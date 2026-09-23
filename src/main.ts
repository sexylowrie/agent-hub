import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, isCwdAllowed, probeBinaries, type BinaryStatus } from './config.ts'
import { Bus } from './core/bus.ts'
import { sessionKey, type SessionView, type Vendor } from './core/events.ts'
import { Hub } from './core/sessions.ts'
import { Store } from './core/store.ts'
import { ClaudeAdapter } from './adapters/claude.ts'
import { CodexAdapter } from './adapters/codex.ts'
import { CursorAdapter } from './adapters/cursor.ts'
import { ClaudeScanner } from './scanner/claude.ts'
import { CodexScanner } from './scanner/codex.ts'
import { CursorScanner } from './scanner/cursor.ts'
import { claudeSource, codexSource, cursorSource, type ScanSource } from './scanner/sources.ts'
import { every, watchDirs } from './scanner/watcher.ts'
import { createPairingCode } from './gateway/auth.ts'
import { startGateway } from './gateway/server.ts'

const VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function serve() {
  const cfg = loadConfig()
  const store = Store.open(cfg.dataDir)
  const bus = new Bus()

  let vendors: Record<Vendor, BinaryStatus> = await probeBinaries(cfg)
  for (const [v, s] of Object.entries(vendors)) {
    console.log(`[config] ${v}: ${s.ok ? `${s.bin} ${s.version}` : `不可用 ${s.bin} (${s.error})`}`)
  }

  let hub: Hub
  const isHub = (vendor: Vendor) => (id: string) => hub.isHubSession(sessionKey(vendor, id))
  const codex = codexSource(
    new CodexScanner({ recentDays: cfg.scanner.recentDays, quietMs: cfg.scanner.idleQuietMs.codex, isHubSession: isHub('codex') }),
    cfg.codex.model,
  )
  const sources: Record<Vendor, ScanSource> = {
    claude: claudeSource(new ClaudeScanner({ recentDays: cfg.scanner.recentDays, quietMs: cfg.scanner.idleQuietMs.claude, isHubSession: isHub('claude') })),
    codex,
    cursor: cursorSource(new CursorScanner({ recentDays: cfg.scanner.recentDays, quietMs: cfg.scanner.idleQuietMs.cursor, isHubSession: isHub('cursor') })),
  }

  hub = new Hub({
    store,
    bus,
    adapters: {
      claude: new ClaudeAdapter(cfg.binaries.claude),
      codex: new CodexAdapter({ bin: cfg.binaries.codex, model: cfg.codex.model, threadInfo: codex.threadInfo }),
      cursor: new CursorAdapter(cfg.binaries.cursor),
    },
    approvalExpireMs: cfg.approval.expireSeconds * 1000,
    isCwdAllowed: (cwd) => isCwdAllowed(cfg, cwd),
    refresh: (s: SessionView) => sources[s.vendor].refresh(s.vendorSessionId),
    beforeTurnEnd: (s) => sources[s.vendor].beforeTurnEnd?.(s.vendorSessionId),
  })

  hub.reconcileOrphans(pidAlive)

  // 首次全量扫描；记录各文件 offset，之后只推增量
  const stops: (() => void)[] = []
  for (const src of Object.values(sources)) {
    const t0 = Date.now()
    const initial = src.init()
    hub.applyScan(initial)
    console.log(`[scanner] ${src.vendor}: ${initial.length} 个会话（${Date.now() - t0}ms）`)
    const quiet = cfg.scanner.idleQuietMs[src.vendor]
    const onFiles = (files: Set<string>) => {
      try {
        const r = src.onFiles(files)
        hub.ingestProgress(r.progress)
        if (r.views.length) hub.applyScan(r.views)
        if (r.later) {
          const later = r.later
          const t = setTimeout(() => hub.applyScan(later()), quiet + 200)
          t.unref()
        }
      } catch (e) {
        console.error(`[scanner] ${src.vendor} 处理变更失败: ${(e as Error).message}`)
      }
    }
    stops.push(watchDirs(src.watchDirs(), onFiles, src.watchDebounceMs))
    if (src.pollFiles) {
      const poll = src.pollFiles.bind(src)
      poll() // 记下初始签名
      stops.push(
        every(src.pollMs ?? 1000, () => {
          const files = poll()
          if (files.length) onFiles(new Set(files))
        }),
      )
    }
  }
  stops.push(
    every(cfg.scanner.reconcileSeconds * 1000, () => {
      for (const src of Object.values(sources)) hub.applyScan(src.scanAll())
      void probeBinaries(cfg).then((v) => (vendors = v))
    }),
  )

  const server = await startGateway({
    cfg,
    store,
    bus,
    hub,
    version: VERSION,
    vendors: () => vendors,
    history: (s, limit) => sources[s.vendor].history?.(s.vendorSessionId, limit),
  })
  console.log(`[gateway] 监听 http://${cfg.listen.host}:${cfg.listen.port}  数据目录 ${cfg.dataDir}`)

  let closing = false
  const shutdown = (sig: string) => {
    if (closing) return
    closing = true
    console.log(`[hub] 收到 ${sig}，退出`)
    for (const stop of stops) stop()
    hub.abortAll()
    server.close()
    setTimeout(() => {
      store.close()
      process.exit(0)
    }, 300).unref()
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
