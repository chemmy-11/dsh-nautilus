/**
 * @dsh-external/dsh-nexus — Nautilus 工作台（全局面板，S4「瑞士制图」）。
 *
 * 规格：docs/2-dev/nautilus-dev-02-ui-workbench.md（§2 令牌 / §3 五视图+抽屉+era 条 / §4 组件 / §5 人工标注 / §6 数据契约）
 * 入口：sidebar.panellist 图标（root）+ main keyed 面板（root），两者 id 同值 = MainPanelId（§3.0 实测契约）。
 *
 * 数据口径（只读；唯一写操作是预言标注 POST /m2/annotations）：
 *   · NEXUS 层：/api/nexus/state（vault 总量/今日/本周）、/api/nexus/m2/state（逐轮读数/曲线/自评覆盖）
 *   · PULSE 层：/api/nexus/pulse/state（每指标最新值 + 采集器健康度）
 *   · INFER 层：Phase 2a 才落库（TTFT/provider）——当前所有视图显示缺席态，不编造、不写 0 假读数
 * 空数据是正常态（本阶段允许）。
 */
import { Component, createElement, useEffect, useState, type ReactNode } from 'react'

export const WORKBENCH_ID = 'nautilus-workbench'

// ── 样式（--nt-* 令牌由 index.ts 注入；此处只补工作台专属类）───────────────────

let styleDone = false
const CSS_LINES = [
  '.nt-wb{display:flex;flex-direction:column;height:100%;min-width:0;background:var(--nt-bg,#f2f2f0);color:var(--nt-text,#101010);font-family:var(--nt-font,Helvetica,Arial,sans-serif)}',
  '.nt-wb-top{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:2px solid var(--nt-text,#101010);background:var(--nt-panel,#fff);flex-wrap:wrap}',
  '.nt-wb-brand{font-size:15px;font-weight:700;letter-spacing:2.5px}',
  '.nt-wb-brand small{display:block;font-size:9px;letter-spacing:1.5px;font-weight:400;color:var(--nt-faint,#9a9a95);text-transform:uppercase}',
  '.nt-wb-seg{display:flex;border:1px solid var(--nt-border,#d9d9d5)}',
  '.nt-wb-seg button{border:0;background:transparent;color:var(--nt-dim,#5f5f5c);font-size:11px;letter-spacing:1.5px;padding:5px 11px;cursor:pointer;text-transform:uppercase}',
  '.nt-wb-seg button.on{background:var(--nt-text,#101010);color:var(--nt-panel,#fff)}',
  '.nt-wb-right{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:1.5px;color:var(--nt-faint,#9a9a95);text-transform:uppercase}',
  '.nt-era{display:flex;align-items:center;gap:10px;padding:6px 16px;border-bottom:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel2,#f7f7f5);font-size:10px;letter-spacing:1.2px;color:var(--nt-dim,#5f5f5c);flex-wrap:wrap}',
  '.nt-era .badge{border:1px solid var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e);padding:1px 6px;letter-spacing:2px}',
  '.nt-wb-body{flex:1;overflow:auto;padding:14px 16px}',
  '.nt-wb-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
  '@media (max-width:1080px){.nt-wb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '.nt-stat{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);padding:9px 11px;position:relative;border-radius:2px}',
  '.nt-stat .layer{position:absolute;top:7px;right:9px;font-size:8.5px;letter-spacing:1.5px;color:var(--nt-faint,#9a9a95)}',
  '.nt-stat .lab{font-size:9px;letter-spacing:2px;color:var(--nt-dim,#5f5f5c);text-transform:uppercase}',
  '.nt-stat .val{font-size:25px;font-weight:300;line-height:1.15;font-variant-numeric:tabular-nums}',
  '.nt-stat .val.warn{color:var(--nt-accent,#e6321e)}',
  '.nt-stat .note{font-size:10px;color:var(--nt-faint,#9a9a95)}',
  '.nt-panel{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);border-radius:2px;margin-top:12px}',
  '.nt-panel > h4{margin:0;padding:8px 11px;border-bottom:1px solid var(--nt-border,#d9d9d5);font-size:10px;letter-spacing:2px;text-transform:uppercase;display:flex;gap:8px;align-items:center}',
  '.nt-panel > h4 em{font-style:normal;color:var(--nt-faint,#9a9a95);letter-spacing:1.5px}',
  '.nt-panel .body{padding:10px 11px}',
  '.nt-note{margin:8px 0 0;padding:6px 9px;border-left:2px solid var(--nt-border2,#c8c8c3);font-size:10.5px;color:var(--nt-dim,#5f5f5c);line-height:1.55}',
  '.nt-tbl{width:100%;border-collapse:collapse;font-size:11px}',
  '.nt-tbl th{text-align:left;font-size:9px;letter-spacing:1.5px;color:var(--nt-faint,#9a9a95);text-transform:uppercase;border-bottom:1px solid var(--nt-border,#d9d9d5);padding:4px 6px;font-weight:500}',
  '.nt-tbl td{border-bottom:1px solid var(--nt-border,#d9d9d5);padding:4px 6px;font-variant-numeric:tabular-nums}',
  '.nt-tbl tr.clickable{cursor:pointer}',
  '.nt-tbl tr.clickable:hover td{background:var(--nt-panel2,#f7f7f5)}',
  '.nt-tag{font-size:9px;letter-spacing:1px;border:1px solid var(--nt-border2,#c8c8c3);padding:0 4px;color:var(--nt-dim,#5f5f5c)}',
  '.nt-tag.red{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-empty{padding:14px;text-align:center;color:var(--nt-faint,#9a9a95);font-size:11px;letter-spacing:1px}',
  '.nt-drawer{position:fixed;top:0;right:0;width:400px;max-width:92vw;height:100vh;background:var(--nt-panel,#fff);border-left:1px solid var(--nt-border,#d9d9d5);z-index:40;display:flex;flex-direction:column}',
  '.nt-drawer .dh{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--nt-border,#d9d9d5);font-size:11px;letter-spacing:1.5px;text-transform:uppercase}',
  '.nt-drawer .dh button{margin-left:auto}',
  '.nt-drawer .db{flex:1;overflow:auto;padding:12px 14px}',
  '.nt-drawer h5{font-size:9.5px;letter-spacing:2px;color:var(--nt-faint,#9a9a95);margin:14px 0 5px;text-transform:uppercase}',
  '.nt-scrim{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:39}',
  '.nt-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--nt-text,#101010);color:var(--nt-panel,#fff);font-size:11px;letter-spacing:1px;padding:7px 14px;border-radius:2px;z-index:60}',
  '.nt-card{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);border-radius:2px;padding:10px 12px;margin-top:10px}',
  '.nt-card .hd{display:flex;gap:8px;align-items:center;font-size:12px}',
  '.nt-card .hd b{letter-spacing:1px}',
  '.nt-card .st{font-size:9px;letter-spacing:1.5px;border:1px solid var(--nt-border2,#c8c8c3);padding:0 5px;color:var(--nt-dim,#5f5f5c)}',
  '.nt-card .st.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-card p{margin:7px 0 0;font-size:11.5px;line-height:1.6;color:var(--nt-dim,#5f5f5c)}',
  '.nt-report{max-width:820px;margin:0 auto}',
  '.nt-report .meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11px;border:1px solid var(--nt-border,#d9d9d5);padding:10px 12px;background:var(--nt-panel2,#f7f7f5)}',
  '.nt-report .meta b{font-weight:500;color:var(--nt-faint,#9a9a95);letter-spacing:1px;text-transform:uppercase;font-size:9.5px}',
  '.nt-report .prose{font-family:Georgia,serif;font-size:13px;line-height:1.95;margin-top:12px}',
  '.nt-report .gate{margin-top:14px;border:1px solid var(--nt-accent,#e6321e);padding:10px 12px;font-size:11px;display:flex;gap:10px;align-items:center}',
  '.nt-btn{border:1px solid var(--nt-border2,#c8c8c3);background:transparent;color:var(--nt-text,#101010);font-size:11px;padding:3px 9px;cursor:pointer;border-radius:2px}',
  '.nt-btn:hover{border-color:var(--nt-text,#101010)}',
  '.nt-btn.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-select,.nt-input{border:1px solid var(--nt-border2,#c8c8c3);background:var(--nt-panel,#fff);color:var(--nt-text,#101010);font-size:11px;padding:3px 6px;border-radius:2px}',
]

function injectWorkbenchStyle(): void {
  if (styleDone || typeof document === 'undefined') return
  styleDone = true
  const el = document.createElement('style')
  el.id = 'nt-workbench-style'
  el.textContent = CSS_LINES.join(String.fromCharCode(10))
  document.head.appendChild(el)
}

