/**
 * @dsh-external/dsh-nautilus — A 系列（OS 层红线告警）客户端半区。
 *
 * 入口三件（D-A4 裁决后收敛）：① 侧栏图标「活跃即闪红」+ 未裁决徽标；② 工作台「告警」视图（台账 + 规则运行态）；
 * ③ 报告查看入口（报告在磁盘，UI 只读）与人工裁决（真阳性/假阳性/未知，不设审批门）。
 *
 * 契约：GET /api/nautilus/pulse/alerts · POST /pulse/alerts/verdict · GET /pulse/alerts/report?id=
 * 纪律同 UI 线：零新依赖、自绘 SVG、样式走组件内 <style> 一次注入、class 前缀 `nt-`、--nt-* 令牌。
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'

// ── 数据面类型（只取用到的字段）─────────────────────────────────────────────────

export type AlertVerdict = 'true-positive' | 'false-positive' | 'unknown'

export interface AlertRuleState {
  id: string
  label: string
  enabled: boolean
  metric: string
  refMetric: string
  expr: string
  op: 'gte' | 'lte'
  threshold: number
  clear: number
  forMs: number
  cooldownMs: number
  state: {
    exceeding: boolean
    open: boolean
    firstExceededAt: number | null
    confirmedAt: number | null
    alertId: string | null
    peak: number | null
    lastValue: number | null
    lastTs: number | null
    skippedTicks: number
  } | null
}

export interface AlertRow {
  id: string
  ruleId: string
  metric: string
  op: 'gte' | 'lte'
  threshold: number
  firstExceededAt: number
  confirmedAt: number
  clearedAt: number | null
  peakValue: number | null
  durationMs: number | null
  snapshotPath: string | null
  snapshotHash: string | null
  reportStatus: 'pending' | 'done' | 'skipped' | 'failed'
  reportModel: string | null
  promptVersion: string | null
  humanVerdict: AlertVerdict | null
  note: string | null
  createdAt: number
}

export interface AlertsState {
  revision: number
  enabled: boolean
  counts: { open: number; total: number; last24h: number; rules: number; rulesEnabled: number }
  rules: AlertRuleState[]
  active: AlertRow[]
  recent: AlertRow[]
  evidence: { dirs: number; bytes: number; oldestTs: number | null; newestTs: number | null } | null
  reportsDir: string | null
}

export interface AlertBadge {
  active: number
  unjudged: number
  enabled: boolean
}

/** 徽标数值（纯函数；SSR/测试可直接调）。 */
export function alertBadgeOf(state: AlertsState | null): AlertBadge {
  if (state === null) return { active: 0, unjudged: 0, enabled: false }
  // 未裁决数只数台账行（recent）并按 id 去重——active 是同一批行的子集，重复计数会虚高
  const seen = new Set<string>()
  let unjudged = 0
  for (const r of state.recent ?? []) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (r.humanVerdict === null && r.reportStatus !== 'pending') unjudged += 1
  }
  return { active: state.active?.length ?? 0, unjudged, enabled: state.enabled === true }
}

export const VERDICT_LABEL: Record<AlertVerdict, string> = {
  'true-positive': '真阳性',
  'false-positive': '假阳性',
  unknown: '未知',
}

export const REPORT_STATUS_LABEL: Record<AlertRow['reportStatus'], string> = {
  pending: '报告待做',
  done: '报告已成文',
  skipped: '报告未调用模型',
  failed: '报告失败',
}

// ── 取数与动作 ────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch { return null }
}

export async function postVerdict(id: string, verdict: AlertVerdict, note: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const r = await fetch('/api/nautilus/pulse/alerts/verdict', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ id, verdict, note: note.trim() === '' ? null : note.trim() }),
    })
    const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!r.ok || j === null || j.ok !== true) {
      const code = j?.error ?? ''
      const human = code === 'unknown-alert' ? '台账里没有这条告警' : 'HTTP ' + String(r.status) + (code === '' ? '' : ' · ' + code)
      return { ok: false, msg: '裁决失败：' + human }
    }
    return { ok: true, msg: '裁决已记：' + VERDICT_LABEL[verdict] }
  } catch (e) {
    return { ok: false, msg: '裁决失败：' + String(e) }
  }
}

