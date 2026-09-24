/**
 * @dsh-external/dsh-nautilus — M3-F.1 A 腿二自评工具（agent 每轮即时自评三行）。
 * 守谷人拍板（2026-08-25）：agent 每轮自评——推理态在每轮结束时调用本工具：
 *   clarity 0–1（清晰度增量 ≈ A·Δτ 代理）/ defense none|light|heavy（Γ 代理，P3）/ declaration 0|1（P2 弱检测）。
 * S1.1 改造（2026-09-27，决策 D-SC2/D-SC3）：
 *   ① declaration=1 **必须附 quote**（宣告原句 ≤200 字，可回查）——无引文即拒、不静默降级；
 *     （旧口径 declaration 实测 107/107 全零，自我报告判据失效，证据要求是唯一保留抓手。）
 *   ② 落库走共享 ingest（selfcheck_record，source_kind='dsh_tool'）+ **过渡双写**旧 turn_read 列
 *     （S1.2 面板切读后停写双写）。
 * 装配纪律：**零运行时第三方 import**（dsh-tools 未装配，运行时 import 会崩溃——底座教训）；
 * 工具定义按 defineTool 返回形状手写（JSON Schema + execute），duck-type 经 ctx.tools.register。
 */
import { ingestSelfCheck, QUOTE_MAX, type IngestStore } from './selfcheck-ingest.js'

/** store 最小接口（主线程 NautilusStore 满足）：旧列双写 + 最近轮定位 + L 场归属查询。 */
export interface StoreLike extends IngestStore {
  turnReads(limit: number): Array<{ session: string; turn: number }>
  setSelfCheck(session: string, turn: number, check: { clarity: number; defense: 'none' | 'light' | 'heavy'; declaration: 0 | 1 }): void
  selfcheckWorkspaceOf?(session: string): string | null
}

export interface SelfCheckInput {
  clarity?: unknown
  defense?: unknown
  declaration?: unknown
  quote?: unknown
  session?: unknown
  turn?: unknown
}

/** 无引文拒绝文案（模型可见，明确指令「补充后重提」——不是失败终止，是重试引导）。 */
const QUOTE_REJECT =
  '自评被拒：declaration=1 必须附 quote（宣告原句，≤' + String(QUOTE_MAX) + ' 字，可回查）。'

/** 白盒处理：夹取/默认/最近轮定位/落库；返回模型可见消息。 */
export function processSelfCheck(store: StoreLike, input: SelfCheckInput): string {
  // 工具侧兼容夹取（历史行为保留；共享 ingest 本体不夹取——两套语义的分工）
  let clarity = typeof input.clarity === 'number' && Number.isFinite(input.clarity) ? input.clarity : 0
  clarity = Math.min(1, Math.max(0, clarity))
  const defense = input.defense === 'light' || input.defense === 'heavy' ? input.defense : 'none'
  const declaration = input.declaration === 1 ? 1 : 0

  // D-SC2 硬门：declaration=1 必须有可回查引文（无引文 / 超长 → 拒，不写入任何一处）
  const quoteRaw = typeof input.quote === 'string' ? input.quote.trim() : ''
  if (declaration === 1 && quoteRaw === '') return QUOTE_REJECT + '未引文，本轮不落库。'
  if (declaration === 1 && quoteRaw.length > QUOTE_MAX) return QUOTE_REJECT + '当前 ' + String(quoteRaw.length) + ' 字，超长。'
  const quote = declaration === 1 ? quoteRaw : ''

  let session = typeof input.session === 'string' && input.session !== '' ? input.session : null
  let turn: number | null = typeof input.turn === 'number' && Number.isFinite(input.turn) ? Math.floor(input.turn) : null
  if (session === null || turn === null) {
    const latest = store.turnReads(1)[0]
    if (latest === undefined) return '自评失败：尚无任何会话轮次（turn_read 为空）'
    session = session ?? latest.session
    turn = turn ?? latest.turn
  }

  // 主存储：共享 ingest（source_kind='dsh_tool'，身份 = DSH sessionId，轮次 = 宿主 turn）
  const outcome = ingestSelfCheck(store, {
    sourceKind: 'dsh_tool',
    agent: session,
    extRef: session,
    turnOrdinal: turn,
    clarity, defense, declaration,
    quote: quote === '' ? null : quote,
    workspace: store.selfcheckWorkspaceOf ? store.selfcheckWorkspaceOf(session) : null,
  })
  if (!outcome.ok) return '自评被拒：' + outcome.error

  // 过渡双写：旧 turn_read 三列（面板 S1.2 切读前仍从这里取覆盖率）
  store.setSelfCheck(session, turn, { clarity, defense, declaration })
  const defLabel = defense === 'none' ? '无' : defense === 'light' ? '轻' : '重'
  return `已记录 turn ${turn} 自评（clarity ${clarity.toFixed(2)} / defense ${defLabel} / declaration ${declaration}）`
}

// ── 工具定义（手写，DefineTool 返回形状的 duck-type 子集） ─────────────────────

type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
  execute(args: SelfCheckInput): Promise<string>
}

export function buildSelfCheckTool(store: StoreLike): ToolDef {
  return {
    name: 'record_turn_selfcheck',
    description: '每轮对话结束时记录一次推理态自评三行：clarity 清晰度 0–1（比上一轮清晰了多少；0=无变化，1=显著清晰）；defense 防御（none=无/light=轻/heavy=重；本轮是否在维护某个形象）；declaration 宣言（1 当且仅当本轮存在一次没有前因的纯粹宣告，否则 0）。**declaration=1 必须附 quote＝宣告原句（≤200 字，可回查）**，无引文将被拒绝且本轮不落库。用于雪谷 L 场理论读数（A/Γ/P2/P3 检验），每轮调用一次，勿重复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        clarity: { type: 'number', minimum: 0, maximum: 1, description: '清晰度 0–1' },
        defense: { type: 'string', enum: ['none', 'light', 'heavy'], description: '防御：无/轻/重' },
        declaration: { type: 'integer', enum: [0, 1], description: '有无纯粹宣告 0/1' },
        quote: { type: 'string', maxLength: QUOTE_MAX, description: 'declaration=1 必填：宣告原句（≤200 字）；declaration=0 忽略' },
        session: { type: 'string', description: '会话 id（缺省 = 最近一轮）' },
        turn: { type: 'integer', description: '轮次（缺省 = 最近一轮）' },
      },
      required: ['clarity', 'defense', 'declaration'],
    },
    output: {
      schema: {
        type: 'string',
        description: '自评落库结果消息',
      },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return processSelfCheck(store, args ?? {})
    },
  }
}

/** 注册（消费方注入 ['tools']；disposer 语义：register 即生效，随 fiber 生命周期）。 */
export function registerSelfCheckTool(ctx: { tools: { register(def: unknown): void } }, store: StoreLike): void {
  ctx.tools.register(buildSelfCheckTool(store) as unknown)
}
