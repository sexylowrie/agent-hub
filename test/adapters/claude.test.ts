import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeLineParser, approvalFromControl, buildControlResponse, claudeArgs, type ControlRequest } from '../../src/adapters/claude.ts'
import type { HubEvent } from '../../src/core/events.ts'
import { stdinLines, stdoutLines } from '../helpers.ts'

function replay(file: string, o: ConstructorParameters<typeof ClaudeLineParser>[0]) {
  const p = new ClaudeLineParser(o)
  const events: HubEvent[] = []
  const controls: ControlRequest[] = []
  let done = false
  for (const line of stdoutLines(file)) {
    const r = p.feed(line)
    events.push(...r.events)
    if (r.control) controls.push(r.control)
    if (r.done) done = true
  }
  return { events, controls, done }
}

const types = (es: HubEvent[]) => es.map((e) => (e.type === 'tool.call' ? `tool.call:${e.status}` : e.type))

test('one-turn-with-tool：partial 文本增量 + 工具调用', () => {
  const sid = '8fb981c1-3e77-48b6-8283-4ebf6fbf3b4c'
  const { events, done } = replay('claude/one-turn-with-tool.ndjson', { turnId: 't1', prompt: 'hi', vendorSessionId: sid })
  assert.ok(done)
  assert.deepEqual(types(events), [
    'turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'message.delta', 'message.delta', 'turn.done',
  ])
  for (const e of events) assert.equal((e as any).sessionId, `claude:${sid}`)
  const deltas = events.filter((e) => e.type === 'message.delta').map((e: any) => e.text).join('')
  assert.equal(deltas, '收到')
  const doneCall = events.find((e) => e.type === 'tool.call' && e.status === 'done') as any
  assert.equal(doneCall.name, 'Bash')
  assert.equal(doneCall.output, 'hub-probe')
  assert.equal(doneCall.isError, false)
  const last = events.at(-1) as any
  assert.equal(last.status, 'success')
  assert.equal(last.resultText, '收到')
  assert.equal(last.turnId, 't1')
  assert.equal(last.usage.output, 84)
})

test('permission-roundtrip：无 partial 时用 assistant 整块，解析出审批并构造回执', () => {
  const { events, controls, done } = replay('claude/permission-roundtrip.ndjson', { turnId: 't2', prompt: 'p' })
  assert.ok(done)
  assert.deepEqual(types(events), [
    'turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'message.delta', 'turn.done',
  ])
  assert.equal((events[0] as any).sessionId, 'claude:f2301e94-69c5-4852-b821-0a015e847cb6')
  assert.equal((events.at(-1) as any).resultText, '收到')

  assert.equal(controls.length, 1)
  const c = controls[0]
  const a = approvalFromControl(c)
  assert.equal(a.kind, 'command')
  assert.match(a.summary, /^Bash: echo probe/)

  // 回执与录制中我方实际写入的一致
  const recorded = stdinLines('claude/permission-roundtrip.ndjson').find((l) => l.type === 'control_response')
  assert.deepEqual(buildControlResponse(c, 'allow'), recorded)

  const deny = buildControlResponse(c, 'deny') as any
  assert.equal(deny.response.response.behavior, 'deny')
  const sess = buildControlResponse(c, 'allow_session') as any
  assert.ok(sess.response.response.updatedPermissions.every((p: any) => p.destination === 'session'))
})

test('start 模式从 init 取新 id 并先发 session.upsert', () => {
  const { events } = replay('claude/one-turn-with-tool.ndjson', { turnId: 't3', prompt: '新会话首句', cwd: '/tmp', isStart: true })
  assert.equal(events[0].type, 'session.upsert')
  const s = (events[0] as any).session
  assert.equal(s.vendorSessionId, '8fb981c1-3e77-48b6-8283-4ebf6fbf3b4c')
  assert.equal(s.origin, 'hub')
  assert.equal(events[1].type, 'turn.started')
})

test('参数：默认 default 权限模式，force 用 acceptEdits，不用 bypass', () => {
  const a = claudeArgs({ resumeId: 'x' })
  assert.deepEqual(a.slice(0, 3), ['-p', '--resume', 'x'])
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default')
  const f = claudeArgs({ force: true })
  assert.equal(f[f.indexOf('--permission-mode') + 1], 'acceptEdits')
  assert.ok(!f.includes('--resume'))
  assert.ok(!f.join(' ').includes('bypass'))
})