export async function fetchReport(id: string): Promise<{ ok: boolean; msg: string; path?: string; markdown?: string }> {
  const j = await getJson<{ ok?: boolean; path?: string; markdown?: string; error?: string }>('/api/nautilus/pulse/alerts/report?id=' + encodeURIComponent(id))
  if (j === null || j.ok !== true) return { ok: false, msg: '报告读取失败（可能尚未成文）' }
  return { ok: true, msg: '', path: j.path, markdown: j.markdown ?? '' }
}

/**
 * 图标徽标轮询（A.4「活跃即闪红」的数据源）。
 * 只做一次轻量读取（limit=20），失败保持上一份——观测面缺席不编数。
 */
export function useAlertBadge(intervalMs = 5000): AlertBadge {
  const [badge, setBadge] = useState<AlertBadge>({ active: 0, unjudged: 0, enabled: false })
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const j = await getJson<AlertsState>('/api/nautilus/pulse/alerts?limit=20')
      if (alive && j !== null) setBadge(alertBadgeOf(j))
    }
    void load()
    const t = intervalMs > 0 ? setInterval(() => { void load() }, intervalMs) : null
    return () => { alive = false; if (t !== null) clearInterval(t) }
  }, [intervalMs])
  return badge
}

// ── 样式（一次注入；前缀 nt-al*）──────────────────────────────────────────────

let styleDone = false
const ALERT_CSS = [
  '.nt-al{display:flex;flex-direction:column;gap:12px}',
  '.nt-al-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10px;letter-spacing:1.5px;color:var(--nt-dim,#5f5f5c);text-transform:uppercase}',
  '.nt-al-chip{border:1px solid var(--nt-border,#d9d9d5);padding:1px 6px;font-size:10px;letter-spacing:1px}',
  '.nt-al-chip.red{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-al-chip.grey{color:var(--nt-faint,#9a9a95)}',
  '.nt-al-state{font-variant-numeric:tabular-nums}',
  '.nt-al-state.hot{color:var(--nt-accent,#e6321e)}',
  '.nt-al-verdict{display:flex;gap:4px;align-items:center;flex-wrap:wrap}',
  '.nt-al-verdict input{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);color:inherit;font-size:11px;padding:2px 5px;min-width:150px}',
  '.nt-al-report{margin:0;padding:10px 12px;border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel2,#f7f7f5);font-size:11px;line-height:1.6;white-space:pre-wrap;max-height:46vh;overflow:auto}',
  '.nt-al-report-head{display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:1px;color:var(--nt-faint,#9a9a95);margin-bottom:6px}',
  '.nt-icon-alert{animation:nt-al-flash 1.1s steps(1,end) infinite}',
  '@keyframes nt-al-flash{0%,55%{opacity:1}56%,100%{opacity:.22}}',
  '.nt-al-off{opacity:.5}',
]
/** 让图标也能用到闪红样式（图标与视图可能各自先渲染）。 */
export function ensureAlertStyle(): void { injectAlertStyle() }

function injectAlertStyle(): void {
  if (styleDone || typeof document === 'undefined') return
  styleDone = true
  const el = document.createElement('style')
  el.id = 'nt-alert-style'
  el.textContent = ALERT_CSS.join(String.fromCharCode(10))
  document.head.appendChild(el)
}

// ── 展示工具 ──────────────────────────────────────────────────────────────────

const fmtTime = (ts: number | null | undefined): string => ts === null || ts === undefined ? '—' : new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
const fmtDur = (ms: number | null): string => ms === null ? '—' : ms >= 60000 ? (ms / 60000).toFixed(1) + ' min' : Math.round(ms / 1000) + ' s'
const fmtNum = (v: number | null | undefined): string => v === null || v === undefined || !Number.isFinite(v) ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(4).replace(/0+$/, ''))

