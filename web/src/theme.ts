import { createStore } from './store.ts'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'agenthub.theme'
const mq = window.matchMedia('(prefers-color-scheme: dark)')

export const themePref = createStore<ThemePref>((localStorage.getItem(KEY) as ThemePref | null) ?? 'system')

export const resolved = (p: ThemePref) => (p === 'system' ? (mq.matches ? 'dark' : 'light') : p)

/** 设 data-theme 与 theme-color（iOS 状态栏颜色跟着变）；index.html 里有同样逻辑的内联脚本，保证首帧不闪 */
function apply() {
  const t = resolved(themePref.get())
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0d0f13' : '#f4f5f8')
}

export function setTheme(p: ThemePref) {
  localStorage.setItem(KEY, p)
  themePref.set(p)
  apply()
}

/** 在浅色 / 深色间切换（导航栏上的一键切换） */
export function toggleTheme() {
  setTheme(resolved(themePref.get()) === 'dark' ? 'light' : 'dark')
}

mq.addEventListener('change', () => themePref.get() === 'system' && apply())
apply()
