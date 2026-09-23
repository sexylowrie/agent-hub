import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CodexScanner, codexState, heldLockFiles, modelOverrideFor, parseRolloutTail, rolloutProgress } from '../../src/scanner/codex.ts'
import type { HubEvent } from '../../src/core/events.ts'
import { recordingPath } from '../helpers.ts'

const SAMPLE_ID = '01a0ce9e-1be2-78f2-8100-58616cfd9785'
const ABORT_ID = '01a0cf47-7705-7701-82f3-c809bdc6b112'
const lines = (rel: string) => readFileSync(recordingPath(rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

/** 假的 ~/.codex：threads 表（实测字段子集）+ 两份 rollout 样本 + 一条无文件线程 + 一条归档线程 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-codex-'))
  const sample = join(root, 'rollout-sample.jsonl')
  const aborted = join(root, 'rollout-interrupted.jsonl')
  copyFileSync(recordingPath('codex/rollout-sample.jsonl'), sample)
  copyFileSync(recordingPath('codex/rollout-interrupted.jsonl'), aborted)
  const old = new Date(Date.now() - 60_000)
  utimesSync(sample, old, old)
  utimesSync(aborted, old, old)
  const stateDb = join(root, 'state_5.sqlite')
  const db = new DatabaseSync(stateDb)
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT,
    archived INTEGER, archived_at INTEGER, first_user_message TEXT, model TEXT, updated_at_ms INTEGER, name TEXT, originator TEXT)`)
  const ins = db.prepare('INSERT INTO threads (id, rollout_path, updated_at, source, cwd, title, archived, first_user_message, model, updated_at_ms, name, originator) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  const now = Date.now()
  ins.run(SAMPLE_ID, sample, Math.floor(now / 1000), 'vscode', '/tmp', '', 0, '运行 echo hub-probe，然后只回复两个字：收到', 'gpt-5.5', now, null, 'Codex Desktop')
  ins.run(ABORT_ID, aborted, Math.floor(now / 1000), 'vscode', '/tmp', 'TCP 拥塞控制', 1, 'x', 'gpt-5.2', now - 1000, null, 'agent-hub')
  ins.run('chat-only', join(root, 'missing.jsonl'), Math.floor(now / 1000), 'vscode', '/x', '纯聊天', 0, 'hi', null, now - 2000, null, 'Codex Desktop')
  ins.run('ancient', sample, 1_000_000, 'cli', '/tmp', 'old', 0, 'old', null, 1_000_000_000, null, 'codex_exec')
  db.close()
  return { root, sample, aborted, stateDb }
}

const scanner = (stateDb: string, alive = true, extra: Partial<ConstructorParameters<typeof CodexScanner>[0]> = {}) =>
  new CodexScanner({ stateDb, recentDays: 30, quietMs: 5000, codexAlive: () => alive, locksDir: join(stateDb, '..', 'thread-writer-locks'), ...extra })

test('parseRolloutTail：task_complete / turn_aborted 收尾，取最后一条回复', () => {
  const t = parseRolloutTail(lines('codex/rollout-sample.jsonl'))
  assert.equal(t.openTurn, false)
  assert.equal(t.lastAgentText, '收到')
  const a = parseRolloutTail(lines('codex/rollout-interrupted.jsonl'))
  assert.equal(a.openTurn, false)
  // 截掉收尾行 → 未收尾
  const open = parseRolloutTail(lines('codex/rollout-sample.jsonl').slice(0, -1))
  assert.equal(open.openTurn, true)
})

test('codexState：近期写入 running；未收尾看有没有活的 codex 进程', () => {
  const now = 1_000_000
  const base = { now, quietMs: 5000, codexAlive: () => true }
  assert.equal(codexState({ ...base, openTurn: false, mtimeMs: now - 1000 }), 'running')
  assert.equal(codexState({ ...base, openTurn: false, mtimeMs: now - 60_000 }), 'idle')
  assert.equal(codexState({ ...base, openTurn: true, mtimeMs: now - 3_600_000 }), 'running')
  assert.equal(codexState({ ...base, openTurn: true, mtimeMs: now - 3_600_000, codexAlive: () => false }), 'idle')
})

test('scanAll：resumable 真假都有；标题回退 first_user_message；归档透传；recentDays 过滤', () => {
  const { stateDb } = fixture()
  const all = scanner(stateDb).scanAll()
  assert.deepEqual(all.map((v) => v.vendorSessionId).sort(), [ABORT_ID, SAMPLE_ID, 'chat-only'].sort())
  const s = all.find((v) => v.vendorSessionId === SAMPLE_ID)!
  assert.equal(s.resumable, true)
  assert.equal(s.state, 'idle')
  assert.equal(s.origin, 'desktop')
  assert.equal(s.title, '运行 echo hub-probe，然后只回复两个字：收到')
  assert.equal(s.lastMessagePreview, '收到')
  const chat = all.find((v) => v.vendorSessionId === 'chat-only')!
  assert.equal(chat.resumable, false)
  assert.match(chat.unresumableReason!, /无本地会话文件/)
  const a = all.find((v) => v.vendorSessionId === ABORT_ID)!
  assert.equal(a.archived, true)
  assert.equal(a.origin, 'hub')
})

test('未收尾的 rollout：有 codex 进程时 running，没有时 idle', () => {
  const { stateDb, sample } = fixture()
  appendFileSync(sample, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'x' } }) + '\n')
  const old = new Date(Date.now() - 60_000)
  utimesSync(sample, old, old)
  assert.equal(scanner(stateDb, true).refresh(SAMPLE_ID)!.state, 'running')
  assert.equal(scanner(stateDb, false).refresh(SAMPLE_ID)!.state, 'idle')
})

test('threadInfo：归档标记；线程模型不可用时才覆盖', () => {
  const { stateDb } = fixture()
  const s = scanner(stateDb)
  assert.equal(s.threadInfo(ABORT_ID, 'gpt-5.5')!.archived, true)
  assert.equal(modelOverrideFor('gpt-5.2', new Set(['gpt-5.5', 'gpt-6-astra']), 'gpt-5.5'), 'gpt-5.5')
  assert.equal(modelOverrideFor('gpt-6-astra', new Set(['gpt-5.5', 'gpt-6-astra']), 'gpt-5.5'), undefined)
  assert.equal(modelOverrideFor('gpt-5.2', undefined, 'gpt-5.5'), undefined) // 读不到可用列表时不动线程模型
  assert.equal(modelOverrideFor(null, new Set(['gpt-5.5']), 'gpt-5.5'), undefined)
})

test('rolloutProgress：两轮对话 → desktop 进度事件', () => {
  const turns = new Map<string, string>()
  const ev = rolloutProgress(lines('codex/rollout-sample.jsonl'), 'codex:x', turns)
  const t = ev.map((e) => (e.type === 'tool.call' ? `tool.call:${e.status}` : e.type))
  assert.deepEqual(t, [
    'turn.started', 'message.user', 'tool.call:started', 'tool.call:done', 'message.delta', 'turn.done',
    'turn.started', 'message.user', 'message.delta', 'turn.done',
  ])
  const users = ev.filter((e) => e.type === 'message.user').map((e: any) => e.text)
  assert.deepEqual(users, ['运行 echo hub-probe，然后只回复两个字：收到', '只回复两个字：收到'])
  const done = ev.find((e) => e.type === 'tool.call' && e.status === 'done') as any
  assert.equal(done.output, 'hub-probe\n')
  assert.equal(done.isError, false)
  const started = ev.find((e) => e.type === 'turn.started') as Extract<HubEvent, { type: 'turn.started' }>
  assert.equal(started.source, 'desktop')
  assert.ok(ev.filter((e) => e.type !== 'turn.started').every((e: any) => e.turnId?.startsWith('desktop:')))
  assert.equal(turns.size, 0)
})

test('rolloutProgress：turn_aborted → turn.done interrupted', () => {
  const ev = rolloutProgress(lines('codex/rollout-interrupted.jsonl'), 'codex:y', new Map())
  assert.equal((ev.at(-1) as any).status, 'interrupted')
})

test('readProgress：首次只记 offset，之后增量', () => {
  const { stateDb, sample } = fixture()
  const s = scanner(stateDb)
  s.scanAll()
  assert.deepEqual(s.readProgress(sample, 'codex:x'), [])
  const [, started, , , user] = lines('codex/rollout-sample.jsonl') // 0 是 session_meta
  appendFileSync(sample, JSON.stringify(started) + '\n' + JSON.stringify(user) + '\n')
  const ev = s.readProgress(sample, 'codex:x')
  assert.deepEqual(ev.map((e) => e.type), ['turn.started', 'message.user'])
  assert.equal(s.threadIdOf(sample), SAMPLE_ID)
})

test('写锁：GUI 打开着线程（锁文件被持有）→ running；残留但无人持有的锁文件不算', () => {
  const { root, stateDb } = fixture()
  const locks = join(root, 'thread-writer-locks')
  mkdirSync(locks)
  writeFileSync(join(locks, `${SAMPLE_ID}.lock`), '')
  writeFileSync(join(locks, '.coordination.lock'), '')
  const held = scanner(stateDb, true, { heldLocks: (fs) => new Set(fs) })
  assert.deepEqual([...held.lockedThreads()], [SAMPLE_ID])
  assert.equal(held.refresh(SAMPLE_ID)!.state, 'running')
  const stale = scanner(stateDb, true, { heldLocks: () => new Set() })
  assert.equal(stale.refresh(SAMPLE_ID)!.state, 'idle')
  assert.equal(codexState({ openTurn: false, mtimeMs: 0, now: 1e9, quietMs: 0, codexAlive: () => false, writerLocked: true }), 'running')
})

test('heldLockFiles：用 lsof 判断锁文件是否被进程打开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-locks-'))
  const a = join(dir, 'a.lock')
  const b = join(dir, 'b.lock')
  writeFileSync(a, '')
  writeFileSync(b, '')
  const fd = openSync(a, 'r')
  try {
    const held = heldLockFiles([a, b])
    // lsof 输出的是真实路径（/var → /private/var）
    assert.equal([...held].some((f) => f.endsWith('/a.lock')), true)
    assert.equal([...held].some((f) => f.endsWith('/b.lock')), false)
  } finally {
    closeSync(fd)
  }
  assert.equal(heldLockFiles([]).size, 0)
})
