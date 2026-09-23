import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { hub } from '../ws.ts'
import type { Health, Vendor } from '../types.ts'
import { VENDOR_LABEL, navigate } from '../util.ts'

const VENDORS: Vendor[] = ['claude', 'codex', 'cursor']
const START_TIMEOUT_MS = 60_000

export function New() {
  const [health, setHealth] = useState<Health>()
  const [vendor, setVendor] = useState<Vendor>('claude')
  const [root, setRoot] = useState('')
  const [sub, setSub] = useState('')
  const [text, setText] = useState('')
  const [force, setForce] = useState(false)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    api<Health>('/api/health')
      .then((h) => {
        setHealth(h)
        setRoot(h.allowedCwds?.[0] ?? '')
      })
      .catch((e) => setErr((e as Error).message))
  }, [])

  const cwd = sub.trim() ? `${root.replace(/\/$/, '')}/${sub.trim().replace(/^\/+/, '')}` : root

  const submit = async (e: Event) => {
    e.preventDefault()
    setErr('')
    setStatus('发起中…')
    const r = await hub.request({ t: 'start', vendor, cwd, text: text.trim(), ...(vendor === 'cursor' && force ? { force: true } : {}) })
    if (!r.ok) {
      setStatus('')
      return setErr(`${r.message}（${r.code}）`)
    }
    const turnId = (r.data as { turnId: string }).turnId
    setStatus('已发起，等待会话创建…')
    // turn.started 带真实会话 id；在它之前失败的轮次事件挂在 pending:<turnId> 上
    const off = hub.onEvent((ev) => {
      if (ev.type === 'turn.started' && ev.turnId === turnId) {
        off()
        clearTimeout(timer)
        navigate(`#/s/${encodeURIComponent(ev.sessionId)}`)
      } else if ('sessionId' in ev && ev.sessionId === `pending:${turnId}` && (ev.type === 'error' || ev.type === 'turn.done')) {
        off()
        clearTimeout(timer)
        setStatus('')
        setErr(ev.type === 'error' ? ev.message : `启动失败：${ev.resultText ?? ev.status}`)
      }
    })
    const timer = window.setTimeout(() => {
      off()
      setStatus('')
      setErr('等待超时：会话可能仍在创建，稍后回列表查看')
    }, START_TIMEOUT_MS)
  }

  const vendorOk = (v: Vendor) => health?.vendors[v]?.ok !== false

  return (
    <div class="page narrow">
      <header class="bar">
        <button class="ghost" onClick={() => navigate('#/')}>
          ‹ 返回
        </button>
        <h1>新建会话</h1>
      </header>
      <form class="form" onSubmit={submit}>
        <div class="seg">
          {VENDORS.map((v) => (
            <button type="button" class={`${vendor === v ? 'on' : ''} ${v}`} disabled={!vendorOk(v)} onClick={() => setVendor(v)}>
              {VENDOR_LABEL[v]}
            </button>
          ))}
        </div>
        <label>
          目录
          <select value={root} onChange={(e) => setRoot((e.target as HTMLSelectElement).value)}>
            {(health?.allowedCwds ?? []).map((c) => (
              <option value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          子目录（可选）
          <input value={sub} placeholder="如 agent-hub" onInput={(e) => setSub((e.target as HTMLInputElement).value)} />
        </label>
        <div class="hint">工作目录：{cwd || '—'}</div>
        <label>
          首句
          <textarea rows={4} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        </label>
        {vendor === 'cursor' && (
          <label class="toggle">
            <input type="checkbox" checked={force} onChange={(e) => setForce((e.target as HTMLInputElement).checked)} />
            放行执行（--force）
          </label>
        )}
        {err && <div class="error">{err}</div>}
        {status && <div class="hint">{status}</div>}
        <button class="primary" disabled={!!status || !cwd || !text.trim()}>
          开始
        </button>
      </form>
    </div>
  )
}
