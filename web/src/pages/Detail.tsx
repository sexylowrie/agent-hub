import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { hub, sessions } from '../ws.ts'
import { useStore } from '../store.ts'
import type { Decision, SessionDetail, StoredEvent } from '../types.ts'
import { eventBlocks, historyBlocks, hubTurnOpen, splitAt, type Block } from '../timeline.ts'
import { STATE_REASON, VENDOR_LABEL, badgeOf, navigate, shortCwd, summarize } from '../util.ts'
import { StatusDot } from './List.tsx'

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function ToolBlock({ b }: { b: Extract<Block, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)
  return (
    <div class={`tool ${b.isError ? 'bad' : ''}`}>
      <button class="tool-head" onClick={() => setOpen(!open)}>
        <span class="caret">{open ? '▾' : '▸'}</span>
        <span class="tool-name">{b.name}</span>
        <span class="tool-sum">{summarize(b.input, 80)}</span>
        {!b.done && <span class="spinner" />}
      </button>
      {open && (
        <div class="tool-body">
          {input && <pre>{input}</pre>}
          {b.output && <pre class="out">{b.output}</pre>}
        </div>
      )}
    </div>
  )
}

const DECISION_LABEL: Record<Decision, string> = { allow: '已允许', deny: '已拒绝', allow_session: '本会话允许' }

