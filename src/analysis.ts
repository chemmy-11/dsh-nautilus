/**
 * @dsh-external/dsh-nexus — M3-F.3 白盒探索性分析（S 形/爆发段/τ_e）。
 * 口径（镜裁决，M2 §10 OQ-M2-1/2）：P1 判据用「轮次视图」（会话内校准时间 τ=turn）；
 * τ_e = 爆发段中位 e 倍增长时间（第二口径为拟合衰减，M3-F.3 只做第一口径）。
 * 纯函数、零依赖、无 I/O——白盒启发式，输出标注段供人核对（不宣称置信度）。
 */

/** 每轮读数（输入；与 store.TurnReadRow 同构，取所需字段）。 */
export interface TurnPoint {
  session: string
  turn: number
  ts: number
  tokenIn: number
  tokenOut: number
  cacheRead: number
  durationMs: number | null
  tps: number | null
}

export interface SmoothedPoint {
  turn: number
  rate: number | null
}

export interface BurstRange {
  fromTurn: number
  toTurn: number
  direction: 'up' | 'down'
}

export interface AnalysisResult {
  session: string
  burst: BurstRange | null
  tauE: number | null
  shape: 'unknown' | 'rising' | 'falling' | 'sigmoid' | 'inverse-sigmoid'
  points: TurnPoint[]
}

export interface AnalyzeOptions {
  minSteps?: number
  relativeThresh?: number
}

/** 未命中率（A 投影）；分母 0 → null（无输入，跳过——与「0%（合法值）」区分）。 */
export function missRateOf(p: Pick<TurnPoint, 'tokenIn' | 'cacheRead'>): number | null {
  const total = p.tokenIn + p.cacheRead
  return total > 0 ? p.tokenIn / total : null
}

/** 平滑序列：按邻窗（window）移动平均，窗口内 null 跳过；首尾渐进窗口。 */
export function smoothedMissRate(points: TurnPoint[], window = 3): SmoothedPoint[] {
  const rates = points.map((p) => missRateOf(p))
  return points.map((p, i) => {
    const half = Math.floor(window / 2)
    const from = Math.max(0, i - half)
    const to = Math.min(points.length - 1, i + half)
    const vals: number[] = []
    for (let j = from; j <= to; j += 1) {
      const r = rates[j]
      if (r !== null && Number.isFinite(r)) vals.push(r)
    }
    const rate = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    return { turn: p.turn, rate }
  })
}

/**
 * 爆发段检测：相邻点相对变化 |Δ| / avg(前后值) 超阈值记「显著步」；
 * 连续 >= minSteps 个显著步构成一段；取累计绝对变化最大的一段。
 */
export function detectBurst(
  smoothed: SmoothedPoint[],
  minSteps = 2,
  relativeThresh = 0.15,
): BurstRange | null {
  let best: BurstRange | null = null
  let bestChange = 0
  let run: SmoothedPoint[] = []
  let runChange = 0
  let prev: SmoothedPoint | null = null
  for (const cur of smoothed) {
    if (prev !== null && prev.rate !== null && cur.rate !== null) {
      const avg = (Math.abs(prev.rate) + Math.abs(cur.rate)) / 2
      const rel = avg > 1e-9 ? Math.abs(cur.rate - prev.rate) / avg : 0
      if (rel >= relativeThresh) {
        if (run.length === 0) run = [prev]
        run.push(cur)
        runChange += Math.abs(cur.rate - prev.rate)
      } else {
        if (run.length > 0 && run.length - 1 >= minSteps && runChange > bestChange) {
          bestChange = runChange
          const firstRate = run[0].rate
          const lastRate = run[run.length - 1].rate
          best = {
            fromTurn: run[0].turn,
            toTurn: run[run.length - 1].turn,
            direction: firstRate !== null && lastRate !== null && lastRate >= firstRate ? 'up' : 'down',
          }
        }
        run = []
        runChange = 0
      }
    }
    prev = cur
  }
  if (run.length > 0 && run.length - 1 >= minSteps && runChange > bestChange) {
    bestChange = runChange
    const firstRate = run[0].rate
    const lastRate = run[run.length - 1].rate
    best = {
      fromTurn: run[0].turn,
      toTurn: run[run.length - 1].turn,
      direction: firstRate !== null && lastRate !== null && lastRate >= firstRate ? 'up' : 'down',
    }
  }
  return best
}

