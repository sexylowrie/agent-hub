// Agent Hub Service Worker：缓存页面壳（离线时还能打开），不缓存 /api 与 /ws；收 Web Push 并显示通知
const CACHE = 'agenthub-shell-v2'
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return
  if (e.request.mode === 'navigate') {
    // 页面：网络优先，拿不到用缓存的壳
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone()
          caches.open(CACHE).then((c) => c.put('/', copy))
          return r
        })
        .catch(() => caches.match('/')),
    )
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    // 带 hash 的构建产物：缓存优先
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((r) => {
            const copy = r.clone()
            caches.open(CACHE).then((c) => c.put(e.request, copy))
            return r
          }),
      ),
    )
  }
})

// Hub 推送的内容：{ title, body, url, tag }（见 src/gateway/push.ts）。iOS 要求每条推送都显示通知
self.addEventListener('push', (e) => {
  let m = { title: 'Agent Hub', body: '', url: '/', tag: 'hub' }
  try {
    m = { ...m, ...e.data.json() }
  } catch {
    if (e.data) m.body = e.data.text()
  }
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, tag: m.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: m.url } }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = new URL(e.notification.data?.url ?? '/', location.origin).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const c = list.find((w) => new URL(w.url).origin === location.origin)
      if (c) return c.navigate(url).then((w) => (w ?? c).focus())
      return self.clients.openWindow(url)
    }),
  )
})
