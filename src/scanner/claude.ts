import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { sessionKey, type Holder, type HistoryItem, type HubEvent, type Origin, type SessionState, type SessionView } from '../core/events.ts'
import { tmuxTargetOf } from './tmux.ts'

// 字段与判定依据见 docs/spec/01-verified-facts.md「Claude Code」与 05-scanner.md。

const CHUNK = 256 * 1024
const HEAD_MAX = 4 * 1024 * 1024
const TITLE_LEN = 60
const PREVIEW_LEN = 200
/** 会话详情只读文件末尾这么多字节 */
const HISTORY_BYTES = 2 * 1024 * 1024
export const DEFAULT_ATTACHED_QUIET_MS = 60_000

export interface ClaudeHead {
  sessionId?: string
  entrypoint?: string
  cwd?: string
  isSidechain?: boolean
  firstUserText?: string
  aiTitle?: string
}

export interface ClaudeTail {
  aiTitle?: string
  lastAssistantText?: string
  /** 最后一条人类输入之后还没有 turn_duration / 中断标记；尾部块里两者都没有时也按未收尾算 */
  turnOpen: boolean
}

/** 用户消息的纯文本；工具结果或无文本返回 undefined */
function userText(o: any): string | undefined {
  const c = o?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === 'tool_result')) return undefined
    const t = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
    return t || undefined
  }
  return undefined
}

/** 真实的人类输入：排除 meta、侧链、命令包装（<command-name> 等）、中断提示 */
export function isHumanPrompt(o: any): string | undefined {
  if (o?.type !== 'user' || o.isMeta || o.isSidechain) return undefined
  const t = userText(o)?.trim()
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return undefined
  return t
}

function assistantText(o: any): string | undefined {
  if (o?.type !== 'assistant' || o.isSidechain) return undefined
  const c = o.message?.content
  if (!Array.isArray(c)) return undefined
  const t = c.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n')
  return t || undefined
}

function parseLines(text: string): any[] {
  const out: any[] = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      // 截断的首/尾行，忽略
    }
  }
  return out
}

export function parseHead(lines: any[]): ClaudeHead & { complete: boolean } {
  const h: ClaudeHead = {}
  let sawUser = false
  for (const o of lines) {
    if (!h.entrypoint && typeof o.entrypoint === 'string') h.entrypoint = o.entrypoint
    if (o.type === 'ai-title' && o.aiTitle) h.aiTitle = o.aiTitle
    if (o.type === 'user' && !sawUser) {
      sawUser = true
      h.sessionId = o.sessionId
      h.cwd = o.cwd
      h.isSidechain = !!o.isSidechain
      if (typeof o.entrypoint === 'string') h.entrypoint = o.entrypoint
    }
    if (!h.firstUserText) {
      const t = isHumanPrompt(o)
      if (t) h.firstUserText = t
    }
  }
  return { ...h, complete: sawUser && !!h.firstUserText }
}

export function parseTail(lines: any[]): ClaudeTail {
  const t: ClaudeTail = { turnOpen: true }
  for (const o of lines) {
    if (o.type === 'ai-title' && o.aiTitle) t.aiTitle = o.aiTitle
    const a = assistantText(o)
    if (a) t.lastAssistantText = a
    if (o.isSidechain) continue
    if (isHumanPrompt(o)) t.turnOpen = true
    else if (o.type === 'system' && o.subtype === 'turn_duration') t.turnOpen = false
    else if (o.type === 'user' && userText(o)?.trim().startsWith('[Request interrupted')) t.turnOpen = false
  }
  return t
}

/**
 * 空闲判定，宁可误判为 running：
 * - 有活 pid（终端 / Desktop 开着）：最后一轮已收尾且文件静默超过 attachedQuietMs → attached，否则 running
 * - 没有活 pid：静默超过 quietMs 才 idle
 */
