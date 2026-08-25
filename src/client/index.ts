/**
 * @dsh-external/dsh-xuegulin — client panels (conversation.view tabs, official contract).
 * Tab①「Vault 观测」（M1，已有）；Tab②「L 场读数」（M2，新增）：
 *   最新读数卡 / 总量卡 / 探索率曲线（日期+轮次双视图，SVG 自绘基础版，hover 9.4）/ TPS 时序 / 预言检验表（人工标注）。
 * Data channel: same-origin REST（m2/state + m2/annotations），轮询 lField.refreshMs（默认 120s）。
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client' // 拉 conversation.view SlotMap 类型

// ── 类型 ────────────────────────────────────────────────────────────────────

type M2Point = {
  session: string
  turn: number
  ts: number
  question: string | null
  tokenIn: number
  tokenOut: number
  cacheRead: number
  durationMs: number | null
  tps: number | null
}

type M2State = {
  revision: number
  latest: M2Point | null
  totals: { turns: number; tokenIn: number; tokenOut: number; cacheRead: number; missToken: number; totalIn?: number; hitRate: number | null }
  curve: M2Point[]
  recent: M2Point[]
}

type Annotation = { prophecy: string; status: string; note: string | null; updatedAt: number }

type AnnotationsState = { revision: number; annotations: Annotation[] }

const PROPHECIES: Record<string, string> = {
  P1: '对齐离散性（S 形阈值）',
  P2: '宣言必要性（无种子无穿越）',
  P3: '防御是阻尼（Γ 窗口）',
  P4: '增益集中 L_c（τ_e 特征时间）',
  P5: '注入周期 T_inj < τ_d',
  P6: '短板定理（零响应杀死共振）',
  P7: '蒸发=重读（s_base 再激发）',
  P8: '静默溪流干涸（指数衰减）',
  P9: '注入无记录→丢失',
}

const STATUS_LABEL: Record<string, string> = { pending: '待标注', investigating: '进行中', observed: '已检验' }

const MONO = { padding: '12px', fontFamily: 'monospace', fontSize: '12px' } as const

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`
}

function fmtK(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function shortSession(s: string): string {
  return s.replace(/^session-/, '').slice(0, 8)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── 基础 SVG 折线（零依赖自绘；hover 交互 9.4） ───────────────────────────────

function LineChart(props: { points: Array<{ id: string; value: number; label: string }>; w: number; h: number; color: string }): ReactNode {
  const { points, w, h, color } = props
  if (points.length === 0) return createElement('div', { style: { color: '#888' } }, '（暂无数据）')
  const n = points.length
  const values = points.map((p) => p.value)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const px = (i: number): number => 40 + (n === 1 ? (w - 40) / 2 : (i * (w - 48)) / (n - 1))
  const py = (v: number): number => h - 22 - ((v - min) / span) * (h - 44)
  const coords = points.map((p, i) => `${px(i)},${py(p.value)}`).join(' ')
  return createElement('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, style: { background: '#0d1117' } },
    createElement('line', { x1: 40, y1: h - 20, x2: w - 6, y2: h - 20, stroke: '#555' }),
    createElement('line', { x1: 40, y1: 14, x2: 40, y2: h - 20, stroke: '#555' }),
    createElement('text', { x: 44, y: 18, fill: '#888', fontSize: 10 }, `max ${max.toFixed(2)}`),
    createElement('text', { x: 44, y: h - 24, fill: '#888', fontSize: 10 }, `min ${min.toFixed(2)}`),
    createElement('text', { x: 44, y: h - 6, fill: '#666', fontSize: 9 }, points[0].label),
    createElement('text', { x: Math.max(44, w - 140), y: h - 6, fill: '#666', fontSize: 9 }, points[n - 1].label),
    n > 1 ? createElement('polyline', { points: coords, fill: 'none', stroke: color, strokeWidth: 1.5 }) : null,
    points.map((p, i) => createElement('circle', { key: p.id, cx: px(i), cy: py(p.value), r: 2.5, fill: color })),
  )
}

// ── L 场读数 tab ─────────────────────────────────────────────────────────────

function XuegulinLFieldView(): ReactNode {
  const [state, setState] = useState<M2State | null>(null)
  const [ann, setAnn] = useState<AnnotationsState | null>(null)
  const [failed, setFailed] = useState(false)
  const [axis, setAxis] = useState<'date' | 'turn'>('date')
  const [metric, setMetric] = useState<'miss' | 'tps'>('miss')
  const [sessionSel, setSessionSel] = useState<string>('')

  const load = (): void => {
    fetch('/api/xuegulin/m2/state', { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<M2State>) : Promise.resolve(null)))
      .then((s) => { setState(s); setFailed(s === null) })
      .catch(() => { setState(null); setFailed(true) })
    fetch('/api/xuegulin/m2/annotations', { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? (r.json() as Promise<AnnotationsState>) : Promise.resolve(null)))
      .then((a) => { if (a) setAnn(a) })
      .catch(() => undefined)
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 120000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed && state === null) return createElement('div', { style: MONO }, 'L 场读数不可用（/api/xuegulin/m2/state）')
  if (state === null) return createElement('div', { style: MONO }, 'L 场读数加载中...')

  const sessions = [...new Set(state.curve.map((p) => p.session))]
  const sel = sessionSel !== '' && sessions.includes(sessionSel) ? sessionSel : (sessions[0] ?? '')
  const points = axis === 'date' ? state.curve : state.curve.filter((p) => p.session === sel)
  // 官方口径：usage.inputTokens = 未命中；总输入 = inputTokens + cacheReadTokens
  const totalIn = (p: M2Point): number => p.tokenIn + p.cacheRead
  const missRate = (p: M2Point): number => (totalIn(p) > 0 ? p.tokenIn / totalIn(p) : 0)
  const hitRateOf = (p: M2Point): number | null => (totalIn(p) > 0 ? p.cacheRead / totalIn(p) : null)
  const curve = points.map((p, i) => ({
    id: `${p.session}-${p.turn}`,
    value: metric === 'miss' ? missRate(p) : (p.tps ?? 0),
    label: axis === 'date' ? fmtTime(p.ts) : `turn ${p.turn}`,
  }))

  const t = state.totals
  const latest = state.latest
  const miss = 1 - (t.hitRate ?? 0)

  // 标注表
  const annMap = new Map<string, Annotation>((ann?.annotations ?? []).map((a) => [a.prophecy, a]))

  const saveAnn = (prophecy: string, status: string): void => {
    fetch('/api/xuegulin/m2/annotations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prophecy, status }),
    }).then((r) => (r.ok ? load() : undefined)).catch(() => undefined)
  }

  const lines: ReactNode[] = []
  lines.push('【最新读数】')
  if (latest) {
    lines.push(`  turn ${latest.turn} · ${shortSession(latest.session)} · ${fmtTime(latest.ts)}`)
    lines.push(`  输入=${fmtK(totalIn(latest))}（未命中 ${fmtK(latest.tokenIn)} / 命中 ${fmtK(latest.cacheRead)}） out=${fmtK(latest.tokenOut)} 命中率=${pct(hitRateOf(latest))} A 投影（未命中率）=${pct(missRate(latest))} TPS=${latest.tps === null ? '—' : latest.tps.toFixed(1)}`)
    if (latest.question) lines.push(`  问：${latest.question}`)
  } else {
    lines.push('  （重启后尚未记录——等待会话活动）')
  }
  lines.push(`【总量】${t.turns} 轮 · 输入=${fmtK(t.totalIn ?? t.tokenIn + t.cacheRead)}（未命中 ${fmtK(t.missToken)} / 命中 ${fmtK(t.cacheRead)}） out=${fmtK(t.tokenOut)}（命中率 ${pct(t.hitRate)} / A 投影（未命中率）${pct(miss)}）`)
  lines.push('【探索率曲线 / TPS】（SVG 自绘；hover 交互 9.4）')

  return createElement('div', { style: MONO },
    createElement('pre', undefined, lines.join('\n')),
    createElement('div', null,
      createElement('button', { onClick: () => setAxis(axis === 'date' ? 'turn' : 'date'), style: { marginRight: 8 } }, axis === 'date' ? '日期视图 → 轮次视图' : '轮次视图 → 日期视图'),
      axis === 'turn'
        ? createElement('select', { value: sel, onChange: (e) => setSessionSel(e.target.value) },
            sessions.map((s) => createElement('option', { key: s, value: s }, shortSession(s))))
        : null,
      createElement('button', { onClick: () => setMetric(metric === 'miss' ? 'tps' : 'miss'), style: { marginLeft: 8 } }, metric === 'miss' ? '指标：未命中率（A 投影） → TPS' : '指标：TPS → 未命中率（A 投影）'),
    ),
    createElement(LineChart, { points: curve, w: 560, h: 160, color: metric === 'miss' ? '#4fc3f7' : '#ffe082' }),
    createElement('pre', undefined, '【预言检验表】（人工标注，框架先行）'),
    createElement('table', { key: 'ann', border: 1, cellPadding: 4 },
      createElement('tbody', null,
        Object.entries(PROPHECIES).map(([key, desc]) => {
          const a = annMap.get(key)
          const status = a?.status ?? 'pending'
          return createElement('tr', { key },
            createElement('td', null, `${key} ${desc}`),
            createElement('td', null,
              createElement('select', { value: status, onChange: (e) => saveAnn(key, e.target.value) },
                Object.entries(STATUS_LABEL).map(([v, l]) => createElement('option', { key: v, value: v }, l)),
              ),
            ),
            createElement('td', { style: { color: '#888' } }, a?.note ?? ''),
          )
        }),
      ),
    ),
  )
}

// ── tab 注册 ─────────────────────────────────────────────────────────────────

export const inject = ['slots']

function XuegulinView(): ReactNode {
  const [state, setState] = useState<XuegulinState | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      fetch('/api/xuegulin/state', { headers: { 'sec-fetch-site': 'same-origin' } })
        .then((r) => (r.ok ? (r.json() as Promise<XuegulinState>) : Promise.resolve(null)))
        .then((s) => { if (alive) { setState(s); setFailed(s === null) } })
        .catch(() => { if (alive) { setState(null); setFailed(true) } })
    }
    load()
    const timer = setInterval(load, 30000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const style = { padding: '12px', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' as const }
  if (failed && state === null) {
    return createElement('div', { style }, 'Vault 观测数据不可用（/api/xuegulin/state）')
  }
  if (state === null) return createElement('div', { style }, 'Vault 观测加载中...')

  const lines: string[] = []
  lines.push(`文件总数：${state.totals.totalFiles}   总字数：${state.totals.totalChars}`)
  lines.push(`今日：${state.today.edits} 次编辑 / ${state.today.modifiedFiles} 个修改文件 / +${state.today.createdFiles} 新增`)
  lines.push(`本周：${state.week.edits} 次编辑 / ${state.week.modifiedFiles} 个修改文件 / +${state.week.createdFiles} 新增`)
  if (state.today.topActive.length > 0) {
    lines.push('今日活跃 Top：')
    for (const t of state.today.topActive) lines.push(`  ${t.edits} 次  ${t.path}`)
  }
  lines.push('最近编辑：')
  for (const ev of state.recent.slice(0, 10)) {
    const d = new Date(ev.ts)
    lines.push(`  [${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}] ${ev.kind} ${ev.path}`)
  }
  return createElement('div', { style }, createElement('pre', undefined, lines.join('\n')))
}

type XuegulinState = {
  revision: number
  totals: { totalFiles: number; totalChars: number }
  today: { edits: number; modifiedFiles: number; createdFiles: number; topActive: Array<{ path: string; edits: number }> }
  week: { edits: number; modifiedFiles: number; createdFiles: number; topActive: Array<{ path: string; edits: number }> }
  recent: Array<{ ts: number; path: string; kind: string }>
}

export function apply(ctx: { slots: { inject(key: string, callback: () => unknown): unknown } }): void {
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: '@dsh-external/dsh-xuegulin-panel',
        order: 30,
        label: () => 'Vault 观测',
      }, XuegulinView),
    ),
    '@dsh-external/dsh-xuegulin: panel',
  )
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: '@dsh-external/dsh-xuegulin-lfield-panel',
        order: 35,
        label: () => 'L 场读数',
      }, XuegulinLFieldView),
    ),
    '@dsh-external/dsh-xuegulin: lfield panel',
  )
}
