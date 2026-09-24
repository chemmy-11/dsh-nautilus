/**
 * @dsh-external/dsh-nautilus — pulse 存储层（`metric_sample`，上游 §4.3）。
 *
 * 与 nautilus **同库不同表**（`~/.dsh/nautilus/nautilus.db`）：pulse 只建自己的采样长表，不碰 turn 系表。
 *
 * 迁移：`user_version 3 → 4`。**只在库已到 v3 时推进版本**——若库仍停在 v<3（nautilus 还没迁移），
 * 本层只做幂等建表、不推进版本：`user_version` 是全库共享序列，抢先写 4 会让 nautilus 的 v1–v3
 * 迁移被永久跳过。等 nautilus 迁到 v3 后的下一次启动，pulse 再补上版本推进。
 * （M5 设计文档原预留 v4 给 `call_p`——现由本层占用 v4，M5 顺延为 v5，已记在开发文档里。）
 *
 * 两个连接同库并发：开 WAL + busy_timeout，读写不互相阻塞。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Sample } from './collect.js'

/** 本层的 schema 版本（metric_sample 引入于 v4）。 */
export const SCHEMA_VERSION = 4

export interface SampleRow {
  ts: number
  metric: string
  value: number
  tags: string
}

export interface PulseStatus {
  rows: number
  oldestTs: number | null
  newestTs: number | null
  metrics: Array<{ metric: string; rows: number; lastTs: number }>
  schemaVersion: number
}

/**
 * `alert_event` 的建表 DDL（A 系列 v7）。**单一定义处**：主库的 v7 迁移与本层构造函数共用同一份文本，
 * 避免「迁移里一份、建表里一份」漂移。DDL 逐字对齐 2026-09-21 原实现在真库中留下的 schema
 * （从 `.dsh-next/nautilus/nautilus.db` 的 sqlite_master 回收，见 E25 重建注记）。
 */
export const ALERT_EVENT_DDL = `
      CREATE TABLE IF NOT EXISTS alert_event (
        id                TEXT PRIMARY KEY,
        rule_id           TEXT NOT NULL,
        metric            TEXT NOT NULL,
        op                TEXT NOT NULL CHECK (op IN ('gte','lte')),
        threshold         REAL NOT NULL,
        first_exceeded_at INTEGER NOT NULL,
        confirmed_at      INTEGER NOT NULL,
        cleared_at        INTEGER,
        peak_value        REAL,
        duration_ms       INTEGER,
        snapshot_path     TEXT,
        snapshot_hash     TEXT,
        report_status     TEXT NOT NULL DEFAULT 'skipped' CHECK (report_status IN ('pending','done','skipped','failed')),
        report_model      TEXT,
        prompt_version    TEXT,
        ack_at            INTEGER,
        human_verdict     TEXT CHECK (human_verdict IN ('true-positive','false-positive','unknown')),
        note              TEXT,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_alert_open ON alert_event(cleared_at, confirmed_at);
      CREATE INDEX IF NOT EXISTS ix_alert_rule ON alert_event(rule_id, confirmed_at);
    `

/** 台账行（读侧口径；供路由与 UI 直接用）。 */
export interface AlertEventRow {
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
  humanVerdict: 'true-positive' | 'false-positive' | 'unknown' | null
  note: string | null
  createdAt: number
}

export function openPulseStore(dbFile: string): PulseStore {
  mkdirSync(dirname(dbFile), { recursive: true })
  return new PulseStore(dbFile)
}