// ── era 措辞分级（集中常量：避免「对照/归因」裸串漂移）──────────────────────────

export type Era = 'api' | 'local'
/** era → 因果强度措辞：api 时代只能说「对照」（弱因果），local 才能说「归因」。 */
export function eraWord(era: Era): string { return era === 'api' ? '对照' : '归因' }
/** era 判定依据与对照集规则的说明文案。 */
export function eraNote(era: Era): string {
  return era === 'api'
    ? 'era=api：应用层流量命中云端 API，本机资源与云端缓存命中率之间无因果通路——结论只用「对照」措辞，不作归因。'
    : 'era=local：本地推理栈落地后三层强因果闭合，可用「归因」措辞。（本地部署未落地，此处仅演示措辞分级）'
}

// ── 取数（只读轮询；抽屉打开时暂停——沿 M4.2 惯例）─────────────────────────────

export function useJson<T>(url: string, paused: boolean, intervalMs = 120000, nonce = 0): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (paused) return
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } })
        if (!r.ok) return
        const j = (await r.json()) as T
        if (alive) setData(j)
      } catch { /* 缺席：保留上一份 */ }
    }
    void load()
    const t = setInterval(() => { void load() }, intervalMs)
    return () => { alive = false; clearInterval(t) }
  }, [url, paused, intervalMs, nonce])
  return data
}

// ── 数据面类型（只取用到的字段）─────────────────────────────────────────────────

/** 单条最新采样（pulse store latest() 的行形状 + 路由 tags 解码结果）。 */
export type PulsePoint = { metric: string; value: number | null; ts: number; tags: unknown }
/** 单指标序列（pulse store series()：桶均值 + 桶内样本数）。 */
export type PulseSeries = { metric: string; from: number; to: number; windowMs: number; maxPoints: number; bucketMs: number; points: Array<{ ts: number; value: number; n: number }> }

export type PulseState = {
  collector: { ticks: number; lastTickTs: number | null; countersOk: boolean; gpuOk: boolean; shellPath: string | null; execAvailable: boolean; lastError: string | null }
  db: { rows: number; oldestTs: number | null; newestTs: number | null; schemaVersion: number }
  latest: PulsePoint[]
}
export type DaySummary = { edits: number; created: number; modified: number; deleted: number }
export type NexusState = { activeRoot: string; totals: { totalFiles: number; totalChars: number }; today: DaySummary; week: DaySummary; recent: Array<{ ts: number; path: string; kind: string }> }
export type M2Point = { session: string; turn: number; ts: number; tokenIn: number; tokenOut: number; cacheRead: number; durationMs: number | null; tps: number | null; question?: string | null; clarity?: number | null; defense?: string | null; declaration?: number | null }
export type M2State = {
  pointing: string
  totals: { turns: number; tokenIn: number; tokenOut: number; cacheRead: number; missToken: number; hitRate: number | null }
  curve: M2Point[]
  recent: M2Point[]
  selfcheck: { checked: number; total: number }
  sessionMeta: Record<string, { startTs: number; turns: number }>
}
export type Annotation = { prophecy: string; status: string; note: string | null; updatedAt: number }
export type AnnotationsState = { annotations: Annotation[] }

export const PROPHECY_SEED: Array<[string, string]> = [
  ['P1', '缓存未命中率随知识库会话推进下降（S 形）'],
  ['P2', '纯粹宣告轮次在自评 declaration 上可辨'],
  ['P3', '防御强度与未命中率同向变化'],
  ['P4', 'τ_e 在知识型会话中显著大于闲聊会话'],
  ['P5', 'TPS 与未命中率负相关（上下文越长解码越慢）'],
  ['P6', 'vault 会话未命中率高于非指向工作区'],
  ['P7', '同窗 CPU 尖峰与未命中率上升共存'],
  ['P8', 'GPU 显存占用与本地推理无关（api 时代）'],
  ['P9', '自评覆盖率提升不改变读数分布'],
]
export const STATUS_LABEL: Record<string, string> = { pending: '待标注', doing: '进行中', checked: '已检验' }

export const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1 }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
}
export const fmtTime = (ts: number | null | undefined): string => ts === null || ts === undefined ? '—' : new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
export const fmtNum = (n: number | null | undefined, d = 2): string => n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d)

/** 指标名 → 中文标签（未知指标原样返回，不猜语义）。 */
export function metricLabel(metric: string): string {
  const table: Record<string, string> = {
    'cpu.utilization': 'CPU 利用率',
    'cpu.ctx_switches': '上下文切换',
    'mem.used': '内存占用',
    'mem.total': '内存总量',
    'mem.swap.used': '交换区占用',
    'disk.io_rate': '磁盘吞吐',
    'disk.queue': '磁盘队列',
    'net.io_rate': '网络吞吐',
    'proc.dsh.rss': '宿主进程 RSS',
    'proc.dsh.cpu': '宿主进程 CPU',
    'gpu.util': 'GPU 利用率',
    'gpu.mem.used': '显存占用',
    'gpu.mem.total': '显存总量',
    'gpu.temp': 'GPU 温度',
    'gpu.power': 'GPU 功耗',
  }
  const m = metric.replace(/^pulse[.]/, '')
  return table[m] ?? m
}

/** 指标名 → 分组（用于分组呈现与排序）。 */
export function metricGroup(metric: string): string {
  const m = metric.replace(/^pulse[.]/, '')
  const head = m.slice(0, m.indexOf('.'))
  const groups: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网络', proc: '进程', gpu: 'GPU' }
  return groups[head] ?? '其他'
}

/** 值 → 带量纲字符串。量纲逐个取自 src/pulse/collect.ts 与 src/pulse/counters.ts 的构造点；未知指标不猜，原样加标注。 */
export function fmtMetricValue(metric: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const m = metric.replace(/^pulse[.]/, '')
  if (m === 'gpu.util') return v.toFixed(0) + '%'
  if (m === 'cpu.utilization' || m === 'proc.dsh.cpu') return (v * 100).toFixed(1) + '%'
  if (m === 'gpu.mem.used' || m === 'gpu.mem.total') return v.toFixed(0) + ' MiB'
  if (m === 'gpu.temp') return v.toFixed(0) + ' °C'
  if (m === 'gpu.power') return v.toFixed(1) + ' W'
  if (m === 'cpu.ctx_switches') return v.toFixed(0) + ' /s'
  if (m === 'disk.queue') return v.toFixed(0)
  if (m === 'disk.io_rate' || m === 'net.io_rate') return fmtBytes(v) + '/s'
  if (m === 'mem.used' || m === 'mem.total' || m === 'mem.swap.used' || m === 'proc.dsh.rss') return fmtBytes(v)
  return String(v) + '（量纲未知）'
}

// ── 公共组件（§4）──────────────────────────────────────────────────────────

export function Stat(props: { layer: string; label: string; value: string; note?: string; warn?: boolean }): ReactNode {
  return createElement('div', { className: 'nt-stat' },
    createElement('span', { className: 'layer' }, props.layer),
    createElement('div', { className: 'lab' }, props.label),
    createElement('div', { className: 'val' + (props.warn === true ? ' warn' : '') }, props.value),
    props.note !== undefined ? createElement('div', { className: 'note' }, props.note) : null,
  )
}

export function Panel(props: { title: string; fig?: string; note?: string; children?: ReactNode }): ReactNode {
  return createElement('div', { className: 'nt-panel' },
    createElement('h4', null, props.fig !== undefined ? createElement('em', null, props.fig) : null, props.title),
    createElement('div', { className: 'body' }, props.children),
    props.note !== undefined ? createElement('p', { className: 'nt-note' }, props.note) : null,
  )
}

export function Empty(props: { text: string }): ReactNode { return createElement('div', { className: 'nt-empty' }, props.text) }

/**
 * 视图错误隔离：单个视图渲染抛错时只替换该视图，其余视图与 era 条照常可用。
 * 教训（2026-09-13 端上实测）：视图组件若被当普通函数调用，hooks 会算进父组件，
 * 切视图时 hooks 数量变化 → React 抛错 → **整页白屏**，症状是「按钮点了没反应」。
 */
export class ViewBoundary extends Component<{ label?: string; children?: ReactNode }, { error: string | null }> {
  constructor(props: { label?: string; children?: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(err: unknown): { error: string } { return { error: String(err) } }
  render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('div', { className: 'nt-panel' },
        createElement('h4', null, '视图渲染失败 · ' + String(this.props.label ?? '')),
        createElement('div', { className: 'body' },
          createElement('p', { className: 'nt-note' }, '该视图渲染时抛错，已隔离——其它视图与数据不受影响。错误原文：' + this.state.error),
          createElement('button', { className: 'nt-btn', onClick: () => this.setState({ error: null }) }, '重试渲染'),
        ),
      )
    }
    return this.props.children
  }
}

