# 05 · Scanner（只读）

## 通用
- `watcher.ts`：对各家目录/文件用 `fs.watch`（递归，macOS 支持），事件去抖 300ms；fs.watch 收不到事件的文件（Cursor 的 state.vscdb-wal）改为轮询 stat；另每 `reconcileSeconds` 全量对账一次。
- 首次启动只纳入 `vendorUpdatedAt` 在 `recentDays` 内的会话；更早的按需分页。
- 输出：`session.upsert`、`session.state`，以及桌面端运行中的进度事件（`message.delta`/`tool.call`/`turn.done`，source=desktop）。
- **空闲判定**是续聊互斥的依据，宁可误判为 running。

## Claude（scanner/claude.ts）
- 遍历 `~/.claude/projects/*/*.jsonl`，跳过 `*/subagents/*`。
- 读首个 `type:user` 行取 `entrypoint/cwd/sessionId`；`entrypoint==='sdk-cli'` 跳过；`isSidechain` 行跳过。
- preview：最后一条 assistant 文本。
- 进度：记录每个文件的已读 offset，增量解析新行；`assistant` → message.delta，`tool_use/tool_result` → tool.call。
- 空闲：`~/.claude/sessions/*.json` 里**没有**该 sessionId 的活 pid，且最后写入距今 > `idleQuietMs.claude`。会话 jsonl 没有 `result` 行，不能靠它判断。
- **只要有活 pid 就一律不可续聊**，哪怕文件很久没写：这意味着终端或 Desktop 还开着这个会话，手机再 `--resume` 会两个进程写同一个 jsonl。不读 `messagingSocketPath`、`status`、`notify_idle` 等未文档化字段。
- 有活 pid 时细分 `attached` 与 `running`（两者都不可续聊，只是文案与上层可选动作不同），宁可误判为 running：
  - `attached`：最后一轮**已收尾**（尾部块里最后一条人类输入之后有 `system/turn_duration` 或 `[Request interrupted` 标记）**且**文件静默 > `attachedQuietMs`（默认 60s）。
  - 其余（最近有写入、最后一轮未收尾、尾部块里找不到输入与收尾标记）→ `running`。未收尾这一条防的是长时间工具调用期间文件不写、被误判为空闲。
  - `holder`：登记文件 `entrypoint==='claude-desktop'`（没有则看会话首行）→ `{kind:'gui', pid}`；否则 `{kind:'cli', pid}`，并查 tmux：`tmux list-panes -a` 里 `pane_pid` 是该 pid 的祖先、且 `pane_current_command ∈ {claude, node, bun}` 的 pane → `tmux:{target}`（`scanner/tmux.ts`）。没装 tmux / 没有 server / 不在 pane 里就不带。
- title：优先最后一条 `ai-title.aiTitle`，否则首条非 meta、非命令包装的用户消息前 60 字。
- `sdk-cli` 过滤例外：Hub 自己新建（origin=hub）的会话照常纳入。
- origin：`claude-desktop`→desktop，`cli`→cli，Hub 自己起的→hub（Core 标记）。

