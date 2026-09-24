// 录制脱敏：把 recordings/ 里与协议无关、但会泄露本机环境的内容去掉，开源前 / 新录制后运行。
//   npx tsx scripts/sanitize-recordings.ts            # 就地改写 recordings/
//   npx tsx scripts/sanitize-recordings.ts --check    # 只检查，发现残留时退出码 1
// 处理：
//   - Claude system/init：MCP 服务、skills、插件、agents、斜杠命令、MCP 工具等本机清单清空（解析只用 subtype/session_id/cwd）
//   - Claude SessionStart hook_response：输出正文清空（可能含记忆库、项目上下文）
//   - Claude stop_hook_summary：hook 命令行替换为占位
//   - 家目录用户名替换为 dev；其他私有项目名替换为 demo-app
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'recordings')
const CHECK = process.argv.includes('--check')

const user = basename(homedir())
const REPLACE: [RegExp, string][] = [
  [new RegExp(`/Users/${user}(?=[/"'\\\\\\s]|$)`, 'g'), '/Users/dev'],
  [/\bdemo-app\b/gi, 'demo-app'],
]
/** 脱敏后不应再出现的内容 */
const LEAKS = [new RegExp(`/Users/${user}\\b`), /mcp__(?!ide__)/, /viking:\/\//i, /openviking/i, /\bdemo-app\b/i]

/** Claude CLI 自带的工具与 agent，保留；其余都是本机装的 */
const BUILTIN_TOOLS = new Set(['Task', 'Agent', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'BashOutput', 'KillShell', 'ExitPlanMode', 'Skill', 'SlashCommand', 'ToolSearch'])
const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide'])

function scrubLine(o: any): any {
  if (o?.type !== 'system') return o
  if (o.subtype === 'init') {
    return {
      ...o,
      tools: Array.isArray(o.tools) ? o.tools.filter((t: string) => BUILTIN_TOOLS.has(t)) : o.tools,
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      plugins: [],
      agents: Array.isArray(o.agents) ? o.agents.filter((a: string) => BUILTIN_AGENTS.has(a)) : o.agents,
      ...(o.memory_paths ? { memory_paths: {} } : {}),
    }
  }
  if (o.subtype === 'hook_response') return { ...o, output: '', stdout: '', stderr: '' }
  if (o.subtype === 'stop_hook_summary' && Array.isArray(o.hookInfos)) {
    return { ...o, hookInfos: o.hookInfos.map((h: any) => ({ ...h, command: '<hook command>' })) }
  }
  return o
}

/** 录制文件是 JSON / NDJSON，NDJSON 行可能带 `<< ` `>> ` 前缀或是 `>> [SIGINT]` 这类动作标记 */
/** 只重写需要清理的行，其余行原样保留（避免重新序列化带来无关的格式差异） */
function sanitize(text: string, file: string): string {
  let out = text
  if (!file.endsWith('.json')) {
    out = text
      .split('\n')
      .map((line) => {
        const m = line.match(/^(<< |>> )?(\{.*\})\s*$/)
        if (!m) return line
        try {
          const o = JSON.parse(m[2])
          const scrubbed = scrubLine(o)
          return scrubbed === o ? line : (m[1] ?? '') + JSON.stringify(scrubbed)
        } catch {
          return line
        }
      })
      .join('\n')
  }
  for (const [re, to] of REPLACE) out = out.replace(re, to)
  return out
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(ndjson|jsonl|json|txt)$/.test(f) ? [p] : []
  })
}

let dirty = 0
for (const f of walk(ROOT)) {
  const before = readFileSync(f, 'utf8')
  const after = f.endsWith('.txt') ? REPLACE.reduce((s, [re, to]) => s.replace(re, to), before) : sanitize(before, f)
  const leaks = LEAKS.filter((re) => re.test(after))
  if (CHECK) {
    if (after !== before || leaks.length) {
      dirty++
      console.log(`未脱敏：${f.replace(ROOT + '/', '')}${leaks.length ? `（残留 ${leaks.map(String).join(', ')}）` : ''}`)
    }
    continue
  }
  if (after !== before) {
    writeFileSync(f, after)
    console.log(`已脱敏：${f.replace(ROOT + '/', '')}（${before.length} → ${after.length} 字节）`)
  }
  if (leaks.length) {
    dirty++
    console.log(`  仍有残留：${leaks.map(String).join(', ')}`)
  }
}
if (dirty) process.exitCode = 1
