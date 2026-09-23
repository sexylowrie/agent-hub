import { z } from 'zod'
import { Decision, Vendor } from '../core/events.ts'

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string(), sinceSeq: z.number().int().nonnegative().optional() }),
  z.object({ t: z.literal('subscribe'), sessionId: z.string() }),
  z.object({ t: z.literal('unsubscribe'), sessionId: z.string() }),
  z.object({ t: z.literal('send'), reqId: z.string(), sessionId: z.string(), text: z.string().min(1), force: z.boolean().optional() }),
  z.object({ t: z.literal('start'), reqId: z.string(), vendor: Vendor, cwd: z.string(), text: z.string().min(1), force: z.boolean().optional() }),
  z.object({ t: z.literal('approve'), reqId: z.string(), approvalId: z.string(), decision: Decision }),
  z.object({ t: z.literal('interrupt'), reqId: z.string(), sessionId: z.string() }),
  z.object({ t: z.literal('ping') }),
])
export type ClientMessage = z.infer<typeof ClientMessage>

/** 所有设备都会收到的事件类型；其余事件只发给订阅了该会话的连接 */
export const BROADCAST_TYPES = new Set(['session.upsert', 'session.state', 'approval.request', 'approval.decided'])

export const WS_CLOSE_UNAUTHORIZED = 4401
