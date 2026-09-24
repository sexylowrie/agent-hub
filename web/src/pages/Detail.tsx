import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { hub, sessions } from '../ws.ts'
import { useStore } from '../store.ts'
import type { Decision, SessionDetail, StoredEvent } from '../types.ts'
import { eventBlocks, historyBlocks, hubTurnOpen, splitAt, type Block } from '../timeline.ts'
import { STATE_REASON, VENDOR_LABEL, navigate, shortCwd, summarize } from '../util.ts'
import { renderMarkdown } from '../markdown.ts'
import { toast } from '../toast.ts'
import { Navbar, OriginTag, Switch, useWide } from '../ui.tsx'
import { IconBack, IconCheck, IconDown, IconFile, IconGlobe, IconSearch, IconSend, IconShield, IconStop, IconTerminal, IconTool, IconX } from '../icons.tsx'

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** 工具名 → 图标（三家工具名各不相同，按关键词归类） */
function ToolIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  if (/bash|shell|command|exec|terminal|run/.test(n)) return <IconTerminal size={14} />
  if (/web|fetch|url|browser/.test(n)) return <IconGlobe size={14} />
  if (/grep|glob|search|find|list|ls/.test(n)) return <IconSearch size={14} />
  if (/edit|write|read|file|patch|notebook|change/.test(n)) return <IconFile size={14} />
  return <IconTool size={14} />
}

