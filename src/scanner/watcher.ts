import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/**
 * 递归监听若干目录（macOS 支持 recursive），去抖后回调变化的绝对路径集合。
 * 目录不存在时静默跳过，由定时对账兜底。
 */
export function watchDirs(dirs: string[], onChange: (files: Set<string>) => void, debounceMs = 300): () => void {
  const watchers: FSWatcher[] = []
  let pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  const flush = () => {
    timer = undefined
    const files = pending
    pending = new Set()
    onChange(files)
  }
  for (const dir of dirs) {
    try {
      const w = watch(dir, { recursive: true }, (_ev, name) => {
        if (name) pending.add(join(dir, name.toString()))
        if (!timer) timer = setTimeout(flush, debounceMs)
      })
      w.on('error', () => {})
      watchers.push(w)
    } catch {
      // 目录不存在
    }
  }
  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}

/** 周期性执行，返回停止函数 */
export function every(ms: number, fn: () => void): () => void {
  const t = setInterval(fn, ms)
  t.unref()
  return () => clearInterval(t)
}
