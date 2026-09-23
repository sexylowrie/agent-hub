// Agent Hub Service Worker：缓存页面壳（离线时还能打开），不缓存 /api 与 /ws；Web Push 见 M3
const CACHE = 'agenthub-shell-v1'
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
