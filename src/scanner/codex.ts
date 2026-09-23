import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sessionKey, type HubEvent, type Origin, type SessionState, type SessionView } from '../core/events.ts'

// 字段与判定依据见 docs/spec/01-verified-facts.md「Codex」与 05-scanner.md。
// rollout 行格式以 recordings/codex/rollout-*.jsonl 为准。

const CHUNK = 256 * 1024
const TITLE_LEN = 60
const PREVIEW_LEN = 200
/** Hub 自起 app-server 时 clientInfo.name，落到 threads.originator */
export const HUB_ORIGINATOR = 'agent-hub'
const NO_ROLLOUT = '无本地会话文件（ChatGPT 聊天线程）'

export interface ThreadRow {
  id: string
  rollout_path: string | null
  cwd: string | null
  title: string | null
  name: string | null
  first_user_message: string | null
  source: string | null
  originator: string | null
  archived: number
  updated_at_ms: number | null
  updated_at: number | null
  model: string | null
}

const COLS = 'id, rollout_path, cwd, title, name, first_user_message, source, originator, archived, updated_at_ms, updated_at, model'

export interface RolloutTail {
  /** 最后一个 task_started 之后没有 task_complete / turn_aborted */
  openTurn: boolean
  lastAgentText?: string
}

function parseLines(text: string): any[] {
  const out: any[] = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      // 截断的首/尾行
    }
  }
  return out
}

export function parseRolloutTail(lines: any[]): RolloutTail {
  const t: RolloutTail = { openTurn: false }
  for (const o of lines) {
    if (o?.type !== 'event_msg') continue
    const p = o.payload
    if (p?.type === 'task_started') t.openTurn = true
    else if (p?.type === 'task_complete' || p?.type === 'turn_aborted') {
      t.openTurn = false
      if (typeof p.last_agent_message === 'string' && p.last_agent_message) t.lastAgentText = p.last_agent_message
    } else if (p?.type === 'item_completed' && p.item?.type === 'AgentMessage') {
      const text = agentText(p.item)
      if (text) t.lastAgentText = text
    }
  }
  return t
}

function agentText(item: any): string | undefined {
  const c = item?.content
  if (!Array.isArray(c)) return undefined
  const t = c.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('')
  return t || undefined
}

function userText(item: any): string | undefined {
  const c = item?.content
  if (!Array.isArray(c)) return undefined
  const t = c.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('').trim()
  return t || undefined
}

/**
 * 空闲判定：线程写锁被持有（GUI 打开着该线程，或有别的 app-server 在写）→ running；
 * rollout 最近 quietMs 内有写入 → running；
 * 最后一轮未收尾（task_started 后没有 complete/aborted）且有活的 codex 进程 → running（GUI 可能在跑或等审批）；
 * 未收尾但本机没有任何 codex 进程 → 视为崩溃遗留，idle。宁可误判为 running。
 */
export function codexState(o: {
  openTurn: boolean
  mtimeMs: number
  now: number
  quietMs: number
  codexAlive: () => boolean
  writerLocked?: boolean
}): SessionState {
  if (o.writerLocked) return 'running'
  if (o.now - o.mtimeMs <= o.quietMs) return 'running'
  if (o.openTurn && o.codexAlive()) return 'running'
  return 'idle'
}

export function originOf(r: Pick<ThreadRow, 'source' | 'originator'>): Origin {
  if (r.originator === HUB_ORIGINATOR) return 'hub'
  return r.source === 'vscode' ? 'desktop' : 'cli'
}

function readRange(file: string, start: number, len: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function readRolloutTail(file: string, size: number): RolloutTail {
  const start = Math.max(0, size - CHUNK)
  let text = readRange(file, start, size - start)
  if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  return parseRolloutTail(parseLines(text))
}

/** 本机是否有活的 codex 进程（ChatGPT App 的 app-server、codex exec、CLI 等） */
export function anyCodexProcess(): boolean {
  try {
    const out = execFileSync('ps', ['-Ao', 'comm='], { encoding: 'utf8', timeout: 5000 })
    return out.split('\n').some((l) => basename(l.trim()) === 'codex')
  } catch {
    return true // 查不到就保守处理
  }
}

/** ~/.codex/models_cache.json 里当前账号可用的模型 slug；读不到返回 undefined */
export function availableModels(file = join(homedir(), '.codex', 'models_cache.json')): Set<string> | undefined {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'))
    const list = (m.models ?? []).map((x: any) => x?.slug).filter((x: unknown) => typeof x === 'string')
    return list.length ? new Set(list) : undefined
  } catch {
    return undefined
  }
}

/**
 * 续聊用的线程信息。thread/resume 沿用线程自带模型（-c model 压不住），而 thread/resume 传 model 会改写线程的模型，
 * 所以只在线程模型不在可用列表里时才覆盖为 fallbackModel。
 */
export function modelOverrideFor(threadModel: string | null | undefined, available: Set<string> | undefined, fallbackModel: string): string | undefined {
  if (!threadModel) return undefined
  if (available ? available.has(threadModel) : true) return undefined
  return fallbackModel
}

