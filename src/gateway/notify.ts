import type { Bus } from '../core/bus.ts'
import type { Store } from '../core/store.ts'
import type { PushMessage, WebPush } from './push.ts'

const BODY_LEN = 120

/**
 * 把 Hub 事件转成推送：只推 approval.request 与 Hub 轮次的 turn.done（桌面端自己跑完的不推，人就在电脑前）。
 */
export function attachPushNotifier(bus: Bus, store: Store, push: Pick<WebPush, 'broadcast'>): () => void {
  const hubTurns = new Set<string>()
  const title = (sessionId: string) => store.getSession(sessionId)?.title?.slice(0, 40) || '会话'
  const url = (sessionId: string) => `/#/s/${encodeURIComponent(sessionId)}`
  const send = (m: PushMessage) => void push.broadcast(m)
  return bus.on(({ event: e }) => {
    if (e.type === 'turn.started') {
      if (e.source === 'hub') hubTurns.add(e.turnId)
    } else if (e.type === 'approval.request') {
      send({ title: `需要审批 · ${title(e.sessionId)}`, body: e.summary.slice(0, BODY_LEN), url: url(e.sessionId), tag: `approval-${e.approvalId}` })
    } else if (e.type === 'turn.done' && e.turnId && hubTurns.delete(e.turnId)) {
      const status = e.status === 'success' ? '完成' : e.status === 'interrupted' ? '已中断' : '出错'
      send({ title: `${status} · ${title(e.sessionId)}`, body: (e.resultText ?? '').slice(0, BODY_LEN) || status, url: url(e.sessionId), tag: `turn-${e.sessionId}` })
    }
  })
}
