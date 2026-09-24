import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { isCwdAllowed, probeBinaries, type BinaryStatus } from './config.ts'
import { Bus } from './core/bus.ts'
import { sessionKey, type HistoryItem, type SessionView, type Vendor } from './core/events.ts'
import { Hub } from './core/sessions.ts'
import { Store } from './core/store.ts'
import { ClaudeAdapter } from './adapters/claude.ts'
import { CodexAdapter } from './adapters/codex.ts'
import { CursorAdapter } from './adapters/cursor.ts'
import { ClaudeScanner, type ClaudeScannerOpts } from './scanner/claude.ts'
import { CodexScanner, type CodexScannerOpts } from './scanner/codex.ts'
import { CursorScanner, type CursorScannerOpts } from './scanner/cursor.ts'
import { claudeSource, codexSource, cursorSource, type ScanSource } from './scanner/sources.ts'
import { every, watchDirs } from './scanner/watcher.ts'

// 装配：Store / Bus / Hub / 三家 Scanner 监听与对账。不含 HTTP 监听、不读 hub.config.json，配置全部以参数传入；
// 独立运行的 main.ts 与嵌入方（如 dougan 门面）共用这一份。

export interface StartHubOpts {
  /** hub.sqlite 所在目录 */
  dataDir: string
  binaries: Record<Vendor, string>
  /** Codex 线程模型不可用时的回退模型 */
  codexModel: string
  /** 新建会话允许的 cwd 根目录；传函数时每次校验都重新取（配置热更新） */
  allowedCwds: readonly string[] | (() => readonly string[])
  scanner?: {
    /** 默认 30 */
    recentDays?: number
    /** 全量对账间隔，默认 60 */
    reconcileSeconds?: number
    /** 默认 claude 3000 / codex 5000 / cursor 0 */
    idleQuietMs?: Partial<Record<Vendor, number>>
    /** 默认 60000 */
    attachedQuietMs?: number
  }
  /** 审批超时（按拒绝处理），默认 300 */
  approvalExpireSeconds?: number
  /** 进行中的 Hub 轮次数变化 */
  onBusyChange?: (inFlight: number) => void
  log?: (msg: string) => void
  /** 覆盖各家 Scanner 的参数（测试或自定义存储位置用） */
  scannerOverrides?: { claude?: Partial<ClaudeScannerOpts>; codex?: Partial<CodexScannerOpts>; cursor?: Partial<CursorScannerOpts> }
}

export interface HubRuntime {
  hub: Hub
  store: Store
  bus: Bus
  sources: Record<Vendor, ScanSource>
  /** 三家二进制状态（启动时探测，之后随对账刷新） */
  vendors: () => Record<Vendor, BinaryStatus>
  /** 会话详情用的厂商历史，可直接作为 GatewayDeps.history */
  history: (s: SessionView, limit: number) => HistoryItem[] | undefined
  /** 停止监听、中断进行中的轮次、关闭数据库 */
  stop: () => Promise<void>
}

export const DEFAULTS = {
  recentDays: 30,
  reconcileSeconds: 60,
  idleQuietMs: { claude: 3000, codex: 5000, cursor: 0 } as Record<Vendor, number>,
  attachedQuietMs: 60_000,
  approvalExpireSeconds: 300,
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 对账时只结束确实是厂商 CLI 的进程（防 pid 被复用后误杀） */
function stopVendorProcess(binaries: Record<Vendor, string>, log: (m: string) => void) {
  const names = new Set(Object.values(binaries).map((b) => basename(b)))
  return (pid: number) => {
    let cmd = ''
    try {
      cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim()
    } catch {
      return
    }
    const argv0 = basename(cmd.split(/\s+/)[0] ?? '')
    const isVendor = names.has(argv0) || cmd.split(/\s+/).slice(0, 3).some((a) => names.has(basename(a)))
    if (!isVendor) return log(`对账：pid ${pid} 已不是厂商进程（${cmd.slice(0, 80)}），不动它`)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已退出
    }
  }
}

