#!/usr/bin/env bash
# 用 tailscale serve 给 Hub 提供 HTTPS（tailnet 内可访问，证书由 Tailscale 自动签发与续期）：
#   https://<本机>.<tailnet>.ts.net  →  http://127.0.0.1:<port>
# Hub 仍只监听 127.0.0.1。首次运行若提示开启 HTTPS Certificates，按提示在 Tailscale 管理后台打开。
#   bash scripts/tailscale-serve.sh          # 开启并打印地址
#   bash scripts/tailscale-serve.sh off      # 关闭
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(command -v tailscale || true)"
[ -n "$TS" ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || { echo "找不到 tailscale（先安装 Tailscale 并登录）"; exit 1; }
PORT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/hub.config.json','utf8')).listen.port)")"

if [ "${1:-}" = "off" ]; then
  "$TS" serve --https=443 off
  echo "已关闭 tailscale serve"
  exit 0
fi

"$TS" serve --bg --https=443 "http://127.0.0.1:$PORT"
DNS="$("$TS" status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,'')))")"
echo
echo "手机访问：https://$DNS"
echo "把它写进 hub.config.json 的 \"publicUrl\"，npm run hub -- pair 打印的配对链接就会用这个地址。"
