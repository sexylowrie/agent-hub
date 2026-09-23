import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'recordings')

/** 读取录制文件：返回子进程 stdout 行（去掉 `<< ` 前缀，跳过 `>> ` 我方写入） */
export function stdoutLines(rel: string): any[] {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('>> '))
    .map((l) => JSON.parse(l.startsWith('<< ') ? l.slice(3) : l))
}

/** 我方写入 stdin 的行 */
export function stdinLines(rel: string): any[] {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('>> '))
    .map((l) => JSON.parse(l.slice(3)))
}
