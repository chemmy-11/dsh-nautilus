#!/usr/bin/env node
/**
 * @dsh-external/dsh-nautilus — A.5 阈值论证：用库里历史离线回测越线频次/持续分布。
 *
 * 判据固化（决策 D-A8）：**p99 之上、max 之下**——低于 p99 是常态不是红线，高于 max 等于没设。
 * 「纯函数同判据」：回放走 src/pulse/alerts.ts 的 AlertEngine（确认窗/滞回/冷却与线上完全相同），
 * 不在脚本里另写一套比较逻辑——两套判据是阈值论证最大的自欺来源。
 *
 * **只读**：只 SELECT metric_sample，不建表、不写任何库（红线 2/3）。
 * 需要先 `npm run build`（内核从 lib/ 取，与宿主加载的是同一份产物）。
 *
 * 用法：
 *   node scripts/alert-threshold-backtest.mjs [--db <path>] [--days 14] [--rule <id>] [--json] [--candidates]
 * 默认库：$DSH_HOME/nautilus/nautilus.db（$DSH_HOME 默认 ~/.dsh）；不存在 → 退出码 2（不猜别的库）。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AlertEngine, DEFAULT_ALERT_RULES, alertMetricExpr } from '../lib/pulse/alerts.js'

function parseArgs(argv) {
  const out = { db: '', days: 14, rule: '', json: false, candidates: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i] ?? ''
    else if (a === '--days') out.days = Number(argv[++i] ?? '14')
    else if (a === '--rule') out.rule = argv[++i] ?? ''
    else if (a === '--json') out.json = true
    else if (a === '--candidates') out.candidates = true
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0) }
    else { console.error('未知参数：' + a); printUsage(); process.exit(2) }
  }
  if (!Number.isFinite(out.days) || out.days <= 0) { console.error('--days 必须是正数'); process.exit(2) }
  return out
}

function printUsage() {
  console.log('用法：node scripts/alert-threshold-backtest.mjs [--db <path>] [--days 14] [--rule <id>] [--json] [--candidates]')
}

function defaultDb() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'nautilus', 'nautilus.db')
}

function pct(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/**
 * 回放一条规则（同判据）。
 * @returns {{ alerts:number, openedAt:number[], exceedMs:number, values:number[], thresholds:Array }}
 */
