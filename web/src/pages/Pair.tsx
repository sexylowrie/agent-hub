import { useState } from 'preact/hooks'
import { api, auth } from '../api.ts'
import { hub } from '../ws.ts'
import { navigate } from '../util.ts'

function defaultName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  return '浏览器'
}

export function Pair({ code: initialCode }: { code?: string }) {
  const [code, setCode] = useState(initialCode ?? '')
  const [name, setName] = useState(auth.device() || defaultName())
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: Event) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const r = await api<{ token: string; deviceId: string }>('/api/pair', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), deviceName: name.trim() }),
      })
      auth.save(r.token, name.trim())
      hub.stop()
      hub.start()
      navigate('#/')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="page narrow">
      <h1>配对 Agent Hub</h1>
      <p class="hint">
        在 Mac 终端运行 <code>npm run hub -- pair</code>，输入打印出的 6 位配对码（5 分钟内有效，只能用一次）。
      </p>
      <form onSubmit={submit} class="form">
        <label>
          Hub 地址
          <input value={location.host} disabled />
        </label>
        <label>
          配对码
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoFocus
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
            placeholder="6 位数字"
          />
        </label>
        <label>
          设备名
          <input value={name} maxLength={64} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {err && <div class="error">{err}</div>}
        <button class="primary" disabled={busy || code.length !== 6 || !name.trim()}>
          {busy ? '配对中…' : '配对'}
        </button>
      </form>
    </div>
  )
}
