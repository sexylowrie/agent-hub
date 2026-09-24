# 06 · Gateway 与鉴权

## 监听
- 只绑定 `config.listen.host`：默认 `127.0.0.1`；接手机时改为 Tailscale IP（`tailscale ip -4`）。启动时若 host 为 `0.0.0.0` 直接拒绝启动。
- HTTP 与 WS 同端口（默认 7788）。
- **HTTPS（M3）**：用 `tailscale serve --bg --https=443 http://127.0.0.1:7788`（`scripts/tailscale-serve.sh`），由 Tailscale 终止 TLS、自动续期证书，反代到本机。Hub 保持只监听 127.0.0.1，不自己管证书；手机访问 `https://<mac>.<tailnet>.ts.net`。该地址写到 `publicUrl`，配对链接会用它。

## 作为库嵌入（v0.2）
- `createApp(deps)` 只定义相对路由（`/api/*`），嵌入方用 Hono `app.route('/hub', createApp(deps))` 挂到任意前缀下。
- `attachWs(server, deps, { wsPath, destroyUnmatched })`：`wsPath` 默认 `/ws`；`destroyUnmatched` 默认 `true`（独立运行时路径不对的 upgrade 直接断开），同一 server 上还有别的 WS 处理器时设为 `false` 放行。
- `deps.authenticate?(token) → DeviceRow | undefined`：REST Bearer、`/api/health` 的"是否已登录"与 WS `hello` 共用；缺省按设备 token 查库。嵌入方可以先认自己的凭据（如 dougan 的机器 token）再回落到 `authenticate(store, token)`。**这不放开鉴权**：未命中仍是 401 / 4401，注入方对自己认的凭据负责（只认它能验证的，不能无条件返回设备）。
- `deps.allowedCwds()` 只用于已登录 `/api/health` 的提示；真正的 cwd 校验在 `Hub` 的 `isCwdAllowed`。
- 独立运行（`npm start`）仍走 `startGateway(deps, cfg.listen)`，行为不变。

## Web Push（M3）
- `GET /api/health`（已鉴权）带 `push.vapidPublicKey`；`POST /api/push/subscribe`（PushSubscription JSON）、`POST /api/push/unsubscribe {endpoint}`、`POST /api/push/test`。
- 只推两类：`approval.request`、**Hub 轮次**的 `turn.done`（桌面端自己跑完的不推）。内容 `{title, body, url, tag}`，按 RFC 8291 aes128gcm 加密、RFC 8292 VAPID 签名（`src/gateway/push.ts`，只用 node:crypto）。
- iOS 只有"添加到主屏幕"后从图标打开的 PWA 才能订阅推送。

## 配对
1. 终端 `npm run hub -- pair` → 生成 6 位数字码写入 `pairing_codes`，5 分钟过期，终端打印码与二维码（二维码内容 `agenthub://pair?host=<host>:<port>&code=<code>`；二维码用纯 ASCII 库不引入依赖的话，先只打印文本，M2 再在 PWA 里做手输）。
2. 客户端 `POST /api/pair {code, deviceName}` → 校验未过期未使用 → 生成 32 字节随机 token → 存 `sha256(token)` → 返回明文 token 一次。
3. 之后 WS `hello{token}` / REST Bearer 校验哈希；命中更新 `last_seen`。
4. `npm run hub -- devices list|revoke <name>`。

## 授权规则
- `start` 的 `cwd` 必须在 `allowedCwds` 前缀内（展开 `~` 后比较真实路径），否则 `CWD_NOT_ALLOWED`。
- `send` 前检查：`resumable` 且 `state==='idle'` 且无 running `hub_turns`，否则 `NOT_RESUMABLE` / `SESSION_BUSY`；`state==='attached'` 时为 `ATTACHED`（附 `holder`）。
- `approve` 只接受 `pending` 且未过期的 approval，记录 `decided_by=deviceId`。
- 所有拒绝都返回 `ack{ok:false}` 并在日志留一行。

## 不做
- 不做用户名密码、不做 OAuth、不做多用户。
- 不做 relay；需要跨网时装 Tailscale。
