import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/** 简单的推拉队列：生产者 push/end，消费者 for await */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private ended = false
  private drainWaiters: (() => void)[] = []

  push(item: T) {
    if (this.ended) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  /** 消费者已处理完此前入队的全部事件（正在等下一条）或队列已结束时 resolve */
  whenDrained(): Promise<void> {
    if (this.ended || (this.items.length === 0 && this.waiters.length > 0)) return Promise.resolve()
    return new Promise((r) => this.drainWaiters.push(r))
  }

  private checkDrained() {
    if (this.ended || (this.items.length === 0 && this.waiters.length > 0)) {
      for (const r of this.drainWaiters.splice(0)) r()
    }
  }

  end() {
    if (this.ended) return
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
    this.checkDrained()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((r) => {
          this.waiters.push(r)
          this.checkDrained()
        })
      },
    }
  }
}

/** 逐行读取 stdout */
export function onLines(child: ChildProcess, fn: (line: string) => void) {
  if (!child.stdout) return
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (l) => {
    if (l.trim()) fn(l)
  })
}

/** 保留 stderr 尾部，便于报错 */
export function stderrTail(child: ChildProcess, max = 2000): () => string {
  let buf = ''
  child.stderr?.on('data', (d: Buffer) => {
    buf = (buf + d.toString()).slice(-max)
  })
  return () => buf.trim()
}

/** 温和结束：先发 soft 信号，5 秒后 SIGKILL */
export function softKill(child: ChildProcess, soft: NodeJS.Signals = 'SIGINT', graceMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(soft)
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, graceMs)
  t.unref()
  child.once('exit', () => clearTimeout(t))
}

export function safeParse(line: string): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch {
    return { ok: false }
  }
}
