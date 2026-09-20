/**
 * @dsh-external/dsh-nautilus — S1.1 共享自评 ingest（决策 D-SC3a 约束 1）。
 *
 * 校验 + 归一 + 落库唯一口径：DSH 工具（selfcheck.ts）、HTTP 路由（routes.ts）、
 * 未来 MCP server（S1.3）都只是薄壳——**口径只在此处一份**，杜绝第二套校验漂移。
 *
 * 本模块零 HTTP / 零工具 / 零宿主依赖（只依赖 store 的最小端口类型），纯逻辑可单测。
 * 严格语义：validateIngest **不夹取、不猜默认**——非法即拒（调用方决定映射 400 还是 isError）。
 * DSH 工具侧的历史兼容夹取（clarity 越界夹取等）留在工具薄壳里做，不污染本口径。
 */
import type { SelfCheckRecordRow } from './store.js'

/** source_kind 枚举（集中常量——与 migrateV5 的 CHECK 一致；红线 4）。 */
export const SOURCE_KINDS = ['dsh_tool', 'http', 'backfill', 'mcp'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const DEFENSES = ['none', 'light', 'heavy'] as const
export type Defense = (typeof DEFENSES)[number]

/** 宣告引文上限（字数口径 = 决策 D-SC2）。 */
export const QUOTE_MAX = 200

/** 身份字段的长度上限（防大字段直灌；HTTP 侧另有体长门）。 */
const STR_MAX = { agent: 120, extRef: 160, model: 120, workspace: 512 } as const

/** store 最小端口（NautilusStore 满足；测试可注入替身）。 */
export interface IngestStore {
  insertSelfCheckRecord(row: SelfCheckRecordRow): 'inserted' | 'duplicate'
}

/** 待校验输入（字段名沿用外部契约的 snake_case 语义，值全 unknown——外部世界不可信）。 */
export interface IngestInput {
  sourceKind: unknown
  agent: unknown
  extRef: unknown
  turnOrdinal: unknown
  clarity: unknown
  defense: unknown
  declaration: unknown
  quote?: unknown
  model?: unknown
  workspace?: unknown
  tsClient?: unknown
  schemaVersion?: unknown
}

export type ValidateResult =
  | { ok: true; record: Omit<SelfCheckRecordRow, 'tsMs'> }
  | { ok: false; error: string }

function invalid(field: string): { ok: false; error: string } {
  return { ok: false, error: `invalid:${field}` }
}

function boundedStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t === '' || t.length > max) return undefined
  return t
}

/** 严格校验并归一（不写库）。error 口径：invalid:<字段> / quote-required / quote-too-long。 */
export function validateIngest(input: IngestInput): ValidateResult {
  const sourceKind = typeof input.sourceKind === 'string' && (SOURCE_KINDS as readonly string[]).includes(input.sourceKind)
    ? input.sourceKind as SourceKind : null
  if (sourceKind === null) return invalid('source_kind')

  const agent = boundedStr(input.agent, STR_MAX.agent)
  if (typeof agent !== 'string') return invalid('agent')
  const extRef = boundedStr(input.extRef, STR_MAX.extRef)
  if (typeof extRef !== 'string') return invalid('ext_ref')

  const turnOrdinal = typeof input.turnOrdinal === 'number' && Number.isInteger(input.turnOrdinal) && input.turnOrdinal >= 1
    ? input.turnOrdinal : null
  if (turnOrdinal === null) return invalid('turn_ordinal')

  const clarity = typeof input.clarity === 'number' && Number.isFinite(input.clarity) && input.clarity >= 0 && input.clarity <= 1
    ? input.clarity : null
  if (clarity === null) return invalid('clarity')

  const defense = typeof input.defense === 'string' && (DEFENSES as readonly string[]).includes(input.defense)
    ? input.defense as Defense : null
  if (defense === null) return invalid('defense')

  const declaration = input.declaration === 0 || input.declaration === 1 ? (input.declaration as 0 | 1) : null
  if (declaration === null) return invalid('declaration')

  let quote: string | null = null
  if (declaration === 1) {
    if (input.quote === undefined || input.quote === null || (typeof input.quote === 'string' && input.quote.trim() === '')) {
      return { ok: false, error: 'quote-required' }
    }
    const q = boundedStr(input.quote, QUOTE_MAX)
    if (typeof q !== 'string') return typeof input.quote === 'string' && input.quote.trim().length > QUOTE_MAX
      ? { ok: false, error: 'quote-too-long' } : invalid('quote')
    quote = q
  } else if (input.quote !== undefined && input.quote !== null && !(typeof input.quote === 'string' && input.quote.trim() === '')) {
    // declaration=0 携带引文：丢弃不落（防「0+引文」歧义行；不报错——引文只在 declaration=1 有语义）
    quote = null
  }

  const model = boundedStr(input.model, STR_MAX.model)
  if (model === undefined) return invalid('model')
  const workspace = boundedStr(input.workspace, STR_MAX.workspace)
  if (workspace === undefined) return invalid('workspace')

  let tsClient: number | null = null
  if (input.tsClient !== undefined && input.tsClient !== null) {
    if (typeof input.tsClient !== 'number' || !Number.isFinite(input.tsClient) || input.tsClient < 0) return invalid('ts_client')
    tsClient = Math.floor(input.tsClient)
  }

  let schemaVersion = 1
  if (input.schemaVersion !== undefined && input.schemaVersion !== null) {
    if (typeof input.schemaVersion !== 'number' || !Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) return invalid('schema_version')
    schemaVersion = input.schemaVersion
  }

  return {
    ok: true,
    record: {
      tsClient, schemaVersion, sourceKind,
      agent, model, workspace, extRef, turnOrdinal,
      clarity, defense, declaration, quote,
    },
  }
}

export type IngestOutcome = { ok: true; result: 'inserted' | 'duplicate' } | { ok: false; error: string }

/** 校验 + 落库一步到位（ts_ms = 宿主接收时刻，权威时钟；来源自报只进 ts_client）。 */
export function ingestSelfCheck(store: IngestStore, input: IngestInput): IngestOutcome {
  const v = validateIngest(input)
  if (!v.ok) return v
  const result = store.insertSelfCheckRecord({ ...v.record, tsMs: Date.now() })
  return { ok: true, result }
}