/** 判据一句话（阈值/解除线/确认窗/冷却）。 */
export function ruleText(r: AlertRuleState): string {
  return r.expr + ' ' + r.op + ' ' + String(r.threshold) + ' / 解除 ' + String(r.clear) +
    ' · 窗 ' + String(Math.round(r.forMs / 1000)) + 's' + (r.cooldownMs > 0 ? ' · 冷却 ' + String(Math.round(r.cooldownMs / 1000)) + 's' : '')
}

// ── 视图 ──────────────────────────────────────────────────────────────────────

export interface AlertsViewProps {
  state: AlertsState | null
  toast: (m: string) => void
  reload: () => void
}

export function AlertsView(props: AlertsViewProps): ReactNode {
  injectAlertStyle()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [report, setReport] = useState<{ id: string; path: string; markdown: string } | null>(null)
  const s = props.state
  if (s === null) return createElement('div', { className: 'nt-empty' }, '告警能力缺席（pulse 未挂载或路由 503）')

  const judge = (id: string, verdict: AlertVerdict): void => {
    if (busy !== null) return
    setBusy(id)
    void postVerdict(id, verdict, note).then((r) => {
      props.toast(r.msg)
      if (r.ok) { setNote(''); props.reload() }
    }).finally(() => setBusy(null))
  }
  const openReport = (id: string): void => {
    void fetchReport(id).then((r) => {
      if (!r.ok) { props.toast(r.msg); return }
      setReport({ id, path: r.path ?? '', markdown: r.markdown ?? '' })
    })
  }

  const rules = createElement('div', { className: 'nt-panel' },
    createElement('h4', null, '规则表', createElement('em', null, s.counts.rulesEnabled + '/' + s.counts.rules + ' 启用 · ' + (s.enabled ? '检测中' : '总开关关'))),
    createElement('div', { className: 'body' },
      createElement('table', { className: 'nt-tbl' },
        createElement('thead', null, createElement('tr', null,
          ...['规则', '判据', '当前值', '运行态', '连续段起点'].map((h) => createElement('th', { key: h }, h)))),
        createElement('tbody', null, ...s.rules.map((r) => {
          const st = r.state
          const hot = st !== null && st.open
          return createElement('tr', { key: r.id, className: r.enabled ? '' : 'nt-al-off' },
            createElement('td', null, r.label, createElement('div', { className: 'nt-tag' }, r.id)),
            createElement('td', null, ruleText(r)),
            createElement('td', null, createElement('span', { className: 'nt-al-state' + (hot ? ' hot' : '') }, fmtNum(st?.lastValue ?? null))),
            createElement('td', null, r.enabled
              ? createElement('span', { className: 'nt-tag' + (hot ? ' red' : '') }, hot ? '活跃' : (st?.exceeding === true ? '越线计时中' : '正常'))
              : createElement('span', { className: 'nt-tag' }, '已停用')),
            createElement('td', null, st?.firstExceededAt === null || st === null ? '—' : fmtTime(st.firstExceededAt)))
        })),
      ),
    ),
  )

  const rowActions = (a: AlertRow): ReactNode => createElement('div', { className: 'nt-al-verdict' },
    ...(['true-positive', 'false-positive', 'unknown'] as AlertVerdict[]).map((v) => createElement('button', {
      key: v,
      className: 'nt-btn' + (a.humanVerdict === v ? ' on' : ''),
      disabled: busy !== null,
      onClick: () => judge(a.id, v),
    }, VERDICT_LABEL[v])),
    createElement('input', {
      placeholder: '备注（可选，≤500 字）',
      value: note,
      onChange: (e: { target: { value: string } }) => setNote(e.target.value),
    }),
    a.reportStatus === 'pending'
      ? createElement('span', { className: 'nt-tag' }, '报告生成中')
      : createElement('button', { className: 'nt-btn', onClick: () => openReport(a.id) }, '查看报告'),
  )

  const table = (rows: AlertRow[], empty: string): ReactNode => rows.length === 0
    ? createElement('div', { className: 'nt-empty' }, empty)
    : createElement('table', { className: 'nt-tbl' },
      createElement('thead', null, createElement('tr', null,
        ...['确认时刻', '规则', '峰值', '持续 / 解除', '证据', '报告', '裁决', '操作'].map((h) => createElement('th', { key: h }, h)))),
      createElement('tbody', null, ...rows.map((a) => createElement('tr', { key: a.id },
        createElement('td', null, fmtTime(a.confirmedAt), createElement('div', { className: 'nt-tag' }, a.id)),
        createElement('td', null, a.ruleId),
        createElement('td', null, fmtNum(a.peakValue)),
        createElement('td', null, a.clearedAt === null ? createElement('span', { className: 'nt-tag red' }, '未解除') : fmtDur(a.durationMs)),
        createElement('td', null, a.snapshotHash === null ? '—' : createElement('span', { className: 'nt-tag', title: a.snapshotPath ?? '' }, String(a.snapshotHash).slice(0, 10))),
        createElement('td', null,
          createElement('span', { className: 'nt-tag' + (a.reportStatus === 'failed' ? ' red' : '') }, REPORT_STATUS_LABEL[a.reportStatus] + (a.reportModel === null ? '' : ' · ' + a.reportModel)),
          // 模板版本随报告一起显示：换模板后新旧报告不混算，人眼能直接分辨
          a.promptVersion === null ? null : createElement('div', { className: 'nt-tag', title: '报告模板版本' }, a.promptVersion)),
        createElement('td', null, a.humanVerdict === null ? createElement('span', { className: 'nt-tag' }, '未裁决') : createElement('span', { className: 'nt-tag' }, VERDICT_LABEL[a.humanVerdict])),
        createElement('td', null, rowActions(a)),
      ))),
    )

  const evidence = s.evidence === null || s.evidence === undefined
    ? null
    : createElement('span', { className: 'nt-al-chip grey' }, '证据 ' + String(s.evidence.dirs) + ' 份 / ' + (s.evidence.bytes / 1024).toFixed(0) + ' KB' + (s.reportsDir === null ? '' : ' · ' + s.reportsDir))

  return createElement('div', { className: 'nt-al' },
    createElement('div', { className: 'nt-al-bar' },
      createElement('span', { className: 'nt-al-chip' + (s.counts.open > 0 ? ' red' : '') }, '活跃 ' + String(s.counts.open)),
      createElement('span', { className: 'nt-al-chip' }, '近 24h ' + String(s.counts.last24h)),
      createElement('span', { className: 'nt-al-chip' }, '累计 ' + String(s.counts.total)),
      s.enabled ? null : createElement('span', { className: 'nt-al-chip red' }, '总开关已关（不检测、不收口台账）'),
      evidence,
      createElement('span', { className: 'nt-al-chip grey' }, '裁决只做事后标注，不设审批门'),
    ),
    createElement('div', { className: 'nt-panel' },
      createElement('h4', null, '活跃告警', createElement('em', null, '确认后未解除')),
      createElement('div', { className: 'body' }, table(s.active, '当前无未解除告警')),
    ),
    report === null ? null : createElement('div', { className: 'nt-panel' },
      createElement('h4', null, '报告 · ' + report.id,
        createElement('button', { className: 'nt-btn', style: { marginLeft: 'auto' }, onClick: () => setReport(null) }, '关闭')),
      createElement('div', { className: 'body' },
        createElement('div', { className: 'nt-al-report-head' }, report.path),
        createElement('pre', { className: 'nt-al-report' }, report.markdown),
      ),
    ),
    createElement('div', { className: 'nt-panel' },
      createElement('h4', null, '告警台账', createElement('em', null, '结构化数据在 alert_event；本表取最近 50 条')),
      createElement('div', { className: 'body' }, table(s.recent, '台账为空（还没有越线确认）')),
    ),
    rules,
  )
}
