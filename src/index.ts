// 库入口：嵌入方（如 dougan 门面）以 git 依赖引用 agent-hub 时从这里 import。
// 只做导出，不含任何副作用；独立运行的 CLI 入口是 main.ts。用法见 README「作为库使用」。

// 装配
export { startHub, DEFAULTS, type StartHubOpts, type HubRuntime } from './runtime.ts'

// Core：事件模型、存储、总线、会话与轮次调度
export {
  HubEvent,
  SessionView,
  SessionState,
  Vendor,
  Origin,
  Holder,
  ApprovalKind,
  Decision,
  sessionKey,
  type HubEventType,
  type HistoryItem,
} from './core/events.ts'
export { Store, type StoredEvent, type ApprovalRow, type DeviceRow, type PushSubscriptionRow } from './core/store.ts'
export { Bus, type Published } from './core/bus.ts'
export { Hub, type HubOpts, type AckResult, type PendingApprovalView } from './core/sessions.ts'

// Adapters
export type { AgentAdapter, RunOpts, ApprovalRequest } from './adapters/types.ts'
export { ClaudeAdapter } from './adapters/claude.ts'
export { CodexAdapter } from './adapters/codex.ts'
export { CursorAdapter } from './adapters/cursor.ts'

// Scanners（只读）
export { ClaudeScanner, type ClaudeScannerOpts } from './scanner/claude.ts'
export { CodexScanner, type CodexScannerOpts } from './scanner/codex.ts'
export { CursorScanner, type CursorScannerOpts } from './scanner/cursor.ts'
export { claudeSource, codexSource, cursorSource, type ScanSource } from './scanner/sources.ts'
export { watchDirs, every } from './scanner/watcher.ts'

// Gateway：REST / WS / 鉴权 / Web Push
export { createApp, attachWs, startGateway, type GatewayDeps, type WsOptions } from './gateway/server.ts'
export { ClientMessage, BROADCAST_TYPES, WS_CLOSE_UNAUTHORIZED } from './gateway/protocol.ts'
export { hashToken, pairDevice, createPairingCode, authenticate, bearer, PAIRING_TTL_MS } from './gateway/auth.ts'
export { WebPush, loadVapid, type Vapid, type PushMessage } from './gateway/push.ts'
export { attachPushNotifier } from './gateway/notify.ts'

// 配置工具
export { isCwdAllowed, expandHome, probeBinaries, type BinaryStatus } from './config.ts'
