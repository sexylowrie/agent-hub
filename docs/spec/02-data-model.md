# 02 · 数据模型（node:sqlite，单文件 `<dataDir>/hub.sqlite`）

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- hub 内部 id：`${vendor}:${vendor_session_id}`
  vendor TEXT NOT NULL,               -- claude | codex | cursor
  vendor_session_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,                         -- 无标题时取首条用户消息前 60 字
  origin TEXT NOT NULL,               -- desktop | cli | hub
  state TEXT NOT NULL,                -- idle | running | awaiting_approval | error | unknown
  resumable INTEGER NOT NULL DEFAULT 1,
  unresumable_reason TEXT,            -- 如 "codex 线程无本地会话文件"
  archived INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  last_event_seq INTEGER,
  vendor_updated_at INTEGER,          -- 厂商侧更新时间 ms
  updated_at INTEGER NOT NULL,
  UNIQUE(vendor, vendor_session_id)
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,              -- HubEvent JSON
  ts INTEGER NOT NULL
);
CREATE INDEX events_session ON events(session_id, seq);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL,                 -- command | file_write | tool | other
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,              -- 厂商原始请求，用于回执
  status TEXT NOT NULL,               -- pending | allowed | denied | expired
  decided_by TEXT,                    -- device id
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,           -- sha256(token)
  paired_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pairing_codes (
  code TEXT PRIMARY KEY,              -- 6 位数字
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE hub_turns (              -- Hub 自己发起的轮次，用于互斥与对账
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,               -- running | done | failed | orphaned
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

## 规则
- `events` 只追加；`seq` 全局单调，客户端用 `sinceSeq` 补拉。
- Scanner 产生的 `session.upsert` 不写 `events`（噪音大），只更新 `sessions`；广播给客户端即可。
- Hub 轮次内的所有事件都写 `events`；桌面端正在跑时 Scanner tail 到的进度事件也写 `events`，但 `message.delta` 合并到每 500ms 一条。
- 启动时把 `hub_turns.status='running'` 的轮次一律标为 `orphaned`（它们都属于上一个已退出的 Hub 进程），对应会话 state 置 `error` 并发 `error` 事件；pid 仍活着且命令行是厂商二进制的，SIGTERM 结束（实测 kill -9 Hub 后 claude 子进程会残留，见 01）。
- `push_subscriptions(endpoint PK, device_id, p256dh, auth, created_at)`：Web Push 订阅；推送服务回 404/410 即删除；只给未吊销设备推。VAPID 密钥存在 `<dataDir>/vapid.json`（JWK，600）。
