import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HubEvent } from '../../src/core/events.ts'
import { eventBlocks, historyBlocks, hubTurnOpen, splitAt } from '../../web/src/timeline.ts'

const S = 'claude:s'
const ev = (events: HubEvent[]) => events.map((event, i) => ({ seq: i + 1, event }))

test('eventBlocks：delta 按 turnId 拼接、tool 合并 started/done、审批回填决定', () => {
  const blocks = eventBlocks(
    ev([
      { type: 'turn.started', sessionId: S, turnId: 't1', source: 'hub' },
      { type: 'message.user', sessionId: S, turnId: 't1', text: '写文件' },
      { type: 'message.delta', sessionId: S, turnId: 't1', text: '好的，' },
      { type: 'message.delta', sessionId: S, turnId: 't1', text: '马上' },
      { type: 'tool.call', sessionId: S, turnId: 't1', callId: 'c1', name: 'Write', input: { file_path: '/tmp/a' }, status: 'started' },
      { type: 'approval.request', sessionId: S, turnId: 't1', approvalId: 'a1', kind: 'file_write', summary: 'Write /tmp/a', detail: {}, expiresAt: 1 },
      { type: 'approval.decided', sessionId: S, approvalId: 'a1', decision: 'allow', by: 'dev' },
      { type: 'tool.call', sessionId: S, turnId: 't1', callId: 'c1', name: 'unknown', input: null, status: 'done', output: 'ok' },
      { type: 'message.delta', sessionId: S, turnId: 't1', text: '完成' },
      { type: 'turn.done', sessionId: S, turnId: 't1', status: 'success', resultText: '完成', durationMs: 1200 },
    ]),
  )
  assert.deepEqual(blocks.map((b) => b.kind), ['user', 'assistant', 'tool', 'approval', 'assistant', 'done'])
  assert.equal((blocks[1] as any).text, '好的，马上')
  assert.deepEqual({ ...(blocks[2] as any), key: undefined }, { kind: 'tool', key: undefined, name: 'Write', input: { file_path: '/tmp/a' }, output: 'ok', isError: undefined, done: true })
  assert.equal((blocks[3] as any).decision, 'allow')
})

test('eventBlocks：没有流式文本的轮次用 resultText 补成回复', () => {
  const blocks = eventBlocks(ev([{ type: 'turn.done', sessionId: S, turnId: 't2', status: 'error', resultText: '额度不足' }]))
  assert.deepEqual(blocks.map((b) => b.kind), ['assistant', 'done'])
})

test('historyBlocks 与 hubTurnOpen', () => {
  const h = historyBlocks([
    { role: 'user', text: 'hi', source: 'desktop' },
    { role: 'tool', text: 'ls', toolName: 'Bash', source: 'desktop' },
  ])
  assert.deepEqual(h.map((b) => b.kind), ['user', 'tool'])
  assert.equal(hubTurnOpen(ev([{ type: 'turn.started', sessionId: S, turnId: 't', source: 'hub' }])), true)
  assert.equal(hubTurnOpen(ev([{ type: 'turn.started', sessionId: S, turnId: 't', source: 'desktop' }])), false)
  assert.equal(
    hubTurnOpen(ev([{ type: 'turn.started', sessionId: S, turnId: 't', source: 'hub' }, { type: 'turn.done', sessionId: S, turnId: 't', status: 'success' }])),
    false,
  )
})

test('splitAt：未结束的轮次从 turn.started 起走实时事件，并裁掉历史里同一轮的内容', () => {
  const history = [
    { role: 'user' as const, text: '早先', source: 'cli' as const },
    { role: 'assistant' as const, text: '好', source: 'cli' as const },
    { role: 'user' as const, text: '写文件', source: 'cli' as const },
  ]
  const events = ev([
    { type: 'turn.started', sessionId: S, turnId: 'old', source: 'hub' },
    { type: 'turn.done', sessionId: S, turnId: 'old', status: 'success' },
    { type: 'turn.started', sessionId: S, turnId: 't', source: 'hub' },
    { type: 'message.user', sessionId: S, turnId: 't', text: '写文件' },
  ])
  assert.deepEqual(splitAt(history, events), { history: history.slice(0, 2), baseSeq: 2 })
  // 轮次都已结束：历史全保留，实时事件从最新 seq 之后开始
  assert.deepEqual(splitAt(history, events.slice(0, 2)), { history, baseSeq: 2 })
})
