import { useEffect, useState } from 'preact/hooks'
import { api } from './api.ts'
import type { Health } from './types.ts'
import { toast } from './toast.ts'
import { Switch } from './ui.tsx'

const fromB64u = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

async function currentSub(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

/** Web Push 开关：订阅后 Hub 在审批请求与 Hub 轮次结束时推送 */
export function PushSection({ health }: { health?: Health }) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext
  const [on, setOn] = useState<boolean>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supported) return
    void currentSub().then((s) => setOn(!!s))
  }, [supported])

  const key = health?.push?.vapidPublicKey
  const ios = /iPhone|iPad/.test(navigator.userAgent)
  const note = !supported
    ? `推送需要 HTTPS 访问（tailscale serve 地址）${ios ? '，且 iOS 要先「添加到主屏幕」、从图标打开' : ''}。`
    : !key && health
      ? 'Hub 未启用推送。'
      : '需要审批、手机发起的轮次结束时通知你。'

  const enable = async () => {
    if (!key) return
    setBusy(true)
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('没有获得通知权限，请在系统设置里允许')
      const reg = await navigator.serviceWorker.ready
      const old = await reg.pushManager.getSubscription()
      // Hub 的 VAPID 公钥换过（如删了数据目录）时旧订阅不能用，重订
      if (old && old.options.applicationServerKey && new Uint8Array(old.options.applicationServerKey).join() !== fromB64u(key).join()) await old.unsubscribe()
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) }))
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) })
      setOn(true)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    try {
      const sub = await currentSub()
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
        await sub.unsubscribe()
      }
      setOn(false)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    try {
      const r = await api<{ sent: number; failed: number }>('/api/push/test', { method: 'POST' })
      toast(`已发出 ${r.sent} 条${r.failed ? `，失败 ${r.failed} 条` : ''}`, 'info')
    } catch (e) {
      toast((e as Error).message)
    }
  }

  return (
    <>
      <div class="card">
        <div class="cell">
          审批与轮次结束推送
          <span class="grow" />
          {supported && key ? (
            <Switch checked={!!on} onChange={(v) => void (busy ? undefined : v ? enable() : disable())} />
          ) : (
            <span class="v">不可用</span>
          )}
        </div>
        {on && (
          <button class="cell accent" onClick={test}>
            发送测试推送
          </button>
        )}
      </div>
      <p class="sec-f">{note}</p>
    </>
  )
}