## Codex（scanner/codex.ts）
- 只读打开 `~/.codex/state_5.sqlite`（`readOnly:true`），`SELECT ... FROM threads WHERE COALESCE(updated_at_ms, updated_at*1000) >= <recentDays>`。
- `rollout_path` 不存在 → `resumable=false, unresumable_reason='无本地会话文件（ChatGPT 聊天线程）'`。
- title 取 `name`，再 `title`，为空取 `first_user_message`；preview 取 rollout 尾部最后一条 AgentMessage。
- origin：`originator='agent-hub'`→hub，`source='vscode'`→desktop，其余→cli。
- 进度：tail `rollout_path`，格式见 `recordings/codex/rollout-sample.jsonl`：`task_started`→turn.started，`item_completed{UserMessage}`→message.user，`item_completed{AgentMessage}`→message.delta，`function_call/custom_tool_call`→tool.call started，`item_completed{CommandExecution|FileChange|McpToolCall|WebSearch}`→tool.call done，`task_complete`→turn.done success，`turn_aborted`→turn.done interrupted。
- 空闲：以下任一即 running，否则 idle。
  - 线程写锁 `~/.codex/thread-writer-locks/<id>.lock` 被进程打开（`lsof -Fpn`）：GUI 正打开着该线程。其中最后一轮已收尾且 rollout 静默 > `attachedQuietMs`（默认 60s）的记为 `attached`（同样不可续聊），`holder.pid` 为持有锁的进程；可执行文件在 `.app/` 包里（ChatGPT App 的 app-server）或查不到 → `kind:'gui'`，否则 `kind:'cli'`。
  - rollout 最后写入距今 ≤ `idleQuietMs.codex`。
  - 最后一轮未收尾（`task_started` 之后没有 `task_complete/turn_aborted`），且本机有活的 codex 进程；没有 codex 进程时视为崩溃遗留。
- 监听：递归监听 `~/.codex`，只处理 `state_5.sqlite*`（全量重扫）、`sessions/`/`archived_sessions/` 下的 rollout（增量进度 + 复查该线程）、`thread-writer-locks/*.lock`（复查该线程）。
- archived：透传，UI 显示"已归档"，续聊前 Adapter 处理 unarchive。

## Cursor（scanner/cursor.ts）
- **不产生** `attached`：IDE 打开着但未生成时 CLI 可以直接续聊（实测 id 不变）。
- 只读打开 `state.vscdb`。列表：`SELECT <json_extract 取的小字段> FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND lastUpdatedAt >= <recentDays>`，不整条解析 value。**禁止** `LIKE '%xxx%'` 扫 value。
- 没有任何 header 且 `~/.cursor/chats` 里也没有消息的 composer（空草稿）不列出。
- 列表 = IDE composer ∪ `~/.cursor/chats/*/<id>/`（纯 CLI 会话，含 Hub start 建的）。origin：IDE 有该 composer→desktop，只在 chats→cli，Hub 登记的→hub。
- cwd：`composerData.workspaceIdentifier.uri.fsPath`，没有则取 `~/.cursor/chats/.../meta.json.cwd`；都没有显示为空，仍允许续聊（`agent --resume` 不依赖 cwd）。
- title：IDE `name` → 首个 header 的 `textPreview` → chats meta 的 name（非默认 "New Agent"）→ 首条 `<user_query>`。
- 运行：`status==='aborted'` 且 Cursor IDE 主进程（`/Cursor.app/Contents/MacOS/Cursor`）在运行 → running（生成中落库就是 aborted，见 01；真被中断的会话会被误判为 running，在 IDE 里再发一句或退出 IDE 即恢复）；`generatingBubbleIds.length>0` 或 `status==='generating'` 保留为兜底；chats 的 store.db 最近 `idleQuietMs.cursor` 内有写入也算 running；否则 idle。
- 监听：`state.vscdb` / `state.vscdb-wal` 每 1.5 秒轮询 stat（fs.watch 收不到 IDE 写入，见 01），变化即全量重扫（约 70–100ms）；`~/.cursor/chats` 下 `store.db/meta.json` 用 fs.watch（去抖 1 秒）。续聊前 Core 仍会 `refresh()` 直接读库复核，不依赖列表是否及时。
- 消息（会话详情 `GET /api/sessions/:id` 的 `messages`）：按 `fullConversationHeadersOnly` 取最近 N 条（默认 50）点查 `bubbleId:<c>:<b>`，再接上 `~/.cursor/chats/.../store.db` 里的消息，取最后 N 条。store.db 格式见 01（样本 `recordings/cursor/store-db-sample.json`，IDE 样本 `ide-composer-sample.json`）。
- 已知限制：终端里交互式 `agent` 正在跑的会话无法判定（没有 pid 登记），只能靠 store.db 写入时间。
