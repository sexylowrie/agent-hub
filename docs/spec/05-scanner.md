# 05 · Scanner（只读）

## 通用
- `watcher.ts`：对各家目录/文件用 `fs.watch`（递归，macOS 支持），事件去抖 300ms；另每 `reconcileSeconds` 全量对账一次。
- 首次启动只纳入 `vendorUpdatedAt` 在 `recentDays` 内的会话；更早的按需分页。
- 输出：`session.upsert`、`session.state`，以及桌面端运行中的进度事件（`message.delta`/`tool.call`/`turn.done`，source=desktop）。
- **空闲判定**是续聊互斥的依据，宁可误判为 running。

## Claude（scanner/claude.ts）
- 遍历 `~/.claude/projects/*/*.jsonl`，跳过 `*/subagents/*`。
- 读首个 `type:user` 行取 `entrypoint/cwd/sessionId`；`entrypoint==='sdk-cli'` 跳过；`isSidechain` 行跳过。
- preview：最后一条 assistant 文本。
- 进度：记录每个文件的已读 offset，增量解析新行；`assistant` → message.delta，`tool_use/tool_result` → tool.call。
- 空闲：`~/.claude/sessions/*.json` 里**没有**该 sessionId 的活 pid，且最后写入距今 > `idleQuietMs.claude`。会话 jsonl 没有 `result` 行，不能靠它判断。
- **只要有活 pid 就一律不可续聊**（state=running），哪怕文件很久没写：这意味着终端或 Desktop 还开着这个会话，手机再 `--resume` 会两个进程写同一个 jsonl。不读 `messagingSocketPath`、`status`、`notify_idle` 等未文档化字段。
- （M1 之后）可用"pid 活 + 文件静默超过阈值"细分为 `attached`（桌面端打开中）与 `running`（正在跑），两者都不可续聊，只是文案不同。M0 不做。
- title：优先最后一条 `ai-title.aiTitle`，否则首条非 meta、非命令包装的用户消息前 60 字。
- `sdk-cli` 过滤例外：Hub 自己新建（origin=hub）的会话照常纳入。
- origin：`claude-desktop`→desktop，`cli`→cli，Hub 自己起的→hub（Core 标记）。

## Codex（scanner/codex.ts）
- 只读打开 `~/.codex/state_5.sqlite`（`readOnly:true`），`SELECT ... FROM threads ORDER BY updated_at DESC`。
- `rollout_path` 不存在 → `resumable=false, unresumable_reason='无本地会话文件（ChatGPT 聊天线程）'`。
- title 取 `title`，为空取 `first_user_message`。
- 进度：tail `rollout_path`；行 `type` 见 recordings/codex/exec-one-turn（rollout 格式与 exec 输出相近，以实际文件为准，先录一份到 recordings/codex/rollout-sample.jsonl）。
- 空闲：rollout 文件最后写入距今 > `idleQuietMs.codex`。
- archived：透传，UI 显示"已归档"，续聊前 Adapter 处理 unarchive。

## Cursor（scanner/cursor.ts）
- 只读打开 `state.vscdb`。列表：`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid DESC LIMIT ?`，逐条解析 JSON，按 `lastUpdatedAt` 过滤 recentDays。**禁止** `LIKE '%xxx%'` 扫 value。
- 消息：按 `fullConversationHeadersOnly` 顺序点查 `bubbleId:<c>:<b>`，只在客户端 subscribe 时加载，且分页（最近 50 条）。
- 进度：`generatingBubbleIds.length>0` 或 `status==='generating'` → running；否则 idle。fs.watch 监听 `state.vscdb-wal`。
- 合并 `~/.cursor/chats/*/<composerId>/`：存在则把 `store.db` 中的消息接在 IDE 消息之后（blobs 表格式需先实测，录样本到 recordings/cursor/store-db-sample.json）。
- cwd：IDE 侧 composerData 无 cwd 字段时，从 `~/.cursor/chats/.../meta.json` 或 workspace 映射推断；推断不到显示为空，仍允许续聊（`agent --resume` 不依赖 cwd）。
