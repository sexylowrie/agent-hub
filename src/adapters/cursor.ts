import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { sessionKey, type HubEvent } from '../core/events.ts'
import type { AgentAdapter, RunOpts } from './types.ts'
import { AsyncQueue, onLines, safeParse, softKill, stderrTail } from './proc.ts'

// 事件形状以 recordings/cursor/*.ndjson 为准。

const MAX_OUTPUT = 10_000
/** result 之后等待进程自行退出的时间 */
const EXIT_GRACE_MS = 3000
const TRANSIENT = /Connection stalled/i

export function cursorArgs(o: { resumeId?: string; force?: boolean; text: string }): string[] {
  const args = ['-p']
  if (o.resumeId) args.push('--resume', o.resumeId)
  // 无头模式遇到未信任目录会停在信任提示并退出；cwd 已由 Hub 限定（start 走 allowedCwds，resume 用会话原工作区）
  args.push('--output-format', 'stream-json', '--stream-partial-output', '--trust')
  if (o.force) args.push('--force')
  else args.push('--sandbox', 'enabled')
  args.push(o.text)
  return args
}

/** tool_call.{xxxToolCall: {args, result}} → 名称、入参、输出 */
function toolParts(tc: any): { name: string; args: unknown; result: any } {
  const key = tc && typeof tc === 'object' ? Object.keys(tc)[0] : undefined
  const body = key ? tc[key] : undefined
  return { name: key ? key.replace(/ToolCall$/, '') : 'tool', args: body?.args ?? null, result: body?.result }
}

function toolOutput(result: any): { output: string; isError: boolean } {
  if (!result) return { output: '', isError: false }
  if (result.success) {
    const s = result.success
    const out = s.interleavedOutput ?? s.stdout ?? s.content ?? s
    const isError = typeof s.exitCode === 'number' && s.exitCode !== 0
    return { output: typeof out === 'string' ? out : JSON.stringify(out), isError }
  }
  const err = result.error ?? result.failure ?? result.rejected ?? result
  return { output: typeof err === 'string' ? err : JSON.stringify(err), isError: true }
}

export interface CursorParseResult {
  events: HubEvent[]
  done?: boolean
}

/**
 * Cursor stream-json 行解析器（可跨重试复用：第二次拉起的 init 不再重复发 turn.started）。
 * --stream-partial-output 下 assistant 先按片段（带 timestamp_ms）输出，随后再整块重复一次已输出的文本（实测），
 * 规则：整块文本等于此前累计的片段时跳过，否则照常输出。
 */
export class CursorLineParser {
  private started = false
  private finished = false
  private interrupted = false
  private vendorSessionId: string | undefined
  private pending = ''
  private outputSeen = false

  constructor(private readonly o: { turnId: string; prompt: string; vendorSessionId?: string; cwd?: string; isStart?: boolean }) {
    this.vendorSessionId = o.vendorSessionId
  }

  get sessionId(): string | undefined {
    return this.vendorSessionId ? sessionKey('cursor', this.vendorSessionId) : undefined
  }

  get hasStarted() {
    return this.started
  }

  /** 已产出过模型输出（文本/工具），此时不再自动重试 */
  get hasOutput() {
    return this.outputSeen
  }

  get isFinished() {
    return this.finished
  }

  markInterrupted() {
    this.interrupted = true
  }