/** 单层曲线（SVG 自绘；S4 定稿视觉：发丝网格 + 墨线 + 朱红阈值/关键点 + τ_e 注记；点数不足 2 → 空态）。 */
export function Spark(props: {
  points: Array<{ x: number; y: number | null }>
  h?: number
  threshold?: number
  thresholdLabel?: string
  yFmt?: (v: number) => string
  anno?: { from: number; to: number; txt: string }
  label?: string
}): ReactNode {
  const pts = props.points.filter((p) => p.y !== null && Number.isFinite(p.y))
  if (pts.length < 2) return Empty({ text: '暂无数据' })
  const h = props.h ?? 150
  const w = 960
  const padL = 46
  const padR = 14
  const padT = 24
  const padB = 24
  const ys = pts.map((p) => p.y as number)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  const n = pts.length
  const sx = (i: number): number => padL + (i / Math.max(1, n - 1)) * (w - padL - padR)
  const sy = (v: number): number => h - padB - ((v - min) / span) * (h - padT - padB)
  const yf = props.yFmt ?? ((v: number): string => v.toFixed(1))
  const kids: ReactNode[] = []
  // 发丝网格 + y 刻度（4 档，定稿：左端小字）
  for (const r of [0, 1 / 3, 2 / 3, 1]) {
    const v = min + span * r
    const y = sy(v)
    kids.push(createElement('line', { key: 'g' + String(r), x1: padL, x2: w - padR, y1: y, y2: y, stroke: 'var(--nt-border,#d9d9d5)', strokeWidth: 1, opacity: 0.7 }))
    kids.push(createElement('text', { key: 't' + String(r), x: padL - 6, y: y + 3, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)', textAnchor: 'end' }, yf(v)))
  }
  // x 时间刻度（首/中/末；x 为 epoch ms 时自动生成，跨度 <36h 只显时分）
  if (n >= 3 && pts[0].x > 1e12) {
    const spanMs = pts[n - 1].x - pts[0].x
    const short = spanMs < 36 * 3600000
    const xt = (x: number): string => {
      const d = new Date(x)
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return short ? hm : String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm
    }
    for (const k of [0, Math.floor((n - 1) / 2), n - 1]) {
      const x = sx(k)
      kids.push(createElement('line', { key: 'x' + String(k), x1: x, x2: x, y1: h - padB, y2: h - padB + 3, stroke: 'var(--nt-border,#d9d9d5)' }))
      kids.push(createElement('text', { key: 'xl' + String(k), x, y: h - 7, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)', textAnchor: 'middle' }, xt(pts[k].x)))
    }
  }
  // 阈值线（朱红虚线 + 右上标签——定稿元素）
  if (props.threshold !== undefined && props.threshold >= min && props.threshold <= max) {
    const y = sy(props.threshold)
    kids.push(createElement('line', { key: 'th', x1: padL, x2: w - padR, y1: y, y2: y, stroke: 'var(--nt-accent,#e6321e)', strokeWidth: 1, strokeDasharray: '2 4', opacity: 0.8 }))
    kids.push(createElement('text', { key: 'tht', x: w - padR, y: y - 4, fontSize: 9, fill: 'var(--nt-accent,#e6321e)', textAnchor: 'end', letterSpacing: 1 }, props.thresholdLabel ?? '阈值'))
  }
  // τ_e 注记（虚线段 + 顶部文字——定稿元素；from/to 为点序号）
  if (props.anno !== undefined && n >= 4) {
    const a = props.anno
    const x1 = sx(Math.max(0, Math.min(n - 1, a.from)))
    const x2 = sx(Math.max(0, Math.min(n - 1, a.to)))
    kids.push(createElement('line', { key: 'an', x1, x2, y1: 14, y2: 14, stroke: 'var(--nt-dim,#5f5f5c)', strokeWidth: 1, strokeDasharray: '3 3' }))
    kids.push(createElement('text', { key: 'ant', x: (x1 + x2) / 2, y: 9, fontSize: 9, fill: 'var(--nt-dim,#5f5f5c)', textAnchor: 'middle', letterSpacing: 1 }, a.txt))
  }
  // 墨线（主线）
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + sx(i).toFixed(1) + ' ' + sy(p.y as number).toFixed(1)).join(' ')
  kids.push(createElement('path', { key: 'line', d, fill: 'none', stroke: 'var(--nt-ink,#101010)', strokeWidth: 1.6 }))
  // 关键点：越过阈值的轮 → 朱红实心（定稿：朱红＝关键点）
  if (props.threshold !== undefined) {
    const th = props.threshold
    pts.forEach((p, i) => {
      if ((p.y as number) >= th) kids.push(createElement('circle', { key: 'm' + String(i), cx: sx(i), cy: sy(p.y as number), r: 2.8, fill: 'var(--nt-accent,#e6321e)' }))
    })
  }
  return createElement('svg', { viewBox: '0 0 ' + String(w) + ' ' + String(h), width: '100%', height: h, role: 'img', 'aria-label': props.label ?? 'series' }, ...kids)
}

// ── 视图 1：总览 ──────────────────────────────────────────────────────────────

export function OverviewView(props: { nexus: NexusState | null; m2: M2State | null; pulse: PulseState | null; vault: VaultInfo | null; lfield: LfieldInfo | null; rescanning: boolean; onRescan: () => void; onOpenTurn: (s: string, t: number) => void }): ReactNode {
  const { nexus, m2, pulse } = props
  const n = m2?.totals
  const hr = n?.hitRate
  const last = pulse?.collector.lastTickTs ?? null
  const lagMs = last === null ? null : Date.now() - last
  const stale = lagMs !== null && lagMs > 180000
  const rows: Array<{ layer: string; label: string; value: string; note?: string; warn?: boolean }> = [
    { layer: 'PULSE', label: '采集器心跳', value: last === null ? '未采样' : fmtTime(last), note: pulse === null ? 'pulse 未装配' : 'tick ' + String(pulse.collector.ticks) + ' · 库内 ' + String(pulse.db.rows) + ' 行 · shell=' + String(pulse.collector.shellPath === null ? '无' : pulse.collector.shellPath), warn: stale },
    { layer: 'NEXUS', label: 'vault 总量', value: nexus === null ? '—' : fmtBytes(nexus.totals.totalChars) + ' / ' + String(nexus.totals.totalFiles) + ' 文件', note: nexus === null ? '读取中或接口缺席' : 'root=' + nexus.activeRoot },
    { layer: 'NEXUS', label: '今日写入', value: nexus === null ? '—' : String(nexus.today.edits) + ' 次', note: nexus === null ? '—' : '新建 ' + String(nexus.today.created) + ' · 修改 ' + String(nexus.today.modified) + ' · 删除 ' + String(nexus.today.deleted) },
    { layer: 'NEXUS', label: '窗口缓存命中率', value: hr === null || hr === undefined ? '—' : (hr * 100).toFixed(1) + '%', note: n === undefined ? '—' : '读 ' + String(n.cacheRead) + ' / 未命中 ' + String(n.missToken) + ' 令牌 · ' + String(n.turns) + ' 轮', warn: hr !== null && hr !== undefined && hr < 0.5 },
    { layer: 'INFER', label: '推理时延 TTFT', value: '—', note: 'Phase 2a 采集（provider 侧未接入）', warn: false },
    { layer: 'INFER', label: '层间对齐度', value: '—', note: '需 INFER 落地后方可计算 τ_e', warn: false },
    { layer: 'M5', label: '预言命中', value: '—', note: 'call_p 未落库（迁移至 schema v5）', warn: false },
    { layer: 'SELF', label: '自评覆盖率', value: m2 === null ? '—' : String(m2.selfcheck.checked) + ' / ' + String(m2.selfcheck.total), note: '每轮 record_turn_selfcheck 落盘比例' },
  ]
  const recent = m2?.recent ?? []
  const latest = pulse?.latest ?? []
  const HEADLINE = ['pulse.cpu.utilization', 'pulse.mem.used', 'pulse.gpu.util', 'pulse.proc.dsh.rss']
  const headline = HEADLINE.map((name) => latest.find((l) => l.metric === name)).filter((x): x is PulsePoint => x !== undefined)
  const sorted = latest.slice().sort((a, b) => (metricGroup(a.metric) + a.metric).localeCompare(metricGroup(b.metric) + b.metric, 'zh-Hans-CN'))
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '读数为观测所得，非评价：本面板只呈现「发生了什么」。三层齐备前（INFER 缺席），任何跨层结论都只能用「对照」措辞。'),
    createElement('div', { className: 'nt-wb-grid' }, ...rows.map((r) => Stat({ layer: r.layer, label: r.label, value: r.value, note: r.note, warn: r.warn }))),
    Panel({
      title: '系统层读数（PULSE · 本机）', fig: 'FIG.01',
      note: '量纲取自 src/pulse/{collect,counters}.ts 的构造点：utilization / proc.cpu 是「占单核比」已换算为百分比，io_rate 为字节/秒，gpu.mem 为 MiB，temp/power 为 °C/W。本机读数与云端缓存之间在 era=api 下没有因果通路——此处只作对照，不作归因。',
      children: latest.length === 0
        ? Empty({ text: pulse === null ? 'PULSE 层缺席：宿主内子插件未挂载或接口不可达' : '尚无采样——等待采集器首个 tick' })
        : createElement('div', null,
          headline.length > 0
            ? createElement('div', { className: 'nt-wb-grid' }, ...headline.map((m) => Stat({ layer: 'PULSE', label: metricLabel(m.metric), value: fmtMetricValue(m.metric, m.value), note: metricGroup(m.metric) + ' · ' + fmtTime(m.ts) })))
            : null,
          createElement('table', { className: 'nt-tbl', style: { marginTop: 10 } },
            createElement('thead', null, createElement('tr', null,
              ...['指标', '分组', '最新值', '采样时刻'].map((h) => createElement('th', { key: h }, h)))),
            createElement('tbody', null, ...sorted.map((m) => createElement('tr', { key: m.metric },
              createElement('td', null, metricLabel(m.metric)),
              createElement('td', null, createElement('span', { className: 'nt-tag' }, metricGroup(m.metric))),
              createElement('td', null, fmtMetricValue(m.metric, m.value)),
              createElement('td', null, fmtTime(m.ts)),
            )))),
          createElement('p', { className: 'nt-note' },
            '采集健康：tick ' + String(pulse?.collector.ticks ?? 0) + ' · 库内 ' + String(pulse?.db.rows ?? 0) + ' 行 ' + String(latest.length) + ' 指标 · shell=' + String(pulse?.collector.shellPath ?? '无') + ' · 计数器 ' + (pulse?.collector.countersOk === true ? '正常' : '不可用') + ' · GPU ' + (pulse?.collector.gpuOk === true ? '正常' : '不可用') + ' · 助手重启 ' + String(pulse?.collector.countersRestarts ?? 0) + ' 次' + (pulse?.collector.lastError === null || pulse?.collector.lastError === undefined ? '' : ' · 最近错误：' + pulse.collector.lastError)),
        ),
    }),
    Panel({
      title: '最近轮次读数', fig: 'FIG.02',
      note: '读数为原始记录；轮次内的问题/回答属解释层，不写回读数（见抽屉）。',
      children: recent.length === 0
        ? Empty({ text: m2 === null ? 'M2 读数接口读取中或不可用' : '窗口内暂无轮次记录' })
        : createElement('table', { className: 'nt-tbl' },
          createElement('thead', null, createElement('tr', null,
            ...['时间', '会话', '轮', '输入(未命中)', '缓存读', '未命中率', '时长', 'TPS'].map((h) => createElement('th', { key: h }, h)))),
          createElement('tbody', null, ...recent.slice(0, 12).map((p) => createElement('tr', { key: p.session + '#' + String(p.turn), className: 'clickable', onClick: () => props.onOpenTurn(p.session, p.turn) },
            createElement('td', null, fmtTime(p.ts)),
            createElement('td', null, p.session.slice(0, 12)),
            createElement('td', null, String(p.turn)),
            createElement('td', null, String(p.tokenIn)),
            createElement('td', null, String(p.cacheRead)),
            createElement('td', null, (() => { const mr = curveValue(p, 'miss'); return mr === null ? '—' : (mr * 100).toFixed(1) + '%' })()),
            createElement('td', null, p.durationMs === null ? '—' : String(Math.round(p.durationMs)) + ' ms'),
            createElement('td', null, fmtNum(p.tps, 1)),
          )))),
    }),
    Panel({
      title: 'vault 指向与扫描', fig: 'FIG.07',
      note: '指向由 vault_config 表驱动：切换指向只改「看哪个库」，既有读数按 root 归属保留（观测记录不可逆，不删除）。重新扫描是全量核对 vault 文件，**不写入 vault**。',
      children: createElement('div', null,
        createElement('table', { className: 'nt-tbl' },
          createElement('tbody', null,
            ...[
              ['当前指向', props.vault === null ? (nexus === null ? '—' : shortRoot(nexus.activeRoot)) : (props.vault.known.find((k) => k.root === (props.vault === null ? '' : props.vault.active))?.displayName ?? shortRoot(props.vault.active)), 'NEXUS'],
              ['完整路径', props.vault === null ? (nexus?.activeRoot ?? '—') : props.vault.active, ''],
              ['可达性', props.vault === null ? '—' : (props.vault.exists ? '存在' : '不存在') + ' · ' + (props.vault.readable ? '可读' : '不可读'), ''],
              ['已知根', props.vault === null ? '—' : String(props.vault.known.length) + ' 个（含历史指向）', ''],
            ].map(([k, v, tag]) => createElement('tr', { key: k },
              createElement('td', { style: { width: '22%', color: 'var(--nt-faint,#9a9a95)' } }, k),
              createElement('td', null, v),
              createElement('td', { style: { width: '14%' } }, tag === '' ? null : createElement('span', { className: 'nt-tag' }, tag)),
            ))),
        ),
        createElement('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          createElement('button', { className: 'nt-btn', disabled: props.rescanning, onClick: props.onRescan }, props.rescanning ? '扫描中…' : '重新扫描 vault'),
          createElement('span', { style: { fontSize: 10, color: 'var(--nt-faint,#9a9a95)' } }, '只读核对：新增/修改/删除的文件数会更新到「今日写入」'),
        ),
      ),
    }),
    Panel({
      title: 'L 场读数（独立指向）', fig: 'FIG.08',
      note: 'M4-L：L 场读数的归属根与 vault 编辑统计**相互独立**（同一会话在不同根下读数分开计）。此处只呈现计数，读数明细在曲线与抽屉里。',
      children: props.lfield === null
        ? Empty({ text: 'L 场接口不可用（/api/nexus/lfield）' })
        : createElement('div', null,
          createElement('table', { className: 'nt-tbl' },
            createElement('thead', null, createElement('tr', null, ...['归属根', '读数条数'].map((h) => createElement('th', { key: h }, h)))),
            createElement('tbody', null, ...Object.entries(props.lfield.counts).map(([root, n]) => createElement('tr', { key: root === '' ? '(未归属)' : root },
              createElement('td', null, root === '' ? '（未归属：会话无 workspace）' : (props.lfield === null ? root : (props.lfield.known.find((k) => k.root === root)?.displayName ?? shortRoot(root)))),
              createElement('td', null, String(n)),
            )))),
          createElement('p', { className: 'nt-note' }, '当前 L 场指向：' + (props.lfield.known.find((k) => k.root === (props.lfield === null ? '' : props.lfield.active))?.displayName ?? shortRoot(props.lfield.active)) + ' · 已知根 ' + String(props.lfield.known.length) + ' 个'),
        ),
    }),
  )
}

// ── 视图 2：曲线 ──────────────────────────────────────────────────────────────

export type CurveKey = 'miss' | 'ms' | 'tps'
export function curveValue(p: M2Point, key: CurveKey): number | null {
  if (key === 'ms') return p.durationMs
  if (key === 'tps') return p.tps
  const read = p.cacheRead
  const miss = p.missToken ?? p.tokenIn
  const den = read + miss
  return den <= 0 ? null : miss / den
}
export function curveUnit(key: CurveKey): string { return key === 'miss' ? '%' : key === 'ms' ? 'ms' : 'tok/s' }
export function curveLabel(key: CurveKey): string { return key === 'miss' ? '未命中率' : key === 'ms' ? '每轮时长' : '解码速度' }

/** /m2/analysis 的逐会话行（只取注记所需字段）。 */
export type AnalysisRow = { session: string; shape: string; tauE: number | null; burst: { fromTurn: number; toTurn: number; direction: string } | null }
export const SHAPE_LABEL: Record<string, string> = { sigmoid: 'S 形', 'inverse-sigmoid': '反 S 形', rising: '上升', falling: '下降', unknown: '形态未定' }

/** M4.3 vault 指向（GET /api/nexus/vault）。 */
export type VaultInfo = {
  revision: number
  active: string
  exists: boolean
  readable: boolean
  known: Array<{ root: string; displayName: string | null; active: number; confirmedAt: number | null }>
}
/** M4-L L 场读数指向与计数（GET /api/nexus/lfield）。 */
export type LfieldInfo = {
  revision: number
  active: string
  counts: Record<string, number>
  known: Array<{ root: string; displayName: string | null; active: number; confirmedAt: number | null }>
}
/** 路径末段（指向短名的兜底；displayName 优先）。 */
export function shortRoot(root: string): string {
  const parts = root.split(/[\\/]/).filter((s) => s !== '')
  return parts.length === 0 ? '未指向' : parts[parts.length - 1]
}
/** 会话 id → 可读短名（不改动任何读数，仅呈现层截断）。 */
export function shortSession(id: string): string {
  return id.startsWith('session-') ? id.slice(8, 16) : id.slice(0, 8)
}

const CURVE_YFMT: Record<CurveKey, (v: number) => string> = {
  miss: (v) => String(Math.round(v)) + '%',
  ms: (v) => String(Math.round(v)),
  tps: (v) => v.toFixed(0),
}

export function CurveView(props: { m2: M2State | null; era: Era; pulse: PulseState | null; paused?: boolean }): ReactNode {
  const [key, setKey] = useState<CurveKey>('miss')
  const [scope, setScope] = useState<string>('all')
  // 数据源：NEXUS 轮次（事件驱动，非等间隔）/ PULSE 采样（等间隔，斜率可读）
  const [source, setSource] = useState<'nexus' | 'pulse'>('nexus')
  const analysis = useJson<AnalysisRow[]>('/api/nexus/m2/analysis?root=all', props.paused === true, 600000)
  const metrics = (props.pulse?.latest ?? []).map((l) => l.metric)
  const [picked, setPicked] = useState<string>('')
  const metric = picked !== '' && metrics.includes(picked) ? picked : (metrics[0] ?? '')
  const series = useJson<PulseSeries>('/api/nexus/pulse/series?metric=' + encodeURIComponent(metric) + '&windowMs=3600000&maxPoints=240', metric === '' || source !== 'pulse' || props.paused === true, 60000)
  const curve = props.m2?.curve ?? []
  const sessions = Array.from(new Set(curve.map((p) => p.session)))
  const scoped = scope === 'all' ? curve : curve.filter((p) => p.session === scope)
  const pts = scoped.map((p) => ({ x: p.ts, y: curveValue(p, key) }))
  const scaled = key === 'miss' ? pts.map((p) => ({ x: p.x, y: p.y === null ? null : p.y * 100 })) : pts
  const threshold = key === 'miss' ? 50 : undefined
  // τ_e 注记（定稿元素）：仅单会话聚焦且 analysis 检出时绘制——多点叠加轴上 τ_e 无意义
  let anno: { from: number; to: number; txt: string } | undefined
  if (key === 'miss' && scope !== 'all' && scaled.length >= 4) {
    const hit = (analysis ?? []).find((a) => a.session === scope)
    if (hit !== undefined && hit.tauE !== null && Number.isFinite(hit.tauE)) {
      const from = Math.floor(scaled.length * 0.3)
      anno = { from, to: Math.min(scaled.length - 1, from + Math.round(hit.tauE)), txt: 'τ_e ≈ ' + String(hit.tauE) + ' turn（' + (SHAPE_LABEL[hit.shape] ?? hit.shape) + '）' }
    }
  }
  const pulsePts = (series?.points ?? []).map((p) => ({ x: p.ts, y: p.value }))
  return createElement('div', null,
    createElement('div', { className: 'nt-wb-seg', style: { marginBottom: 10 } },
      createElement('button', { className: source === 'nexus' ? 'on' : '', onClick: () => setSource('nexus') }, 'NEXUS 轮次'),
      createElement('button', { className: source === 'pulse' ? 'on' : '', onClick: () => setSource('pulse') }, 'PULSE 采样'),
    ),
    source === 'nexus'
      ? createElement('div', null,
        createElement('div', { className: 'nt-wb-seg', style: { marginBottom: 10 } },
          ...(['miss', 'ms', 'tps'] as CurveKey[]).map((k) => createElement('button', { key: k, className: k === key ? 'on' : '', onClick: () => setKey(k) }, curveLabel(k))),
          createElement('span', { style: { width: 12 } }),
          createElement('button', { className: scope === 'all' ? 'on' : '', onClick: () => setScope('all') }, '全会话'),
          ...sessions.slice(0, 6).map((s) => createElement('button', { key: s, className: s === scope ? 'on' : '', onClick: () => setScope(s) }, s.slice(0, 8))),
        ),
        Panel({
          title: curveLabel(key) + ' 时序曲线', fig: 'FIG.02',
          note: '时间轴为记录时间戳（非等间隔）：轮次并非均匀采样，曲线的斜率不代表速率；朱红虚线为阈值参考（' + (threshold === undefined ? '本指标不设阈值' : String(threshold) + curveUnit(key)) + '），朱红实心点＝越过阈值的轮；τ_e 注记取自 /m2/analysis 检出值（单会话聚焦时显示）。',
          children: Spark({ points: scaled, threshold, thresholdLabel: 'S 形阈值参考（P1）', yFmt: CURVE_YFMT[key], anno, h: 200, label: curveLabel(key) }),
        }),
      )
      : createElement('div', null,
        createElement('div', { className: 'nt-wb-seg', style: { marginBottom: 10 } },
          createElement('select', { className: 'nt-select', value: metric, onChange: (e: { target: { value: string } }) => setPicked(e.target.value) },
            ...metrics.map((m) => createElement('option', { key: m, value: m }, metricLabel(m) + '（' + metricGroup(m) + '）'))),
        ),
        Panel({
          title: '本机采样曲线 · ' + (metric === '' ? '无指标' : metricLabel(metric)), fig: 'FIG.02',
          note: 'PULSE 是等间隔采样（默认 5 s 一采，桶均值聚合到最多 240 点）：与 NEXUS 轮次曲线不同，这里的时间轴均匀，斜率可读。窗口 1 小时；每 60 s 刷新一次。',
          children: metrics.length === 0
            ? Empty({ text: 'PULSE 层缺席：无指标可选（宿主内子插件未挂载）' })
            : Spark({ points: pulsePts, h: 180, label: metricLabel(metric) }),
        }),
      ),
    Panel({
      title: '三层同窗对齐', fig: 'FIG.03',
      note: 'PULSE 采样间隔与 NEXUS 轮次不同步，当前只能做「邻近对照」，不能做同窗归因——跨越这条线的任何结论都必须降级为对照措辞。',
      children: Empty({ text: 'INFER 层缺席：同窗对齐需 TTFT/provider 读数（Phase 2a）' }),
    }),
    Panel({
      title: 'era 对照集', fig: 'FIG.04',
      note: eraNote(props.era),
      children: createElement('div', { style: { fontSize: 11, color: 'var(--nt-dim,#5f5f5c)' } },
        '当前 era=' + props.era + '，措辞档位：' + eraWord(props.era) + '。窗口内轮次 ' + String(curve.length) + ' 条，会话 ' + String(sessions.length) + ' 个。'),
    }),
  )
}

// ── 视图 3：假设 ──────────────────────────────────────────────────────────────

export function HypothesesView(props: { m2: M2State | null; ann: AnnotationsState | null; analysis: AnalysisRow[] | null; vault: VaultInfo | null; onProphecy: (id: string) => void }): ReactNode {
  const status = (id: string): string => {
    const hit = props.ann?.annotations.find((a) => a.prophecy === id)
    return hit === undefined ? 'pending' : hit.status
  }
  const n = props.m2?.totals
  // M3-F.3 白盒分析的产出直接当证据位：形态分布 / τ_e 可算性 / 爆发段——不再写「需 Phase 2a」这类过期占位
  const rows = props.analysis ?? []
  const shapeCount = rows.reduce((acc: Record<string, number>, r) => { acc[r.shape] = (acc[r.shape] ?? 0) + 1; return acc }, {})
  const shapeText = Object.entries(shapeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => (SHAPE_LABEL[k] ?? k) + ' ' + String(v)).join(' · ')
  const taus = rows.map((r) => r.tauE).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b)
  const tauMedian = taus.length === 0 ? null : taus[Math.floor(taus.length / 2)]
  const roots = props.vault === null ? 0 : props.vault.known.length
  const evidence: Record<string, string> = {
    P1: n === undefined ? '待窗口读数' : '窗口命中率 ' + (n.hitRate === null ? '—' : (n.hitRate * 100).toFixed(1) + '%') + '（' + String(n.turns) + ' 轮）· 白盒形态 ' + (shapeText === '' ? '未检出' : shapeText),
    P2: props.m2 === null ? '待自评落盘' : '自评 ' + String(props.m2.selfcheck.checked) + '/' + String(props.m2.selfcheck.total),
    P3: '需逐轮自评与未命中率同轮对齐（自评覆盖 ' + String(props.m2 === null ? 0 : props.m2.selfcheck.checked) + ' 轮）',
    P4: tauMedian === null ? 'τ_e 暂不可算（需 ≥4 轮且检出形态）' : 'τ_e 可算 ' + String(taus.length) + '/' + String(rows.length) + ' 会话 · 中位 ' + String(tauMedian) + ' turn',
    P5: n === undefined || n.turns === 0 ? '待读数' : 'TPS 与未命中率的相关性待逐轮配对（当前 ' + String(n.turns) + ' 轮）',
    P6: roots <= 1 ? '需多 root 对照（已知根 ' + String(roots) + ' 个；读数按根归属，可跨根对照）' : '已知根 ' + String(roots) + ' 个，可做跨根对照',
    P7: '需 PULSE 同窗采样（间隔不同步，只能邻近对照）',
    P8: 'era=api 下显存与推理无因果通路',
    P9: '需自评覆盖率提升前后两窗口',
  }
  const analysed = rows.slice().sort((a, b) => (b.tauE ?? -1) - (a.tauE ?? -1)).slice(0, 12)
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '假设是待检验命题，不是结论。每条假设的状态由人工标注（预言视图）决定；读数只提供证据位，不自动判定。'),
    ...PROPHECY_SEED.map(([id, text]) => {
      const st = status(id)
      return createElement('div', { key: id, className: 'nt-card', onClick: () => props.onProphecy(id), style: { cursor: 'pointer' } },
        createElement('div', { className: 'hd' },
          createElement('b', null, id),
          createElement('span', { className: 'st' + (st === 'checked' ? ' on' : '') }, STATUS_LABEL[st] ?? st),
        ),
        createElement('p', null, text),
        createElement('p', { style: { color: 'var(--nt-faint,#9a9a95)', fontSize: 10.5 } }, '证据位：' + (evidence[id] ?? '—')),
      )
    }),
    Panel({
      title: '白盒分析（/m2/analysis）', fig: 'FIG.09',
      note: 'M3-F.3 白盒：形态由未命中率序列的拐点与单调性**检出**，τ_e 是探索段长度（turn）。检出不是判定——假设成立与否仍由人工标注决定（见预言视图）。',
      children: rows.length === 0
        ? Empty({ text: '分析接口无结果（窗口内会话不足 4 轮，或接口不可达）' })
        : createElement('div', null,
          createElement('table', { className: 'nt-tbl' },
            createElement('thead', null, createElement('tr', null, ...['会话', '形态', '爆发段', 'τ_e'].map((h) => createElement('th', { key: h }, h)))),
            createElement('tbody', null, ...analysed.map((r) => createElement('tr', { key: r.session },
              createElement('td', null, shortSession(r.session)),
              createElement('td', null, SHAPE_LABEL[r.shape] ?? r.shape),
              createElement('td', null, r.burst === null ? '—' : 't' + String(r.burst.fromTurn) + '→' + String(r.burst.toTurn) + '（' + (r.burst.direction === 'down' ? '降' : '升') + '）'),
              createElement('td', null, r.tauE === null ? '—' : String(r.tauE) + ' turn'),
            )))),
          createElement('p', { className: 'nt-note' }, '检出会话 ' + String(rows.length) + ' 个 · 形态分布 ' + (shapeText === '' ? '—' : shapeText) + ' · τ_e 中位 ' + (tauMedian === null ? '—' : String(tauMedian) + ' turn')),
        ),
    }),
  )
}

