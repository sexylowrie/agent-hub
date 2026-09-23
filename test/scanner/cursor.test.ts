import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CursorScanner, chatMessageItems, composerState, readStoreDb, rootMessageIds } from '../../src/scanner/cursor.ts'
import { recordingPath, storeDbFromSample, vscdbFromSamples } from '../helpers.ts'

const IDE_ID = 'dc0a49f7-ea72-4ce8-bfad-10db22d991b0'
const CLI_ID = '782a8d20-bbae-4776-9cda-17cce05b3b92'
const DAY = 86_400_000
const sampleJson = (rel: string) => JSON.parse(readFileSync(recordingPath(rel), 'utf8'))

/** 假的 Cursor 环境：state.vscdb 放一个 IDE composer；~/.cursor/chats 放一个纯 CLI 会话 + 一个 IDE 会话的 CLI 续聊 */
function fixture(o: { patch?: (cd: any) => void; ideAlsoInChats?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-cursor-'))
  const globalDb = join(root, 'state.vscdb')
  vscdbFromSamples(['cursor/ide-composer-sample.json'], globalDb, o.patch)
  const chatsDir = join(root, 'chats')
  const cliDir = join(chatsDir, 'ws1', CLI_ID)
  mkdirSync(cliDir, { recursive: true })
  const sample = storeDbFromSample('cursor/store-db-sample.json', join(cliDir, 'store.db'))
  writeFileSync(join(cliDir, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: sample.meta.createdAt, updatedAtMs: 1790184354261, cwd: '/private/tmp' }))
  if (o.ideAlsoInChats) {
    const d = join(chatsDir, 'ws2', IDE_ID)
    mkdirSync(d, { recursive: true })
    storeDbFromSample('cursor/store-db-sample.json', join(d, 'store.db'))
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ updatedAtMs: 1790190000000, cwd: '/Users/dev/AiProject' }))
  }
  const old = new Date(1790184354261)
  utimesSync(join(cliDir, 'store.db'), old, old)
  const scanner = new CursorScanner({ globalDb, chatsDir, recentDays: 30, quietMs: 0, now: () => 1790190000000 + DAY })
  return { root, scanner }
}

test('rootMessageIds：根 blob 的 field 1 按顺序列出消息 blob', () => {
  const s = sampleJson('cursor/store-db-sample.json')
  const ids = rootMessageIds(Buffer.from(s.root.hex, 'hex'))
  assert.deepEqual(ids, s.messages.map((m: any) => m.id))
})

test('chatMessageItems：只取 <user_query> 里的真实输入，跳过注入上下文与 system', () => {
  const s = sampleJson('cursor/store-db-sample.json')
  const items = s.messages.flatMap((m: any) => chatMessageItems(m.json))
  const users = items.filter((i: any) => i.role === 'user').map((i: any) => i.text)
  assert.equal(users.length, 3)
  assert.equal(users[0], '只回复两个字：收到')
  assert.ok(users.every((t: string) => !t.includes('<')))
  assert.ok(items.some((i: any) => i.role === 'tool' && i.toolName === 'Shell'))
  assert.equal(items.at(-1).role, 'assistant')
})

test('readStoreDb：从 sqlite 读出与样本一致的消息', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-cursor-db-'))
  storeDbFromSample('cursor/store-db-sample.json', join(root, 'store.db'))
  const r = readStoreDb(join(root, 'store.db'))
  assert.equal(r.name, 'New Agent')
  assert.equal(r.items.filter((i) => i.role === 'user').length, 3)
})

test('composerState：生成中落库为 aborted（实测），IDE 在运行才算 running；generating 信号兜底', () => {
  const alive = () => true
  const dead = () => false
  assert.equal(composerState({ generating: 0, status: 'completed' }, alive), 'idle')
  assert.equal(composerState({ generating: 0, status: 'aborted' }, alive), 'running')
  assert.equal(composerState({ generating: 0, status: 'aborted' }, dead), 'idle')
  assert.equal(composerState({ generating: 1, status: 'completed' }, dead), 'running')
  assert.equal(composerState({ generating: 0, status: 'generating' }, dead), 'running')
})

