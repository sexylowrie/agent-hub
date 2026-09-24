import { randomUUID } from 'node:crypto'
import type { AgentAdapter, ApprovalRequest } from '../adapters/types.ts'
import type { Bus } from './bus.ts'
import type { Decision, Holder, HubEvent, SessionState, SessionView, Vendor } from './events.ts'
import type { Store } from './store.ts'

/** 失败时 code=ATTACHED 会带上 holder（会话被谁开着），供上层给出 inject / takeover / fork 等显式动作 */
export type AckResult = { ok: true; data?: unknown } | { ok: false; code: string; message: string; holder?: Holder }

export interface HubOpts {
  store: Store
  bus: Bus
  adapters: Partial<Record<Vendor, AgentAdapter>>
  approvalExpireMs: number
  /** start 的 cwd 白名单校验 */
  isCwdAllowed: (cwd: string) => boolean
  /** 发起续聊前按厂商重新读取一次会话实时状态（防止列表状态过期），返回 undefined 表示会话已不存在 */
  refresh?: (s: SessionView) => SessionView | undefined
  /** Hub 轮次结束、解除互斥之前调用（Scanner 借此跳过本轮自己写入的文件内容） */
  beforeTurnEnd?: (s: SessionView) => void
  log?: (msg: string) => void
  deltaMergeMs?: number
  /** 进行中的 Hub 轮次数变化（防睡眠按需开关用） */
  onBusyChange?: (inFlight: number) => void
}

interface PendingApproval {
  sessionId: string
  resolve: (d: Decision) => void
  timer: NodeJS.Timeout
}

const PREVIEW_LEN = 200

function sameView(a: SessionView, b: SessionView): boolean {
  return (
    a.cwd === b.cwd &&
    a.title === b.title &&
    a.origin === b.origin &&
    a.state === b.state &&
    a.resumable === b.resumable &&
    a.unresumableReason === b.unresumableReason &&
    a.archived === b.archived &&
    a.lastMessagePreview === b.lastMessagePreview &&
    a.vendorUpdatedAt === b.vendorUpdatedAt &&
    JSON.stringify(a.holder) === JSON.stringify(b.holder)
  )
}

/** Core：会话归一、Hub 轮次调度、审批、事件落库与广播。不含任何厂商细节。 */
export class Hub {
  private readonly store: Store
  private readonly bus: Bus
  private inFlight = new Map<string, { turnId: string; ctrl: AbortController }>()
  private approvals = new Map<string, PendingApproval>()
  private deltaBuf = new Map<string, { event: Extract<HubEvent, { type: 'message.delta' }>; timer: NodeJS.Timeout }>()
  private readonly log: (msg: string) => void

  constructor(private readonly o: HubOpts) {
    this.store = o.store
    this.bus = o.bus
    this.log = o.log ?? ((m) => console.log(`[hub] ${m}`))
  }

  // ---------- 事件 ----------

  /** 落库并广播 */
  record(event: HubEvent): number {
    const seq = this.store.appendEvent(event)
    this.bus.publish({ seq, event })
    return seq
  }

  private setState(sessionId: string, state: SessionState, reason?: string) {
    this.store.setSessionState(sessionId, state)
    this.record({ type: 'session.state', sessionId, state, reason })
  }

  isHubSession(sessionId: string): boolean {
    return this.store.getSession(sessionId)?.origin === 'hub'
  }

  isBusy(sessionId: string): boolean {
    return this.inFlight.has(sessionId) || this.store.hasRunningTurn(sessionId)
  }

  // ---------- Scanner 输入 ----------

  /** Scanner 产出的会话：合并入库，变化时广播 session.upsert（不写 events） */
  applyScan(views: SessionView[]) {
    for (const v of views) {
      const prev = this.store.getSession(v.id)
      const next: SessionView = { ...v }
      if (prev?.origin === 'hub') next.origin = 'hub'
      // Hub 轮次进行中，状态以 Core 为准
      if (prev && this.isBusy(v.id)) next.state = prev.state
      if (prev && sameView(prev, next)) continue
      this.store.upsertSession(next)
      this.bus.publish({ seq: 0, event: { type: 'session.upsert', session: next } })
    }
  }

  /** 桌面端进度事件：Hub 轮次进行中的会话忽略（Adapter 已产出）；message.delta 按会话合并 */
  ingestProgress(events: HubEvent[]) {
    for (const e of events) {
      const sid = 'sessionId' in e ? e.sessionId : undefined
      if (!sid || this.isBusy(sid)) continue
      if (e.type === 'message.delta') {
        const buf = this.deltaBuf.get(sid)
        if (buf && buf.event.turnId === e.turnId) {
          buf.event.text += e.text
          continue
        }
        if (buf) this.flushDelta(sid)
        const timer = setTimeout(() => this.flushDelta(sid), this.o.deltaMergeMs ?? 500)
        timer.unref()
        this.deltaBuf.set(sid, { event: { ...e }, timer })
        continue
      }
      this.flushDelta(sid)
      this.record(e)
    }
  }

