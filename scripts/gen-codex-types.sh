#!/usr/bin/env bash
# 重新生成 Codex app-server 协议类型 → src/adapters/codex.types.ts（入口）+ src/adapters/codex.types/（闭包）
# codex 路径取 hub.config.json 的 binaries.codex（没有配置文件时用 example）。
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=hub.config.json; [ -f "$CFG" ] || CFG=hub.config.example.json
CODEX=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).binaries.codex.replace(/^~/, process.env.HOME))' "$CFG")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"$CODEX" app-server generate-ts --out "$TMP" >/dev/null
CODEX_VERSION=$("$CODEX" --version) npx tsx scripts/bundle-codex-types.ts "$TMP" src/adapters/codex.types \
  InitializeParams InitializeResponse \
  ThreadStartParams ThreadStartResponse ThreadResumeParams ThreadResumeResponse \
  ThreadUnarchiveParams ThreadUnarchiveResponse \
  TurnStartParams TurnStartResponse TurnInterruptParams TurnInterruptResponse \
  ServerNotification ServerRequest \
  CommandExecutionRequestApprovalResponse FileChangeRequestApprovalResponse