test('scanAll：IDE composer（desktop，cwd 取 workspaceIdentifier）+ 纯 CLI 会话（cli，标题取首条输入）', () => {
  const { scanner } = fixture()
  const all = scanner.scanAll()
  assert.equal(all.length, 2)
  const ide = all.find((v) => v.vendorSessionId === IDE_ID)!
  assert.equal(ide.origin, 'desktop')
  assert.equal(ide.cwd, '/Users/dev/AiProject/demo-app')
  assert.equal(ide.title, 'General chat')
  assert.equal(ide.state, 'idle')
  assert.equal(ide.resumable, true)
  assert.equal(ide.lastMessagePreview, '你好，需要我帮你做什么？')
  const cli = all.find((v) => v.vendorSessionId === CLI_ID)!
  assert.equal(cli.origin, 'cli')
  assert.equal(cli.cwd, '/private/tmp')
  assert.equal(cli.title, '只回复两个字：收到')
  assert.match(cli.lastMessagePreview!, /hub-probe/)
})

test('IDE 正在生成：status=aborted 且 IDE 在运行 → running；IDE 未运行 → idle', () => {
  const patch = (cd: any) => (cd.status = 'aborted')
  const a = fixture({ patch })
  const alive = new CursorScanner({ globalDb: join(a.root, 'state.vscdb'), chatsDir: join(a.root, 'chats'), recentDays: 30, quietMs: 0, ideAlive: () => true, now: () => 1790190000000 + DAY })
  assert.equal(alive.refresh(IDE_ID)!.state, 'running')
  const dead = new CursorScanner({ globalDb: join(a.root, 'state.vscdb'), chatsDir: join(a.root, 'chats'), recentDays: 30, quietMs: 0, ideAlive: () => false, now: () => 1790190000000 + DAY })
  assert.equal(dead.refresh(IDE_ID)!.state, 'idle')
  const g = fixture({ patch: (cd) => (cd.generatingBubbleIds = ['b1']) })
  assert.equal(g.scanner.refresh(IDE_ID)!.state, 'running')
})

test('空草稿不列出；超出 recentDays 不列出', () => {
  const { scanner } = fixture({ patch: (cd) => (cd.fullConversationHeadersOnly = []) })
  assert.ok(!scanner.scanAll().some((v) => v.vendorSessionId === IDE_ID))
  const far = fixture()
  const s2 = new CursorScanner({ globalDb: join(far.root, 'state.vscdb'), chatsDir: join(far.root, 'chats'), recentDays: 1, quietMs: 0, now: () => 1790190000000 + 90 * DAY })
  assert.equal(s2.scanAll().length, 0)
})

test('history：IDE 消息在前，CLI 续聊消息接在后面；preview 取较新的一侧', () => {
  const { scanner } = fixture({ ideAlsoInChats: true })
  const h = scanner.history(IDE_ID)
  assert.deepEqual(h.slice(0, 2).map((i) => [i.role, i.text, i.source]), [
    ['user', 'hi', 'desktop'],
    ['assistant', '你好，需要我帮你做什么？', 'desktop'],
  ])
  assert.ok(h.slice(2).every((i) => i.source === 'cli'))
  assert.equal(h.filter((i) => i.source === 'cli' && i.role === 'user').length, 3)
  const v = scanner.refresh(IDE_ID)!
  assert.equal(v.origin, 'desktop')
  assert.match(v.lastMessagePreview!, /hub-probe/)
  assert.equal(scanner.history(IDE_ID, 3).length, 3)
})

test('只读：不存在的库不报错，返回空', () => {
  const s = new CursorScanner({ globalDb: '/nonexistent/state.vscdb', chatsDir: '/nonexistent', recentDays: 30, quietMs: 0 })
  assert.deepEqual(s.scanAll(), [])
  assert.equal(s.refresh(IDE_ID), undefined)
})
