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
- 活动会话登记：`~/.claude/sessions/<pid>.json`，含 sessionId、cwd、pid、messagingSocketPath；可用于判断某会话是否有活进程。登记里还有 `entrypoint`（`cli` / `claude-desktop`，2026-09-24 本机核对），Scanner 只用它区分 attached 的持有者是终端还是 Desktop；目录里另有只含 `peerToken/procStart` 的文件（无 sessionId），忽略。
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
- **`--fork-session`**（2026-09-24 实测，claude 2.1.281）：`claude -p --resume <原 id> --fork-session ...` 从一开始（含 `hook_started`、`command_lifecycle`、`system/init`）输出的 `session_id` 就是**新 id**；新会话文件写在同一 cwd 编码目录下，包含原会话上下文；原会话文件不追加任何内容。SessionStart hook 的 `hook_name` 为 `SessionStart:fork`。样本：`recordings/claude/fork-session.ndjson`。
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
- 协议 JSON Schema：`codex app-server generate-json-schema --out <dir>`；TS：`generate-ts`。需要时本地导出（不入库，约 4MB）；Adapter 用的 TS 类型由 `npm run gen:codex` 生成到 `src/adapters/codex.types*`。
- **模型**：`~/.codex/config.toml` 默认 `gpt-5.2`，ChatGPT 账号不支持，报 400；拉起时必须 `-c model="gpt-5.5"`（可用列表在 `~/.codex/models_cache.json`）。
- `codex exec --json` 需 `</dev/null` 或 `--skip-git-repo-check`，否则等 stdin；事件为 `thread.started` / `turn.started` / `item.*` / `turn.completed`（Adapter 走 app-server，不用 exec，样本未保留）。
- `codex mcp-server` 已被官方移除，不要用。

### Codex · M1 实测补充（2026-09-24）
- `threads` 表实际字段还有 `updated_at_ms`、`name`、`preview`、`recency_at_ms` 等；`updated_at` 单位是**秒**。Hub 自起 app-server 时 `clientInfo.name` 会落到 `originator`（Hub 用 `agent-hub`）。
- `thread/resume` 参数可带 `approvalPolicy`、`sandbox`、`model`、`excludeTurns:true`（不回传历史 turns，Hub 用这个）。
- **模型**：resume 沿用线程自己存的模型，`-c model=` **压不住**（gpt-5.2 线程 resume 后报 400）；`thread/resume` 传 `model` 能覆盖，但会**改写线程的模型**并持久化。Hub 策略：线程模型在 `~/.codex/models_cache.json` 的 `models[].slug` 里就沿用，不在才覆盖为 `config.codex.model`。本机当前可用：gpt-6-astra/sol/luna、gpt-5.6-*、gpt-5.5 等。
- **遗留通知**：resume 后、本轮开始前会收到上一轮的 `thread/tokenUsage/updated`（turnId 是上一轮的）。解析只认本轮 turnId（`turn/start` 响应里的 `turn.id`）。样本：`recordings/codex/app-server-resume.ndjson`。
- **中断**：`turn/interrupt {threadId, turnId}` → `{}` → `turn/completed{turn.status:"interrupted"}`；关 stdin 后进程立即退出（code 0）。样本：`app-server-interrupted.ndjson`。
- **失败轮次**：先 `error{willRetry:false}` 通知，再 `turn/completed{status:"failed", turn.error}`。样本：`app-server-model-unsupported.ndjson`。
- **文件审批**：`item/fileChange/requestApproval {threadId, turnId, itemId, reason, grantRoot}` **不带路径**，路径在此前 `item/started{type:fileChange}.changes[].path`。回执同命令审批。样本：`app-server-filechange-approval.ndjson`。
- **归档**：`codex archive <id>` 会把 rollout 移到 `~/.codex/archived_sessions/` 并更新 `rollout_path`；`thread/unarchive` 移回。归档线程直接 resume 报 `session <id> is archived. Run codex unarchive <id> to unarchive it first.`（原文里命令带反引号）。样本：`app-server-unarchive-resume.ndjson`。
- **线程写锁**：app-server 加载一个线程时持有 `~/.codex/thread-writer-locks/<threadId>.lock`（flock，文件保持打开；释放后文件删除）。ChatGPT App 里**正打开着**的线程由 GUI 的 app-server 持锁，此时另一个 app-server resume 报 `thread <id> already has an active writer`。Scanner 用 `lsof -Fn` 查锁文件是否被进程打开（约 150ms，只在有锁文件时查）。
- 实测 GUI 里一轮早已结束（01:14）、线程仍停留在界面上时（01:38），锁一直被持有，Hub 视为不可续聊（state=running）。
- 在 App 里**切到别的线程不释放**：本次运行中打开过的线程都保持加锁。**退出 ChatGPT App（⌘Q）后锁文件全部删除**，随后 Hub 续聊 GUI 线程成功，线程模型（gpt-6-astra）不变。
- **rollout 格式**（`recordings/codex/rollout-*.jsonl`）：`session_meta`、`event_msg{task_started|task_complete|turn_aborted|item_completed|token_count|thread_settings_applied}`、`response_item{message|function_call|function_call_output|custom_tool_call|reasoning|...}`、`world_state`、`turn_context`、`token_usage_record`、`compacted`。
  - 一轮以 `task_started` 开始，以 `task_complete{last_agent_message,duration_ms}` 或 `turn_aborted{reason:"interrupted"}` 结束。
  - 真实用户输入看 `event_msg.item_completed{item.type:"UserMessage"}`；`response_item` 里 role=user 的还有注入上下文（`# AGENTS.md instructions`、`<environment_context>`、`<recommended_plugins>`、`<turn_aborted>`）。
  - `world_state` 带 `~/.codex/AGENTS.md` 全文，**录样本时必须裁掉**（`scripts/trim-codex-rollout.ts`）。
  - 本机 37 份归档 rollout 里有 3 份以未收尾的 `task_started` 结尾（崩溃遗留），不能单凭"未收尾"判定运行中。

