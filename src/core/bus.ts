import { EventEmitter } from 'node:events'
import type { HubEvent } from './events.ts'

/** 已发布事件：seq 为 0 表示未落库（如 Scanner 的 session.upsert） */
export interface Published {
  seq: number
  event: HubEvent
}

export class Bus {
  private ee = new EventEmitter()

  constructor() {
    this.ee.setMaxListeners(0)
  }

  publish(p: Published) {
    this.ee.emit('event', p)
  }

  on(fn: (p: Published) => void): () => void {
    this.ee.on('event', fn)
    return () => this.ee.off('event', fn)
  }
}
