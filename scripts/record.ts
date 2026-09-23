// 录制厂商真实事件流到 recordings/。格式见 recordings/README.md：
// `<< ` 子进程 stdout，`>> ` 我方写入 stdin（`>> [xxx]` 为动作标记）；stderr 另存 <name>.stderr.txt。
//
// 用法：
//   npm run record -- claude [--prompt 文本] [--cwd 目录] [--resume <sessionId>] [--decision allow|deny] [--out 文件名|绝对路径] [--interrupt-after ms]
//   npm run record -- codex  [同上] [--unarchive] [--force] [--model m]  # app-server JSON-RPC；--resume 为 threadId；--force 用 workspace-write；--model 覆盖线程模型
//   npm run record -- cursor [同上，无 --decision] [--force]     # agent -p stream-json；--resume 为 composerId
// 默认在 /tmp 新开会话，审批自动按 --decision 回复（默认 allow）。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config.ts'
import { buildControlResponse, claudeArgs } from '../src/adapters/claude.ts'
import { codexArgs, codexDecision } from '../src/adapters/codex.ts'
import { cursorArgs } from '../src/adapters/cursor.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: 'string', default: '用 shell 执行 `echo hub-probe > /tmp/hub-record-probe.txt`，完成后只回复两个字：收到' },
    cwd: { type: 'string', default: '/tmp' },
    resume: { type: 'string' },
    decision: { type: 'string', default: 'allow' },
    out: { type: 'string' },
    'interrupt-after': { type: 'string' },
    unarchive: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    model: { type: 'string' },
  },
})

const vendor = positionals[0]
if (vendor !== 'claude' && vendor !== 'codex' && vendor !== 'cursor') {
  console.error('用法：npm run record -- claude|codex|cursor [--prompt ...]')
  process.exit(1)
}

const cfg = loadConfig()
const dir = join(import.meta.dirname, '..', 'recordings', vendor)
mkdirSync(dir, { recursive: true })
const name = values.out ?? `record-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`
const outPath = isAbsolute(name) ? name : join(dir, name)
const out = createWriteStream(outPath)
const errOut = createWriteStream(outPath.replace(/\.ndjson$/, '') + '.stderr.txt')
const decision = values.decision === 'deny' ? 'deny' : 'allow'
const t0 = Date.now()

function launch(bin: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(bin, args, { cwd: values.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.pipe(errOut)
  child.on('close', (code, signal) => {
    out.end()
    errOut.end()
    console.error(`[record] 退出 code=${code} signal=${signal}（${Date.now() - t0}ms），已写入 ${outPath}`)
  })
  return child
}

function lines(child: ChildProcessWithoutNullStreams, fn: (msg: any) => void) {
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    out.write(`<< ${line}\n`)
    try {
      fn(JSON.parse(line))
    } catch {
      // 非 JSON 行照录
    }
  })
}

function writer(child: ChildProcessWithoutNullStreams) {
  return (obj: unknown) => {
    const line = JSON.stringify(obj)
    out.write(`>> ${line}\n`)
    if (child.stdin.writable) child.stdin.write(line + '\n')
  }
}

function mark(action: string) {
  out.write(`>> [${action}]\n`)
  console.error(`[record] ${action}`)
}

if (vendor === 'claude') {
  const child = launch(cfg.binaries.claude, claudeArgs({ resumeId: values.resume }))
  const write = writer(child)
  if (values['interrupt-after']) {
    setTimeout(() => {
      mark('SIGINT')
      child.kill('SIGINT')
    }, Number(values['interrupt-after']))
  }
  const commandUuid = randomUUID()
  write({ type: 'user', uuid: commandUuid, message: { role: 'user', content: values.prompt } })
  lines(child, (msg) => {
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      console.error(`[record] 审批 ${msg.request.tool_name} → ${decision}`)
      write(buildControlResponse({ requestId: msg.request_id, toolName: msg.request.tool_name, input: msg.request.input, raw: msg }, decision))
    }
    // 带 uuid 的输入会产出 command_lifecycle；以自家命令 completed 为准结束，遗留轮次的 result 不算
    if (msg.type === 'command_lifecycle' && msg.command_uuid === commandUuid && msg.state === 'completed') child.stdin.end()
    if (msg.type === 'result') console.error(`[record] result: ${msg.subtype} ${String(msg.result ?? '').slice(0, 80)}`)
  })
} else if (vendor === 'codex') {
  const child = launch(cfg.binaries.codex, codexArgs(cfg.codex.model))
  const write = writer(child)
  let nextId = 1
  const pending = new Map<number, (result: any, error: any) => void>()
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      pending.set(id, (r, e) => (e ? reject(new Error(`${method}: ${JSON.stringify(e)}`)) : resolve(r)))
      write({ id, method, params })
    })
  let threadId = values.resume
  let turnId: string | undefined
  lines(child, (msg) => {
    if (msg.id !== undefined && msg.method) {
      // 服务端请求：审批按 --decision 回，其他一律拒绝
      const d = msg.method.endsWith('/requestApproval') ? codexDecision(decision) : 'decline'
      console.error(`[record] 服务端请求 ${msg.method} → ${d}`)
      write({ id: msg.id, result: { decision: d } })
      return
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg.result, msg.error)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'turn/started') turnId = msg.params?.turn?.id
    if (msg.method === 'turn/completed') {
      console.error(`[record] turn/completed status=${msg.params?.turn?.status}`)
      mark('close stdin')
      child.stdin.end()
    }
  })
  ;(async () => {
    await call('initialize', { clientInfo: { name: 'agent-hub', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    write({ method: 'initialized', params: {} })
    const sandbox = values.force ? 'workspace-write' : 'read-only'
    if (threadId) {
      if (values.unarchive) await call('thread/unarchive', { threadId })
      await call('thread/resume', { threadId, approvalPolicy: 'on-request', sandbox, excludeTurns: true, ...(values.model ? { model: values.model } : {}) })
    } else {
      const r = await call('thread/start', { cwd: values.cwd, approvalPolicy: 'on-request', sandbox })
      threadId = r.thread.id
    }
    await call('turn/start', { threadId, input: [{ type: 'text', text: values.prompt }] })
    if (values['interrupt-after']) {
      setTimeout(() => {
        mark('turn/interrupt')
        void call('turn/interrupt', { threadId, turnId }).catch((e) => console.error(`[record] ${e.message}`))
      }, Number(values['interrupt-after']))
    }
  })().catch((e) => {
    console.error(`[record] ${e.message}`)
    child.stdin.end()
  })
} else {
  const child = launch(cfg.binaries.cursor, cursorArgs({ resumeId: values.resume, force: values.force, text: values.prompt }))
  child.stdin.end()
  if (values['interrupt-after']) {
    setTimeout(() => {
      mark('SIGINT')
      child.kill('SIGINT')
    }, Number(values['interrupt-after']))
  }
  lines(child, (msg) => {
    if (msg.type === 'result') console.error(`[record] result: ${msg.subtype} ${String(msg.result ?? '').slice(0, 80)}`)
  })
}
