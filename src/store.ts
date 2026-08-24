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
}
