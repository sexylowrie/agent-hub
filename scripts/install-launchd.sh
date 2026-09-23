#!/usr/bin/env bash
# 把 Hub 装成当前用户的 LaunchAgent：登录自启、崩溃/被杀后 1 秒内拉起。
#   bash scripts/install-launchd.sh install     # 构建 PWA、写 plist、加载并启动
#   bash scripts/install-launchd.sh uninstall   # 停止并删除 plist
#   bash scripts/install-launchd.sh status      # 查看运行状态
#   bash scripts/install-launchd.sh restart     # launchctl kickstart -k
# 日志：~/Library/Logs/agent-hub/hub.log
set -euo pipefail

LABEL=com.agenthub.hub
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/agent-hub"
DOMAIN="gui/$(id -u)"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

install() {
  local node
  node="$(command -v node)" || { echo "找不到 node"; exit 1; }
  [ -f "$ROOT/hub.config.json" ] || { echo "缺少 $ROOT/hub.config.json（先 cp hub.config.example.json hub.config.json）"; exit 1; }
  [ -d "$ROOT/node_modules/tsx" ] || (cd "$ROOT" && npm install)
  [ -d "$ROOT/web/node_modules" ] || (cd "$ROOT" && npm run web:install)
  (cd "$ROOT" && npm run web:build)
  mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
  # PATH 用安装时的：launchd 默认 PATH 找不到 claude/agent，Hub 轮次里 agent 执行命令也要用到用户的工具链
  # 直接 node --import tsx 单进程运行（tsx CLI 会再起一个子进程，kill -9 父进程时子进程会占着端口）
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(printf %s "$node" | xml_escape)</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>--import</string><string>tsx</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(printf %s "$ROOT" | xml_escape)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(printf %s "$PATH" | xml_escape)</string>
    <key>HUB_CONFIG</key><string>$(printf %s "$ROOT/hub.config.json" | xml_escape)</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(printf %s "$LOG_DIR/hub.log" | xml_escape)</string>
  <key>StandardErrorPath</key><string>$(printf %s "$LOG_DIR/hub.log" | xml_escape)</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart "$DOMAIN/$LABEL"
  echo "已安装并启动 ${LABEL}，日志 ${LOG_DIR}/hub.log"
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 ${LABEL}"
}

status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\t(state|pid|last exit code|runs) =' || echo "${LABEL} 未加载"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "已重启" ;;
  *) echo "用法：bash scripts/install-launchd.sh install|uninstall|status|restart"; exit 1 ;;
esac
