# agent-hub

跑在用户自己 Mac 上的单进程服务，把 Claude Code、Codex、Cursor 三家的本机会话统一成一个列表，
手机 / 浏览器端（PWA）可以看进度、在桌面端空闲后接着聊、处理权限审批、新建会话。
**不做实时接管 GUI，不做厂商 relay，不上云。**

本文件是给 AI 协作者（Claude Code、Codex、Cursor 等）的项目约定，`AGENTS.md` 是指向它的软链，只改这一个文件。
面向用户的介绍见 `README.md`。

## 先读什么
1. `docs/spec/00-overview.md`：目标、边界、非目标、目录树
2. `docs/spec/01-verified-facts.md`：三家在本机的**已验证事实**（路径、命令、协议、实测坑），实现必须以此为准
3. 与改动相关的 spec：`02` 数据模型、`03` 事件与协议、`04` Adapter、`05` Scanner、`06` Gateway 与鉴权、`07` PWA
4. `recordings/`：三家真实事件流（已脱敏），解析以录制为准，不凭记忆猜字段

"为什么这么设计"先看 `docs/research/`，不要重新调研。里程碑 M0–M3 已完成（`docs/spec/08-milestones.md`），之后按需求迭代。

## 技术栈（已定，不要换）
- Node 24+ 与 TypeScript（strict），`tsx` 直接运行，后端不做构建
- 依赖白名单：`hono` `ws` `zod` `tsx` `typescript` `@types/node` `@types/ws`；PWA（`web/`）另有 `vite` `preact`
- 存储用内置 `node:sqlite`，**禁止**任何原生编译依赖（better-sqlite3 等）
- 测试用 `node:test`；Adapter 与 Scanner 用 `recordings/` 回放，不 mock 协议
- 新增依赖必须在 README 写明理由；不引入 lint / format 工具链

## 硬约束（运行时行为）
- 三家存储**只读**：`~/.claude/projects`、`~/.codex/*.sqlite`、Cursor `state.vscdb` 只能以只读方式打开，永远不写；续聊由官方 CLI 自己写回
- 会话非空闲时**拒绝**续聊（判定见 `05-scanner.md`，宁可误判为运行中）；同一会话同时只允许一个 Hub 轮次
- Adapter 一次一轮：拉起进程 → 跑完 → 退出，不维持长驻子进程
- 不用 Chrome DevTools 协议碰 Cursor IDE；不 patch 任何厂商二进制；不用隐藏参数 `--sdk-url`；不复用厂商的 relay / 远程控制协议
- `src/core` 不依赖任何厂商细节；厂商字段、路径、命令行只能出现在 `src/adapters/*` 与 `src/scanner/*`；`gateway` 只认 core 的类型
- 三家二进制路径来自 `hub.config.json` 的 `binaries`，不要硬编码；Codex 回退模型来自 `codex.model`

## 安全规范

这个服务能在用户机器上执行 AI 代理的命令、读到三家的全部会话，仓库也是公开的。以下规则优先于便利性，拿不准时按更保守的做。

### 1. 权限与执行边界（不能放宽）
- 默认走最保守的权限模式：Claude `--permission-mode default`、Codex `sandbox: read-only` + `approvalPolicy: on-request`、Cursor `--sandbox enabled`。放宽（`acceptEdits` / `workspace-write` / `--force`）只能来自用户在界面上**显式、逐次**打开的开关，默认关，不得记住或自动打开
- **永远不用** `--dangerously-skip-permissions`、`bypassPermissions`、`--yolo`、`danger-full-access` 这类跳过审批的模式
- 审批超时一律按**拒绝**处理；只接受 `pending` 且未过期的审批；记录 `decided_by`
- 新建会话的 `cwd` 必须落在 `allowedCwds` 内，按 `realpath` 比较（防 `..` 与软链逃逸）
- 用户发来的文本只作为 prompt 传给 CLI（参数数组或 stdin），**不拼进 shell 命令**；子进程一律 `spawn(bin, args)`，不用 `shell: true`

### 2. 网络与鉴权
- Gateway 只监听 `127.0.0.1` 或 Tailscale 地址，启动时拒绝 `0.0.0.0` / `::`；对外 HTTPS 用 `tailscale serve` 反代，Hub 自己不开公网端口
- 除 `/api/pair`、`/api/health` 外所有 REST 都要 Bearer token，WS 必须先 `hello`；未鉴权的 `/api/health` 不返回 `allowedCwds` 等内部信息
- 配对码 6 位、一次性、5 分钟过期；设备 token 32 字节随机数，库里**只存 sha256**，明文只在配对响应里出现一次；支持吊销
- 静态托管必须防目录穿越（解析后的路径不能跑出 `web/dist`）
- 新接口默认需要鉴权；任何放开鉴权的改动都要在 `06-gateway-auth.md` 写明理由

