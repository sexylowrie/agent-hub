import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../../web/src/markdown.ts'

test('renderMarkdown：段落、粗体、行内代码、列表、代码块', () => {
  const html = renderMarkdown('原因：**aborted** 不是 `generating`\n\n- 第一条\n- 第二条\n\n1. 甲\n2. 乙\n\n```ts\nconst a = 1 < 2\n```')
  assert.equal(
    html,
    '<p>原因：<strong>aborted</strong> 不是 <code>generating</code></p>' +
      '<ul><li>第一条</li><li>第二条</li></ul>' +
      '<ol><li>甲</li><li>乙</li></ol>' +
      '<pre><code>const a = 1 &lt; 2</code></pre>',
  )
})

test('renderMarkdown：原始 HTML 一律转义，链接只认 http(s)', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [点我](javascript:alert(1)) [文档](https://example.com/a?b=1)')
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!html.includes('href="javascript'))
  assert.ok(html.includes('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">文档</a>'))
})

test('renderMarkdown：代码里的星号不当强调；标题、引用、分隔线；单换行保留', () => {
  assert.equal(renderMarkdown('`a*b*c` 和 *斜体*'), '<p><code>a*b*c</code> 和 <em>斜体</em></p>')
  assert.equal(renderMarkdown('## 结论\n> 引用\n---\n一行\n两行'), '<p class="md-h">结论</p><blockquote>引用</blockquote><hr><p>一行<br>两行</p>')
})

test('stripMarkdown：预览去掉标记只留文字', async () => {
  const { stripMarkdown } = await import('../../web/src/markdown.ts')
  assert.equal(stripMarkdown('可以这样回：\n1. **空闲判定**按 `M0` 做\n- [文档](https://x.y)'), '可以这样回： 空闲判定按 M0 做 文档')
})
