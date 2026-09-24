/**
 * @dsh-external/dsh-nautilus — pulse 告警检测内核（A 系列 A.1）。
 *
 * 定位（红线：观测不干预）：只做「判定 + 留证 + 成文」，**不自动处置**——不杀进程、不改宿主行为。
 * 内核是纯函数式状态机（零依赖、零 I/O）：调用方每 tick 喂一次「指标 → 当前值」，
 * 内核回吐状态迁移（opened / cleared）；落库、冻结、成文都在插件半区（本文件不碰库）。
 *
 * 口径（E25/E26 实测教训固化）：
 *  · 确认窗 `forMs` 是**时间窗**而不是 tick 数——三族量化实测 1×/2×/3×，用 tick 数会让
 *    同一条规则换个对象就换了语义（本地族 5s、计数器族 15s、GPU 族 10s）。
 *  · 滞回：越线看 `threshold`，解除看 `clear`；两线之间保持现状。
 *  · 连续段被打断（回落到 threshold 另一侧）→ **计时重置**（E26 边界案例：19:54:21 越线、
 *    19:54:27 回落 0.89926 ＜ 0.90 → 连续段自 19:54:32 重算；抖动不产生告警）。
 *  · 缺样本（指标缺席 / 分母为 0）→ 跳过且**状态保持**：缺席不等于恢复。
 *  · 停用不擅自解除：规则 `enabled=false` 或被删掉时，内核**不**解除已确认的告警
 *    （收口归插件半区的启动自愈——改配置不该把历史告警抹平）。
 *  · 冷却：解除后 `cooldownMs` 内不再开新告警，但**计时继续累积**——冷却一过，
 *    仍在越线态且连续段够长的规则立刻确认，不多等一个 forMs。
 *  · 峰值：越线段内取极值（gte 取 max、lte 取 min），与台账 peak_value 同源。
 */

/** 比较方向。ratio 规则同样落这两个之一（先算占比再比）。 */
export type AlertOp = 'gte' | 'lte'

/** 一条告警规则（配置面；全部字段可由 cordis.yml 给定）。 */
export interface AlertRule {
  /** 稳定业务 id（台账 rule_id；改名等于换规则，历史不混算）。 */
  id: string
  /** 中文短名（UI 显示）。 */
  label: string
  enabled: boolean
  /** 主指标（ratio 规则里是分子）。 */
  metric: string
  /** ratio 规则的分母指标；空串 = 直接比较主指标。 */
  refMetric: string
  op: AlertOp
  threshold: number
  /** 解除线（滞回下沿/上沿）；gte 时 clear < threshold，lte 时 clear > threshold。 */
  clear: number
  /** 确认窗（ms）：连续越线满这么久才确认。 */
  forMs: number
  /** 冷却（ms）：解除后这段时间内不再开新告警（计时继续累积）。 */
  cooldownMs: number
}

/** 规则运行态（诊断面；不做持久化——重启后由启动自愈重建）。 */
export interface AlertRuntimeState {
  id: string
  /** 当前值是否在越线侧。 */
  exceeding: boolean
  /** 是否已确认（台账里有一行未解除）。 */
  open: boolean
  /** 本段连续越线的起点；null = 当前不在连续段内。 */
  firstExceededAt: number | null
  confirmedAt: number | null
  alertId: string | null
  /** 越线段内极值（gte=max / lte=min）。 */
  peak: number | null
  /** 冷却截止时刻（解除后设置）。 */
  cooldownUntil: number
  lastValue: number | null
  lastTs: number | null
  /** 因缺样本跳过的 tick 数（诊断「缺席 ≠ 恢复」是否生效）。 */
  skippedTicks: number
}

/** 状态迁移（插件半区据此落库 / 冻结 / 成文）。 */
export type AlertTransition =
  | {
    kind: 'opened'
    rule: AlertRule
    alertId: string
    ts: number
    firstExceededAt: number
    confirmedAt: number
    peak: number
    value: number
  }
  | {
    kind: 'cleared'
    rule: AlertRule
    alertId: string
    ts: number
    firstExceededAt: number
    confirmedAt: number
    peak: number
    value: number
    durationMs: number
  }

/** 台账主键：`a-<base36(确认时刻)>-<ruleId>`（与 2026-09-21 真数据演练的目录名同式）。 */
export function alertIdFor(confirmedAt: number, ruleId: string): string {
  return 'a-' + Math.trunc(confirmedAt).toString(36) + '-' + ruleId
}

/** ratio 规则的展示/落库表达式（台账 metric 列）；非 ratio 就是指标名本身。 */
export function alertMetricExpr(rule: AlertRule): string {
  return rule.refMetric === '' ? rule.metric : rule.metric + ' / ' + rule.refMetric
}

