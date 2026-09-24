/**
 * @dsh-external/dsh-nautilus — 工作台图表原语（零依赖 SVG/DIV 自绘）。
 *
 * 借鉴来源（2026-09-20 守谷人裁决：方案 A「图表语法升级 · 自绘」，不引入图表库）：
 *   · stat 卡内嵌走势线（Grafana Stat / Datadog Query Value）→ Sparkline
 *   · 每指标一图 + 跨图同步十字线（Netdata 方法论）→ MiniChart（共享 hover 由父级持有）
 *   · 堆叠构成柱（Grafana Node Exporter Full 的 CPU/内存构成行）→ StackedBars
 *   · 占比横条 gauge（Grafana Bar Gauge）→ BarGauge
 *   · 状态带（Grafana State Timeline）→ StateBand
 *   · 排行条（Datadog Top List）→ TopList
 *
 * 纪律（AGENTS §3 / dev-02 §2）：
 *   · 全部无 hooks 的纯呈现函数（可像 Stat/Spark 一样直调；带状态的交互由父组件持有并经 props 传入）；
 *   · 颜色只取 --nt-* 令牌（fallback 与令牌默认值同值；朱红＝需人工注意，正常态一律墨/灰）；
 *   · 缺席态显式：数据不足渲染空态或不渲染，不写 0、不编造；
 *   · 零第三方 import（react 除外，构建期 external）。
 */
import { createElement, type ReactNode } from 'react'

/** 令牌色（与 index.ts 注入的 --nt-* 令牌同源；fallback 与令牌默认值一致）。 */
const C = {
  ink: 'var(--nt-ink,#101010)',
  text: 'var(--nt-text,#101010)',
  dim: 'var(--nt-dim,#5f5f5c)',
  faint: 'var(--nt-faint,#9a9a95)',
  border: 'var(--nt-border,#d9d9d5)',
  panel2: 'var(--nt-panel2,#f7f7f5)',
  accent: 'var(--nt-accent,#e6321e)',
}

/** 空态（数据不足时的小占位；不写 0）。 */
function MiniEmpty(props: { text?: string }): ReactNode {
  return createElement('div', { className: 'nt-mini-empty' }, props.text ?? '暂无数据')
}

/**
 * 走势线（stat 卡内嵌，Grafana Stat 式）：墨线 + 淡面积 + 末点，无坐标轴。
 * 有效点 <2 → null（调用方不占位，卡片退化为纯数字）。
 */
export function Sparkline(props: { values: Array<number | null>; h?: number; label?: string }): ReactNode {
  const pts: number[] = []
  for (const v of props.values) if (v !== null && Number.isFinite(v)) pts.push(v)
  if (pts.length < 2) return null
  const w = 240
  const h = props.h ?? 40
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const sx = (i: number): number => 2 + (i / (pts.length - 1)) * (w - 4)
  const sy = (v: number): number => h - 4 - ((v - min) / span) * (h - 8)
  const d = pts.map((v, i) => (i === 0 ? 'M' : 'L') + sx(i).toFixed(1) + ' ' + sy(v).toFixed(1)).join(' ')
  const area = d + ' L' + sx(pts.length - 1).toFixed(1) + ' ' + String(h - 2) + ' L' + sx(0).toFixed(1) + ' ' + String(h - 2) + ' Z'
  const li = pts.length - 1
  return createElement('svg', { viewBox: '0 0 ' + String(w) + ' ' + String(h), width: '100%', height: h, role: 'img', 'aria-label': props.label ?? 'sparkline', style: { display: 'block' } },
    createElement('path', { d: area, fill: C.ink, opacity: 0.07 }),
    createElement('path', { d, fill: 'none', stroke: C.ink, strokeWidth: 1.3 }),
    createElement('circle', { cx: sx(li), cy: sy(pts[li]), r: 2, fill: C.ink }),
  )
}

/**
 * 占比横条 gauge（Grafana Bar Gauge 式）：ratio ∈ [0,1]；threshold 画朱红刻度线；
 * warn（越过阈值）时填充与数值转朱红——朱红＝需人工注意的语义纪律。
 */