  private flushDelta(sid: string) {
    const buf = this.deltaBuf.get(sid)
    if (!buf) return
    clearTimeout(buf.timer)
    this.deltaBuf.delete(sid)
    this.record(buf.event)
  }

  // ---------- 客户端命令 ----------

  send(sessionId: string, text: string, force = false): AckResult {
    let s = this.store.getSession(sessionId)
    if (!s) return this.reject('NOT_FOUND', `会话不存在: ${sessionId}`)
    if (!s.resumable) return this.reject('NOT_RESUMABLE', s.unresumableReason ?? '该会话不可续聊')
    if (this.isBusy(sessionId)) return this.reject('SESSION_BUSY', '已有 Hub 轮次在进行')
    if (this.o.refresh) {
      const fresh = this.o.refresh(s)
      if (!fresh) return this.reject('NOT_FOUND', `会话已不存在: ${sessionId}`)
      this.applyScan([fresh])
      s = this.store.getSession(sessionId)!
    }
    if (s.state === 'attached') {
      const where = s.holder?.kind === 'gui' ? '桌面 App' : '终端'
      return { ...this.reject('ATTACHED', `会话在${where}里开着（已安静），关掉后才能在这里续聊`), holder: s.holder }
    }
    if (s.state !== 'idle') return this.reject('SESSION_BUSY', `会话非空闲（state=${s.state}），桌面端可能仍打开着该会话`)
    const adapter = this.o.adapters[s.vendor]
    if (!adapter) return this.reject('VENDOR_UNSUPPORTED', `暂不支持 ${s.vendor}`)
    if (!s.cwd && adapter.requiresCwd !== false) return this.reject('NOT_RESUMABLE', '会话缺少 cwd')
    const turnId = randomUUID()
    const cwd = s.cwd ?? ''
    void this.runTurn(sessionId, turnId, force, (opts) => adapter.resume(s.vendorSessionId, cwd, text, opts))
    return { ok: true, data: { turnId } }
  }

  start(vendor: Vendor, cwd: string, text: string, force = false): AckResult {
    const adapter = this.o.adapters[vendor]
    if (!adapter) return this.reject('VENDOR_UNSUPPORTED', `暂不支持 ${vendor}`)
    if (!this.o.isCwdAllowed(cwd)) return this.reject('CWD_NOT_ALLOWED', `cwd 不在 allowedCwds 内: ${cwd}`)
    const turnId = randomUUID()
    void this.runTurn(`pending:${turnId}`, turnId, force, (opts) => adapter.start(cwd, text, opts))
    return { ok: true, data: { turnId } }
  }

  approve(approvalId: string, decision: Decision, deviceId: string): AckResult {
    const row = this.store.getApproval(approvalId)
    if (!row) return this.reject('NOT_FOUND', `审批不存在: ${approvalId}`)
    if (!this.store.decideApproval(approvalId, decision, deviceId)) {
      return this.reject('APPROVAL_CLOSED', `审批已处理或已过期（status=${row.status}）`)
    }
    this.record({ type: 'approval.decided', sessionId: row.sessionId, approvalId, decision, by: deviceId })
    const p = this.approvals.get(approvalId)
    if (p) {
      clearTimeout(p.timer)
      this.approvals.delete(approvalId)
      p.resolve(decision)
    }
    return { ok: true }
  }

  interrupt(sessionId: string): AckResult {
    const f = this.inFlight.get(sessionId)
    if (!f) return this.reject('NO_TURN', '该会话没有进行中的 Hub 轮次')
    f.ctrl.abort()
    return { ok: true, data: { turnId: f.turnId } }
  }

  private reject(code: string, message: string): Extract<AckResult, { ok: false }> {
    this.log(`拒绝 ${code}: ${message}`)
    return { ok: false, code, message }
  }

  // ---------- 轮次 ----------