  feed(msg: any): CursorParseResult {
    const events: HubEvent[] = []
    if (this.finished) return { events }
    const turnId = this.o.turnId
    switch (msg?.type) {
      case 'system': {
        if (msg.subtype !== 'init' || this.started) break
        this.started = true
        this.vendorSessionId ??= msg.session_id
        const sessionId = this.sessionId!
        if (this.o.isStart) {
          const now = Date.now()
          events.push({
            type: 'session.upsert',
            session: {
              id: sessionId,
              vendor: 'cursor',
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
      case 'thinking': {
        const sessionId = this.sessionId
        if (sessionId && msg.subtype === 'delta' && msg.text) events.push({ type: 'thinking.delta', sessionId, turnId, text: msg.text })
        break
      }
      case 'assistant': {
        const sessionId = this.sessionId
        if (!sessionId) break
        const text = (msg.message?.content ?? [])
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('')
        if (!text) break
        if (this.pending && text === this.pending) {
          this.pending = ''
          break
        }
        this.pending += text
        this.outputSeen = true
        events.push({ type: 'message.delta', sessionId, turnId, text })
        break
      }
      case 'tool_call': {
        const sessionId = this.sessionId
        if (!sessionId) break
        this.pending = ''
        this.outputSeen = true
        const { name, args, result } = toolParts(msg.tool_call)
        const callId = String(msg.call_id)
        if (msg.subtype === 'started') {
          events.push({ type: 'tool.call', sessionId, turnId, callId, name, input: args, status: 'started' })
        } else if (msg.subtype === 'completed') {
          const { output, isError } = toolOutput(result)
          events.push({ type: 'tool.call', sessionId, turnId, callId, name, input: args, status: 'done', output: output.slice(0, MAX_OUTPUT), isError })
        }
        break
      }
      case 'result': {
        const sessionId = this.sessionId ?? (msg.session_id ? sessionKey('cursor', msg.session_id) : undefined)
        if (!sessionId) return { events }
        this.finished = true
        const isError = !!msg.is_error || msg.subtype !== 'success'
        const status = isError ? (this.interrupted ? 'interrupted' : 'error') : 'success'
        if (status === 'error') events.push({ type: 'error', sessionId, message: String(msg.result ?? msg.subtype ?? 'cursor 返回错误'), recoverable: true })
        events.push({
          type: 'turn.done',
          sessionId,
          turnId,
          status,
          resultText: typeof msg.result === 'string' ? msg.result : undefined,
          usage: msg.usage ? { input: msg.usage.inputTokens, output: msg.usage.outputTokens } : undefined,
          durationMs: msg.duration_ms,
        })
        return { events, done: true }
      }
    }
    return { events }
  }
}

export class CursorAdapter implements AgentAdapter {
  readonly vendor = 'cursor' as const
  /** agent --resume 不依赖 cwd；IDE 会话推断不到工作区时在 home 下拉起 */
  readonly requiresCwd = false

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
    const parser = new CursorLineParser({ turnId: opts.turnId, prompt: o.text, vendorSessionId: o.resumeId, cwd: o.cwd, isStart: !o.resumeId })
    let aborted = false
    let current: ReturnType<typeof spawn> | undefined

    const onAbort = () => {
      aborted = true
      parser.markInterrupted()
      if (current) softKill(current, 'SIGINT')
    }
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })

    const attempt = (n: number) => {
      // start 的重试改为续接已拿到的会话，避免建出两个会话
      const resumeId = o.resumeId ?? (parser.sessionId ? parser.sessionId.slice('cursor:'.length) : undefined)
      const child = spawn(this.bin, cursorArgs({ resumeId, force: opts.force, text: o.text }), {
        cwd: o.cwd || homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      current = child
      if (child.pid) opts.onSpawn?.(child.pid)
      const tail = stderrTail(child)
      let lastError = ''

      onLines(child, (line) => {
        const p = safeParse(line)
        if (!p.ok) {
          q.push({ type: 'error', sessionId: parser.sessionId, message: `无法解析的输出: ${line.slice(0, 200)}`, recoverable: true })
          return
        }
        const msg = p.value
        // 瞬时错误且尚无模型输出：扣住 result，由 close 决定是否重试
        if (msg?.type === 'result' && (msg.is_error || msg.subtype !== 'success') && TRANSIENT.test(String(msg.result ?? '')) && n === 0 && !parser.hasOutput && !aborted) {
          lastError = String(msg.result)
          return
        }
        const r = parser.feed(msg)
        for (const e of r.events) q.push(e)
        if (r.done) {
          const t = setTimeout(() => softKill(child, 'SIGTERM'), EXIT_GRACE_MS)
          t.unref()
          child.once('exit', () => clearTimeout(t))
        }
      })

      child.on('error', (err) => {
        q.push({ type: 'error', sessionId: parser.sessionId, message: `拉起 cursor agent 失败: ${err.message}`, recoverable: false })
        q.end()
      })

      child.on('close', (code, signal) => {
        if (parser.isFinished) return end()
        const errText = lastError || tail()
        if (n === 0 && !aborted && !parser.hasOutput && TRANSIENT.test(errText)) {
          q.push({ type: 'error', sessionId: parser.sessionId, message: `cursor 瞬时错误，重试一次: ${errText.slice(0, 200)}`, recoverable: true })
          return attempt(1)
        }
        const sessionId = parser.sessionId
        if (!aborted) {
          q.push({ type: 'error', sessionId, message: `cursor agent 异常退出 code=${code} signal=${signal} ${errText}`.trim(), recoverable: true })
        }
        if (sessionId) q.push({ type: 'turn.done', sessionId, turnId: opts.turnId, status: aborted ? 'interrupted' : 'error' })
        end()
      })
    }

    const end = () => {
      opts.signal.removeEventListener('abort', onAbort)
      q.end()
    }

    if (aborted) {
      queueMicrotask(end)
    } else attempt(0)
    return q
  }
}
