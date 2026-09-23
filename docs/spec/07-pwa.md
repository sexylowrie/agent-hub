# 07 · PWA（M2）

## 栈
Vite + Preact + TypeScript；`web/` 独立 package；构建产物由 Hub 用 hono 静态托管在 `/`。类型从 `../src/core/events.ts` 直接 import（tsconfig paths）。

## 页面
1. **配对页**：输入 host:port 与 6 位码 → 存 token 到 localStorage。
2. **会话列表**：按 `updatedAt` 倒序；行：厂商色条、标题、cwd 末两段、状态徽标（运行中/空闲/待审批/已归档/不可续接）、preview。顶部筛选厂商与状态。运行中的行 preview 实时刷新。
3. **会话详情**：消息流（user/assistant 气泡）、工具调用折叠块（name + input 摘要，展开看 output）、审批卡片（允许/拒绝/本会话允许 + 倒计时）。底部输入框：state≠idle 时禁用并显示原因；Cursor 会话多一个"放行执行(--force)"开关，默认关。
4. **新建**：厂商单选、cwd 下拉（来自 `/api/health` 返回的 allowedCwds）、首句。

## 行为
- WS 断线指数退避重连，带 `sinceSeq`。
- `message.delta` 在客户端按 turnId 拼接。
- Service Worker：缓存壳；Web Push 订阅（需 HTTPS，见 M3 的 Tailscale 证书），推送内容只有 `approval.request` 与 `turn.done`。
- 移动端优先，≥ 390px 宽即可，不做桌面布局。
