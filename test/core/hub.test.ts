import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { ClaudeLineParser, approvalFromControl, buildControlResponse } from '../../src/adapters/claude.ts'
import type { AgentAdapter, RunOpts } from '../../src/adapters/types.ts'
import { AsyncQueue } from '../../src/adapters/proc.ts'
import { Bus } from '../../src/core/bus.ts'
import type { HubEvent, SessionView } from '../../src/core/events.ts'
import { Hub } from '../../src/core/sessions.ts'
import { Store } from '../../src/core/store.ts'
import { createPairingCode, pairDevice, authenticate, hashToken } from '../../src/gateway/auth.ts'
import { startGateway } from '../../src/gateway/server.ts'
import type { HubConfig } from '../../src/config.ts'
import { stdoutLines } from '../helpers.ts'

const SID = 'f2301e94-69c5-4852-b821-0a015e847cb6'

/** 回放 Adapter：把录制逐行喂给真实解析器，遇到审批调用 onApproval 并记录回执 */
class ReplayAdapter implements AgentAdapter {
  readonly vendor = 'claude' as const
  responses: unknown[] = []
  constructor(private file: string) {}
  resume(id: string, cwd: string, text: string, opts: RunOpts) {
    return this.run(text, opts, id)
  }
  start(cwd: string, text: string, opts: RunOpts) {
    return this.run(text, opts, undefined, cwd)
  }
  private run(prompt: string, opts: RunOpts, vendorSessionId?: string, cwd?: string): AsyncIterable<HubEvent> {
    const q = new AsyncQueue<HubEvent>()
    const p = new ClaudeLineParser({ turnId: opts.turnId, prompt, vendorSessionId, cwd, isStart: !vendorSessionId })
    void (async () => {
      for (const line of stdoutLines(this.file)) {
        const r = p.feed(line)
        r.events.forEach((e) => q.push(e))
        if (r.control) {
          await q.whenDrained()
          this.responses.push(buildControlResponse(r.control, await opts.onApproval(approvalFromControl(r.control))))
        }
      }
      q.end()
    })()
    return q
  }
}

function view(state: SessionView['state'], id = SID): SessionView {
  return {
    id: `claude:${id}`, vendor: 'claude', vendorSessionId: id, cwd: '/tmp', title: 't', origin: 'cli',
    state, resumable: true, archived: false, updatedAt: Date.now(),
  }
}

