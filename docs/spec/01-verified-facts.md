# 01 · 已验证事实（2026-09-23 本机实测）

实现以本文为准。若与本机实际不符，先改本文再改代码。

## 本机环境
| 项 | 值 |
|---|---|
| macOS | Darwin 25.3.0，Apple Silicon |
| Node | v24.13.0（nvm），`node:sqlite` 可用 |
| claude | 2.1.280，PATH 可用，claude.ai 订阅登录 |
| codex | 0.155.0（`--version` → `codex-cli 0.155.0-alpha.9.2`），二进制在 `/Applications/ChatGPT.app/Contents/Resources/codex`，ChatGPT 账号登录；**未**软链到 PATH |
| cursor agent | 2026.09.18（`agent --version` → `2026.09.18-9a7762b`，原记录 2026.03.25 已过时），PATH 里 `agent` 与 `cursor-agent` 同一程序，已 `agent login` |
| Cursor IDE / ChatGPT App / Claude Desktop | 均已安装，会话期间通常在运行 |

## Claude Code
- 会话文件：`~/.claude/projects/<cwd 编码>/<sessionId>.jsonl`，cwd 编码规则：路径中 `/` 换成 `-`（如 `/Users/dev/AiProject` → `-Users-dev-AiProject`）。
- 每行一个 JSON。首个 `type:"user"` 行带 `entrypoint`、`cwd`、`version`、`sessionId`。
- `entrypoint` 取值：`cli`（终端）、`claude-desktop`（Claude Desktop 的 Code 模式）、`sdk-cli`（SDK/子代理/插件内部调用，**列表要过滤掉**）。
- 子代理转录在 `<sessionId>/subagents/agent-*.jsonl`，不算独立会话。
- Claude Desktop：Chat 模式会话在云端、本机无文件；Cowork 在 VM 镜像里；**只有 Code 模式**落本地且可续接。
- Desktop 拉起 claude 的方式（可直接借鉴）：
  `claude --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --include-partial-messages --replay-user-messages --effort medium --model claude-opus-5-5 ...`
- 续接已实测：`claude -p --output-format json --resume <sessionId> "<text>"` 成功；resume 会追加写同一个 jsonl。
- 无头输出：`--output-format stream-json` 事件类型见 `recordings/claude/one-turn-with-tool.ndjson`：`system(init|status|hook_started|hook_response)`、`stream_event`（Anthropic 流事件透传）、`assistant`、`user`（工具结果）、`rate_limit_event`、`result(success)`。
- 权限审批：`--permission-prompt-tool stdio` + `--input-format stream-json` 时，stdout 出现 `{"type":"control_request","request_id":..,"request":{"subtype":"can_use_tool","tool_name":..,"input":..}}`，stdin 回 `{"type":"control_response","response":{"subtype":"success","request_id":..,"response":{"behavior":"allow"|"deny",...}}}`。样本见 `recordings/claude/permission-roundtrip.ndjson`。
- 活动会话登记：`~/.claude/sessions/<pid>.json`，含 sessionId、cwd、pid、messagingSocketPath；可用于判断某会话是否有活进程。
- **会话 jsonl 里没有 `type:"result"` 行**（result 只出现在 stream-json 输出里）。行类型实测有 `user/assistant/attachment/ai-title/mode/permission-mode/last-prompt/file-history-snapshot` 等。
- `ai-title` 行：`{"type":"ai-title","aiTitle":"...","sessionId":...}`，Claude 自动生成的标题，可能出现多次，取最后一条。
- 用户消息里有大量包装行：`isMeta:true`、`<command-name>`、`<local-command-stdout>`、`<local-command-caveat>` 等，取标题时要跳过。
- 交互会话（终端 / Desktop 标签）**空闲等待输入时进程也一直活着**，`~/.claude/sessions/<pid>.json` 一直在。因此"有活 pid"只能说明会话被桌面端打开着，不能说明正在跑。
- `claude -p`（含 Hub 自己 `--resume` / 新建）写入的 `entrypoint` 是 `sdk-cli`；本机 655 个会话文件里 532 个是 `sdk-cli`。Hub 新建的会话首行也是 `sdk-cli`，Scanner 需对 Hub 已登记的会话例外放行。
- `claude -p` 不开 `--replay-user-messages` 时 stdout 不回显用户输入；不开 `--include-partial-messages` 时没有 `stream_event`，文本只在 `assistant` 整块里。
- 会话 jsonl 中每轮结束写一行 `{"type":"system","subtype":"turn_duration","durationMs":..}`，Scanner 用它产出桌面端 `turn.done`。
- 审批回执 `allow_session`：`control_response` 里带 `updatedPermissions`（取 `permission_suggestions`，`destination` 改为 `session`），claude 接受无报错（M0 实测）。生效范围是 claude 建议的规则（如 `Bash(echo s1 *)`），**不是整个工具**，不同命令仍会再次请求审批。
- **`command_lifecycle`**：stdin 的 user 消息带 `uuid` 时，stdout 输出 `{"type":"command_lifecycle","command_uuid":<该 uuid>,"state":"queued|started|completed|cancelled"}`，本轮的 `result` 夹在 started 与 completed 之间。不带 uuid 时不输出。`--replay-user-messages` 会回显该 user 消息（`isReplay:true`，uuid 原样）。
- **后台任务**：模型用 `run_in_background` 起的命令，`result` 之后 `claude -p` 会**等后台任务结束才退出**，期间无输出（实测 sleep 60 → 进程多活约 60s）。
- **遗留轮次**：上一轮后台任务在进程退出后才结束的，下次 `--resume` 时 claude 会先处理补排的 `<task-notification>`，输出一个**不属于本次输入**的空 `result`（`duration_ms`≈20，usage 为 0），再处理本次输入。该空 `result` **可能早于**本次输入的 `queued` 到达（真机观察到的竞态）。样本：`recordings/claude/resume-with-leftover-notification.ndjson`。
- **SIGINT 中断**：输出 `user`（`[Request interrupted by user]`）→ `result{subtype:"error_during_execution",is_error:true}` → `command_lifecycle{state:"cancelled"}`，进程随即退出。样本：`recordings/claude/interrupted.ndjson`。
- Hub `--resume` 必须在会话原 cwd 下拉起（claude 按 cwd 编码目录找会话文件）。
- 会话文件大小可达 100 MB（本机 1.2 GB / 655 个），Scanner 只读头尾块，不整文件读。
- 不要用 `--bare`（只认 API key，订阅登录不可用）。

