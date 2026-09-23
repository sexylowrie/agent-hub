# agent-hub

统一管理本机 Claude Code / Codex / Cursor 会话的单进程服务，配手机端 PWA。
设计与规格见 `docs/spec/`，背景调研见 `docs/research/`，AI 协作者须知见 `CLAUDE.md`（`AGENTS.md` 为同一文件）。

## 依赖表
| 包 | 用途 | 理由 |
|---|---|---|
| hono | HTTP 路由 | 轻量，支持 Node adapter |
| ws | WebSocket 服务端 | 事实标准 |
| zod | 事件/命令运行时校验 | 三家协议会变，静默错误代价高 |
| tsx / typescript / @types/node | 开发期运行 TS | 不做构建步骤 |
| vite / preact（web/） | PWA | 体积小 |

## 状态
- [ ] M0 骨架 + Claude
- [ ] M1 Codex + Cursor
- [ ] M2 PWA
- [ ] M3 常驻与打磨
