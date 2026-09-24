/**
 * @dsh-external/dsh-nautilus — 告警报告（A 系列 A.3）：确定性 digest + prompt + 三段式报告。
 *
 * 分段纪律（决策文档 §7 边界 4）：**事实段由程序生成**（可复算、可审计），模型只填
 * 「候选假设」与「待查」两段。所以本文件里 digest / 事实段 / 报告骨架全是纯函数，
 * 模型调用留在插件半区（index.ts），测试不必真调模型。
 *
 * 三段物理分栏：
 *   一、事实（程序生成，不经模型）  二、候选假设（模型输出，仅供人工判定）  三、待查
 */
import type { SnapshotMeta } from './snapshot.js'

/** 报告模板版本（进台账 prompt_version；模板一改就递增，新旧报告不混算）。 */
export const REPORT_PROMPT_VERSION = 'a-report-v1'

/** 单指标窗口聚合（确定性）。 */
export interface DigestMetric {
  metric: string
  n: number
  min: number
  max: number
  last: number
  mean: number
}

export interface AlertDigest {
  alertId: string
  ruleId: string
  ruleLabel: string
  metric: string
  op: string
  threshold: number
  clear: number
  firstExceededAt: number
  confirmedAt: number
  peak: number
  window: { from: number; to: number; lookbackMs: number }
  evidence: {
    rows: number
    distinctTicks: number
    cadenceMs: number | null
    coverage: number
    gapCount: number
    maxGapMs: number
    activeSessions: number | null
    snapshotHash: string
  }
  metrics: DigestMetric[]
  era: string
  generatedAt: number
}

export interface DigestInput {
  alertId: string
  ruleId: string
  ruleLabel: string
  metric: string
  op: string
  threshold: number
  clear: number
  firstExceededAt: number
  confirmedAt: number
  peak: number
  meta: SnapshotMeta
  snapshotHash: string
  /** 逐指标聚合（调用方用 aggregateMetrics 从窗口行算出；本函数不碰 I/O）。 */
  metrics: DigestMetric[]
  now?: number
}

/** 逐指标聚合（纯函数；空窗口 → 空数组，不编 0 行读数）。 */
export function aggregateMetrics(rows: ReadonlyArray<{ metric: string; value: number | null }>): DigestMetric[] {
  const acc = new Map<string, { n: number; min: number; max: number; sum: number; last: number; lastTs: number }>()
  // 说明：调用方按 ts 升序喂入，故「最后见到的一条非空值」即窗口末值
  for (const r of rows) {
    if (r.value === null || !Number.isFinite(r.value)) continue
    const cur = acc.get(r.metric)
    if (cur === undefined) acc.set(r.metric, { n: 1, min: r.value, max: r.value, sum: r.value, last: r.value, lastTs: 0 })
    else { cur.n += 1; cur.min = Math.min(cur.min, r.value); cur.max = Math.max(cur.max, r.value); cur.sum += r.value; cur.last = r.value }
  }
  return [...acc.entries()].map(([metric, v]) => ({ metric, n: v.n, min: v.min, max: v.max, last: v.last, mean: v.sum / v.n }))
    .sort((a, b) => (a.metric < b.metric ? -1 : 1))
}

export function buildDigest(input: DigestInput): AlertDigest {
  const m = input.meta
  return {
    alertId: input.alertId, ruleId: input.ruleId, ruleLabel: input.ruleLabel,
    metric: input.metric, op: input.op, threshold: input.threshold, clear: input.clear,
    firstExceededAt: input.firstExceededAt, confirmedAt: input.confirmedAt, peak: input.peak,
    window: { from: m.from, to: m.to, lookbackMs: m.lookbackMs },
    evidence: {
      rows: m.rows, distinctTicks: m.distinctTicks, cadenceMs: m.cadenceMs,
      coverage: m.coverage, gapCount: m.gapCount, maxGapMs: m.maxGapMs,
      activeSessions: m.activeSessions, snapshotHash: input.snapshotHash,
    },
    metrics: input.metrics,
    era: m.era,
    generatedAt: input.now ?? Date.now(),
  }
}

/** 事实段条目（程序生成；顺序固定 → 报告可复算）。 */
export function digestFacts(d: AlertDigest): string[] {
  const iso = (t: number): string => new Date(t).toISOString()
  const pct = (x: number): string => (x * 100).toFixed(1) + '%'
  const facts = [
    '规则 \`' + d.ruleId + '\`（' + d.ruleLabel + '）：' + d.metric + ' ' + d.op + ' ' + String(d.threshold) + '（解除线 ' + String(d.clear) + '）',
    '首次越线 ' + iso(d.firstExceededAt) + ' → 确认 ' + iso(d.confirmedAt) + '（连续 ' + String(Math.round((d.confirmedAt - d.firstExceededAt) / 1000)) + 's）',
    '越线段峰值 ' + String(d.peak) + '（阈值 ' + String(d.threshold) + '）',
    '证据窗口 ' + iso(d.window.from) + ' → ' + iso(d.window.to) + '（回看 ' + String(Math.round(d.window.lookbackMs / 3600000)) + 'h）',
    '覆盖 ' + pct(d.evidence.coverage) + ' · 空洞 ' + String(d.evidence.gapCount) + (d.evidence.gapCount > 0 ? '（最大 ' + String(Math.round(d.evidence.maxGapMs / 60000)) + 'min）' : '') +
      ' · 采样档 ' + (d.evidence.cadenceMs === null ? '—' : String(Math.round(d.evidence.cadenceMs)) + 'ms') +
      ' · 原始行 ' + String(d.evidence.rows) + '（' + String(d.evidence.distinctTicks) + ' 个 tick）',
    '窗口内活跃会话 ' + (d.evidence.activeSessions === null ? '不可得' : String(d.evidence.activeSessions)),
  ]
  for (const m of d.metrics) {
    facts.push('指标 \`' + m.metric + '\`：n=' + String(m.n) + ' min=' + fmtNum(m.min) + ' max=' + fmtNum(m.max) + ' mean=' + fmtNum(m.mean) + ' last=' + fmtNum(m.last) + '（+' + String(d.era) + ' 时代，仅作对照）')
  }
  return facts
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'G'
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'k'
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '')
}

