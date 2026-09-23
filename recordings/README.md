# recordings · 三家真实事件流（2026-09-23 录制）

解析器以这些文件为准。`<< ` 前缀 = 子进程 stdout；`>> ` 前缀 = 我们写入 stdin；无前缀 = 纯 stdout。

| 文件 | 内容 | 用途 |
|---|---|---|
| claude/one-turn-with-tool.ndjson | `claude -p --output-format stream-json --verbose --include-partial-messages`，含 Bash 工具调用 | 事件映射、delta 拼接 |
| claude/permission-roundtrip.ndjson | 双向 stream-json + `--permission-prompt-tool stdio`，含 `control_request/can_use_tool` 与我们的 `control_response` | 审批往返 |
| claude/adapter-args-roundtrip.ndjson | `npm run record -- claude` 录制，参数与 Adapter 完全一致（`--include-partial-messages` + `--permission-prompt-tool stdio` + `--permission-mode default`），含审批往返 | Adapter 端到端解析 |
| claude/resume-with-leftover-notification.ndjson | resume 一个上轮留有后台任务（`sleep 15`，run_in_background）的会话：claude 先处理遗留 task-notification 输出一个空 `result`，再处理我们的输入；输入带 `uuid`，含 `command_lifecycle` | 只认自家命令的 result |
| claude/interrupted.ndjson | 长文本生成中途对 claude 发 SIGINT（`>> [SIGINT]` 为动作标记）：输出 `result{subtype:error_during_execution,is_error:true}`，随后 `command_lifecycle{state:cancelled}` | 中断识别 |
| codex/exec-one-turn.ndjson | `codex exec --json`，含 command_execution | 事件形状参考（Adapter 不用 exec） |
| codex/app-server-one-turn.ndjson | app-server JSON-RPC：initialize → thread/start → turn/start → turn/completed | 握手与一轮 |
| codex/app-server-approval.ndjson | 同上，read-only 沙箱触发 `item/commandExecution/requestApproval` 并回 accept | 审批往返 |
| cursor/one-turn-with-tool.ndjson | `agent -p --output-format stream-json --sandbox enabled`，含 tool_call | 事件映射 |

录制脚本：`npm run record -- claude|codex|cursor [--prompt ..] [--cwd ..] [--resume id] [--decision allow|deny] [--out 文件名] [--interrupt-after ms]`；codex 另有 `--unarchive`、`--model`、`--force`。

## M1 补充（2026-09-24，均用 `npm run record` 录制，只动 /tmp 下的探针会话）
| 文件 | 内容 | 用途 |
|---|---|---|
| codex/app-server-resume.ndjson | `thread/resume{excludeTurns}` → 一轮；resume 后先收到**上一轮**的 tokenUsage | 只认本轮 turnId |
| codex/app-server-interrupted.ndjson | 长文本中途 `turn/interrupt` → `turn/completed{interrupted}` | 中断 |
| codex/app-server-filechange-approval.ndjson | read-only 沙箱下 apply_patch 触发 `item/fileChange/requestApproval` 并 accept | 文件审批（请求不带路径） |
| codex/app-server-unarchive-resume.ndjson | 归档线程 `thread/unarchive` → resume（带 `model` 覆盖） | 自动解档 |
| codex/app-server-model-unsupported.ndjson | 线程模型为 gpt-5.2：`error` 通知 + `turn/completed{failed}` | 失败轮次 |
| codex/rollout-sample.jsonl | 探针线程的 rollout（两轮，含工具调用），经 `scripts/trim-codex-rollout.ts` 裁剪（去 AGENTS.md 等注入上下文） | Scanner 尾部/进度 |
| codex/rollout-interrupted.jsonl | 被中断线程的 rollout，以 `turn_aborted` 结尾 | 中断识别 |
| cursor/resume-one-turn.ndjson | `--stream-partial-output` 下续聊一轮：文本片段 + 整块重复，中间夹工具调用 | 去重规则 |
| cursor/interrupted.ndjson | SIGINT：无 result，退出码 130 | 中断 |
| cursor/store-db-sample.json | `~/.cursor/chats/.../store.db`（三轮 CLI 会话）经 `scripts/dump-cursor-store.ts` 导出：meta、根 blob（protobuf hex）、消息 JSON | chats 合并 |
| cursor/ide-composer-sample.json | IDE composer（`dc0a49f7`，只有 hi/你好）的 composerData + bubble，经 `scripts/dump-cursor-composer.ts` 只留 Scanner 用到的字段 | IDE 列表/详情 |

## Scanner 样本（M0 补充）
| 文件 | 内容 | 用途 |
|---|---|---|
| claude/session-cli-sample.jsonl | 真实 `entrypoint:cli` 交互会话前 30 行，经 `scripts/trim-claude-session.ts` 裁剪（丢 attachment、截断长文本） | Scanner 头尾解析、标题、增量进度 |
| claude/session-sdk-cli-sample.jsonl | 上面 permission-roundtrip 那次 `claude -p` 落盘的会话文件，同样裁剪 | sdk-cli 过滤 |
