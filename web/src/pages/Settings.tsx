import { useEffect, useState } from 'preact/hooks'
import { api, auth } from '../api.ts'
import { hub } from '../ws.ts'
import type { Health } from '../types.ts'
import { VENDOR_LABEL, navigate } from '../util.ts'
import { PushToggle } from '../push.tsx'

export function Settings() {
  const [health, setHealth] = useState<Health>()
  const [err, setErr] = useState('')
  useEffect(() => {
    api<Health>('/api/health')
      .then(setHealth)
      .catch((e) => setErr((e as Error).message))
  }, [])

  const unpair = () => {
    if (!confirm('退出后需要重新配对，确定？')) return
    auth.clear()
    hub.stop()
    navigate('#/pair')
  }

  return (
    <div class="page narrow">
      <header class="bar">
        <button class="ghost" onClick={() => navigate('#/')}>
          ‹ 返回
        </button>
        <h1>设置</h1>
      </header>
      {err && <div class="error">{err}</div>}
      <section class="card">
        <h2>Hub</h2>
        <div class="kv">
          <span>地址</span>
          <span>{location.host}</span>
        </div>
        <div class="kv">
          <span>版本</span>
          <span>{health?.version ?? '—'}</span>
        </div>
        <div class="kv">
          <span>本设备</span>
          <span>{auth.device() || '—'}</span>
        </div>
        {health &&
          Object.entries(health.vendors).map(([v, s]) => (
            <div class="kv">
              <span>{VENDOR_LABEL[v as keyof typeof VENDOR_LABEL]}</span>
              <span class={s.ok ? '' : 'bad'}>{s.ok ? s.version : `不可用：${s.error ?? ''}`}</span>
            </div>
          ))}
      </section>
      <section class="card">
        <h2>通知</h2>
        <PushToggle health={health} />
      </section>
      <button class="danger" onClick={unpair}>
        退出配对
      </button>
    </div>
  )
}
