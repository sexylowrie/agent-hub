import { spawn } from 'node:child_process'
import { sessionKey, type Decision, type HubEvent } from '../core/events.ts'
import type {
  CommandExecutionRequestApprovalResponse,
  ServerNotification,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from './codex.types.ts'
import type { AgentAdapter, ApprovalRequest, RunOpts } from './types.ts'
import { AsyncQueue, onLines, safeParse, softKill, stderrTail } from './proc.ts'

// 协议以 recordings/codex/app-server-*.ndjson 为准；类型来自 scripts/gen-codex-types.sh 生成的 codex.types.ts。

const MAX_OUTPUT = 10_000
/** turn/completed 并关闭 stdin 后等待进程自行退出的时间 */
const EXIT_GRACE_MS = 2000
/** 发出 turn/interrupt 后等 turn/completed 的时间，超时直接结束进程 */
const INTERRUPT_GRACE_MS = 5000
const CLIENT_INFO = { name: 'agent-hub', version: '0.1.0' }

export function codexArgs(model: string): string[] {
  return ['-c', `model="${model}"`, 'app-server']
}

export function codexDecision(d: Decision): CommandExecutionRequestApprovalResponse['decision'] & string {
  return d === 'allow' ? 'accept' : d === 'allow_session' ? 'acceptForSession' : 'decline'
}

export interface ServerReq {
  id: number | string
  method: string
  params: any
}

export interface CodexParseResult {
  events: HubEvent[]
  request?: ServerReq
  done?: boolean
}

function itemInput(item: any): unknown {
  switch (item?.type) {
    case 'commandExecution':
      return { command: item.command, cwd: item.cwd }
    case 'fileChange':
      return { changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type })) }
    case 'mcpToolCall':
      return { server: item.server, tool: item.tool, arguments: item.arguments }
    case 'dynamicToolCall':
      return { tool: item.tool, arguments: item.arguments }
    default:
      return null
  }
}

function itemName(item: any): string {
  switch (item?.type) {
    case 'commandExecution':
      return 'shell'
    case 'fileChange':
      return 'apply_patch'
    case 'mcpToolCall':
      return `${item.server}/${item.tool}`
    case 'dynamicToolCall':
      return item.tool ?? 'tool'
    default:
      return item?.type ?? 'tool'
  }
}

function itemOutput(item: any): string {
  if (item?.type === 'commandExecution') return item.aggregatedOutput ?? ''
  if (item?.type === 'fileChange') return (item.changes ?? []).map((c: any) => `${c.kind?.type ?? 'update'} ${c.path}`).join('\n')
  if (item?.type === 'mcpToolCall') return JSON.stringify(item.result ?? item.error ?? '')
  if (item?.type === 'dynamicToolCall') return JSON.stringify(item.contentItems ?? '')
  return ''
}

function itemFailed(item: any): boolean {
  if (item?.status === 'failed' || item?.status === 'declined') return true
  return item?.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0
}

const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'])

/**
 * app-server 通知解析器（一轮）。只认本轮 turnId 的通知：resume 后会先收到上一轮的 thread/tokenUsage/updated（实测）。
 * 本轮 turnId 取自 turn/start 的响应（setCodexTurnId）或第一条 turn/started。
 */
export class CodexLineParser {
  private threadId: string | undefined
  private codexTurnId: string | undefined
  private started = false
  private finished = false
  private interrupted = false
  private items = new Map<string, any>()
  private streamed = new Set<string>()
  private lastAgentText: string | undefined
  private usage: { input?: number; output?: number } | undefined
  private errorReported = false

  constructor(private readonly o: { turnId: string; prompt: string; threadId?: string }) {
    this.threadId = o.threadId
  }

  get sessionId(): string | undefined {
    return this.threadId ? sessionKey('codex', this.threadId) : undefined
  }

  get turnIdOfCodex() {
    return this.codexTurnId
  }

  get hasStarted() {
    return this.started
  }

  setThreadId(id: string) {
    this.threadId = id
  }

