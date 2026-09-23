// 命令行 WS 客户端，用于验收与调试：打印收到的事件，turn.done 或被拒后退出。
// 用法：
//   tsx scripts/ws-client.ts send  <sessionId> <text> [--force] [--approve allow|deny|allow_session]
//   tsx scripts/ws-client.ts start <vendor> <cwd> <text> [--approve ...]
// 附加：--interrupt-after <ms>  send 成功后定时发 interrupt
// 环境变量：HUB_TOKEN（必填）、HUB_URL（默认 ws://127.0.0.1:7788/ws）
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    approve: { type: 'string', default: 'allow' },
    force: { type: 'boolean', default: false },
    'interrupt-after': { type: 'string' },
  },
})
const token = process.env.HUB_TOKEN
if (!token) throw new Error('需要 HUB_TOKEN')
const [cmd, ...args] = positionals
const ws = new WebSocket(process.env.HUB_URL ?? 'ws://127.0.0.1:7788/ws')
const t0 = Date.now()
const log = (s: string) => console.log(`+${String(Date.now() - t0).padStart(6)}ms ${s}`)

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
ws.on('close', (code) => {
  log(`连接关闭 code=${code}`)
  process.exit(code === 4401 ? 2 : 0)
})
ws.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.t === 'snapshot') {
    log(`snapshot: ${m.sessions.length} 个会话, seq=${m.seq}`)
    if (cmd === 'send') ws.send(JSON.stringify({ t: 'send', reqId: 'r1', sessionId: args[0], text: args[1], force: values.force }))
    else if (cmd === 'start') ws.send(JSON.stringify({ t: 'start', reqId: 'r1', vendor: args[0], cwd: args[1], text: args[2], force: values.force }))
    else throw new Error(`未知命令 ${cmd}`)
    return
  }
  if (m.t === 'ack') {
    log(`ack ${m.reqId}: ${JSON.stringify(m.ok ? { ok: true, data: m.data } : { ok: false, code: m.code, message: m.message })}`)
    if (m.reqId === 'r1' && !m.ok) ws.close()
    if (m.reqId === 'r1' && m.ok && cmd === 'send' && values['interrupt-after']) {
      setTimeout(() => {
        log('→ interrupt')
        ws.send(JSON.stringify({ t: 'interrupt', reqId: 'r3', sessionId: args[0] }))
      }, Number(values['interrupt-after']))
    }
    return
  }
  if (m.t !== 'event') return
  const e = m.event
  if (e.type === 'session.upsert') return log(`[${m.seq}] session.upsert ${e.session.id} state=${e.session.state}`)
  const brief: Record<string, unknown> = { ...e }
  delete brief.type
  delete brief.sessionId
  delete brief.turnId
  if (typeof brief.output === 'string') brief.output = brief.output.slice(0, 80)
  if (e.type === 'approval.request') brief.detail = undefined
  log(`[${m.seq}] ${e.type} ${JSON.stringify(brief)}`)
  if (e.type === 'approval.request') {
    log(`→ approve ${values.approve}`)
    ws.send(JSON.stringify({ t: 'approve', reqId: 'r2', approvalId: e.approvalId, decision: values.approve }))
  }
  if (e.type === 'turn.done') setTimeout(() => ws.close(), 200)
})
