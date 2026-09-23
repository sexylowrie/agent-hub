import { spawn, type ChildProcess } from 'node:child_process'

export type KeepAwakeMode = 'ac' | 'turn' | 'off'

/**
 * 防睡眠：`caffeinate -s` 只在接电源时阻止系统睡眠（含合盖），`-w <hub pid>` 保证 Hub 退出（含 kill -9）后自动释放。
 * ac：Hub 运行期间一直持有；turn：只在有 Hub 轮次时持有；off：不管。
 */
export class KeepAwake {
  private proc: ChildProcess | undefined

  constructor(
    readonly mode: KeepAwakeMode,
    private readonly spawnFn: typeof spawn = spawn,
    private readonly log: (m: string) => void = (m) => console.log(`[power] ${m}`),
  ) {}

  start() {
    if (this.mode === 'ac') this.hold()
  }

  onBusyChange(inFlight: number) {
    if (this.mode !== 'turn') return
    if (inFlight > 0) this.hold()
    else this.release()
  }

  get holding() {
    return !!this.proc
  }

  private hold() {
    if (this.proc) return
    const p = this.spawnFn('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' })
    this.proc = p
    p.on('error', (e) => {
      this.log(`caffeinate 启动失败：${e.message}`)
      if (this.proc === p) this.proc = undefined
    })
    p.on('exit', () => {
      if (this.proc === p) this.proc = undefined
    })
  }

  release() {
    this.proc?.kill()
    this.proc = undefined
  }
}