  setCodexTurnId(id: string) {
    this.codexTurnId ??= id
  }

  markInterrupted() {
    this.interrupted = true
  }

  /** 该通知是否属于本轮 */
  private ours(p: any): boolean {
    if (!p || (this.threadId && p.threadId && p.threadId !== this.threadId)) return false
    const tid = p.turnId ?? p.turn?.id
    if (!tid) return false
    return tid === this.codexTurnId
  }

  feed(msg: any): CodexParseResult {
    const events: HubEvent[] = []
    if (this.finished) return { events }
    // 服务端请求（有 id 且有 method）：一律需回执，交给调用方
    if (msg?.method && msg.id !== undefined && msg.id !== null) {
      return { events, request: { id: msg.id, method: msg.method, params: msg.params ?? {} } }
    }
    const n = msg as ServerNotification
    const sessionId = this.sessionId
    if (!n?.method || !sessionId) return { events }
    const turnId = this.o.turnId
    const p: any = (n as any).params
    if (n.method === 'turn/started' && !this.codexTurnId && p?.threadId === this.threadId) this.codexTurnId = p.turn?.id
    if (!this.ours(p)) return { events }
    switch (n.method) {
      case 'turn/started': {
        if (this.started) break
        this.started = true
        events.push({ type: 'turn.started', sessionId, turnId, source: 'hub' })
        events.push({ type: 'message.user', sessionId, turnId, text: this.o.prompt })
        break
      }
      case 'item/agentMessage/delta': {
        if (!p.delta) break
        this.streamed.add(p.itemId)
        events.push({ type: 'message.delta', sessionId, turnId, text: p.delta })
        break
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        if (p.delta) events.push({ type: 'thinking.delta', sessionId, turnId, text: p.delta })
        break
      }
      case 'item/started': {
        const item = p.item
        if (!item?.id) break
        this.items.set(item.id, item)
        if (TOOL_ITEMS.has(item.type)) {
          events.push({ type: 'tool.call', sessionId, turnId, callId: item.id, name: itemName(item), input: itemInput(item), status: 'started' })
        }
        break
      }
      case 'item/completed': {
        const item = p.item
        if (!item?.id) break
        this.items.set(item.id, item)
        if (item.type === 'agentMessage') {
          if (item.text) this.lastAgentText = item.text
          if (item.text && !this.streamed.has(item.id)) events.push({ type: 'message.delta', sessionId, turnId, text: item.text })
        } else if (TOOL_ITEMS.has(item.type)) {
          events.push({
            type: 'tool.call',
            sessionId,
            turnId,
            callId: item.id,
            name: itemName(item),
            input: itemInput(item),
            status: 'done',
            output: itemOutput(item).slice(0, MAX_OUTPUT),
            isError: itemFailed(item),
          })
        }
        break
      }
      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last
        if (last) this.usage = { input: last.inputTokens, output: last.outputTokens }
        break
      }
      case 'error': {
        if (p.willRetry) break
        this.errorReported = true
        events.push({ type: 'error', sessionId, message: String(p.error?.message ?? 'codex 返回错误'), recoverable: true })
        break
      }
      case 'turn/completed': {
        this.finished = true
        const t = p.turn ?? {}
        let status: 'success' | 'error' | 'interrupted' =
          t.status === 'completed' ? 'success' : t.status === 'interrupted' ? 'interrupted' : 'error'
        if (status === 'error' && this.interrupted) status = 'interrupted'
        if (status === 'error' && !this.errorReported) {
          events.push({ type: 'error', sessionId, message: String(t.error?.message ?? `codex 轮次失败（${t.status}）`), recoverable: true })
        }
        events.push({
          type: 'turn.done',
          sessionId,
          turnId,
          status,
          resultText: this.lastAgentText,
          usage: this.usage,
          durationMs: typeof t.durationMs === 'number' ? t.durationMs : undefined,
        })
        return { events, done: true }
      }
    }
    return { events }
  }

  /** 审批请求 → ApprovalRequest；fileChange 请求本身不带路径，从此前 item/started 的 changes 取 */
  approvalOf(req: ServerReq): ApprovalRequest | undefined {
    const p = req.params ?? {}
    if (req.method === 'item/commandExecution/requestApproval') {
      const cmd = String(p.command ?? this.items.get(p.itemId)?.command ?? '')
      return {
        kind: 'command',
        summary: `命令: ${cmd}`.slice(0, 300),
        detail: { command: cmd, cwd: p.cwd, reason: p.reason, kind: p.kind },
        raw: req,
      }
    }
    if (req.method === 'item/fileChange/requestApproval') {
      const changes = (this.items.get(p.itemId)?.changes ?? []) as any[]
      const paths = changes.map((c) => c.path).join(', ')
      return {
        kind: 'file_write',
        summary: `写文件: ${paths || '(未知路径)'}`.slice(0, 300),
        detail: { changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type, diff: String(c.diff ?? '').slice(0, 4000) })), reason: p.reason, grantRoot: p.grantRoot },
        raw: req,
      }
    }
    return undefined
  }
}

