import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeScanner, claudeState, historyItems, liveSessionIds, liveSessions, parseHead, parseTail, progressEvents } from '../../src/scanner/claude.ts'

const REC = join(import.meta.dirname, '..', '..', 'recordings', 'claude')
const CLI_ID = '68fea937-1dcd-4ca5-8a75-3d21e410b32e'
const SDK_ID = 'f2301e94-69c5-4852-b821-0a015e847cb6'
const lines = (f: string) => readFileSync(join(REC, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

/** 搭一个假的 ~/.claude：projects 下放两份样本 + 一个 subagents 文件 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-claude-'))
  const proj = join(root, 'projects', '-Users-dev-AiProject-agent-hub')
  mkdirSync(join(proj, CLI_ID, 'subagents'), { recursive: true })
  mkdirSync(join(root, 'projects', '-private-tmp'), { recursive: true })
  mkdirSync(join(root, 'sessions'))
  copyFileSync(join(REC, 'session-cli-sample.jsonl'), join(proj, `${CLI_ID}.jsonl`))
  copyFileSync(join(REC, 'session-cli-sample.jsonl'), join(proj, CLI_ID, 'subagents', 'agent-x.jsonl'))
  copyFileSync(join(REC, 'session-sdk-cli-sample.jsonl'), join(root, 'projects', '-private-tmp', `${SDK_ID}.jsonl`))
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(proj, `${CLI_ID}.jsonl`), old, old)
  utimesSync(join(root, 'projects', '-private-tmp', `${SDK_ID}.jsonl`), old, old)
  return { root, proj, cliFile: join(proj, `${CLI_ID}.jsonl`) }
}

const scanner = (root: string, extra: Partial<ConstructorParameters<typeof ClaudeScanner>[0]> = {}) =>
  new ClaudeScanner({
    projectsDir: join(root, 'projects'),
    sessionsDir: join(root, 'sessions'),
    recentDays: 30,
    quietMs: 3000,
    ...extra,
  })

test('parseHead：跳过 meta 与命令包装，取首条真实输入', () => {
  const h = parseHead(lines('session-cli-sample.jsonl'))
  assert.equal(h.entrypoint, 'cli')
  assert.equal(h.sessionId, CLI_ID)
  assert.equal(h.cwd, '/Users/dev/AiProject/agent-hub')
  assert.match(h.firstUserText!, /^读完 CLAUDE\.md/)
})

test('parseTail：ai-title 与最后一条 assistant 文本', () => {
  const t = parseTail(lines('session-cli-sample.jsonl'))
  assert.equal(t.aiTitle, 'M0 范围与验收确认')
  assert.ok(t.lastAssistantText && t.lastAssistantText.length > 0)
})

test('scanAll：过滤 sdk-cli 与 subagents，空闲会话 idle', () => {
  const { root } = fixture()
  const list = scanner(root).scanAll()
  assert.equal(list.length, 1)
  const s = list[0]
  assert.equal(s.id, `claude:${CLI_ID}`)
  assert.equal(s.origin, 'cli')
  assert.equal(s.title, 'M0 范围与验收确认')
  assert.equal(s.state, 'idle')
  assert.equal(s.resumable, true)
})

test('Hub 登记的会话即使是 sdk-cli 也纳入，origin=hub', () => {
  const { root } = fixture()
  const list = scanner(root, { isHubSession: (id) => id === SDK_ID }).scanAll()
  const hub = list.find((s) => s.vendorSessionId === SDK_ID)
  assert.equal(hub?.origin, 'hub')
})

test('parseTail：最后一条人类输入之后有 turn_duration 才算收尾', () => {
  const all = lines('session-cli-sample.jsonl')
  // 样本在第二轮中途截断（第 25 行是新的人类输入）
  assert.equal(parseTail(all).turnOpen, true)
  const done = all.findLastIndex((o) => o.type === 'system' && o.subtype === 'turn_duration')
  assert.equal(parseTail(all.slice(0, done + 1)).turnOpen, false)
  // 尾部块里既没有输入也没有收尾：按未收尾算
  assert.equal(parseTail(all.filter((o) => o.type === 'assistant')).turnOpen, true)
  // 中断标记也算收尾
  assert.equal(parseTail([...all, { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]).turnOpen, false)
})

test('有活 pid、最后一轮未收尾：running，哪怕文件很久没写', () => {
  const { root } = fixture()
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLI_ID }))
  const [s] = scanner(root, { attachedQuietMs: 1000 }).scanAll()
  assert.equal(s.state, 'running')
  assert.equal(s.holder, undefined)
  assert.equal(claudeState({ livePid: true, mtimeMs: 0, now: 1e13, quietMs: 3000 }), 'running')
  assert.equal(claudeState({ livePid: true, mtimeMs: 0, now: 1e13, quietMs: 3000, attachedQuietMs: 1000, turnOpen: true }), 'running')
})

/** 把样本截到第一轮收尾（turn_duration），模拟"终端开着、已答完、在等输入" */
function closedTurnFixture(ageMs: number, registry: Record<string, unknown> = {}) {
  const f = fixture()
  const all = readFileSync(f.cliFile, 'utf8').split('\n').filter(Boolean)
  const done = all.findLastIndex((l) => JSON.parse(l).subtype === 'turn_duration')
  writeFileSync(f.cliFile, all.slice(0, done + 1).join('\n') + '\n')
  const t = new Date(Date.now() - ageMs)
  utimesSync(f.cliFile, t, t)
  writeFileSync(join(f.root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLI_ID, ...registry }))
  return f
}

test('有活 pid、最后一轮已收尾、静默超过 attachedQuietMs → attached，holder 带 pid 与 tmux pane', () => {
  const { root } = closedTurnFixture(10 * 60_000, { entrypoint: 'cli' })
  const [s] = scanner(root, { tmuxTarget: (pid) => (pid === process.pid ? 'dev:1.0' : undefined) }).scanAll()
  assert.equal(s.state, 'attached')
  assert.deepEqual(s.holder, { kind: 'cli', pid: process.pid, tmux: { target: 'dev:1.0' } })
  const [plain] = scanner(root, { tmuxTarget: () => undefined }).scanAll()
  assert.deepEqual(plain.holder, { kind: 'cli', pid: process.pid })
})

test('attached 的持有者是 Claude Desktop → kind=gui，不查 tmux', () => {
  const { root } = closedTurnFixture(10 * 60_000, { entrypoint: 'claude-desktop' })
  const [s] = scanner(root, { tmuxTarget: () => assert.fail('不该查 tmux') }).scanAll()
  assert.equal(s.state, 'attached')
  assert.deepEqual(s.holder, { kind: 'gui', pid: process.pid })
  assert.deepEqual([...liveSessions(join(root, 'sessions'))], [[CLI_ID, { pid: process.pid, entrypoint: 'claude-desktop' }]])
})

test('已收尾但静默未超过 attachedQuietMs（默认 60s）→ running', () => {
  const { root } = closedTurnFixture(5_000)
  const [s] = scanner(root, { tmuxTarget: () => undefined }).scanAll()
  assert.equal(s.state, 'running')
})

test('死 pid 不算；刚写入未静默的算 running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sess-'))
  writeFileSync(join(dir, '99999999.json'), JSON.stringify({ pid: 99999999, sessionId: 'dead' }))
  assert.equal(liveSessionIds(dir).has('dead'), false)
  assert.equal(claudeState({ livePid: false, mtimeMs: 1000, now: 2000, quietMs: 3000 }), 'running')
  assert.equal(claudeState({ livePid: false, mtimeMs: 1000, now: 5000, quietMs: 3000 }), 'idle')
})

