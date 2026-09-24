import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { AgentAdapter } from '../../src/adapters/types.ts'
import { Bus } from '../../src/core/bus.ts'
import { Hub } from '../../src/core/sessions.ts'
import { Store } from '../../src/core/store.ts'
import { createPairingCode, pairDevice } from '../../src/gateway/auth.ts'
import { startGateway } from '../../src/gateway/server.ts'

async function setup(adapters: Partial<Record<'claude', AgentAdapter>> = {}) {
  const webRoot = mkdtempSync(join(tmpdir(), 'hub-web-'))
  mkdirSync(join(webRoot, 'assets'))
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><div id="app"></div>')
  writeFileSync(join(webRoot, 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(join(webRoot, 'sw.js'), '// sw')
  writeFileSync(join(tmpdir(), 'hub-web-secret.txt'), 'secret')
  const store = new Store(':memory:')
  const bus = new Bus()
  const hub = new Hub({ store, bus, adapters, approvalExpireMs: 60_000, isCwdAllowed: () => true, log: () => {} })
  const server = await startGateway({ allowedCwds: () => ['/tmp'], store, bus, hub, version: 't', vendors: () => ({}) as any, webRoot, log: () => {} }, { host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { token } = pairDevice(store, createPairingCode(store).code, 'test')!
  return { store, hub, server, base, token, close: () => (server.closeAllConnections(), server.close()) }
}

test('静态托管：index 与前端路由回落、assets 长缓存、目录穿越 404、未知 /api 仍是 JSON 404', async () => {
  const { base, close } = await setup()
  try {
    const root = await fetch(`${base}/`)
    assert.equal(root.status, 200)
    assert.match(root.headers.get('content-type')!, /text\/html/)
    assert.equal(root.headers.get('cache-control'), 'no-cache')
    assert.match(await root.text(), /id="app"/)
    assert.match(await (await fetch(`${base}/s/claude:x`)).text(), /id="app"/)
    const js = await fetch(`${base}/assets/index-abc.js`)
    assert.match(js.headers.get('content-type')!, /javascript/)
    assert.match(js.headers.get('cache-control')!, /immutable/)
    assert.equal((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache')
    assert.equal((await fetch(`${base}/missing.js`)).status, 404)
    assert.equal((await fetch(`${base}/%2e%2e/hub-web-secret.txt`)).status, 404)
    const api = await fetch(`${base}/api/nope`, { headers: { authorization: 'Bearer x' } })
    assert.equal(api.status, 401)
  } finally {
    close()
  }
})

test('会话详情带 pendingApprovals：只列 pending 且未过期的', async () => {
  const { store, base, token, close } = await setup()
  try {
    const now = Date.now()
    store.upsertSession({ id: 'claude:s1', vendor: 'claude', vendorSessionId: 's1', cwd: '/tmp', title: 't', origin: 'cli', state: 'awaiting_approval', resumable: true, archived: false, updatedAt: now })
    const base0 = { sessionId: 'claude:s1', turnId: 't1', kind: 'command' as const, summary: 'ls', payload: '{}', createdAt: now }
    store.insertApproval({ ...base0, id: 'a-live', expiresAt: now + 60_000 })
    store.insertApproval({ ...base0, id: 'a-old', expiresAt: now - 1 })
    store.insertApproval({ ...base0, id: 'a-done', expiresAt: now + 60_000 })
    store.decideApproval('a-done', 'allow', 'dev')
    const d = (await (await fetch(`${base}/api/sessions/claude%3As1`, { headers: { authorization: `Bearer ${token}` } })).json()) as any
    assert.deepEqual(d.pendingApprovals.map((a: any) => a.id), ['a-live'])
  } finally {
    close()
  }
})

test('start 在拿到会话 id 之前失败：错误事件只发给发起的连接', async () => {
  const failing: AgentAdapter = {
    vendor: 'claude',
    resume: () => { throw new Error('unused') },
    start: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('spawn ENOENT')) }),
    }),
  } as unknown as AgentAdapter
  const { base, token, close } = await setup({ claude: failing })
  const connect = async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`)
    const msgs: any[] = []
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())))
    await once(ws, 'open')
    ws.send(JSON.stringify({ t: 'hello', token }))
    return { ws, msgs }
  }
  try {
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify({ t: 'start', reqId: 'r1', vendor: 'claude', cwd: '/tmp', text: 'hi' }))
    const t0 = Date.now()
    while (!a.msgs.some((m) => m.event?.type === 'error') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10))
    const ack = a.msgs.find((m) => m.reqId === 'r1')
    const err = a.msgs.find((m) => m.event?.type === 'error').event
    assert.equal(err.sessionId, `pending:${ack.data.turnId}`)
    assert.match(err.message, /spawn ENOENT/)
    assert.ok(!b.msgs.some((m) => m.event?.type === 'error'))
    a.ws.close()
    b.ws.close()
  } finally {
    close()
  }
})