export function claudeState(o: {
  livePid: boolean
  mtimeMs: number
  now: number
  quietMs: number
  /** 不传则有活 pid 一律 running */
  attachedQuietMs?: number
  turnOpen?: boolean
}): SessionState {
  if (o.livePid) {
    const quiet = o.attachedQuietMs !== undefined && o.now - o.mtimeMs > o.attachedQuietMs
    return quiet && o.turnOpen === false ? 'attached' : 'running'
  }
  if (o.now - o.mtimeMs <= o.quietMs) return 'running'
  return 'idle'
}

export function originOf(entrypoint: string | undefined): Origin {
  return entrypoint === 'claude-desktop' ? 'desktop' : 'cli'
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

export function readHead(file: string, size: number): ReturnType<typeof parseHead> {
  let len = Math.min(CHUNK, size)
  for (;;) {
    let text = readRange(file, 0, len)
    if (len < size) text = text.slice(0, text.lastIndexOf('\n') + 1)
    const h = parseHead(parseLines(text))
    if (h.complete || len >= size || len >= HEAD_MAX) return h
    len = Math.min(len * 4, size, HEAD_MAX)
  }
}

export function readTail(file: string, size: number): ClaudeTail {
  const start = Math.max(0, size - CHUNK)
  let text = readRange(file, start, size - start)
  if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  return parseTail(parseLines(text))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface LiveProcess {
  pid: number
  /** 登记文件里的 entrypoint（cli / claude-desktop），用来区分终端与 Desktop */
  entrypoint?: string
}

/** ~/.claude/sessions/<pid>.json → sessionId 集合（只算活进程） */
export function liveSessionIds(sessionsDir: string, alive = pidAlive): Set<string> {
  return new Set(liveSessions(sessionsDir, alive).keys())
}

/** ~/.claude/sessions/<pid>.json → sessionId → 持有它的活进程 */
export function liveSessions(sessionsDir: string, alive = pidAlive): Map<string, LiveProcess> {
  const out = new Map<string, LiveProcess>()
  let files: string[]
  try {
    files = readdirSync(sessionsDir)
  } catch {
    return out
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const o = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
      const pid = Number(o.pid ?? basename(f, '.json'))
      if (o.sessionId && pid && alive(pid)) {
        out.set(o.sessionId, { pid, ...(typeof o.entrypoint === 'string' ? { entrypoint: o.entrypoint } : {}) })
      }
    } catch {
      // 写到一半的文件，下次再读
    }
  }
  return out
}

export interface ClaudeScannerOpts {
  projectsDir?: string
  sessionsDir?: string
  recentDays: number
  quietMs: number
  /** 有活 pid 时文件静默超过这么久（且最后一轮已收尾）算 attached，默认 60s */
  attachedQuietMs?: number
  /** attached 会话所在的 tmux pane（默认查 tmux）；返回 undefined 表示不在 tmux 里 */
  tmuxTarget?: (pid: number) => string | undefined
  /** Hub 已登记（origin=hub）的会话即使是 sdk-cli 也纳入 */
  isHubSession?: (vendorSessionId: string) => boolean
  now?: () => number
}

interface FileMeta {
  mtimeMs: number
  size: number
  head: ReturnType<typeof parseHead>
  tail: ClaudeTail
}

export class ClaudeScanner {
  readonly projectsDir: string
  readonly sessionsDir: string
  private meta = new Map<string, FileMeta>()
  private offsets = new Map<string, number>()
  /** 桌面端进度：当前 turn（按用户消息 uuid）*/
  private desktopTurn = new Map<string, string>()
  private readonly now: () => number

  constructor(private readonly o: ClaudeScannerOpts) {
    this.projectsDir = o.projectsDir ?? join(homedir(), '.claude', 'projects')
    this.sessionsDir = o.sessionsDir ?? join(homedir(), '.claude', 'sessions')
    this.now = o.now ?? Date.now
  }

  /** 列出 recentDays 内的会话文件（跳过 subagents） */
  listFiles(): string[] {
    const cutoff = this.now() - this.o.recentDays * 86_400_000
    const out: string[] = []
    let dirs: string[]
    try {
      dirs = readdirSync(this.projectsDir)
    } catch {
      return out
    }
    for (const d of dirs) {
      const dir = join(this.projectsDir, d)
      let files: string[]
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const p = join(dir, f)
        try {
          if (statSync(p).mtimeMs >= cutoff) out.push(p)
        } catch {
          // 刚被删
        }
      }
    }
    return out
  }

  /** 全量扫描，返回应展示的会话 */
  scanAll(): SessionView[] {
    const live = liveSessions(this.sessionsDir)
    const out: SessionView[] = []
    const seen = new Set<string>()
    for (const f of this.listFiles()) {
      seen.add(f)
      const v = this.scanFile(f, live)
      if (v) out.push(v)
    }
    for (const k of this.meta.keys()) if (!seen.has(k)) this.meta.delete(k)
    return out
  }

  scanFile(file: string, live = liveSessions(this.sessionsDir)): SessionView | undefined {
    if (file.includes('/subagents/')) return undefined
    let st
    try {
      st = statSync(file)
    } catch {
      return undefined
    }
    let m = this.meta.get(file)
    if (!m || m.mtimeMs !== st.mtimeMs || m.size !== st.size) {
      const head = m && m.head.complete ? m.head : readHead(file, st.size)
      m = { mtimeMs: st.mtimeMs, size: st.size, head, tail: readTail(file, st.size) }
      this.meta.set(file, m)
    }
    const h = m.head
    const vendorSessionId = h.sessionId ?? basename(file, '.jsonl')
    if (h.isSidechain) return undefined
    if (!h.sessionId) return undefined // 没有用户消息的空文件
    const isHub = this.o.isHubSession?.(vendorSessionId) ?? false
    if (h.entrypoint === 'sdk-cli' && !isHub) return undefined

    const now = this.now()
    const title = m.tail.aiTitle ?? h.aiTitle ?? h.firstUserText?.slice(0, TITLE_LEN) ?? null
    const proc = live.get(vendorSessionId)
    const state = claudeState({
      livePid: !!proc,
      mtimeMs: st.mtimeMs,
      now,
      quietMs: this.o.quietMs,
      attachedQuietMs: this.o.attachedQuietMs ?? DEFAULT_ATTACHED_QUIET_MS,
      turnOpen: m.tail.turnOpen,
    })
    const v: SessionView = {
      id: sessionKey('claude', vendorSessionId),
      vendor: 'claude',
      vendorSessionId,
      cwd: h.cwd ?? null,
      title,
      origin: isHub ? 'hub' : originOf(h.entrypoint),
      state,
      resumable: !!h.cwd,
      archived: false,
      vendorUpdatedAt: Math.round(st.mtimeMs),
      updatedAt: now,
    }
    if (state === 'attached' && proc) v.holder = this.holderOf(proc, h.entrypoint)
    if (!h.cwd) v.unresumableReason = '会话文件缺少 cwd'
    if (m.tail.lastAssistantText) v.lastMessagePreview = m.tail.lastAssistantText.slice(0, PREVIEW_LEN)
    return v
  }

  private holderOf(p: LiveProcess, sessionEntrypoint: string | undefined): Holder {
    const gui = (p.entrypoint ?? sessionEntrypoint) === 'claude-desktop'
    if (gui) return { kind: 'gui', pid: p.pid }
    let target: string | undefined
    try {
      target = (this.o.tmuxTarget ?? tmuxTargetOf)(p.pid)
    } catch {
      target = undefined
    }
    return { kind: 'cli', pid: p.pid, ...(target ? { tmux: { target } } : {}) }
  }

  /** 按会话 id 找文件：先查缓存，再逐个项目目录找 `<id>.jsonl` */
  findFile(vendorSessionId: string): string | undefined {
    const name = `${vendorSessionId}.jsonl`
    for (const f of this.meta.keys()) if (basename(f) === name) return f
    let dirs: string[] = []
    try {
      dirs = readdirSync(this.projectsDir)
    } catch {
      return undefined
    }
    for (const d of dirs) {
      const p = join(this.projectsDir, d, name)
      try {
        statSync(p)
        return p
      } catch {
        // 不在这个目录
      }
    }
    return undefined
  }

  /** 续聊前的实时复核：重新读文件与活 pid */
  refresh(vendorSessionId: string): SessionView | undefined {
    const f = this.findFile(vendorSessionId)
    return f ? this.scanFile(f) : undefined
  }

  /** 会话详情：读文件末尾，取最后 limit 条 */
  history(vendorSessionId: string, limit = 50): HistoryItem[] {
    const f = this.findFile(vendorSessionId)
    if (!f) return []
    let size: number
    try {
      size = statSync(f).size
    } catch {
      return []
    }
    const start = Math.max(0, size - HISTORY_BYTES)
    let text = readRange(f, start, size - start)
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return historyItems(parseLines(text)).slice(-limit)
  }

  /** 丢弃文件中尚未读取的新行（Hub 轮次自己写入的，Adapter 已产出事件） */
  skipToEnd(file: string) {
    try {
      this.offsets.set(file, statSync(file).size)
    } catch {
      // 文件不存在
    }
  }

  /**
   * 增量读取文件新行，转成桌面端进度事件。首次调用只记录 offset，不回放历史。
   */
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
    return progressEvents(parseLines(text), sessionId, this.desktopTurn)
  }
}