test('readProgress：首次只记 offset，之后增量产出桌面端事件', () => {
  const { root, cliFile } = fixture()
  const sc = scanner(root)
  assert.deepEqual(sc.readProgress(cliFile, 's'), [])
  const src = lines('session-cli-sample.jsonl')
  appendFileSync(cliFile, src.map((o) => JSON.stringify(o)).join('\n') + '\n')
  const evs = sc.readProgress(cliFile, 's')
  const types = evs.map((e) => e.type)
  assert.equal(types[0], 'turn.started')
  assert.equal(types[1], 'message.user')
  assert.ok(types.includes('message.delta'))
  assert.ok(types.includes('tool.call'))
  assert.ok(types.includes('turn.done'))
  assert.ok(evs.every((e) => e.type !== 'turn.started' || e.source === 'desktop'))
  assert.deepEqual(sc.readProgress(cliFile, 's'), [])
})

test('progressEvents：真实输入开启桌面端轮次', () => {
  const evs = progressEvents(lines('session-sdk-cli-sample.jsonl'), 's', new Map())
  assert.deepEqual(evs.slice(0, 2).map((e) => e.type), ['turn.started', 'message.user'])
})

test('historyItems / history：人类输入、assistant 文本、工具调用，取最后 limit 条', () => {
  const items = historyItems(lines('session-cli-sample.jsonl'))
  assert.ok(items.length > 2)
  assert.equal(items[0].role, 'user')
  assert.match(items[0].text, /^读完 CLAUDE\.md/)
  assert.ok(items.some((i) => i.role === 'assistant'))
  assert.ok(items.some((i) => i.role === 'tool' && i.toolName))
  assert.ok(items.every((i) => i.source === 'cli' && !i.text.startsWith('<')))
  const { root } = fixture()
  const h = scanner(root).history(CLI_ID, 3)
  assert.equal(h.length, 3)
  assert.deepEqual(h, items.slice(-3))
  assert.deepEqual(scanner(root).history('no-such-id'), [])
})