/** prompt（确定性；模型只被要求填两段，事实段由程序给全）。 */
export function buildPrompt(d: AlertDigest, facts: readonly string[]): { system: string; user: string } {
  const system = [
    '你是本机观测台（Nautilus）的告警分析助手。你的职责是**提出候选假设**，不是下结论。',
    '硬约束：',
    '1. 只能依据给定的事实段推测，不得引入外部知识或凭空的进程名；',
    '2. 不得给出处置动作（不杀进程、不改配置）——处置由人决定；',
    '3. 每条假设必须给出「可观测的验证方式」（看哪个指标/哪段时间）；',
    '4. 无法解释就写「无法从现有证据判断」，不要编。',
    '输出格式（严格两段，不要多余前后缀）：',
    '=== 候选假设 ===',
    '- （≤4 条，每条一行：假设 + 依据 + 验证方式）',
    '=== 待查 ===',
    '- （≤4 条，每条一行：还需要哪份证据才能排除某个假设）',
  ].join('\n')
  const user = [
    '## 事实（程序生成，未经模型）',
    ...facts.map((f) => '- ' + f),
    '',
    '请按上面的输出格式作答。时代档位：' + d.era + '（api 时代只作对照，不得宣称因果）。',
  ].join('\n')
  return { system, user }
}

/** 解析模型输出（拿不到分隔符就把全文当假设段，待查段留空——不丢内容、不假装有结构）。 */
export function parseHypotheses(raw: string): { hypotheses: string; toCheck: string; parsed: boolean } {
  const text = raw.trim()
  const hIdx = text.indexOf('=== 候选假设 ===')
  const cIdx = text.indexOf('=== 待查 ===')
  if (hIdx === -1 || cIdx === -1 || cIdx < hIdx) return { hypotheses: text, toCheck: '', parsed: false }
  return {
    hypotheses: text.slice(hIdx + '=== 候选假设 ==='.length, cIdx).trim(),
    toCheck: text.slice(cIdx + '=== 待查 ==='.length).trim(),
    parsed: true,
  }
}

export interface ComposeInput {
  digest: AlertDigest
  facts: readonly string[]
  /** 模型输出（null = 未调用：门禁关 / 无 llm seam / 调用失败）。 */
  raw: string | null
  /** 未调用/失败的一句话原因（写进报告，禁止静默）。 */
  skipReason: string | null
  model: string | null
  now?: number
}

/** 三段式报告（markdown；事实段永远在场，假设段缺席时如实说明）。 */
export function composeReport(input: ComposeInput): string {
  const d = input.digest
  const iso = (t: number): string => new Date(t).toISOString()
  const head = [
    '# 告警报告 · ' + d.alertId,
    '',
    '- 规则：' + d.ruleLabel + '（\`' + d.ruleId + '\`）· 判据 ' + d.metric + ' ' + d.op + ' ' + String(d.threshold) + ' / 解除 ' + String(d.clear),
    '- 确认：' + iso(d.confirmedAt) + ' · 首次越线：' + iso(d.firstExceededAt) + ' · 峰值：' + String(d.peak),
    '- 证据：\`' + d.evidence.snapshotHash.slice(0, 16) + '\` · 覆盖 ' + (d.evidence.coverage * 100).toFixed(1) + '% · 空洞 ' + String(d.evidence.gapCount) + ' · 行 ' + String(d.evidence.rows),
    '- 模型：' + (input.model === null ? '未调用' + (input.skipReason === null ? '' : '（' + input.skipReason + '）') : input.model + ' · 模板 ' + REPORT_PROMPT_VERSION),
    '- 生成：' + iso(input.now ?? Date.now()) + ' · era=' + d.era + '（措辞只作对照）',
    '',
    '## 一、事实（程序生成，不经模型）',
    '',
    ...input.facts.map((f) => '- ' + f),
    '',
    '## 二、候选假设（模型输出，仅供人工判定）',
    '',
  ]
  const tail = ['', '## 三、待查', '']
  if (input.raw === null) {
    head.push('（本段缺席：' + (input.skipReason ?? '未调用模型') + '。事实段与证据不受影响。）')
    tail.push('（同上：模型未调用，待查清单留给人工。）')
  } else {
    const parsed = parseHypotheses(input.raw)
    head.push(parsed.hypotheses === '' ? '（模型未给出内容）' : parsed.hypotheses)
    tail.push(parsed.toCheck === '' ? (parsed.parsed ? '（模型未给出待查项）' : '（模型输出未按格式返回，原文已归入第二段）') : parsed.toCheck)
  }
  return head.concat(tail).join('\n') + '\n'
}

/** 解除时追加结果补记（**不重复调模型**——门禁只对越线那一刻的调用生效一次）。 */
export function composeResultNote(input: { clearedAt: number; durationMs: number; peak: number; value: number }): string {
  return [
    '',
    '## 附：结果补记（程序生成）',
    '',
    '- 解除时刻：' + new Date(input.clearedAt).toISOString(),
    '- 持续：' + String(Math.round(input.durationMs / 1000)) + 's',
    '- 段内峰值：' + String(input.peak) + ' · 解除时值：' + String(input.value),
    '- 说明：本补记不调用模型（同一告警只成文一次）。',
    '',
  ].join('\n')
}
