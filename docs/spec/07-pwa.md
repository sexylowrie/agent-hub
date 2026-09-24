# 07 · PWA（M2）

## 栈
Vite + Preact + TypeScript；`web/` 独立 package；构建产物由 Hub 用 hono 静态托管在 `/`。类型从 `../src/core/events.ts` 直接 import（tsconfig paths）。

## 视觉与主题（2026-09-24，设计稿 `docs/mockups/ui-refresh.html`）
- iOS 风格：大标题 + 毛玻璃导航栏（滚动后出分隔线）、inset grouped 圆角卡片、分段控件；厂商用渐变头像块（C / Cx / Cu），右下角小圆点表示运行中（蓝色呼吸）/ 待审批（琥珀）/ 出错。
- 颜色全部是 CSS 变量，`[data-theme=light|dark]` 两套。主题三档：跟随系统（默认）/ 浅色 / 深色，设置页选，列表导航栏一键切换；存 localStorage `agenthub.theme`。`index.html` 内联脚本在首帧前设好 `data-theme` 与 `theme-color`（不闪），跟随系统时监听 `prefers-color-scheme`。
- AI 回复走 `web/src/markdown.ts` 轻量渲染（段落、粗体、斜体、行内代码、代码块、列表、标题、引用、分隔线、http(s) 链接），先转义再加标签，不输出原始 HTML；列表预览用 `stripMarkdown` 去标记。
- 工具块按工具名关键词配图标（终端 / 文件 / 搜索 / 网络），状态：转圈 / 对勾 / 叉。审批卡片：琥珀描边 + 倒计时圆环 + 三个大按钮。
- 输入栏悬浮圆角，Hub 轮次进行中发送键变红色"停止"（interrupt）；上翻离开底部时有新内容出"↓ 新消息"。
- 加载用骨架屏；发送 / 审批 / 中断失败用顶部 toast。
- 构建注意：`vite.config.ts` 写了 `build.cssTarget`，样式里只写标准 `backdrop-filter`，由压缩器补 `-webkit-`（两种都手写时压缩器会只留一个，Chrome 上毛玻璃失效，实测）。

## 手机端 / 电脑端适配（断点 900px，`web/src/ui.tsx` 的 `WIDE_QUERY` 与 style.css 保持一致）
- **手机（< 900px）**：单栏，按路由切页。输入控件字号 16px（iOS 小于 16px 聚焦会放大页面）；图标按钮 40px、发送键 36px；导航栏左右留 `safe-area-inset`（横屏刘海）；Enter 始终换行。
- **电脑（≥ 900px）**：左右分栏。左栏常驻会话列表（固定定位、独立滚动，宽 `clamp(340px, 30vw, 420px)`），右栏按路由显示详情 / 新建 / 设置，没有选中时显示占位；当前会话在左栏高亮；右栏内容最宽 820px 居中；"返回会话列表"按钮隐藏（`.to-list`）。
- 电脑端（`pointer: fine`）Enter 发送、Shift+Enter 换行；输入法选词中的 Enter（`isComposing` / keyCode 229）不发送。
- 悬停效果只在 `(hover: hover) and (pointer: fine)` 下生效，避免手机点完残留 :hover；键盘焦点有 `focus-visible` 描边，会话行可 Enter 打开。