function ApprovalCard({ b, actionable }: { b: Extract<Block, { kind: 'approval' }>; actionable: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const live = actionable && !b.decision
  const now = useNow(live)
  const left = Math.max(0, Math.round((b.expiresAt - now) / 1000))
  const expired = !b.decision && (left === 0 || !actionable)
  const decide = async (decision: Decision) => {
    setBusy(true)
    setErr('')
    const r = await hub.request({ t: 'approve', approvalId: b.approvalId, decision })
    setBusy(false)
    if (!r.ok) setErr(r.message)
  }
  const [open, setOpen] = useState(false)
  return (
    <div class={`approval ${live && !expired ? 'live' : ''}`}>
      <div class="approval-head">
        <strong>需要审批</strong>
        <span class="grow" />
        {b.decision ? (
          <span class="badge mute">{b.by === 'expired' ? '已过期（拒绝）' : DECISION_LABEL[b.decision]}</span>
        ) : expired ? (
          <span class="badge mute">已失效</span>
        ) : (
          <span class="badge warn">
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </span>
        )}
      </div>
      <div class="approval-sum">{b.summary}</div>
      {b.detail !== undefined && b.detail !== null && (
        <button class="link" onClick={() => setOpen(!open)}>
          {open ? '收起详情' : '查看详情'}
        </button>
      )}
      {open && <pre>{JSON.stringify(b.detail, null, 2)}</pre>}
      {live && !expired && (
        <div class="approval-actions">
          <button class="danger" disabled={busy} onClick={() => decide('deny')}>
            拒绝
          </button>
          <button disabled={busy} onClick={() => decide('allow_session')}>
            本会话允许
          </button>
          <button class="primary" disabled={busy} onClick={() => decide('allow')}>
            允许
          </button>
        </div>
      )}
      {err && <div class="error">{err}</div>}
    </div>
  )
}

function BlockView({ b, pending }: { b: Block; pending: Set<string> }) {
  switch (b.kind) {
    case 'user':
      return <div class="msg user">{b.text}</div>
    case 'assistant':
      return <div class="msg assistant">{b.text}</div>
    case 'tool':
      return <ToolBlock b={b} />
    case 'approval':
      return <ApprovalCard b={b} actionable={pending.has(b.approvalId)} />
    case 'done':
      return (
        <div class={`turn-end ${b.status}`}>
          {b.status === 'success' ? '完成' : b.status === 'interrupted' ? '已中断' : '出错'}
          {b.durationMs ? ` · ${(b.durationMs / 1000).toFixed(1)}s` : ''}
          {b.status === 'error' && b.resultText ? `：${b.resultText}` : ''}
        </div>
      )
    case 'error':
      return <div class="turn-end error">{b.message}</div>
  }
}

export function Detail({ id }: { id: string }) {
  const map = useStore(sessions)
  const [detail, setDetail] = useState<SessionDetail>()
  const [loadErr, setLoadErr] = useState('')
  /** REST 载入时已覆盖到的 seq；之后的实时事件接在厂商历史后面 */
  const [baseSeq, setBaseSeq] = useState(0)
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [text, setText] = useState('')
  const [force, setForce] = useState(false)
  const [sendErr, setSendErr] = useState('')
  const [sending, setSending] = useState(false)
  const stick = useRef(true)
  const refetchTimer = useRef<number>()

  const load = async () => {
    try {
      const d = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}?messages=200`)
      const split = d.messages ? splitAt(d.messages, d.events) : { history: undefined, baseSeq: 0 }
      setDetail({ ...d, messages: split.history })
      setLoadErr('')
      setBaseSeq(split.baseSeq)
      setEvents((cur) => mergeEvents(d.events, cur))
      setPending(new Set((d.pendingApprovals ?? []).map((a) => a.id)))
    } catch (e) {
      setLoadErr((e as Error).message)
    }
  }

  useEffect(() => {
    hub.subscribe(id)
    void load()
    const offEvent = hub.onEvent((e, seq) => {
      if (!('sessionId' in e) || e.sessionId !== id || !seq) return
      setEvents((cur) => mergeEvents(cur, [{ seq, event: e }]))
      if (e.type === 'approval.request') setPending((p) => new Set(p).add(e.approvalId))
      if (e.type === 'approval.decided')
        setPending((p) => {
          const n = new Set(p)
          n.delete(e.approvalId)
          return n
        })
      // 轮次结束后厂商文件已写完，重拉历史，替换掉实时拼出来的部分
      if (e.type === 'turn.done') {
        clearTimeout(refetchTimer.current)
        refetchTimer.current = window.setTimeout(() => void load(), 1200)
      }
    })
    // 重连后补拉（Hub 重启过则 WS 补发不含本会话，靠 REST 兜底）
    const offSnap = hub.onSnapshot(() => void load())
    return () => {
      hub.unsubscribe(id)
      offEvent()
      offSnap()
      clearTimeout(refetchTimer.current)
    }
  }, [id])

  const session = map.get(id) ?? detail
  const blocks = useMemo(() => {
    if (!detail) return []
    if (detail.messages) {
      // 厂商历史 + 载入之后的实时事件；已载入部分里仍待处理的审批单独补上卡片
      const liveEvents = events.filter((e) => e.seq > baseSeq)
      const approvalsBefore = eventBlocks(events.filter((e) => e.seq <= baseSeq)).filter(
        (b) => b.kind === 'approval' && pending.has(b.approvalId),
      )
      return [...historyBlocks(detail.messages), ...approvalsBefore, ...eventBlocks(liveEvents)]
    }
    return eventBlocks(events)
  }, [detail, events, baseSeq, pending])

  useEffect(() => {
    // 滚到页面最底（输入栏是 sticky 的，scrollIntoView 会让最后一条被它盖住）
    if (stick.current) window.scrollTo(0, document.documentElement.scrollHeight)
  }, [blocks.length, blocks[blocks.length - 1]])

  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!session) {
    return (
      <div class="page">
        <header class="bar">
          <button class="ghost" onClick={() => navigate('#/')}>
            ‹ 返回
          </button>
        </header>
        <p class="empty">{loadErr || '加载中…'}</p>
      </div>
    )
  }

  const badge = badgeOf(session)
  const blockedReason = !session.resumable ? (session.unresumableReason ?? '该会话不可续聊') : STATE_REASON[session.state]
  const canInterrupt = (session.state === 'running' || session.state === 'awaiting_approval') && hubTurnOpen(events)

  const send = async (e: Event) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || blockedReason) return
    setSending(true)
    setSendErr('')
    stick.current = true
    const r = await hub.request({ t: 'send', sessionId: id, text: t, ...(session.vendor === 'cursor' && force ? { force: true } : {}) })
    setSending(false)
    if (r.ok) setText('')
    else setSendErr(`${r.message}${r.code === 'OFFLINE' || r.code === 'TIMEOUT' ? '' : `（${r.code}）`}`)
  }

  const interrupt = async () => {
    const r = await hub.request({ t: 'interrupt', sessionId: id })
    if (!r.ok) setSendErr(r.message)
  }

  return (
    <div class="page detail">
      <header class="bar sticky">
        <button class="ghost" onClick={() => navigate('#/')}>
          ‹
        </button>
        <div class="bar-title">
          <div class="title">{session.title || '（无标题）'}</div>
          <div class="sub">
            {VENDOR_LABEL[session.vendor]} · {shortCwd(session.cwd)}
          </div>
        </div>
        <span class={`badge ${badge.cls}`}>{badge.label}</span>
        <StatusDot />
      </header>
      <div class="timeline">
        {loadErr && <div class="error">{loadErr}</div>}
        {detail && blocks.length === 0 && <p class="empty">暂无消息</p>}
        {blocks.map((b) => (
          <BlockView key={b.key} b={b} pending={pending} />
        ))}
        {session.state === 'running' && !canInterrupt && <div class="turn-end">运行中…</div>}
      </div>
      <form class="composer" onSubmit={send}>
        {blockedReason && <div class="hint">{blockedReason}</div>}
        {sendErr && <div class="error">{sendErr}</div>}
        {session.vendor === 'cursor' && (
          <label class="toggle">
            <input type="checkbox" checked={force} onChange={(e) => setForce((e.target as HTMLInputElement).checked)} />
            放行执行（--force）：Cursor 没有中途审批，默认在沙箱里跑；勾选后不受沙箱限制
          </label>
        )}
        <div class="composer-row">
          <textarea
            rows={1}
            value={text}
            disabled={!!blockedReason}
            placeholder={blockedReason ? '暂不可续聊' : '接着说…'}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement
              setText(el.value)
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`
            }}
          />
          {canInterrupt ? (
            <button type="button" class="danger" onClick={interrupt}>
              中断
            </button>
          ) : (
            <button class="primary" disabled={!!blockedReason || sending || !text.trim()}>
              发送
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function mergeEvents(a: StoredEvent[], b: StoredEvent[]): StoredEvent[] {
  const m = new Map<number, StoredEvent>()
  for (const e of a) m.set(e.seq, e)
  for (const e of b) m.set(e.seq, e)
  return [...m.values()].sort((x, y) => x.seq - y.seq)
}
