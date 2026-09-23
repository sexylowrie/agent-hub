// 录制厂商真实事件流到 recordings/。格式见 recordings/README.md：
// `<< ` 子进程 stdout，`>> ` 我方写入 stdin；stderr 另存 <name>.stderr.txt。
//
// 用法：
//   npm run record -- claude [--prompt 文本] [--cwd 目录] [--resume <sessionId>] [--decision allow|deny] [--out 文件名|绝对路径] [--interrupt-after ms]
// 默认在 /tmp 新开会话，审批自动按 --decision 回复（默认 allow）。codex / cursor 在 M1 补充。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config.ts'
import { buildControlResponse, claudeArgs } from '../src/adapters/claude.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: 'string', default: '用 Bash 工具执行 `echo hub-probe > /tmp/hub-record-probe.txt`，完成后只回复两个字：收到' },
    cwd: { type: 'string', default: '/tmp' },
    resume: { type: 'string' },
    decision: { type: 'string', default: 'allow' },
    out: { type: 'string' },
    'interrupt-after': { type: 'string' },
  },
})

const vendor = positionals[0]
if (vendor !== 'claude') {
  console.error(vendor ? `暂只支持 claude（${vendor} 在 M1 补充）` : '用法：npm run record -- claude [--prompt ...]')
  process.exit(1)
}

const cfg = loadConfig()
const dir = join(import.meta.dirname, '..', 'recordings', vendor)
mkdirSync(dir, { recursive: true })
const name = values.out ?? `record-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`
const outPath = isAbsolute(name) ? name : join(dir, name)
const out = createWriteStream(outPath)
const errOut = createWriteStream(outPath.replace(/\.ndjson$/, '') + '.stderr.txt')

const child = spawn(cfg.binaries.claude, claudeArgs({ resumeId: values.resume }), {
  cwd: values.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const write = (obj: unknown) => {
  const line = JSON.stringify(obj)
  out.write(`>> ${line}\n`)
  child.stdin.write(line + '\n')
}
child.stderr.pipe(errOut)
if (values['interrupt-after']) {
  setTimeout(() => {
    out.write(`>> [SIGINT]\n`)
    console.error('[record] 发送 SIGINT')
    child.kill('SIGINT')
  }, Number(values['interrupt-after']))
}
const commandUuid = randomUUID()
write({ type: 'user', uuid: commandUuid, message: { role: 'user', content: values.prompt } })

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  out.write(`<< ${line}\n`)
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
    const decision = values.decision === 'deny' ? 'deny' : 'allow'
    console.error(`[record] 审批 ${msg.request.tool_name} → ${decision}`)
    write(buildControlResponse({ requestId: msg.request_id, toolName: msg.request.tool_name, input: msg.request.input, raw: msg }, decision))
  }
  // 带 uuid 的输入会产出 command_lifecycle；以自家命令 completed 为准结束，遗留轮次的 result 不算
  if (msg.type === 'command_lifecycle' && msg.command_uuid === commandUuid && msg.state === 'completed') child.stdin.end()
  if (msg.type === 'result') {
    console.error(`[record] result: ${msg.subtype} ${String(msg.result ?? '').slice(0, 80)}`)
  }
})

child.on('close', (code) => {
  out.end()
  errOut.end()
  console.error(`[record] 退出 code=${code}，已写入 ${outPath}`)
})