### 3. 密钥与凭据
- 仓库里**不得出现**任何真实的 token、API key、私钥、配对码、Cookie、VAPID 私钥；示例一律用占位符（`<token>`、`123456`）
- 本机专属文件都已 gitignore，不要改成入库：`hub.config.json`、`data/`、`.env`、`web/dist/`；运行数据（`hub.sqlite`、`vapid.json`，权限 600）在 `dataDir`，不在仓库里
- 日志不打印 token、token 哈希、推送订阅的 endpoint 全文；拒绝请求只记原因码
- 验收时生成的设备 token 只放会话临时目录，用完吊销

### 4. 录制、样本与截图（开源红线）
- 录制会带上本机环境（Claude `system/init` 里的 MCP 服务 / skills / 插件清单、SessionStart hook 输出、家目录、私有项目名）。**新录制提交前必须**：`SANITIZE_WORDS=<私有词,逗号分隔> npm run sanitize`，再 `npm run sanitize -- --check` 通过
- 录制只用探针会话（`/tmp` 或 gitignored 的 `data/` 下新建），**不要 resume 用户真实的会话**，不要把真实会话内容写进样本、测试、文档或提交说明
- 代码、测试、文档、设计稿里不出现：真实家目录与用户名（用 `/Users/dev`）、主机名 / tailnet 名 / IP（用 `my-mac.example.ts.net`）、邮箱、公司与内部服务名、其他私有项目名、真实会话标题
- README / 文档截图只用演示数据（真实前端 + 注入的假 `fetch` / `WebSocket`），不截真实会话
- 提交前自查：`git diff --cached` 里有没有上面这些内容；大块二进制或生成物（如协议 schema 导出）不入库

### 5. 前端
- AI 回复的 Markdown 只能走 `web/src/markdown.ts`：**先转义再加标签**，不输出任何原始 HTML，链接只认 `http(s)` 且带 `rel="noopener noreferrer"`；除此之外不用 `dangerouslySetInnerHTML`
- 不加载任何第三方脚本、字体、CDN、统计埋点；Service Worker 不缓存 `/api` 与 `/ws`
- token 只存在本机 localStorage，不放进 URL、不写日志

### 6. 推送
- Web Push 按 RFC 8291 端到端加密、RFC 8292 VAPID 签名；只推 `approval.request` 与 **Hub 轮次**的 `turn.done`
- 推送正文只放标题与 ≤120 字摘要，不放完整命令输出、文件内容或密钥；推送服务返回 404/410 的订阅立即删除，吊销设备的订阅不再推送

### 7. 依赖与供应链
- 只用白名单依赖；不加带 `postinstall` 等安装钩子的包；lockfile 入库
- 不从网络下载并执行脚本；生成代码（`npm run gen:codex`）只来自本机已安装的官方二进制

### 8. 操作边界（对 AI 协作者）
- **不要自行 `git push`、改写历史、删分支、发布**；提交前先给用户看改动，用户说提交再提交
- 删除文件、清理数据、吊销设备、改 launchd / Tailscale 等系统配置前先说明影响并确认
- 发现疑似泄露（密钥、真实会话内容、个人信息）先停下告诉用户，不要自己"悄悄修掉"后继续

## 常用命令
```bash
npm run dev                  # tsx watch src/main.ts
npm start                    # 前台运行
npm test                     # node:test（含 recordings 回放）
npm run typecheck            # 后端 + PWA
npm run web:install && npm run web:build   # 构建 PWA 到 web/dist，Hub 托管在 /
npm run web:dev              # PWA 开发服务器（/api、/ws 代理到 127.0.0.1:7788）
npm run hub -- pair          # 一次性配对码
npm run hub -- devices list | revoke <name|id>
npm run record -- claude|codex|cursor   # 录一份新的事件流（录完必须脱敏）
npm run sanitize [-- --check]           # 录制脱敏 / 检查
npm run gen:codex            # 重新生成 Codex app-server 协议 TS 类型
bash scripts/install-launchd.sh install|status|restart|uninstall   # 常驻（改代码后用 restart）
bash scripts/tailscale-serve.sh [off]   # 手机访问的 HTTPS
```
Hub 装成 LaunchAgent 后常驻占用 7788，开发时不要再 `npm run dev` 抢端口；curl 用 `127.0.0.1:7788`，不要省略主机。

## 工作方式
- 改协议解析：先补 / 更新 `recordings/` 样本（并脱敏）和对应测试，再改实现
- spec 与本机实际不一致：以实际为准，更新 `01-verified-facts.md`，并在提交说明里写明
- 改 PWA：同时检查浅色 / 深色两套主题，以及手机（< 900px）与电脑（≥ 900px）两种布局；颜色只用 `style.css` 里的设计令牌
- 交付前跑 `npm test` 与 `npm run typecheck`；UI 改动要实际打开页面看过
- 提交信息用中文，小步提交；不要顺手重构与当前任务无关的模块
