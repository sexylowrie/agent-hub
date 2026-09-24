import { useEffect, useState } from 'preact/hooks'
import { api, auth } from '../api.ts'
import { hub } from '../ws.ts'
import { useStore } from '../store.ts'
import type { Health } from '../types.ts'
import { VENDOR_LABEL, navigate } from '../util.ts'
import { setTheme, themePref, type ThemePref } from '../theme.ts'
import { toast } from '../toast.ts'
import { IconBack } from '../icons.tsx'
import { Navbar } from '../ui.tsx'
import { PushSection } from '../push.tsx'

const THEMES: { key: ThemePref; label: string; pv: string }[] = [
  { key: 'system', label: '跟随系统', pv: 'a' },
  { key: 'light', label: '浅色', pv: 'l' },
  { key: 'dark', label: '深色', pv: 'd' },
]

export function Settings() {
  const [health, setHealth] = useState<Health>()
  const theme = useStore(themePref)
  useEffect(() => {
    api<Health>('/api/health')
      .then(setHealth)
      .catch((e) => toast((e as Error).message))
  }, [])

  const unpair = () => {
    if (!confirm('退出后需要重新配对，确定？')) return
    auth.clear()
    hub.stop()
    navigate('#/pair')
  }

  return (
    <div class="page">
      <Navbar>
        <div class="nav-row">
          <button class="back" onClick={() => navigate('#/')}>
            <IconBack size={22} />
            会话
          </button>
        </div>
        <h1 class="large-title">设置</h1>
      </Navbar>

      <div class="sec-h">外观</div>
      <div class="card">
        <div class="theme-pick" role="radiogroup" aria-label="主题">
          {THEMES.map((t) => (
            <button class={`tp ${theme === t.key ? 'on' : ''}`} role="radio" aria-checked={theme === t.key} onClick={() => setTheme(t.key)}>
              <div class={`pv ${t.pv}`}>
                <i />
                <i />
                <i />
              </div>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div class="sec-h">通知</div>
      <PushSection health={health} />

      <div class="sec-h">Hub</div>
      <div class="card">
        <div class="cell">
          地址<span class="grow" />
          <span class="v">{location.host}</span>
        </div>
        <div class="cell">
          本设备<span class="grow" />
          <span class="v">{auth.device() || '—'}</span>
        </div>
        <div class="cell">
          版本<span class="grow" />
          <span class="v">{health?.version ?? '—'}</span>
        </div>
        {health &&
          Object.entries(health.vendors).map(([v, s]) => (
            <div class="cell">
              <span class={`vdot ${v}`} />
              {VENDOR_LABEL[v as keyof typeof VENDOR_LABEL]}
              <span class="grow" />
              <span class={`v ${s.ok ? '' : 'bad'}`}>{s.ok ? s.version?.replace(/\s*\(.*\)$/, '').replace(/^codex-cli\s*/, '') : '不可用'}</span>
            </div>
          ))}
      </div>

      <div class="sec-h" />
      <div class="card">
        <button class="cell danger" onClick={unpair}>
          退出配对
        </button>
      </div>
      <div style={{ height: 'calc(40px + env(safe-area-inset-bottom))' }} />
    </div>
  )
}