/** 审批回执；未知的服务端请求回 JSON-RPC 错误，避免对方一直等 */
export function buildServerResponse(req: ServerReq, decision?: Decision) {
  if (decision === undefined) return { id: req.id, error: { code: -32601, message: `agent-hub 不支持 ${req.method}` } }
  return { id: req.id, result: { decision: codexDecision(decision) } }
}

export interface CodexThreadInfo {
  archived: boolean
  /** 需要覆盖的模型（线程自带模型不可用时）；undefined 表示沿用线程模型 */
  modelOverride?: string
}

export interface CodexAdapterOpts {
  bin: string
  model: string
  /** 续聊前查线程信息（Scanner 只读 threads 表） */
  threadInfo?: (threadId: string) => CodexThreadInfo | undefined
}

export class CodexAdapter implements AgentAdapter {
  readonly vendor = 'codex' as const

  constructor(private readonly o: CodexAdapterOpts) {}

  resume(vendorSessionId: string, cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent> {
    return this.run({ threadId: vendorSessionId, cwd, text, opts })
  }

  start(cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent> {
    return this.run({ cwd, text, opts })
  }

  private run(o: { threadId?: string; cwd: string; text: string; opts: RunOpts }): AsyncIterable<HubEvent> {
    const { opts } = o
    const q = new AsyncQueue<HubEvent>()
    const parser = new CodexLineParser({ turnId: opts.turnId, prompt: o.text, threadId: o.threadId })
    const child = spawn(this.o.bin, codexArgs(this.o.model), { cwd: o.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    if (child.pid) opts.onSpawn?.(child.pid)
    const tail = stderrTail(child)
    let finished = false
    let aborted = false
    let threadId = o.threadId
    let nextId = 1
    const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>()

    const write = (obj: unknown) => {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n')
    }
    const call = <T = any>(method: string, params: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        write({ id, method, params })
      })

    const finish = () => {
      if (finished) return
      finished = true
      child.stdin.end()
      const t = setTimeout(() => softKill(child, 'SIGTERM'), EXIT_GRACE_MS)
      t.unref()
      child.once('exit', () => clearTimeout(t))
    }

    const fail = (message: string) => {
      q.push({ type: 'error', sessionId: parser.sessionId, message, recoverable: true })
      if (parser.sessionId) q.push({ type: 'turn.done', sessionId: parser.sessionId, turnId: opts.turnId, status: aborted ? 'interrupted' : 'error' })
      finish()
    }

    const onAbort = () => {
      aborted = true
      parser.markInterrupted()
      const codexTurnId = parser.turnIdOfCodex
      if (!threadId || !codexTurnId) return softKill(child, 'SIGTERM')
      call('turn/interrupt', { threadId, turnId: codexTurnId }).catch(() => {})
      const t = setTimeout(() => softKill(child, 'SIGTERM'), INTERRUPT_GRACE_MS)
      t.unref()
      child.once('exit', () => clearTimeout(t))
    }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })

    child.stdin.on('error', () => {})

    onLines(child, (line) => {
      const p = safeParse(line)
      if (!p.ok) {
        q.push({ type: 'error', sessionId: parser.sessionId, message: `无法解析的输出: ${line.slice(0, 200)}`, recoverable: true })
        return
      }
      const msg = p.value
      // 响应
      if (msg && msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
        const h = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) h.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))))
        else h.resolve(msg.result)
        return
      }
      const r = parser.feed(msg)
      for (const e of r.events) q.push(e)
      if (r.request) {
        const req = r.request
        const approval = parser.approvalOf(req)
        if (!approval) {
          write(buildServerResponse(req))
          q.push({ type: 'error', sessionId: parser.sessionId, message: `未处理的 codex 请求 ${req.method}，已拒绝`, recoverable: true })
        } else {
          // 先让 Core 处理完此前的事件，保证 approval.request 排在 tool.call started 之后
          q.whenDrained()
            .then(() => opts.onApproval(approval))
            .catch(() => 'deny' as const)
            .then((d) => write(buildServerResponse(req, d)))
        }
      }
      if (r.done) finish()
    })

    void (async () => {
      await call('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } })
      write({ method: 'initialized', params: {} })
      const sandbox = opts.force ? 'workspace-write' : 'read-only'
      if (threadId) {
        const info = this.o.threadInfo?.(threadId)
        if (info?.archived) await call('thread/unarchive', { threadId })
        const params: ThreadResumeParams = { threadId, approvalPolicy: 'on-request', sandbox, excludeTurns: true }
        if (info?.modelOverride) params.model = info.modelOverride
        try {
          await call('thread/resume', params)
        } catch (e) {
          // 线程信息过期（刚在 GUI 里归档）：解档后重试一次
          if (!/is archived/.test((e as Error).message)) throw e
          await call('thread/unarchive', { threadId })
          await call('thread/resume', params)
        }
      } else {
        const params: ThreadStartParams = { cwd: o.cwd, approvalPolicy: 'on-request', sandbox }
        const r = await call<{ thread: { id: string } }>('thread/start', params)
        const id = r.thread.id
        threadId = id
        parser.setThreadId(id)
        const now = Date.now()
        q.push({
          type: 'session.upsert',
          session: {
            id: sessionKey('codex', id),
            vendor: 'codex',
            vendorSessionId: id,
            cwd: o.cwd,
            title: o.text.slice(0, 60),
            origin: 'hub',
            state: 'running',
            resumable: true,
            archived: false,
            vendorUpdatedAt: now,
            updatedAt: now,
          },
        })
      }
      if (aborted || !threadId) return finish()
      const turnParams: TurnStartParams = { threadId, input: [{ type: 'text', text: o.text, text_elements: [] }] }
      const tr = await call<{ turn: { id: string } }>('turn/start', turnParams)
      parser.setCodexTurnId(tr.turn.id)
      if (aborted) onAbort()
    })().catch((e) => {
      if (!finished) fail(`codex 调用失败: ${(e as Error).message}`)
    })

    child.on('error', (err) => {
      q.push({ type: 'error', sessionId: parser.sessionId, message: `拉起 codex 失败: ${err.message}`, recoverable: false })
      q.end()
    })

    child.on('close', (code, signal) => {
      opts.signal.removeEventListener('abort', onAbort)
      for (const h of pending.values()) h.reject(new Error('codex 进程已退出'))
      pending.clear()
      if (!finished) {
        finished = true
        const sessionId = parser.sessionId
        if (!aborted) {
          q.push({ type: 'error', sessionId, message: `codex 异常退出 code=${code} signal=${signal} ${tail()}`.trim(), recoverable: true })
        }
        if (sessionId) q.push({ type: 'turn.done', sessionId, turnId: opts.turnId, status: aborted ? 'interrupted' : 'error' })
      }
      q.end()
    })

    return q
  }
}
