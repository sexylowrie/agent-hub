import { useState } from 'preact/hooks'
import { connStatus, sessions } from '../ws.ts'
import { useStore } from '../store.ts'
import type { SessionView, Vendor } from '../types.ts'
import { ORIGIN_TAG, VENDOR_LABEL, ago, badgeOf, navigate, shortCwd, sortKey } from '../util.ts'

type StateFilter = 'all' | 'running' | 'awaiting_approval' | 'idle' | 'archived'
const STATE_FILTERS: [StateFilter, string][] = [
  ['all', '全部'],
  ['running', '运行中'],
  ['awaiting_approval', '待审批'],
  ['idle', '可续聊'],
  ['archived', '已归档'],
]
const VENDORS: (Vendor | 'all')[] = ['all', 'claude', 'codex', 'cursor']
const FILTER_KEY = 'agenthub.filters'

function loadFilters(): { vendor: Vendor | 'all'; state: StateFilter } {
  try {
    return { vendor: 'all', state: 'all', ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') }
  } catch {
    return { vendor: 'all', state: 'all' }
  }
}

function match(s: SessionView, f: ReturnType<typeof loadFilters>) {
  if (f.vendor !== 'all' && s.vendor !== f.vendor) return false
  switch (f.state) {
    case 'all':
      return true
    case 'archived':
      return s.archived
    case 'idle':
      return s.state === 'idle' && s.resumable && !s.archived
    default:
      return s.state === f.state
  }
}

export function StatusDot() {
  const st = useStore(connStatus)
  const label = st === 'open' ? '已连接' : st === 'connecting' ? '连接中' : '已断开'
  return <span class={`dot ${st}`} title={label} aria-label={label} />
}

export function List() {
  const map = useStore(sessions)
  const [f, setF] = useState(loadFilters)
  const update = (patch: Partial<typeof f>) => {
    const next = { ...f, ...patch }
    setF(next)
    localStorage.setItem(FILTER_KEY, JSON.stringify(next))
  }
  const all = [...map.values()]
  const list = all.filter((s) => match(s, f)).sort((a, b) => sortKey(b) - sortKey(a))
  const pendingCount = all.filter((s) => s.state === 'awaiting_approval').length

  return (
    <div class="page">
      <header class="bar">
        <StatusDot />
        <h1>会话</h1>
        <span class="grow" />
        <button class="ghost" onClick={() => navigate('#/settings')} aria-label="设置">
          设置
        </button>
        <button class="primary small" onClick={() => navigate('#/new')}>
          新建
        </button>
      </header>
      <div class="chips">
        {VENDORS.map((v) => (
          <button class={`chip ${f.vendor === v ? 'on' : ''} ${v}`} onClick={() => update({ vendor: v })}>
            {v === 'all' ? '全部厂商' : VENDOR_LABEL[v]}
          </button>
        ))}
      </div>
      <div class="chips">
        {STATE_FILTERS.map(([k, label]) => (
          <button class={`chip ${f.state === k ? 'on' : ''}`} onClick={() => update({ state: k })}>
            {label}
            {k === 'awaiting_approval' && pendingCount > 0 ? ` ${pendingCount}` : ''}
          </button>
        ))}
      </div>
      {list.length === 0 && <p class="empty">{map.size ? '没有符合筛选条件的会话' : '加载中…'}</p>}
      <ul class="sessions">
        {list.map((s) => {
          const b = badgeOf(s)
          return (
            <li key={s.id} class={`row ${s.vendor}`} onClick={() => navigate(`#/s/${encodeURIComponent(s.id)}`)}>
              <div class="row-top">
                <span class="title">{s.title || '（无标题）'}</span>
                <span class={`badge ${b.cls}`}>{b.label}</span>
              </div>
              <div class="row-meta">
                <span>{VENDOR_LABEL[s.vendor]}</span>
                <span class={`origin ${s.origin}`} title={ORIGIN_TAG[s.origin].title}>
                  {ORIGIN_TAG[s.origin].label}
                </span>
                {s.cwd && <span>{shortCwd(s.cwd)}</span>}
                <span class="grow" />
                <span>{ago(sortKey(s))}</span>
              </div>
              {s.lastMessagePreview && <div class="preview">{s.lastMessagePreview}</div>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
