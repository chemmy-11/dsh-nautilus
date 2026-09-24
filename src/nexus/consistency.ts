/**
 * @dsh-external/dsh-nautilus — 双路一致性口径（AL.4b/AL.5 判据口；**全仓唯一一份**）。
 *
 * 三指标（口径 = 决策 docs/1-planning/nautilus-alignment.md §5「验收基线」）：
 *   · `exact` = 完全一致率（人工 align === 自评 align 的对数占比）
 *   · `near`  = 相邻档一致率（|Δ| ≤ 1——1–5 量表下即「不跳档」的对数占比）
 *   · `kappa` = 二次加权 κ（K=5；w(i,j) = (i−j)²/(K−1)²；分母为 0 → null，不给假读数）
 * 留出集：确定性切分 `hash(session:turn) % N === 0`（FNV-1a 32 位，**不随机**、可复现）——
 * 只用于采纳/回滚判定，绝不进提示词、绝不参与 rubric 修订（决策 §5 边界）。
 * AL.4b v2：留出集读数随三指标一起出场（`consistencyOf().holdout`）——切分与指标同源，
 * 路由与脚本读同一批行、走同一份 `splitHoldout`，同库必同数（UI 不许自己再切一份）。
 *
 * **为什么必须共享**：路由（`GET /api/nautilus/m2/alignments` 的 `consistency`）与脚本
 * （`scripts/alignment-consistency.mjs`）若各写一份，同一批样本会读出两个 κ——两套口径是本仓库明令禁止的。
 * 故三指标与留出集分桶只在此处实现，脚本 import 构建产物 `lib/nexus/consistency.js`。
 * **本模块只算不判**：结论纪律与「留出集提升才采纳」都在调用方；样本不足阈值只有 `MIN_PAIRS` 一个来源
 * （路由 `scale.min` 与脚本 `--min` 的默认值都取它——UI 侧不再写本地常量）。
 *
 * 加入键约定（重要）：人工侧键 = `(session, turn)`（turn_annotation），自评侧键 = `(ext_ref, turn_ordinal)`
 * （selfcheck_record）——两侧都有行而配对数 = 0 时，多半是 ext_ref 语义不符，**大声提示而不是静默给 0 分**。
 *
 * 纯模块：零 I/O、零宿主依赖、零第三方 import（AL.6 边界；可单测）。
 */

/** 留出集分桶默认除数（N=5 → 20%；OQ-AL2 未定，沿用 AL.5 既有值）。 */
export const HOLDOUT_EVERY = 5

/**
 * 样本不足阈值（对）：`< MIN_PAIRS` 时**只作观察、不得据此调整 rubric**（决策 §5）。
 * 单点来源——路由 `scale.min`（UI 读它渲染「样本不足」态）与脚本 `--min` 默认值共用；
 * 同一个阈值散成两份常量就是两套口径，本仓库禁止。
 */
export const MIN_PAIRS = 50

/** 量表档数（1–5）：二次加权 κ 的 K 与权重分母都取它，不另写字面量。 */
export const ALIGN_SCALE = 5

/** 人工侧参与配对的**最小行形状**（turn_annotation 读侧的超集）。 */
export interface HumanAlignRow {
  session: string
  turn: number
  align: number | null
}

/** 自评侧参与配对的**最小行形状**（selfcheck_record 读侧的超集）。 */
export interface SelfAlignRow {
  extRef: string
  turnOrdinal: number
  align: number | null
}

/** 一条配对（两侧 align 均已就位）。 */
export interface AlignPair {
  /** `session:turn`——留出集分桶与去重都用它。 */
  key: string
  session: string
  turn: number
  human: number
  self: number
}

/** 三指标读数（exact/near 为 0–1 的**率**，不是百分数；空集三项皆 null）。 */
export interface ConsistencyMetrics {
  n: number
  exact: number | null
  near: number | null
  kappa: number | null
  /** 混淆表，键 `human->self`（与人可读的对照输出共用）。 */
  confusion: Record<string, number>
}

/**
 * 留出集切片读数（四字段）。**空切片 → exact/near 为 null**（本模块纪律：空集不报 0 分）；
 * 片内对数 = 1 时如实给出——与 AL.5 脚本打印的是同一份 `metrics` 输出，两端逐字可对。
 */
export interface HoldoutSummary {
  pairs: number
  exact: number | null
  near: number | null
  kappa: number | null
}

/** 路由契约用的读数（pairs<2 → null：一对样本给不出相关性，不给假读数）。 */
export interface ConsistencySummary {
  pairs: number
  exact: number
  near: number
  kappa: number | null
  /** 确定性留出集切片（AL.4b v2；只用于采纳/回滚判定，不进提示词、不改 rubric）。 */
  holdout: HoldoutSummary
}

