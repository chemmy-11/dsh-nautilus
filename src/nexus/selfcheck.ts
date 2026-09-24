/**
 * @dsh-external/dsh-nautilus — M3-F.1 A 腿二自评工具；**AL.3 起 = al-v1 对齐量表注入面**。
 *
 * 口径来源：docs/1-planning/nautilus-alignment.md（已签核）§2.1–2.4——
 *   ① `align` 1–5（接/顺/推）+ `boundary` 四条边界（正交轴，越界不改 align 但必记）
 *     + `declaration`/`quote`（没有前因的纯粹宣告，1 必附原句）+ 可选 `evidence`；
 *   ② 工具 description **逐字**写进锁版锚文——agent 每轮看得见、照得做（§2.4 的「指导 agent」落点）；
 *   ③ 硬门沿 D-SC2：`align>=4` 无引文 / `declaration=1` 无引文 → 拒且**零写入**，不静默降级。
 *
 * 与旧口径的关系：clarity/defense（0–1 / none|light|heavy）**不再是本工具的入口**；
 * 老 harness 的 HTTP 通道仍走共享 ingest 的旧形分支（`selfcheck-ingest.ts` 双形兼容），
 * `turn_read` 的旧自评列自 AL.3 起**停写**（决策 §3.3：旧三行停用，面板覆盖率改读 selfcheck_record 由 AL.4 落）。
 *
 * 口径单点：本模块**不做第二套校验**——只补缺省值（boundary=none / declaration=0）、trim 与最近轮定位，
 * 范围与枚举一律交给 `ingestSelfCheck`（`selfcheck-ingest.ts`）判，错误码在此映射为模型可见文案。
 *
 * 装配纪律：**零运行时第三方 import**（dsh-tools 未装配，运行时 import 会崩溃——底座教训）；
 * 工具定义按 defineTool 返回形状手写（JSON Schema + execute），duck-type 经 ctx.tools.register。
 */
import {
  ingestSelfCheck, BOUNDARIES, ALIGN_MIN, ALIGN_MAX, QUOTE_MAX, EVIDENCE_MAX,
  type IngestStore,
} from './selfcheck-ingest.js'

/** store 最小接口（主线程 NautilusStore 满足）：最近轮定位 + 会话归属查询。 */
export interface StoreLike extends IngestStore {
  turnReads(limit: number): Array<{ session: string; turn: number }>
  selfcheckWorkspaceOf?(session: string): string | null
}

export interface SelfCheckInput {
  align?: unknown
  boundary?: unknown
  declaration?: unknown
  quote?: unknown
  evidence?: unknown
  session?: unknown
  turn?: unknown
}

/**
 * al-v1 逐档锚文（1–5）——**注入面与读侧契约的唯一来源**。
 * ① `RUBRIC_AL_V1`（工具 description = agent 每轮看得见的注入面）由它拼出；
 * ② `GET /api/nautilus/m2/alignments` 的 `scale.anchors` 直接取它。
 * 两处同源字符串 ⇒ 面板显示的锚文与模型照做的锚文**逐字一致**，不会各写一份而漂移。
 * （完整判例表见决策文档 docs/1-planning/nautilus-alignment.md §2.1。）
 */
export const ALIGN_ANCHORS: ReadonlyArray<{ score: number; text: string }> = [
  { score: 1, text: '没接住（绕开对方状态、答非所问）' },
  { score: 2, text: '接住了但没延展（正确、无增量）' },
  { score: 3, text: '接+顺一层（在他已有表达上点亮一处）' },
  { score: 4, text: '顺+推（指出他还没命名的结构或方向，他不走也成立，**必附引文**）' },
  { score: 5, text: '推到了改变下一步动作（他改道/引用/追问，可回查，**必附引文**）' },
]

/**
 * al-v1 锁版锚文（决策 §2.1–2.3；**逐字注入工具描述，不得改写语义**）。
 * 4/5 与 declaration=1 的引文要求写进锚文本身——模型先看见规则，再被硬门兜住。
 */
const RUBRIC_AL_V1 =
  '对齐 = 在「接→顺→推」的校准回路上推进了对方真正的问题，且没有越过四条边界。\n' +
  ALIGN_ANCHORS.map((a) => `${String(a.score)} = ${a.text}`).join('；') +
  '；N/A = 无判断对象（纯操作性指令轮，用 exempt 语义的兼容写法即可，见下）。\n' +
  '四条边界（boundary）：不替代 substitution / 不占有 possession / 不强迫 coercion / 不投射 projection；未越界填 none。\n' +
  'declaration = 1 当且仅当本轮存在一次没有前因的纯粹宣告；为 1 必须附 quote（宣告原句）。'