## Codex（ChatGPT App 内置）
- 状态库：`~/.codex/state_5.sqlite`，表 `threads` 字段含 `id, rollout_path, cwd, title, source, originator, archived, archived_at, updated_at, first_user_message, model, cli_version`。当前 50 条。
- `source`：`vscode`（GUI）、`exec`、`cli`；`originator`：`Codex Desktop`、`codex_work_desktop`、`codex_exec`。
- 会话正文：`rollout_path` 指向 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；归档的在 `~/.codex/archived_sessions/`。首行 `type:"session_meta"`。
- **12/50 条 rollout_path 文件不存在**（ChatGPT 纯聊天线程），这类 `resumable=false`。
- GUI 运行时 ChatGPT App 会拉起 `codex app-server`（默认 `stdio://`），**独占**，第二个客户端挂不上；`~/.codex/app-server-control/` 不存在，托管 daemon 未运行。
- Hub 自起 `codex app-server`（stdio）走 JSON-RPC（线上省略 `jsonrpc` 字段）：
  - `initialize {clientInfo, capabilities:{experimentalApi:true}}` → 再发通知 `initialized`
  - `thread/list {limit, archived?, sourceKinds?:["cli","vscode","exec","appServer","unknown"], sortKey?:"updated_at"}` → `{data:[...], nextCursor}`；**默认不带 sourceKinds 时列不出 GUI 线程**
  - `thread/resume {threadId}`；归档线程报错 `session ... is archived`，需先 `thread/unarchive`（或 CLI `codex unarchive <id>`）
  - `thread/start {cwd, approvalPolicy:"on-request", sandbox:"read-only"|"workspace-write"}`
  - `turn/start {threadId, input:[{type:"text",text}]}`；通知流 `turn/started`、`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed{turn.status}`
  - 审批：服务端发**带 id 的请求** `item/commandExecution/requestApproval {kind,threadId,turnId,itemId,reason,command,...}`，客户端回 `{id, result:{decision:"accept"|"decline"|"acceptForSession"}}`。样本见 `recordings/codex/app-server-approval.ndjson`
- 协议 JSON Schema：`codex app-server generate-json-schema --out <dir>`；TS：`generate-ts`。已导出一份到 `docs/research/codex-app-server-schema/`。
- **模型**：`~/.codex/config.toml` 默认 `gpt-5.2`，ChatGPT 账号不支持，报 400；拉起时必须 `-c model="gpt-5.5"`（可用列表在 `~/.codex/models_cache.json`）。
- `codex exec --json` 需 `</dev/null` 或 `--skip-git-repo-check`，否则等 stdin；事件类型见 `recordings/codex/exec-one-turn.ndjson`。
- `codex mcp-server` 已被官方移除，不要用。

## Cursor
- IDE 会话库：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`，**约 10 GB**，WAL 模式。表 `cursorDiskKV(key, value)`。
  - `composerData:<composerId>` → JSON：`name, status(none|completed|...), createdAt, lastUpdatedAt, isAgentic, unifiedMode, fullConversationHeadersOnly:[{bubbleId,type,createdAt}], generatingBubbleIds:[]`
  - `bubbleId:<composerId>:<bubbleId>` → JSON：`type(1=user,2=assistant), text, toolFormerData?, thinking?, tokenCount`
  - 当前 1631 个 composer。**只能按 key 点查**，禁止全表扫 value。
  - 只读打开：`file:...?mode=ro`（Python 已验证；Node `node:sqlite` 用 `{readOnly:true}`）。
- CLI 续接已实测：`agent -p --output-format json --resume <composerId> "<text>"` 成功，返回同 `session_id`，上下文完整（inputTokens ≈17k）。
- CLI 续聊内容写到 `~/.cursor/chats/<workspaceHash>/<composerId>/store.db`（表 `blobs, meta`）+ `meta.json{cwd,createdAtMs,updatedAtMs}`，**不回写** `state.vscdb`。Scanner 需合并两处。
- 无头事件见 `recordings/cursor/one-turn-with-tool.ndjson`：`system(init)`、`user`、`thinking(delta|completed)`、`tool_call(started|completed)`、`assistant`、`result(success)`。
- `agent -p` 无中途审批；`--sandbox enabled` 或 `--force`。
- `agent ls` 需要 TTY（Ink），不能在无头环境用；列表一律读库。
- 偶发 `Connection stalled`，重试一次即可。

## 三家共性
- 都是"本机进程 + 出站连接"，Hub 不需要开任何入站端口给厂商。
- 三家的登录态都在本机，Hub 子进程直接继承，**不需要在 Hub 里处理任何厂商鉴权**。