/**
 * τ_e（镜口径）= 爆发段中位 e 倍增长时间。
 * 在 [fromTurn, toTurn] 内：direction='up' 找 rate[j] >= rate[i] * base（增长 e 倍）；
 * direction='down' 找 rate[i] >= rate[j] * base（衰减至 1/e——时间尺度同义，取正）；
 * 全部 (i,j) gap = turn[j] - turn[i]，取中位数。
 */
export function estimateTauE(burst: BurstRange, points: TurnPoint[], base = Math.E): number | null {
  const seg = points.filter((p) => p.turn >= burst.fromTurn && p.turn <= burst.toTurn)
  const rates = new Map<number, number>()
  for (const p of seg) {
    const r = missRateOf(p)
    if (r !== null) rates.set(p.turn, r)
  }
  const gaps: number[] = []
  const turns = seg.map((p) => p.turn)
  const scaled = burst.direction === 'down' ? 1 / base : base
  for (let i = 0; i < turns.length; i += 1) {
    const ri = rates.get(turns[i])
    if (ri === undefined) continue
    for (let j = i + 1; j < turns.length; j += 1) {
      const rj = rates.get(turns[j])
      if (rj === undefined) continue
      const ratio = rj / ri
      if (burst.direction === 'down' ? ratio <= scaled : ratio >= scaled) {
        gaps.push(turns[j] - turns[i])
      }
    }
  }
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

/** 单会话分析：shape 白盒启发式（unknown/rising/falling/sigmoid/inverse-sigmoid）。 */
export function analyzeSession(points: TurnPoint[], opts: AnalyzeOptions = {}): AnalysisResult {
  const minSteps = opts.minSteps ?? 2
  const thresh = opts.relativeThresh ?? 0.15
  const smoothed = smoothedMissRate(points, 3)
  const burst = detectBurst(smoothed, minSteps, thresh)
  let shape: AnalysisResult['shape'] = 'unknown'
  if (burst === null) {
    // 无显著变化：平线或单调未达阈值 → unknown
    shape = 'unknown'
  } else {
    // 爆发段外的变化是否都 < thresh（平缓判据）
    let outsideCalm = true
    let prev: SmoothedPoint | null = null
    for (const cur of smoothed) {
      if (prev !== null && prev.rate !== null && cur.rate !== null
        && (cur.turn < burst.fromTurn || cur.turn > burst.toTurn)) {
        const avg = (Math.abs(prev.rate) + Math.abs(cur.rate)) / 2
        const rel = avg > 1e-9 ? Math.abs(cur.rate - prev.rate) / avg : 0
        if (rel >= thresh) outsideCalm = false
      }
      prev = cur
    }
    if (outsideCalm) {
      shape = burst.direction === 'down' ? 'inverse-sigmoid' : 'sigmoid'
    } else {
      shape = burst.direction === 'down' ? 'falling' : 'rising'
    }
  }
  return { session: points[0]?.session ?? '', burst, tauE: burst === null ? null : estimateTauE(burst, points), shape, points }
}

/** 按 session 分组分析（组内按 turn 升序处理——调用方保证顺序）。 */
export function analyze(points: TurnPoint[], opts: AnalyzeOptions = {}): AnalysisResult[] {
  const bySession = new Map<string, TurnPoint[]>()
  for (const p of points) {
    const list = bySession.get(p.session) ?? []
    list.push(p)
    bySession.set(p.session, list)
  }
  const out: AnalysisResult[] = []
  for (const [session, list] of bySession) {
    const sorted = [...list].sort((a, b) => a.turn - b.turn)
    out.push(analyzeSession(sorted, opts))
  }
  return out
}
