# 08 · 里程碑与验收

每个里程碑：先写测试（回放 recordings），再实现，最后跑验收命令。验收通过才进入下一个。

## M0 · 骨架 + Claude（目标 1 天）
范围：`config.ts`、`core/*`、`gateway/*`、`scanner/claude.ts`、`adapters/claude.ts`、`scripts/record.ts`、CLI 子命令 `pair / devices`。
验收：
```bash
cp hub.config.example.json hub.config.json && npm run dev            # 启动无报错
npm run hub -- pair                                                   # 打印配对码
curl -s -XPOST :7788/api/pair -d '{"code":"123456","deviceName":"cli"}' -H 'content-type: application/json'
curl -s :7788/api/sessions -H 'authorization: Bearer <token>' | jq 'length'   # ≥1，且不含 sdk-cli 会话
# 用 wscat/自写脚本：hello → 找一个 idle 的 claude 会话 → send "只回复两个字：收到"
#   期望事件序列：turn.started → message.user → message.delta* → turn.done{status:success,resultText:"收到"}
# 再发一句需要写文件的指令：期望 approval.request → approve allow → tool.call done → turn.done
# 对一个 state=running 的会话 send：期望 ack{ok:false,code:SESSION_BUSY}
npm test                                                              # 回放测试全绿
```

## M1 · Codex + Cursor（目标 1.5 天）
范围：`scanner/codex.ts` `scanner/cursor.ts` `adapters/codex.ts` `adapters/cursor.ts`、`scripts/gen-codex-types.sh`、补录 `recordings/codex/rollout-sample.jsonl` 与 `recordings/cursor/store-db-sample.json`。
验收：
```bash
curl -s :7788/api/sessions?vendor=codex ... | jq '[.[]|.resumable]|group_by(.)|map({(.[0]|tostring):length})'
#   期望 true/false 都有（无文件线程为 false）
# send 到一个 Codex GUI 建的 idle 线程 → turn.done success；对 archived 线程 send → 自动 unarchive 后成功
# send 到 Codex 需要写文件（read-only 沙箱）→ approval.request → allow → 成功
# send 到 Cursor IDE 建的会话（不带 force）→ turn.done success，session_id 不变
# Cursor 会话详情能看到 IDE 消息 + 刚才 Hub 续聊的消息（合并 ~/.cursor/chats）
# 在 Cursor IDE 里跑一个长任务时，该会话 state=running，send 被拒
npm test
```

## M2 · PWA（目标 2 天）
范围：`web/` 四个页面、Hub 静态托管、WS 重连补拉。
验收：手机浏览器打开 `http://<tailscale-ip>:7788` → 配对 → 看到三家会话 → 对 Desktop 建的 Claude 会话续聊一句并处理一次审批 → 添加到主屏幕后仍可用。

## M3 · 常驻与打磨（目标 1 天）
范围：`scripts/install-launchd.sh`、启动对账（orphaned）、按需 `caffeinate -s`、Tailscale HTTPS + Web Push、可选 `bridges/feishu.ts`（2026-09-24 用户决定不做飞书桥）。
验收：`launchctl kickstart` 后 Hub 自启；kill -9 Hub 进程 5 秒内恢复；合盖接电 30 分钟后手机仍能续聊；手机收到审批推送。

## 交付物检查
- `README.md` 状态勾选更新
- `docs/spec/01-verified-facts.md` 与实际一致
- 每个 Adapter/Scanner 至少一个回放测试