function replay(rule, groups) {
  const engine = new AlertEngine([rule])
  let alerts = 0
  let exceedMs = 0
  let prevExceedTs = null
  for (const g of groups) {
    const values = new Map()
    for (const r of g.rows) values.set(r.metric, r.value)
    const transitions = engine.observe(values, g.ts)
    for (const t of transitions) if (t.kind === 'opened') alerts += 1
    const st = engine.stateOf(rule.id)
    if (st !== undefined && st.exceeding) {
      if (prevExceedTs !== null) exceedMs += g.ts - prevExceedTs
      prevExceedTs = g.ts
    } else prevExceedTs = null
  }
  return { alerts, exceedMs }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbFile = args.db !== '' ? args.db : defaultDb()
  if (!existsSync(dbFile)) {
    console.error('库不存在：' + dbFile + '（--db 指定别的库；不猜、不回退）')
    process.exit(2)
  }
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const head = db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS oldest, MAX(ts) AS newest FROM metric_sample').get()
  if (head === null || Number(head.rows) === 0) {
    console.error('metric_sample 为空——没有可回测的历史')
    process.exit(2)
  }
  const to = Number(head.newest)
  const from = Math.max(Number(head.oldest), to - args.days * 86400000)
  const spanDays = (to - from) / 86400000
  const rules = args.rule === '' ? DEFAULT_ALERT_RULES : DEFAULT_ALERT_RULES.filter((r) => r.id === args.rule)
  if (rules.length === 0) { console.error('没有匹配的规则 id：' + args.rule); process.exit(2) }

  const outRules = []
  for (const rule of rules) {
    const metrics = rule.refMetric === '' ? [rule.metric] : [rule.metric, rule.refMetric]
    const ph = metrics.map(() => '?').join(',')
    // 只取该规则要的指标（14 天 × 15 指标 = 数百万行；按规则裁剪后每 tick 只剩 1–2 行）
    const rows = db.prepare(`SELECT ts, metric, value FROM metric_sample WHERE ts >= ? AND ts <= ? AND metric IN (${ph}) AND value IS NOT NULL ORDER BY ts ASC`).all(from, to, ...metrics)
    const groups = []
    for (const r of rows) {
      const last = groups[groups.length - 1]
      if (last !== undefined && last.ts === Number(r.ts)) last.rows.push({ metric: String(r.metric), value: Number(r.value) })
      else groups.push({ ts: Number(r.ts), rows: [{ metric: String(r.metric), value: Number(r.value) }] })
    }
    // 取值分布：只统计「可比较」的 tick（ratio 规则要求分子分母同时在）
    const series = []
    for (const g of groups) {
      const values = new Map(g.rows.map((r) => [r.metric, r.value]))
      const v = rule.refMetric === '' ? values.get(rule.metric) : (values.get(rule.metric) !== undefined && (values.get(rule.refMetric) ?? 0) > 0 ? values.get(rule.metric) / values.get(rule.refMetric) : undefined)
      if (v !== undefined && Number.isFinite(v)) series.push(v)
    }
    series.sort((a, b) => a - b)
    const base = replay(rule, groups)
    const candidates = []
    const maxV = series.length === 0 ? null : series[series.length - 1]
    if (args.candidates && maxV !== null) {
      const seen = new Set()
      for (const p of [99, 99.5, 99.9]) {
        const t = pct(series, p)
        if (t === null) continue
        const key = String(t)
        if (seen.has(key)) continue
        seen.add(key)
        const cand = { ...rule, threshold: t, clear: Math.max(0, t - (t - (pct(series, 50) ?? 0)) * 0.5) }
        if (rule.op === 'lte') continue
        const r = replay(cand, groups)
        candidates.push({ label: 'p' + String(p), threshold: t, clear: cand.clear, alerts: r.alerts, exceedMin: r.exceedMs / 60000 })
      }
    }
    outRules.push({
      id: rule.id, label: rule.label, enabled: rule.enabled, expr: alertMetricExpr(rule), op: rule.op,
      current: { threshold: rule.threshold, clear: rule.clear, forMs: rule.forMs, alerts: base.alerts, alertsPerDay: base.alerts / spanDays, exceedMin: base.exceedMs / 60000 },
      distribution: series.length === 0 ? null : {
        n: series.length, p50: pct(series, 50), p90: pct(series, 90), p99: pct(series, 99), p999: pct(series, 99.9), max: maxV,
      },
      candidates,
    })
  }
  db.close()

  const result = { db: dbFile, from, to, days: spanDays, rows: Number(head.rows), rules: outRules }
  if (args.json) { console.log(JSON.stringify(result, null, 2)); return }

  const f = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(4))
  console.log('# A.5 阈值回测（只读）')
  console.log('库：' + dbFile)
  console.log('窗口：' + new Date(from).toISOString() + ' → ' + new Date(to).toISOString() + '（' + spanDays.toFixed(2) + ' 天 · ' + String(head.rows) + ' 行原始采样）')
  console.log('判据：p99 之上、max 之下（低于 p99 是常态不是红线；高于 max 等于没设）')
  for (const r of outRules) {
    console.log('')
    console.log('## ' + r.label + '（' + r.id + '）· ' + r.expr + ' ' + r.op)
    if (r.distribution === null) { console.log('  窗口内没有可比较的采样——阈值无从论证（换机器必须重跑）'); continue }
    const d = r.distribution
    console.log('  分布：n=' + String(d.n) + ' p50=' + f(d.p50) + ' p90=' + f(d.p90) + ' p99=' + f(d.p99) + ' p99.9=' + f(d.p999) + ' max=' + f(d.max))
    console.log('  当前默认：threshold=' + f(r.current.threshold) + ' clear=' + f(r.current.clear) + ' 窗=' + String(r.current.forMs / 1000) + 's')
    console.log('  → 回测告警 ' + String(r.current.alerts) + ' 次 / ' + spanDays.toFixed(1) + ' 天（≈' + (r.current.alertsPerDay).toFixed(2) + ' 次/天）· 越线累计 ' + r.current.exceedMin.toFixed(1) + ' min')
    for (const c of r.candidates) console.log('  候选 ' + c.label + '：threshold=' + f(c.threshold) + ' clear=' + f(c.clear) + ' → ' + String(c.alerts) + ' 次（≈' + (c.alerts / spanDays).toFixed(2) + ' 次/天）')
  }
  console.log('')
  console.log('（结论与修订值记入 docs/1-planning/nautilus-os-alerting.md §6.1 D-A8；本脚本只出证据，不自动改默认值）')
}

main()