/** 取规则当前值：直接取主指标，或缺一不可地取比值（分母 ≤0 / 缺席 → null）。 */
export function ruleValue(rule: AlertRule, values: ReadonlyMap<string, number>): number | null {
  const a = values.get(rule.metric)
  if (a === undefined || !Number.isFinite(a)) return null
  if (rule.refMetric === '') return a
  const b = values.get(rule.refMetric)
  if (b === undefined || !Number.isFinite(b) || b <= 0) return null
  return a / b
}

/** 越线判定（gte：≥ threshold；lte：≤ threshold）。 */
export function isExceeding(rule: AlertRule, value: number): boolean {
  return rule.op === 'gte' ? value >= rule.threshold : value <= rule.threshold
}

/** 解除判定（跌破解除线才解除；两线之间保持现状）。 */
export function isCleared(rule: AlertRule, value: number): boolean {
  return rule.op === 'gte' ? value < rule.clear : value > rule.clear
}

/** 越线段内极值。 */
export function peakOf(op: AlertOp, prev: number | null, value: number): number {
  if (prev === null) return value
  return op === 'gte' ? Math.max(prev, value) : Math.min(prev, value)
}

/**
 * 默认规则（**A.5 回测选定值 = D-A8**，2026-09-28 定）。
 *
 * 判据固化：**p99 之上、max 之下**——低于 p99 是常态不是红线；高于 max 等于没设。
 * 修订依据是 8.5 天真库回测：旧默认里唯一会刷屏的是内存占比（0.90+30s → 41 次/8.5 天 ≈ 5 次/天，
 * 其余三条实测从不触发：CPU p99.9=0.597 / GPU max 40% / 显存 max 0.886）；确认窗 30s → 120s、
 * 证据回看 2h → 4h 后，内存占比降到 9 次/8.5 天（≈1 次/天）。
 * 纯函数同判据回放脚本：`scripts/alert-threshold-backtest.mjs`（只读、可复跑）。
 *
 * 四对象（CPU 利用率 / 内存占比 / 显存占比 / GPU 利用率）默认启用；`dsh-rss`（宿主进程 RSS）
 * 默认**关闭**——OQ-A1 未裁（进程级红线口径未定，误报会随会话长度漂移）。
 *
 * 单位口径（照抄 collect.ts，不换算、不猜）：cpu.utilization ∈ [0,1]、mem/gpu.mem 为
 * used/total 比值、gpu.util 是 nvidia-smi 的百分数 ∈ [0,100]。
 */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = Object.freeze([
  {
    id: 'mem-occupancy', label: '内存占比', enabled: true,
    metric: 'pulse.mem.used', refMetric: 'pulse.mem.total', op: 'gte',
    threshold: 0.93, clear: 0.88, forMs: 120_000, cooldownMs: 0,
  },
  {
    id: 'gpu-mem-occupancy', label: '显存占比', enabled: true,
    metric: 'pulse.gpu.mem.used', refMetric: 'pulse.gpu.mem.total', op: 'gte',
    threshold: 0.93, clear: 0.88, forMs: 120_000, cooldownMs: 0,
  },
  {
    id: 'cpu-utilization', label: 'CPU 利用率', enabled: true,
    metric: 'pulse.cpu.utilization', refMetric: '', op: 'gte',
    threshold: 0.90, clear: 0.85, forMs: 120_000, cooldownMs: 0,
  },
  {
    id: 'gpu-utilization', label: 'GPU 利用率', enabled: true,
    metric: 'pulse.gpu.util', refMetric: '', op: 'gte',
    threshold: 95, clear: 90, forMs: 120_000, cooldownMs: 0,
  },
  {
    id: 'dsh-rss', label: '宿主 RSS', enabled: false,
    metric: 'pulse.proc.dsh.rss', refMetric: '', op: 'gte',
    threshold: 4 * 1024 * 1024 * 1024, clear: 3.5 * 1024 * 1024 * 1024, forMs: 120_000, cooldownMs: 0,
  },
])

