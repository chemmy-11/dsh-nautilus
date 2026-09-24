/**
 * @dsh-external/dsh-nautilus — 告警证据冻结（A 系列 A.2）。
 *
 * 关键澄清（决策文档 §2）：**不是新增录制**——`metric_sample` 已是 5s 原始采样、保留 14 天，
 * 越线前 lookback 窗口的数据在报警那一刻**已经在库里**。本模块做的是
 * 「按原生节奏抽取 → 压缩落盘 → 算覆盖率与指纹 → 独立保留期」，不重采样、不插值、不改库。
 *
 * 产物（每个告警一个目录，与 reports/ 分离）：
 *   <alertsRoot>/<alertId>/samples.jsonl.gz   原始行（ts/metric/value/tags），逐行 JSON、按 (ts,metric,tags) 定序
 *   <alertsRoot>/<alertId>/meta.json          窗口、覆盖率、空洞、采样档、活跃会话、行数、指纹
 *   <alertsRoot>/reports/<alertId>.md         A.3 的报告（本模块只负责目录约定）
 *
 * 覆盖率口径（可复算，不猜）：先取**去重后的时间戳**为「真实 tick」——同一 tick 会写 15 条指标，
 * 用原始行算间隔会恒为 0、空洞永远检不出（2026-09-21 实测踩到的真 bug，测试里有回归位）。
 *   cadence = distinctTs 相邻间隔的**中位数**（采样档）
 *   空洞   = 相邻间隔 > gapFactor × cadence 的那些段；missingMs = Σ(间隔 − cadence)
 *   coverage = 1 − missingMs / span
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

/** 冻结用的一行原始采样（metric_sample 的只读投影）。 */
export interface SnapshotSample {
  ts: number
  metric: string
  value: number | null
  tags: string
}

export interface SnapshotGap {
  from: number
  to: number
  gapMs: number
  missingMs: number
}

export interface CoverageReport {
  distinctTicks: number
  cadenceMs: number | null
  gaps: SnapshotGap[]
  missingMs: number
  coverage: number
}

