import { statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sessionKey, type HistoryItem, type HubEvent, type SessionView, type Vendor } from '../core/events.ts'
import type { ClaudeScanner } from './claude.ts'
import type { CodexScanner } from './codex.ts'
import type { CursorScanner } from './cursor.ts'

/** 一家厂商的扫描来源：main.ts 只按这个接口接线，厂商细节留在 scanner/* */
export interface ScanSource {
  readonly vendor: Vendor
  /** 首次全量扫描（并把已有文件的读取位置推到末尾，不回放历史） */
  init(): SessionView[]
  scanAll(): SessionView[]
  /** 续聊前按 vendorSessionId 实时复核 */
  refresh(vendorSessionId: string): SessionView | undefined
  /** 需要 fs.watch 的目录（递归） */
  watchDirs(): string[]
  /** 去抖时间，默认 300ms */
  watchDebounceMs?: number
  /** fs.watch 收不到事件的文件改用轮询：返回自上次调用以来 mtime/size 变化的文件 */
  pollFiles?(): string[]
  pollMs?: number
  /** 监听到变化：返回需要合并的会话与桌面端进度事件；later 为静默期后需要复查的会话 */
  onFiles(files: Set<string>): { views: SessionView[]; progress: HubEvent[]; later?: () => SessionView[] }
  /** Hub 轮次结束前：跳过本轮自己写入的文件内容 */
  beforeTurnEnd?(vendorSessionId: string): void
  history?(vendorSessionId: string, limit: number): HistoryItem[]
}

const defined = <T>(xs: (T | undefined)[]) => xs.filter((x): x is T => x !== undefined)

export function claudeSource(s: ClaudeScanner): ScanSource {
  return {
    vendor: 'claude',
    init() {
      const views = s.scanAll()
      for (const f of s.listFiles()) s.skipToEnd(f)
      return views
    },
    scanAll: () => s.scanAll(),
    refresh: (id) => s.refresh(id),
    watchDirs: () => [s.projectsDir, s.sessionsDir],
    onFiles(files) {
      let pidsChanged = false
      const views: SessionView[] = []
      const progress: HubEvent[] = []
      const changed: string[] = []
      for (const f of files) {
        if (f.startsWith(s.sessionsDir)) {
          pidsChanged = true
          continue
        }
        if (!f.endsWith('.jsonl') || f.includes('/subagents/')) continue
        const v = s.scanFile(f)
        if (!v) continue
        changed.push(f)
        views.push(v)
        progress.push(...s.readProgress(f, v.id))
      }
      return {
        views: pidsChanged ? s.scanAll() : views,
        progress,
        // 静默期过后再扫一次，让 running → idle 及时生效
        later: changed.length ? () => defined(changed.map((f) => s.scanFile(f))) : undefined,
      }
    },
    beforeTurnEnd(id) {
      const f = s.findFile(id)
      if (f) s.skipToEnd(f)
    },
  }
}

export function codexSource(s: CodexScanner, fallbackModel: string): ScanSource & { threadInfo: (id: string) => ReturnType<CodexScanner['threadInfo']> } {
  const sessionsDir = join(s.codexHome, 'sessions')
  const archivedDir = join(s.codexHome, 'archived_sessions')
  const dbName = basename(s.stateDb)
  const dbDir = dirname(s.stateDb)
  return {
    vendor: 'codex',
    threadInfo: (id) => s.threadInfo(id, fallbackModel),
    init() {
      const views = s.scanAll()
      for (const f of s.rolloutFiles()) s.skipToEnd(f)
      return views
    },
    scanAll: () => s.scanAll(),
    refresh: (id) => s.refresh(id),
    // 递归监听 ~/.codex（已含 sessions/ 与 archived_sessions/）；其下还有日志库等高频文件，onFiles 里过滤
    watchDirs: () => [dbDir],
    onFiles(files) {
      let dbChanged = false
      const ids = new Set<string>()
      const progress: HubEvent[] = []
      for (const f of files) {
        if (dirname(f) === dbDir && basename(f).startsWith(dbName)) {
          dbChanged = true
          continue
        }
        if (dirname(f) === s.locksDir && f.endsWith('.lock')) {
          // GUI 打开/切走线程：写锁出现/消失
          const id = basename(f, '.lock')
          if (!id.startsWith('.')) ids.add(id)
          continue
        }
        if (!f.endsWith('.jsonl') || !(f.startsWith(sessionsDir) || f.startsWith(archivedDir))) continue
        const id = s.threadIdOf(f)
        if (!id) {
          dbChanged = true // 新线程，等 threads 表
          continue
        }
        ids.add(id)
        progress.push(...s.readProgress(f, sessionKey('codex', id)))
      }
      const views = dbChanged ? s.scanAll() : defined([...ids].map((id) => s.refresh(id)))
      return { views, progress, later: ids.size ? () => defined([...ids].map((id) => s.refresh(id))) : undefined }
    },
    beforeTurnEnd(id) {
      const f = s.rolloutOf(id)
      if (f) s.skipToEnd(f)
    },
  }
}

export function cursorSource(s: CursorScanner): ScanSource {
  const globalDir = dirname(s.globalDb)
  const dbName = basename(s.globalDb)
  const sigs = new Map<string, string>()
  return {
    vendor: 'cursor',
    init: () => s.scanAll(),
    scanAll: () => s.scanAll(),
    refresh: (id) => s.refresh(id),
    // IDE 写 state.vscdb-wal 时 fs.watch（FSEvents）收不到事件（实测），IDE 侧改为轮询 stat；chats 仍用 fs.watch
    watchDirs: () => [s.chatsDir],
    watchDebounceMs: 1000,
    pollMs: 1500,
    pollFiles() {
      const changed: string[] = []
      for (const f of [s.globalDb, `${s.globalDb}-wal`]) {
        let sig = ''
        try {
          const st = statSync(f)
          sig = `${st.mtimeMs}:${st.size}`
        } catch {
          // 不存在
        }
        if (sigs.has(f) && sigs.get(f) !== sig) changed.push(f)
        sigs.set(f, sig)
      }
      return changed
    },
    onFiles(files) {
      const relevant = [...files].some(
        (f) => (dirname(f) === globalDir && basename(f).startsWith(dbName)) || (f.startsWith(s.chatsDir) && /(store\.db|meta\.json)/.test(f)),
      )
      // IDE 生成期间 WAL 高频变化；全量扫描约 70–100ms，轮询间隔 1.5s 即是节流
      return { views: relevant ? s.scanAll() : [], progress: [] }
    },
    history: (id, limit) => s.history(id, limit),
  }
}
