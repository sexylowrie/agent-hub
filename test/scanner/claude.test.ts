import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeScanner, claudeState, historyItems, liveSessionIds, parseHead, parseTail, progressEvents } from '../../src/scanner/claude.ts'

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

test('有活 pid 一律 running，哪怕文件很久没写', () => {
  const { root } = fixture()
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: CLI_ID }))
  const [s] = scanner(root).scanAll()
  assert.equal(s.state, 'running')
  assert.equal(claudeState({ livePid: true, mtimeMs: 0, now: 1e13, quietMs: 3000 }), 'running')
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