/** 配置校验（schema 表达不了的约束在这里响亮失败，不留到运行时静默失效）。 */
export function validateAlertRules(rules: readonly AlertRule[]): void {
  const seen = new Set<string>()
  for (const r of rules) {
    const where = 'alertRules[' + r.id + ']'
    if (r.id.trim() === '') throw new Error('[pulse] 非法配置：' + where + ' 的 id 不能为空')
    if (seen.has(r.id)) throw new Error('[pulse] 非法配置：alertRules 出现重复 id ' + r.id)
    seen.add(r.id)
    if (r.metric.trim() === '') throw new Error('[pulse] 非法配置：' + where + ' 的 metric 不能为空')
    if (r.op !== 'gte' && r.op !== 'lte') throw new Error('[pulse] 非法配置：' + where + ' 的 op 必须是 gte|lte，实得 ' + String(r.op))
    if (!Number.isFinite(r.threshold) || !Number.isFinite(r.clear)) throw new Error('[pulse] 非法配置：' + where + ' 的 threshold/clear 必须是有限数')
    if (r.forMs < 0 || !Number.isFinite(r.forMs)) throw new Error('[pulse] 非法配置：' + where + ' 的 forMs 必须 ≥0')
    if (r.cooldownMs < 0 || !Number.isFinite(r.cooldownMs)) throw new Error('[pulse] 非法配置：' + where + ' 的 cooldownMs 必须 ≥0')
    const bad = r.op === 'gte' ? r.clear >= r.threshold : r.clear <= r.threshold
    if (bad) {
      throw new Error('[pulse] 非法配置：' + where + ' 的解除线必须在阈值另一侧（' + r.op + '：threshold=' + r.threshold + ' clear=' + r.clear + '）')
    }
  }
}

/**
 * 检测状态机。一个实例管全部规则（每条规则一份运行态）。
 * **不是**并发安全的：调用方保证 observe 串行（pulse tick 本身串行）。
 */
export class AlertEngine {
  private readonly rules: AlertRule[]
  private readonly states = new Map<string, AlertRuntimeState>()

  constructor(rules: readonly AlertRule[]) {
    validateAlertRules(rules)
    this.rules = rules.map((r) => ({ ...r }))
    for (const r of this.rules) this.states.set(r.id, blankState(r.id))
  }

  rulesView(): AlertRule[] { return this.rules.map((r) => ({ ...r })) }

  statesView(): AlertRuntimeState[] {
    return this.rules.map((r) => ({ ...(this.states.get(r.id) ?? blankState(r.id)) }))
  }

  stateOf(id: string): AlertRuntimeState | undefined {
    const s = this.states.get(id)
    return s === undefined ? undefined : { ...s }
  }

  /**
   * 观测一个 tick（同一时刻的一批「指标 → 值」）。
   * @returns 本次产生的状态迁移（0..n 条；顺序 = 规则声明序）。
   */
  observe(values: ReadonlyMap<string, number>, ts: number): AlertTransition[] {
    const out: AlertTransition[] = []
    for (const rule of this.rules) {
      const s = this.states.get(rule.id)
      if (s === undefined) continue
      if (!rule.enabled) {
        // 停用不擅自解除：只停「新确认」，已确认的等插件半区收口（见文件头）
        continue
      }
      const v = ruleValue(rule, values)
      s.lastTs = ts
      if (v === null) { s.skippedTicks += 1; continue }
      s.lastValue = v
      if (isExceeding(rule, v)) {
        s.exceeding = true
        if (s.firstExceededAt === null) { s.firstExceededAt = ts; s.peak = v }
        else s.peak = peakOf(rule.op, s.peak, v)
        if (!s.open && ts - s.firstExceededAt >= rule.forMs && ts >= s.cooldownUntil) {
          const alertId = alertIdFor(ts, rule.id)
          s.open = true
          s.confirmedAt = ts
          s.alertId = alertId
          out.push({ kind: 'opened', rule, alertId, ts, firstExceededAt: s.firstExceededAt, confirmedAt: ts, peak: s.peak ?? v, value: v })
        }
        continue
      }
      s.exceeding = false
      if (isCleared(rule, v)) {
        if (s.open && s.alertId !== null && s.confirmedAt !== null) {
          const confirmedAt = s.confirmedAt
          out.push({
            kind: 'cleared', rule, alertId: s.alertId, ts,
            firstExceededAt: s.firstExceededAt ?? confirmedAt, confirmedAt,
            peak: s.peak ?? v, value: v, durationMs: Math.max(0, ts - confirmedAt),
          })
          s.cooldownUntil = ts + rule.cooldownMs
        }
        s.open = false
        s.alertId = null
        s.confirmedAt = null
        s.firstExceededAt = null
        s.peak = null
        continue
      }
      // 滞回带：已确认的保持（等跌破解除线）；未确认的连续段被打断 → 计时重置
      if (!s.open) { s.firstExceededAt = null; s.peak = null }
    }
    return out
  }
}

function blankState(id: string): AlertRuntimeState {
  return {
    id, exceeding: false, open: false, firstExceededAt: null, confirmedAt: null,
    alertId: null, peak: null, cooldownUntil: 0, lastValue: null, lastTs: null, skippedTicks: 0,
  }
}
