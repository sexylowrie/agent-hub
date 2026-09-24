import { useEffect, useRef, useState } from 'preact/hooks'
import { connStatus, sessions } from '../ws.ts'
import { useStore } from '../store.ts'
import type { SessionView, Vendor } from '../types.ts'
import {
  GROUPS,
  ORIGIN_TAG,
  VENDOR_LABEL,
  ago,
  badgeOf,
  defaultOpenGroup,
  groupSessions,
  navigate,
  shortCwd,
  sortKey,
  type GroupKey,
} from '../util.ts'

const VENDORS: (Vendor | 'all')[] = ['all', 'claude', 'codex', 'cursor']
const VENDOR_KEY = 'agenthub.vendor'
/** 用户手动展开/折叠过的组（本次打开期间有效）；没动过时按 defaultOpenGroup */
const OPEN_KEY = 'agenthub.openGroups'
/** 每组先显示几个，其余点「展开全部」 */
const PAGE = 5

function loadOpen(): Set<GroupKey> | undefined {
  const raw = sessionStorage.getItem(OPEN_KEY)
  if (!raw) return undefined
  try {
    return new Set(JSON.parse(raw) as GroupKey[])
  } catch {
    return undefined
  }
}

export function StatusDot() {
  const st = useStore(connStatus)
  const label = st === 'open' ? '已连接' : st === 'connecting' ? '连接中' : '已断开'
  return <span class={`dot ${st}`} title={label} aria-label={label} />
}

function Row({ s }: { s: SessionView }) {
  const b = badgeOf(s)
  return (
    <li class={`row ${s.vendor}`} onClick={() => navigate(`#/s/${encodeURIComponent(s.id)}`)}>
      <div class="row-top">
        <span class="title">{s.title || '（无标题）'}</span>
        {(s.archived || !s.resumable) && <span class={`badge ${b.cls}`}>{b.label}</span>}
      </div>
      <div class="row-meta">
        <span>{VENDOR_LABEL[s.vendor]}</span>
        <span class={`origin ${s.origin}`} title={ORIGIN_TAG[s.origin].title}>
          {ORIGIN_TAG[s.origin].label}
        </span>
        {s.cwd && <span class="cwd">{shortCwd(s.cwd)}</span>}
        <span class="grow" />
        <span>{ago(sortKey(s))}</span>
      </div>
      {s.lastMessagePreview && <div class="preview">{s.lastMessagePreview}</div>}
    </li>
  )
}

export function List() {
  const map = useStore(sessions)
  const [vendor, setVendor] = useState<Vendor | 'all'>(() => (localStorage.getItem(VENDOR_KEY) as Vendor | 'all' | null) ?? 'all')
  const [open, setOpen] = useState<Set<GroupKey> | undefined>(loadOpen)
  const [showAll, setShowAll] = useState<Set<GroupKey>>(new Set())

  const all = [...map.values()]
  const count = (v: Vendor | 'all') => (v === 'all' ? all.length : all.filter((s) => s.vendor === v).length)
  const groups = groupSessions(vendor === 'all' ? all : all.filter((s) => s.vendor === vendor))
  const first = defaultOpenGroup(groups)
  const isOpen = (k: GroupKey) => (open ? open.has(k) : k === first)

  // 来了新的审批请求：自动展开「待审批」（审批 5 分钟过期，不能被折叠藏起来）；之后仍可手动折叠
  const awaitingIds = groups.awaiting.map((s) => s.id)
  const seenAwaiting = useRef(new Set(awaitingIds))
  useEffect(() => {
    const fresh = awaitingIds.some((id) => !seenAwaiting.current.has(id))
    seenAwaiting.current = new Set(awaitingIds)
    if (!fresh || !open || open.has('awaiting')) return
    const next = new Set(open).add('awaiting')
    setOpen(next)
    sessionStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
  }, [awaitingIds.join('|')])

  const pickVendor = (v: Vendor | 'all') => {
    setVendor(v)
    localStorage.setItem(VENDOR_KEY, v)
  }
  const toggle = (k: GroupKey) => {
    const next = new Set(GROUPS.map((g) => g.key).filter(isOpen))
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setOpen(next)
    sessionStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
  }
  const toggleAll = (k: GroupKey) => {
    const next = new Set(showAll)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setShowAll(next)
  }

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
          <button class={`chip ${vendor === v ? 'on' : ''} ${v}`} onClick={() => pickVendor(v)}>
            {v === 'all' ? '全部' : VENDOR_LABEL[v]}
            <span class="n">{count(v)}</span>
          </button>
        ))}
      </div>
      {map.size === 0 && <p class="empty">加载中…</p>}
      {map.size > 0 &&
        GROUPS.map(({ key, label }) => {
          const items = groups[key]
          const opened = isOpen(key)
          const expanded = showAll.has(key)
          const shown = expanded ? items : items.slice(0, PAGE)
          return (
            <section class={`group ${opened ? '' : 'collapsed'}`} key={key}>
              <button class="group-head" onClick={() => toggle(key)} aria-expanded={opened}>
                <span class="caret">▾</span>
                <span class={`sdot ${key}`} />
                <span class="group-name">{label}</span>
                <span class="count">{items.length}</span>
                {!opened && <span class="peek">{items.slice(0, 3).map((s) => s.title || '（无标题）').join(' · ')}</span>}
              </button>
              {opened && (
                <>
                  {items.length === 0 ? (
                    <p class="group-empty">没有会话</p>
                  ) : (
                    <ul class="sessions">
                      {shown.map((s) => (
                        <Row key={s.id} s={s} />
                      ))}
                    </ul>
                  )}
                  {items.length > PAGE && (
                    <button class="more" onClick={() => toggleAll(key)}>
                      {expanded ? '收起' : `展开全部 ${items.length} 个`}
                    </button>
                  )}
                </>
              )}
            </section>
          )
        })}
    </div>
  )
}
