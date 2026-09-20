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