// ── 视图 4：预言 ──────────────────────────────────────────────────────────────

export function ProphecyView(props: { ann: AnnotationsState | null; m2: M2State | null; toast: (m: string) => void; reload: () => void }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string>('')
  const [cur, setCur] = useState<string>('P1')
  const mine = props.ann?.annotations.find((a) => a.prophecy === cur)
  const save = async (status: string): Promise<void> => {
    setBusy(cur)
    try {
      const r = await fetch('/api/nexus/m2/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prophecy: cur, status, note: note === '' ? (mine?.note ?? null) : note }),
      })
      if (!r.ok) { props.toast('标注失败：HTTP ' + String(r.status)); return }
      props.toast(cur + ' → ' + (STATUS_LABEL[status] ?? status))
      props.reload()
    } catch (e) { props.toast('标注失败：' + String(e)) } finally { setBusy(null) }
  }
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '标注是解释层：它记录人对读数的解读，永不写回读数本身（读数不可变）。标注表与 pulse 表同库，POST 是唯一写路径。'),
    Panel({
      title: '预言标注', fig: 'FIG.05',
      note: 'P1–P9 为登记在案的预言清单；状态与备注存于 nexus_ui_annotation。',
      children: createElement('div', null,
        createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          createElement('select', { className: 'nt-select', value: cur, onChange: (e: { target: { value: string } }) => { setCur(e.target.value); setNote('') } },
            ...PROPHECY_SEED.map(([id, text]) => createElement('option', { key: id, value: id }, id + ' · ' + text.slice(0, 22)))),
          createElement('span', { className: 'st', style: { fontSize: 10 } }, STATUS_LABEL[mine?.status ?? 'pending'] ?? '待标注'),
          ...['pending', 'doing', 'checked'].map((s) => createElement('button', { key: s, className: 'nt-btn', disabled: busy !== null, onClick: () => { void save(s) } }, STATUS_LABEL[s] ?? s)),
        ),
        createElement('div', { style: { marginTop: 8 } },
          createElement('textarea', {
            className: 'nt-input', style: { width: '100%', minHeight: 56, fontFamily: 'inherit' },
            placeholder: mine?.note ?? '备注（证据、反例、边界条件）',
            value: note, onChange: (e: { target: { value: string } }) => setNote(e.target.value),
          })),
        createElement('p', { className: 'nt-note' }, mine === undefined ? '当前预言尚无标注记录。' : '最近更新 ' + fmtTime(mine.updatedAt) + '：' + (mine.note ?? '（无备注）')),
      ),
    }),
    Panel({
      title: '自评证据', fig: 'FIG.06',
      note: 'record_turn_selfcheck 是每轮推理态自评（clarity/defense/declaration）；覆盖率低时 P2/P3 不可检验——此时结论只能停在「样本不足」。',
      children: props.m2 === null
        ? Empty({ text: 'M2 读数接口读取中或不可用' })
        : createElement('div', { style: { fontSize: 11.5, lineHeight: 1.7 } },
          '自评覆盖率 ' + String(props.m2.selfcheck.checked) + ' / ' + String(props.m2.selfcheck.total) + ' 轮（' +
          (props.m2.selfcheck.total === 0 ? '0' : ((props.m2.selfcheck.checked / props.m2.selfcheck.total) * 100).toFixed(0)) + '%）——' +
          (props.m2.selfcheck.total === 0 ? '窗口内无轮次，无从检验。' : props.m2.selfcheck.checked === 0 ? '尚未落盘任何自评，P2/P3 停在样本不足。' : '已可做初步配对，样本量仍小。')),
    }),
  )
}
// ── 视图 5：报告 ──────────────────────────────────────────────────────────────

