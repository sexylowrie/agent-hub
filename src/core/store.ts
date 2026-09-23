import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalKind, Decision, HubEvent, SessionState, SessionView, Vendor } from './events.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  vendor_session_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  resumable INTEGER NOT NULL DEFAULT 1,
  unresumable_reason TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  last_event_seq INTEGER,
  vendor_updated_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(vendor, vendor_session_id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hub_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
`

type Row = Record<string, any>

export interface StoredEvent {
  seq: number
  event: HubEvent
  ts: number
}

export interface ApprovalRow {
  id: string
  sessionId: string
  turnId: string | null
  kind: ApprovalKind
  summary: string
  payload: string
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  decidedBy: string | null
  createdAt: number
  expiresAt: number
}

export interface DeviceRow {
  id: string
  name: string
  pairedAt: number
  lastSeen: number | null
  revoked: boolean
}

function toView(r: Row): SessionView {
  const v: SessionView = {
    id: r.id,
    vendor: r.vendor as Vendor,
    vendorSessionId: r.vendor_session_id,
    cwd: r.cwd ?? null,
    title: r.title ?? null,
    origin: r.origin,
    state: r.state as SessionState,
    resumable: !!r.resumable,
    archived: !!r.archived,
    updatedAt: r.updated_at,
  }
  if (r.unresumable_reason) v.unresumableReason = r.unresumable_reason
  if (r.last_message_preview) v.lastMessagePreview = r.last_message_preview
  if (r.vendor_updated_at != null) v.vendorUpdatedAt = r.vendor_updated_at
  return v
}

function toApproval(r: Row): ApprovalRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    kind: r.kind,
    summary: r.summary,
    payload: r.payload,
    status: r.status,
    decidedBy: r.decided_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }
}

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;')
    this.db.exec(SCHEMA)
  }

  static open(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true })
    return new Store(join(dataDir, 'hub.sqlite'))
  }

  close() {
    this.db.close()
  }

  // ---- sessions ----
  upsertSession(v: SessionView) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, vendor, vendor_session_id, cwd, title, origin, state, resumable, unresumable_reason,
           archived, last_message_preview, vendor_updated_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, title=excluded.title, origin=excluded.origin, state=excluded.state,
           resumable=excluded.resumable, unresumable_reason=excluded.unresumable_reason, archived=excluded.archived,
           last_message_preview=excluded.last_message_preview, vendor_updated_at=excluded.vendor_updated_at,
           updated_at=excluded.updated_at`,
      )
      .run(
        v.id, v.vendor, v.vendorSessionId, v.cwd, v.title, v.origin, v.state, v.resumable ? 1 : 0,
        v.unresumableReason ?? null, v.archived ? 1 : 0, v.lastMessagePreview ?? null, v.vendorUpdatedAt ?? null, v.updatedAt,
      )
  }

  getSession(id: string): SessionView | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined
    return r ? toView(r) : undefined
  }

  listSessions(f: { vendor?: string; state?: string; limit?: number; offset?: number } = {}): SessionView[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (f.vendor) (where.push('vendor=?'), args.push(f.vendor))
    if (f.state) (where.push('state=?'), args.push(f.state))
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(vendor_updated_at, updated_at) DESC LIMIT ? OFFSET ?`
    args.push(f.limit ?? 500, f.offset ?? 0)
    return (this.db.prepare(sql).all(...args) as Row[]).map(toView)
  }

  setSessionState(id: string, state: SessionState, now = Date.now()) {
    this.db.prepare('UPDATE sessions SET state=?, updated_at=? WHERE id=?').run(state, now, id)
  }

  // ---- events ----
  appendEvent(event: HubEvent, ts = Date.now()): number {
    const sessionId = 'sessionId' in event && event.sessionId ? event.sessionId : ''
    const r = this.db
      .prepare('INSERT INTO events (session_id, type, payload, ts) VALUES (?,?,?,?)')
      .run(sessionId, event.type, JSON.stringify(event), ts)
    const seq = Number(r.lastInsertRowid)
    if (sessionId) this.db.prepare('UPDATE sessions SET last_event_seq=? WHERE id=?').run(seq, sessionId)
    return seq
  }

  latestSeq(): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as Row
    return r.s ?? 0
  }

  eventsSince(sessionId: string, sinceSeq = 0, limit = 500): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, payload, ts FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, sinceSeq, limit) as Row[]
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload), ts: r.ts }))
  }

  recentEvents(sessionId: string, limit = 200): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, payload, ts FROM events WHERE session_id=? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, limit) as Row[]
    return rows.reverse().map((r) => ({ seq: r.seq, event: JSON.parse(r.payload), ts: r.ts }))
  }

  /** 补拉：指定会话的全部事件 + 所有 approval.* 事件 */
  replayFor(sessionIds: string[], sinceSeq: number, limit = 2000): StoredEvent[] {
    const ph = sessionIds.map(() => '?').join(',')
    const cond = sessionIds.length ? `session_id IN (${ph}) OR ` : ''
    const rows = this.db
      .prepare(`SELECT seq, payload, ts FROM events WHERE seq>? AND (${cond}type LIKE 'approval.%') ORDER BY seq LIMIT ?`)
      .all(sinceSeq, ...sessionIds, limit) as Row[]
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload), ts: r.ts }))
  }

  // ---- approvals ----
  insertApproval(a: Omit<ApprovalRow, 'status' | 'decidedBy'>) {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, turn_id, kind, summary, payload, status, created_at, expires_at)
         VALUES (?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(a.id, a.sessionId, a.turnId, a.kind, a.summary, a.payload, a.createdAt, a.expiresAt)
  }

  getApproval(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row | undefined
    return r ? toApproval(r) : undefined
  }

  /** 会话里仍待处理（pending 且未过期）的审批 */
  pendingApprovals(sessionId: string, now = Date.now()): ApprovalRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE session_id=? AND status='pending' AND expires_at>? ORDER BY created_at`)
      .all(sessionId, now) as Row[]
    return rows.map(toApproval)
  }

  /** 只在 pending 且未过期时生效；返回是否成功 */
  decideApproval(id: string, decision: Decision, by: string, now = Date.now()): boolean {
    const status = decision === 'deny' ? 'denied' : 'allowed'
    const r = this.db
      .prepare(
        `UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending' AND expires_at>?`,
      )
      .run(status, by, now, id, now)
    return r.changes === 1
  }

  expireApproval(id: string, now = Date.now()): boolean {
    const r = this.db
      .prepare(`UPDATE approvals SET status='expired', decided_at=? WHERE id=? AND status='pending'`)
      .run(now, id)
    return r.changes === 1
  }

  expireAllPending(now = Date.now()) {
    this.db.prepare(`UPDATE approvals SET status='expired', decided_at=? WHERE status='pending'`).run(now)
  }

  // ---- devices ----
  insertDevice(id: string, name: string, tokenHash: string, now = Date.now()) {
    this.db.prepare('INSERT INTO devices (id, name, token_hash, paired_at) VALUES (?,?,?,?)').run(id, name, tokenHash, now)
  }

  findDeviceByTokenHash(hash: string): DeviceRow | undefined {
    const r = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked=0').get(hash) as Row | undefined
    return r ? { id: r.id, name: r.name, pairedAt: r.paired_at, lastSeen: r.last_seen, revoked: !!r.revoked } : undefined
  }

  touchDevice(id: string, now = Date.now()) {
    this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now, id)
  }

  listDevices(): DeviceRow[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY paired_at').all() as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      pairedAt: r.paired_at,
      lastSeen: r.last_seen,
      revoked: !!r.revoked,
    }))
  }

  /** 按名称或 id 吊销，返回吊销数量 */
  revokeDevice(nameOrId: string): number {
    return Number(
      this.db.prepare('UPDATE devices SET revoked=1 WHERE (name=? OR id=?) AND revoked=0').run(nameOrId, nameOrId).changes,
    )
  }

  // ---- pairing codes ----
  insertPairingCode(code: string, expiresAt: number) {
    this.db.prepare('INSERT OR REPLACE INTO pairing_codes (code, expires_at, used) VALUES (?,?,0)').run(code, expiresAt)
  }

  /** 原子地消费配对码：未使用且未过期才成功 */
  consumePairingCode(code: string, now = Date.now()): boolean {
    const r = this.db
      .prepare('UPDATE pairing_codes SET used=1 WHERE code=? AND used=0 AND expires_at>?')
      .run(code, now)
    return r.changes === 1
  }

  // ---- hub_turns ----
  insertTurn(id: string, sessionId: string, now = Date.now()) {
    this.db
      .prepare(`INSERT INTO hub_turns (id, session_id, status, started_at) VALUES (?,?,'running',?)`)
      .run(id, sessionId, now)
  }

  setTurnPid(id: string, pid: number) {
    this.db.prepare('UPDATE hub_turns SET pid=? WHERE id=?').run(pid, id)
  }

  /** start() 拿到新 id 后把轮次挂到真实会话上 */
  setTurnSession(id: string, sessionId: string) {
    this.db.prepare('UPDATE hub_turns SET session_id=? WHERE id=?').run(sessionId, id)
  }

  finishTurn(id: string, status: 'done' | 'failed', now = Date.now()) {
    this.db.prepare('UPDATE hub_turns SET status=?, ended_at=? WHERE id=?').run(status, now, id)
  }

  hasRunningTurn(sessionId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM hub_turns WHERE session_id=? AND status='running'`).get(sessionId)
  }

  runningTurns(): { id: string; sessionId: string; pid: number | null }[] {
    return (this.db.prepare(`SELECT * FROM hub_turns WHERE status='running'`).all() as Row[]).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      pid: r.pid,
    }))
  }

  markTurnOrphaned(id: string, now = Date.now()) {
    this.db.prepare(`UPDATE hub_turns SET status='orphaned', ended_at=? WHERE id=?`).run(now, id)
  }
}
