import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { WebSocket, WebSocketServer } from 'ws'
import { Bus } from '../../src/core/bus.ts'
import { Hub } from '../../src/core/sessions.ts'
import { Store, type DeviceRow } from '../../src/core/store.ts'
import { authenticate, createPairingCode, pairDevice } from '../../src/gateway/auth.ts'
import { attachWs, createApp, type GatewayDeps } from '../../src/gateway/server.ts'

// 嵌入方式（dougan 门面）：createApp 挂在 /hub 下、WS 在 /hub/ws，与宿主自己的 WS 共用一个 server；
// 鉴权先认宿主的机器凭据，再回落到设备 token。

/** events.once 遇到 error 会 reject；握手被拒时 ws 先报 error 再 close */
const closed = (ws: WebSocket) => new Promise((r) => ws.once('close', r))

const MACHINE: DeviceRow = { id: 'machine', name: '本机', pairedAt: 0, lastSeen: null, revoked: false }

function deps() {
  const store = new Store(':memory:')
  const bus = new Bus()
  const hub = new Hub({ store, bus, adapters: {}, approvalExpireMs: 60_000, isCwdAllowed: () => true, log: () => {} })
  store.upsertSession({ id: 'claude:s1', vendor: 'claude', vendorSessionId: 's1', cwd: '/tmp', title: 't', origin: 'cli', state: 'idle', resumable: true, archived: false, updatedAt: 1 })
  const d: GatewayDeps = {
    allowedCwds: () => ['/Users/dev/code'],
    store,
    bus,
    hub,
    version: 't',
    vendors: () => ({}) as any,
    authenticate: (token) => (token === '<machine-token>' ? MACHINE : authenticate(store, token)),
    log: () => {},
  }
  return d
}

test('createApp 挂在 /hub 下：路径带前缀，注入的 authenticate 同时认机器凭据与设备 token', async () => {
  const d = deps()
  const root = new Hono()
  root.get('/health', (c) => c.text('host'))
  root.route('/hub', createApp(d))
  const get = (path: string, token?: string) => root.fetch(new Request(`http://x${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }))

  assert.equal(await (await get('/health')).text(), 'host')
  assert.equal((await get('/hub/api/sessions')).status, 401)
  assert.equal((await get('/hub/api/sessions', 'wrong')).status, 401)
  const viaMachine = await get('/hub/api/sessions', '<machine-token>')
  assert.equal(viaMachine.status, 200)
  assert.equal(((await viaMachine.json()) as any[])[0].id, 'claude:s1')
  const { token } = pairDevice(d.store, createPairingCode(d.store).code, 'phone')!
  assert.equal((await get('/hub/api/sessions', token)).status, 200)
  // 未挂前缀的原路径在宿主里不存在
  assert.equal((await get('/api/sessions', '<machine-token>')).status, 404)

  // /api/health：未登录不带内部信息，登录（含机器凭据）后带 allowedCwds
  const anon = (await (await get('/hub/api/health')).json()) as any
  assert.equal(anon.allowedCwds, undefined)
  const authed = (await (await get('/hub/api/health', '<machine-token>')).json()) as any
  assert.deepEqual(authed.allowedCwds, ['/Users/dev/code'])
})

test('attachWs：wsPath=/hub/ws，destroyUnmatched=false 时与宿主的其他 WS 共存；hello 走注入的 authenticate', async () => {
  const d = deps()
  const server = createServer((_req, res) => res.writeHead(404).end())
  attachWs(server, d, { wsPath: '/hub/ws', destroyUnmatched: false })
  // 宿主自己的 WS（如硬件通道）
  const other = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/board') other.handleUpgrade(req, socket, head, (ws) => ws.send('board-hi'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const hubWs = new WebSocket(`${base}/hub/ws`)
    const msgs: any[] = []
    hubWs.on('message', (m) => msgs.push(JSON.parse(m.toString())))
    await once(hubWs, 'open')
    hubWs.send(JSON.stringify({ t: 'hello', token: '<machine-token>' }))
    while (!msgs.some((m) => m.t === 'snapshot')) await new Promise((r) => setTimeout(r, 5))
    assert.equal(msgs[0].sessions[0].id, 'claude:s1')
    hubWs.close()

    const board = new WebSocket(`${base}/board`)
    const [hi] = await once(board, 'message')
    assert.equal(hi.toString(), 'board-hi')
    board.close()

    // 原来的 /ws 不再由 Hub 处理
    const bad = new WebSocket(`${base}/hub/wrong`)
    bad.on('error', () => {})
    const t = setTimeout(() => bad.terminate(), 300)
    await closed(bad)
    clearTimeout(t)
    assert.notEqual(bad.readyState, WebSocket.OPEN)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('attachWs：默认 /ws，路径不匹配的 upgrade 直接断开（独立运行时的原行为）', async () => {
  const d = deps()
  const server = createServer()
  attachWs(server, d)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const bad = new WebSocket(`${base}/other`)
    bad.on('error', () => {})
    await closed(bad)
    const ok = new WebSocket(`${base}/ws`)
    await once(ok, 'open')
    ok.close()
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
