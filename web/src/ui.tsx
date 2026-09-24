import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useStore } from './store.ts'
import { toasts } from './toast.ts'
import type { SessionView } from './types.ts'
import { connStatus } from './ws.ts'
import { ORIGIN_TAG } from './util.ts'

export const AVATAR: Record<SessionView['vendor'], string> = { claude: 'C', codex: 'Cx', cursor: 'Cu' }

/** 电脑端分栏的断点，与 style.css 里的 @media (min-width: 900px) 一致 */
export const WIDE_QUERY = '(min-width: 900px)'

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/** 导航栏：滚动离开顶部时出分隔线。电脑端左栏是独立滚动容器（.sidebar），其余跟随页面滚动 */
export function Navbar({ children, compact }: { children: ComponentChildren; compact?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const box = ref.current?.closest('.sidebar') as HTMLElement | null
    const on = () => setScrolled((box ? box.scrollTop : window.scrollY) > 4)
    const target: HTMLElement | Window = box ?? window
    on()
    target.addEventListener('scroll', on, { passive: true })
    return () => target.removeEventListener('scroll', on)
  }, [])
  return (
    <header ref={ref} class={`navbar ${scrolled ? 'scrolled' : ''} ${compact ? 'compact' : ''}`}>
      {children}
    </header>
  )
}

/** 电脑端右栏没有选中会话时的占位 */
export function EmptyPane() {
  return (
    <div class="pane-empty">
      <div class="logo" aria-hidden="true">
        <i style={{ height: '26px', background: '#e08a64' }} />
        <i style={{ height: '20px', background: '#19b58c' }} />
        <i style={{ height: '14px', background: '#9aa6ff' }} />
      </div>
      <h2>选择一个会话</h2>
      <p>从左侧列表打开会话查看进度、续聊或处理审批，或者新建一个。</p>
    </div>
  )
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
