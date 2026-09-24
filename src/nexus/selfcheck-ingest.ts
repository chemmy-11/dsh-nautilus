/**
 * @dsh-external/dsh-nautilus — S1.1 共享自评 ingest（决策 D-SC3a 约束 1）；AL.3 起 **双形兼容**。
 *
 * 校验 + 归一 + 落库**唯一口径**：DSH 工具（selfcheck.ts）、HTTP 路由（routes.ts）、
 * 未来 MCP server（S1.3）都只是薄壳——口径只在此处一份，杜绝第二套校验漂移。
 *
 * 两代形态（AL.3 换维度，但**不打断老通道**）：
 *   · 新形（AL 对齐量表 `al-v1`，决策 nautilus-alignment §2）：`align` 1–5 整数 +
 *     `boundary`（四条边界，缺省 none）+ `declaration`/`quote` + `evidence`；
 *     `clarity`/`defense` **置 NULL**（v9 已允许），`rubric_version='al-v1'`，
 *     `schema_version` 缺省 **2**（1–5 量表锁版，同 turn_annotation 的 align 行）。
 *   · 旧形（S1.1 三行）：`clarity` 0–1 + `defense` 枚举 + `declaration`——**列值与判定逐字保留**，
 *     `align`/`boundary`/`evidence`/`rubric_version` 留 NULL（代际分层，决策 §9.3 **永不合并统计**）。
 *   分支判据：`align` 在场且非 null → 新形；否则旧形（旧形缺 clarity/defense 即拒）。
 *
 * 硬门沿 D-SC2 先例：`align>=4` 无引文、`declaration=1` 无引文 → 拒且**零写入**（不静默降级）。
 *
 * 本模块零 HTTP / 零工具 / 零宿主依赖（只依赖 store 的最小端口类型），纯逻辑可单测。
 * 严格语义：validateIngest **不夹取、不猜默认**——非法即拒（调用方决定映射 400 还是 isError）。
 * error 口径：invalid:<字段> / quote-required / align-quote-required / quote-too-long / evidence-too-long。
 */
import type { SelfCheckRecordRow } from '../store.js'

/** source_kind 枚举（集中常量——与 migrateV5 的 CHECK 一致；红线 4）。 */
export const SOURCE_KINDS = ['dsh_tool', 'http', 'backfill', 'mcp'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const DEFENSES = ['none', 'light', 'heavy'] as const
export type Defense = (typeof DEFENSES)[number]

/** 四条边界（锁版枚举；与 v8/v9 迁移的 CHECK 逐字一致——越界不改 align，但必记）。 */
export const BOUNDARIES = ['none', 'substitution', 'possession', 'coercion', 'projection'] as const
export type Boundary = (typeof BOUNDARIES)[number]

/** align 量表刻度（决策 §2.1：1–5，**不夹取**）。 */
export const ALIGN_MIN = 1
export const ALIGN_MAX = 5

/** 准则文本版本（签-6：起始值 al-v1）——新形逐行登记；旧形留 NULL。 */
export const RUBRIC_VERSION = 'al-v1'

/** 量表代际（selfcheck_record.schema_version）：新形 = 2（1–5 锁版），旧形 = 1（0–1 三行口径）。 */
export const SCHEMA_VERSION_ALIGN = 2
export const SCHEMA_VERSION_LEGACY = 1

/** 宣告引文上限（字数口径 = 决策 D-SC2）。 */
export const QUOTE_MAX = 200

/** evidence 上限（「可选短文本」的边界——防大字段直灌；超限拒，不截断）。 */
export const EVIDENCE_MAX = 500

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
  /** 旧形：清晰度 0–1（新形不得携带——新形由 align 取代，两个维度不混算）。 */
  clarity?: unknown
  /** 旧形：防御 none|light|heavy。 */
  defense?: unknown
  declaration: unknown
  quote?: unknown
  /** 新形：对齐 1–5（在场且非 null 即走新路径）。 */
  align?: unknown
  /** 新形：四条边界枚举（缺省 none）。 */
  boundary?: unknown
  /** 新形：可选短证据文本。 */
  evidence?: unknown
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

/** declaration 归一（两代共用）：只在 0/1 里取值，其余即拒（不猜默认）。 */
function readDeclaration(v: unknown): 0 | 1 | null {
  return v === 0 || v === 1 ? (v as 0 | 1) : null
}

/** 引文归一（trim）；越限报 quote-too-long（是否**必填**由各代自行判定）。 */
function readQuote(v: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, text: '' }
  if (typeof v !== 'string') return { ok: false, error: 'invalid:quote' }
  const text = v.trim()
  if (text.length > QUOTE_MAX) return { ok: false, error: 'quote-too-long' }
  return { ok: true, text }
}