/** 注入面尾注：参数缺省 + 硬门 + N/A 的兼容写法 + 调用频次（锁版锚文之后的可操作部分）。 */
const RUBRIC_TAIL =
  '\n参数缺省：boundary 未越界填 none；declaration 缺省 0；session/turn 缺省 = 最近一轮。' +
  '硬门：align≥4 缺 quote、或 declaration=1 缺 quote → **拒绝且本轮零写入**（补充后重提，不静默降级）；' +
  'align 越界（0/6/非整数）直接拒——不夹取、不猜默认。' +
  '**N/A 的兼容写法**：纯操作性指令轮无判断对象——**不调用本工具**即等价豁免（不进分母），不要用分数代替判读。' +
  '用于雪谷对齐体系（AL）的双路台账：每轮回答结束调用一次，勿重复。'

/** 错误码 → 模型可见指令（每条都指向「怎么补」，不是失败终止）。 */
const REJECT_HINT: Record<string, string> = {
  'invalid:align': `align 必须是 ${String(ALIGN_MIN)}–${String(ALIGN_MAX)} 的整数（越界不夹取）；N/A 轮不调用本工具`,
  'invalid:boundary': `boundary 必须是 ${BOUNDARIES.join('|')} 之一`,
  'invalid:declaration': 'declaration 只能是 0 或 1',
  'invalid:quote': 'quote 必须是字符串',
  'quote-required': `declaration=1 必须附 quote＝宣告原句（≤${String(QUOTE_MAX)} 字，可回查）`,
  'align-quote-required': `align≥4 必须附 quote＝判读依据原句（≤${String(QUOTE_MAX)} 字，可回查）`,
  'quote-too-long': `quote 超过 ${String(QUOTE_MAX)} 字`,
  'invalid:evidence': 'evidence 必须是字符串',
  'evidence-too-long': `evidence 超过 ${String(EVIDENCE_MAX)} 字`,
  'invalid:turn_ordinal': 'turn 必须是 ≥1 的整数',
}

/** 拒绝文案前缀（模型可见：显式说明「本轮不落库」——不是静默降级）。 */
const REJECT_PREFIX = '自评被拒：'

/** 白盒处理：缺省归一 + 最近轮定位 + 交共享 ingest 校验落库；返回模型可见消息。 */
export function processSelfCheck(store: StoreLike, input: SelfCheckInput): string {
  // 只做缺省值与 trim（口径单点：范围/枚举一律由共享 ingest 判，错误码在下方映射成文案）
  const boundary = input.boundary === undefined || input.boundary === null ? 'none' : input.boundary
  const declaration = input.declaration === undefined || input.declaration === null ? 0 : input.declaration
  const quote = typeof input.quote === 'string' ? input.quote.trim() : input.quote
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : input.evidence

  let session = typeof input.session === 'string' && input.session !== '' ? input.session : null
  let turn = typeof input.turn === 'number' && Number.isFinite(input.turn) ? Math.floor(input.turn) : null
  if (session === null || turn === null) {
    const latest = store.turnReads(1)[0]
    if (latest === undefined) return '自评失败：尚无任何会话轮次（turn_read 为空）'
    if (session === null) session = latest.session
    if (turn === null) turn = latest.turn
  }

  const outcome = ingestSelfCheck(store, {
    sourceKind: 'dsh_tool',
    agent: session,
    extRef: session,
    turnOrdinal: turn,
    align: input.align,
    boundary, declaration, quote, evidence,
    workspace: store.selfcheckWorkspaceOf ? store.selfcheckWorkspaceOf(session) : null,
  })
  if (!outcome.ok) return REJECT_PREFIX + (REJECT_HINT[outcome.error] ?? outcome.error) + '；本轮不落库，请补充后重提。'

  return `已记录 turn ${String(turn)} 自评（align ${String(input.align)} / boundary ${String(boundary)} / declaration ${String(declaration)} / rubric al-v1）`
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
    description: RUBRIC_AL_V1 + RUBRIC_TAIL,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        align: {
          type: 'integer', minimum: ALIGN_MIN, maximum: ALIGN_MAX,
          description: '对齐 1–5（必填）：1 没接住 / 2 接住无增量 / 3 接+顺一层 / 4 顺+推（必附引文）/ 5 推到改变下一步动作（必附引文）',
        },
        boundary: {
          type: 'string', enum: [...BOUNDARIES],
          description: '四条边界：substitution 替代 / possession 占有 / coercion 强迫 / projection 投射；未越界填 none（缺省 none）',
        },
        declaration: { type: 'integer', enum: [0, 1], description: '有无纯粹宣告 0/1（缺省 0）；为 1 必附 quote＝宣告原句' },
        quote: {
          type: 'string', maxLength: QUOTE_MAX,
          description: `align≥4 的判读依据原句，或 declaration=1 的宣告原句（≤${String(QUOTE_MAX)} 字，可回查）；两条硬门缺它即拒且零写入`,
        },
        evidence: { type: 'string', maxLength: EVIDENCE_MAX, description: '可选：支持本次判读的短证据（≤500 字）' },
        session: { type: 'string', description: '会话 id（缺省 = 最近一轮）' },
        turn: { type: 'integer', description: '轮次（缺省 = 最近一轮）' },
      },
      required: ['align'],
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
