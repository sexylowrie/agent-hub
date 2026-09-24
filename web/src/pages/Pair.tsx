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
    <div class="page">
      <div class="hero">
        <div class="logo" aria-hidden="true">
          <i style={{ height: '26px', background: '#e08a64' }} />
          <i style={{ height: '20px', background: '#19b58c' }} />
          <i style={{ height: '14px', background: '#9aa6ff' }} />
        </div>
        <h1>配对 Agent Hub</h1>
        <p>
          在 Mac 终端运行 <code>npm run hub -- pair</code>
          <br />
          输入打印出的 6 位配对码（5 分钟内有效）
        </p>
      </div>
      <form onSubmit={submit}>
        <div class="card">
          <div class="cell">
            <input
              class="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              autoFocus
              value={code}
              aria-label="配对码"
              placeholder="······"
              onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
            />
          </div>
        </div>
        <div class="sec-h">设备</div>
        <div class="card">
          <label class="cell">
            <span class="k">设备名</span>
            <input value={name} maxLength={64} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <div class="cell">
            <span class="k">Hub</span>
            <span class="grow" />
            <span class="v">{location.host}</span>
          </div>
        </div>
        {err && <p class="sec-f error">{err}</p>}
        <div class="form-foot">
          <button class="btn go block" disabled={busy || code.length !== 6 || !name.trim()}>
            {busy ? '配对中…' : '配对'}
          </button>
        </div>
      </form>
    </div>
  )
}
