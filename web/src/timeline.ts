import type { Decision, HistoryItem, HubEvent } from './types.ts'

export type Block =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string; turnId?: string }
  | { kind: 'tool'; key: string; name: string; input: unknown; output?: string; isError?: boolean; done: boolean }
  | { kind: 'approval'; key: string; approvalId: string; approvalKind: string; summary: string; detail: unknown; expiresAt: number; decision?: Decision; by?: string }
  | { kind: 'done'; key: string; status: 'success' | 'error' | 'interrupted'; resultText?: string; durationMs?: number }
  | { kind: 'error'; key: string; message: string }

/** 历史里的工具输入是 JSON 字符串（可能被截断）；能解析就还原成对象，摘要才能挑出命令/路径 */
function parseMaybe(text: string): unknown {
  if (!/^[[{]/.test(text)) return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 厂商历史 → 块（工具调用只有输入摘要） */
export function historyBlocks(items: HistoryItem[]): Block[] {
  return items.map((m, i): Block => {
    const key = `h${i}`
    if (m.role === 'user') return { kind: 'user', key, text: m.text }
    if (m.role === 'assistant') return { kind: 'assistant', key, text: m.text }
    return { kind: 'tool', key, name: m.toolName ?? 'tool', input: parseMaybe(m.text), done: true }
  })
}

/**
 * 事件流 → 块。message.delta 按 turnId 拼接到同一个 assistant 块；tool.call 按 callId 合并 started/done；
 * approval.decided 回填到对应审批卡片。
 */
export function eventBlocks(events: { seq: number; event: HubEvent }[]): Block[] {
  const out: Block[] = []
  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>()
  const approvals = new Map<string, Extract<Block, { kind: 'approval' }>>()
  const turnHasText = new Set<string>()
  for (const { seq, event: e } of events) {
    const key = `e${seq}`
    switch (e.type) {
      case 'message.user':
        out.push({ kind: 'user', key, text: e.text })
        break
      case 'message.delta': {
        const last = out[out.length - 1]
        if (last?.kind === 'assistant' && last.turnId === e.turnId) last.text += e.text
        else out.push({ kind: 'assistant', key, text: e.text, turnId: e.turnId })
        if (e.turnId) turnHasText.add(e.turnId)
        break
      }
      case 'tool.call': {
        const t = tools.get(e.callId)
        if (t) {
          if (e.status === 'done') {
            t.done = true
            t.output = e.output
            t.isError = e.isError
          }
          if (e.name !== 'unknown') t.name = e.name
          if (e.input !== null && e.input !== undefined) t.input = e.input
          break
        }
        const b: Extract<Block, { kind: 'tool' }> = {
          kind: 'tool',
          key,
          name: e.name,
          input: e.input,
          output: e.output,
          isError: e.isError,
          done: e.status === 'done',
        }
        tools.set(e.callId, b)
        out.push(b)
        break
      }
      case 'approval.request': {
        const b: Extract<Block, { kind: 'approval' }> = {
          kind: 'approval',
          key,
          approvalId: e.approvalId,
          approvalKind: e.kind,
          summary: e.summary,
          detail: e.detail,
          expiresAt: e.expiresAt,
        }
        approvals.set(e.approvalId, b)
        out.push(b)
        break
      }
      case 'approval.decided': {
        const b = approvals.get(e.approvalId)
        if (b) {
          b.decision = e.decision
          b.by = e.by
        }
        break
      }
      case 'turn.done':
        // 没有流式文本的轮次（如 Cursor 失败、只给 result）把 resultText 补成回复
        if (e.resultText && !(e.turnId && turnHasText.has(e.turnId))) out.push({ kind: 'assistant', key: `${key}r`, text: e.resultText, turnId: e.turnId })
        out.push({ kind: 'done', key, status: e.status, resultText: e.resultText, durationMs: e.durationMs })
        break
      case 'error':
        out.push({ kind: 'error', key, message: e.message })
        break
    }
  }
  return out
}

/** 最近一个 Hub 轮次是否还没结束（用于显示"中断"） */
export function hubTurnOpen(events: { event: HubEvent }[]): boolean {
  let open = false
  for (const { event: e } of events) {
    if (e.type === 'turn.started') open = e.source === 'hub'
    else if (e.type === 'turn.done') open = false
  }
  return open
}

/**
 * 厂商历史与 Hub 事件的分界：载入时若有未结束的轮次，从它的 turn.started 起用实时事件渲染，
 * 并把历史里已写入的同一轮（从该轮用户消息起）裁掉，避免重复或漏掉用户消息。
 */
export function splitAt(history: HistoryItem[], events: { seq: number; event: HubEvent }[]): { history: HistoryItem[]; baseSeq: number } {
  let baseSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
  let open: { seq: number; turnId: string } | undefined
  for (const { seq, event: e } of events) {
    if (e.type === 'turn.started') open = { seq, turnId: e.turnId }
    else if (e.type === 'turn.done') open = undefined
  }
  if (!open) return { history, baseSeq }
  baseSeq = open.seq - 1
  const turnId = open.turnId
  const userText = events.find((x) => x.event.type === 'message.user' && x.event.turnId === turnId)?.event as { text: string } | undefined
  if (!userText) return { history, baseSeq }
  const cut = history.map((h) => h.role === 'user' && h.text.trim() === userText.text.trim()).lastIndexOf(true)
  return { history: cut >= 0 ? history.slice(0, cut) : history, baseSeq }
}
