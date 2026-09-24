import { z } from 'zod'

export const Vendor = z.enum(['claude', 'codex', 'cursor'])
export type Vendor = z.infer<typeof Vendor>

/** attached：有进程持有会话（终端 / 桌面 App 开着）但已安静；与 running 一样不可续聊，只是文案与可选动作不同 */
export const SessionState = z.enum(['idle', 'running', 'attached', 'awaiting_approval', 'error', 'unknown'])
export type SessionState = z.infer<typeof SessionState>

/** attached 会话的持有者：cli=终端里的进程，gui=桌面 App；tmux 为 Claude CLI 所在的 pane */
export const Holder = z.object({
  kind: z.enum(['cli', 'gui']),
  pid: z.number().int().optional(),
  tmux: z.object({ target: z.string() }).optional(),
})
export type Holder = z.infer<typeof Holder>

export const Origin = z.enum(['desktop', 'cli', 'hub'])
export type Origin = z.infer<typeof Origin>

export const ApprovalKind = z.enum(['command', 'file_write', 'tool', 'other'])
export type ApprovalKind = z.infer<typeof ApprovalKind>

export const Decision = z.enum(['allow', 'deny', 'allow_session'])
export type Decision = z.infer<typeof Decision>

export const SessionView = z.object({
  id: z.string(),
  vendor: Vendor,
  vendorSessionId: z.string(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  origin: Origin,
  state: SessionState,
  resumable: z.boolean(),
  unresumableReason: z.string().optional(),
  archived: z.boolean(),
  lastMessagePreview: z.string().optional(),
  vendorUpdatedAt: z.number().optional(),
  updatedAt: z.number(),
  /** 只在 state=attached 时出现 */
  holder: Holder.optional(),
})
export type SessionView = z.infer<typeof SessionView>

const turnId = z.string().optional()

export const HubEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.upsert'), session: SessionView }),
  z.object({ type: z.literal('session.state'), sessionId: z.string(), state: SessionState, reason: z.string().optional() }),
  z.object({ type: z.literal('turn.started'), sessionId: z.string(), turnId: z.string(), source: z.enum(['desktop', 'hub']) }),
  z.object({ type: z.literal('message.user'), sessionId: z.string(), turnId, text: z.string() }),
  z.object({ type: z.literal('message.delta'), sessionId: z.string(), turnId, text: z.string() }),
  z.object({ type: z.literal('thinking.delta'), sessionId: z.string(), turnId, text: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    sessionId: z.string(),
    turnId,
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: z.enum(['started', 'done']),
    output: z.string().optional(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('approval.request'),
    sessionId: z.string(),
    turnId,
    approvalId: z.string(),
    kind: ApprovalKind,
    summary: z.string(),
    detail: z.unknown(),
    expiresAt: z.number(),
  }),
  z.object({ type: z.literal('approval.decided'), sessionId: z.string(), approvalId: z.string(), decision: Decision, by: z.string() }),
  z.object({
    type: z.literal('turn.done'),
    sessionId: z.string(),
    turnId,
    status: z.enum(['success', 'error', 'interrupted']),
    resultText: z.string().optional(),
    usage: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
    durationMs: z.number().optional(),
  }),
  z.object({ type: z.literal('error'), sessionId: z.string().optional(), message: z.string(), recoverable: z.boolean() }),
])
export type HubEvent = z.infer<typeof HubEvent>
export type HubEventType = HubEvent['type']

/** 会话详情里的历史消息（厂商存储读出，REST 返回，不进 events 表） */
export interface HistoryItem {
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  at?: number
  /** desktop=桌面端写入；cli=厂商 CLI 写入（含 Hub 续聊） */
  source: 'desktop' | 'cli'
}

export const sessionKey =(vendor: Vendor, vendorSessionId: string) => `${vendor}:${vendorSessionId}`
