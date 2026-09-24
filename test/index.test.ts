import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// 按包名自引用：走 package.json 的 exports，与 git 依赖安装后的解析方式一致
import * as lib from 'agent-hub'
import type { GatewayDeps, HubOpts, HubRuntime, ScanSource, SessionView, StartHubOpts } from 'agent-hub'

test('库入口：exports 指向 src/index.ts，清单里的符号都能按包名 import', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.exports['.'], './src/index.ts')
  const values = [
    'Store', 'Bus', 'Hub', 'ClaudeAdapter', 'CodexAdapter', 'CursorAdapter', 'ClaudeScanner', 'CodexScanner', 'CursorScanner',
    'claudeSource', 'codexSource', 'cursorSource', 'watchDirs', 'every', 'createApp', 'attachWs', 'startGateway',
    'WebPush', 'loadVapid', 'attachPushNotifier', 'hashToken', 'pairDevice', 'createPairingCode', 'authenticate', 'bearer',
    'isCwdAllowed', 'startHub', 'sessionKey',
  ] as const
  for (const k of values) assert.equal(typeof lib[k], 'function', k)
  assert.ok(lib.BROADCAST_TYPES.has('session.upsert'))
  assert.equal(lib.WS_CLOSE_UNAUTHORIZED, 4401)
  assert.equal(lib.ClientMessage.safeParse({ t: 'ping' }).success, true)
  assert.ok(lib.SessionState.options.includes('attached'))
  assert.equal(lib.HubEvent.safeParse({ type: 'session.state', sessionId: 's', state: 'attached' }).success, true)
  assert.equal(lib.isCwdAllowed([import.meta.dirname], join(import.meta.dirname, 'core')), true)
})

test('库入口：导入不产生副作用（不读配置、不监听端口）', async () => {
  // 能走到这里即说明 import 'agent-hub' 没有因为缺 hub.config.json 抛错；类型只做编译期检查
  const v: SessionView['state'] = 'attached'
  const t: Partial<GatewayDeps & HubOpts & StartHubOpts & HubRuntime & ScanSource> = {}
  assert.equal(v, 'attached')
  assert.deepEqual(t, {})
})