## Cursor
- IDE 会话库：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`，**约 10 GB**，WAL 模式。表 `cursorDiskKV(key, value)`。
  - `composerData:<composerId>` → JSON：`name, status(none|completed|aborted|...), createdAt, lastUpdatedAt, isAgentic, unifiedMode, fullConversationHeadersOnly:[{bubbleId,type,createdAt,grouping.textPreview}], generatingBubbleIds:[], workspaceIdentifier.uri.fsPath`
  - `bubbleId:<composerId>:<bubbleId>` → JSON：`type(1=user,2=assistant), text, toolFormerData?, thinking?, tokenCount`
  - 当前 1631 个 composer。**只能按 key 点查**，禁止全表扫 value。
  - 只读打开：`file:...?mode=ro`（Python 已验证；Node `node:sqlite` 用 `{readOnly:true}`）。
- CLI 续接已实测：`agent -p --output-format json --resume <composerId> "<text>"` 成功，返回同 `session_id`，上下文完整（inputTokens ≈17k）。
- CLI 续聊内容写到 `~/.cursor/chats/<workspaceHash>/<composerId>/store.db`（表 `blobs, meta`）+ `meta.json{cwd,createdAtMs,updatedAtMs}`，**不回写** `state.vscdb`。Scanner 需合并两处。
- 无头事件见 `recordings/cursor/one-turn-with-tool.ndjson`：`system(init)`、`user`、`thinking(delta|completed)`、`tool_call(started|completed)`、`assistant`、`result(success)`。
- `agent -p` 无中途审批；`--sandbox enabled` 或 `--force`。
- `agent ls` 需要 TTY（Ink），不能在无头环境用；列表一律读库。
- 偶发 `Connection stalled`，重试一次即可。

### Cursor · M1 实测补充（2026-09-24）
- **cwd**：composerData 有 `workspaceIdentifier.uri.fsPath`（IDE 工作区目录），1632 个里 527 个有（老会话没有）。原记录"composerData 无 cwd 字段"不准确。
- 列表查询：`WHERE key >= 'composerData:' AND key < 'composerData;'` 配合 `json_extract` 只取小字段，1632 条冷启动约 450ms、热约 65ms；`LIKE 'composerData:%' ORDER BY rowid` 反而要 ~500ms。value 合计 76 MB，单条最大 3.7 MB，不要整条 `JSON.parse`。
- bubble：`{type:1|2, text, toolFormerData?:{name,status,params,result}, createdAt}`；header 的 `grouping.textPreview` 可直接当预览。
- **`~/.cursor/chats/<workspaceHash>/<composerId>/store.db`**：表 `meta(key,value)`、`blobs(id,data)`。
  - `meta` 只有 key `'0'`，value 是 **hex 编码的 JSON**：`{agentId, latestRootBlobId, name("New Agent"), mode, createdAt, blobEncryptionKey}`。
  - blob 按内容寻址（id 为 32 字节 hex）。根 blob 是 protobuf，**field 1 重复出现，按顺序列出消息 blob id**；其余字段含工作区 URI、token 拆分等。
  - 消息 blob 是 JSON `{role:"system"|"user"|"assistant"|"tool", content}`。用户真实输入包在 `<user_query>…</user_query>` 里；每次拉起还会插一条约 55 KB 的注入上下文 user 消息（`<user_info>`、规则、技能等），要跳过。assistant content 里有 `text` / `reasoning` / `tool-call{toolName,args}`；tool 消息是 `tool-result{toolName,result}`。样本：`recordings/cursor/store-db-sample.json`。
  - IDE 会话被 CLI 续聊后，store.db **只含 CLI 这几轮**，IDE 历史不在里面，详情要两边拼接。
- **信任提示**：`agent -p` 在未信任目录（如 `/tmp`）直接退出 code 1，stderr `Workspace Trust Required … Pass --trust, --yolo, or -f`。Hub 一律带 `--trust`（cwd 已由 allowedCwds / 会话原工作区限定）。
- **`--stream-partial-output`**：assistant 按片段输出（带 `timestamp_ms`），一段结束后再把这段全文整块输出一次（紧挨工具调用前的那次也带 `timestamp_ms`，最后一次不带）。Adapter 规则：整块文本等于累计片段时丢弃。样本：`recordings/cursor/resume-one-turn.ndjson`。
- **SIGINT**：没有 `result` 行，stderr `Aborting operation...`，退出码 130。样本：`recordings/cursor/interrupted.ndjson`。
- `agent -p` 从拉起到 `system.init` 实测约 15 秒（续聊 IDE 会话时），整轮 20–30 秒。
- **fs.watch 收不到 IDE 的写入**：对 `globalStorage/` 递归与非递归 `fs.watch` 各挂 20 秒，期间 `state.vscdb-wal` 被写入（mtime 变化），两者都**没有任何事件**。IDE 侧变化只能轮询 stat 发现。
- **IDE 生成中的落库状态**（每 0.5s 轮询 composerData，一次约 110 秒的长任务）：`generatingBubbleIds` **始终为空**，从未出现 `status:"generating"`；用户消息发出 0.5s 内落库，status 变为 **`aborted`**，bubble 随生成陆续写入（h7→h71），`lastUpdatedAt` 停在本轮开始时刻不刷新；结束时 status 改为 `completed`。真被中断/IDE 中途退出的会话也停在 `aborted`（本机近 30 天 19 个有内容的会话里 1 个）。原"generatingBubbleIds 非空即 running"的判据不成立。

## 三家共性
- 都是"本机进程 + 出站连接"，Hub 不需要开任何入站端口给厂商。
- 三家的登录态都在本机，Hub 子进程直接继承，**不需要在 Hub 里处理任何厂商鉴权**。

## 常驻与推送 · M3 实测（2026-09-24）
- **kill -9 Hub 后厂商子进程还活着**：Hub 轮次中 `kill -9` Hub，`claude -p --resume … --input-format stream-json` 子进程没有随之退出（stdin 管道断了也不立刻退）。旧对账只处理"pid 不存在"的轮次，会让这类轮次永远停在 running、会话一直 SESSION_BUSY。现在启动时所有 running 轮次一律 orphaned，子进程还活着且命令行是厂商二进制就 SIGTERM。
- **tsx CLI 是两个进程**：`tsx x.ts` 先起一个 node 再 spawn 真正跑代码的 node。launchd 下若用 tsx CLI，`kill -9` 只杀掉外层，内层继续占着端口，新实例起不来。plist 里直接 `node --import tsx src/main.ts` 单进程运行。
- **launchd**：`KeepAlive=true` + `ThrottleInterval=1`，`kill -9` 后 1.6 秒恢复服务（health 可用）；`launchctl kickstart -k` 正常重启。launchd 的默认 PATH 找不到 `claude`/`agent`（在 `~/.local/bin`），plist 写入安装时的 PATH。
- **caffeinate**：`caffeinate -s -w <hub pid>` 在 Hub 被 kill -9 后自动退出，不会残留断言。`-s` 只在接电源时生效。合盖接电 30 分钟后仍可访问**未实测**（需要人合盖）。
- **Web Push 加密**：`encryptPayload` 用 RFC 8291 附录 A 的输入，输出与 RFC 结果逐字节一致；VAPID JWT 用公钥验签通过。Chrome DevTools 驱动的浏览器 `Notification.requestPermission()` 直接返回 denied，拿不到订阅；改用最小接收端直连 **Mozilla autopush**（`wss://push.services.mozilla.com`，hello → register 带 VAPID 公钥 → 拿到 endpoint 登记到 Hub）验证：Hub 推送被接受（201），收到的 aes128gcm 消息解密正确；一轮需要审批的 Claude 续聊依次收到「需要审批」「完成」两条。**Apple 推送服务（iOS 主屏幕 PWA）尚未验证**。
- **Tailscale**：本机原先没装；`brew install --cask tailscale-app` 的安装器需要 sudo 密码，Claude Code 的 `!` 命令也没有 TTY，一样失败；下载官方 pkg 用图形安装器装成功。tailnet 默认没开 Serve，首次 `tailscale serve` 给出后台开启链接（浏览器必须登录与本机同一个 Tailscale 账号，否则 404 node not found）。首次 HTTPS 请求约 27 秒（签发证书），之后正常。
- **经 tailscale serve 的 HTTPS 验收**：`https://<mac>.<tailnet>.ts.net` 上 PWA、REST、WS 都通；在 Claude 测试会话里经此地址续聊 → 审批允许 → 写文件 → turn.done success。iPhone 已配对并从手机续聊过 Cursor 会话。
- **防睡眠断言**：接电源时 `pmset -g assertions` 可见 `caffeinate -s -w <hub pid>` 持有 PreventSystemSleep（"on behalf of Process ID <hub pid>"）。
