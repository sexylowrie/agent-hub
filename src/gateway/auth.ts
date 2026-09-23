import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { DeviceRow, Store } from '../core/store.ts'

export const PAIRING_TTL_MS = 5 * 60_000

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** 生成一次性 6 位配对码，5 分钟过期 */
export function createPairingCode(store: Store, now = Date.now()): { code: string; expiresAt: number } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = now + PAIRING_TTL_MS
  store.insertPairingCode(code, expiresAt)
  return { code, expiresAt }
}

/** 消费配对码并登记设备；明文 token 只在这里返回一次，库里只存哈希 */
export function pairDevice(store: Store, code: string, deviceName: string): { token: string; deviceId: string } | undefined {
  if (!/^\d{6}$/.test(code) || !store.consumePairingCode(code)) return undefined
  const token = randomBytes(32).toString('base64url')
  const deviceId = randomUUID()
  store.insertDevice(deviceId, deviceName, hashToken(token))
  return { token, deviceId }
}

export function authenticate(store: Store, token: string | undefined): DeviceRow | undefined {
  if (!token) return undefined
  const d = store.findDeviceByTokenHash(hashToken(token))
  if (d) store.touchDevice(d.id)
  return d
}

export function bearer(header: string | undefined | null): string | undefined {
  const m = header?.match(/^Bearer\s+(.+)$/i)
  return m?.[1].trim()
}
