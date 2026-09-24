import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { sessionKey, type Decision, type HubEvent } from '../core/events.ts'
import type { AgentAdapter, ApprovalRequest, RunOpts } from './types.ts'
import { AsyncQueue, onLines, safeParse, softKill, stderrTail } from './proc.ts'

const MAX_OUTPUT = 10_000
/** result 之后等待进程自行退出的时间 */
const EXIT_GRACE_MS = 3000
/** 扣住的 result 等待 command_lifecycle 的时间（旧 CLI 兼容） */
const LIFECYCLE_WAIT_MS = 5000

export interface ControlRequest {
  requestId: string
  toolName: string
  input: unknown
  raw: any
}

export interface ParseResult {
  events: HubEvent[]
  control?: ControlRequest
  done?: boolean
  /** 收到 result 但尚未见过任何 command_lifecycle：由调用方稍后 flushDeferred() */
  deferred?: boolean
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === 'text' ? c.text : typeof c === 'string' ? c : JSON.stringify(c)))
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

/**
 * Claude stream-json 行解析器（状态机）。字段以 recordings/claude/*.ndjson 为准。
 * - 没有 --replay-user-messages 时 stdout 不回显用户输入，message.user 由解析器在 init 后按 prompt 补发
 * - 有 partial 时文本走 stream_event.text_delta，assistant 整块里同一 message 的文本不再重复
 * - 输入带 uuid 时 claude 输出 command_lifecycle{command_uuid,state:queued|started|completed}。
 *   resume 时可能先处理遗留轮次（如上次后台任务的 task-notification）并输出一个不属于我们的 result，
 *   这个遗留 result 可能早于我们的 queued 到达（实测竞态），所以带 commandUuid 时严格只认自家命令 started 之后的输出。
 *   兼容不输出 lifecycle 的旧 CLI：result 到达时若从未见过 lifecycle，先扣住，由调用方超时后 flushDeferred() 放行。
 */
export class ClaudeLineParser {
  private started = false
  private vendorSessionId: string | undefined
  private currentMsgId: string | undefined
  private streamedText = new Set<string>()
  private streamedThinking = new Set<string>()
  private tools = new Map<string, { name: string; input: unknown }>()
  private lifecycleSeen = false
  private ourStarted = false
  private finished = false
  /** 旧 CLI（无 lifecycle）兼容模式 */
  private legacy = false
  private deferredResult: any
  private interrupted = false

  constructor(
    private readonly o: {
      turnId: string
      prompt: string
      vendorSessionId?: string
      cwd?: string
      isStart?: boolean
      /** 写入 stdin 的 user 消息 uuid，对应 command_lifecycle.command_uuid */
      commandUuid?: string
    },
  ) {
    this.vendorSessionId = o.vendorSessionId
  }

  get sessionId(): string | undefined {
    return this.vendorSessionId ? sessionKey('claude', this.vendorSessionId) : undefined
  }

  get hasStarted() {
    return this.started
  }

  /** 当前输出是否属于本轮 */
  private get active() {
    return !this.o.commandUuid || this.legacy || this.ourStarted
  }

  /** 由 Hub 发起中断（SIGINT）后调用：随后的 error_during_execution 视为 interrupted */
  markInterrupted() {
    this.interrupted = true
  }

  /** 扣住的 result 超时仍未见 lifecycle：视为旧 CLI，放行 */
  flushDeferred(): ParseResult {
    const msg = this.deferredResult
    this.deferredResult = undefined
    if (!msg || this.lifecycleSeen || this.finished) return { events: [] }
    this.legacy = true
    return this.feed(msg)
  }

