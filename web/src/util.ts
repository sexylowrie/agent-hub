import type { SessionState, SessionView, Vendor } from './types.ts'

export const VENDOR_LABEL: Record<Vendor, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

export type Badge = { label: string; cls: string }

export function badgeOf(s: SessionView): Badge {
  if (s.state === 'awaiting_approval') return { label: '待审批', cls: 'warn' }
  if (s.state === 'running') return { label: '运行中', cls: 'run' }
  if (s.state === 'error') return { label: '出错', cls: 'err' }
  if (s.archived) return { label: '已归档', cls: 'mute' }
  if (!s.resumable) return { label: '不可续接', cls: 'mute' }
  if (s.state === 'idle') return { label: '空闲', cls: 'idle' }
  return { label: '未知', cls: 'mute' }
}

export const STATE_REASON: Partial<Record<SessionState, string>> = {
  running: '会话运行中（桌面端可能正打开着它），空闲后才能续聊',
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