/**
 * 哪些锁文件正被进程打开（持有 flock）。Node 没有 flock API，用一次 lsof 批量查；
 * lsof 在部分文件未被打开时退出码为 1，stdout 仍列出被打开的那些。查询失败时保守地视为全部持有。
 */
export function heldLockFiles(files: string[]): Set<string> {
  if (!files.length) return new Set()
  let out: string
  try {
    out = execFileSync('lsof', ['-Fn', '--', ...files], { encoding: 'utf8', timeout: 5000 })
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    if (err.status !== 1) return new Set(files)
    out = err.stdout ?? ''
  }
  return new Set(out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)))
}

export interface CodexScannerOpts {
  stateDb?: string
  recentDays: number
  quietMs: number
  isHubSession?: (threadId: string) => boolean
  codexAlive?: () => boolean
  /** 默认 ~/.codex/thread-writer-locks */
  locksDir?: string
  heldLocks?: (files: string[]) => Set<string>
  now?: () => number
}

interface FileMeta {
  mtimeMs: number
  size: number
  tail: RolloutTail
}

export class CodexScanner {
  readonly stateDb: string
  readonly codexHome: string
  readonly locksDir: string
  private db: DatabaseSync | undefined
  private meta = new Map<string, FileMeta>()
  private offsets = new Map<string, number>()
  private desktopTurn = new Map<string, string>()
  /** rollout 路径 → threadId（进度增量用） */
  private byPath = new Map<string, string>()
  private readonly now: () => number

  constructor(private readonly o: CodexScannerOpts) {
    this.codexHome = join(homedir(), '.codex')
    this.stateDb = o.stateDb ?? join(this.codexHome, 'state_5.sqlite')
    this.locksDir = o.locksDir ?? join(this.codexHome, 'thread-writer-locks')
    this.now = o.now ?? Date.now
  }

