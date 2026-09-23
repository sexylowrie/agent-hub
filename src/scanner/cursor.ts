import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sessionKey, type HistoryItem, type SessionState, type SessionView } from '../core/events.ts'

// 字段与判定依据见 docs/spec/01-verified-facts.md「Cursor」与 05-scanner.md。
// state.vscdb 约 10 GB：只按 key 范围取 composerData 并用 json_extract 取小字段，bubble 只按 key 点查。

const TITLE_LEN = 60
const PREVIEW_LEN = 200
const CLI_DEFAULT_NAME = 'New Agent'

// ---------- ~/.cursor/chats（CLI 会话 / CLI 续聊）----------

function varint(b: Uint8Array, i: number): [number, number] {
  let r = 0
  let mul = 1
  for (;;) {
    if (i >= b.length) throw new Error('protobuf 截断')
    const x = b[i++]
    r += (x & 0x7f) * mul
    if (!(x & 0x80)) return [r, i]
    mul *= 128
  }
}

/** store.db 根 blob（protobuf）：field 1 重复出现，每个是 32 字节的消息 blob id，按对话顺序 */
export function rootMessageIds(root: Uint8Array): string[] {
  const out: string[] = []
  let i = 0
  while (i < root.length) {
    const [key, j] = varint(root, i)
    i = j
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) i = varint(root, i)[1]
    else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else if (wire === 2) {
      const [len, k] = varint(root, i)
      if (field === 1 && len === 32) out.push(Buffer.from(root.subarray(k, k + 32)).toString('hex'))
      i = k + len
    } else throw new Error(`protobuf wire type ${wire} 不支持`)
  }
  return out
}

const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/

function partsOf(content: unknown): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

/** store.db 里的消息 JSON → 历史条目。用户输入包在 <user_query> 里，其余 user 消息是注入的上下文，跳过。 */
export function chatMessageItems(msg: any): HistoryItem[] {
  const out: HistoryItem[] = []
  if (msg?.role === 'user') {
    for (const p of partsOf(msg.content)) {
      const m = typeof p.text === 'string' ? p.text.match(USER_QUERY) : null
      if (m) out.push({ role: 'user', text: m[1], source: 'cli' })
    }
  } else if (msg?.role === 'assistant') {
    for (const p of partsOf(msg.content)) {
      if (p.type === 'text' && p.text) out.push({ role: 'assistant', text: p.text, source: 'cli' })
      else if (p.type === 'tool-call') {
        out.push({ role: 'tool', text: JSON.stringify(p.args ?? {}).slice(0, 2000), toolName: p.toolName, source: 'cli' })
      }
    }
  } else if (msg?.role === 'tool') {
    for (const p of partsOf(msg.content)) {
      if (p.type === 'tool-result') {
        const r = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? '')
        out.push({ role: 'tool', text: r.slice(0, 2000), toolName: p.toolName, source: 'cli' })
      }
    }
  }
  return out
}

export interface CliChat {
  composerId: string
  dir: string
  cwd?: string
  updatedAtMs?: number
  /** store.db 最近修改时间，用于判断 CLI 是否正在写 */
  mtimeMs: number
  name?: string
  items: HistoryItem[]
}

export function readStoreDb(file: string): { name?: string; items: HistoryItem[] } {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string } | undefined
    if (!metaRow) return { items: [] }
    const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8'))
    const blob = db.prepare('SELECT data FROM blobs WHERE id = ?')
    const root = (blob.get(meta.latestRootBlobId) as { data: Uint8Array } | undefined)?.data
    if (!root) return { name: meta.name, items: [] }
    const items: HistoryItem[] = []
    for (const id of rootMessageIds(root)) {
      const data = (blob.get(id) as { data: Uint8Array } | undefined)?.data
      if (!data || data[0] !== 0x7b) continue
      try {
        items.push(...chatMessageItems(JSON.parse(Buffer.from(data).toString('utf8'))))
      } catch {
        // 非 JSON 节点
      }
    }
    return { name: meta.name, items }
  } finally {
    db.close()
  }
}

// ---------- state.vscdb（IDE 会话）----------

export interface ComposerRow {
  composerId: string
  name?: string
  status?: string
  generating: number
  createdAt?: number
  lastUpdatedAt?: number
  headers: number
  firstUserPreview?: string
  lastPreview?: string
  workspace?: string
}

