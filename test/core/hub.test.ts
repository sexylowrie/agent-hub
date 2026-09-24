import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { ClaudeLineParser, approvalFromControl, buildControlResponse, claudeParserOpts } from '../../src/adapters/claude.ts'
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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SID = 'f2301e94-69c5-4852-b821-0a015e847cb6'

/** 回放 Adapter：把录制逐行喂给真实解析器，遇到审批调用 onApproval 并记录回执 */
class ReplayAdapter implements AgentAdapter {
  readonly vendor = 'claude' as const
  readonly supportsFork = true
  responses: unknown[] = []
  forks: string[] = []
  constructor(private file: string) {}
  resume(id: string, cwd: string, text: string, opts: RunOpts) {
    if (opts.fork) this.forks.push(id)
    return this.run(text, opts, id, cwd)
  }
  start(cwd: string, text: string, opts: RunOpts) {
    return this.run(text, opts, undefined, cwd)
  }
  private run(prompt: string, opts: RunOpts, resumeId: string | undefined, cwd: string): AsyncIterable<HubEvent> {
    const q = new AsyncQueue<HubEvent>()
    const p = new ClaudeLineParser(claudeParserOpts({ resumeId, fork: opts.fork, cwd, text: prompt, turnId: opts.turnId }))
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

test('attached：send 返回 ATTACHED 并附 holder；holder 落库，回到 idle 后清掉', () => {
  const { store, hub, seen } = setup()
  const holder = { kind: 'cli' as const, pid: 4242, tmux: { target: 'dev:1.0' } }
  hub.applyScan([{ ...view('attached'), holder }])
  assert.deepEqual(store.getSession(`claude:${SID}`)!.holder, holder)
  const r = hub.send(`claude:${SID}`, 'x')
  assert.equal(r.ok, false)
  assert.equal((r as any).code, 'ATTACHED')
  assert.deepEqual((r as any).holder, holder)
  assert.match((r as any).message, /终端/)
  // 只有 holder 变了也要广播
  const before = seen.length
  hub.applyScan([{ ...view('attached'), holder: { kind: 'gui', pid: 4242 } }])
  assert.equal(seen.length, before + 1)
  assert.match((hub.send(`claude:${SID}`, 'x') as any).message, /桌面 App/)
  hub.applyScan([view('idle')])
  assert.equal(store.getSession(`claude:${SID}`)!.holder, undefined)
})

test('fork：attached 会话可以 fork，新会话挂上轮次，原会话状态不变', async () => {
  const { store, hub, adapter, seen } = setup('claude/fork-session.ndjson')
  const ORIGINAL = 'fc1972b0-3e7d-4924-9eab-4074b6c8f8f5'
  const FORKED = 'claude:72ed2e39-744d-4b97-97c9-98cc089c0926'
  hub.applyScan([{ ...view('attached', ORIGINAL), holder: { kind: 'cli', pid: 4242 } }])
  const r = hub.fork(`claude:${ORIGINAL}`, '只回复两个字：好的')
  assert.equal(r.ok, true)
  assert.deepEqual(adapter.forks, [ORIGINAL])
  await waitFor(() => seen.some((e) => e.type === 'turn.done'))
  await waitFor(() => !hub.isBusy(FORKED))
  const forked = store.getSession(FORKED)!
  assert.equal(forked.origin, 'hub')
  assert.equal(forked.state, 'idle')
  assert.equal(forked.lastMessagePreview, '好的')
  assert.deepEqual(store.eventsSince(FORKED).map((e) => e.event.type).filter((t) => t !== 'session.state'), ['turn.started', 'message.user', 'message.delta', 'turn.done'])
  const orig = store.getSession(`claude:${ORIGINAL}`)!
  assert.equal(orig.state, 'attached')
  assert.equal(store.eventsSince(`claude:${ORIGINAL}`).length, 0)
})

test('fork：真在跑的会话不 fork；不支持 fork 的厂商返回 FORK_UNSUPPORTED', () => {
  const { hub } = setup('claude/fork-session.ndjson')
  hub.applyScan([view('running')])
  assert.equal(pick(hub.fork(`claude:${SID}`, 'x')).code, 'SESSION_BUSY')
  hub.applyScan([view('awaiting_approval')])
  assert.equal(pick(hub.fork(`claude:${SID}`, 'x')).code, 'SESSION_BUSY')
  assert.equal(pick(hub.fork('claude:nope', 'x')).code, 'NOT_FOUND')
  const store = new Store(':memory:')
  const noFork: AgentAdapter = { vendor: 'codex', resume: () => assert.fail('不该拉起'), start: () => assert.fail('不该拉起') }
  const h2 = new Hub({ store, bus: new Bus(), adapters: { codex: noFork }, approvalExpireMs: 1000, isCwdAllowed: () => true, log: () => {} })
  h2.applyScan([{ ...view('idle', 'th'), id: 'codex:th', vendor: 'codex' }])
  const r = h2.fork('codex:th', 'x') as any
  assert.equal(r.code, 'FORK_UNSUPPORTED')
  assert.match(r.message, /codex/)
})

test('Store：旧库（sessions 表没有 holder 列）打开时自动补列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-store-'))
  const file = join(dir, 'hub.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, vendor TEXT NOT NULL, vendor_session_id TEXT NOT NULL, cwd TEXT, title TEXT,
    origin TEXT NOT NULL, state TEXT NOT NULL, resumable INTEGER NOT NULL DEFAULT 1, unresumable_reason TEXT, archived INTEGER NOT NULL DEFAULT 0,
    last_message_preview TEXT, last_event_seq INTEGER, vendor_updated_at INTEGER, updated_at INTEGER NOT NULL, UNIQUE(vendor, vendor_session_id))`)
  old.prepare(`INSERT INTO sessions (id, vendor, vendor_session_id, origin, state, updated_at) VALUES ('claude:a','claude','a','cli','idle',1)`).run()
  old.close()
  const store = Store.open(dir)
  assert.equal(store.getSession('claude:a')!.state, 'idle')
  store.upsertSession({ ...view('attached', 'a'), holder: { kind: 'gui' } })
  assert.deepEqual(store.getSession('claude:a')!.holder, { kind: 'gui' })
  store.close()
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
  hub.applyScan([view('idle'), view('running', 'busy-1'), { ...view('attached', 'att-1'), holder: { kind: 'cli', pid: 4242 } }])
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
    assert.equal(list.length, 3)
    assert.deepEqual(list.find((s) => s.id === 'claude:att-1').holder, { kind: 'cli', pid: 4242 })
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
    ws.send(JSON.stringify({ t: 'send', reqId: 'ra', sessionId: 'claude:att-1', text: 'x' }))
    await waitFor(() => msgs.some((m) => m.reqId === 'ra'))
    const att = msgs.find((m) => m.reqId === 'ra')
    assert.equal(att.code, 'ATTACHED')
    assert.deepEqual(att.holder, { kind: 'cli', pid: 4242 })

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
