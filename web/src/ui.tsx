import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useStore } from './store.ts'
import { toasts } from './toast.ts'
import type { SessionView } from './types.ts'
import { connStatus } from './ws.ts'
import { ORIGIN_TAG } from './util.ts'

export const AVATAR: Record<SessionView['vendor'], string> = { claude: 'C', codex: 'Cx', cursor: 'Cu' }

/** 页面滚动离开顶部（导航栏出分隔线） */
export function useScrolled(threshold = 4) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > threshold)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [threshold])
  return scrolled
}

export function Navbar({ children, compact }: { children: ComponentChildren; compact?: boolean }) {
  const scrolled = useScrolled()
  return <header class={`navbar ${scrolled ? 'scrolled' : ''} ${compact ? 'compact' : ''}`}>{children}</header>
}

export function StatusPill() {
  const st = useStore(connStatus)
  const label = st === 'open' ? '已连接' : st === 'connecting' ? '连接中' : '已断开'
  return (
    <span class={`pill ${st}`} role="status">
      <span class="d" />
      {label}
    </span>
  )
}

export function Avatar({ s }: { s: Pick<SessionView, 'vendor' | 'state'> }) {
  const live = s.state === 'running' ? 'running' : s.state === 'awaiting_approval' ? 'awaiting' : s.state === 'error' ? 'error' : ''
  return (
    <div class={`avatar ${s.vendor}`} aria-hidden="true">
      {AVATAR[s.vendor]}
      {live && <span class={`live ${live}`} />}
    </div>
  )
}

export function OriginTag({ origin }: { origin: SessionView['origin'] }) {
  return (
    <span class={`tag ${origin === 'hub' ? 'hub' : ''}`} title={ORIGIN_TAG[origin].title}>
      {ORIGIN_TAG[origin].label}
    </span>
  )
}

export function Switch({ checked, onChange, small, tone }: { checked: boolean; onChange: (v: boolean) => void; small?: boolean; tone?: 'warn' }) {
  return (
    <label class={`switch ${small ? 'sm' : ''} ${tone ?? ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span />
    </label>
  )
}

export function Toasts() {
  const list = useStore(toasts)
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => (
        <div class={`toast ${t.kind}`} key={t.id}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
