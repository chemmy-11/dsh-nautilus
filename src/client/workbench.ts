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
import { createElement, useEffect, useState, type ReactNode } from 'react'

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
  '.nt-report{max-width:820px}',
  '.nt-report .meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11px;border:1px solid var(--nt-border,#d9d9d5);padding:10px 12px;background:var(--nt-panel2,#f7f7f5)}',
  '.nt-report .meta b{font-weight:500;color:var(--nt-faint,#9a9a95);letter-spacing:1px;text-transform:uppercase;font-size:9.5px}',
  '.nt-report .prose{font-family:Georgia,serif;font-size:13px;line-height:1.95;margin-top:12px}',
  '.nt-report .gate{margin-top:14px;border:1px solid var(--nt-accent,#e6321e);padding:10px 12px;font-size:11px;display:flex;gap:10px;align-items:center}',
  '.nt-btn{border:1px solid var(--nt-border2,#c8c8c3);background:transparent;color:var(--nt-text,#101010);font-size:11px;padding:3px 9px;cursor:pointer;border-radius:2px}',
  '.nt-btn:hover{border-color:var(--nt-text,#101010)}',
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

export type PulseState = {
  collector: { ticks: number; lastTickTs: number | null; countersOk: boolean; gpuOk: boolean; shellPath: string | null; execAvailable: boolean; lastError: string | null }
  db: { rows: number; oldestTs: number | null; newestTs: number | null; schemaVersion: number }
  latest: Array<{ metric: string; value: number | null; ts: number; tags: unknown }>
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

/** 单层曲线（SVG 自绘；点数不足 2 → 空态）。 */
export function Spark(props: { points: Array<{ x: number; y: number | null }>; h?: number; threshold?: number; label?: string }): ReactNode {
  const pts = props.points.filter((p) => p.y !== null && Number.isFinite(p.y))
  if (pts.length < 2) return Empty({ text: '暂无数据' })
  const h = props.h ?? 132
  const w = 960
  const ys = pts.map((p) => p.y as number)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  const sx = (i: number): number => (i / Math.max(1, pts.length - 1)) * (w - 48) + 34
  const sy = (v: number): number => h - 22 - ((v - min) / span) * (h - 44)
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + sx(i).toFixed(1) + ' ' + sy(p.y as number).toFixed(1)).join(' ')
  const tick = (r: number): number => min + span * r
  const kids: ReactNode[] = [createElement('path', { key: 'line', d, fill: 'none', stroke: 'var(--nt-ink,#101010)', strokeWidth: 1.5 })]
  for (const r of [0, 1 / 3, 2 / 3, 1]) {
    const y = sy(tick(r))
    kids.push(createElement('line', { key: 'g' + String(r), x1: 34, x2: w - 14, y1: y, y2: y, stroke: 'var(--nt-border,#d9d9d5)', strokeWidth: 1 }))
    kids.push(createElement('text', { key: 't' + String(r), x: 2, y: y + 3, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)' }, tick(r).toFixed(1)))
  }
  if (props.threshold !== undefined && props.threshold >= min && props.threshold <= max) {
    const y = sy(props.threshold)
    kids.push(createElement('line', { key: 'th', x1: 34, x2: w - 14, y1: y, y2: y, stroke: 'var(--nt-accent,#e6321e)', strokeWidth: 1, strokeDasharray: '5 4' }))
  }
  return createElement('svg', { viewBox: '0 0 ' + String(w) + ' ' + String(h), width: '100%', height: h, role: 'img', 'aria-label': props.label ?? 'series' }, ...kids)
}

// ── 视图 1：总览 ──────────────────────────────────────────────────────────────

export function OverviewView(props: { nexus: NexusState | null; m2: M2State | null; pulse: PulseState | null; onOpenTurn: (s: string, t: number) => void }): ReactNode {
  const { nexus, m2, pulse } = props
  const n = m2?.totals
  const hr = n?.hitRate
  const last = pulse?.collector.lastTickTs ?? null
  const lagMs = last === null ? null : Date.now() - last
  const stale = lagMs !== null && lagMs > 180000
  const rows: Array<{ layer: string; label: string; value: string; note?: string; warn?: boolean }> = [
    { layer: 'NEXUS', label: 'vault 总量', value: nexus === null ? '—' : fmtBytes(nexus.totals.totalChars) + ' / ' + String(nexus.totals.totalFiles) + ' 文件', note: nexus === null ? '读取中或接口缺席' : 'root=' + nexus.activeRoot },
    { layer: 'NEXUS', label: '今日写入', value: nexus === null ? '—' : String(nexus.today.edits) + ' 次', note: nexus === null ? '—' : '新建 ' + String(nexus.today.created) + ' · 修改 ' + String(nexus.today.modified) + ' · 删除 ' + String(nexus.today.deleted) },
    { layer: 'NEXUS', label: '窗口缓存命中率', value: hr === null || hr === undefined ? '—' : (hr * 100).toFixed(1) + '%', note: n === undefined ? '—' : '读 ' + String(n.cacheRead) + ' / 未命中 ' + String(n.missToken) + ' 令牌 · ' + String(n.turns) + ' 轮', warn: hr !== null && hr !== undefined && hr < 0.5 },
    { layer: 'PULSE', label: '采集器心跳', value: last === null ? '未采样' : fmtTime(last), note: pulse === null ? 'pulse 未装配' : 'tick ' + String(pulse.collector.ticks) + ' · 库内 ' + String(pulse.db.rows) + ' 行 · shell=' + String(pulse.collector.shellPath === null ? '无' : pulse.collector.shellPath), warn: stale },
    { layer: 'INFER', label: '推理时延 TTFT', value: '—', note: 'Phase 2a 采集（provider 侧未接入）', warn: false },
    { layer: 'INFER', label: '层间对齐度', value: '—', note: '需 INFER 落地后方可计算 τ_e', warn: false },
    { layer: 'M5', label: '预言命中', value: '—', note: 'call_p 未落库（迁移至 schema v5）', warn: false },
    { layer: 'SELF', label: '自评覆盖率', value: m2 === null ? '—' : String(m2.selfcheck.checked) + ' / ' + String(m2.selfcheck.total), note: '每轮 record_turn_selfcheck 落盘比例' },
  ]
  const recent = m2?.recent ?? []
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '读数为观测所得，非评价：本面板只呈现「发生了什么」。三层齐备前（INFER 缺席），任何跨层结论都只能用「对照」措辞。'),
    createElement('div', { className: 'nt-wb-grid' }, ...rows.map((r) => Stat({ layer: r.layer, label: r.label, value: r.value, note: r.note, warn: r.warn }))),
    Panel({
      title: '最近轮次读数', fig: 'FIG.01',
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

export function CurveView(props: { m2: M2State | null; era: Era }): ReactNode {
  const [key, setKey] = useState<CurveKey>('miss')
  const [scope, setScope] = useState<string>('all')
  const curve = props.m2?.curve ?? []
  const sessions = Array.from(new Set(curve.map((p) => p.session)))
  const scoped = scope === 'all' ? curve : curve.filter((p) => p.session === scope)
  const pts = scoped.map((p) => ({ x: p.ts, y: curveValue(p, key) }))
  const scaled = key === 'miss' ? pts.map((p) => ({ x: p.x, y: p.y === null ? null : p.y * 100 })) : pts
  const threshold = key === 'miss' ? 50 : undefined
  return createElement('div', null,
    createElement('div', { className: 'nt-wb-seg', style: { marginBottom: 10 } },
      ...(['miss', 'ms', 'tps'] as CurveKey[]).map((k) => createElement('button', { key: k, className: k === key ? 'on' : '', onClick: () => setKey(k) }, curveLabel(k))),
      createElement('span', { style: { width: 12 } }),
      createElement('button', { className: scope === 'all' ? 'on' : '', onClick: () => setScope('all') }, '全会话'),
      ...sessions.slice(0, 6).map((s) => createElement('button', { key: s, className: s === scope ? 'on' : '', onClick: () => setScope(s) }, s.slice(0, 8))),
    ),
    Panel({
      title: curveLabel(key) + ' 时序曲线', fig: 'FIG.02',
      note: '时间轴为记录时间戳（非等间隔）：轮次并非均匀采样，曲线的斜率不代表速率；阈值线 ' + (threshold === undefined ? '本指标不设阈值' : String(threshold) + curveUnit(key) + ' 为参考线') + '。',
      children: Spark({ points: scaled, threshold, label: curveLabel(key) }),
    }),
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

export function HypothesesView(props: { m2: M2State | null; ann: AnnotationsState | null; onProphecy: (id: string) => void }): ReactNode {
  const status = (id: string): string => {
    const hit = props.ann?.annotations.find((a) => a.prophecy === id)
    return hit === undefined ? 'pending' : hit.status
  }
  const n = props.m2?.totals
  const evidence: Record<string, string> = {
    P1: n === undefined ? '待窗口读数' : '窗口命中率 ' + (n.hitRate === null ? '—' : (n.hitRate * 100).toFixed(1) + '%') + '（' + String(n.turns) + ' 轮）',
    P2: props.m2 === null ? '待自评落盘' : '自评 ' + String(props.m2.selfcheck.checked) + '/' + String(props.m2.selfcheck.total),
    P3: '需逐轮自评与未命中率同轮对齐',
    P4: '需会话时长 τ_e（Phase 2a 计算）',
    P5: n === undefined || n.turns === 0 ? '待读数' : 'TPS 与未命中率的相关性待逐轮配对',
    P6: '需多 root 对照（当前单 root）',
    P7: '需 PULSE 同窗采样（间隔不同步）',
    P8: 'era=api 下显存与推理无因果通路',
    P9: '需自评覆盖率提升前后两窗口',
  }
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

export function ReportView(props: { nexus: NexusState | null; m2: M2State | null; pulse: PulseState | null; era: Era; ann: AnnotationsState | null }): ReactNode {
  const { nexus, m2, pulse, era } = props
  const n = m2?.totals
  const curve = m2?.curve ?? []
  const from = curve.length === 0 ? null : curve[0].ts
  const to = curve.length === 0 ? null : curve[curve.length - 1].ts
  const win = from === null || to === null ? '窗口内无轮次' : new Date(from).toLocaleString('zh-CN', { hour12: false }) + ' → ' + new Date(to).toLocaleString('zh-CN', { hour12: false })
  const marked = props.ann === null ? 0 : props.ann.annotations.filter((a) => a.status === 'checked').length
  const save = (name: string, text: string, mime: string): void => {
    if (typeof document === 'undefined') return
    const url = URL.createObjectURL(new Blob([text], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
  const snapshot = { generatedAt: new Date().toISOString(), era, claiming: eraWord(era), nexus, m2, pulse, annotations: props.ann }
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
    '3. INFER 层缺失时无法计算 τ_e（端到端时延与探索率的耦合），本报告不含任何时延结论。',
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
      ] as Array<[string, string]>).flatMap(([k, v]) => [createElement('b', { key: k }, k), createElement('span', { key: k + ':v' }, v)])),
    createElement('div', { className: 'prose' },
      createElement('p', null, '一、样本与窗口。本报告覆盖 ' + String(curve.length) + ' 轮读数，来自 ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 个会话；窗口自 ' + win + '。窗口由落库轮次决定，不是人工划定的实验区间——因此任何「前后对比」都要先确认两侧样本量是否可比。'),
      createElement('p', null, '二、缓存结构。窗口内缓存命中率 ' + (n === undefined || n.hitRate === null ? '暂无读数' : (n.hitRate * 100).toFixed(1) + '%') + '（读 ' + String(n?.cacheRead ?? 0) + ' / 未命中 ' + String(n?.missToken ?? 0) + ' 令牌）。这一列最能说明「上下文是否被复用」，但它同时受长上下文与话题切换混杂；把它当作探索率的投影，而不是结论。'),
      createElement('p', null, '三、本机侧。PULSE 采集器 tick ' + String(pulse?.collector.ticks ?? 0) + ' 次，库内 ' + String(pulse?.db.rows ?? 0) + ' 行 ' + String(pulse === null ? 0 : pulse.latest.length) + ' 指标；shell=' + String(pulse?.collector.shellPath ?? '无') + '，GPU 通道 ' + (pulse?.collector.gpuOk === true ? '可用' : '不可用') + '。本机读数与云端缓存之间在 era=' + era + ' 下' + (era === 'api' ? '没有因果通路' : '存在因果通路') + '，故报告中二者只作对照。'),
      createElement('p', null, '四、缺席与上限。INFER 层（TTFT/provider）尚未接入，三层同窗对齐与 τ_e 均无法计算。据此，本报告的最高结论强度为「' + eraWord(era) + '」，且限于单层内部。'),
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

export function Workbench(): ReactNode {
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
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])
  const point = drawer === null || m2 === null ? null : (m2.curve.concat(m2.recent).find((p) => p.session === drawer.session && p.turn === drawer.turn) ?? null)
  const ok = (v: unknown): string => (v === null ? '缺席' : '在场')
  const body = view === 'overview' ? OverviewView({ nexus, m2, pulse, onOpenTurn: (s, t) => setDrawer({ session: s, turn: t }) })
    : view === 'curve' ? CurveView({ m2, era })
    : view === 'hypotheses' ? HypothesesView({ m2, ann, onProphecy: (id) => { setView('prophecy'); setToast('已跳到预言标注：' + id) } })
    : view === 'prophecy' ? ProphecyView({ ann, m2, toast: setToast, reload: () => setNonce((v) => v + 1) })
    : ReportView({ nexus, m2, pulse, era, ann })
  return createElement('div', { className: 'nt-wb' },
    createElement('div', { className: 'nt-wb-top' },
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
        createElement('button', { className: 'nt-btn' + (era === 'api' ? '' : ''), onClick: () => setEra('api') }, 'api 对照'),
        createElement('button', { className: 'nt-btn', onClick: () => setEra('local') }, 'local 归因'),
      ),
    ),
    createElement('div', { className: 'nt-wb-body' }, body),
    drawer !== null ? Drawer({ target: drawer, point, onClose: () => setDrawer(null) }) : null,
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
