import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(import.meta.dirname, '..', 'recordings')

/** 读取录制文件：返回子进程 stdout 行（去掉 `<< ` 前缀，跳过 `>> ` 我方写入） */
export function stdoutLines(rel: string): any[] {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('>> '))
    .map((l) => JSON.parse(l.startsWith('<< ') ? l.slice(3) : l))
}

/** 我方写入 stdin 的行（`>> [SIGINT]` 这类动作标记除外） */
export function stdinLines(rel: string): any[] {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('>> ') && !l.startsWith('>> ['))
    .map((l) => JSON.parse(l.slice(3)))
}

export function recordingPath(rel: string): string {
  return join(ROOT, rel)
}

/** recordings/cursor/store-db-sample.json → 临时 store.db（表结构与 ~/.cursor/chats 实测一致） */
export function storeDbFromSample(rel: string, file: string) {
  const s = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);')
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify(s.meta)).toString('hex'))
  const ins = db.prepare('INSERT INTO blobs VALUES (?, ?)')
  ins.run(s.root.id, Buffer.from(s.root.hex, 'hex'))
  for (const m of s.messages) ins.run(m.id, Buffer.from(JSON.stringify(m.json)))
  db.close()
  return s
}

/** recordings/cursor/ide-composer-sample.json → 临时 state.vscdb（cursorDiskKV 表） */
export function vscdbFromSamples(rels: string[], file: string, patch: (cd: any) => void = () => {}) {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const ins = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)')
  for (const rel of rels) {
    const s = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
    const cd = structuredClone(s.composerData)
    patch(cd)
    ins.run(`composerData:${cd.composerId}`, JSON.stringify(cd))
    for (const [bid, b] of Object.entries(s.bubbles)) ins.run(`bubbleId:${cd.composerId}:${bid}`, JSON.stringify(b))
  }
  db.close()
}