/** FNV-1a 32 位：同 key 永远同桶——留出集可复现，不靠随机。 */
export function fnv1a(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** 是否落进留出集（every < 2 视为无留出集——调用方应先拒非法入参）。 */
export function isHoldout(key: string, every: number = HOLDOUT_EVERY): boolean {
  return Number.isInteger(every) && every >= 2 && fnv1a(key) % every === 0
}

/** 配对键：`<会话>:<轮次>`（人工 session / 自评 ext_ref 走同一拼法，键不符即配不上）。 */
export function pairKey(ref: string, turn: number): string {
  return ref + ':' + String(turn)
}

/**
 * 连接两侧 → 配对。自评按 `(ext_ref, turn_ordinal)` 建索引（唯一键由表约束保证），
 * 人工 side 顺序即输出顺序（调用方决定排序）；align 为 null 的行（旧代际/豁免）不参与配对。
 */
export function pairAlignments(
  human: readonly HumanAlignRow[],
  self: readonly SelfAlignRow[],
): AlignPair[] {
  const byKey = new Map<string, number>()
  for (const s of self) {
    if (s.align === null || s.align === undefined) continue
    byKey.set(pairKey(s.extRef, s.turnOrdinal), s.align)
  }
  const pairs: AlignPair[] = []
  for (const h of human) {
    if (h.align === null || h.align === undefined) continue
    const key = pairKey(h.session, h.turn)
    const s = byKey.get(key)
    if (s === undefined) continue
    pairs.push({ key, session: h.session, turn: h.turn, human: h.align, self: s })
  }
  return pairs
}

/** 确定性切分：留出集（只用于采纳判定）/ 进化集（其余）。同 key 永远同侧。 */
export function splitHoldout(
  pairs: readonly AlignPair[],
  every: number = HOLDOUT_EVERY,
): { holdout: AlignPair[]; evolution: AlignPair[] } {
  const holdout: AlignPair[] = []
  const evolution: AlignPair[] = []
  for (const p of pairs) (isHoldout(p.key, every) ? holdout : evolution).push(p)
  return { holdout, evolution }
}

/** 三指标（exact/near 为 0–1 的率；den=0 → kappa null）。空集不报 0，一律 null。 */
export function metrics(pairs: readonly AlignPair[]): ConsistencyMetrics {
  const n = pairs.length
  if (n === 0) return { n: 0, exact: null, near: null, kappa: null, confusion: {} }
  let exact = 0
  let near = 0
  const confusion: Record<string, number> = {}
  for (const p of pairs) {
    if (p.human === p.self) exact += 1
    if (Math.abs(p.human - p.self) <= 1) near += 1
    const k = p.human + '->' + p.self
    confusion[k] = (confusion[k] ?? 0) + 1
  }
  // 二次加权 κ（K 档；权重 = (i−j)²/(K−1)²）
  const K = ALIGN_SCALE
  const obs: number[][] = []
  const exp: number[][] = []
  for (let i = 0; i < K; i++) { obs.push(new Array<number>(K).fill(0)); exp.push(new Array<number>(K).fill(0)) }
  const humanCount = new Array<number>(K).fill(0)
  const selfCount = new Array<number>(K).fill(0)
  for (const p of pairs) {
    obs[p.human - 1][p.self - 1] += 1
    humanCount[p.human - 1] += 1
    selfCount[p.self - 1] += 1
  }
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) exp[i][j] = (humanCount[i] * selfCount[j]) / n
  let num = 0
  let den = 0
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
    const w = Math.pow(i - j, 2) / Math.pow(K - 1, 2)
    num += w * obs[i][j]
    den += w * exp[i][j]
  }
  const kappa = den === 0 ? null : 1 - num / den
  return { n, exact: exact / n, near: near / n, kappa, confusion }
}

/**
 * 路由契约读数：`{pairs, exact, near, kappa, holdout}`；**配对 < 2 → null**
 * （一对样本的一致性恒为「完全一致」，报出来是假读数）。
 * `holdout` 与 `scripts/alignment-consistency.mjs` 用**同一个** `splitHoldout`——
 * 同库同数，不是第二套切分。
 */
export function consistencyOf(pairs: readonly AlignPair[], every: number = HOLDOUT_EVERY): ConsistencySummary | null {
  if (pairs.length < 2) return null
  const m = metrics(pairs)
  const h = metrics(splitHoldout(pairs, every).holdout)
  return {
    pairs: m.n,
    exact: m.exact ?? 0,
    near: m.near ?? 0,
    kappa: m.kappa,
    holdout: { pairs: h.n, exact: h.exact, near: h.near, kappa: h.kappa },
  }
}
