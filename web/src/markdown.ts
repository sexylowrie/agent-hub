// 轻量 Markdown → HTML：只覆盖 AI 回复里常见的几种写法，不引依赖。
// 安全：所有文本先转义再加标签，不输出任何原始 HTML；链接只认 http(s)。

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  // 先把行内代码抠出来，避免里面的 * _ 被当成强调
  const codes: string[] = []
  let out = esc(s).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`)
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = undefined
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*```/)
    if (fence) {
      flushPara()
      flushList()
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (h) {
      flushPara()
      flushList()
      out.push(`<p class="md-h">${inline(h[2])}</p>`)
    } else if (ul || ol) {
      flushPara()
      const tag = ul ? 'ul' : 'ol'
      if (list?.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push((ul ?? ol)![1])
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara()
      flushList()
      out.push('<hr>')
    } else if (/^\s*>\s?/.test(line)) {
      flushPara()
      flushList()
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`)
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()
  return out.join('')
}

/** 列表预览用：去掉 Markdown 标记，只留文字 */
export function stripMarkdown(src: string): string {
  return src
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}