const COMPOSER_COLS = `
  substr(key, 14) AS composerId,
  json_extract(value, '$.name') AS name,
  json_extract(value, '$.status') AS status,
  json_array_length(json_extract(value, '$.generatingBubbleIds')) AS generating,
  json_extract(value, '$.createdAt') AS createdAt,
  json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt,
  json_array_length(json_extract(value, '$.fullConversationHeadersOnly')) AS headers,
  json_extract(value, '$.fullConversationHeadersOnly[0].grouping.textPreview') AS firstUserPreview,
  json_extract(value, '$.fullConversationHeadersOnly[#-1].grouping.textPreview') AS lastPreview,
  json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS workspace`

/** 运行判定：有正在生成的 bubble 或 status=generating。宁可误判为 running。 */
export function composerState(r: Pick<ComposerRow, 'generating' | 'status'>): SessionState {
  return (r.generating ?? 0) > 0 || r.status === 'generating' ? 'running' : 'idle'
}

function bubbleItem(o: any, at?: number): HistoryItem | undefined {
  const t = o?.toolFormerData
  if (t?.name) {
    const text = String(t.result ?? t.params ?? t.rawArgs ?? '').slice(0, 2000)
    return { role: 'tool', text, toolName: t.name, at, source: 'desktop' }
  }
  if (typeof o?.text !== 'string' || !o.text) return undefined
  return { role: o.type === 1 ? 'user' : 'assistant', text: o.text, at, source: 'desktop' }
}

export interface CursorScannerOpts {
  globalDb?: string
  chatsDir?: string
  recentDays: number
  quietMs: number
  isHubSession?: (composerId: string) => boolean
  now?: () => number
}

export class CursorScanner {
  readonly globalDb: string
  readonly chatsDir: string
  private db: DatabaseSync | undefined
  private chatCache = new Map<string, CliChat>()
  private readonly now: () => number

  constructor(private readonly o: CursorScannerOpts) {
    this.globalDb = o.globalDb ?? join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    this.chatsDir = o.chatsDir ?? join(homedir(), '.cursor', 'chats')
    this.now = o.now ?? Date.now
  }

  private open(): DatabaseSync | undefined {
    if (this.db) return this.db
    try {
      statSync(this.globalDb)
      this.db = new DatabaseSync(this.globalDb, { readOnly: true })
    } catch {
      this.db = undefined
    }
    return this.db
  }