  feed(msg: any): ParseResult {
    const events: HubEvent[] = []
    const turnId = this.o.turnId
    if (this.finished) return { events }
    const t = msg?.type
    if (!this.active && (t === 'stream_event' || t === 'assistant' || t === 'user' || t === 'result')) {
      if (t === 'result' && !this.lifecycleSeen) {
        this.deferredResult = msg
        return { events, deferred: true }
      }
      return { events }
    }
    switch (t) {
      case 'command_lifecycle': {
        if (!this.o.commandUuid || msg.command_uuid !== this.o.commandUuid) break
        this.lifecycleSeen = true
        this.deferredResult = undefined
        if (msg.state === 'started') this.ourStarted = true
        else if ((msg.state === 'completed' || msg.state === 'cancelled') && this.sessionId) {
          // 兜底：没收到本轮 result 就结束了
          this.finished = true
          const status = msg.state === 'cancelled' ? 'interrupted' : 'success'
          events.push({ type: 'turn.done', sessionId: this.sessionId, turnId, status })
          return { events, done: true }
        }
        break
      }
      case 'system': {
        if (msg.subtype !== 'init' || this.started) break
        this.started = true
        if (!this.vendorSessionId) this.vendorSessionId = msg.session_id
        const sessionId = this.sessionId!
        if (this.o.isStart) {
          const now = Date.now()
          events.push({
            type: 'session.upsert',
            session: {
              id: sessionId,
              vendor: 'claude',
              vendorSessionId: this.vendorSessionId!,
              cwd: this.o.cwd ?? msg.cwd ?? null,
              title: this.o.prompt.slice(0, 60),
              origin: 'hub',
              state: 'running',
              resumable: true,
              archived: false,
              vendorUpdatedAt: now,
              updatedAt: now,
            },
          })
        }
        events.push({ type: 'turn.started', sessionId, turnId, source: 'hub' })
        events.push({ type: 'message.user', sessionId, turnId, text: this.o.prompt })
        break
      }
      case 'stream_event': {
        const sessionId = this.sessionId
        if (!sessionId) break
        const ev = msg.event
        if (ev?.type === 'message_start') this.currentMsgId = ev.message?.id
        else if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            if (this.currentMsgId) this.streamedText.add(this.currentMsgId)
            events.push({ type: 'message.delta', sessionId, turnId, text: ev.delta.text })
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            if (this.currentMsgId) this.streamedThinking.add(this.currentMsgId)
            events.push({ type: 'thinking.delta', sessionId, turnId, text: ev.delta.thinking })
          }
        }
        break
      }
      case 'assistant': {
        const sessionId = this.sessionId
        if (!sessionId || msg.parent_tool_use_id) break
        const id: string | undefined = msg.message?.id
        for (const b of msg.message?.content ?? []) {
          if (b.type === 'text' && b.text && !(id && this.streamedText.has(id))) {
            events.push({ type: 'message.delta', sessionId, turnId, text: b.text })
          } else if (b.type === 'thinking' && b.thinking && !(id && this.streamedThinking.has(id))) {
            events.push({ type: 'thinking.delta', sessionId, turnId, text: b.thinking })
          } else if (b.type === 'tool_use') {
            this.tools.set(b.id, { name: b.name, input: b.input })
            events.push({ type: 'tool.call', sessionId, turnId, callId: b.id, name: b.name, input: b.input, status: 'started' })
          }
        }
        break
      }
      case 'user': {
        const sessionId = this.sessionId
        const content = msg.message?.content
        if (!sessionId || msg.parent_tool_use_id || !Array.isArray(content)) break
        for (const b of content) {
          if (b?.type !== 'tool_result') continue
          const t = this.tools.get(b.tool_use_id)
          events.push({
            type: 'tool.call',
            sessionId,
            turnId,
            callId: b.tool_use_id,
            name: t?.name ?? 'unknown',
            input: t?.input ?? null,
            status: 'done',
            output: toolResultText(b.content).slice(0, MAX_OUTPUT),
            isError: !!b.is_error,
          })
        }
        break
      }
      case 'control_request': {
        const r = msg.request
        if (r?.subtype === 'can_use_tool') {
          return { events, control: { requestId: msg.request_id, toolName: r.tool_name, input: r.input, raw: msg } }
        }
        break
      }
      case 'result': {
        this.finished = true
        const sessionId = this.sessionId
        if (!sessionId) return { events, done: true }
        const isError = !!msg.is_error || msg.subtype !== 'success'
        const status = isError ? (this.interrupted ? 'interrupted' : 'error') : 'success'
        if (status === 'error') {
          events.push({ type: 'error', sessionId, message: String(msg.result ?? msg.subtype ?? 'claude 返回错误'), recoverable: true })
        }
        events.push({
          type: 'turn.done',
          sessionId,
          turnId,
          status,
          resultText: typeof msg.result === 'string' ? msg.result : undefined,
          usage: msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens } : undefined,
          durationMs: msg.duration_ms,
        })
        return { events, done: true }
      }
    }
    return { events }
  }
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function approvalFromControl(c: ControlRequest): ApprovalRequest {
  const r = c.raw.request ?? {}
  const input = (c.input ?? {}) as Record<string, unknown>
  let kind: ApprovalRequest['kind'] = 'tool'
  let summary = `${c.toolName}`
  if (c.toolName === 'Bash') {
    kind = 'command'
    summary = `Bash: ${String(input.command ?? '')}`
  } else if (FILE_TOOLS.has(c.toolName)) {
    kind = 'file_write'
    summary = `${c.toolName}: ${String(input.file_path ?? input.notebook_path ?? '')}`
  } else if (r.description) {
    summary = `${c.toolName}: ${r.description}`
  }
  return {
    kind,
    summary: summary.slice(0, 300),
    detail: { toolName: c.toolName, input: c.input, description: r.description, blockedPath: r.blocked_path },
    raw: c.raw,
  }
}