  private async runTurn(
    initialSessionId: string,
    turnId: string,
    force: boolean,
    run: (opts: Parameters<AgentAdapter['resume']>[3]) => AsyncIterable<HubEvent>,
  ) {
    let sessionId = initialSessionId
    const ctrl = new AbortController()
    this.inFlight.set(sessionId, { turnId, ctrl })
    this.o.onBusyChange?.(this.inFlight.size)
    this.store.insertTurn(turnId, sessionId)
    const isPending = sessionId.startsWith('pending:')
    if (!isPending) this.setState(sessionId, 'running', 'hub')

    let preview = ''
    let finalStatus: 'success' | 'error' | 'interrupted' | undefined
    try {
      const events = run({
        turnId,
        force,
        signal: ctrl.signal,
        onSpawn: (pid) => this.store.setTurnPid(turnId, pid),
        onApproval: (req) => this.requestApproval(sessionId, turnId, req),
      })
      for await (const e of events) {
        if (e.type === 'session.upsert') {
          // start()：拿到真实会话 id，挂上轮次
          const old = sessionId
          sessionId = e.session.id
          this.store.upsertSession(e.session)
          this.store.setTurnSession(turnId, sessionId)
          this.inFlight.delete(old)
          this.inFlight.set(sessionId, { turnId, ctrl })
          this.bus.publish({ seq: 0, event: e })
          continue
        }
        this.record(e)
        if (e.type === 'message.delta') preview += e.text
        else if (e.type === 'turn.started') preview = ''
        else if (e.type === 'turn.done') {
          finalStatus = e.status
          if (e.resultText) preview = e.resultText
        }
      }
    } catch (err) {
      this.record({ type: 'error', sessionId, message: `轮次异常: ${(err as Error).message}`, recoverable: true })
    } finally {
      const cur = this.store.getSession(sessionId)
      if (cur) {
        try {
          this.o.beforeTurnEnd?.(cur)
        } catch {
          // 忽略
        }
      }
      this.inFlight.delete(sessionId)
      this.o.onBusyChange?.(this.inFlight.size)
      this.store.finishTurn(turnId, finalStatus === 'success' || finalStatus === 'interrupted' ? 'done' : 'failed')
      const s = this.store.getSession(sessionId)
      if (s) {
        if (preview) s.lastMessagePreview = preview.slice(0, PREVIEW_LEN)
        s.state = finalStatus === 'error' || !finalStatus ? 'error' : 'idle'
        s.updatedAt = Date.now()
        this.store.upsertSession(s)
        this.record({ type: 'session.state', sessionId, state: s.state, reason: `hub 轮次结束: ${finalStatus ?? 'no result'}` })
        this.bus.publish({ seq: 0, event: { type: 'session.upsert', session: s } })
      }
    }
  }

  private requestApproval(sessionId: string, turnId: string, req: ApprovalRequest): Promise<Decision> {
    const approvalId = randomUUID()
    const now = Date.now()
    const expiresAt = now + this.o.approvalExpireMs
    this.store.insertApproval({
      id: approvalId,
      sessionId,
      turnId,
      kind: req.kind,
      summary: req.summary,
      payload: JSON.stringify(req.raw),
      createdAt: now,
      expiresAt,
    })
    this.setState(sessionId, 'awaiting_approval')
    this.record({
      type: 'approval.request',
      sessionId,
      turnId,
      approvalId,
      kind: req.kind,
      summary: req.summary,
      detail: req.detail,
      expiresAt,
    })
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(approvalId)
        if (this.store.expireApproval(approvalId)) {
          this.record({ type: 'approval.decided', sessionId, approvalId, decision: 'deny', by: 'expired' })
        }
        resolve('deny')
      }, this.o.approvalExpireMs)
      timer.unref()
      this.approvals.set(approvalId, {
        sessionId,
        timer,
        resolve: (d) => resolve(d),
      })
    }).then((d) => {
      if (this.inFlight.has(sessionId)) this.setState(sessionId, 'running', 'approval decided')
      return d
    })
  }

  /** 中断所有进行中的轮次（退出时用） */
  abortAll() {
    for (const f of this.inFlight.values()) f.ctrl.abort()
  }

  /**
   * 启动对账：库里仍是 running 的轮次都属于上一个 Hub 进程（已不在），一律标 orphaned、会话置 error。
   * 子进程还活着（Hub 被 kill -9 时可能留下）就交给 stop 结束，否则它没人消费、会话会一直被占着。
   */
  reconcileOrphans(isAlive: (pid: number) => boolean, stop?: (pid: number) => void) {
    this.store.expireAllPending()
    for (const t of this.store.runningTurns()) {
      if (t.pid && isAlive(t.pid)) {
        this.log(`对账：轮次 ${t.id} 的子进程 ${t.pid} 仍在运行，结束它`)
        stop?.(t.pid)
      }
      this.store.markTurnOrphaned(t.id)
      if (this.store.getSession(t.sessionId)) this.setState(t.sessionId, 'error', 'orphaned')
      this.record({ type: 'error', sessionId: t.sessionId, message: `Hub 轮次 ${t.id} 异常中断（orphaned）`, recoverable: true })
      this.log(`对账：轮次 ${t.id} 标记为 orphaned`)
    }
  }
}
