import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CodexLineParser, buildServerResponse, codexArgs, codexDecision, type ServerReq } from '../../src/adapters/codex.ts'
import type { HubEvent } from '../../src/core/events.ts'
import { stdinLines, stdoutLines } from '../helpers.ts'

/**
 * 按录制回放：模拟 Adapter 的编排——turn/start 的响应给出本轮 turnId，thread/start 的响应给出新线程 id，
 * 其余响应不进解析器。
 */
function replay(file: string, o: { turnId: string; prompt: string; threadId?: string; interrupted?: boolean }) {
  const reqs = new Map<number, string>()
  for (const l of stdinLines(file)) if (l.id !== undefined && l.method) reqs.set(l.id, l.method)
  const p = new CodexLineParser(o)
  if (o.interrupted) p.markInterrupted()
  const events: HubEvent[] = []
  const requests: ServerReq[] = []
  let done = 0
  for (const msg of stdoutLines(file)) {
    if (msg.method === undefined && msg.id !== undefined) {
      const m = reqs.get(msg.id)
      if (m === 'thread/start') p.setThreadId(msg.result.thread.id)
      if (m === 'turn/start') p.setCodexTurnId(msg.result.turn.id)
      continue
    }
    const r = p.feed(msg)
    events.push(...r.events)
    if (r.request) requests.push(r.request)
    if (r.done) done++
  }
  return { events, requests, done, parser: p }
}

const types = (es: HubEvent[]) => es.map((e) => (e.type === 'tool.call' ? `tool.call:${e.status}` : e.type))
const deltas = (es: HubEvent[]) => es.filter((e) => e.type === 'message.delta').map((e: any) => e.text).join('')

test('参数：-c model 覆盖默认模型，走 stdio app-server', () => {
  assert.deepEqual(codexArgs('gpt-5.5'), ['-c', 'model="gpt-5.5"', 'app-server'])
  assert.equal(codexDecision('allow'), 'accept')
  assert.equal(codexDecision('deny'), 'decline')
  assert.equal(codexDecision('allow_session'), 'acceptForSession')
})

test('one-turn（thread/start）：工具调用 + 增量文本', () => {
  const { events, done } = replay('codex/app-server-one-turn.ndjson', { turnId: 't1', prompt: 'p' })
  assert.equal(done, 1)
  assert.deepEqual(types(events), ['turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'message.delta', 'turn.done'])
  const call = events.find((e) => e.type === 'tool.call' && e.status === 'done') as any
  assert.equal(call.name, 'shell')
  assert.match(call.input.command, /echo hub-probe/)
  assert.equal(call.isError, false)
  const last = events.at(-1) as any
  assert.equal(last.status, 'success')
  assert.equal(last.resultText, '收到')
  assert.equal(last.turnId, 't1')
  assert.ok(last.usage.output > 0)
  assert.equal(deltas(events), '收到')
})

test('命令审批：解析出服务端请求并构造与录制一致的回执', () => {
  const file = 'codex/app-server-approval.ndjson'
  const { events, requests, parser } = replay(file, { turnId: 't2', prompt: 'p' })
  assert.equal(requests.length, 1)
  const a = parser.approvalOf(requests[0])!
  assert.equal(a.kind, 'command')
  assert.match(a.summary, /echo probe > \/tmp\/hub-approval-probe\.txt/)
  const recorded = stdinLines(file).find((l) => l.result?.decision)
  assert.deepEqual(buildServerResponse(requests[0], 'allow'), recorded)
  assert.deepEqual((buildServerResponse(requests[0], 'allow_session') as any).result, { decision: 'acceptForSession' })
  assert.equal((events.at(-1) as any).status, 'success')
})

test('fileChange 审批：请求不带路径，从 item/started 的 changes 取', () => {
  const file = 'codex/app-server-filechange-approval.ndjson'
  const { events, requests, parser } = replay(file, { turnId: 't3', prompt: 'p' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'item/fileChange/requestApproval')
  const a = parser.approvalOf(requests[0])!
  assert.equal(a.kind, 'file_write')
  assert.match(a.summary, /\/tmp\/hub-codex-fc\/hub-note\.txt/)
  assert.deepEqual(buildServerResponse(requests[0], 'deny'), { id: requests[0].id, result: { decision: 'decline' } })
  assert.deepEqual(types(events), ['turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'message.delta', 'turn.done'])
  assert.equal((events.find((e) => e.type === 'tool.call' && e.status === 'done') as any).name, 'apply_patch')
})

test('resume：忽略上一轮遗留的 tokenUsage 通知，usage 取本轮', () => {
  const file = 'codex/app-server-resume.ndjson'
  const threadId = '01a0ce9e-1be2-78f2-8100-58616cfd9785'
  const { events, done } = replay(file, { turnId: 't4', prompt: '只回复两个字：收到', threadId })
  assert.equal(done, 1)
  assert.deepEqual(types(events), ['turn.started', 'message.user', 'message.delta', 'turn.done'])
  for (const e of events) assert.equal((e as any).sessionId, `codex:${threadId}`)
  const last = events.at(-1) as any
  assert.equal(last.resultText, '收到')
  // 遗留通知是上一轮的累计 usage；本轮 last 的 output 很小
  const leftover = stdoutLines(file).find((l) => l.method === 'thread/tokenUsage/updated')
  assert.notEqual(leftover.params.turnId, stdoutLines(file).find((l) => l.method === 'turn/started').params.turn.id)
  assert.ok(last.usage.output < 50)
})

test('unarchive 后 resume：正常一轮', () => {
  const { events } = replay('codex/app-server-unarchive-resume.ndjson', { turnId: 't5', prompt: 'p', threadId: '01a0ce9a-f977-7191-b9df-34dc0dc28ed4' })
  assert.equal((events.at(-1) as any).status, 'success')
  assert.equal(deltas(events), '收到')
})

test('turn/interrupt：Hub 中断后 turn.done=interrupted，不发 error', () => {
  const { events, done } = replay('codex/app-server-interrupted.ndjson', { turnId: 't6', prompt: 'p', interrupted: true })
  assert.equal(done, 1)
  assert.ok(!events.some((e) => e.type === 'error'))
  assert.equal((events.at(-1) as any).status, 'interrupted')
  assert.ok(deltas(events).length > 0)
})

test('模型不可用：error 通知 + turn.done=error，只报一次错', () => {
  const { events } = replay('codex/app-server-model-unsupported.ndjson', { turnId: 't7', prompt: 'p', threadId: '01a0ce9f-2135-7840-95a4-c7e877ce85f0' })
  const errors = events.filter((e) => e.type === 'error') as any[]
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /gpt-5\.2/)
  assert.equal((events.at(-1) as any).status, 'error')
})

test('未知的服务端请求：回 JSON-RPC 错误', () => {
  const r = buildServerResponse({ id: 9, method: 'item/tool/requestUserInput', params: {} }) as any
  assert.equal(r.id, 9)
  assert.equal(r.error.code, -32601)
})

test('录制里没有私人上下文（AGENTS.md 全文）', () => {
  for (const f of ['app-server-resume.ndjson', 'app-server-interrupted.ndjson', 'rollout-sample.jsonl']) {
    const s = readFileSync(join(import.meta.dirname, '..', '..', 'recordings', 'codex', f), 'utf8')
    assert.ok(!s.includes('个人协作偏好'), f)
  }
})
