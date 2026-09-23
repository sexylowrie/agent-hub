# 04 · Adapters

## 接口（src/adapters/types.ts）
```ts
interface RunOpts { force?: boolean; signal: AbortSignal; onApproval: (req: ApprovalRequest) => Promise<Decision> }
interface AgentAdapter {
  readonly vendor: Vendor
  resume(vendorSessionId: string, cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent>
  start(cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent>   // 需产出 session.upsert 带新 id
}
```
- 一次调用 = 一轮 = 一个子进程生命周期。`signal` abort 时先温和结束（Claude/Cursor: SIGINT；Codex: `turn/interrupt`）再 5 秒后 SIGKILL。
- 审批：Adapter 解析出请求后调用 `opts.onApproval`，Core 负责写 approvals 表、广播、等待客户端决定或超时，再把 Decision 返回给 Adapter 回执。
- 所有 stdout 行先 `JSON.parse`，失败的行作为 `error{recoverable:true}` 记录原文前 200 字，不中断。
- 子进程 `env` 继承当前用户环境；不注入任何 API key。

## Claude（src/adapters/claude.ts）
```
claude -p --resume <id> --input-format stream-json --output-format stream-json \
       --verbose --include-partial-messages --permission-prompt-tool stdio \
       --permission-mode default
```
- 通过 stdin 发 `{"type":"user","uuid":<随机 uuid>,"message":{"role":"user","content":text}}`，然后**保持 stdin 打开**直到收到**本轮**的 `result`，再关闭。
- 本轮判定：只认 `command_lifecycle{command_uuid=该 uuid, state:started}` 之后的输出与 `result`；之前的（resume 时的遗留轮次）一律丢弃。若 `result` 到达时从未见过任何 lifecycle，先扣住 5 秒，仍无 lifecycle 则视为旧版 CLI 放行。`completed/cancelled` 在没有 `result` 时兜底结束本轮。
- 关闭 stdin 后 3 秒未退出（后台任务会让进程一直挂着）→ SIGTERM，再 5 秒 SIGKILL。
- 由 Hub 发起中断（SIGINT）后的 `error_during_execution` 记为 `turn.done{status:interrupted}`，不发 `error`。
- `control_request.can_use_tool` → `onApproval`；回 `control_response`，allow 时带 `updatedInput: request.input`。
- `start()` 不带 `--resume`，从 `system.init.session_id` 取新 id。
- `--permission-mode` 默认 `default`；`force` 时用 `acceptEdits`，**不用** bypass。

## Codex（src/adapters/codex.ts）
```
<codexBin> -c model="<config.codex.model>" app-server        # stdio
```
- 握手：`initialize` → `initialized` 通知。
- `resume`: 先读 threads 表 archived；archived 则 `thread/unarchive`；然后 `thread/resume {threadId}` → `turn/start`。
- `start`: `thread/start {cwd, approvalPolicy:"on-request", sandbox: force ? "workspace-write" : "read-only"}`。
- 服务端请求（有 `id` 且有 `method`）一律视为需回执；目前已知 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`（后者按 schema）。回 `{id, result:{decision}}`，decision 映射：allow→accept、deny→decline、allow_session→acceptForSession。
- `turn/completed` 后发 `turn.done`，然后关闭 stdin 让进程退出；2 秒未退出 SIGTERM。
- 类型从 `scripts/gen-codex-types.sh` 生成的 `codex.types.ts` 取，不手写。

## Cursor（src/adapters/cursor.ts）
```
agent -p --resume <composerId> --output-format stream-json [--sandbox enabled | --force] "<text>"
```
- 默认 `--sandbox enabled`；`force=true` 才 `--force`。UI 上 force 必须是显式开关。
- 无审批。`tool_call` 事件直接转 `tool.call`。
- `Connection stalled` 等瞬时错误：同一轮内自动重试 1 次。
- `start()` 不带 `--resume`，从 `result.session_id` 取 id；注意此时 Scanner 需从 `~/.cursor/chats` 发现它。

## 测试
`test/adapters/*.test.ts`：用 `recordings/` 的 ndjson 喂给各 Adapter 的行解析器，断言产出的 HubEvent 序列（类型顺序 + 关键字段）。审批样本要断言能正确构造回执。
