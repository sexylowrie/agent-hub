// 与 Hub 共用的类型：只 import type，不把 zod 打进前端包
export type { Decision, HistoryItem, HubEvent, SessionState, SessionView, Vendor } from '../../src/core/events.ts'
import type { HistoryItem, HubEvent, SessionView, Vendor } from '../../src/core/events.ts'

export interface StoredEvent {
  seq: number
  event: HubEvent
  ts?: number
}

export interface PendingApproval {
  id: string
  kind: string
  summary: string
  expiresAt: number
}

export type SessionDetail = SessionView & { events: StoredEvent[]; messages?: HistoryItem[]; pendingApprovals?: PendingApproval[] }

export interface Health {
  ok: boolean
  version: string
  vendors: Record<Vendor, { bin: string; version?: string; ok: boolean; error?: string }>
  allowedCwds?: string[]
  push?: { vapidPublicKey: string }
}

export type Ack = { t: 'ack'; reqId: string; ok: true; data?: any } | { t: 'ack'; reqId: string; ok: false; code: string; message: string }

export type ServerMessage =
  | { t: 'snapshot'; sessions: SessionView[]; seq: number }
  | { t: 'event'; seq: number; event: HubEvent }
  | Ack
  | { t: 'pong' }
