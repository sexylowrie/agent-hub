import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { auth } from './api.ts'
import { hub } from './ws.ts'
import { Detail } from './pages/Detail.tsx'
import { List } from './pages/List.tsx'
import { New } from './pages/New.tsx'
import { Pair } from './pages/Pair.tsx'
import { Settings } from './pages/Settings.tsx'
import { EmptyPane, Toasts, useWide } from './ui.tsx'
import './theme.ts'
import './style.css'

type Route = { name: 'pair'; code?: string } | { name: 'list' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'settings' }

function parse(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?')
  if (path === '/pair' || !auth.token()) return { name: 'pair', code: new URLSearchParams(query).get('code') ?? undefined }
  const m = path.match(/^\/s\/(.+)$/)
  if (m) return { name: 'detail', id: decodeURIComponent(m[1]) }
  if (path === '/new') return { name: 'new' }
  if (path === '/settings') return { name: 'settings' }
  return { name: 'list' }
}

function Pane({ route }: { route: Exclude<Route, { name: 'pair' }> }) {
  switch (route.name) {
    case 'detail':
      // key：切换会话时整页重建，避免上一个会话的状态残留
      return <Detail key={route.id} id={route.id} />
    case 'new':
      return <New />
    case 'settings':
      return <Settings />
    default:
      return null
  }
}

function App() {
  const [route, setRoute] = useState(() => parse(location.hash))
  const wide = useWide()
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  if (route.name === 'pair') {
    return (
      <>
        <Toasts />
        <Pair code={route.code} />
      </>
    )
  }
  // 电脑端：左栏常驻会话列表，右栏显示详情 / 新建 / 设置；手机端单栏按路由切页
  if (wide) {
    return (
      <>
        <Toasts />
        <div class="split">
          <aside class="sidebar">
            <List selected={route.name === 'detail' ? route.id : undefined} />
          </aside>
          <main class="main">{route.name === 'list' ? <EmptyPane /> : <Pane route={route} />}</main>
        </div>
      </>
    )
  }
  return (
    <>
      <Toasts />
      {route.name === 'list' ? <List /> : <Pane route={route} />}
    </>
  )
}

hub.start()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') hub.wake()
})
window.addEventListener('online', () => hub.wake())

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

render(<App />, document.getElementById('app')!)
