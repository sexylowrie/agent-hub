# agent-hub

一个跑在这台 Mac 上的单进程服务，把 Claude Code、Codex、Cursor 三家的本机会话统一成一个列表，
手机端可以看进度、在桌面端空闲后接着聊、处理权限审批。**不做实时接管 GUI，不做厂商 relay。**

## 先读什么
1. `docs/spec/00-overview.md` 目标、边界、非目标
2. `docs/spec/01-verified-facts.md` 三家在本机的**已验证事实**（路径、命令、协议样本），实现必须以此为准
3. 当前里程碑对应的 spec 章节（见 `docs/spec/08-milestones.md`）
4. `recordings/` 三家真实事件流，Adapter 解析以录制为准，不凭记忆猜字段

背景调研与架构图在 `docs/research/`，遇到"为什么这么设计"先看那里，不要重新调研。

## 技术栈（已定，不要换）
- Node 24（本机 v24.13.0）+ TypeScript，`tsx` 直接运行，开发期不做构建
- 依赖白名单：`hono` `ws` `zod` `tsx` `typescript` `@types/node`，前端另有 `vite` `preact`
- 存储用内置 `node:sqlite`，**禁止**任何原生编译依赖（better-sqlite3 等）
- 测试用 `node:test`，Adapter 与 Scanner 用 `recordings/` 回放，不 mock 协议
- 新增依赖必须在 README 的依赖表里写一句理由

## 硬约束
- 三家的存储**只读**：`~/.claude/projects`、`~/.codex/*.sqlite`、Cursor 的 `state.vscdb` 只能以只读方式打开，永远不写
- 会话非空闲时**拒绝**发起续聊，空闲判定见 `05-scanner.md`；同一会话同时只允许一个 Hub 轮次
- Adapter 一次一轮：拉起进程 → 跑完 → 退出，不维持长驻子进程
- Gateway 只监听 Tailscale 地址或 127.0.0.1，不监听 0.0.0.0
- 设备 token 只存哈希；配对码一次性、5 分钟过期
- 不用 Chrome DevTools 协议碰 Cursor IDE；不 patch 任何厂商二进制；不用隐藏参数 `--sdk-url`

## 三家二进制（来自 hub.config.json，不要硬编码）
- claude：`claude`（PATH），2.1.280
- codex：`/Applications/ChatGPT.app/Contents/Resources/codex`，0.155；ChatGPT 账号只能用 `gpt-5.5` 等，`~/.codex/config.toml` 里的 gpt-5.2 不可用，拉起时必须 `-c model="gpt-5.5"`
- cursor：`agent`（PATH），2026.03.25；已 `agent login`

## 常用命令
```bash
npm run dev            # tsx watch src/main.ts
npm test               # node --test
npm run gen:codex      # 重新生成 Codex app-server 协议 TS 类型
npm run record -- <vendor>   # 录一份新的事件流到 recordings/
```

## 工作方式
- 按 `08-milestones.md` 的顺序做，每个里程碑有验收命令，跑通验收再进下一个
- 改协议解析先补/更新 `recordings/` 里的样本和对应测试
- 遇到 spec 与本机实际不一致：以实际为准，改 `01-verified-facts.md` 并在提交说明里写明
- 提交信息用中文，一个里程碑内小步提交
- 不要顺手重构与当前任务无关的模块；不要引入 lint/format 工具链

## 目录约定
见 `docs/spec/00-overview.md` 的目录树。`src/core` 不依赖任何厂商细节；厂商细节只能出现在 `src/adapters/*` 与 `src/scanner/*`。
