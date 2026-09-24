import { useEffect, useRef, useState } from 'preact/hooks'
import { sessions } from '../ws.ts'
import { IconChevron, IconGear, IconMoon, IconPlus, IconSun } from '../icons.tsx'
import { resolved, themePref, toggleTheme } from '../theme.ts'
import { Avatar, Navbar, OriginTag, StatusPill } from '../ui.tsx'
import { stripMarkdown } from '../markdown.ts'
import { useStore } from '../store.ts'
import type { SessionView, Vendor } from '../types.ts'
import {
  GROUPS,
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

function Row({ s, selected }: { s: SessionView; selected: boolean }) {
  const b = badgeOf(s)
  return (
    <div
      class={`row ${selected ? 'on' : ''}`}
      role="link"
      tabIndex={0}
      aria-current={selected ? 'page' : undefined}
      onClick={() => navigate(`#/s/${encodeURIComponent(s.id)}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`#/s/${encodeURIComponent(s.id)}`)}
    >
      <Avatar s={s} />
      <div class="r-main">
        <div class="r-top">
          <span class="r-title">{s.title || '（无标题）'}</span>
          <span class="r-time">{ago(sortKey(s))}</span>
        </div>
        <div class="r-meta">
          <span>{VENDOR_LABEL[s.vendor]}</span>
          <OriginTag origin={s.origin} />
          {(s.archived || !s.resumable) && <span class="tag">{b.label}</span>}
          {s.cwd && <span class="cwd">{shortCwd(s.cwd)}</span>}
        </div>
        {s.lastMessagePreview && <div class="r-prev">{stripMarkdown(s.lastMessagePreview)}</div>}
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div class="groups">
      <div class="g-head">
        <span class="sk" style={{ width: '90px', height: '16px' }} />
      </div>
      <div class="g-body">
        {[0, 1, 2, 3].map((i) => (
          <div class="sk-row" key={i}>
            <span class="sk" style={{ width: '36px', height: '36px', borderRadius: '11px' }} />
            <div class="grow">
              <span class="sk" style={{ display: 'block', width: '60%', height: '14px', marginBottom: '8px' }} />
              <span class="sk" style={{ display: 'block', width: '90%', height: '12px' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** selected：电脑端分栏时右侧正在看的会话，列表里高亮 */
export function List({ selected }: { selected?: string } = {}) {
  const map = useStore(sessions)
  const theme = useStore(themePref)
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
      <Navbar>
        <div class="nav-row">
          <StatusPill />
          <span class="grow" />
          <button class="icon-btn" onClick={toggleTheme} aria-label="切换浅色 / 深色">
            {resolved(theme) === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          <button class="icon-btn" onClick={() => navigate('#/settings')} aria-label="设置">
            <IconGear />
          </button>
          <button class="icon-btn primary" onClick={() => navigate('#/new')} aria-label="新建会话">
            <IconPlus />
          </button>
        </div>
        <h1 class="large-title">会话</h1>
        <div class="seg" role="tablist">
          {VENDORS.map((v) => (
            <button class={vendor === v ? 'on' : ''} role="tab" aria-selected={vendor === v} onClick={() => pickVendor(v)}>
              {v !== 'all' && <span class={`vdot ${v}`} />}
              {v === 'all' ? '全部' : VENDOR_LABEL[v]}
              <span class="n">{count(v)}</span>
            </button>
          ))}
        </div>
      </Navbar>
      {map.size === 0 ? (
        <Skeleton />
      ) : (
        <div class="groups">
          {GROUPS.map(({ key, label }) => {
            const items = groups[key]
            const opened = isOpen(key)
            const expanded = showAll.has(key)
            const shown = expanded ? items : items.slice(0, PAGE)
            return (
              <section class={`group ${opened ? '' : 'collapsed'}`} key={key}>
                <button class="g-head" onClick={() => toggle(key)} aria-expanded={opened}>
                  <span class="chev">
                    <IconChevron size={14} />
                  </span>
                  <span class={`sdot ${key}`} />
                  <span class="g-name">{label}</span>
                  <span class="g-count">{items.length}</span>
                  {!opened && <span class="g-peek">{items.slice(0, 3).map((s) => s.title || '（无标题）').join(' · ')}</span>}
                </button>
                {opened && (
                  <div class="g-body">
                    {items.length === 0 ? (
                      <div class="g-empty">没有会话</div>
                    ) : (
                      shown.map((s) => <Row key={s.id} s={s} selected={s.id === selected} />)
                    )}
                    {items.length > PAGE && (
                      <button class="more" onClick={() => toggleAll(key)}>
                        {expanded ? '收起' : `展开全部 ${items.length} 个`}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
