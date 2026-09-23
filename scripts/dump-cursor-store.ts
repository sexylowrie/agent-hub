// 把 Cursor CLI 会话的 ~/.cursor/chats/<ws>/<id>/store.db 导出成可提交的回放样本（JSON）：
// 保留 meta 与根 blob（protobuf，原样 hex）以及根引用的消息 blob（JSON，长字符串截断），丢弃其余中间节点，
// 去掉 blobEncryptionKey。测试里用 test/helpers.ts 的 storeDbFromSample() 还原成 sqlite。
// 用法：tsx scripts/dump-cursor-store.ts <store.db> > recordings/cursor/store-db-sample.json
import { DatabaseSync } from 'node:sqlite'
import { rootMessageIds } from '../src/scanner/cursor.ts'

const [src] = process.argv.slice(2)
const db = new DatabaseSync(src, { readOnly: true })
const metaRow = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value: string }
const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8'))
delete meta.blobEncryptionKey
const blob = (id: string) => (db.prepare('SELECT data FROM blobs WHERE id=?').get(id) as { data: Uint8Array } | undefined)?.data
const root = blob(meta.latestRootBlobId)!
const cut = (v: unknown): unknown => {
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v
  if (Array.isArray(v)) return v.map(cut)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'signature' ? '' : cut(x)]))
  return v
}
const messages = rootMessageIds(root).map((id) => ({ id, json: cut(JSON.parse(Buffer.from(blob(id)!).toString('utf8'))) }))
console.log(JSON.stringify({ meta, root: { id: meta.latestRootBlobId, hex: Buffer.from(root).toString('hex') }, messages }, null, 1))
db.close()
