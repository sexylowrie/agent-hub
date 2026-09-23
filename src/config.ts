import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { Vendor } from './core/events.ts'

const VendorNums = z.object({ claude: z.number(), codex: z.number(), cursor: z.number() })

const ConfigSchema = z.object({
  listen: z.object({ host: z.string().min(1), port: z.number().int().positive() }),
  dataDir: z.string().min(1),
  binaries: z.object({ claude: z.string(), codex: z.string(), cursor: z.string() }),
  codex: z.object({ model: z.string() }),
  allowedCwds: z.array(z.string()),
  scanner: z.object({
    recentDays: z.number().positive(),
    reconcileSeconds: z.number().positive(),
    idleQuietMs: VendorNums,
  }),
  approval: z.object({ expireSeconds: z.number().positive() }),
})

export type HubConfig = z.infer<typeof ConfigSchema>

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

const FORBIDDEN_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*'])

export function loadConfig(file = process.env.HUB_CONFIG ?? 'hub.config.json'): HubConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`读取配置失败 ${file}: ${(e as Error).message}（先 cp hub.config.example.json hub.config.json）`)
  }
  const cfg = ConfigSchema.parse(raw)
  if (FORBIDDEN_HOSTS.has(cfg.listen.host)) {
    throw new Error(`listen.host=${cfg.listen.host} 不允许：只能监听 127.0.0.1 或 Tailscale 地址`)
  }
  cfg.dataDir = expandHome(cfg.dataDir)
  cfg.allowedCwds = cfg.allowedCwds.map(expandHome)
  cfg.binaries = {
    claude: expandHome(cfg.binaries.claude),
    codex: expandHome(cfg.binaries.codex),
    cursor: expandHome(cfg.binaries.cursor),
  }
  return cfg
}

/** cwd 是否落在 allowedCwds 某个前缀内（按真实路径比较）。 */
export function isCwdAllowed(cfg: HubConfig, cwd: string): boolean {
  let real: string
  try {
    real = realpathSync(expandHome(cwd))
  } catch {
    return false
  }
  return cfg.allowedCwds.some((root) => {
    let r: string
    try {
      r = realpathSync(root)
    } catch {
      return false
    }
    return real === r || real.startsWith(r + sep)
  })
}

export interface BinaryStatus {
  bin: string
  version?: string
  ok: boolean
  error?: string
}

function probe(bin: string): Promise<BinaryStatus> {
  return new Promise((done) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return done({ bin, ok: false, error: err.message.split('\n')[0] })
      done({ bin, ok: true, version: stdout.trim().split('\n')[0] })
    })
  })
}

export async function probeBinaries(cfg: HubConfig): Promise<Record<Vendor, BinaryStatus>> {
  const [claude, codex, cursor] = await Promise.all([
    probe(cfg.binaries.claude),
    probe(cfg.binaries.codex),
    probe(cfg.binaries.cursor),
  ])
  return { claude, codex, cursor }
}