/** 会话文件行 → 历史条目（人类输入、assistant 文本、工具调用）；按行的 entrypoint 区分桌面端与 CLI（含 Hub 续聊） */
export function historyItems(lines: any[]): HistoryItem[] {
  const out: HistoryItem[] = []
  for (const o of lines) {
    if (o.isSidechain) continue
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || undefined : undefined
    const source = o.entrypoint === 'claude-desktop' ? 'desktop' : 'cli'
    const prompt = isHumanPrompt(o)
    if (prompt) {
      out.push({ role: 'user', text: prompt, at, source })
      continue
    }
    if (o.type !== 'assistant') continue
    for (const b of o.message?.content ?? []) {
      if (b?.type === 'text' && b.text) out.push({ role: 'assistant', text: b.text, at, source })
      else if (b?.type === 'tool_use') out.push({ role: 'tool', text: JSON.stringify(b.input ?? {}).slice(0, 2000), toolName: b.name, at, source })
    }
  }
  return out
}

/** 会话文件行 → 桌面端进度事件（source=desktop）。turns 记录每个会话当前轮次 id。 */
export function progressEvents(lines: any[], sessionId: string, turns: Map<string, string>): HubEvent[] {
  const out: HubEvent[] = []
  for (const o of lines) {
    if (o.isSidechain) continue
    const prompt = isHumanPrompt(o)
    if (prompt) {
      const turnId = `desktop:${o.uuid ?? Date.now()}`
      turns.set(sessionId, turnId)
      out.push({ type: 'turn.started', sessionId, turnId, source: 'desktop' })
      out.push({ type: 'message.user', sessionId, turnId, text: prompt })
      continue
    }
    const turnId = turns.get(sessionId)
    if (o.type === 'assistant') {
      for (const b of o.message?.content ?? []) {
        if (b.type === 'text' && b.text) out.push({ type: 'message.delta', sessionId, turnId, text: b.text })
        else if (b.type === 'tool_use')
          out.push({ type: 'tool.call', sessionId, turnId, callId: b.id, name: b.name, input: b.input, status: 'started' })
      }
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type !== 'tool_result') continue
        const output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        out.push({
          type: 'tool.call',
          sessionId,
          turnId,
          callId: b.tool_use_id,
          name: 'unknown',
          input: null,
          status: 'done',
          output: output.slice(0, 10_000),
          isError: !!b.is_error,
        })
      }
    } else if (o.type === 'system' && o.subtype === 'turn_duration') {
      out.push({ type: 'turn.done', sessionId, turnId, status: 'success', durationMs: o.durationMs })
      turns.delete(sessionId)
    }
  }
  return out
}
