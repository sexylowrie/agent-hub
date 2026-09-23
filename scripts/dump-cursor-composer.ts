// 从 Cursor IDE 的 state.vscdb 导出一个 composer（composerData + 其 bubble）作为 Scanner 回放样本。
// 只保留 Scanner 用到的字段，长字符串截断。只读打开，按 key 点查。
// 用法：tsx scripts/dump-cursor-composer.ts <composerId> > recordings/cursor/ide-composer-sample.json
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [id] = process.argv.slice(2)
const file = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
const db = new DatabaseSync(file, { readOnly: true })
const get = (key: string) => {
  const r = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as { value: string | Uint8Array } | undefined
  return r ? JSON.parse(typeof r.value === 'string' ? r.value : Buffer.from(r.value).toString('utf8')) : undefined
}
const cut = (v: unknown) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v)
const cd = get(`composerData:${id}`)
if (!cd) throw new Error(`没有 composerData:${id}`)
const KEEP = ['_v', 'composerId', 'name', 'status', 'createdAt', 'lastUpdatedAt', 'fullConversationHeadersOnly', 'generatingBubbleIds', 'workspaceIdentifier', 'isAgentic', 'unifiedMode', 'isDraft']
const composerData = Object.fromEntries(KEEP.filter((k) => k in cd).map((k) => [k, cd[k]]))
const bubbles: Record<string, unknown> = {}
for (const h of cd.fullConversationHeadersOnly ?? []) {
  const b = get(`bubbleId:${id}:${h.bubbleId}`)
  if (!b) continue
  const t = b.toolFormerData
  bubbles[h.bubbleId] = {
    _v: b._v,
    bubbleId: b.bubbleId,
    type: b.type,
    text: cut(b.text),
    createdAt: b.createdAt,
    ...(t ? { toolFormerData: { name: t.name, status: t.status, tool: t.tool, params: cut(t.params), result: cut(t.result) } } : {}),
  }
}
console.log(JSON.stringify({ composerData, bubbles }, null, 1))
db.close()
