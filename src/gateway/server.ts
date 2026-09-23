import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BinaryStatus, HubConfig } from '../config.ts'
import type { Bus, Published } from '../core/bus.ts'
import type { HistoryItem, SessionView, Vendor } from '../core/events.ts'
import type { AckResult, Hub } from '../core/sessions.ts'
import type { DeviceRow, Store } from '../core/store.ts'
import { authenticate, bearer, pairDevice } from './auth.ts'
import { BROADCAST_TYPES, ClientMessage, WS_CLOSE_UNAUTHORIZED } from './protocol.ts'

export interface GatewayDeps {
  cfg: HubConfig
  store: Store
  bus: Bus
  hub: Hub
  version: string
  vendors: () => Record<Vendor, BinaryStatus>
  /** 从厂商存储读会话历史（目前 Cursor：IDE 消息 + CLI 续聊）；返回 undefined 表示该厂商不提供 */
  history?: (s: SessionView, limit: number) => HistoryItem[] | undefined
  /** PWA 构建产物目录（web/dist）；不存在时只提供 API */
  webRoot?: string
  log?: (msg: string) => void
}

type Env = { Variables: { device: DeviceRow } }

const toInt = (v: string | undefined, d?: number) => {
  const n = v === undefined ? NaN : Number.parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

export function createApp(d: GatewayDeps) {
  const { store } = d
  const log = d.log ?? ((m) => console.log(`[gateway] ${m}`))
  const app = new Hono<Env>()

  app.post('/api/pair', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; deviceName?: unknown }
    const code = typeof body.code === 'string' ? body.code : ''
    const name = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 64) : ''
    if (!name) return c.json({ error: 'deviceName 必填' }, 400)
    const r = pairDevice(store, code, name)
    if (!r) {
      log(`配对失败：配对码无效、已使用或已过期（device=${name}）`)
      return c.json({ error: '配对码无效、已使用或已过期' }, 401)
    }
    log(`设备已配对：${name} (${r.deviceId})`)
    return c.json(r)
  })

  app.get('/api/health', (c) => {
    const authed = !!authenticate(store, bearer(c.req.header('authorization')))
    return c.json({
      ok: true,
      version: d.version,
      vendors: d.vendors(),
      ...(authed ? { allowedCwds: d.cfg.allowedCwds } : {}),
    })
  })

  app.use('/api/*', async (c, next) => {
    const device = authenticate(store, bearer(c.req.header('authorization')))
    if (!device) return c.json({ error: 'unauthorized' }, 401)
    c.set('device', device)
    await next()
  })

  app.get('/api/sessions', (c) =>
    c.json(
      store.listSessions({
        vendor: c.req.query('vendor') || undefined,
        state: c.req.query('state') || undefined,
        limit: toInt(c.req.query('limit'), 500),
        offset: toInt(c.req.query('offset'), 0),
      }),
    ),
  )

  app.get('/api/sessions/:id', (c) => {
    const s = store.getSession(c.req.param('id'))
    if (!s) return c.json({ error: 'not found' }, 404)
    let messages: HistoryItem[] | undefined
    try {
      messages = d.history?.(s, Math.min(toInt(c.req.query('messages'), 50)!, 200))
    } catch (e) {
      log(`读取会话历史失败 ${s.id}: ${(e as Error).message}`)
    }
    const pendingApprovals = store
      .pendingApprovals(s.id)
      .map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, expiresAt: a.expiresAt }))
    return c.json({ ...s, events: store.recentEvents(s.id, 200), pendingApprovals, ...(messages ? { messages } : {}) })
  })

  app.get('/api/sessions/:id/events', (c) => {
    const id = c.req.param('id')
    if (!store.getSession(id)) return c.json({ error: 'not found' }, 404)
    return c.json(store.eventsSince(id, toInt(c.req.query('sinceSeq'), 0), Math.min(toInt(c.req.query('limit'), 500)!, 2000)))
  })

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))
  if (d.webRoot) app.get('*', serveStatic(d.webRoot))

  return app
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

/** 托管 PWA：路径限制在 root 内；无扩展名的路径回落 index.html；带 hash 的 assets 长缓存，其余每次校验 */
function serveStatic(root: string) {
  const base = resolve(root)
  const read = (file: string) => {
    try {
      return statSync(file).isFile() ? readFileSync(file) : undefined
    } catch {
      return undefined
    }
  }
  return (c: { req: { path: string }; body: (b: Uint8Array | null, s?: number, h?: Record<string, string>) => Response }) => {
    let rel: string
    try {
      rel = decodeURIComponent(c.req.path)
    } catch {
      return c.body(null, 400)
    }
    let file = resolve(base, `.${rel}`)
    if (file !== base && !file.startsWith(base + sep)) return c.body(null, 404)
    let buf = rel.endsWith('/') ? undefined : read(file)
    if (!buf && !extname(rel)) {
      file = resolve(base, 'index.html')
      buf = read(file)
    }
    if (!buf) return c.body(null, 404)
    const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    return c.body(new Uint8Array(buf), 200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache })
  }
}

