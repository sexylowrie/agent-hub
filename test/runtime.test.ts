import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCwdAllowed } from '../src/config.ts'
import { startHub } from '../src/runtime.ts'
import { recordingPath } from './helpers.ts'

const CLI_ID = '68fea937-1dcd-4ca5-8a75-3d21e410b32e'

/** 三家存储全部指到临时目录，二进制指到不存在的路径：不碰本机真实数据 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-rt-')))
  const dirs = {
    data: join(root, 'data'),
    projects: join(root, 'claude', 'projects'),
    sessions: join(root, 'claude', 'sessions'),
    codex: join(root, 'codex'),
    chats: join(root, 'cursor', 'chats'),
    work: join(root, 'work'),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  mkdirSync(join(dirs.projects, '-Users-dev-demo'))
  copyFileSync(recordingPath('claude/session-cli-sample.jsonl'), join(dirs.projects, '-Users-dev-demo', `${CLI_ID}.jsonl`))
  return { root, dirs }
}

test('startHub：不监听 HTTP、配置全走参数；装配 Scanner 首扫、监听增量、cwd 白名单可热更新、stop 收尾', async () => {
  const { root, dirs } = fixture()
  let roots = [dirs.work]
  const rt = await startHub({
    dataDir: dirs.data,
    binaries: { claude: join(root, 'no-claude'), codex: join(root, 'no-codex'), cursor: join(root, 'no-agent') },
    codexModel: 'gpt-5.5',
    allowedCwds: () => roots,
    scanner: { reconcileSeconds: 3600 },
    log: () => {},
    scannerOverrides: {
      claude: { projectsDir: dirs.projects, sessionsDir: dirs.sessions },
      codex: { stateDb: join(dirs.codex, 'state_5.sqlite'), locksDir: join(dirs.codex, 'locks'), codexAlive: () => false },
      cursor: { globalDb: join(root, 'cursor', 'state.vscdb'), chatsDir: dirs.chats, ideAlive: () => false },
    },
  })
  try {
    // 首扫：样本会话入库
    const list = rt.store.listSessions()
    assert.deepEqual(list.map((s) => s.id), [`claude:${CLI_ID}`])
    assert.equal(rt.sources.claude.vendor, 'claude')
    // 二进制不可用如实报告
    assert.equal(rt.vendors().claude.ok, false)
    assert.equal(typeof rt.history(list[0], 5)?.length, 'number')

    // 监听：新会话文件出现 → session.upsert
    const upserts: string[] = []
    const off = rt.bus.on((p) => p.event.type === 'session.upsert' && upserts.push(p.event.session.id))
    const other = '11111111-2222-4333-8444-555555555555'
    const file = join(dirs.projects, '-Users-dev-demo', `${other}.jsonl`)
    copyFileSync(recordingPath('claude/session-cli-sample.jsonl'), file)
    // FSEvents 刚开始监听时偶尔丢首个事件：每 500ms 再 touch 一次
    const t0 = Date.now()
    while (!upserts.length && Date.now() - t0 < 10_000) {
      await new Promise((r) => setTimeout(r, 500))
      if (!upserts.length) utimesSync(file, new Date(), new Date())
    }
    off()
    // 样本首行 sessionId 是 CLI_ID，复制出的文件在 Scanner 眼里仍是同一会话（按文件内 sessionId 归并）
    assert.ok(upserts.includes(`claude:${CLI_ID}`))

    // cwd 白名单：函数形式每次重新取
    assert.equal((rt.hub.start('claude', '/etc', 'x') as any).code, 'CWD_NOT_ALLOWED')
    roots = [join(root, 'elsewhere')]
    assert.equal((rt.hub.start('claude', dirs.work, 'x') as any).code, 'CWD_NOT_ALLOWED')
  } finally {
    await rt.stop()
    await rt.stop() // 幂等
  }
  assert.throws(() => rt.store.listSessions())
})

test('isCwdAllowed：接受 roots 数组，按真实路径比较（.. 与软链逃逸不算）', () => {
  const { dirs } = fixture()
  mkdirSync(join(dirs.work, 'a'))
  assert.equal(isCwdAllowed([dirs.work], join(dirs.work, 'a')), true)
  assert.equal(isCwdAllowed([dirs.work], dirs.work), true)
  assert.equal(isCwdAllowed([dirs.work], join(dirs.work, 'a', '..', '..')), false)
  assert.equal(isCwdAllowed([dirs.work], `${dirs.work}-evil`), false)
  assert.equal(isCwdAllowed([], dirs.work), false)
  assert.equal(isCwdAllowed(['~'], join(dirs.work, 'missing')), false)
})