function ToolBlock({ b }: { b: Extract<Block, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)
  return (
    <div class={`tool ${b.isError ? 'bad' : ''}`}>
      <button class="tool-h" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="tool-ic">
          <ToolIcon name={b.name} />
        </span>
        <span class="tool-n">{b.name}</span>
        <span class="tool-s">{summarize(b.input, 80)}</span>
        {!b.done ? (
          <span class="spin" aria-label="进行中" />
        ) : b.isError ? (
          <span class="st-err">
            <IconX size={16} />
          </span>
        ) : b.output !== undefined ? (
          <span class="st-ok">
            <IconCheck size={16} />
          </span>
        ) : null}
      </button>
      {open && (
        <div class="tool-b">
          {input && input !== '{}' && (
            <>
              <div class="lbl">输入</div>
              <pre>{input}</pre>
            </>
          )}
          {b.output && (
            <>
              <div class="lbl">输出</div>
              <pre>{b.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const DECISION_LABEL: Record<Decision, string> = { allow: '已允许', deny: '已拒绝', allow_session: '本会话已允许' }
const KIND_LABEL: Record<string, string> = { command: '运行命令', file_write: '修改文件', tool: '使用工具', other: '操作' }
const RING_C = 2 * Math.PI * 16

function ApprovalCard({ b, actionable, vendor }: { b: Extract<Block, { kind: 'approval' }>; actionable: boolean; vendor: string }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const live = actionable && !b.decision
  const now = useNow(live)
  const left = Math.max(0, Math.round((b.expiresAt - now) / 1000))
  const total = useRef(Math.max(300, left))
  const expired = !b.decision && (left === 0 || !actionable)
  const active = live && !expired
  const decide = async (decision: Decision) => {
    setBusy(true)
    const r = await hub.request({ t: 'approve', approvalId: b.approvalId, decision })
    setBusy(false)
    if (!r.ok) toast(`审批失败：${r.message}`)
  }
  const status = b.decision ? (b.by === 'expired' ? '已过期（按拒绝处理）' : DECISION_LABEL[b.decision]) : expired ? '已失效' : ''
  return (
    <div class={`approval ${active ? 'live' : ''}`}>
      <div class="ap-h">
        <span class="ap-ic">
          <IconShield size={18} />
        </span>
        <div class="grow">
          <div class="ap-t">
            {active ? '需要审批' : '审批'} · {KIND_LABEL[b.approvalKind] ?? '操作'}
          </div>
          <div class="ap-k">{status || `${vendor} 请求你的许可`}</div>
        </div>
        {active && (
          <div class="ring" aria-label={`剩余 ${left} 秒`}>
            <svg width="38" height="38">
              <circle cx="19" cy="19" r="16" stroke="var(--warn-soft)" stroke-width="3" fill="none" />
              <circle
                cx="19" cy="19" r="16" stroke="var(--warn)" stroke-width="3" fill="none" stroke-linecap="round"
                stroke-dasharray={RING_C} stroke-dashoffset={RING_C * (1 - left / total.current)}
              />
            </svg>
            <span>
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </span>
          </div>
        )}
      </div>
      <div class="ap-cmd">{b.summary}</div>
      {b.detail !== undefined && b.detail !== null && (
        <button class="link" onClick={() => setOpen(!open)}>
          {open ? '收起详情' : '查看详情'}
        </button>
      )}
      {open && <pre class="ap-detail">{JSON.stringify(b.detail, null, 2)}</pre>}
      {active && (
        <div class="ap-actions">
          <button class="btn deny" disabled={busy} onClick={() => decide('deny')}>
            拒绝
          </button>
          <button class="btn soft" disabled={busy} onClick={() => decide('allow_session')}>
            本会话允许
          </button>
          <button class="btn go" disabled={busy} onClick={() => decide('allow')}>
            允许
          </button>
        </div>
      )}
    </div>
  )
}

function Assistant({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div class="assistant" dangerouslySetInnerHTML={{ __html: html }} />
}

function BlockView({ b, pending, vendor }: { b: Block; pending: Set<string>; vendor: string }) {
  switch (b.kind) {
    case 'user':
      return <div class="bubble user">{b.text}</div>
    case 'assistant':
      return <Assistant text={b.text} />
    case 'tool':
      return <ToolBlock b={b} />
    case 'approval':
      return <ApprovalCard b={b} actionable={pending.has(b.approvalId)} vendor={vendor} />
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

function DetailSkeleton() {
  return (
    <div class="timeline">
      <span class="sk" style={{ alignSelf: 'flex-end', width: '62%', height: '40px', borderRadius: '18px' }} />
      <span class="sk" style={{ width: '90%', height: '14px' }} />
      <span class="sk" style={{ width: '75%', height: '14px' }} />
      <span class="sk" style={{ width: '100%', height: '40px', borderRadius: '12px' }} />
    </div>
  )
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
  const ta = useRef<HTMLTextAreaElement>(null)
  const wide = useWide()
  const [sending, setSending] = useState(false)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
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

  const toBottom = (smooth = false) => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })

  useEffect(() => {
    // 贴底时跟着新内容滚；用户上翻着就只提示「新消息」
    if (stick.current) toBottom()
    else if (blocks.length) setUnseen(true)
  }, [blocks.length, blocks[blocks.length - 1]])

  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80
      setAtBottom(stick.current)
      if (stick.current) setUnseen(false)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!session) {
    return (
      <div class="page">
        <Navbar compact>
          <div class="nav-row">
            <button class="back to-list" onClick={() => navigate('#/')}>
              <IconBack size={22} />
              会话
            </button>
          </div>
        </Navbar>
        {loadErr ? <p class="empty">{loadErr}</p> : <DetailSkeleton />}
      </div>
    )
  }

  const blockedReason = !session.resumable ? (session.unresumableReason ?? '该会话不可续聊') : STATE_REASON[session.state]
  const canInterrupt = (session.state === 'running' || session.state === 'awaiting_approval') && hubTurnOpen(events)

  const send = async (e: Event) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || blockedReason) return
    setSending(true)
    stick.current = true
    const r = await hub.request({ t: 'send', sessionId: id, text: t, ...(session.vendor === 'cursor' && force ? { force: true } : {}) })
    setSending(false)
    if (r.ok) {
      setText('')
      if (ta.current) ta.current.style.height = ''
    } else toast(`发送失败：${r.message}`)
  }

  const interrupt = async () => {
    const r = await hub.request({ t: 'interrupt', sessionId: id })
    if (!r.ok) toast(`中断失败：${r.message}`)
  }

  const vendorLabel = VENDOR_LABEL[session.vendor]
  const hint = blockedReason ?? (session.state === 'running' ? '运行中…' : '')

  return (
    <div class="page detail">
      <Navbar compact>
        <div class="nav-row">
          <div class="nav-side" style={{ justifyContent: 'flex-start' }}>
            <button class="back to-list" onClick={() => navigate('#/')} aria-label="返回会话列表">
              <IconBack size={22} />
            </button>
          </div>
          <div class="d-title">
            <div class="t">{session.title || '（无标题）'}</div>
            <div class="s">
              <span class={`vdot ${session.vendor}`} />
              {vendorLabel}
              <OriginTag origin={session.origin} />
              {session.cwd && <span class="cwd">{shortCwd(session.cwd)}</span>}
            </div>
          </div>
          <div class="nav-side">
            <span class={`tag ${STATE_TAG[session.state]?.cls ?? ''}`}>{STATE_TAG[session.state]?.label ?? '未知'}</span>
          </div>
        </div>
      </Navbar>
      {!detail && !loadErr ? (
        <DetailSkeleton />
      ) : (
        <div class="timeline">
          {loadErr && <div class="error">{loadErr}</div>}
          {detail && blocks.length === 0 && <p class="empty">暂无消息</p>}
          {blocks.map((b) => (
            <BlockView key={b.key} b={b} pending={pending} vendor={vendorLabel} />
          ))}
        </div>
      )}
      {!atBottom && unseen && (
        <button class="jump" onClick={() => toBottom(true)}>
          <IconDown size={14} />
          新消息
        </button>
      )}
      <form class="composer" onSubmit={send}>
        {hint && (
          <div class="c-hint">
            <span class={`sdot ${session.state === 'awaiting_approval' ? 'awaiting' : session.state === 'running' ? 'running' : ''}`} />
            {hint}
          </div>
        )}
        {session.vendor === 'cursor' && !blockedReason && (
          <div class="force">
            <Switch small tone="warn" checked={force} onChange={setForce} />
            <span>放行执行（--force）：Cursor 没有中途审批，默认在沙箱里跑；打开后不受沙箱限制</span>
          </div>
        )}
        <div class="c-box">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            disabled={!!blockedReason}
            placeholder={blockedReason ? '暂不可续聊' : wide ? '接着说…（Enter 发送，Shift+Enter 换行）' : '接着说…'}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement
              setText(el.value)
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`
            }}
            onKeyDown={(e) => {
              // 电脑端（精确指针）Enter 发送、Shift+Enter 换行；输入法选词中的 Enter 不算；手机上 Enter 始终换行
              if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
              if (!window.matchMedia('(pointer: fine)').matches) return
              e.preventDefault()
              ;(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit()
            }}
          />
          {canInterrupt ? (
            <button type="button" class="send stop" onClick={interrupt} aria-label="中断">
              <IconStop size={14} />
            </button>
          ) : (
            <button class="send" disabled={!!blockedReason || sending || !text.trim()} aria-label="发送">
              <IconSend size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

const STATE_TAG: Record<string, { label: string; cls: string }> = {
  idle: { label: '空闲', cls: 'ok' },
  running: { label: '运行中', cls: 'run' },
  attached: { label: '已打开', cls: '' },
  awaiting_approval: { label: '待审批', cls: 'warn' },
  error: { label: '出错', cls: 'err' },
  unknown: { label: '未知', cls: '' },
}

function mergeEvents(a: StoredEvent[], b: StoredEvent[]): StoredEvent[] {
  const m = new Map<number, StoredEvent>()
  for (const e of a) m.set(e.seq, e)
  for (const e of b) m.set(e.seq, e)
  return [...m.values()].sort((x, y) => x.seq - y.seq)
}