  /** 查询失败（IDE 升级换库等）时关掉连接，下次重开 */
  private query<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
    const db = this.open()
    if (!db) return fallback
    try {
      return fn(db)
    } catch {
      try {
        db.close()
      } catch {
        // 忽略
      }
      this.db = undefined
      return fallback
    }
  }

  close() {
    this.db?.close()
    this.db = undefined
  }

  composers(sinceMs: number): ComposerRow[] {
    return this.query(
      (db) =>
        db
          .prepare(
            `SELECT ${COMPOSER_COLS} FROM cursorDiskKV
             WHERE key >= 'composerData:' AND key < 'composerData;'
               AND COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0) >= ?`,
          )
          .all(sinceMs) as unknown as ComposerRow[],
      [],
    )
  }

  composer(composerId: string): ComposerRow | undefined {
    return this.query(
      (db) => db.prepare(`SELECT ${COMPOSER_COLS} FROM cursorDiskKV WHERE key = ?`).get(`composerData:${composerId}`) as unknown as ComposerRow | undefined,
      undefined,
    )
  }

  /** ~/.cursor/chats/<workspaceHash>/<composerId>/ 目录列表 */
  private chatDirs(): Map<string, string> {
    const out = new Map<string, string>()
    let wss: string[]
    try {
      wss = readdirSync(this.chatsDir)
    } catch {
      return out
    }
    for (const ws of wss) {
      let ids: string[]
      try {
        ids = readdirSync(join(this.chatsDir, ws))
      } catch {
        continue
      }
      for (const id of ids) out.set(id, join(this.chatsDir, ws, id))
    }
    return out
  }

  readChat(composerId: string, dir: string): CliChat | undefined {
    let st
    try {
      st = statSync(join(dir, 'store.db'))
    } catch {
      return undefined
    }
    const cached = this.chatCache.get(composerId)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.dir === dir) return cached
    let meta: any = {}
    try {
      meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    } catch {
      // 没有 meta.json
    }
    let store: ReturnType<typeof readStoreDb>
    try {
      store = readStoreDb(join(dir, 'store.db'))
    } catch {
      return cached // 正在写入，沿用上次
    }
    const chat: CliChat = {
      composerId,
      dir,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      updatedAtMs: typeof meta.updatedAtMs === 'number' ? meta.updatedAtMs : undefined,
      mtimeMs: st.mtimeMs,
      name: store.name,
      items: store.items,
    }
    this.chatCache.set(composerId, chat)
    return chat
  }

  private view(row: ComposerRow | undefined, chat: CliChat | undefined): SessionView | undefined {
    const composerId = row?.composerId ?? chat?.composerId
    if (!composerId) return undefined
    const hasIde = !!row && row.headers > 0
    if (!hasIde && !chat?.items.length) return undefined // 空草稿
    const now = this.now()
    const isHub = this.o.isHubSession?.(composerId) ?? false
    const firstUser = chat?.items.find((i) => i.role === 'user')?.text
    const lastAssistant = chat?.items.findLast((i) => i.role === 'assistant')?.text
    const chatName = chat?.name && chat.name !== CLI_DEFAULT_NAME ? chat.name : undefined
    const title = (hasIde ? row!.name || row!.firstUserPreview : undefined) || chatName || firstUser?.slice(0, TITLE_LEN) || null
    const ideAt = hasIde ? (row!.lastUpdatedAt ?? row!.createdAt) : undefined
    const cliAt = chat ? Math.max(chat.updatedAtMs ?? 0, Math.round(chat.mtimeMs)) : undefined
    const cliNewer = cliAt !== undefined && (ideAt === undefined || cliAt > ideAt)
    let state: SessionState = row ? composerState(row) : 'idle'
    if (chat && now - chat.mtimeMs <= this.o.quietMs) state = 'running'
    const preview = cliNewer ? lastAssistant : (row?.lastPreview ?? undefined)
    const v: SessionView = {
      id: sessionKey('cursor', composerId),
      vendor: 'cursor',
      vendorSessionId: composerId,
      cwd: row?.workspace ?? chat?.cwd ?? null,
      title,
      origin: isHub ? 'hub' : hasIde ? 'desktop' : 'cli',
      state,
      resumable: true,
      archived: false,
      vendorUpdatedAt: Math.max(ideAt ?? 0, cliAt ?? 0) || undefined,
      updatedAt: now,
    }
    if (preview) v.lastMessagePreview = preview.slice(0, PREVIEW_LEN)
    return v
  }

  scanAll(): SessionView[] {
    const cutoff = this.now() - this.o.recentDays * 86_400_000
    const rows = new Map(this.composers(cutoff).map((r) => [r.composerId, r]))
    const dirs = this.chatDirs()
    const out: SessionView[] = []
    for (const [id, dir] of dirs) {
      const chat = this.readChat(id, dir)
      if (!chat) continue
      const recent = Math.max(chat.updatedAtMs ?? 0, chat.mtimeMs) >= cutoff
      const row = rows.get(id) ?? (recent ? this.composer(id) : undefined)
      if (!recent && !rows.has(id)) continue
      rows.delete(id)
      const v = this.view(row, chat)
      if (v) out.push(v)
    }
    for (const row of rows.values()) {
      const v = this.view(row, undefined)
      if (v) out.push(v)
    }
    return out
  }

  /** 续聊前的实时复核 */
  refresh(composerId: string): SessionView | undefined {
    const dir = this.chatDirs().get(composerId)
    return this.view(this.composer(composerId), dir ? this.readChat(composerId, dir) : undefined)
  }

  /** 会话详情：IDE 消息（最近 limit 条 bubble，按 key 点查）+ CLI 续聊消息，取最后 limit 条 */
  history(composerId: string, limit = 50): HistoryItem[] {
    const ide = this.query((db) => {
      const row = db.prepare('SELECT json_extract(value, ?) AS h FROM cursorDiskKV WHERE key = ?').get('$.fullConversationHeadersOnly', `composerData:${composerId}`) as
        | { h: string | null }
        | undefined
      if (!row?.h) return []
      const headers = (JSON.parse(row.h) as { bubbleId: string; createdAt?: string }[]).slice(-limit)
      const stmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      const items: HistoryItem[] = []
      for (const h of headers) {
        const r = stmt.get(`bubbleId:${composerId}:${h.bubbleId}`) as { value: string | Uint8Array } | undefined
        if (!r) continue
        try {
          const o = JSON.parse(typeof r.value === 'string' ? r.value : Buffer.from(r.value).toString('utf8'))
          const it = bubbleItem(o, h.createdAt ? Date.parse(h.createdAt) : undefined)
          if (it) items.push(it)
        } catch {
          // 损坏的 bubble
        }
      }
      return items
    }, [] as HistoryItem[])
    const dir = this.chatDirs().get(composerId)
    const cli = dir ? (this.readChat(composerId, dir)?.items ?? []) : []
    return [...ide, ...cli].slice(-limit)
  }
}