export function BarGauge(props: { label: string; display: string; ratio: number; threshold?: number; warn?: boolean }): ReactNode {
  const r = Math.max(0, Math.min(1, Number.isFinite(props.ratio) ? props.ratio : 0))
  const warn = props.warn === true
  return createElement('div', { className: 'nt-gauge' },
    createElement('div', { className: 'lr' },
      createElement('span', { className: 'lb' }, props.label),
      createElement('span', { className: 'vl' + (warn ? ' warn' : '') }, props.display),
    ),
    createElement('div', { className: 'tr' },
      createElement('div', { className: 'fl' + (warn ? ' warn' : ''), style: { width: (r * 100).toFixed(1) + '%' } }),
      props.threshold !== undefined && props.threshold > 0 && props.threshold < 1
        ? createElement('div', { className: 'th', style: { left: (props.threshold * 100).toFixed(1) + '%' } })
        : null,
    ),
  )
}

/**
 * 小图（Netdata「每指标一图」的网格单元）：等间隔采样序列的迷你面积图。
 * hover 同步：父级持有共享 hoverTs，本组件只按 props 画十字线/末点，并在鼠标移动时
 * 把「最近采样点的 ts」上抛——跨图十字线由所有单元读同一个 hoverTs 实现。
 * 有效点 <2 → 空态（PULSE 缺席/刚起步是正常态）。
 */
export function MiniChart(props: {
  points: Array<{ ts: number; value: number }>
  h?: number
  hoverTs?: number | null
  onHover?: (ts: number | null) => void
  label?: string
}): ReactNode {
  const pts = props.points.filter((p) => Number.isFinite(p.value))
  const h = props.h ?? 46
  if (pts.length < 2) return MiniEmpty({})
  const W = 200
  const t0 = pts[0].ts
  const t1 = pts[pts.length - 1].ts
  const tSpan = t1 - t0 || 1
  const vs = pts.map((p) => p.value)
  const min = Math.min(...vs)
  const max = Math.max(...vs)
  const vSpan = max - min || 1
  const px = (ts: number): number => 2 + ((ts - t0) / tSpan) * (W - 4)
  const py = (v: number): number => h - 5 - ((v - min) / vSpan) * (h - 10)
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + px(p.ts).toFixed(1) + ' ' + py(p.value).toFixed(1)).join(' ')
  const area = d + ' L' + px(t1).toFixed(1) + ' ' + String(h - 2) + ' L' + px(t0).toFixed(1) + ' ' + String(h - 2) + ' Z'
  const hts = props.hoverTs
  const near = hts !== null && hts !== undefined && hts >= t0 && hts <= t1
    ? pts.reduce((best, p) => (Math.abs(p.ts - hts) < Math.abs(best.ts - hts) ? p : best), pts[0])
    : null
  const kids: ReactNode[] = [
    createElement('path', { key: 'a', d: area, fill: C.ink, opacity: 0.06 }),
    createElement('path', { key: 'l', d, fill: 'none', stroke: C.ink, strokeWidth: 1.2, vectorEffect: 'non-scaling-stroke' }),
  ]
  if (near !== null) {
    kids.push(createElement('line', { key: 'h', x1: px(near.ts), x2: px(near.ts), y1: 2, y2: h - 2, stroke: C.faint, strokeWidth: 1, strokeDasharray: '2 3', vectorEffect: 'non-scaling-stroke' }))
    kids.push(createElement('circle', { key: 'hd', cx: px(near.ts), cy: py(near.value), r: 2.4, fill: C.accent }))
  }
  return createElement('svg', {
    viewBox: '0 0 ' + String(W) + ' ' + String(h), width: '100%', height: h, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': props.label ?? 'mini series', style: { display: 'block', cursor: 'crosshair' },
    onMouseMove: props.onHover === undefined ? undefined : (e: { clientX: number; currentTarget: SVGSVGElement }) => {
      const rect = e.currentTarget.getBoundingClientRect()
      if (rect.width <= 0) return
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const target = t0 + frac * tSpan
      let best = pts[0]
      for (const p of pts) if (Math.abs(p.ts - target) < Math.abs(best.ts - target)) best = p
      props.onHover(best.ts)
    },
    onMouseLeave: props.onHover === undefined ? undefined : () => props.onHover(null),
  }, ...kids)
}

