import { execFileSync } from 'node:child_process'

// 判定 attached 会话的持有进程是否在某个 tmux pane 里（给上层做"注入到该 pane"用）。
// 按进程树匹配：pane 的 shell pid 是持有进程的祖先，且 pane 前台命令是 agent 本身。

/** pane 前台命令是这些之一才算 agent（node / bun 是被 shim 起来时显示的运行时名） */
export const AGENT_PANE_CMDS = new Set(['claude', 'node', 'bun'])

export interface Pane {
  /** session:window.pane，可直接给 tmux -t */
  target: string
  pid: number
  cmd: string
}

const PANE_FMT = '#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_command}'

export function parsePanes(text: string): Pane[] {
  const out: Pane[] = []
  for (const line of text.split('\n')) {
    const [target, pid, cmd] = line.split('\t')
    if (target && pid && cmd !== undefined && Number(pid) > 0) out.push({ target, pid: Number(pid), cmd: cmd.trim() })
  }
  return out
}

/** `ps -Ao pid=,ppid=` → pid → ppid */
export function parsePpids(text: string): Map<number, number> {
  const m = new Map<number, number>()
  for (const line of text.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid > 0 && ppid >= 0) m.set(pid, ppid)
  }
  return m
}

/** 沿父进程链往上找，命中某个 agent pane 的 shell pid（或就是它本身）即返回该 pane */
export function paneFor(pid: number, panes: Pane[], ppids: Map<number, number>, cmds = AGENT_PANE_CMDS): Pane | undefined {
  const byPid = new Map(panes.filter((p) => cmds.has(p.cmd)).map((p) => [p.pid, p]))
  const seen = new Set<number>()
  for (let cur: number | undefined = pid; cur && cur > 1 && !seen.has(cur); cur = ppids.get(cur)) {
    seen.add(cur)
    const hit = byPid.get(cur)
    if (hit) return hit
  }
  return undefined
}

function run(bin: string, args: string[]): string | undefined {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/** 持有进程所在的 tmux pane target；没装 tmux、没有 tmux server、不在 pane 里都返回 undefined */
export function tmuxTargetOf(pid: number): string | undefined {
  const panes = run('tmux', ['list-panes', '-a', '-F', PANE_FMT])
  if (!panes) return undefined
  const list = parsePanes(panes)
  if (!list.length) return undefined
  const ps = run('ps', ['-Ao', 'pid=,ppid='])
  if (!ps) return undefined
  return paneFor(pid, list, parsePpids(ps))?.target
}
