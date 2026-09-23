// 把真实 Claude 会话 jsonl 裁剪成可提交的回放样本：
// 只保留 user/assistant/ai-title/system 行，丢弃 attachment 等，长文本截断，thinking 签名去掉。
// 用法：tsx scripts/trim-claude-session.ts <src.jsonl> <maxLines> > recordings/claude/xxx.jsonl
import { readFileSync } from 'node:fs'

const [src, max = '60'] = process.argv.slice(2)
const KEEP = new Set(['user', 'assistant', 'ai-title', 'system'])
const cut = (s: string) => (s.length > 300 ? s.slice(0, 300) + '…' : s)
let n = 0
for (const l of readFileSync(src, 'utf8').split('\n')) {
  if (!l.trim() || n >= Number(max)) continue
  const o = JSON.parse(l)
  if (!KEEP.has(o.type)) continue
  const c = o.message?.content
  if (typeof c === 'string') o.message.content = cut(c)
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (typeof b.text === 'string') b.text = cut(b.text)
      if (typeof b.thinking === 'string') b.thinking = cut(b.thinking)
      if ('signature' in b) b.signature = ''
      if (typeof b.content === 'string') b.content = cut(b.content)
      else if (Array.isArray(b.content)) b.content = cut(JSON.stringify(b.content))
      if (b.input && JSON.stringify(b.input).length > 300) b.input = { truncated: cut(JSON.stringify(b.input)) }
    }
  }
  delete o.toolUseResult
  delete o.tool_use_result
  console.log(JSON.stringify(o))
  n++
}
