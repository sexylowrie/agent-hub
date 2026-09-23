# 00 · 总览

## 目标
一个跑在 Mac 上的单进程 `agent-hub`，把 Claude Code、Codex、Cursor 三家在本机的会话统一成一个列表，让手机端可以：
1. **看会话列表**：三家混排，含标题、目录、状态、最后一句。
2. **看进度**：桌面端正在跑的会话，流式看到输出和工具调用。
3. **续聊**：桌面端空闲后，在手机上对同一个会话接着说，含权限审批。
4. **新建会话**：选厂商、选目录、发首句。

## 非目标（明确不做）
- 实时接管 GUI 正在运行的进程（三家都没有正规缝隙，见 research/01）。
- 复用或模拟厂商的 relay / Remote Control 协议。
- Chrome DevTools 协议驱动 Cursor IDE。
- 让 IDE / GUI 窗口同步显示手机上发的消息。
- 多用户、账号体系、公网部署。

## 一句话架构
`Scanner` 只读三家存储产出列表与进度 → `Core` 归一为统一事件并落 SQLite → `Gateway` 用 WebSocket/REST 给客户端；用户从手机发消息时 `Adapter` 拉起一轮 CLI 进程续接会话，跑完退出。

## 目录树
```
agent-hub/
├── src/
│   ├── main.ts
│   ├── config.ts              # 读 hub.config.json，展开 ~，校验二进制存在与版本
│   ├── core/{events,bus,store,sessions}.ts
│   ├── scanner/{claude,codex,cursor,watcher}.ts
│   ├── adapters/{types,claude,codex,cursor}.ts + codex.types.ts(生成)
│   ├── gateway/{server,auth,protocol}.ts
│   └── bridges/feishu.ts      # 可选，M3
├── web/                       # Vite + Preact PWA（M2）
├── recordings/                # 三家真实事件流 + README
├── scripts/{gen-codex-types.sh,install-launchd.sh,record.ts}
├── docs/{spec,research}
└── hub.config.json            # 从 example 复制
```

## 分层规则
- `core/` 不 import 任何 `adapters/` `scanner/` 的厂商细节；只认统一事件与 `AgentAdapter` 接口。
- 厂商相关的字段名、路径、命令行只允许出现在 `adapters/<vendor>.ts`、`scanner/<vendor>.ts`。
- `gateway/` 只认 `core/` 的类型。
