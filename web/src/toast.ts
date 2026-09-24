import { createStore } from './store.ts'

export interface Toast {
  id: number
  text: string
  kind: 'error' | 'info'
}

export const toasts = createStore<Toast[]>([])
let seq = 0

/** 顶部轻提示，3.5 秒后消失 */
export function toast(text: string, kind: Toast['kind'] = 'error') {
  const t = { id: ++seq, text, kind }
  toasts.set([...toasts.get(), t])
  setTimeout(() => toasts.set(toasts.get().filter((x) => x.id !== t.id)), 3500)
}