/**
 * 严格校验并归一（不写库）。分支：`align` 在场且非 null → 新形（al-v1 对齐量表），否则旧形。
 * 旧形逐字保留改造前的判定顺序与宽松点（例如 declaration=0 携带引文一律丢弃、不报错）。
 */
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

  // ── 新形：AL 对齐量表（align 1–5 + boundary；clarity/defense 无值可填 → NULL）─────────────
  if (input.align !== undefined && input.align !== null) {
    const align = typeof input.align === 'number' && Number.isInteger(input.align)
      && input.align >= ALIGN_MIN && input.align <= ALIGN_MAX ? input.align : null
    if (align === null) return invalid('align') // 0 / 6 / 小数 / 字符串一律拒——不夹取、不猜默认

    const boundary = input.boundary === undefined || input.boundary === null
      ? 'none' // 锁版缺省：未越界填 none（非「猜」——枚举的文档缺省值）
      : (typeof input.boundary === 'string' && (BOUNDARIES as readonly string[]).includes(input.boundary)
        ? input.boundary as Boundary : null)
    if (boundary === null) return invalid('boundary')

    const declaration = readDeclaration(input.declaration)
    if (declaration === null) return invalid('declaration')

    const q = readQuote(input.quote)
    if (!q.ok) return q
    // D-SC2 硬门（先例照抄：拒绝即零写入，不静默降级）
    if (align >= 4 && q.text === '') return { ok: false, error: 'align-quote-required' }
    if (declaration === 1 && q.text === '') return { ok: false, error: 'quote-required' }
    // 引文只在「4/5 判读依据」或「宣告原句」时有语义；其余（align<=3 且 declaration=0）丢弃不落——
    // 与 turn_annotation 的 fit<>4 丢引文同口径，防 0+引文 的歧义行
    const quote = align >= 4 || declaration === 1 ? q.text : null

    let evidence: string | null = null
    if (input.evidence !== undefined && input.evidence !== null) {
      if (typeof input.evidence !== 'string') return invalid('evidence')
      const e = input.evidence.trim()
      if (e !== '') {
        if (e.length > EVIDENCE_MAX) return { ok: false, error: 'evidence-too-long' }
        evidence = e
      }
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

    let schemaVersion = SCHEMA_VERSION_ALIGN
    if (input.schemaVersion !== undefined && input.schemaVersion !== null) {
      if (typeof input.schemaVersion !== 'number' || !Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) return invalid('schema_version')
      schemaVersion = input.schemaVersion
    }

    return {
      ok: true,
      record: {
        tsClient, schemaVersion, sourceKind,
        agent, model, workspace, extRef, turnOrdinal,
        clarity: null, defense: null, declaration, quote,
        align, boundary, evidence, rubricVersion: RUBRIC_VERSION,
      },
    }
  }

  // ── 旧形：S1.1 三行（改造前行为逐字保留——老 harness 不断线）────────────────────────────
  const clarity = typeof input.clarity === 'number' && Number.isFinite(input.clarity) && input.clarity >= 0 && input.clarity <= 1
    ? input.clarity : null
  if (clarity === null) return invalid('clarity')

  const defense = typeof input.defense === 'string' && (DEFENSES as readonly string[]).includes(input.defense)
    ? input.defense as Defense : null
  if (defense === null) return invalid('defense')

  const declaration = readDeclaration(input.declaration)
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

  let schemaVersion = SCHEMA_VERSION_LEGACY
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
      align: null, boundary: null, evidence: null, rubricVersion: null,
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
