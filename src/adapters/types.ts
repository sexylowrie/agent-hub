import type { ApprovalKind, Decision, HubEvent, Vendor } from '../core/events.ts'

export interface ApprovalRequest {
  kind: ApprovalKind
  summary: string
  /** 给客户端展示的详情 */
  detail: unknown
  /** 厂商原始请求，落 approvals.payload 用于回执 */
  raw: unknown
}

export interface RunOpts {
  /** Hub 轮次 id，Adapter 产出的事件都带上 */
  turnId: string
  force?: boolean
  /** 只对 resume 有效：继承原会话上下文另开一条新会话（原会话不动），需产出 session.upsert 带新 id。
   *  只有 supportsFork 的 Adapter 会读它；其余忽略，Core 在调用前就拒绝（FORK_UNSUPPORTED） */
  fork?: boolean
  signal: AbortSignal
  onApproval: (req: ApprovalRequest) => Promise<Decision>
  /** 子进程拉起后回报 pid，用于 hub_turns 对账 */
  onSpawn?: (pid: number) => void
}

export interface AgentAdapter {
  readonly vendor: Vendor
  /** 续聊是否必须知道会话 cwd（默认 true）；为 false 时 cwd 可能传空串 */
  readonly requiresCwd?: boolean
  /** 是否支持 RunOpts.fork（默认 false） */
  readonly supportsFork?: boolean
  resume(vendorSessionId: string, cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent>
  /** 需产出 session.upsert 带新 id */
  start(cwd: string, text: string, opts: RunOpts): AsyncIterable<HubEvent>
}
