import type { SessionState, SessionView, Vendor } from './types.ts'

/** 会话来源：desktop=桌面 App（GUI），cli=终端命令行，hub=手机上新建（底层也是 CLI） */
export const ORIGIN_TAG: Record<SessionView['origin'], { label: string; title: string }> = {
  desktop: { label: 'GUI', title: '桌面 App 里建的会话' },
  cli: { label: 'CLI', title: '终端命令行里建的会话' },
  hub: { label: 'Hub', title: '手机上新建的会话（经 CLI 运行）' },
}

export const VENDOR_LABEL: Record<Vendor, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

export type Badge = { label: string; cls: string }

export function badgeOf(s: SessionView): Badge {
  if (s.state === 'awaiting_approval') return { label: '待审批', cls: 'warn' }
  if (s.state === 'running') return { label: '运行中', cls: 'run' }
  if (s.state === 'attached') return { label: s.holder?.kind === 'gui' ? 'App 开着' : '终端开着', cls: 'mute' }
  if (s.state === 'error') return { label: '出错', cls: 'err' }
  if (s.archived) return { label: '已归档', cls: 'mute' }
  if (!s.resumable) return { label: '不可续接', cls: 'mute' }
  if (s.state === 'idle') return { label: '空闲', cls: 'idle' }
  return { label: '未知', cls: 'mute' }
}

export const STATE_REASON: Partial<Record<SessionState, string>> = {
  running: '会话运行中（桌面端可能正打开着它），空闲后才能续聊',
  attached: '会话在终端或桌面 App 里开着，关掉后才能在这里续聊',
  awaiting_approval: '正在等待审批',
}

/** cwd 末两段 */
export function shortCwd(cwd: string | null): string {
  if (!cwd) return ''
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function ago(ms: number | undefined): string {
  if (!ms) return ''
  const d = Math.max(0, Date.now() - ms) / 1000
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`
  return new Date(ms).toLocaleDateString()
}

export const sortKey = (s: SessionView) => s.vendorUpdatedAt ?? s.updatedAt

export function navigate(hash: string) {
  location.hash = hash
}

export function summarize(v: unknown, max = 120): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (typeof v === 'string') s = v
  else if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const pick = o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
    s = typeof pick === 'string' ? pick : Array.isArray(pick) ? pick.join(' ') : JSON.stringify(v)
  } else s = String(v)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export type GroupKey = 'awaiting' | 'running' | 'idle' | 'error' | 'other'

/** 列表的状态分组，按这个顺序从上到下排 */
export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'awaiting', label: '待审批' },
  { key: 'running', label: '运行中' },
  { key: 'idle', label: '可续聊' },
  { key: 'error', label: '出错' },
  { key: 'other', label: '其他' },
]

/** 会话归到哪一组：进行中的状态优先（attached 与 running 同组，都不能续聊）；可续聊 = 空闲、可续接、未归档；其余（已归档 / 不可续接 / 未知）进「其他」 */
export function groupOf(s: SessionView): GroupKey {
  if (s.state === 'awaiting_approval') return 'awaiting'
  if (s.state === 'running' || s.state === 'attached') return 'running'
  if (s.state === 'error') return 'error'
  if (s.state === 'idle' && s.resumable && !s.archived) return 'idle'
  return 'other'
}

/** 分组并按最近更新倒序 */
export function groupSessions(list: SessionView[]): Record<GroupKey, SessionView[]> {
  const out = { awaiting: [], running: [], idle: [], error: [], other: [] } as Record<GroupKey, SessionView[]>
  for (const s of list) out[groupOf(s)].push(s)
  for (const k of Object.keys(out) as GroupKey[]) out[k].sort((a, b) => sortKey(b) - sortKey(a))
  return out
}

/** 默认只展开一个组：按顺序第一个有会话的组 */
export function defaultOpenGroup(groups: Record<GroupKey, SessionView[]>): GroupKey | undefined {
  return GROUPS.find((g) => groups[g.key].length > 0)?.key
}
