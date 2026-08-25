/**
 * @dsh-external/dsh-xuegulin — xuegu.db (SQLite, node:sqlite, zero deps).
 * vault_meta: file metadata baseline; edit_event: edit operations (only fs.watch channel writes).
 * Idempotency: edit_event.session_key unique (debounce window key) — no double counting on reload/restart.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface VaultMetaRow {
  path: string
  mtime: number
  size: number
  chars: number
  first_seen_ts: number
  last_seen_ts: number
  deleted: number
}

export interface DaySummary {
  edits: number
  modifiedFiles: number
  createdFiles: number
  topActive: Array<{ path: string; edits: number }>
}

/** M2 turn 读数行（官方会话事件聚合；与团队底座零耦合）。 */
export interface TurnReadRow {
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

export function openStore(dbFile: string): XuegulinStore {
  mkdirSync(dirname(dbFile), { recursive: true })
  return new XuegulinStore(dbFile)
}

export class XuegulinStore {
  private readonly db: DatabaseSync

  constructor(dbFile: string) {
    this.db = new DatabaseSync(dbFile)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        chars INTEGER NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_meta_mtime ON vault_meta(mtime);
      CREATE TABLE IF NOT EXISTS edit_event (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_edit_ts ON edit_event(ts);
      CREATE INDEX IF NOT EXISTS idx_edit_path_ts ON edit_event(path, ts);
      -- M2：L 场读数（官方 session/event 直采；幂等键 step_seen）
      CREATE TABLE IF NOT EXISTS turn_read (
        session TEXT NOT NULL,
        turn INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        question TEXT,
        token_in INTEGER NOT NULL DEFAULT 0,
        token_out INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        tps REAL,
        clarity REAL,
        defense TEXT,
        declaration INTEGER,
        PRIMARY KEY (session, turn)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_ts ON turn_read(ts);
      CREATE INDEX IF NOT EXISTS idx_turn_session ON turn_read(session, turn);
      CREATE TABLE IF NOT EXISTS step_seen (
        session TEXT NOT NULL,
        turn INTEGER NOT NULL,
        step INTEGER NOT NULL,
        PRIMARY KEY (session, turn, step)
      );
      -- M2：标记标注（预言检验表；prophecy 唯一——每个预言一条，最新状态）
      CREATE TABLE IF NOT EXISTS annotation (
        prophecy TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        session TEXT,
        turn INTEGER,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // ── vault_meta ──────────────────────────────────────────────────────────────

  getMeta(path: string): VaultMetaRow | undefined {
    return this.db.prepare('SELECT * FROM vault_meta WHERE path = ?').get(path) as VaultMetaRow | undefined
  }

  /** upsert；@returns 'created' | 'updated' | 'unchanged' */
  upsertMeta(row: { path: string; mtime: number; size: number; chars: number; ts: number }): 'created' | 'updated' | 'unchanged' {
    const existing = this.getMeta(row.path)
    if (existing === undefined) {
      this.db.prepare(`
        INSERT INTO vault_meta (path, mtime, size, chars, first_seen_ts, last_seen_ts, deleted)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(row.path, row.mtime, row.size, row.chars, row.ts, row.ts)
      return 'created'
    }
    if (existing.deleted === 1 || existing.mtime !== row.mtime || existing.size !== row.size) {
      this.db.prepare(`
        UPDATE vault_meta SET mtime = ?, size = ?, chars = ?, last_seen_ts = ?, deleted = 0 WHERE path = ?
      `).run(row.mtime, row.size, row.chars, row.ts, row.path)
      return 'updated'
    }
    return 'unchanged'
  }

  markDeleted(path: string, nowTs: number): void {
    this.db.prepare('UPDATE vault_meta SET deleted = 1, last_seen_ts = ? WHERE path = ?').run(nowTs, path)
  }

  totals(): { totalFiles: number; totalChars: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS c FROM vault_meta WHERE deleted = 0').get() as
      | { n: number; c: number }
      | undefined
    return { totalFiles: r?.n ?? 0, totalChars: r?.c ?? 0 }
  }

  allPaths(): string[] {
    return (this.db.prepare('SELECT path FROM vault_meta').all() as Array<{ path: string }>).map((r) => r.path)
  }

  // ── edit_event ──────────────────────────────────────────────────────────────

  /** 幂等写入；@returns true = 新记，false = 重复忽略。 */
  insertEdit(ev: { ts: number; path: string; kind: string; sessionKey: string }): boolean {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO edit_event (id, ts, path, kind, session_key) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), ev.ts, ev.path, ev.kind, ev.sessionKey)
    return Number(r.changes) > 0
  }

  // ── 统计（§3 口径） ─────────────────────────────────────────────────────────

  summary(dayStart: number, dayEnd: number): DaySummary {
    const edits = this.db.prepare('SELECT COUNT(*) AS n FROM edit_event WHERE ts >= ? AND ts < ?').get(dayStart, dayEnd) as { n: number }
    const created = this.db.prepare("SELECT COUNT(DISTINCT path) AS n FROM edit_event WHERE ts >= ? AND ts < ? AND kind = 'created'")
      .get(dayStart, dayEnd) as { n: number }
    const modified = this.db.prepare("SELECT COUNT(DISTINCT path) AS n FROM edit_event WHERE ts >= ? AND ts < ? AND kind = 'modified'")
      .get(dayStart, dayEnd) as { n: number }
    const top = this.db.prepare(`
      SELECT path, COUNT(*) AS edits FROM edit_event WHERE ts >= ? AND ts < ?
      GROUP BY path ORDER BY edits DESC LIMIT 5
    `).all(dayStart, dayEnd) as Array<{ path: string; edits: number }>
    return { edits: edits.n, modifiedFiles: modified.n, createdFiles: created.n, topActive: top }
  }

  recentEvents(limit: number): Array<{ ts: number; path: string; kind: string }> {
    return this.db.prepare('SELECT ts, path, kind FROM edit_event ORDER BY ts DESC LIMIT ?').all(limit) as Array<
      { ts: number; path: string; kind: string }
    >
  }

  // ── M2 turn_read（官方事件 → 每轮读数） ──────────────────────────────────────

  /** 幂等标记 step 已消费；@returns true = 首次（应更新 turn_read），false = 重复忽略。 */
  marksStepSeen(session: string, turn: number, step: number): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO step_seen (session, turn, step) VALUES (?, ?, ?)')
      .run(session, turn, step)
    return Number(r.changes) > 0
  }

  /** upsert 每轮读数（按 step 聚合累加；重启/重载幂等）。 */
  upsertTurnRead(row: {
    session: string
    turn: number
    ts: number
    question: string | null
    tokenIn: number
    tokenOut: number
    cacheRead: number
    durationMs: number | null
  }): void {
    const dur = row.durationMs !== null && row.durationMs > 0 ? row.durationMs : null
    const tps = dur !== null ? (row.tokenOut * 1000.0) / dur : null
    this.db.prepare(`
      INSERT INTO turn_read (session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session, turn) DO UPDATE SET
        ts = excluded.ts,
        question = COALESCE(excluded.question, question),
        token_in = token_in + excluded.token_in,
        token_out = token_out + excluded.token_out,
        cache_read = cache_read + excluded.cache_read,
        duration_ms = COALESCE(duration_ms, 0) + COALESCE(excluded.duration_ms, 0),
        tps = CASE
          WHEN COALESCE(duration_ms, 0) + COALESCE(excluded.duration_ms, 0) > 0
          THEN (token_out + excluded.token_out) * 1000.0
               / (COALESCE(duration_ms, 0) + COALESCE(excluded.duration_ms, 0))
          ELSE NULL END
    `).run(
      row.session, row.turn, row.ts, row.question,
      row.tokenIn, row.tokenOut, row.cacheRead, dur, tps,
    )
  }

  turnReads(limit: number): TurnReadRow[] {
    const rows = this.db.prepare(`
      SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps
      FROM turn_read ORDER BY ts DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      session: String(r.session!), turn: Number(r.turn), ts: Number(r.ts),
      question: r.question === null || r.question === undefined ? null : String(r.question),
      tokenIn: Number(r.token_in ?? 0), tokenOut: Number(r.token_out ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
      tps: r.tps === null || r.tps === undefined ? null : Number(r.tps),
    }))
  }

  /** 总量读数（总命中/未命中 token）；未命中 = token_in（官方 inputTokens = 未命中口径）。 */
  turnTotals(): { turns: number; tokenIn: number; tokenOut: number; cacheRead: number } {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS turns,
             COALESCE(SUM(token_in), 0) AS tin,
             COALESCE(SUM(token_out), 0) AS tout,
             COALESCE(SUM(cache_read), 0) AS cr
      FROM turn_read
    `).get() as { turns: number; tin: number; tout: number; cr: number }
    return { turns: Number(r.turns ?? 0), tokenIn: Number(r.tin ?? 0), tokenOut: Number(r.tout ?? 0), cacheRead: Number(r.cr ?? 0) }
  }

  /** 窗口内读数（曲线数据；ts >= fromTs 升序）。 */
  turnReadsSince(fromTs: number): TurnReadRow[] {
    const rows = this.db.prepare(`
      SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps
      FROM turn_read WHERE ts >= ? ORDER BY ts ASC
    `).all(fromTs) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      session: String(r.session!), turn: Number(r.turn), ts: Number(r.ts),
      question: r.question === null || r.question === undefined ? null : String(r.question),
      tokenIn: Number(r.token_in ?? 0), tokenOut: Number(r.token_out ?? 0),
      cacheRead: Number(r.cache_read ?? 0),
      durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
      tps: r.tps === null || r.tps === undefined ? null : Number(r.tps),
    }))
  }

  // ── M2 预言标注 ─────────────────────────────────────────────────────────────

  listAnnotations(): Array<{ prophecy: string; status: string; note: string | null; session: string | null; turn: number | null; updatedAt: number }> {
    const rows = this.db.prepare('SELECT prophecy, status, note, session, turn, updated_at FROM annotation ORDER BY prophecy').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      prophecy: String(r.prophecy), status: String(r.status ?? 'pending'),
      note: r.note === null || r.note === undefined ? null : String(r.note),
      session: r.session === null || r.session === undefined ? null : String(r.session),
      turn: r.turn === null || r.turn === undefined ? null : Number(r.turn),
      updatedAt: Number(r.updated_at ?? 0),
    }))
  }

  upsertAnnotation(row: { prophecy: string; status: string; note?: string | null; session?: string | null; turn?: number | null }): void {
    this.db.prepare(`
      INSERT INTO annotation (prophecy, status, note, session, turn, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(prophecy) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        session = excluded.session,
        turn = excluded.turn,
        updated_at = excluded.updated_at
    `).run(row.prophecy, row.status, row.note ?? null, row.session ?? null, row.turn ?? null, Date.now())
  }
}