function setup(file = 'claude/one-turn-with-tool.ndjson', expireMs = 60_000) {
  const store = new Store(':memory:')
  const bus = new Bus()
  const adapter = new ReplayAdapter(file)
  const hub = new Hub({ store, bus, adapters: { claude: adapter }, approvalExpireMs: expireMs, isCwdAllowed: (c) => c.startsWith('/tmp'), log: () => {} })
  const seen: HubEvent[] = []
  bus.on((p) => seen.push(p.event))
  return { store, bus, hub, adapter, seen }
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const t = Date.now()
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('配对码一次性、过期无效；token 只存哈希', () => {
  const store = new Store(':memory:')
  const { code } = createPairingCode(store)
  const r = pairDevice(store, code, 'cli')!
  assert.ok(r.token.length >= 40)
  assert.equal(pairDevice(store, code, 'again'), undefined)
  const row = store.db.prepare('SELECT token_hash FROM devices').get() as any
  assert.equal(row.token_hash, hashToken(r.token))
  assert.notEqual(row.token_hash, r.token)
  assert.equal(authenticate(store, r.token)?.name, 'cli')
  const old = createPairingCode(store, Date.now() - 6 * 60_000)
  assert.equal(pairDevice(store, old.code, 'late'), undefined)
  store.revokeDevice('cli')
  assert.equal(authenticate(store, r.token), undefined)
})

test('非 idle / 不可续聊 / 进行中 → 拒绝', async () => {
  const { store, hub } = setup()
  hub.applyScan([view('running')])
  assert.deepEqual(pick(hub.send(`claude:${SID}`, 'x')), { ok: false, code: 'SESSION_BUSY' })
  hub.applyScan([{ ...view('idle'), resumable: false, unresumableReason: 'no' }])
  assert.deepEqual(pick(hub.send(`claude:${SID}`, 'x')), { ok: false, code: 'NOT_RESUMABLE' })
  assert.deepEqual(pick(hub.send('claude:nope', 'x')), { ok: false, code: 'NOT_FOUND' })
  hub.applyScan([view('idle')])
  store.insertTurn('t-other', `claude:${SID}`)
  assert.deepEqual(pick(hub.send(`claude:${SID}`, 'x')), { ok: false, code: 'SESSION_BUSY' })
  assert.deepEqual(pick(hub.start('claude', '/etc', 'x')), { ok: false, code: 'CWD_NOT_ALLOWED' })
})

test('refresh 复核：列表显示 idle 但实时是 running 时拒绝', () => {
  const store = new Store(':memory:')
  const hub = new Hub({
    store, bus: new Bus(), adapters: { claude: new ReplayAdapter('claude/one-turn-with-tool.ndjson') },
    approvalExpireMs: 1000, isCwdAllowed: () => true, log: () => {}, refresh: (s) => ({ ...s, state: 'running' }),
  })
  hub.applyScan([view('idle')])
  assert.equal(pick(hub.send(`claude:${SID}`, 'x')).code, 'SESSION_BUSY')
})

test('一轮：事件落库、互斥、结束后回 idle', async () => {
  const { store, hub, seen } = setup()
  hub.applyScan([view('idle')])
  const r = hub.send(`claude:${SID}`, 'hi')
  assert.equal(r.ok, true)
  assert.equal(pick(hub.send(`claude:${SID}`, 'again')).code, 'SESSION_BUSY')
  await waitFor(() => seen.some((e) => e.type === 'turn.done'))
  await waitFor(() => !hub.isBusy(`claude:${SID}`))
  const types = store.eventsSince(`claude:${SID}`).map((e) => e.event.type)
  assert.deepEqual(types.filter((t) => t !== 'session.state'), [
    'turn.started', 'message.user', 'tool.call', 'tool.call', 'message.delta', 'message.delta', 'turn.done',
  ])
  const s = store.getSession(`claude:${SID}`)!
  assert.equal(s.state, 'idle')
  assert.equal(s.lastMessagePreview, '收到')
  assert.equal((store.db.prepare('SELECT status FROM hub_turns').get() as any).status, 'done')
})

test('审批：请求 → 决定 → 回执；重复决定被拒', async () => {
  const { store, hub, seen, adapter } = setup('claude/permission-roundtrip.ndjson')
  hub.applyScan([view('idle')])
  hub.send(`claude:${SID}`, 'p')
  await waitFor(() => seen.some((e) => e.type === 'approval.request'))
  const req = seen.find((e) => e.type === 'approval.request') as any
  assert.equal(req.kind, 'command')
  const order = seen.map((e) => e.type).filter((t) => t === 'tool.call' || t === 'approval.request')
  assert.deepEqual(order, ['tool.call', 'approval.request'])
  assert.equal(store.getSession(`claude:${SID}`)!.state, 'awaiting_approval')
  assert.equal(hub.approve(req.approvalId, 'allow', 'dev1').ok, true)
  assert.equal(pick(hub.approve(req.approvalId, 'deny', 'dev1')).code, 'APPROVAL_CLOSED')
  await waitFor(() => seen.some((e) => e.type === 'turn.done'))
  assert.equal((adapter.responses[0] as any).response.response.behavior, 'allow')
  const a = store.getApproval(req.approvalId)!
  assert.equal(a.status, 'allowed')
  assert.equal(a.decidedBy, 'dev1')
})

test('审批超时自动拒绝', async () => {
  const { hub, seen, adapter } = setup('claude/permission-roundtrip.ndjson', 50)
  hub.applyScan([view('idle')])
  hub.send(`claude:${SID}`, 'p')
  await waitFor(() => seen.some((e) => e.type === 'approval.decided'))
  assert.equal((seen.find((e) => e.type === 'approval.decided') as any).by, 'expired')
  await waitFor(() => adapter.responses.length === 1)
  assert.equal((adapter.responses[0] as any).response.response.behavior, 'deny')
})

test('启动对账：pid 不在的 running 轮次标 orphaned，会话置 error', () => {
  const { store, hub } = setup()
  hub.applyScan([view('idle')])
  store.insertTurn('t1', `claude:${SID}`)
  store.setTurnPid('t1', 99999999)
  hub.reconcileOrphans(() => false)
  assert.equal((store.db.prepare(`SELECT status FROM hub_turns WHERE id='t1'`).get() as any).status, 'orphaned')
  assert.equal(store.getSession(`claude:${SID}`)!.state, 'error')
})

test('启动对账：子进程仍活着的遗留轮次也标 orphaned，并结束子进程，会话不再被占用', () => {
  const { store, hub } = setup()
  hub.applyScan([view('idle')])
  store.insertTurn('t2', `claude:${SID}`)
  store.setTurnPid('t2', 4242)
  const stopped: number[] = []
  hub.reconcileOrphans(() => true, (pid) => stopped.push(pid))
  assert.deepEqual(stopped, [4242])
  assert.equal(store.hasRunningTurn(`claude:${SID}`), false)
  assert.equal(hub.isBusy(`claude:${SID}`), false)
})

test('onBusyChange：轮次开始 1、结束 0', async () => {
  const store = new Store(':memory:')
  const bus = new Bus()
  const counts: number[] = []
  const hub = new Hub({
    store, bus, adapters: { claude: new ReplayAdapter('claude/one-turn-with-tool.ndjson') }, approvalExpireMs: 60_000,
    isCwdAllowed: () => true, log: () => {}, onBusyChange: (n) => counts.push(n),
  })
  hub.applyScan([view('idle')])
  assert.equal(hub.send(`claude:${SID}`, 'x').ok, true)
  await waitFor(() => counts.length === 2)
  assert.deepEqual(counts, [1, 0])
})

test('Gateway：REST 鉴权 + WS hello/send/审批/SESSION_BUSY', async () => {
  const { store, bus, hub } = setup('claude/permission-roundtrip.ndjson')
  hub.applyScan([view('idle'), view('running', 'busy-1')])
  const cfg = { listen: { host: '127.0.0.1', port: 0 }, allowedCwds: ['/tmp'] } as unknown as HubConfig
  const server = await startGateway({ cfg, store, bus, hub, version: 't', vendors: () => ({}) as any, log: () => {} })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401)
    const { code } = createPairingCode(store)
    const bad = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000x', deviceName: 'cli' }) })
    assert.equal(bad.status, 401)
    const pr = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: 'cli' }) })
    const { token } = (await pr.json()) as any
    const list = (await (await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).json()) as any[]
    assert.equal(list.length, 2)
    const detail = await fetch(`${base}/api/sessions/${encodeURIComponent(`claude:${SID}`)}`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(detail.status, 200)

    // 错误 token 被 4401 关闭
    const wsBad = new WebSocket(`${base.replace('http', 'ws')}/ws`)
    await once(wsBad, 'open')
    wsBad.send(JSON.stringify({ t: 'hello', token: 'nope' }))
    const [closeCode] = await once(wsBad, 'close')
    assert.equal(closeCode, 4401)

    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`)
    const msgs: any[] = []
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())))
    await once(ws, 'open')
    ws.send(JSON.stringify({ t: 'hello', token }))
    await waitFor(() => msgs.some((m) => m.t === 'snapshot'))
    ws.send(JSON.stringify({ t: 'send', reqId: 'r0', sessionId: 'claude:busy-1', text: 'x' }))
    await waitFor(() => msgs.some((m) => m.reqId === 'r0'))
    assert.deepEqual(pick(msgs.find((m) => m.reqId === 'r0')), { ok: false, code: 'SESSION_BUSY' })

    ws.send(JSON.stringify({ t: 'send', reqId: 'r1', sessionId: `claude:${SID}`, text: 'p' }))
    await waitFor(() => msgs.some((m) => m.event?.type === 'approval.request'))
    const req = msgs.find((m) => m.event?.type === 'approval.request').event
    ws.send(JSON.stringify({ t: 'approve', reqId: 'r2', approvalId: req.approvalId, decision: 'allow' }))
    await waitFor(() => msgs.some((m) => m.event?.type === 'turn.done'))
    assert.equal(msgs.find((m) => m.reqId === 'r2').ok, true)
    const seq = msgs.filter((m) => m.t === 'event' && m.event.sessionId === `claude:${SID}`).map((m) => m.event.type)
      .filter((t) => !t.startsWith('session.'))
    assert.deepEqual(seq, ['turn.started', 'message.user', 'tool.call', 'approval.request', 'approval.decided', 'tool.call', 'message.delta', 'turn.done'])
    const done = msgs.find((m) => m.event?.type === 'turn.done').event
    assert.equal(done.status, 'success')
    assert.equal(done.resultText, '收到')
    ws.close()
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

function pick(r: any) {
  return r.ok ? { ok: true } : { ok: false, code: r.code }
}

test('缺 cwd：默认拒绝；Adapter 声明 requiresCwd=false 时照常续聊（Cursor）', async () => {
  const { store, hub, adapter, seen } = setup()
  hub.applyScan([{ ...view('idle'), cwd: null }])
  const r = hub.send(`claude:${SID}`, 'hi')
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'NOT_RESUMABLE')
  Object.defineProperty(adapter, 'requiresCwd', { value: false })
  const ok = hub.send(`claude:${SID}`, 'hi')
  assert.equal(ok.ok, true)
  await waitFor(() => seen.some((e) => e.type === 'turn.done'))
  assert.equal(store.getSession(`claude:${SID}`)!.state, 'idle')
})
