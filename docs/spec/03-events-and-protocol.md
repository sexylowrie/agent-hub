# 03 · 统一事件与客户端协议

## HubEvent（src/core/events.ts，用 zod 定义并导出类型）
```ts
type SessionState = 'idle' | 'running' | 'attached' | 'awaiting_approval' | 'error' | 'unknown'
// attached：有进程持有会话（终端 / 桌面 App 开着）但已安静；与 running 一样不可续聊，判定见 05-scanner.md
type Vendor = 'claude' | 'codex' | 'cursor'

type HubEvent =
  | { type: 'session.upsert';   session: SessionView }
  | { type: 'session.state';    sessionId: string; state: SessionState; reason?: string }
  | { type: 'turn.started';     sessionId; turnId; source: 'desktop' | 'hub' }
  | { type: 'message.user';     sessionId; turnId?; text }
  | { type: 'message.delta';    sessionId; turnId?; text }
  | { type: 'thinking.delta';   sessionId; turnId?; text }           // 可选展示
  | { type: 'tool.call';        sessionId; turnId?; callId; name; input: unknown; status: 'started' | 'done'; output?: string; isError?: boolean }
  | { type: 'approval.request'; sessionId; turnId?; approvalId; kind; summary; detail: unknown; expiresAt }
  | { type: 'approval.decided'; sessionId; approvalId; decision: 'allow' | 'deny' | 'allow_session'; by: string }
  | { type: 'turn.done';        sessionId; turnId?; status: 'success' | 'error' | 'interrupted'; resultText?; usage?: { input?: number; output?: number }; durationMs? }
  | { type: 'error';            sessionId?; message; recoverable: boolean }

interface SessionView {
  id; vendor; vendorSessionId; cwd; title; origin; state; resumable; unresumableReason?;
  archived; lastMessagePreview?; vendorUpdatedAt?; updatedAt;
  holder?: { kind: 'cli' | 'gui'; pid?: number; tmux?: { target: string } }   // 只在 state=attached 时出现
}
```

## 三家 → HubEvent 映射（以 recordings 为准）
| HubEvent | Claude stream-json | Codex app-server | Cursor stream-json |
|---|---|---|---|
| turn.started | 第一条 `system.init` | `turn/started` | `system.init` |
| message.user | `user`（非工具结果） | `item/started{type:userMessage}` | `user` |
| message.delta | `stream_event.content_block_delta(text_delta)`；无 partial 时用 `assistant` 整块 | `item/agentMessage/delta` | `assistant`（整块，Cursor 无文本增量） |
| thinking.delta | `stream_event...thinking_delta` | `item/reasoning/*`（若有） | `thinking.delta` |
| tool.call started | `assistant` 中 `tool_use` 块 | `item/started{type:commandExecution\|fileChange\|mcpToolCall}` | `tool_call.started` |
| tool.call done | `user` 中 `tool_result` 块 | `item/completed` 同类型 | `tool_call.completed` |
| approval.request | `control_request{can_use_tool}` | `item/*/requestApproval`（带 id 的请求） | 无 |
| turn.done | `result` | `turn/completed{turn.status}` | `result` |
| error | `result.is_error` / 进程非 0 退出 | `error` 通知 / `turn.status=failed` | `result.is_error` / 非 0 退出 |

## WebSocket 协议（/ws）
```ts
// 客户端 → Hub
{ t: 'hello', token: string, sinceSeq?: number }
{ t: 'subscribe', sessionId }          // 收该会话的全部事件；不订阅只收 session.upsert/state
{ t: 'unsubscribe', sessionId }
{ t: 'send', reqId, sessionId, text, force?: boolean }
{ t: 'start', reqId, vendor, cwd, text }
{ t: 'approve', reqId, approvalId, decision: 'allow' | 'deny' | 'allow_session' }
{ t: 'interrupt', reqId, sessionId }
{ t: 'ping' }

// Hub → 客户端
{ t: 'snapshot', sessions: SessionView[], seq: number }   // hello 后立刻
{ t: 'event', seq, event: HubEvent }
{ t: 'ack', reqId, ok: true, data?: unknown }
{ t: 'ack', reqId, ok: false, code, message, holder? }     // 如 SESSION_BUSY / ATTACHED / NOT_RESUMABLE / CWD_NOT_ALLOWED
{ t: 'pong' }
```
- hello 校验失败直接关闭连接，code 4401。
- `send` 对 `attached` 会话返回 `code:'ATTACHED'` 并带 `holder`（谁开着这条会话）；对 `running` 等其余非空闲状态仍是 `SESSION_BUSY`。
- `sinceSeq` 存在时，snapshot 之后按序补发 `events`（只补该设备订阅过的会话 + 全部 approval.*）。

## REST
```
POST /api/pair                 { code, deviceName } → { token, deviceId }
GET  /api/health               → { ok, version, vendors: {claude:{bin,version,ok}, ...} }
GET  /api/sessions             ?vendor=&state=&limit=&offset=   → SessionView[]
GET  /api/sessions/:id         ?messages=50  → SessionView + 最近 200 条 events + pendingApprovals + messages?（厂商历史：Claude jsonl / Codex rollout / Cursor IDE 消息 + CLI 续聊）
GET  /api/sessions/:id/events  ?sinceSeq=&limit=
```
`pendingApprovals` 元素：`{ id, kind, summary, expiresAt }`（pending 且未过期）。
其余路径由 Hub 托管 `web/dist`（无扩展名回落 `index.html`，`/assets/*` 长缓存）。
`start` 在拿到真实会话 id 之前失败时，事件的 sessionId 为 `pending:<turnId>`，只发给发起 start 的连接。
`messages` 元素：`{ role: 'user'|'assistant'|'tool', text, toolName?, at?, source: 'desktop'|'cli' }`（`HistoryItem`，不进 events 表）。
除 `/api/pair` 与 `/api/health` 外都需 `Authorization: Bearer <token>`。