export async function startHub(o: StartHubOpts): Promise<HubRuntime> {
  const log = o.log ?? ((m) => console.log(`[hub] ${m}`))
  const recentDays = o.scanner?.recentDays ?? DEFAULTS.recentDays
  const reconcileSeconds = o.scanner?.reconcileSeconds ?? DEFAULTS.reconcileSeconds
  const idleQuietMs = { ...DEFAULTS.idleQuietMs, ...o.scanner?.idleQuietMs }
  const attachedQuietMs = o.scanner?.attachedQuietMs ?? DEFAULTS.attachedQuietMs
  const roots = typeof o.allowedCwds === 'function' ? o.allowedCwds : () => o.allowedCwds as readonly string[]

  const store = Store.open(o.dataDir)
  const bus = new Bus()

  let vendors: Record<Vendor, BinaryStatus> = await probeBinaries(o.binaries)
  for (const [v, s] of Object.entries(vendors)) {
    log(`${v}: ${s.ok ? `${s.bin} ${s.version}` : `不可用 ${s.bin} (${s.error})`}`)
  }

  let hub: Hub
  const isHub = (vendor: Vendor) => (id: string) => hub.isHubSession(sessionKey(vendor, id))
  const codex = codexSource(
    new CodexScanner({ recentDays, quietMs: idleQuietMs.codex, attachedQuietMs, isHubSession: isHub('codex'), ...o.scannerOverrides?.codex }),
    o.codexModel,
  )
  const sources: Record<Vendor, ScanSource> = {
    claude: claudeSource(
      new ClaudeScanner({ recentDays, quietMs: idleQuietMs.claude, attachedQuietMs, isHubSession: isHub('claude'), ...o.scannerOverrides?.claude }),
    ),
    codex,
    cursor: cursorSource(new CursorScanner({ recentDays, quietMs: idleQuietMs.cursor, isHubSession: isHub('cursor'), ...o.scannerOverrides?.cursor })),
  }

  hub = new Hub({
    store,
    bus,
    adapters: {
      claude: new ClaudeAdapter(o.binaries.claude),
      codex: new CodexAdapter({ bin: o.binaries.codex, model: o.codexModel, threadInfo: codex.threadInfo }),
      cursor: new CursorAdapter(o.binaries.cursor),
    },
    approvalExpireMs: (o.approvalExpireSeconds ?? DEFAULTS.approvalExpireSeconds) * 1000,
    isCwdAllowed: (cwd) => isCwdAllowed(roots(), cwd),
    refresh: (s: SessionView) => sources[s.vendor].refresh(s.vendorSessionId),
    beforeTurnEnd: (s) => sources[s.vendor].beforeTurnEnd?.(s.vendorSessionId),
    onBusyChange: o.onBusyChange,
    log,
  })

  hub.reconcileOrphans(pidAlive, stopVendorProcess(o.binaries, log))

  // 首次全量扫描；记录各文件 offset，之后只推增量
  const stops: (() => void)[] = []
  for (const src of Object.values(sources)) {
    const t0 = Date.now()
    const initial = src.init()
    hub.applyScan(initial)
    log(`scanner ${src.vendor}: ${initial.length} 个会话（${Date.now() - t0}ms）`)
    const quiet = idleQuietMs[src.vendor]
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
        log(`scanner ${src.vendor} 处理变更失败: ${(e as Error).message}`)
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
    every(reconcileSeconds * 1000, () => {
      for (const src of Object.values(sources)) hub.applyScan(src.scanAll())
      void probeBinaries(o.binaries).then((v) => (vendors = v))
    }),
  )

  let stopped: Promise<void> | undefined
  return {
    hub,
    store,
    bus,
    sources,
    vendors: () => vendors,
    history: (s, limit) => sources[s.vendor].history?.(s.vendorSessionId, limit),
    stop: () =>
      (stopped ??= (async () => {
        for (const stop of stops) stop()
        hub.abortAll()
        // 给被中断的轮次一点时间把收尾事件落库
        await new Promise((r) => setTimeout(r, 300))
        store.close()
      })()),
  }
}
