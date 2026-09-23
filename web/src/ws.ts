import type { Ack, HubEvent, ServerMessage, SessionView } from './types.ts'
import { auth } from './api.ts'
import { createStore } from './store.ts'

export type ConnStatus = 'connecting' | 'open' | 'offline'

export const sessions = createStore<Map<string, SessionView>>(new Map())
export const connStatus = createStore<ConnStatus>('offline')

type Listener = (e: HubEvent, seq: number) => void
type Pending = { resolve: (a: Ack) => void; timer: number }

const PING_MS = 25_000
const PONG_TIMEOUT_MS = 10_000
const ACK_TIMEOUT_MS = 20_000
const BACKOFF_MAX_MS = 30_000

/** 与 Hub 的唯一 WS 连接：hello/snapshot、断线指数退避重连（带 sinceSeq 补拉）、请求-应答 */
class HubSocket {
  private ws: WebSocket | undefined
  private lastSeq = 0
  private attempt = 0
  private retryTimer: number | undefined
  private pingTimer: number | undefined
  private pongTimer: number | undefined
  private listeners = new Set<Listener>()
  private snapshotListeners = new Set<() => void>()
  private pending = new Map<string, Pending>()
  private subs = new Set<string>()
  private stopped = true

  start() {
    this.stopped = false
    if (!this.ws) this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = undefined
  }

  /** 页面回到前台时，连接已断就立刻重连（手机后台会掐掉 socket） */
  wake() {
    if (this.stopped) return
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      clearTimeout(this.retryTimer)
      this.attempt = 0
      this.connect()
    } else if (this.ws.readyState === WebSocket.OPEN) this.ping()
  }

  private connect() {
    if (!auth.token()) return
    connStatus.set('connecting')
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', token: auth.token(), ...(this.lastSeq ? { sinceSeq: this.lastSeq } : {}) }))
      for (const id of this.subs) ws.send(JSON.stringify({ t: 'subscribe', sessionId: id }))
    }
    ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)) as ServerMessage)
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearInterval(this.pingTimer)
      clearTimeout(this.pongTimer)
      connStatus.set('offline')
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve({ t: 'ack', reqId: id, ok: false, code: 'OFFLINE', message: '连接已断开，请求结果未知' })
      }
      this.pending.clear()
      if (ev.code === 4401) {
        auth.clear()
        location.hash = '#/pair'
        return
      }
      if (this.stopped) return
      const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6)
      this.attempt++
      this.retryTimer = window.setTimeout(() => this.connect(), delay)
    }
  }

  private ping() {
    this.send({ t: 'ping' })
    clearTimeout(this.pongTimer)
    this.pongTimer = window.setTimeout(() => this.ws?.close(), PONG_TIMEOUT_MS)
  }

  private onMessage(m: ServerMessage) {
    switch (m.t) {
      case 'snapshot': {
        this.attempt = 0
        connStatus.set('open')
        if (!this.lastSeq) this.lastSeq = m.seq
        sessions.set(new Map(m.sessions.map((s) => [s.id, s])))
        clearInterval(this.pingTimer)
        this.pingTimer = window.setInterval(() => this.ping(), PING_MS)
        for (const f of this.snapshotListeners) f()
        return
      }
      case 'event': {
        if (m.seq > this.lastSeq) this.lastSeq = m.seq
        applyToSessions(m.event)
        for (const f of this.listeners) f(m.event, m.seq)
        return
      }
      case 'ack': {
        const p = this.pending.get(m.reqId)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(m.reqId)
        p.resolve(m)
        return
      }
      case 'pong':
        clearTimeout(this.pongTimer)
        return
    }
  }

  private send(obj: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(obj))
    return true
  }

  /** 发命令并等 ack；未连接时直接返回失败 */
  request(msg: Record<string, unknown>): Promise<Ack> {
    const reqId = crypto.randomUUID()
    return new Promise((resolve) => {
      if (!this.send({ ...msg, reqId })) return resolve({ t: 'ack', reqId, ok: false, code: 'OFFLINE', message: '未连接到 Hub' })
      const timer = window.setTimeout(() => {
        this.pending.delete(reqId)
        resolve({ t: 'ack', reqId, ok: false, code: 'TIMEOUT', message: 'Hub 未响应' })
      }, ACK_TIMEOUT_MS)
      this.pending.set(reqId, { resolve, timer })
    })
  }

  subscribe(sessionId: string) {
    this.subs.add(sessionId)
    this.send({ t: 'subscribe', sessionId })
  }

  unsubscribe(sessionId: string) {
    this.subs.delete(sessionId)
    this.send({ t: 'unsubscribe', sessionId })
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 每次（重）连上拿到 snapshot 时回调，页面借此补拉 REST */
  onSnapshot(fn: () => void): () => void {
    this.snapshotListeners.add(fn)
    return () => this.snapshotListeners.delete(fn)
  }
}

function applyToSessions(e: HubEvent) {
  if (e.type === 'session.upsert') {
    const next = new Map(sessions.get())
    next.set(e.session.id, e.session)
    sessions.set(next)
  } else if (e.type === 'session.state') {
    const cur = sessions.get().get(e.sessionId)
    if (!cur || cur.state === e.state) return
    const next = new Map(sessions.get())
    next.set(e.sessionId, { ...cur, state: e.state })
    sessions.set(next)
  }
}

export const hub = new HubSocket()
