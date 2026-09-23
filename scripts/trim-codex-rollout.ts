// 把真实 Codex rollout jsonl 裁剪成可提交的回放样本：
// 丢弃 world_state（含 AGENTS.md 全文）、turn_context、token 统计与 developer 指令，注入的 user 上下文只留首行，所有长字符串截断。
// 用法：tsx scripts/trim-codex-rollout.ts <rollout.jsonl> > recordings/codex/xxx.jsonl
import { readFileSync } from 'node:fs'

const [src] = process.argv.slice(2)
const DROP = new Set(['world_state', 'turn_context', 'token_usage_record'])
const cut = (v: unknown): unknown => {
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v
  if (Array.isArray(v)) return v.map(cut)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]))
  return v
}
for (const l of readFileSync(src, 'utf8').split('\n')) {
  if (!l.trim()) continue
  const o = JSON.parse(l)
  if (DROP.has(o.type)) continue
  if (o.type === 'event_msg' && o.payload?.type === 'token_count') continue
  if (o.type === 'response_item' && o.payload?.role === 'developer') continue
  if (o.type === 'session_meta') delete o.payload.base_instructions
  // 注入到 user 角色的上下文（AGENTS.md、插件列表等）只留开头标记
  if (o.type === 'response_item' && o.payload?.role === 'user') {
    for (const c of o.payload.content ?? []) {
      if (typeof c.text === 'string' && (c.text.startsWith('<') || c.text.startsWith('# AGENTS.md'))) {
        c.text = `${c.text.split('\n')[0]}\n[已裁剪：注入上下文]`
      }
    }
  }
  console.log(JSON.stringify(cut(o)))
}
