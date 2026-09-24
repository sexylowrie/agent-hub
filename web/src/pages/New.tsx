import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { hub } from '../ws.ts'
import type { Health, Vendor } from '../types.ts'
import { VENDOR_LABEL, navigate } from '../util.ts'
import { toast } from '../toast.ts'
import { IconBack } from '../icons.tsx'
import { Navbar, Switch } from '../ui.tsx'

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

  useEffect(() => {
    api<Health>('/api/health')
      .then((h) => {
        setHealth(h)
        setRoot(h.allowedCwds?.[0] ?? '')
      })
      .catch((e) => toast((e as Error).message))
  }, [])

  const cwd = sub.trim() ? `${root.replace(/\/$/, '')}/${sub.trim().replace(/^\/+/, '')}` : root

  const submit = async (e: Event) => {
    e.preventDefault()
    setStatus('发起中…')
    const r = await hub.request({ t: 'start', vendor, cwd, text: text.trim(), ...(vendor === 'cursor' && force ? { force: true } : {}) })
    if (!r.ok) {
      setStatus('')
      return toast(`${r.message}（${r.code}）`)
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
        toast(ev.type === 'error' ? ev.message : `启动失败：${ev.resultText ?? ev.status}`)
      }
    })
    const timer = window.setTimeout(() => {
      off()
      setStatus('')
      toast('等待超时：会话可能仍在创建，稍后回列表查看', 'info')
    }, START_TIMEOUT_MS)
  }

  const vendorOk = (v: Vendor) => health?.vendors[v]?.ok !== false

  return (
    <div class="page">
      <Navbar>
        <div class="nav-row">
          <button class="back to-list" onClick={() => navigate('#/')}>
            <IconBack size={22} />
            会话
          </button>
        </div>
        <h1 class="large-title">新建会话</h1>
      </Navbar>
      <form onSubmit={submit}>
        <div class="seg">
          {VENDORS.map((v) => (
            <button type="button" class={vendor === v ? 'on' : ''} disabled={!vendorOk(v)} onClick={() => setVendor(v)}>
              <span class={`vdot ${v}`} />
              {VENDOR_LABEL[v]}
            </button>
          ))}
        </div>
        <div class="sec-h">工作目录</div>
        <div class="card">
          <label class="cell">
            <span class="k">根目录</span>
            <select value={root} onChange={(e) => setRoot((e.target as HTMLSelectElement).value)}>
              {(health?.allowedCwds ?? []).map((c) => (
                <option value={c}>{c.replace(/^\/Users\/[^/]+/, '~')}</option>
              ))}
            </select>
          </label>
          <label class="cell">
            <span class="k">子目录</span>
            <input value={sub} placeholder="可选，如 agent-hub" onInput={(e) => setSub((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <p class="sec-f">{cwd || '—'}</p>
        <div class="sec-h">首句</div>
        <div class="card">
          <div class="cell stack">
            <textarea value={text} placeholder="想让它做什么？" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          </div>
        </div>
        {vendor === 'cursor' && (
          <>
            <div class="sec-h" />
            <div class="card">
              <div class="cell">
                <span>放行执行（--force）</span>
                <span class="grow" />
                <Switch tone="warn" checked={force} onChange={setForce} />
              </div>
            </div>
            <p class="sec-f">Cursor 没有中途审批，默认在沙箱里跑；打开后不受沙箱限制。</p>
          </>
        )}
        <div class="form-foot">
          <button class="btn go block" disabled={!!status || !cwd || !text.trim()}>
            {status || '开始'}
          </button>
        </div>
      </form>
    </div>
  )
}
