import type { Health } from './types.ts'

/** Web Push 开关（M3 实现订阅；此处先占位说明条件） */
export function PushToggle({ health }: { health?: Health }) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    return <p class="hint">审批推送需要 HTTPS 访问（Tailscale 证书）才能开启。</p>
  }
  if (!health?.push) return <p class="hint">Hub 未启用推送。</p>
  return <p class="hint">推送可用。</p>
}
