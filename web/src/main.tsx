import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { auth } from './api.ts'
import { hub } from './ws.ts'
import { Detail } from './pages/Detail.tsx'
import { List } from './pages/List.tsx'
import { New } from './pages/New.tsx'
import { Pair } from './pages/Pair.tsx'
import { Settings } from './pages/Settings.tsx'
import { Toasts } from './ui.tsx'
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

function App() {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return (
    <>
      <Toasts />
      {route.name === 'pair' ? (
        <Pair code={route.code} />
      ) : route.name === 'detail' ? (
        <Detail id={route.id} />
      ) : route.name === 'new' ? (
        <New />
      ) : route.name === 'settings' ? (
        <Settings />
      ) : (
        <List />
      )}
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
