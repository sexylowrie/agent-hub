# recordings · 三家真实事件流（2026-09-23 录制）

解析器以这些文件为准。`<< ` 前缀 = 子进程 stdout；`>> ` 前缀 = 我们写入 stdin；无前缀 = 纯 stdout。

| 文件 | 内容 | 用途 |
|---|---|---|
| claude/one-turn-with-tool.ndjson | `claude -p --output-format stream-json --verbose --include-partial-messages`，含 Bash 工具调用 | 事件映射、delta 拼接 |
| claude/permission-roundtrip.ndjson | 双向 stream-json + `--permission-prompt-tool stdio`，含 `control_request/can_use_tool` 与我们的 `control_response` | 审批往返 |
| codex/exec-one-turn.ndjson | `codex exec --json`，含 command_execution | 事件形状参考（Adapter 不用 exec） |
| codex/app-server-one-turn.ndjson | app-server JSON-RPC：initialize → thread/start → turn/start → turn/completed | 握手与一轮 |
| codex/app-server-approval.ndjson | 同上，read-only 沙箱触发 `item/commandExecution/requestApproval` 并回 accept | 审批往返 |
| cursor/one-turn-with-tool.ndjson | `agent -p --output-format stream-json --sandbox enabled`，含 tool_call | 事件映射 |

待补（M1）：`codex/rollout-sample.jsonl`（GUI 会话文件格式）、`cursor/store-db-sample.json`（CLI 续聊存储格式）。
录制脚本：`npm run record -- <vendor>`（M0 实现 `scripts/record.ts`）。

## Scanner 样本（M0 补充）
| 文件 | 内容 | 用途 |
|---|---|---|
| claude/session-cli-sample.jsonl | 真实 `entrypoint:cli` 交互会话前 30 行，经 `scripts/trim-claude-session.ts` 裁剪（丢 attachment、截断长文本） | Scanner 头尾解析、标题、增量进度 |
| claude/session-sdk-cli-sample.jsonl | 上面 permission-roundtrip 那次 `claude -p` 落盘的会话文件，同样裁剪 | sdk-cli 过滤 |