export class PulseStore {
  private readonly db: DatabaseSync
  constructor(dbFile: string) {
    this.db = new DatabaseSync(dbFile)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 3000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metric_sample (
        ts      INTEGER NOT NULL,
        layer   TEXT    NOT NULL,
        metric  TEXT    NOT NULL,
        value   REAL,
        tags    TEXT,
        era     TEXT    NOT NULL DEFAULT 'api'
      );
      CREATE INDEX IF NOT EXISTS idx_sample_q ON metric_sample(metric, ts);
      CREATE INDEX IF NOT EXISTS idx_sample_ts ON metric_sample(ts);
    `)
    // 告警台账：幂等建表**不抢版本**（user_version 由主库的 v7 迁移推进；本层独立挂载也能自愈）
    this.db.exec(ALERT_EVENT_DDL)
    this.migrate()
  }

  /** 幂等迁移：建表已在上方完成，这里只负责版本推进（见文件头）。 */
  private migrate(): void {
    const v = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0)
    if (v === SCHEMA_VERSION || v > SCHEMA_VERSION) return
    if (v === SCHEMA_VERSION - 1) {
      this.db.exec('PRAGMA user_version = ' + SCHEMA_VERSION)
      return
    }
    console.warn('[pulse] schema 版本 ' + v + ' < v' + (SCHEMA_VERSION - 1) + '：只建表、暂不推进版本（等 nautilus 迁移到 v' + (SCHEMA_VERSION - 1) + '）')
  }

  schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0)
  }

  /** 批量落库（单事务；layer 由调用方给出，era 默认 'api'——§4.4 的 era 由 core 后续驱动）。 */
  insert(ts: number, layer: string, samples: Sample[], era = 'api'): number {
    if (samples.length === 0) return 0
    const stmt = this.db.prepare('INSERT INTO metric_sample (ts, layer, metric, value, tags, era) VALUES (?, ?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const s of samples) stmt.run(ts, layer, s.metric, s.value, JSON.stringify(s.tags ?? {}), era)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return samples.length
  }

  /** 每个指标的最新一条。 */
  latest(): Array<{ metric: string; value: number | null; ts: number; tags: string }> {
    return this.db.prepare(`
      SELECT metric, value, ts, tags FROM (
        SELECT metric, value, ts, tags, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY ts DESC) AS rn
        FROM metric_sample
      ) WHERE rn = 1 ORDER BY metric
    `).all() as Array<{ metric: string; value: number | null; ts: number; tags: string }>
  }

  /** 单指标时间序列（按桶取均值；桶宽由 maxPoints 推得，保证点数 ≤ maxPoints）。 */
  series(metric: string, from: number, to: number, maxPoints = 600): Array<{ ts: number; value: number; n: number }> {
    const span = Math.max(1, to - from)
    const bucket = Math.max(1, Math.ceil(span / Math.max(1, maxPoints)))
    return this.db.prepare(`
      SELECT CAST(ts / ? AS INTEGER) * ? AS ts, AVG(value) AS value, COUNT(*) AS n
      FROM metric_sample
      WHERE metric = ? AND ts >= ? AND ts <= ? AND value IS NOT NULL
      GROUP BY CAST(ts / ? AS INTEGER)
      ORDER BY ts
    `).all(bucket, bucket, metric, from, to, bucket) as Array<{ ts: number; value: number; n: number }>
  }

  status(): PulseStatus {
    const head = this.db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS oldest, MAX(ts) AS newest FROM metric_sample').get() as { rows: number; oldest: number | null; newest: number | null }
    const metrics = this.db.prepare('SELECT metric, COUNT(*) AS rows, MAX(ts) AS lastTs FROM metric_sample GROUP BY metric ORDER BY metric').all() as Array<{ metric: string; rows: number; lastTs: number }>
    return { rows: Number(head.rows ?? 0), oldestTs: head.oldest ?? null, newestTs: head.newest ?? null, metrics, schemaVersion: this.schemaVersion() }
  }

  /** 保留策略（§4.3）：删掉早于 cutoff 的原始采样；返回删除行数。 */
  prune(cutoffTs: number): number {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM metric_sample').get() as { n: number }
    this.db.prepare('DELETE FROM metric_sample WHERE ts < ?').run(cutoffTs)
    const after = this.db.prepare('SELECT COUNT(*) AS n FROM metric_sample').get() as { n: number }
    return Number(before.n) - Number(after.n)
  }

  // ── A 系列：告警台账（alert_event；schema v7）────────────────────────────────
  // 写侧只有两处：确认那一刻 insertAlert，解除那一刻 closeAlert。其余列由 A.2/A.3/A.4 分步补写。

  /** 落一条「已确认」告警。同一 id 重复写入 = 幂等忽略（重放/重启不乱台账）。 */
  insertAlert(row: {
    id: string; ruleId: string; metric: string; op: 'gte' | 'lte'; threshold: number
    firstExceededAt: number; confirmedAt: number; peakValue: number | null
    snapshotPath?: string | null; snapshotHash?: string | null
    reportStatus?: 'pending' | 'done' | 'skipped' | 'failed'; createdAt: number
  }): 'inserted' | 'duplicate' {
    const hit = this.db.prepare('SELECT 1 AS x FROM alert_event WHERE id = ?').get(row.id)
    if (hit !== undefined) return 'duplicate'
    this.db.prepare(`
      INSERT INTO alert_event
        (id, rule_id, metric, op, threshold, first_exceeded_at, confirmed_at, cleared_at, peak_value,
         duration_ms, snapshot_path, snapshot_hash, report_status, report_model, prompt_version,
         ack_at, human_verdict, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
    `).run(
      row.id, row.ruleId, row.metric, row.op, row.threshold, row.firstExceededAt, row.confirmedAt,
      row.peakValue, row.snapshotPath ?? null, row.snapshotHash ?? null, row.reportStatus ?? 'skipped', row.createdAt,
    )
    return 'inserted'
  }

  /** 解除（幂等）：只在未解除时写 cleared_at 与 duration_ms。@returns 是否本次真的收口。 */
  closeAlert(id: string, ts: number): boolean {
    const r = this.db.prepare(`
      UPDATE alert_event SET cleared_at = ?, duration_ms = MAX(0, ? - confirmed_at)
      WHERE id = ? AND cleared_at IS NULL
    `).run(ts, ts, id)
    return Number(r.changes) > 0
  }

  /** 未解除行（按确认时刻升序）。 */
  openAlerts(): AlertEventRow[] {
    return this.rowsToAlerts(this.db.prepare('SELECT * FROM alert_event WHERE cleared_at IS NULL ORDER BY confirmed_at ASC').all())
  }

  /**
   * 启动自愈：把上个进程遗留的未解除行收口。重启后内存里的连续段与峰值都不可考，
   * 让台账挂着「还活着」是不诚实的——收口成一条有始有终的历史记录，需要时由新一轮越线重新确认。
   * @returns 被收口的 id 列表。
   */
  closeStaleAlerts(ts: number): string[] {
    const open = this.openAlerts()
    const closed: string[] = []
    for (const row of open) { if (this.closeAlert(row.id, ts)) closed.push(row.id) }
    return closed
  }

  alertById(id: string): AlertEventRow | null {
    const r = this.db.prepare('SELECT * FROM alert_event WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? null : mapAlertRow(r)
  }

  /** 最近台账（默认 50 行；UI 与证据归档用）。 */
  recentAlerts(limit = 50): AlertEventRow[] {
    return this.rowsToAlerts(this.db.prepare('SELECT * FROM alert_event ORDER BY confirmed_at DESC LIMIT ?').all(limit))
  }

  /** 台账计数：open = 未解除；total = 全部；last24h = 近 24h 确认数（噪声观察面）。 */
  alertCounts(now = Date.now()): { open: number; total: number; last24h: number } {
    const head = this.db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN cleared_at IS NULL THEN 1 ELSE 0 END) AS open FROM alert_event
    `).get() as { total: number; open: number | null }
    const day = this.db.prepare('SELECT COUNT(*) AS n FROM alert_event WHERE confirmed_at >= ?').get(now - 86400000) as { n: number }
    return { open: Number(head.open ?? 0), total: Number(head.total ?? 0), last24h: Number(day.n ?? 0) }
  }

  private rowsToAlerts(rows: unknown[]): AlertEventRow[] {
    return (rows as Array<Record<string, unknown>>).map(mapAlertRow)
  }

  /**
   * 关闭连接。node:sqlite 的 prepared statement 只能靠 GC 终结：若语句尚未回收，
   * `close()` 可能抛错（Windows + WAL 下表现为文件句柄滞留）。**不再静默吞掉**——
   * 记一条警告，便于在 dispose 路径上发现泄漏；进程退出后由 OS 回收。
   */
  close(): void {
    try { this.db.close() } catch (err) {
      console.warn('[pulse] store.close() 未完全释放：' + (err instanceof Error ? err.message : String(err)))
    }
  }
}

/** 行 → AlertEventRow（列名 snake_case → 驼峰；枚举列原样透传）。 */
function mapAlertRow(r: Record<string, unknown>): AlertEventRow {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
  return {
    id: String(r.id), ruleId: String(r.rule_id), metric: String(r.metric),
    op: String(r.op) === 'lte' ? 'lte' : 'gte',
    threshold: Number(r.threshold),
    firstExceededAt: Number(r.first_exceeded_at), confirmedAt: Number(r.confirmed_at),
    clearedAt: num(r.cleared_at), peakValue: num(r.peak_value), durationMs: num(r.duration_ms),
    snapshotPath: str(r.snapshot_path), snapshotHash: str(r.snapshot_hash),
    reportStatus: (str(r.report_status) ?? 'skipped') as AlertEventRow['reportStatus'],
    reportModel: str(r.report_model), promptVersion: str(r.prompt_version),
    humanVerdict: str(r.human_verdict) as AlertEventRow['humanVerdict'],
    note: str(r.note), createdAt: Number(r.created_at ?? 0),
  }
}