/**
 * 堆叠构成柱（Grafana 构成行式）：一行＝一个离散事件（轮），每段 fill 由调用方给令牌色。
 * hover/点击行号是**原始 rows 下标**（组件内部过滤零行不重排）；状态由父级持有（本组件无 hooks）。
 * `marks`：与 rows 平行的人工层标记（T 系列对齐判读；null = 无标记）——柱顶上方一枚
 * 徽标（描边圆 + 档位数字），**只改点样貌、不动读数线/柱体**（dev-02 §5 解读与观测分层）。
 * 行数 0 → 空态。
 */
export function StackedBars(props: {
  rows: Array<{ x: number; segs: Array<{ key: string; v: number; fill: string; name: string }> }>
  h?: number
  hoverIndex?: number | null
  onHover?: (i: number | null) => void
  onOpenRow?: (i: number) => void
  xTick?: (x: number) => string
  yFmt?: (v: number) => string
  label?: string
  marks?: Array<string | null>
}): ReactNode {
  const indexed: Array<{ row: (typeof props.rows)[number]; oi: number }> = []
  props.rows.forEach((row, oi) => {
    if (row.segs.some((s) => Number.isFinite(s.v) && s.v > 0)) indexed.push({ row, oi })
  })
  const h = props.h ?? 220
  if (indexed.length === 0) return MiniEmpty({})
  const W = 1120
  const padL = 46
  const padR = 14
  const padT = 14
  const padB = 24
  const totals = indexed.map(({ row }) => row.segs.reduce((a, s) => a + (Number.isFinite(s.v) ? s.v : 0), 0))
  const max = Math.max(...totals, 1)
  const plotW = W - padL - padR
  const cw = plotW / indexed.length
  const bw = Math.max(1.5, Math.min(26, cw * 0.66))
  const plotH = h - padT - padB
  const yf = props.yFmt ?? ((v: number): string => String(Math.round(v)))
  const kids: ReactNode[] = []
  for (const r of [0, 0.5, 1]) {
    const v = max * r
    const y = h - padB - r * plotH
    kids.push(createElement('line', { key: 'g' + String(r), x1: padL, x2: W - padR, y1: y, y2: y, stroke: C.border, strokeWidth: 1, opacity: 0.7 }))
    kids.push(createElement('text', { key: 't' + String(r), x: padL - 6, y: y + 3, fontSize: 9, fill: C.faint, textAnchor: 'end' }, yf(v)))
  }
  indexed.forEach(({ row, oi }, i) => {
    const bx = padL + i * cw + (cw - bw) / 2
    let yBottom = h - padB
    for (const s of row.segs) {
      if (!(Number.isFinite(s.v) && s.v > 0)) continue
      const segH = (s.v / max) * plotH
      kids.push(createElement('rect', { key: 'b' + String(oi) + s.key, x: bx, y: yBottom - segH, width: bw, height: Math.max(0.5, segH), fill: s.fill, opacity: props.hoverIndex === oi ? 1 : 0.88 }))
      yBottom -= segH
    }
    const isHv = props.hoverIndex === oi
    if (isHv) kids.push(createElement('rect', { key: 'hl' + String(oi), x: bx - 2, y: padT, width: bw + 4, height: plotH, fill: 'none', stroke: C.faint, strokeWidth: 1, strokeDasharray: '2 3' }))
    const mark = props.marks !== undefined ? props.marks[oi] : null
    if (mark !== null && mark !== undefined) {
      const cx = bx + bw / 2
      kids.push(createElement('circle', { key: 'mk' + String(oi), cx, cy: padT - 6, r: 5.5, fill: C.panel2, stroke: C.accent, strokeWidth: 1 }))
      kids.push(createElement('text', { key: 'mkt' + String(oi), x: cx, y: padT - 3, fontSize: 7.5, fill: C.accent, textAnchor: 'middle', fontWeight: 700 }, mark))
    }
    kids.push(createElement('rect', {
      key: 'hit' + String(oi), x: padL + i * cw, y: padT, width: cw, height: plotH, fill: 'transparent',
      onMouseMove: props.onHover === undefined ? undefined : () => props.onHover(oi),
      onClick: props.onOpenRow === undefined ? undefined : () => props.onOpenRow(oi),
      style: { cursor: props.onOpenRow === undefined ? undefined : 'pointer' },
    }))
  })
  if (indexed.length >= 2 && props.xTick !== undefined) {
    for (const k of [0, Math.floor((indexed.length - 1) / 2), indexed.length - 1]) {
      const { row } = indexed[k]
      const x = padL + k * cw + cw / 2
      kids.push(createElement('line', { key: 'x' + String(k), x1: x, x2: x, y1: h - padB, y2: h - padB + 3, stroke: C.border }))
      kids.push(createElement('text', { key: 'xl' + String(k), x, y: h - 7, fontSize: 9, fill: C.faint, textAnchor: 'middle' }, props.xTick(row.x)))
    }
  }
  return createElement('svg', { viewBox: '0 0 ' + String(W) + ' ' + String(h), width: '100%', height: h, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': props.label ?? 'stacked bars', style: { display: 'block' } }, ...kids)
}

/**
 * 状态带（Grafana State Timeline 式）：每条泳道一段横轨，轨道底＝缺席/空白，
 * 墨色片段＝有读数/活跃的区间（span 的 from/to 为 epoch ms，落在 domain 内按比例截断）。
 */
export function StateBand(props: {
  domain: [number, number]
  lanes: Array<{ label: string; spans: Array<{ from: number; to: number }> }>
  xTick?: (ts: number) => string
}): ReactNode {
  const [d0, d1] = props.domain
  if (!(Number.isFinite(d0) && Number.isFinite(d1) && d1 > d0)) return MiniEmpty({})
  const spanMs = d1 - d0
  const seg = (from: number, to: number): ReactNode => {
    const a = Math.max(0, ((from - d0) / spanMs) * 100)
    const b = Math.min(100, ((to - d0) / spanMs) * 100)
    return b <= a ? null : createElement('i', { key: String(from) + '-' + String(to), style: { left: a.toFixed(2) + '%', width: (b - a).toFixed(2) + '%' } })
  }
  const xt = props.xTick ?? ((ts: number): string => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }))
  return createElement('div', { className: 'nt-band' },
    ...props.lanes.map((ln) => createElement('div', { key: ln.label, className: 'ln' },
      createElement('span', { className: 'lb' }, ln.label),
      createElement('span', { className: 'tk' }, ...ln.spans.map((s) => seg(s.from, s.to))),
    )),
    createElement('div', { className: 'ax' },
      createElement('span', null, xt(d0)),
      createElement('span', null, xt(d0 + spanMs / 2)),
      createElement('span', null, xt(d1)),
    ),
  )
}

/**
 * 排行条（Datadog Top List 式）：按 value 降序的横向条行；条宽相对最大值。
 * 零值/非有限值行不渲染（不写 0 占位）。
 */
export function TopList(props: {
  rows: Array<{ label: string; sub?: string; value: number; display: string }>
  max?: number
}): ReactNode {
  const rows = props.rows.filter((r) => Number.isFinite(r.value) && r.value > 0)
  if (rows.length === 0) return MiniEmpty({})
  const max = props.max ?? Math.max(...rows.map((r) => r.value), 1)
  return createElement('div', { className: 'nt-top' }, ...rows.map((r, i) =>
    createElement('div', { key: r.label + String(i), className: 'rw', title: r.sub },
      createElement('span', { className: 'ix' }, String(i + 1).padStart(2, '0')),
      createElement('span', { className: 'lb' }, r.label),
      createElement('span', { className: 'tk' }, createElement('i', { style: { width: Math.max(1, (r.value / max) * 100).toFixed(1) + '%' } })),
      createElement('span', { className: 'vl' }, r.display),
    )))
}
