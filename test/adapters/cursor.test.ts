import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CursorLineParser, cursorArgs } from '../../src/adapters/cursor.ts'
import type { HubEvent } from '../../src/core/events.ts'
import { stdoutLines } from '../helpers.ts'

function replay(file: string, o: ConstructorParameters<typeof CursorLineParser>[0], interrupted = false) {
  const p = new CursorLineParser(o)
  if (interrupted) p.markInterrupted()
  const events: HubEvent[] = []
  let done = 0
  for (const l of stdoutLines(file)) {
    const r = p.feed(l)
    events.push(...r.events)
    if (r.done) done++
  }
  return { events, done, parser: p }
}

const types = (es: HubEvent[]) => es.map((e) => (e.type === 'tool.call' ? `tool.call:${e.status}` : e.type))
const deltas = (es: HubEvent[]) => es.filter((e) => e.type === 'message.delta').map((e: any) => e.text).join('')

test('参数：默认 --sandbox enabled，force 才 --force；partial 输出 + --trust', () => {
  const a = cursorArgs({ resumeId: 'c1', text: 'hi' })
  assert.deepEqual(a.slice(0, 3), ['-p', '--resume', 'c1'])
  assert.equal(a[a.indexOf('--sandbox') + 1], 'enabled')
  assert.ok(!a.includes('--force'))
  assert.ok(a.includes('--stream-partial-output') && a.includes('--trust'))
  assert.equal(a.at(-1), 'hi')
  const f = cursorArgs({ force: true, text: 'x' })
  assert.ok(f.includes('--force') && !f.includes('--sandbox') && !f.includes('--resume'))
})

test('resume-one-turn（partial）：片段文本 + 整块重复被去重，工具调用前后各一段', () => {
  const sid = '782a8d20-bbae-4776-9cda-17cce05b3b92'
  const { events, done } = replay('cursor/resume-one-turn.ndjson', { turnId: 't1', prompt: 'p', vendorSessionId: sid })
  assert.equal(done, 1)
  const last = events.at(-1) as any
  assert.equal(last.type, 'turn.done')
  assert.equal(last.status, 'success')
  // 拼起来的增量文本与 result 一致：说明两次整块重复都被去掉了
  assert.equal(deltas(events), last.resultText)
  const t = types(events).filter((x) => x !== 'message.delta' && x !== 'thinking.delta')
  assert.deepEqual(t, ['turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'turn.done'])
  const call = events.find((e) => e.type === 'tool.call' && e.status === 'done') as any
  assert.equal(call.name, 'shell')
  assert.equal(call.output, 'hub-probe\n')
  assert.equal(call.isError, false)
  for (const e of events) assert.equal((e as any).sessionId, `cursor:${sid}`)
})

test('非 partial（M0 录制）：整块 assistant 照常输出', () => {
  const { events } = replay('cursor/one-turn-with-tool.ndjson', { turnId: 't2', prompt: 'p', vendorSessionId: 'x' })
  assert.equal(deltas(events), '收到')
  assert.equal((events.at(-1) as any).resultText, '收到')
  assert.equal(events.filter((e) => e.type === 'thinking.delta').length, 3)
})

test('start：从 init 取新 id 并先发 session.upsert', () => {
  const { events } = replay('cursor/one-turn-with-tool.ndjson', { turnId: 't3', prompt: '新会话', cwd: '/tmp', isStart: true })
  assert.equal(events[0].type, 'session.upsert')
  const s = (events[0] as any).session
  assert.equal(s.vendorSessionId, 'ddd13a8f-b3b2-44c7-8ac1-e13c40779577')
  assert.equal(s.origin, 'hub')
  assert.equal(s.cwd, '/tmp')
  assert.equal(events[1].type, 'turn.started')
})

test('SIGINT 中断：没有 result 行，解析器不自行结束（由进程退出兜底为 interrupted）', () => {
  const { events, done, parser } = replay('cursor/interrupted.ndjson', { turnId: 't4', prompt: 'p', vendorSessionId: 'x' }, true)
  assert.equal(done, 0)
  assert.ok(!parser.isFinished)
  assert.ok(!parser.hasOutput)
  assert.deepEqual(types(events), ['turn.started', 'message.user'])
})

test('跨重试复用：第二次 init 不重复 turn.started', () => {
  const p = new CursorLineParser({ turnId: 't5', prompt: 'p', vendorSessionId: 'x' })
  const init = stdoutLines('cursor/one-turn-with-tool.ndjson')[0]
  assert.equal(p.feed(init).events.length, 2)
  assert.equal(p.feed(init).events.length, 0)
})
