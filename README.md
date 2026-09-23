# agent-hub

统一管理本机 Claude Code / Codex / Cursor 会话的单进程服务，配手机端 PWA。
设计与规格见 `docs/spec/`，背景调研见 `docs/research/`，AI 协作者须知见 `CLAUDE.md`（`AGENTS.md` 为同一文件）。

## 依赖表
| 包 | 用途 | 理由 |
|---|---|---|
| hono | HTTP 路由 | 轻量；Node 侧用 `node:http` 自行转接，不引入 `@hono/node-server` |
| ws | WebSocket 服务端 | 事实标准 |
| zod | 事件/命令运行时校验 | 三家协议会变，静默错误代价高 |
| tsx / typescript / @types/node | 开发期运行 TS | 不做构建步骤 |
| @types/ws（dev） | ws 的类型声明 | 仅类型、无运行时代码，`npm run typecheck` 需要 |
| vite / preact（web/） | PWA | 体积小 |

## 状态
- [x] M0 骨架 + Claude
- [ ] M1 Codex + Cursor
- [ ] M2 PWA
- [ ] M3 常驻与打磨

## 使用（M0）
```bash
cp hub.config.example.json hub.config.json
npm install
npm run dev                          # 启动 Hub（默认 127.0.0.1:7788）
npm run hub -- pair                  # 打印一次性配对码（5 分钟）
npm run hub -- devices list          # 已配对设备；devices revoke <name|id> 吊销
npm test                             # 回放测试
npm run typecheck
npm run record -- claude             # 录一份 claude 事件流到 recordings/claude/
HUB_TOKEN=<token> npx tsx scripts/ws-client.ts send <sessionId> "<text>"   # 命令行 WS 客户端
```
注：部分 curl 版本不接受 `:7788` 这种省略主机的写法，用 `127.0.0.1:7788`。
