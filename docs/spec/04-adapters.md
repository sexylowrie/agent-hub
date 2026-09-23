# 04 · Adapters

## 接口（src/adapters/types.ts）
```ts
interface RunOpts { force?: boolean; signal: AbortSignal; onApproval: (req: ApprovalRequest) => Promise<Decision> }
interface AgentAdapter {
  readonly vendor: Vendor
  readonly requiresCwd?: boolean   // 默认 true；false 时会话缺 cwd 也允许续聊（Cursor）
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
- 握手：`initialize {clientInfo:{name:"agent-hub"}, capabilities:{experimentalApi:true}}` → `initialized` 通知。
- `resume`：先经 `threadInfo`（Scanner 只读 threads 表）取 archived 与模型；archived 则 `thread/unarchive`；然后 `thread/resume {threadId, approvalPolicy:"on-request", sandbox, excludeTurns:true, model?}` → `turn/start`。
  - 线程模型不在 `models_cache.json` 可用列表里才带 `model`（会改写线程模型，见 01）。
  - resume 报 `is archived`（threadInfo 过期）时解档后重试一次。
  - 报 `already has an active writer`（GUI 打开着该线程）时本轮失败；正常情况下 Scanner 已判为 running，send 在 Core 就被拒。
- `start`：`thread/start {cwd, approvalPolicy:"on-request", sandbox}`，响应里拿新线程 id 后先产出 `session.upsert`。
- sandbox：默认 `read-only`，`force` 用 `workspace-write`。
- 本轮判定：只认 `turn/start` 响应里 `turn.id` 的通知（resume 后会先收到上一轮的 tokenUsage）。
- 事件：`turn/started`→turn.started+message.user；`item/agentMessage/delta`→message.delta（没有 delta 的 agentMessage 用 `item/completed` 整块）；`item/reasoning/*Delta`→thinking.delta；`item/started|completed{commandExecution|fileChange|mcpToolCall|dynamicToolCall}`→tool.call；`thread/tokenUsage/updated.last`→usage；`error{willRetry:false}`→error；`turn/completed`→turn.done（completed→success、interrupted→interrupted、failed→error）。
- 服务端请求（有 `id` 且有 `method`）一律回执：`item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 走 `onApproval`，回 `{id, result:{decision}}`，映射 allow→accept、deny→decline、allow_session→acceptForSession；其他请求回 JSON-RPC 错误 `-32601` 并产出 `error{recoverable:true}`。
- 文件审批的摘要从此前 `item/started{fileChange}.changes[].path` 取（请求本身不带路径）。
- 中断：`turn/interrupt {threadId, turnId}`，5 秒内没收到 `turn/completed` 就 SIGTERM；轮次还没开始时直接 SIGTERM。
- `turn/completed` 后关闭 stdin 让进程退出；2 秒未退出 SIGTERM。
- 类型从 `scripts/gen-codex-types.sh` 生成的 `codex.types.ts` 取，不手写（生成物是按根类型取的闭包目录 `codex.types/`）。

## Cursor（src/adapters/cursor.ts）
```
agent -p [--resume <composerId>] --output-format stream-json --stream-partial-output --trust [--sandbox enabled | --force] "<text>"
```
- 默认 `--sandbox enabled`；`force=true` 才 `--force`。UI 上 force 必须是显式开关。
- `--trust`：无头模式在未信任目录会直接退出（见 01）。
- `--stream-partial-output`：文本片段 → message.delta；随后的整块重复（等于累计片段）丢弃。
- 无审批。`tool_call.{xxxToolCall:{args,result}}` → `tool.call`（name 去掉 `ToolCall` 后缀，输出取 `result.success.interleavedOutput`）。
- `Connection stalled` 等瞬时错误：还没有模型输出时，同一轮内自动重试 1 次（start 的重试改为续接已拿到的 id）。
- 中断：SIGINT。Cursor 不输出 result、退出码 130，由进程退出兜底为 `turn.done{status:interrupted}`。
- `requiresCwd=false`：`agent --resume` 不依赖 cwd，推断不到工作区时在 home 下拉起。
- `start()` 不带 `--resume`，从 `system.init.session_id` 取 id；Scanner 会从 `~/.cursor/chats` 发现它。

## 测试
`test/adapters/*.test.ts`：用 `recordings/` 的 ndjson 喂给各 Adapter 的行解析器，断言产出的 HubEvent 序列（类型顺序 + 关键字段）。审批样本要断言能正确构造回执。