test('adapter-args-roundtrip：Adapter 实际参数（partial + stdio 审批）', () => {
  const { events, controls, done } = replay('claude/adapter-args-roundtrip.ndjson', { turnId: 't4', prompt: 'p', vendorSessionId: 'x' })
  assert.ok(done)
  assert.deepEqual(types(events), [
    'turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'message.delta', 'turn.done',
  ])
  assert.equal(controls.length, 1)
  const recorded = stdinLines('claude/adapter-args-roundtrip.ndjson').find((l) => l.type === 'control_response')
  assert.deepEqual(buildControlResponse(controls[0], 'allow'), recorded)
  assert.equal((events.at(-1) as any).resultText, '收到')
})

test('resume-with-leftover-notification：跳过遗留轮次的空 result，只认自家命令', () => {
  const file = 'claude/resume-with-leftover-notification.ndjson'
  const commandUuid = stdinLines(file).find((l) => l.type === 'user').uuid
  const { events, done } = replay(file, { turnId: 't5', prompt: '只回复两个字：收到', vendorSessionId: 'x', commandUuid })
  assert.ok(done)
  assert.deepEqual(types(events), ['turn.started', 'message.user', 'message.delta', 'turn.done'])
  const last = events.at(-1) as any
  assert.equal(last.resultText, '收到')
  assert.equal(events.filter((e) => e.type === 'turn.done').length, 1)

  // 对照：不带 commandUuid（旧行为）会被遗留 result 提前结束
  const legacy = replay(file, { turnId: 't6', prompt: 'p', vendorSessionId: 'x' })
  assert.equal((legacy.events.find((e) => e.type === 'turn.done') as any).resultText, '')
})

test('竞态：遗留 result 早于自家 queued 到达时也不误判', () => {
  // 真机上观察到的顺序：init → 遗留 result → queued → started …；用真实录制行重排模拟
  const file = 'claude/resume-with-leftover-notification.ndjson'
  const commandUuid = stdinLines(file).find((l) => l.type === 'user').uuid
  const lines = stdoutLines(file)
  const qi = lines.findIndex((l) => l.type === 'command_lifecycle' && l.state === 'queued')
  const [queued] = lines.splice(qi, 1)
  const ri = lines.findIndex((l) => l.type === 'result')
  lines.splice(ri + 1, 0, queued)
  const p = new ClaudeLineParser({ turnId: 't7', prompt: 'p', vendorSessionId: 'x', commandUuid })
  const events: HubEvent[] = []
  let deferred = 0
  for (const l of lines) {
    const r = p.feed(l)
    events.push(...r.events)
    if (r.deferred) deferred++
  }
  assert.equal(deferred, 1)
  assert.deepEqual(p.flushDeferred().events, []) // 之后见到了 lifecycle，扣住的 result 作废
  const done = events.filter((e) => e.type === 'turn.done') as any[]
  assert.equal(done.length, 1)
  assert.equal(done[0].resultText, '收到')
})

test('旧 CLI 兼容：无 lifecycle 时扣住的 result 经 flushDeferred 放行', () => {
  const p = new ClaudeLineParser({ turnId: 't8', prompt: 'p', vendorSessionId: 'x', commandUuid: 'never-seen' })
  let deferred = false
  for (const l of stdoutLines('claude/one-turn-with-tool.ndjson')) if (p.feed(l).deferred) deferred = true
  assert.ok(deferred)
  const r = p.flushDeferred()
  assert.ok(r.done)
  assert.equal((r.events.at(-1) as any).resultText, '收到')
})

test('interrupted：SIGINT 后的 error_during_execution 记为 interrupted，不发 error', () => {
  const file = 'claude/interrupted.ndjson'
  const commandUuid = stdinLines(file).find((l) => l.type === 'user').uuid
  const p = new ClaudeLineParser({ turnId: 't9', prompt: 'p', vendorSessionId: 'x', commandUuid })
  p.markInterrupted()
  const events: HubEvent[] = []
  for (const l of stdoutLines(file)) events.push(...p.feed(l).events)
  assert.ok(!events.some((e) => e.type === 'error'))
  const done = events.filter((e) => e.type === 'turn.done') as any[]
  assert.equal(done.length, 1)
  assert.equal(done[0].status, 'interrupted')

  // 未经 Hub 中断的同样输出仍是 error
  const q = new ClaudeLineParser({ turnId: 't10', prompt: 'p', vendorSessionId: 'x', commandUuid })
  const evs: HubEvent[] = []
  for (const l of stdoutLines(file)) evs.push(...q.feed(l).events)
  assert.equal((evs.find((e) => e.type === 'turn.done') as any).status, 'error')
})
