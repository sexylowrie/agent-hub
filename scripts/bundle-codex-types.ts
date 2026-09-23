// 从 `codex app-server generate-ts` 的生成目录里，按根类型沿 `import type` 取闭包，
// 只复制用得到的文件到 <输出目录>，并给相对 import 补上 `.ts`（NodeNext 要求带扩展名），
// 再写 <输出目录>.ts 统一 re-export 根类型。生成目录里根与 v2/ 有同名类型，所以保留目录结构。
// 用法见 scripts/gen-codex-types.sh。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const [dir, outDir, ...roots] = process.argv.slice(2)
if (!dir || !outDir || !roots.length) {
  console.error('用法：tsx scripts/bundle-codex-types.ts <生成目录> <输出目录> <根类型...>')
  process.exit(1)
}

const IMPORT = /^(import type \{ [^}]+ \} from ")([^"]+)(";)\s*$/gm

const locate = (name: string): string => {
  // 同名时优先 v2（新协议）
  for (const idx of [join(dir, 'v2', 'index.ts'), join(dir, 'index.ts')]) {
    const m = readFileSync(idx, 'utf8').match(new RegExp(`export type \\{ ${name} \\} from "([^"]+)"`))
    if (m) return resolve(dirname(idx), m[1] + '.ts')
  }
  throw new Error(`找不到根类型 ${name}`)
}

const rootFiles = roots.map((r) => [r, locate(r)] as const)
const seen = new Map<string, string>()
const queue = rootFiles.map(([, f]) => f)
while (queue.length) {
  const f = queue.shift()!
  if (seen.has(f)) continue
  const src = readFileSync(f, 'utf8').replace(IMPORT, (_all, a, p, b) => {
    queue.push(resolve(dirname(f), p + '.ts'))
    return `${a}${p}.ts${b}`
  })
  seen.set(f, src)
}

rmSync(outDir, { recursive: true, force: true })
for (const [f, src] of seen) {
  const target = join(outDir, relative(dir, f))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, src)
}
const name = basename(outDir)
const lines = rootFiles.map(([r, f]) => `export type { ${r} } from './${name}/${relative(dir, f)}'`)
writeFileSync(
  `${outDir}.ts`,
  `// 由 scripts/gen-codex-types.sh 生成，勿手改。来源：${process.env.CODEX_VERSION ?? 'codex'} app-server generate-ts\n${lines.join('\n')}\n`,
)
console.log(`已写入 ${outDir}/（${seen.size} 个文件）与 ${outDir}.ts`)
