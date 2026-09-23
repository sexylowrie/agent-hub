import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/core/store.ts'
import { WebPush, encryptPayload, loadVapid, vapidAuth } from '../../src/gateway/push.ts'

// RFC 8291 §5 / 附录 A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}
const u = (s: string) => Buffer.from(s, 'base64url')

test('encryptPayload：与 RFC 8291 附录 A 的结果逐字节一致', () => {
  const out = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { asPrivate: u(RFC.asPrivate), salt: u(RFC.salt) })
  assert.equal(out.toString('base64url'), RFC.body)
})

/** 按接收端（浏览器）流程解密，验证随机密钥下的往返 */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ct = body.subarray(21 + idlen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest()
  const ex = (prk: Buffer, info: string | Buffer, n: number) => h(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, n)
  const ikm = ex(h(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32)
  const prk = h(salt, ikm)
  const d = createDecipheriv('aes-128-gcm', ex(prk, 'Content-Encoding: aes128gcm\0', 16), ex(prk, 'Content-Encoding: nonce\0', 12))
  d.setAuthTag(ct.subarray(ct.length - 16))
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  assert.equal(pt[pt.length - 1], 2)
  return pt.subarray(0, -1).toString()
}

test('encryptPayload：随机临时密钥与盐，接收端可解密', () => {
  const a = encryptPayload(Buffer.from('你好'), { p256dh: RFC.uaPublic, auth: RFC.auth })
  const b = encryptPayload(Buffer.from('你好'), { p256dh: RFC.uaPublic, auth: RFC.auth })
  assert.notEqual(a.toString('hex'), b.toString('hex'))
  assert.equal(decrypt(a, u(RFC.uaPrivate), u(RFC.auth)), '你好')
})

test('VAPID：密钥持久化；JWT 的 aud/exp/sub 正确且 ES256 签名可用公钥验证', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-vapid-'))
  const v = loadVapid(dir)
  assert.equal(loadVapid(dir).publicKey, v.publicKey)
  assert.equal(u(v.publicKey).length, 65)
  const now = Date.UTC(2026, 8, 24)
  const h = vapidAuth('https://web.push.apple.com/abc?x=1', v, 'mailto:a@b.c', now)
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!
  assert.equal(m[4], v.publicKey)
  assert.deepEqual(JSON.parse(u(m[2]).toString()), { aud: 'https://web.push.apple.com', exp: now / 1000 + 43200, sub: 'mailto:a@b.c' })
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(u(v.publicKey).subarray(1, 33)), y: b64(u(v.publicKey).subarray(33)) }, format: 'jwk' })
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, u(m[3])))
})
const b64 = (b: Buffer) => b.toString('base64url')

test('broadcast：加密发给每个订阅，410 的订阅被删除', async () => {
  const store = new Store(':memory:')
  store.insertDevice('d1', 'phone', 'h1')
  store.insertDevice('d2', 'pad', 'h2')
  store.insertDevice('d3', 'old', 'h3')
  store.revokeDevice('d3')
  store.upsertPushSubscription({ endpoint: 'https://push.example/revoked', deviceId: 'd3', p256dh: RFC.uaPublic, auth: RFC.auth })
  store.upsertPushSubscription({ endpoint: 'https://push.example/ok', deviceId: 'd1', p256dh: RFC.uaPublic, auth: RFC.auth })
  store.upsertPushSubscription({ endpoint: 'https://push.example/gone', deviceId: 'd2', p256dh: RFC.uaPublic, auth: RFC.auth })
  const calls: { url: string; init: RequestInit }[] = []
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(null, { status: url.endsWith('gone') ? 410 : 201 })
  }) as unknown as typeof fetch
  const push = new WebPush(store, loadVapid(mkdtempSync(join(tmpdir(), 'hub-vapid-'))), 'mailto:a@b.c', () => {}, fake)
  const r = await push.broadcast({ title: '需要审批', body: 'Bash: ls', url: '/#/s/x', tag: 'approval-1' })
  assert.deepEqual(r, { sent: 1, failed: 1 })
  const ok = calls.find((c) => c.url.endsWith('ok'))!
  const headers = ok.init.headers as Record<string, string>
  assert.equal(headers['Content-Encoding'], 'aes128gcm')
  assert.match(headers.Authorization, /^vapid t=/)
  assert.deepEqual(JSON.parse(decrypt(Buffer.from(ok.init.body as Uint8Array), u(RFC.uaPrivate), u(RFC.auth))), {
    title: '需要审批',
    body: 'Bash: ls',
    url: '/#/s/x',
    tag: 'approval-1',
  })
  assert.ok(!calls.some((c) => c.url.endsWith('revoked')))
  assert.deepEqual(store.listPushSubscriptions().map((s) => s.endpoint), ['https://push.example/ok'])
})

test('attachPushNotifier：推审批与 Hub 轮次的 turn.done，桌面端 turn.done 不推', async () => {
  const { Bus } = await import('../../src/core/bus.ts')
  const { attachPushNotifier } = await import('../../src/gateway/notify.ts')
  const store = new Store(':memory:')
  store.upsertSession({ id: 'claude:s', vendor: 'claude', vendorSessionId: 's', cwd: '/tmp', title: '修 bug', origin: 'cli', state: 'idle', resumable: true, archived: false, updatedAt: 1 })
  const bus = new Bus()
  const sent: any[] = []
  attachPushNotifier(bus, store, { broadcast: async (m) => (sent.push(m), { sent: 1, failed: 0 }) })
  const pub = (event: any) => bus.publish({ seq: 1, event })
  pub({ type: 'turn.started', sessionId: 'claude:s', turnId: 'd1', source: 'desktop' })
  pub({ type: 'turn.done', sessionId: 'claude:s', turnId: 'd1', status: 'success', resultText: '桌面端' })
  pub({ type: 'turn.started', sessionId: 'claude:s', turnId: 'h1', source: 'hub' })
  pub({ type: 'approval.request', sessionId: 'claude:s', turnId: 'h1', approvalId: 'a1', kind: 'command', summary: 'Bash: rm x', detail: {}, expiresAt: 1 })
  pub({ type: 'turn.done', sessionId: 'claude:s', turnId: 'h1', status: 'success', resultText: '好了' })
  assert.deepEqual(sent, [
    { title: '需要审批 · 修 bug', body: 'Bash: rm x', url: '/#/s/claude%3As', tag: 'approval-a1' },
    { title: '完成 · 修 bug', body: '好了', url: '/#/s/claude%3As', tag: 'turn-claude:s' },
  ])
})