export function ReportView(props: { nexus: NexusState | null; m2: M2State | null; pulse: PulseState | null; era: Era; ann: AnnotationsState | null; analysis: AnalysisRow[] | null; vault: VaultInfo | null }): ReactNode {
  const { nexus, m2, pulse, era } = props
  const n = m2?.totals
  const curve = m2?.curve ?? []
  const from = curve.length === 0 ? null : curve[0].ts
  const to = curve.length === 0 ? null : curve[curve.length - 1].ts
  const win = from === null || to === null ? '窗口内无轮次' : new Date(from).toLocaleString('zh-CN', { hour12: false }) + ' → ' + new Date(to).toLocaleString('zh-CN', { hour12: false })
  const marked = props.ann === null ? 0 : props.ann.annotations.filter((a) => a.status === 'checked').length
  const rows = props.analysis ?? []
  const shapeCount = rows.reduce((acc: Record<string, number>, r) => { acc[r.shape] = (acc[r.shape] ?? 0) + 1; return acc }, {})
  const shapeText = Object.entries(shapeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => (SHAPE_LABEL[k] ?? k) + ' ' + String(v)).join(' · ')
  const taus = rows.map((r) => r.tauE).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b)
  const tauMedian = taus.length === 0 ? null : taus[Math.floor(taus.length / 2)]
  const pointing = props.vault === null ? (nexus?.activeRoot ?? '—') : (props.vault.known.find((k) => k.root === (props.vault === null ? '' : props.vault.active))?.displayName ?? shortRoot(props.vault.active))
  const save = (name: string, text: string, mime: string): void => {
    if (typeof document === 'undefined') return
    const url = URL.createObjectURL(new Blob([text], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    // Firefox 要求锚点在文档里才触发 click 下载
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const snapshot = { generatedAt: new Date().toISOString(), era, claiming: eraWord(era), nexus, m2, pulse, annotations: props.ann, analysis: props.analysis, vault: props.vault }
  const md = [
    '# Nautilus 观测报告（中间报告）',
    '',
    '- 生成时间：' + new Date().toISOString(),
    '- era：' + era + '（措辞档位：' + eraWord(era) + '）',
    '- 观测窗口：' + win,
    '- 读数样本：' + String(curve.length) + ' 轮 / ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 会话',
    '- 层在场：NEXUS ' + (nexus === null ? '缺席' : '在场') + ' · PULSE ' + (pulse === null ? '缺席' : '在场') + ' · INFER 缺席（Phase 2a）',
    '',
    '## 一并附带的诚实边界',
    '',
    '1. 命中率绝对值受会话口径影响，偏高；它衡量的是「同窗口内被缓存复用的输入占比」，不是「知识利用率」。',
    '2. NEXUS 与 PULSE 采样不同步（轮次事件 vs 定时采样），跨层陈述只能取邻近对照，不构成同窗归因。',
    '3. 本报告的 τ_e 是白盒轮次级探索段长度（/m2/analysis 检出）；端到端时延与探索率的耦合仍需 INFER 层，故报告不含任何时延结论。',
    '4. 人工标注 ' + String(marked) + ' 条已检验；未标注项一律视为未检验，不并入结论。',
    '',
  ].join(String.fromCharCode(10))
  const gateOk = nexus !== null && pulse !== null
  return createElement('div', { className: 'nt-report' },
    createElement('div', { className: 'meta' },
      ...([
        ['生成时间', new Date().toLocaleString('zh-CN', { hour12: false })],
        ['era', era + ' · ' + eraWord(era)],
        ['观测窗口', win],
        ['读数样本', String(curve.length) + ' 轮 / ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 会话'],
        ['层在场', 'NEXUS ' + (nexus === null ? '缺席' : '在场') + ' · PULSE ' + (pulse === null ? '缺席' : '在场') + ' · INFER 缺席'],
        ['人工标注', String(marked) + ' 条已检验'],
        ['vault 指向', pointing],
        ['白盒分析', rows.length === 0 ? '无检出' : String(rows.length) + ' 会话 · ' + (shapeText === '' ? '形态未定' : shapeText) + ' · τ_e 中位 ' + (tauMedian === null ? '—' : String(tauMedian) + ' turn')],
      ] as Array<[string, string]>).flatMap(([k, v]) => [createElement('b', { key: k }, k), createElement('span', { key: k + ':v' }, v)])),
    createElement('div', { className: 'prose' },
      createElement('p', null, '一、样本与窗口。本报告覆盖 ' + String(curve.length) + ' 轮读数，来自 ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 个会话；窗口自 ' + win + '。窗口由落库轮次决定，不是人工划定的实验区间——因此任何「前后对比」都要先确认两侧样本量是否可比。'),
      createElement('p', null, '二、缓存结构。窗口内缓存命中率 ' + (n === undefined || n.hitRate === null ? '暂无读数' : (n.hitRate * 100).toFixed(1) + '%') + '（读 ' + String(n?.cacheRead ?? 0) + ' / 未命中 ' + String(n?.missToken ?? 0) + ' 令牌）。这一列最能说明「上下文是否被复用」，但它同时受长上下文与话题切换混杂；把它当作探索率的投影，而不是结论。'),
      createElement('p', null, '三、本机侧。PULSE 采集器 tick ' + String(pulse?.collector.ticks ?? 0) + ' 次，库内 ' + String(pulse?.db.rows ?? 0) + ' 行 ' + String(pulse === null ? 0 : pulse.latest.length) + ' 指标；shell=' + String(pulse?.collector.shellPath ?? '无') + '，GPU 通道 ' + (pulse?.collector.gpuOk === true ? '可用' : '不可用') + '。本机读数与云端缓存之间在 era=' + era + ' 下' + (era === 'api' ? '没有因果通路' : '存在因果通路') + '，故报告中二者只作对照。'),
      createElement('p', null, '四、白盒分析。M3-F.3 在本窗口检出 ' + String(rows.length) + ' 个会话的形态（' + (shapeText === '' ? '无' : shapeText) + '）；探索段长度 τ_e 可算 ' + String(taus.length) + ' 个，中位 ' + (tauMedian === null ? '—' : String(tauMedian) + ' turn') + '。形态与 τ_e 是**检出**，不是判定：它们只说明「曲线长这样」，是否支持某条假设仍由人工标注决定。'),
      createElement('p', null, '五、缺席与上限。报告观测的 vault 指向为 ' + pointing + '（读数按根归属，跨根不混算）。INFER 层（TTFT/provider）尚未接入，**端到端时延与探索率的耦合**无法计算；本报告的 τ_e 是白盒的轮次级探索段长度，与 INFER 条件下的时延耦合不是同一个量。据此最高结论强度为「' + eraWord(era) + '」，且限于单层内部。'),
    ),
    createElement('div', { className: 'gate' },
      createElement('span', { className: 'nt-tag' + (gateOk ? '' : ' red') }, gateOk ? '读数层齐备' : '读数层缺口'),
      createElement('span', null, '交付门：' + (gateOk ? 'NEXUS 与 PULSE 均在场，报告可作为中间报告交付；升级为正式报告需补 INFER 层与人工检验标注。' : 'NEXUS 或 PULSE 缺席，本报告仅为现场快照，不可作为阶段交付。')),
    ),
    createElement('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
      createElement('button', { className: 'nt-btn', onClick: () => save('nautilus-report.json', JSON.stringify(snapshot, null, 2), 'application/json') }, '导出 JSON 快照'),
      createElement('button', { className: 'nt-btn', onClick: () => save('nautilus-report.md', md, 'text/markdown') }, '导出 Markdown'),
      createElement('span', { style: { fontSize: 10, color: 'var(--nt-faint,#9a9a95)', alignSelf: 'center' } }, '导出为本地文件，不写回任何观测数据'),
    ),
  )
}

// ── 抽屉：单轮钻取（读数 vs 解读分层）──────────────────────────────────────────

export type DrawerTarget = { session: string; turn: number }
export type TurnText = { found: boolean; session?: string; turn?: number; userText?: string; assistantText?: string }

export function Drawer(props: { target: DrawerTarget; point: M2Point | null; onClose: () => void }): ReactNode {
  const [text, setText] = useState<TurnText | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setText(null)
    const url = '/api/nexus/m2/turn-text?session=' + encodeURIComponent(props.target.session) + '&turn=' + String(props.target.turn)
    fetch(url, { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setText(j as TurnText) })
      .catch(() => { if (alive) setText(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [props.target.session, props.target.turn])
  const p = props.point
  const miss = p === null ? null : curveValue(p, 'miss')
  const rows: Array<[string, string]> = p === null ? [] : [
    ['输入（未命中）', String(p.tokenIn)],
    ['缓存读', String(p.cacheRead)],
    ['输出', String(p.tokenOut)],
    ['未命中率', miss === null ? '—' : (miss * 100).toFixed(1) + '%'],
    ['时长', p.durationMs === null ? '—' : String(Math.round(p.durationMs)) + ' ms'],
    ['TPS', fmtNum(p.tps, 1)],
  ]
  const selfRows: Array<[string, string]> = p === null ? [] : [
    ['clarity', p.clarity === null || p.clarity === undefined ? '未落盘' : String(p.clarity)],
    ['defense', p.defense === null || p.defense === undefined ? '未落盘' : String(p.defense)],
    ['declaration', p.declaration === null || p.declaration === undefined ? '未落盘' : String(p.declaration)],
  ]
  return createElement('div', null,
    createElement('div', { className: 'nt-scrim', onClick: props.onClose }),
    createElement('div', { className: 'nt-drawer' },
      createElement('div', { className: 'dh' },
        createElement('span', null, '单轮钻取 · t' + String(props.target.turn)),
        createElement('span', { className: 'nt-tag' }, props.target.session.slice(0, 10)),
        createElement('button', { className: 'nt-btn', onClick: props.onClose }, '关闭'),
      ),
      createElement('div', { className: 'db' },
        createElement('p', { className: 'nt-note', style: { marginTop: 0 } }, '本抽屉分两层：上半是读数（客观、不可变），下半是原文与自评（解释层）。原文只读，永不写回读数。'),
        createElement('h5', null, '读数（turn_read）'),
        p === null
          ? Empty({ text: '本窗口内无该轮读数（可能已被裁剪策略清除）' })
          : createElement('table', { className: 'nt-tbl' }, createElement('tbody', null, ...rows.map(([k, v]) => createElement('tr', { key: k }, createElement('td', { style: { width: '42%', color: 'var(--nt-faint,#9a9a95)' } }, k), createElement('td', null, v))))),
        createElement('h5', null, '推理态自评（record_turn_selfcheck）'),
        selfRows.every(([, v]) => v === '未落盘')
          ? Empty({ text: '该轮未落盘自评 → P2/P3 在此轮不可检验' })
          : createElement('table', { className: 'nt-tbl' }, createElement('tbody', null, ...selfRows.map(([k, v]) => createElement('tr', { key: k }, createElement('td', { style: { width: '42%', color: 'var(--nt-faint,#9a9a95)' } }, k), createElement('td', null, v))))),
        createElement('h5', null, '完整问答（turn_text）'),
        loading
          ? Empty({ text: '读取中' })
          : text === null
            ? Empty({ text: '原文接口不可用' })
            : text.found === false
              ? Empty({ text: '该轮原文未采集（B 方案自 M3-F.2 起前向积累；此轮早于部署）' })
              : createElement('div', null,
                createElement('div', { style: { fontSize: 11, color: 'var(--nt-faint,#9a9a95)' } }, '问'),
                createElement('p', { style: { fontSize: 12, lineHeight: 1.7, margin: '2px 0 10px' } }, text.userText === undefined || text.userText === '' ? '（空）' : text.userText),
                createElement('div', { style: { fontSize: 11, color: 'var(--nt-faint,#9a9a95)' } }, '答'),
                createElement('p', { style: { fontSize: 12, lineHeight: 1.7, margin: '2px 0 0', whiteSpace: 'pre-wrap' } }, text.assistantText === undefined || text.assistantText === '' ? '（空）' : text.assistantText.slice(0, 6000)),
              ),
      ),
    ),
  )
}

// ── 根组件 ────────────────────────────────────────────────────────────────────

export type ViewKey = 'overview' | 'curve' | 'hypotheses' | 'prophecy' | 'report'
export const VIEW_LABEL: Record<ViewKey, string> = { overview: '总览', curve: '曲线', hypotheses: '假设', prophecy: '预言', report: '报告' }
export const WORKBENCH_LABEL = 'Nautilus 工作台'

/** 工作台根组件。onExitToConversation 由宿主半区注入（ctx.layout.selectPanel(null)），用于回到会话。 */
export function Workbench(props: { onExitToConversation?: () => void } = {}): ReactNode {
  injectWorkbenchStyle()
  const [view, setView] = useState<ViewKey>('overview')
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null)
  const [era, setEra] = useState<Era>('api')
  const [toast, setToast] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const paused = drawer !== null
  const nexus = useJson<NexusState>('/api/nexus/state', paused, 120000, nonce)
  const m2 = useJson<M2State>('/api/nexus/m2/state?root=all', paused, 120000, nonce)
  const pulse = useJson<PulseState>('/api/nexus/pulse/state', paused, 120000, nonce)
  const ann = useJson<AnnotationsState>('/api/nexus/m2/annotations', paused, 120000, nonce)
  // nexus 层接入（M4.3 / M4-L / M3-F.3）：指向、L 场计数、白盒分析——原先只有旧 tab 能看到
  const vault = useJson<VaultInfo>('/api/nexus/vault', paused, 120000, nonce)
  const lfield = useJson<LfieldInfo>('/api/nexus/lfield', paused, 120000, nonce)
  const analysis = useJson<AnalysisRow[]>('/api/nexus/m2/analysis?root=all', paused, 600000, nonce)
  const [rescanning, setRescanning] = useState(false)
  const onRescan = (): void => {
    setRescanning(true)
    fetch('/api/nexus/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ kind: 'rescan' }),
    })
      .then((r) => { setToast(r.ok ? '已触发全量扫描（只读核对 vault）' : '扫描触发失败：HTTP ' + String(r.status)); if (r.ok) setNonce((v) => v + 1) })
      .catch((e) => setToast('扫描触发失败：' + String(e)))
      .finally(() => setRescanning(false))
  }
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])
  const point = drawer === null || m2 === null ? null : (m2.curve.concat(m2.recent).find((p) => p.session === drawer.session && p.turn === drawer.turn) ?? null)
  const ok = (v: unknown): string => (v === null ? '缺席' : '在场')
  // 用 createElement 渲染视图组件（**不可**写成 OverviewView({...}) 直接调用）：
  // 直接调用会把子组件的 hooks 算进父组件，切换视图时 hooks 数量变化 → React 抛错、整页渲染失败。
  const body = view === 'overview' ? createElement(OverviewView, { nexus, m2, pulse, vault, lfield, rescanning, onRescan, onOpenTurn: (s: string, t: number) => setDrawer({ session: s, turn: t }) })
    : view === 'curve' ? createElement(CurveView, { m2, era, pulse, paused })
    : view === 'hypotheses' ? createElement(HypothesesView, { m2, ann, analysis, vault, onProphecy: (id: string) => { setView('prophecy'); setToast('已跳到预言标注：' + id) } })
    : view === 'prophecy' ? createElement(ProphecyView, { ann, m2, toast: setToast, reload: () => setNonce((v) => v + 1) })
    : createElement(ReportView, { nexus, m2, pulse, era, ann, analysis, vault })
  return createElement('div', { className: 'nt-wb' },
    createElement('div', { className: 'nt-wb-top' },
      props.onExitToConversation !== undefined
        ? createElement('button', { className: 'nt-btn', style: { marginRight: 2 }, onClick: () => { if (props.onExitToConversation !== undefined) props.onExitToConversation() } }, '← 返回会话')
        : null,
      createElement('div', { className: 'nt-wb-brand' }, 'NAUTILUS', createElement('small', null, 'Observation Workbench')),
      createElement('div', { className: 'nt-wb-seg' }, ...(['overview', 'curve', 'hypotheses', 'prophecy', 'report'] as ViewKey[]).map((k) => createElement('button', { key: k, className: k === view ? 'on' : '', onClick: () => setView(k) }, VIEW_LABEL[k]))),
      createElement('div', { className: 'nt-wb-right' },
        createElement('span', null, 'NEXUS ' + ok(nexus) + ' · PULSE ' + ok(pulse)),
        createElement('span', null, '刷新 ' + (pulse === null ? '—' : fmtTime(pulse.collector.lastTickTs))),
        createElement('button', { className: 'nt-btn', onClick: () => setNonce((v) => v + 1) }, '立即取数'),
      ),
    ),
    createElement('div', { className: 'nt-era' },
      createElement('span', { className: 'badge' }, 'ERA · ' + era.toUpperCase()),
      createElement('span', null, '措辞档位：' + eraWord(era) + '（' + (era === 'api' ? '弱因果' : '强因果') + '）'),
      createElement('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
        createElement('button', { className: 'nt-btn' + (era === 'api' ? ' on' : ''), onClick: () => setEra('api') }, 'api 对照'),
        createElement('button', { className: 'nt-btn' + (era === 'local' ? ' on' : ''), onClick: () => setEra('local') }, 'local 归因'),
      ),
    ),
    createElement('div', { className: 'nt-wb-body' }, createElement(ViewBoundary, { key: view, label: VIEW_LABEL[view] }, body)),
    drawer !== null ? createElement(Drawer, { target: drawer, point, onClose: () => setDrawer(null) }) : null,
    toast !== null ? createElement('div', { className: 'nt-toast' }, toast) : null,
  )
}

/** 侧栏面板图标（sidebar.panellist）：size/active 由壳提供，图标自绘。 */
export function WorkbenchIcon(props: { size?: number; active?: boolean }): ReactNode {
  const s = props.size ?? 18
  const on = props.active === true
  const stroke = on ? 'var(--nt-accent,#e6321e)' : 'currentColor'
  return createElement('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', role: 'img', 'aria-label': WORKBENCH_LABEL },
    createElement('circle', { cx: 12, cy: 12, r: 8.5, stroke, strokeWidth: 1.4, fill: on ? 'var(--nt-accent,#e6321e)' : 'none', fillOpacity: on ? 0.12 : 0 }),
    createElement('path', { d: 'M3.5 12h17M12 3.5c3 2.6 3 14.4 0 17M12 3.5c-3 2.6-3 14.4 0 17', stroke, strokeWidth: 1.1 }),
    createElement('path', { d: 'M12 12l6.5-4.2', stroke, strokeWidth: 1.4 }),
    createElement('circle', { cx: 18.5, cy: 7.8, r: 1.7, fill: 'var(--nt-accent,#e6321e)' }),
  )
}