## 页面
1. **配对页**：PWA 由 Hub 自己托管，host 即 `location.host`（只读显示）；输入 6 位码与设备名 → 存 token 到 localStorage。`npm run hub -- pair` 会打印 `http://<host>/#/pair?code=<code>`，打开即预填。
2. **会话列表**（设计稿 `docs/mockups/session-list-grouped.html` 方案 C，2026-09-24 定稿）：
   - 顶部只有一排厂商筛选（全部 / Claude / Codex / Cursor，带会话数），记在 localStorage；不再单独筛状态。
   - 按状态分组，从上到下：**待审批 → 运行中 → 可续聊 → 出错 → 其他**。归组规则（`web/src/util.ts` 的 `groupOf`）：`awaiting_approval` / `running` / `error` 各自成组；`idle` 且可续接且未归档为「可续聊」；其余（已归档、不可续接、unknown）进「其他」，行上保留"已归档 / 不可续接"徽标。
   - 组可折叠，**默认只展开一个组**：按上面的顺序第一个有会话的组。用户手动展开/折叠后按用户的来（sessionStorage，本次打开期间有效）；例外：出现**新的**待审批会话时自动展开「待审批」（审批 5 分钟过期，不能被折叠藏住），之后仍可手动折叠，下一个新审批再展开。折叠的组标题后显示前 3 个会话标题。
   - 组内**竖排**（横排在"可续聊"上百个时没法用，见设计稿对比），按 `vendorUpdatedAt ?? updatedAt` 倒序（`updatedAt` 每次扫描都会变，不适合排序）；每组先显示 5 个，超出的点「展开全部 N 个」。
   - 行：厂商色条、标题、来源标签（`origin`：desktop→GUI、cli→CLI、hub→Hub，详情页标题栏同样显示）、cwd 末两段、相对时间、preview。运行中的行 preview 随 `session.upsert` 实时刷新，状态变化时行会移到对应组。
3. **会话详情**：消息流（user/assistant 气泡）、工具调用折叠块（name + input 摘要，展开看 output）、审批卡片（允许/拒绝/本会话允许 + 倒计时）。底部输入框：`running` / `awaiting_approval` / 不可续聊时禁用并显示原因（`error` 不禁用：Hub 轮次失败后会话是 error，send 前 Hub 会实时复核状态，由服务端决定）；Cursor 会话多一个"放行执行(--force)"开关，默认关。Hub 轮次进行中显示"中断"。
4. **新建**：厂商单选、cwd 下拉（来自 `/api/health` 返回的 allowedCwds）+ 可选子目录、首句；ack 后等 `turn.started` 拿到真实会话 id 再跳详情。
5. **设置**：Hub 版本与三家二进制状态、推送开关（M3）、退出配对。

## 详情页的数据拼接
- 三家都有厂商历史（`messages`：Claude 读会话 jsonl、Codex 读 rollout、Cursor 读 IDE 库 + ~/.cursor/chats），只读文件末尾 2MB。
- 渲染 = 厂商历史 + 分界 seq 之后的实时事件。分界：载入时没有未结束的轮次取最新 seq；有则取该轮 `turn.started` 之前，并把历史里同一轮（从该轮用户消息起）裁掉（`web/src/timeline.ts` 的 `splitAt`）。
- `turn.done` 后 1.2s 重拉详情，用厂商历史替换实时拼出来的部分。
- 已载入部分里仍待处理的审批靠 REST 的 `pendingApprovals` 补卡片；过期/已决定的只显示结果。

## 行为
- WS 断线指数退避重连（1s 起翻倍，封顶 30s，±30% 抖动），带 `sinceSeq`；25s 心跳 ping，10s 无 pong 主动断开重连；页面回到前台 / `online` 事件时立即重连。
- 每次拿到 snapshot，打开着的详情页重拉 REST（Hub 重启后进程内订阅记录丢失，WS 补发不含该会话，靠 REST 兜底）。
- `message.delta` 在客户端按 turnId 拼接。
- Service Worker（`web/public/sw.js`）：页面网络优先、失败用缓存的壳；`/assets/*` 缓存优先；不碰 `/api` 与 `/ws`。只在安全上下文注册（127.0.0.1 或 HTTPS；`http://<tailscale-ip>` 不行）。Web Push 订阅（需 HTTPS，见 M3 的 Tailscale 证书），推送内容只有 `approval.request` 与 `turn.done`。
- 移动端优先，≥ 390px 宽即可，不做桌面布局。