/** 构造写回 stdin 的 control_response；allow 带 updatedInput，allow_session 附带会话级规则 */
export function buildControlResponse(c: ControlRequest, decision: Decision) {
  let response: Record<string, unknown>
  if (decision === 'deny') {
    response = { behavior: 'deny', message: '用户在 agent-hub 上拒绝了该操作' }
  } else {
    response = { behavior: 'allow', updatedInput: c.input }
    const suggestions = c.raw.request?.permission_suggestions
    if (decision === 'allow_session' && Array.isArray(suggestions) && suggestions.length) {
      response.updatedPermissions = suggestions.map((s: any) => ({ ...s, destination: 'session' }))
    }
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: c.requestId, response } }
}

export function claudeArgs(o: { resumeId?: string; force?: boolean; fork?: boolean }): string[] {
  const args = ['-p']
  if (o.resumeId) args.push('--resume', o.resumeId)
  // 继承原会话上下文、另开新 id（原会话文件不动）；新 id 从 system.init.session_id 取
  if (o.resumeId && o.fork) args.push('--fork-session')
  args.push(
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', o.force ? 'acceptEdits' : 'default',
  )
  return args
}

/** 一轮的解析器参数：新建与 fork 都不预设会话 id（从 system.init.session_id 取），并先产出 session.upsert */
export function claudeParserOpts(o: { resumeId?: string; fork?: boolean; cwd: string; text: string; turnId: string; commandUuid?: string }) {
  const fresh = !o.resumeId || !!o.fork
  return {
    commandUuid: o.commandUuid,
    turnId: o.turnId,
    prompt: o.text,
    vendorSessionId: fresh ? undefined : o.resumeId,
    cwd: o.cwd,
    isStart: fresh,
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly vendor = 'claude' as const
  readonly supportsFork = true

  constructor(private readonly bin: string) {}

  resume(vendorSessionId: string, cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent> {
    return this.run({ resumeId: vendorSessionId, cwd, text, opts })
  }

  start(cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent> {
    return this.run({ cwd, text, opts })
  }

  private run(o: { resumeId?: string; cwd: string; text: string; opts: RunOpts }): AsyncIterable<HubEvent> {
    const { opts } = o
    const q = new AsyncQueue<HubEvent>()
    const commandUuid = randomUUID()
    const parser = new ClaudeLineParser(claudeParserOpts({ ...o, fork: opts.fork, turnId: opts.turnId, commandUuid }))
    const child = spawn(this.bin, claudeArgs({ resumeId: o.resumeId, force: opts.force, fork: opts.fork }), {
      cwd: o.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (child.pid) opts.onSpawn?.(child.pid)
    const tail = stderrTail(child)
    let finished = false
    let aborted = false

    const write = (obj: unknown) => {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n')
    }

    const onAbort = () => {
      aborted = true
      parser.markInterrupted()
      softKill(child, 'SIGINT')
    }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })

    child.stdin.on('error', () => {})
    write({ type: 'user', uuid: commandUuid, message: { role: 'user', content: o.text } })

    const handle = (r: ParseResult) => {
      for (const e of r.events) q.push(e)
      if (r.control) {
        const c = r.control
        // 先让 Core 处理完此前的事件，保证 approval.request 排在 tool.call started 之后
        q.whenDrained()
          .then(() => opts.onApproval(approvalFromControl(c)))
          .catch(() => 'deny' as const)
          .then((d) => write(buildControlResponse(c, d)))
      }
      if (r.deferred) {
        const t = setTimeout(() => handle(parser.flushDeferred()), LIFECYCLE_WAIT_MS)
        t.unref()
      }
      if (r.done) {
        finished = true
        child.stdin.end()
        // 有后台任务（run_in_background）时 claude -p 会等它们结束才退出且不再输出，这里不等
        const t = setTimeout(() => softKill(child, 'SIGTERM'), EXIT_GRACE_MS)
        t.unref()
        child.once('exit', () => clearTimeout(t))
      }
    }

    onLines(child, (line) => {
      const p = safeParse(line)
      if (!p.ok) {
        q.push({ type: 'error', sessionId: parser.sessionId, message: `无法解析的输出: ${line.slice(0, 200)}`, recoverable: true })
        return
      }
      handle(parser.feed(p.value))
    })

    child.on('error', (err) => {
      q.push({ type: 'error', sessionId: parser.sessionId, message: `拉起 claude 失败: ${err.message}`, recoverable: false })
      q.end()
    })

    child.on('close', (code, signal) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (!finished) {
        const sessionId = parser.sessionId
        const status = aborted ? 'interrupted' : 'error'
        if (!aborted) {
          q.push({
            type: 'error',
            sessionId,
            message: `claude 异常退出 code=${code} signal=${signal} ${tail()}`.trim(),
            recoverable: true,
          })
        }
        if (sessionId) q.push({ type: 'turn.done', sessionId, turnId: opts.turnId, status })
      }
      q.end()
    })

    return q
  }
}