/** 覆盖率与空洞（纯函数；去重时间戳是这里的第一原则，见文件头）。 */
export function computeCoverage(tsList: readonly number[], spanMs: number, gapFactor = 3): CoverageReport {
  const uniq = [...new Set(tsList.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b)
  if (uniq.length < 2) {
    return { distinctTicks: uniq.length, cadenceMs: null, gaps: [], missingMs: 0, coverage: uniq.length === 0 ? 0 : 1 }
  }
  const diffs: number[] = []
  for (let i = 1; i < uniq.length; i++) diffs.push(uniq[i] - uniq[i - 1])
  const sorted = [...diffs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const cadenceMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const threshold = Math.max(1, cadenceMs * gapFactor)
  const gaps: SnapshotGap[] = []
  let missingMs = 0
  for (let i = 1; i < uniq.length; i++) {
    const gapMs = uniq[i] - uniq[i - 1]
    if (gapMs > threshold) {
      const miss = gapMs - cadenceMs
      missingMs += miss
      gaps.push({ from: uniq[i - 1], to: uniq[i], gapMs, missingMs: miss })
    }
  }
  const span = Math.max(1, spanMs)
  const coverage = Math.max(0, Math.min(1, 1 - missingMs / span))
  return { distinctTicks: uniq.length, cadenceMs, gaps, missingMs, coverage }
}

/** 行 → JSONL（定序 + 稳定字段序；同样输入必得同样字节 → 指纹可复算）。 */
export function samplesToJsonl(rows: readonly SnapshotSample[]): string {
  const sorted = [...rows].sort((a, b) => (a.ts - b.ts) || (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0) || (a.tags < b.tags ? -1 : a.tags > b.tags ? 1 : 0))
  return sorted.map((r) => JSON.stringify({ ts: r.ts, metric: r.metric, value: r.value, tags: r.tags })).join('\n') + (sorted.length === 0 ? '' : '\n')
}

export interface SnapshotMeta {
  alertId: string
  ruleId: string
  metric: string
  op: string
  threshold: number
  clear: number
  from: number
  to: number
  lookbackMs: number
  rows: number
  metrics: string[]
  distinctTicks: number
  cadenceMs: number | null
  coverage: number
  missingMs: number
  gapCount: number
  maxGapMs: number
  gaps: SnapshotGap[]
  /** 窗口内有过读数的会话数（turn_read；同一库只读查询）。null = 查不到（库结构缺席）。 */
  activeSessions: number | null
  era: string
  createdAt: number
  generator: string
}

export interface FreezeResult {
  alertId: string
  dir: string
  samplesPath: string
  metaPath: string
  snapshotHash: string
  meta: SnapshotMeta
}

export interface FreezeOptions {
  root: string
  alertId: string
  ruleId: string
  metric: string
  op: string
  threshold: number
  clear: number
  from: number
  to: number
  rows: readonly SnapshotSample[]
  activeSessions: number | null
  era?: string
  now?: number
  generator?: string
}

/** 冻结一份证据：写 samples.jsonl.gz + meta.json，返回 sha256 指纹。 */
export function freezeSnapshot(opts: FreezeOptions): FreezeResult {
  const dir = join(opts.root, opts.alertId)
  mkdirSync(dir, { recursive: true })
  const jsonl = samplesToJsonl(opts.rows)
  const gz = gzipSync(Buffer.from(jsonl, 'utf8'), { level: 9 })
  const snapshotHash = createHash('sha256').update(gz).digest('hex')
  const samplesPath = join(dir, 'samples.jsonl.gz')
  writeFileSync(samplesPath, gz)
  const cov = computeCoverage(opts.rows.map((r) => r.ts), opts.to - opts.from)
  const meta: SnapshotMeta = {
    alertId: opts.alertId, ruleId: opts.ruleId, metric: opts.metric, op: opts.op,
    threshold: opts.threshold, clear: opts.clear,
    from: opts.from, to: opts.to, lookbackMs: opts.to - opts.from,
    rows: opts.rows.length,
    metrics: [...new Set(opts.rows.map((r) => r.metric))].sort(),
    distinctTicks: cov.distinctTicks, cadenceMs: cov.cadenceMs,
    coverage: cov.coverage, missingMs: cov.missingMs,
    gapCount: cov.gaps.length, maxGapMs: cov.gaps.reduce((m, g) => Math.max(m, g.gapMs), 0),
    gaps: cov.gaps, activeSessions: opts.activeSessions, era: opts.era ?? 'api',
    createdAt: opts.now ?? Date.now(),
    generator: opts.generator ?? 'nautilus/pulse/snapshot@1',
  }
  const metaPath = join(dir, 'meta.json')
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
  return { alertId: opts.alertId, dir, samplesPath, metaPath, snapshotHash, meta }
}

/** 目录名（`a-<base36(确认时刻)>-<ruleId>`）→ 确认时刻；解析不出 → null（外部放进来的目录不动它）。 */
export function alertTsFromDirName(name: string): number | null {
  const m = /^a-([0-9a-z]+)-(.+)$/.exec(name)
  if (m === null) return null
  const ts = parseInt(m[1], 36)
  return Number.isFinite(ts) && ts > 0 ? ts : null
}

/**
 * 独立保留期清理（不受 metric_sample 的 14 天影响）：删除确认时刻早于 cutoff 的快照目录 +
 * 对应的 reports/<id>.md。只碰本插件自己命名的 `a-*` 目录（红线 3：不动别人、不动既有数据）。
 * @returns 被删除的 alertId 列表。
 */
export function pruneSnapshots(root: string, cutoffTs: number): string[] {
  if (!existsSync(root)) return []
  const removed: string[] = []
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const ts = alertTsFromDirName(ent.name)
    if (ts === null || ts >= cutoffTs) continue
    try { rmSync(join(root, ent.name), { recursive: true, force: true }) } catch { continue }
    const report = join(root, 'reports', ent.name + '.md')
    if (existsSync(report)) { try { rmSync(report, { force: true }) } catch { /* 报告删不掉不影响快照已清 */ } }
    removed.push(ent.name)
  }
  return removed
}

/** 台账目录现状（诊断/证据归档用）：目录数、总字节、最老/最新确认时刻。 */
export function snapshotStats(root: string): { dirs: number; bytes: number; oldestTs: number | null; newestTs: number | null } {
  if (!existsSync(root)) return { dirs: 0, bytes: 0, oldestTs: null, newestTs: null }
  let dirs = 0; let bytes = 0; let oldest: number | null = null; let newest: number | null = null
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const ts = alertTsFromDirName(ent.name)
    if (ts === null) continue
    dirs += 1
    if (oldest === null || ts < oldest) oldest = ts
    if (newest === null || ts > newest) newest = ts
    const dir = join(root, ent.name)
    for (const f of readdirSync(dir)) {
      try { bytes += statSync(join(dir, f)).size } catch { /* 竞态：文件刚被删 */ }
    }
  }
  return { dirs, bytes, oldestTs: oldest, newestTs: newest }
}

/** 台账人读日志：ledger.md（追加式）。存在即追加，不存在则创建表头。 */
export function appendLedgerText(ledgerPath: string, text: string): void {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  const head = '# Nautilus · OS 层红线告警台账\n\n> 由 A 系列自动追加（越线确认 / 证据冻结 / 报告 / 解除 / 裁决）。\n> 结构化数据以 ~/.dsh/nautilus/nautilus.db 的 alert_event 为准，本文件只是人读日志（含报告内联副本）。\n\n'
  if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, head, 'utf8')
  let body = ''
  try { body = readFileSync(ledgerPath, 'utf8') } catch { body = head }
  writeFileSync(ledgerPath, body + text, 'utf8')
}

/** 台账一行（自动加时间戳前缀）。 */
export function appendLedger(ledgerPath: string, line: string): void {
  appendLedgerText(ledgerPath, '- `' + new Date().toISOString() + '` ' + line + '\n')
}