  private query<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
    try {
      this.db ??= new DatabaseSync(this.stateDb, { readOnly: true })
      return fn(this.db)
    } catch {
      try {
        this.db?.close()
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

  threads(sinceMs: number): ThreadRow[] {
    return this.query(
      (db) =>
        db
          .prepare(`SELECT ${COLS} FROM threads WHERE COALESCE(updated_at_ms, updated_at * 1000) >= ? ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC`)
          .all(sinceMs) as unknown as ThreadRow[],
      [],
    )
  }

  thread(id: string): ThreadRow | undefined {
    return this.query((db) => db.prepare(`SELECT ${COLS} FROM threads WHERE id = ?`).get(id) as unknown as ThreadRow | undefined, undefined)
  }

  /** 写锁被持有的线程 id（锁文件释放后会删除；进程崩溃可能留下无人持有的文件，所以还要查是否真被持有） */
  lockedThreads(): Set<string> {
    let names: string[]
    try {
      names = readdirSync(this.locksDir).filter((f) => f.endsWith('.lock') && !f.startsWith('.'))
    } catch {
      return new Set()
    }
    if (!names.length) return new Set()
    const files = names.map((f) => join(this.locksDir, f))
    // lsof 输出的是真实路径，按文件名比对
    const held = new Set([...(this.o.heldLocks ?? heldLockFiles)(files)].map((f) => basename(f)))
    return new Set(names.filter((f) => held.has(f)).map((f) => basename(f, '.lock')))
  }

  private view(r: ThreadRow, codexAlive: () => boolean, locked: Set<string>): SessionView {
    const now = this.now()
    const isHub = this.o.isHubSession?.(r.id) ?? false
    const title = r.name || r.title || r.first_user_message?.slice(0, TITLE_LEN) || null
    const v: SessionView = {
      id: sessionKey('codex', r.id),
      vendor: 'codex',
      vendorSessionId: r.id,
      cwd: r.cwd || null,
      title: title ? title.slice(0, TITLE_LEN * 2) : null,
      origin: isHub ? 'hub' : originOf(r),
      state: 'idle',
      resumable: true,
      archived: !!r.archived,
      vendorUpdatedAt: r.updated_at_ms ?? (r.updated_at ? r.updated_at * 1000 : undefined),
      updatedAt: now,
    }
    let st
    try {
      st = r.rollout_path ? statSync(r.rollout_path) : undefined
    } catch {
      st = undefined
    }
    if (!st || !r.rollout_path) {
      v.resumable = false
      v.unresumableReason = NO_ROLLOUT
      return v
    }
    let m = this.meta.get(r.rollout_path)
    if (!m || m.mtimeMs !== st.mtimeMs || m.size !== st.size) {
      m = { mtimeMs: st.mtimeMs, size: st.size, tail: readRolloutTail(r.rollout_path, st.size) }
      this.meta.set(r.rollout_path, m)
    }
    this.byPath.set(r.rollout_path, r.id)
    v.state = codexState({ openTurn: m.tail.openTurn, mtimeMs: st.mtimeMs, now, quietMs: this.o.quietMs, codexAlive, writerLocked: locked.has(r.id) })
    if (!v.cwd) {
      v.resumable = false
      v.unresumableReason = '线程缺少 cwd'
    }
    if (m.tail.lastAgentText) v.lastMessagePreview = m.tail.lastAgentText.slice(0, PREVIEW_LEN)
    return v
  }

  /** codex 进程探测只在有未收尾轮次时做，且一次扫描最多一次 */
  private aliveProbe(): () => boolean {
    let cached: boolean | undefined
    return () => (cached ??= (this.o.codexAlive ?? anyCodexProcess)())
  }

  scanAll(): SessionView[] {
    const cutoff = this.now() - this.o.recentDays * 86_400_000
    const alive = this.aliveProbe()
    const locked = this.lockedThreads()
    return this.threads(cutoff).map((r) => this.view(r, alive, locked))
  }

  refresh(threadId: string): SessionView | undefined {
    const r = this.thread(threadId)
    return r ? this.view(r, this.aliveProbe(), this.lockedThreads()) : undefined
  }

  /** 当前已知的 rollout 文件（首次扫描后用来记录 offset） */
  rolloutFiles(): string[] {
    return [...this.byPath.keys()]
  }

  threadIdOf(file: string): string | undefined {
    return this.byPath.get(file)
  }

  skipToEnd(file: string) {
    try {
      this.offsets.set(file, statSync(file).size)
    } catch {
      // 文件不存在
    }
  }

  threadInfo(threadId: string, fallbackModel: string): { archived: boolean; modelOverride?: string } | undefined {
    const r = this.thread(threadId)
    if (!r) return undefined
    return { archived: !!r.archived, modelOverride: modelOverrideFor(r.model, availableModels(), fallbackModel) }
  }

  rolloutOf(threadId: string): string | undefined {
    return this.thread(threadId)?.rollout_path ?? undefined
  }

  /** 增量读取 rollout 新行，转成桌面端进度事件。首次调用只记录 offset，不回放历史。 */
  readProgress(file: string, sessionId: string): HubEvent[] {
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return []
    }
    const off = this.offsets.get(file)
    if (off === undefined || size < off) {
      this.offsets.set(file, size)
      return []
    }
    if (size === off) return []
    let text = readRange(file, off, size - off)
    const end = text.lastIndexOf('\n')
    if (end < 0) return []
    text = text.slice(0, end + 1)
    this.offsets.set(file, off + Buffer.byteLength(text))
    return rolloutProgress(parseLines(text), sessionId, this.desktopTurn)
  }
}

const TOOL_ITEMS = new Set(['CommandExecution', 'FileChange', 'McpToolCall', 'WebSearch', 'DynamicToolCall'])

function toolOutput(item: any): string {
  if (typeof item.aggregated_output === 'string') return item.aggregated_output
  if (item.changes) return Object.keys(item.changes).join('\n')
  if (item.result !== undefined) return typeof item.result === 'string' ? item.result : JSON.stringify(item.result)
  return ''
}

/** rollout 行 → 桌面端进度事件（source=desktop）。turns 记录每个会话当前轮次 id。 */
export function rolloutProgress(lines: any[], sessionId: string, turns: Map<string, string>): HubEvent[] {
  const out: HubEvent[] = []
  for (const o of lines) {
    const p = o?.payload
    if (o?.type === 'event_msg') {
      if (p?.type === 'task_started') {
        const turnId = `desktop:${p.turn_id}`
        turns.set(sessionId, turnId)
        out.push({ type: 'turn.started', sessionId, turnId, source: 'desktop' })
        continue
      }
      const turnId = turns.get(sessionId)
      if (p?.type === 'item_completed') {
        const item = p.item
        if (item?.type === 'UserMessage') {
          const text = userText(item)
          if (text) out.push({ type: 'message.user', sessionId, turnId, text })
        } else if (item?.type === 'AgentMessage') {
          const text = agentText(item)
          if (text) out.push({ type: 'message.delta', sessionId, turnId, text })
        } else if (TOOL_ITEMS.has(item?.type)) {
          const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
          out.push({
            type: 'tool.call',
            sessionId,
            turnId,
            callId: String(item.id),
            name: item.type,
            input: item.command ?? item.changes ?? item.arguments ?? null,
            status: 'done',
            output: toolOutput(item).slice(0, 10_000),
            isError: failed,
          })
        }
      } else if (p?.type === 'task_complete' || p?.type === 'turn_aborted') {
        out.push({
          type: 'turn.done',
          sessionId,
          turnId,
          status: p.type === 'turn_aborted' ? 'interrupted' : 'success',
          resultText: typeof p.last_agent_message === 'string' ? p.last_agent_message : undefined,
          durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : undefined,
        })
        turns.delete(sessionId)
      }
    } else if (o?.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call')) {
      let input: unknown = p.arguments ?? p.input ?? null
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input)
        } catch {
          // 保留原文
        }
      }
      out.push({ type: 'tool.call', sessionId, turnId: turns.get(sessionId), callId: String(p.call_id), name: p.name ?? 'tool', input, status: 'started' })
    }
  }
  return out
}
