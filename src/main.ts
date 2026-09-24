import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { Store } from './core/store.ts'
import { createPairingCode } from './gateway/auth.ts'
import { startGateway } from './gateway/server.ts'
import { attachPushNotifier } from './gateway/notify.ts'
import { WebPush, loadVapid } from './gateway/push.ts'
import { KeepAwake } from './power.ts'
import { startHub } from './runtime.ts'

const VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
const WEB_ROOT = join(import.meta.dirname, '..', 'web', 'dist')

async function serve() {
  const cfg = loadConfig()
  const keepAwake = new KeepAwake(cfg.power.keepAwake)
  keepAwake.start()

  const rt = await startHub({
    dataDir: cfg.dataDir,
    binaries: cfg.binaries,
    codexModel: cfg.codex.model,
    allowedCwds: cfg.allowedCwds,
    scanner: cfg.scanner,
    approvalExpireSeconds: cfg.approval.expireSeconds,
    onBusyChange: (n) => keepAwake.onBusyChange(n),
  })
  const { hub, store, bus } = rt

  const push = new WebPush(store, loadVapid(cfg.dataDir), cfg.push.subject)
  const stopPush = attachPushNotifier(bus, store, push)

  const server = await startGateway(
    {
      allowedCwds: () => cfg.allowedCwds,
      store,
      bus,
      hub,
      version: VERSION,
      vendors: rt.vendors,
      history: rt.history,
      webRoot: WEB_ROOT,
      push,
    },
    cfg.listen,
  )
  if (!existsSync(join(WEB_ROOT, 'index.html'))) console.log(`[gateway] 未找到 PWA 构建产物 ${WEB_ROOT}，先 npm run web:build`)
  console.log(`[gateway] 监听 http://${cfg.listen.host}:${cfg.listen.port}  数据目录 ${cfg.dataDir}`)
  if (cfg.publicUrl) console.log(`[gateway] 手机访问 ${cfg.publicUrl}`)
  console.log(`[power] 防睡眠：${cfg.power.keepAwake}`)

  let closing = false
  const shutdown = (sig: string) => {
    if (closing) return
    closing = true
    console.log(`[hub] 收到 ${sig}，退出`)
    stopPush()
    keepAwake.release()
    server.close()
    void rt.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

function pair() {
  const cfg = loadConfig()
  const store = Store.open(cfg.dataDir)
  const { code, expiresAt } = createPairingCode(store)
  store.close()
  const host = `${cfg.listen.host}:${cfg.listen.port}`
  console.log(`配对码：${code}`)
  console.log(`有效期至：${new Date(expiresAt).toLocaleString()}（5 分钟，一次性）`)
  console.log(`agenthub://pair?host=${host}&code=${code}`)
  console.log(`浏览器打开：${cfg.publicUrl?.replace(/\/$/, '') ?? `http://${host}`}/#/pair?code=${code}`)
}

function devices(args: string[]) {
  const cfg = loadConfig()
  const store = Store.open(cfg.dataDir)
  try {
    const [sub = 'list', name] = args
    if (sub === 'list') {
      const list = store.listDevices()
      if (!list.length) return console.log('（无已配对设备）')
      for (const d of list) {
        const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '-'
        console.log(`${d.revoked ? '[已吊销] ' : ''}${d.name}\t${d.id}\t配对于 ${new Date(d.pairedAt).toLocaleString()}\t最近 ${seen}`)
      }
    } else if (sub === 'revoke') {
      if (!name) throw new Error('用法：npm run hub -- devices revoke <name|id>')
      const n = store.revokeDevice(name)
      console.log(n ? `已吊销 ${n} 台设备` : `没有找到未吊销的设备：${name}`)
      if (!n) process.exitCode = 1
    } else {
      throw new Error(`未知子命令 devices ${sub}；可用 list | revoke <name|id>`)
    }
  } finally {
    store.close()
  }
}

async function main() {
  const [cmd = 'serve', ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'serve':
      return serve()
    case 'pair':
      return pair()
    case 'devices':
      return devices(rest)
    default:
      throw new Error(`未知命令 ${cmd}；可用 serve | pair | devices`)
  }
}

main().catch((e) => {
  console.error(`[hub] ${(e as Error).message}`)
  process.exit(1)
})
