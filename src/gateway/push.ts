import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type JsonWebKey, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../core/store.ts'

// Web Push：消息加密按 RFC 8291（aes128gcm，RFC 8188 单记录），应用服务器身份按 RFC 8292（VAPID）。
// 只用 node:crypto，测试向量见 test/gateway/push.test.ts（RFC 8291 附录 A）。

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac('sha256', key).update(data).digest()
/** HKDF-Expand，输出不超过 32 字节时只需一轮 */
const expand = (prk: Uint8Array, info: Uint8Array, len: number) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len)

export interface PushKeys {
  /** 客户端公钥（65 字节未压缩点，base64url） */
  p256dh: string
  /** 16 字节认证密钥（base64url） */
  auth: string
}

/**
 * 加密一条推送消息，返回 aes128gcm 消息体（header || ciphertext）。
 * asPrivate / salt 只在测试里注入；正常每条消息都生成新的临时密钥和盐。
 */
export function encryptPayload(plaintext: Uint8Array, keys: PushKeys, opts: { asPrivate?: Uint8Array; salt?: Uint8Array } = {}): Buffer {
  const uaPublic = unb64u(keys.p256dh)
  const authSecret = unb64u(keys.auth)
  const ecdh = createECDH('prime256v1')
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const ecdhSecret = ecdh.computeSecret(uaPublic)
  const salt = opts.salt ?? randomBytes(16)

  const prkKey = hmac(authSecret, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = expand(prkKey, keyInfo, 32)
  const prk = hmac(salt, ikm)
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12)

  // 单记录：明文后接 0x02（最后一条记录的分隔符），不额外填充
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

export interface Vapid {
  publicKey: string
  privateKey: KeyObject
}

/** 读取或生成 VAPID 密钥（P-256，私钥以 JWK 存在 dataDir，权限 600） */
export function loadVapid(dataDir: string): Vapid {
  const file = join(dataDir, 'vapid.json')
  let jwk: JsonWebKey
  if (existsSync(file)) jwk = JSON.parse(readFileSync(file, 'utf8'))
  else {
    jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 })
  }
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)])), privateKey: createPrivateKey({ key: jwk, format: 'jwk' }) }
}

/** VAPID Authorization 头：ES256 JWT，aud 为推送服务的 origin */
export function vapidAuth(endpoint: string, v: Vapid, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: v.privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`
}

export interface PushMessage {
  title: string
  body: string
  /** 点开后打开的页面（hash 路由） */
  url: string
  /** 同 tag 的通知互相替换 */
  tag: string
}

export class WebPush {
  constructor(
    private readonly store: Store,
    readonly vapid: Vapid,
    private readonly subject: string,
    private readonly log: (m: string) => void = (m) => console.log(`[push] ${m}`),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 发给所有设备；推送服务返回 404/410 表示订阅已失效，删掉 */
  async broadcast(msg: PushMessage): Promise<{ sent: number; failed: number }> {
    const subs = this.store.listPushSubscriptions()
    let sent = 0
    let failed = 0
    await Promise.all(
      subs.map(async (s) => {
        try {
          const res = await this.fetchImpl(s.endpoint, {
            method: 'POST',
            headers: {
              TTL: '86400',
              Urgency: 'high',
              Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              Authorization: vapidAuth(s.endpoint, this.vapid, this.subject),
            },
            body: new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(msg)), { p256dh: s.p256dh, auth: s.auth })),
          })
          if (res.status === 404 || res.status === 410) {
            this.store.deletePushSubscription(s.endpoint)
            this.log(`订阅已失效，删除（device=${s.deviceId}）`)
            failed++
          } else if (!res.ok) {
            this.log(`推送失败 ${res.status}（device=${s.deviceId}）：${(await res.text()).slice(0, 200)}`)
            failed++
          } else sent++
        } catch (e) {
          this.log(`推送异常（device=${s.deviceId}）：${(e as Error).message}`)
          failed++
        }
      }),
    )
    return { sent, failed }
  }
}