/** 把 node:http 请求转给 hono（不引入 @hono/node-server） */
async function toFetch(app: Hono<any>, req: IncomingMessage, res: ServerResponse) {
  try {
    const method = req.method ?? 'GET'
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    }
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      duplex: hasBody ? 'half' : undefined,
    } as RequestInit)
    const response = await app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) for await (const chunk of response.body as any) res.write(chunk)
    res.end()
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (e as Error).message }))
  }
}

interface Conn {
  ws: WebSocket
  device?: DeviceRow
  subs: Set<string>
  /** 本连接发起的 start 轮次，turn.started 到达时自动订阅新会话 */
  startTurns: Set<string>
}

export function attachWs(server: Server, d: GatewayDeps) {
  const { store, bus, hub } = d
  const log = d.log ?? ((m) => console.log(`[gateway] ${m}`))
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  const conns = new Set<Conn>()
  /** 每台设备订阅过的会话，断线重连补拉用（进程内有效） */
  const deviceSubs = new Map<string, Set<string>>()

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  const sendJson = (ws: WebSocket, obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  const deliver = (c: Conn, p: Published) => {
    const e = p.event
    const sid = 'sessionId' in e ? e.sessionId : undefined
    if (e.type === 'turn.started' && c.startTurns.delete(e.turnId)) {
      c.subs.add(e.sessionId)
      if (c.device) deviceSubs.get(c.device.id)?.add(e.sessionId)
    }
    // start 拿到真实会话 id 之前失败的事件挂在 pending:<turnId> 上，只发给发起的连接
    const pendingOwn = !!sid?.startsWith('pending:') && c.startTurns.has(sid.slice('pending:'.length))
    if (BROADCAST_TYPES.has(e.type) || !sid || c.subs.has(sid) || pendingOwn) sendJson(c.ws, { t: 'event', seq: p.seq, event: e })
  }

  bus.on((p) => {
    for (const c of conns) if (c.device) deliver(c, p)
  })

  wss.on('connection', (ws) => {
    const c: Conn = { ws, subs: new Set(), startTurns: new Set() }
    conns.add(c)
    ws.on('close', () => conns.delete(c))
    ws.on('error', () => {})

    ws.on('message', (data) => {
      let raw: any
      try {
        raw = JSON.parse(data.toString())
      } catch {
        return
      }
      const parsed = ClientMessage.safeParse(raw)
      if (!parsed.success) {
        if (!c.device) return ws.close(WS_CLOSE_UNAUTHORIZED, 'hello required')
        if (typeof raw?.reqId === 'string') {
          sendJson(ws, { t: 'ack', reqId: raw.reqId, ok: false, code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'bad request' })
        }
        return
      }
      const m = parsed.data
      if (m.t === 'hello') {
        const device = authenticate(store, m.token)
        if (!device) {
          log('WS hello 鉴权失败')
          return ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized')
        }
        c.device = device
        const remembered = deviceSubs.get(device.id) ?? new Set<string>()
        deviceSubs.set(device.id, remembered)
        for (const s of remembered) c.subs.add(s)
        sendJson(ws, { t: 'snapshot', sessions: store.listSessions(), seq: store.latestSeq() })
        if (m.sinceSeq !== undefined) {
          for (const ev of store.replayFor([...c.subs], m.sinceSeq)) sendJson(ws, { t: 'event', seq: ev.seq, event: ev.event })
        }
        return
      }
      if (!c.device) return ws.close(WS_CLOSE_UNAUTHORIZED, 'hello required')
      const device = c.device
      const ack = (reqId: string, r: AckResult) => sendJson(ws, { t: 'ack', reqId, ...r })
      switch (m.t) {
        case 'ping':
          return sendJson(ws, { t: 'pong' })
        case 'subscribe':
          c.subs.add(m.sessionId)
          deviceSubs.get(device.id)!.add(m.sessionId)
          return
        case 'unsubscribe':
          c.subs.delete(m.sessionId)
          deviceSubs.get(device.id)!.delete(m.sessionId)
          return
        case 'send': {
          // 成功发起才自动订阅；Adapter 事件是异步产出的，不会漏
          const r = hub.send(m.sessionId, m.text, m.force)
          if (r.ok) {
            c.subs.add(m.sessionId)
            deviceSubs.get(device.id)!.add(m.sessionId)
          }
          return ack(m.reqId, r)
        }
        case 'start': {
          const r = hub.start(m.vendor, m.cwd, m.text, m.force)
          if (r.ok) c.startTurns.add((r.data as { turnId: string }).turnId)
          return ack(m.reqId, r)
        }
        case 'approve':
          return ack(m.reqId, hub.approve(m.approvalId, m.decision, device.id))
        case 'interrupt':
          return ack(m.reqId, hub.interrupt(m.sessionId))
      }
    })
  })

  return wss
}

export function startGateway(d: GatewayDeps): Promise<Server> {
  const app = createApp(d)
  const server = createServer((req, res) => void toFetch(app, req, res))
  attachWs(server, d)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(d.cfg.listen.port, d.cfg.listen.host, () => resolve(server))
  })
}
