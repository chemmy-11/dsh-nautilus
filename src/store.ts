/**
 * @dsh-external/dsh-nautilus — nautilus.db (SQLite, node:sqlite, zero deps).
 * turn_read/turn_text/step_seen/annotation: M2/M3 L 场读数与人工标注（官方 session/event 直采）。
 * session_root: M4-L per-session L-field ownership ('' = owned by no pointing — global view only);
 * lfield_config: M4-L independent L-field pointing (single row; baseline_ts kept as legacy, no longer read).
 * selfcheck_record: S1.1 多源自评（v5 迁移创建；唯一键 source_kind+ext_ref+turn_ordinal，见 1-planning 决策 D-SC3）。
 *
 * ⚠️ 历史残留表：`vault_meta` / `edit_event` / `vault_config`（vault 观测腿）已于 2026-09-27 下线。
 *    **代码不再读写、也不 drop**（红线 3：绝不销毁既有数据）——老库里它们仍在，新库不再创建。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
// v7 告警台账的 DDL 只有一份（本库迁移与 pulse 存储层共用），见 ALERT_EVENT_DDL 注释
import { ALERT_EVENT_DDL } from './pulse/store.js'
// AL.2：迁移账本（注册 + 顺序执行 + 回读校验），拆包甲的技术前提
import { runMigrations, type Migration, type MigrationRunResult } from './migrations.js'
/** M2/M3 turn 读数行（官方会话事件聚合；与团队底座零耦合）。 */
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
  clarity?: number | null
  defense?: string | null
  declaration?: number | null
}

/** M3-F.1 自评三行（A 腿二）。 */
export interface SelfCheck {
  clarity: number
  defense: 'none' | 'light' | 'heavy'
  declaration: 0 | 1
}

/** S1.1 多源自评行（selfcheck_record；口径 = 决策 D-SC3 定案版）。 */
export interface SelfCheckRecordRow {
  tsMs: number
  tsClient: number | null
  schemaVersion: number
  sourceKind: 'dsh_tool' | 'http' | 'backfill' | 'mcp'
  agent: string
  model: string | null
  workspace: string | null
  extRef: string
  turnOrdinal: number
  clarity: number
  defense: 'none' | 'light' | 'heavy'
  declaration: 0 | 1
  quote: string | null
}

export function openStore(dbFile: string): NautilusStore {
  mkdirSync(dirname(dbFile), { recursive: true })
  return new NautilusStore(dbFile)
}

export class NautilusStore {
  private readonly db: DatabaseSync

  constructor(dbFile: string) {
    this.db = new DatabaseSync(dbFile)
    this.db.exec(`
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
      -- M3-F.2：完整问答原文（B 方案；前向积累——每轮 user/assistant 全文）
      CREATE TABLE IF NOT EXISTS turn_text (
        session TEXT NOT NULL,
        turn INTEGER NOT NULL,
        user_text TEXT NOT NULL DEFAULT '',
        assistant_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session, turn)
      );
      -- M4-L：L 场读数会话归属（采集落点打标；'' = 未归属桶——仅在未指向时产生）
      CREATE TABLE IF NOT EXISTS session_root (
        session TEXT PRIMARY KEY,
        root TEXT NOT NULL DEFAULT '',
        first_ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_root ON session_root(root);
      -- M4-L：L 场读数独立指向（单行配置；与 vault_config 观测指向互不影响）
      CREATE TABLE IF NOT EXISTS lfield_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        root TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        baseline_ts INTEGER
      );
    `)
    this.migrate()
  }

  /**
   * 迁移入口。**历史沿革**：v0→v1 曾是「vault_meta/edit_event 加 root 列」——vault 观测腿 2026-09-27 下线后
   * 该步已删除（新库不再建这三张表；老库的既有表保留为残留，不 drop）。
   */
  private migrate(): void {
    this.lastMigrationRun = runMigrations({ db: this.db, list: this.migrations() })
  }

  /** 本腿注册的迁移账本（顺序由版本号决定；v1/v4 属他腿或已废弃，见 migrations.ts 文件头）。 */
  private migrations(): Migration[] {
    return [
      { version: 2, owner: 'nautilus', name: 'L 场指向 + 会话归属', apply: () => this.migrateV2() },
      { version: 3, owner: 'nautilus', name: 'lfield 基线列', apply: () => this.migrateV3() },
      { version: 5, owner: 'nautilus', name: 'S1.1 selfcheck_record', apply: () => this.migrateV5() },
      { version: 6, owner: 'nautilus', name: 'T 系列 turn_annotation', apply: () => this.migrateV6() },
      { version: 7, owner: 'nautilus', name: 'A 系列 alert_event', apply: () => this.migrateV7() },
      { version: 8, owner: 'nautilus', name: 'AL 对齐量表 1–5（turn_annotation 重建 + selfcheck_record 追加）', apply: () => this.migrateV8() },
      { version: 9, owner: 'nautilus', name: 'AL.3 selfcheck_record 重建（clarity/defense 转可空）', apply: () => this.migrateV9() },
    ]
  }

  /** 最近一次迁移账本运行结果（诊断与测试用；null = 尚未运行）。 */
  private lastMigrationRun: MigrationRunResult | null = null

  migrationLog(): MigrationRunResult | null {
    return this.lastMigrationRun
  }


  /**
   * M4-L 迁移（user_version 1→2，2026-08-31 定稿）：L 场读数独立指向 + 归档——
   * 既有会话（指向制前）整体归入 '' 桶（守谷人定稿：= 目前全部数据；M4.11 起该桶语义为「不属于任何指向」，不再是视图，
   * 与指向后的知识库会话两类分开处理）；lfield_config 种子 = ''（vault 观测腿下线后无「迁移时 vault 指向」可继承）。
   */
  private migrateV2(): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO session_root (session, root, first_ts)
        SELECT session, '', MIN(ts) FROM turn_read GROUP BY session
      `).run()
      this.db.prepare(`
        INSERT OR IGNORE INTO lfield_config (id, root, updated_at, baseline_ts) VALUES (1, ?, ?, ?)
      `).run('', Date.now(), Date.now())
      this.db.exec('PRAGMA user_version = 2')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * M4-L 修正迁移（user_version 2→3）：为旧 v2 表补 baseline_ts 列（划代基线——
   * 归档 epoch 与指向 epoch 的分界时刻）。幂等：已有基线 → 零行变更。
   */
  private migrateV3(): void {
    this.db.exec('BEGIN')
    try {
      const cols = this.db.prepare('PRAGMA table_info(lfield_config)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'baseline_ts')) {
        this.db.exec('ALTER TABLE lfield_config ADD COLUMN baseline_ts INTEGER')
      }
      this.db.prepare('UPDATE lfield_config SET baseline_ts = ? WHERE baseline_ts IS NULL').run(Date.now())
      this.db.exec('PRAGMA user_version = 3')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * S1.1 迁移（user_version 4→5，决策 D-SC3 定案版）：自评多源表 `selfcheck_record`。
   * 唯一键 (source_kind, ext_ref, turn_ordinal)——同键重投 = 修正覆盖（last-writer-wins，
   * 与旧 turn_read 自评列同语义）；`source_kind` 枚举预占 'mcp'（D-SC3a 前瞻约束）。
   * v4 槽已被 pulse（metric_sample）占用；M5 若复活改占 v6。幂等：IF NOT EXISTS + 版本单调。
   */
  private migrateV5(): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS selfcheck_record (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms          INTEGER NOT NULL,
          ts_client      INTEGER,
          schema_version INTEGER NOT NULL DEFAULT 1,
          source_kind    TEXT    NOT NULL CHECK (source_kind IN ('dsh_tool','http','backfill','mcp')),
          agent          TEXT    NOT NULL,
          model          TEXT,
          workspace      TEXT,
          ext_ref        TEXT    NOT NULL,
          turn_ordinal   INTEGER NOT NULL,
          clarity        REAL    NOT NULL CHECK (clarity BETWEEN 0 AND 1),
          defense        TEXT    NOT NULL CHECK (defense IN ('none','light','heavy')),
          declaration    INTEGER NOT NULL CHECK (declaration IN (0,1)),
          quote          TEXT,
          CHECK (declaration = 0 OR quote IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_sc_key ON selfcheck_record (source_kind, ext_ref, turn_ordinal);
        CREATE INDEX IF NOT EXISTS ix_sc_ts ON selfcheck_record(ts_ms);
      `)
      this.db.exec('PRAGMA user_version = 5')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * T 系列迁移（user_version 5→6，决策 D-T2）：逐轮人工标注 `turn_annotation`
   * （一行一轮、最新覆盖；fit/exempt 互斥与 fit=4 必附引文走 CHECK 双门；recheck 覆盖前旧值挪 `*_prev`）
   * + 抽样队列 `annotation_sample`（origin 服务端判定依据）。
   * 人工解读层不落 turn_read（dev-02 §5：解读不写回读数）。幂等：IF NOT EXISTS + 版本单调。
   */
  private migrateV6(): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS turn_annotation (
          session        TEXT NOT NULL,
          turn           INTEGER NOT NULL,
          fit            INTEGER CHECK (fit BETWEEN 0 AND 4),
          exempt         INTEGER NOT NULL DEFAULT 0 CHECK (exempt IN (0,1)),
          quote          TEXT,
          note           TEXT,
          origin         TEXT NOT NULL CHECK (origin IN ('spot','sample')),
          schema_version INTEGER NOT NULL DEFAULT 1,
          fit_prev       INTEGER,
          quote_prev     TEXT,
          annotated_at   INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          PRIMARY KEY (session, turn),
          CHECK ((fit IS NULL AND exempt = 1) OR (fit IS NOT NULL AND exempt = 0)),
          CHECK (fit <> 4 OR quote IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS ix_ta_ts ON turn_annotation(updated_at);
        CREATE TABLE IF NOT EXISTS annotation_sample (
          batch_id     TEXT    NOT NULL,
          session      TEXT    NOT NULL,
          turn         INTEGER NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'sample' CHECK (kind IN ('sample','recheck')),
          strata       TEXT    NOT NULL DEFAULT '',
          sampled_at   INTEGER NOT NULL,
          annotated_at INTEGER,
          PRIMARY KEY (batch_id, session, turn)
        );
        CREATE INDEX IF NOT EXISTS ix_as_lookup ON annotation_sample(session, turn, annotated_at);
      `)
      this.db.exec('PRAGMA user_version = 6')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * A 系列迁移（user_version 6→7，决策 D-A1/A3）：OS 层红线告警台账 `alert_event`。
   *
   * 一行一条**已确认**的告警（确认那刻插入，解除时补 cleared_at/duration_ms）；
   * 规则参数快照（rule_id/metric/op/threshold）与报告/裁决字段一并在表内留位，
   * 让台账在规则改阈值之后仍能解释「当时按哪条线判的」。
   *
   * 幂等：`CREATE TABLE IF NOT EXISTS` + 版本单调；不删不改既有数据（红线 3）。
   * v8 槽留给并行的 S2（`turn_annotation` 重建 + `selfcheck_record` 追加）。
   */
  private migrateV7(): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec(ALERT_EVENT_DDL)
      this.db.exec('PRAGMA user_version = 7')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * AL 迁移（user_version 7→8，决策 §3.2，守谷人 6 签已核）：
   *  ① `turn_annotation` **重建**——加 `align` 1–5 / `align_prev` / `boundary`，CHECK 改写成三态：
   *     豁免 / 旧 fit 行（schema_version=1，保留可查） / 新 align 行（schema_version≥2）。SQLite 改不了 CHECK，
   *     故走「建新表 → 搬数据 → 换名」；**旧行一个不丢、字段一个不改**（红线 3）。
   *  ② `selfcheck_record` 追加 `align/boundary/self_align/evidence/rubric_version/receive`（逐列判存在，幂等）。
   * `align` 4 与 5 均须引文（签-2）：CHECK `align IS NULL OR align < 4 OR quote IS NOT NULL`。
   * 旧 `fit` 列**保留不写**（术语已废止，但历史数据不动）。
   */
  private migrateV8(): void {
    this.db.exec('BEGIN')
    try {
      // 表可能在（手工置版 / 半迁移的库）——缺席则跳过并如实告警，绝不硬崩（启动挡住比静默更重要的前提是「库本身可用」）
      const hasTa = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='turn_annotation'").get() !== undefined
      const taCols = hasTa ? (this.db.prepare('PRAGMA table_info(turn_annotation)').all() as Array<{ name: string }>) : []
      if (!hasTa) {
        console.warn('[nautilus] migrateV8：turn_annotation 缺席——跳过重建（该表由 v6 创建；本库的版本号与表结构不一致，请人工核对）')
      } else if (!taCols.some((c) => c.name === 'align')) {
        this.db.exec(`
          CREATE TABLE turn_annotation_v8 (
            session        TEXT NOT NULL,
            turn           INTEGER NOT NULL,
            align          INTEGER CHECK (align BETWEEN 1 AND 5),
            fit            INTEGER CHECK (fit BETWEEN 0 AND 4),
            exempt         INTEGER NOT NULL DEFAULT 0 CHECK (exempt IN (0,1)),
            quote          TEXT,
            note           TEXT,
            origin         TEXT NOT NULL CHECK (origin IN ('spot','sample')),
            boundary       TEXT NOT NULL DEFAULT 'none'
                           CHECK (boundary IN ('none','substitution','possession','coercion','projection')),
            schema_version INTEGER NOT NULL DEFAULT 2,
            align_prev     INTEGER CHECK (align_prev BETWEEN 1 AND 5),
            fit_prev       INTEGER,
            quote_prev     TEXT,
            annotated_at   INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL,
            PRIMARY KEY (session, turn),
            CHECK (
              (exempt = 1 AND fit IS NULL AND align IS NULL)
              OR (exempt = 0 AND schema_version = 1 AND fit IS NOT NULL AND align IS NULL)
              OR (exempt = 0 AND schema_version >= 2 AND align IS NOT NULL AND fit IS NULL)
            ),
            CHECK ((fit IS NULL OR fit <> 4 OR quote IS NOT NULL)
               AND (align IS NULL OR align < 4 OR quote IS NOT NULL))
          );
          INSERT INTO turn_annotation_v8
            (session, turn, align, fit, exempt, quote, note, origin, boundary, schema_version,
             align_prev, fit_prev, quote_prev, annotated_at, updated_at)
          SELECT session, turn, NULL, fit, exempt, quote, note, origin, 'none', 1,
                 NULL, fit_prev, quote_prev, annotated_at, updated_at
          FROM turn_annotation;
          DROP TABLE turn_annotation;
          ALTER TABLE turn_annotation_v8 RENAME TO turn_annotation;
          CREATE INDEX IF NOT EXISTS ix_ta_ts ON turn_annotation(updated_at);
        `)
      }
      const hasSc = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='selfcheck_record'").get() !== undefined
      const scCols = new Set(hasSc ? (this.db.prepare('PRAGMA table_info(selfcheck_record)').all() as Array<{ name: string }>).map((c) => c.name) : [])
      if (!hasSc) console.warn('[nautilus] migrateV8：selfcheck_record 缺席——跳过追加列（该表由 v5 创建；版本号与表结构不一致，请人工核对）')
      const addCol = (name: string, ddl: string): void => { if (hasSc && !scCols.has(name)) this.db.exec('ALTER TABLE selfcheck_record ADD COLUMN ' + ddl) }
      addCol('align', 'align INTEGER CHECK (align BETWEEN 1 AND 5)')
      addCol('boundary', "boundary TEXT CHECK (boundary IN ('none','substitution','possession','coercion','projection'))")
      addCol('self_align', 'self_align INTEGER CHECK (self_align BETWEEN 1 AND 5)')
      addCol('evidence', 'evidence TEXT')
      addCol('rubric_version', 'rubric_version TEXT')
      // receive 语义未定（OQ-AL1）——列留位但**不写入**，见决策文档 §10
      addCol('receive', 'receive INTEGER CHECK (receive IN (0,1,2))')
      this.db.exec('PRAGMA user_version = 8')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * AL.3 迁移（user_version 8→9）：`selfcheck_record` **重建**——`clarity`/`defense` 转为**可空**。
   *
   * 理由：AL 把自评收成一维 `align` 1–5；新行的旧三行维度**没有值可填**，而 v5 建表时两列是 NOT NULL——
   * 继续塞 0/'none' 等于造假数据。SQLite 改不了 NOT NULL → 「建新表 → 搬数据 → 换名」（同 v8 手法）。
   * 旧行一个不丢、字段一个不改；CHECK 保留（NULL 不触发 BETWEEN/枚举约束，天然兼容新旧两代）。
   */
  private migrateV9(): void {
    this.db.exec('BEGIN')
    try {
      const hasSc = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='selfcheck_record'").get() !== undefined
      if (!hasSc) {
        console.warn('[nautilus] migrateV9：selfcheck_record 缺席——跳过重建（该表由 v5 创建；版本号与表结构不一致，请人工核对）')
      } else {
        const cols = this.db.prepare('PRAGMA table_info(selfcheck_record)').all() as Array<{ name: string; notnull: number }>
        const clarityStrict = cols.find((c) => c.name === 'clarity')?.notnull === 1
        const hasAlign = cols.some((c) => c.name === 'align')
        if (clarityStrict && hasAlign) {
          this.db.exec(`
            CREATE TABLE selfcheck_record_v9 (
              id             INTEGER PRIMARY KEY AUTOINCREMENT,
              ts_ms          INTEGER NOT NULL,
              ts_client      INTEGER,
              schema_version INTEGER NOT NULL DEFAULT 1,
              source_kind    TEXT    NOT NULL CHECK (source_kind IN ('dsh_tool','http','backfill','mcp')),
              agent          TEXT    NOT NULL,
              model          TEXT,
              workspace      TEXT,
              ext_ref        TEXT    NOT NULL,
              turn_ordinal   INTEGER NOT NULL,
              clarity        REAL    CHECK (clarity IS NULL OR clarity BETWEEN 0 AND 1),
              defense        TEXT    CHECK (defense IS NULL OR defense IN ('none','light','heavy')),
              declaration    INTEGER NOT NULL CHECK (declaration IN (0,1)),
              quote          TEXT,
              align          INTEGER CHECK (align BETWEEN 1 AND 5),
              boundary       TEXT    CHECK (boundary IS NULL OR boundary IN ('none','substitution','possession','coercion','projection')),
              self_align     INTEGER CHECK (self_align BETWEEN 1 AND 5),
              evidence       TEXT,
              rubric_version TEXT,
              receive        INTEGER CHECK (receive IN (0,1,2)),
              CHECK (declaration = 0 OR quote IS NOT NULL)
            );
            INSERT INTO selfcheck_record_v9
              (id, ts_ms, ts_client, schema_version, source_kind, agent, model, workspace, ext_ref, turn_ordinal,
               clarity, defense, declaration, quote, align, boundary, self_align, evidence, rubric_version, receive)
            SELECT id, ts_ms, ts_client, schema_version, source_kind, agent, model, workspace, ext_ref, turn_ordinal,
                   clarity, defense, declaration, quote, align, boundary, self_align, evidence, rubric_version, receive
            FROM selfcheck_record;
            DROP TABLE selfcheck_record;
            ALTER TABLE selfcheck_record_v9 RENAME TO selfcheck_record;
            CREATE UNIQUE INDEX IF NOT EXISTS ux_sc_key ON selfcheck_record (source_kind, ext_ref, turn_ordinal);
            CREATE INDEX IF NOT EXISTS ix_sc_ts ON selfcheck_record(ts_ms);
          `)
        } else if (!hasAlign) {
          console.warn('[nautilus] migrateV9：selfcheck_record 缺 align 列（v8 未生效？）——跳过重建')
        }
      }
      this.db.exec('PRAGMA user_version = 9')
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.db.close()
  }


  // ── M4-L：L 场读数独立指向（lfield_config / session_root） ──────────────────

  /** L 场读数当前指向（采集归属；'' = 未指向——新会话将落入未归属桶）。 */
  lfieldRoot(): string {
    const r = this.db.prepare('SELECT root FROM lfield_config WHERE id = 1').get() as { root: string } | undefined
    return r === undefined ? '' : String(r.root)
  }

  /** 切换 L 场读数指向（采集从此归入新根；既有会话归属不变）。 */
  setLfieldRoot(root: string): void {
    this.db.prepare(`
      INSERT INTO lfield_config (id, root, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at
    `).run(root, Date.now())
  }

  /**
   * 会话首次落点分类（守谷人 2026-08-31 定稿；2026-09 口径修订保留）：cwd 在当前 L 场指向根之下（含等于）
   * → vault 会话，归指向根；否则 → ''（不属于任何指向，只在全局视图出现）。INSERT OR IGNORE——首标定终身，不因后续改写。
   */
  classifySessionRoot(session: string, cwd: string | undefined, ts: number): void {
    const root = this.lfieldRoot()
    const kb = cwd !== undefined && cwd !== '' && root !== '' && this.isUnderRoot(cwd, root)
    this.db.prepare('INSERT OR IGNORE INTO session_root (session, root, first_ts) VALUES (?, ?, ?)')
      .run(session, kb ? root : '', ts)
  }

  /** workspace 归属判定：cwd 等于根或位于根下（Windows 大小写不敏感，分隔符统一）。 */
  private isUnderRoot(cwd: string, root: string): boolean {
    const norm = (p: string): string => p.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    const c = norm(cwd)
    const r = norm(root)
    return c === r || c.startsWith(r + '\\')
  }

  /** 各归属的会话数（键含 '' = 不属于任何指向）。 */
  sessionRootCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT root, COUNT(*) AS n FROM session_root GROUP BY root').all() as Array<{ root: string; n: number }>
    const out: Record<string, number> = {}
    for (const r of rows) out[String(r.root)] = Number(r.n)
    return out
  }

  /** 每会话元信息（首轮时刻 + 轮数；会话选择器的友好标签数据源）。 */
  sessionMeta(): Record<string, { startTs: number; turns: number }> {
    const rows = this.db.prepare('SELECT session, MIN(ts) AS start_ts, COUNT(*) AS turns FROM turn_read GROUP BY session').all() as Array<Record<string, unknown>>
    const out: Record<string, { startTs: number; turns: number }> = {}
    for (const r of rows) out[String(r.session)] = { startTs: Number(r.start_ts), turns: Number(r.turns) }
    return out
  }

  /** M4-B：逐会话自评覆盖（已评/总轮次 + 缺口轮号；root 给定时按归属桶过滤）。 */
  selfcheckCoverage(root?: string): {
    checked: number
    total: number
    bySession: Record<string, { checked: number; total: number; missing: number[] }>
  } {
    const f = this.turnRootFilter(root)
    const agg = this.db.prepare(`
      SELECT session, COUNT(*) AS total,
             SUM(CASE WHEN clarity IS NOT NULL THEN 1 ELSE 0 END) AS checked
      FROM turn_read WHERE 1 = 1${f.sql}
      GROUP BY session
    `).all(...f.params) as Array<Record<string, unknown>>
    const missing = this.db.prepare(`
      SELECT session, turn FROM turn_read WHERE clarity IS NULL${f.sql} ORDER BY session, turn
    `).all(...f.params) as Array<Record<string, unknown>>
    const bySession: Record<string, { checked: number; total: number; missing: number[] }> = {}
    let checked = 0
    let total = 0
    for (const r of agg) {
      const s = String(r.session)
      const t = Number(r.total)
      const c = Number(r.checked ?? 0)
      bySession[s] = { checked: c, total: t, missing: [] }
      checked += c
      total += t
    }
    for (const r of missing) {
      const s = String(r.session)
      if (bySession[s] !== undefined) bySession[s].missing.push(Number(r.turn))
    }
    return { checked, total, bySession }
  }

  /** 会话归属过滤片段：root 给定时仅取归属该根的会话（undefined = 不过滤——工具全局口径）。 */
  private turnRootFilter(root: string | undefined): { sql: string; params: string[] } {
    if (root === undefined) return { sql: '', params: [] }
    return { sql: ' AND session IN (SELECT session FROM session_root WHERE root = ?)', params: [root] }
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

  turnReads(limit: number, root?: string): TurnReadRow[] {
    const f = this.turnRootFilter(root)
    const rows = this.db.prepare(`
      SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps,
             clarity, defense, declaration
      FROM turn_read WHERE 1 = 1${f.sql} ORDER BY ts DESC LIMIT ?
    `).all(...f.params, limit) as Array<Record<string, unknown>>
    return rows.map((r) => mapTurnRow(r))
  }

  /** 总量读数（总命中/未命中 token）；未命中 = token_in（官方 inputTokens = 未命中口径）。 */
  turnTotals(root?: string): { turns: number; tokenIn: number; tokenOut: number; cacheRead: number } {
    const f = this.turnRootFilter(root)
    const r = this.db.prepare(`
      SELECT COUNT(*) AS turns,
             COALESCE(SUM(token_in), 0) AS tin,
             COALESCE(SUM(token_out), 0) AS tout,
             COALESCE(SUM(cache_read), 0) AS cr
      FROM turn_read WHERE 1 = 1${f.sql}
    `).get(...f.params) as { turns: number; tin: number; tout: number; cr: number }
    return { turns: Number(r.turns ?? 0), tokenIn: Number(r.tin ?? 0), tokenOut: Number(r.tout ?? 0), cacheRead: Number(r.cr ?? 0) }
  }

  /** 窗口内读数（曲线数据；ts >= fromTs 升序；root 给定时按归属桶过滤）。 */
  turnReadsSince(fromTs: number, root?: string): TurnReadRow[] {
    const f = this.turnRootFilter(root)
    const rows = this.db.prepare(`
      SELECT session, turn, ts, question, token_in, token_out, cache_read, duration_ms, tps,
             clarity, defense, declaration
      FROM turn_read WHERE ts >= ?${f.sql} ORDER BY ts ASC
    `).all(fromTs, ...f.params) as Array<Record<string, unknown>>
    return rows.map((r) => mapTurnRow(r))
  }

  /** M3-F.1：写入某轮自评三行（upsert，幂等——同一轮重复自评以新值覆盖）。**S1.2 切读后停写**（过渡双写）。 */
  setSelfCheck(session: string, turn: number, check: SelfCheck): void {
    this.db.prepare(`
      UPDATE turn_read SET clarity = ?, defense = ?, declaration = ? WHERE session = ? AND turn = ?
    `).run(check.clarity, check.defense, check.declaration, session, turn)
  }

  // ── S1.1 自评多源表（selfcheck_record；口径 = 决策 D-SC3 定案版）───────────────

  /** 全库 schema 版本（PRAGMA user_version；跨层诊断用）。 */
  schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0)
  }

  /**
   * 落一条多源自评；同唯一键 (source_kind, ext_ref, turn_ordinal) 重投 = 修正覆盖。
   * @returns 'inserted' 首投 / 'duplicate' 同键覆盖（响应面据此标 duplicate）。
   */
  insertSelfCheckRecord(row: SelfCheckRecordRow): 'inserted' | 'duplicate' {
    const hit = this.db
      .prepare('SELECT 1 AS x FROM selfcheck_record WHERE source_kind = ? AND ext_ref = ? AND turn_ordinal = ?')
      .get(row.sourceKind, row.extRef, row.turnOrdinal)
    this.db.prepare(`
      INSERT INTO selfcheck_record
        (ts_ms, ts_client, schema_version, source_kind, agent, model, workspace, ext_ref, turn_ordinal,
         clarity, defense, declaration, quote)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_kind, ext_ref, turn_ordinal) DO UPDATE SET
        ts_ms = excluded.ts_ms,
        ts_client = excluded.ts_client,
        schema_version = excluded.schema_version,
        agent = excluded.agent,
        model = excluded.model,
        workspace = excluded.workspace,
        clarity = excluded.clarity,
        defense = excluded.defense,
        declaration = excluded.declaration,
        quote = excluded.quote
    `).run(
      row.tsMs, row.tsClient, row.schemaVersion, row.sourceKind, row.agent, row.model, row.workspace,
      row.extRef, row.turnOrdinal, row.clarity, row.defense, row.declaration, row.quote,
    )
    return hit === undefined ? 'inserted' : 'duplicate'
  }

  /** 多源自评行数（可按 source_kind 过滤；诊断与验收对照用）。 */
  countSelfCheckRecords(sourceKind?: string): number {
    const r = sourceKind === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM selfcheck_record').get()
      : this.db.prepare('SELECT COUNT(*) AS n FROM selfcheck_record WHERE source_kind = ?').get(sourceKind)
    return Number((r as { n: number } | undefined)?.n ?? 0)
  }

  /** 该会话的 L 场归属（session_root；'' = 未归属 → 返回 null，不存空串）。 */
  selfcheckWorkspaceOf(session: string): string | null {
    const r = this.db.prepare('SELECT root FROM session_root WHERE session = ?').get(session) as { root: string } | undefined
    if (r === undefined || r.root === '') return null
    return String(r.root)
  }

  // ── T 系列：逐轮人工标注（turn_annotation / annotation_sample；口径 = 决策 D-T2/T3）──

  /**
   * upsert 一条逐轮标注（一行一轮、最新覆盖）。覆盖已有标注时旧值挪入 `fit_prev/quote_prev`
   * （D-T4 复标的成对数据；`annotated_at` 保持首次标注时刻，`updated_at` 记本次）。
   * @returns 'inserted' | 'overwritten'
   */
  upsertTurnAnnotation(row: {
    session: string; turn: number
    fit: number | null; exempt: 0 | 1
    quote: string | null; note: string | null
    origin: 'spot' | 'sample'; schemaVersion: number
  }): 'inserted' | 'overwritten' {
    const now = Date.now()
    const prev = this.db.prepare('SELECT fit, quote, annotated_at FROM turn_annotation WHERE session = ? AND turn = ?')
      .get(row.session, row.turn) as { fit: number | null; quote: string | null; annotated_at: number } | undefined
    if (prev === undefined) {
      this.db.prepare(`
        INSERT INTO turn_annotation (session, turn, fit, exempt, quote, note, origin, schema_version, fit_prev, quote_prev, annotated_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(row.session, row.turn, row.fit, row.exempt, row.quote, row.note, row.origin, row.schemaVersion, now, now)
      return 'inserted'
    }
    this.db.prepare(`
      UPDATE turn_annotation
      SET fit = ?, exempt = ?, quote = ?, note = ?, origin = ?, schema_version = ?,
          fit_prev = COALESCE(fit_prev, ?), quote_prev = COALESCE(quote_prev, ?),
          updated_at = ?
      WHERE session = ? AND turn = ?
    `).run(row.fit, row.exempt, row.quote, row.note, row.origin, row.schemaVersion,
      prev.fit ?? null, prev.quote ?? null, now, row.session, row.turn)
    return 'overwritten'
  }

  /**
   * 队列命中判定（origin 服务端判定的依据）：该轮在任一**未完成**队列行中 → 'sample' 并回填 annotated_at；
   * 否则 'spot'。一次标注可命中多个批次（如两批重叠抽了同轮）——全部回填。
   */
  resolveAnnotationOrigin(session: string, turn: number): 'spot' | 'sample' {
    const hits = this.db.prepare('SELECT batch_id FROM annotation_sample WHERE session = ? AND turn = ? AND annotated_at IS NULL')
      .all(session, turn) as Array<{ batch_id: string }>
    if (hits.length === 0) return 'spot'
    this.db.prepare('UPDATE annotation_sample SET annotated_at = ? WHERE session = ? AND turn = ? AND annotated_at IS NULL')
      .run(Date.now(), session, turn)
    return 'sample'
  }

  listTurnAnnotations(): Array<{
    session: string; turn: number; fit: number | null; exempt: 0 | 1
    quote: string | null; note: string | null; origin: 'spot' | 'sample'
    schemaVersion: number; fitPrev: number | null; annotatedAt: number; updatedAt: number
  }> {
    const rows = this.db.prepare('SELECT * FROM turn_annotation ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      session: String(r.session), turn: Number(r.turn),
      fit: r.fit === null || r.fit === undefined ? null : Number(r.fit),
      exempt: Number(r.exempt ?? 0) as 0 | 1,
      quote: r.quote == null ? null : String(r.quote),
      note: r.note == null ? null : String(r.note),
      origin: String(r.origin) as 'spot' | 'sample',
      schemaVersion: Number(r.schema_version ?? 1),
      fitPrev: r.fit_prev === null || r.fit_prev === undefined ? null : Number(r.fit_prev),
      annotatedAt: Number(r.annotated_at), updatedAt: Number(r.updated_at),
    }))
  }

  /**
   * 双口径覆盖计数（spot/sample 永不合并——决策 §7 边界 3）。
   * pending = 队列里仍未标的候选；rechecked = 有 *_prev 的条数（噪声地板成对样本数）。
   */
  turnAnnotationCoverage(): {
    spot: number; sample: { marked: number; pending: number }
    exempted: number; byFit: Record<string, number>; rechecked: number; total: number
  } {
    const byOrigin = this.db.prepare(`
      SELECT origin, COUNT(*) AS n, SUM(exempt) AS ex, SUM(CASE WHEN fit_prev IS NOT NULL THEN 1 ELSE 0 END) AS rc
      FROM turn_annotation GROUP BY origin
    `).all() as Array<{ origin: string; n: number; ex: number | null; rc: number | null }>
    const fits = this.db.prepare('SELECT fit, COUNT(*) AS n FROM turn_annotation WHERE fit IS NOT NULL GROUP BY fit').all() as Array<{ fit: number; n: number }>
    const pending = this.db.prepare('SELECT COUNT(*) AS n FROM annotation_sample WHERE annotated_at IS NULL').get() as { n: number }
    const out = { spot: 0, sample: { marked: 0, pending: Number(pending.n ?? 0) }, exempted: 0, byFit: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 } as Record<string, number>, rechecked: 0, total: 0 }
    for (const r of byOrigin) {
      const n = Number(r.n)
      out.total += n
      out.exempted += Number(r.ex ?? 0)
      out.rechecked += Number(r.rc ?? 0)
      if (r.origin === 'sample') out.sample.marked = n
      else out.spot = n
    }
    for (const f of fits) out.byFit[String(Number(f.fit))] = Number(f.n)
    return out
  }

  /** 已标注的 (session:turn) 键集（生成器排重：sample 不再抽已标、recheck 只抽已标未复标）。 */
  annotatedTurnKeys(): { annotated: Set<string>; rechecked: Set<string> } {
    const rows = this.db.prepare('SELECT session, turn, fit_prev FROM turn_annotation').all() as Array<{ session: string; turn: number; fit_prev: number | null }>
    const annotated = new Set<string>()
    const rechecked = new Set<string>()
    for (const r of rows) {
      const k = `${r.session}:${r.turn}`
      annotated.add(k)
      if (r.fit_prev !== null && r.fit_prev !== undefined) rechecked.add(k)
    }
    return { annotated, rechecked }
  }

  /** 入队（生成器与测试共用；PK 冲突 = 已入队，跳过不报错）。@returns 实际插入行数。 */
  insertSampleBatch(rows: Array<{ batchId: string; session: string; turn: number; kind: 'sample' | 'recheck'; strata: string }>): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO annotation_sample (batch_id, session, turn, kind, strata, sampled_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    let n = 0
    this.db.exec('BEGIN')
    try {
      const now = Date.now()
      for (const r of rows) { const c = stmt.run(r.batchId, r.session, r.turn, r.kind, r.strata, now); n += Number(c.changes) }
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return n
  }

  // ── AL 系列：对齐程度标注（align 1–5 + boundary；口径 = 决策文档 §2，守谷人 6 签）──

  /**
   * upsert 一条**对齐**标注（一行一轮、最新覆盖）。人工与自评同形——两路用同一把尺子。
   * 覆盖时旧 `align` 挪入 `align_prev`（一致性/噪声地板的成对数据）；`annotated_at` 保持首标时刻。
   * `align=4|5` 无引文由 CHECK 拒（签-2）；`exempt=1` 与 `align` 互斥。
   * @returns 'inserted' | 'overwritten'
   */
  upsertTurnAlignment(row: {
    session: string; turn: number
    align: number | null; exempt: 0 | 1
    boundary: 'none' | 'substitution' | 'possession' | 'coercion' | 'projection'
    quote: string | null; note: string | null; origin: 'spot' | 'sample'
  }): 'inserted' | 'overwritten' {
    const now = Date.now()
    const prev = this.db.prepare('SELECT align, quote, annotated_at FROM turn_annotation WHERE session = ? AND turn = ?')
      .get(row.session, row.turn) as { align: number | null; quote: string | null; annotated_at: number } | undefined
    if (prev === undefined) {
      this.db.prepare(`
        INSERT INTO turn_annotation
          (session, turn, align, fit, exempt, quote, note, origin, boundary, schema_version, align_prev, fit_prev, quote_prev, annotated_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 2, NULL, NULL, NULL, ?, ?)
      `).run(row.session, row.turn, row.align, row.exempt, row.quote, row.note, row.origin, row.boundary, now, now)
      return 'inserted'
    }
    // 覆盖：新行的 CHECK 要求 align 行**不得携带 fit**（代际分层）——所以旧 fit 挪进 fit_prev 后清空，
    // 旧 align/quote 同理进 *_prev（AL.5 的成对数据靠它）。SQLite 的 SET 右侧一律读旧值，故可同句搬移。
    this.db.prepare(`
      UPDATE turn_annotation
      SET align = ?, exempt = ?, quote = ?, note = ?, origin = ?, boundary = ?, schema_version = 2,
          fit = NULL,
          fit_prev = COALESCE(fit_prev, fit),
          align_prev = COALESCE(align_prev, ?),
          quote_prev = COALESCE(quote_prev, quote),
          updated_at = ?
      WHERE session = ? AND turn = ?
    `).run(row.align, row.exempt, row.quote, row.note, row.origin, row.boundary,
      prev.align ?? null, now, row.session, row.turn)
    return 'overwritten'
  }

  /** 读侧：对齐标注清单（含旧 fit 行——它们 `align` 为 null、`schemaVersion=1`）。 */
  listTurnAlignments(): Array<{
    session: string; turn: number; align: number | null; alignPrev: number | null
    boundary: string; exempt: 0 | 1; quote: string | null; note: string | null
    origin: 'spot' | 'sample'; schemaVersion: number; annotatedAt: number; updatedAt: number
  }> {
    const rows = this.db.prepare('SELECT * FROM turn_annotation ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      session: String(r.session), turn: Number(r.turn),
      align: r.align === null || r.align === undefined ? null : Number(r.align),
      alignPrev: r.align_prev === null || r.align_prev === undefined ? null : Number(r.align_prev),
      boundary: String(r.boundary ?? 'none'),
      exempt: Number(r.exempt ?? 0) as 0 | 1,
      quote: r.quote == null ? null : String(r.quote),
      note: r.note == null ? null : String(r.note),
      origin: String(r.origin) as 'spot' | 'sample',
      schemaVersion: Number(r.schema_version ?? 1),
      annotatedAt: Number(r.annotated_at), updatedAt: Number(r.updated_at),
    }))
  }

  /**
   * 对齐分布与边界计数（AL.5 一致性对照的输入）。
   * `legacyFitRows` = 旧 0–4 契合行（`schema_version=1`）——**与新量表分层，永不合并统计**（诚实边界 3）。
   */
  turnAlignmentCoverage(): {
    total: number; aligned: number; exempted: number; legacyFitRows: number
    byAlign: Record<string, number>; byBoundary: Record<string, number>
  } {
    const rows = this.db.prepare('SELECT align, exempt, boundary, schema_version FROM turn_annotation').all() as Array<Record<string, unknown>>
    const out = {
      total: 0, aligned: 0, exempted: 0, legacyFitRows: 0,
      byAlign: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as Record<string, number>,
      byBoundary: { none: 0, substitution: 0, possession: 0, coercion: 0, projection: 0 } as Record<string, number>,
    }
    for (const r of rows) {
      out.total += 1
      if (Number(r.schema_version ?? 1) === 1) { out.legacyFitRows += 1; continue }
      if (Number(r.exempt ?? 0) === 1) { out.exempted += 1 }
      if (r.align !== null && r.align !== undefined) {
        out.aligned += 1
        const k = String(Number(r.align))
        out.byAlign[k] = (out.byAlign[k] ?? 0) + 1
      }
      const b = String(r.boundary ?? 'none')
      out.byBoundary[b] = (out.byBoundary[b] ?? 0) + 1
    }
    return out
  }

  // ── M3-F.2 完整问答原文（B 方案；前向积累） ─────────────────────────────────

  /** 写入/更新该轮用户问题全文（首次 insert，后续仅当为空时补）。 */
  upsertUserText(session: string, turn: number, text: string): void {
    this.db.prepare(`
      INSERT INTO turn_text (session, turn, user_text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session, turn) DO UPDATE SET
        user_text = CASE WHEN turn_text.user_text = '' THEN excluded.user_text ELSE turn_text.user_text END,
        updated_at = excluded.updated_at
    `).run(session, turn, text, Date.now())
  }

  /** 追加该轮 assistant 全文（多 step 拼接，幂等由 step_seen 保证调用方只调一次/step）。 */
  appendAssistantText(session: string, turn: number, text: string): void {
    this.db.prepare(`
      INSERT INTO turn_text (session, turn, assistant_text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session, turn) DO UPDATE SET
        assistant_text = turn_text.assistant_text || excluded.assistant_text,
        updated_at = excluded.updated_at
    `).run(session, turn, text, Date.now())
  }

  getTurnText(session: string, turn: number): { userText: string; assistantText: string } | null {
    const r = this.db.prepare('SELECT user_text, assistant_text FROM turn_text WHERE session = ? AND turn = ?')
      .get(session, turn) as { user_text: string; assistant_text: string } | undefined
    if (r === undefined) return null
    return { userText: r.user_text, assistantText: r.assistant_text }
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

/** 行 → TurnReadRow（含 M3-F.1 预留/自评三列）。 */
function mapTurnRow(r: Record<string, unknown>): TurnReadRow {
  return {
    session: String(r.session!), turn: Number(r.turn), ts: Number(r.ts),
    question: r.question === null || r.question === undefined ? null : String(r.question),
    tokenIn: Number(r.token_in ?? 0), tokenOut: Number(r.token_out ?? 0),
    cacheRead: Number(r.cache_read ?? 0),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    tps: r.tps === null || r.tps === undefined ? null : Number(r.tps),
    clarity: r.clarity === null || r.clarity === undefined ? null : Number(r.clarity),
    defense: r.defense === null || r.defense === undefined ? null : String(r.defense),
    declaration: r.declaration === null || r.declaration === undefined ? null : Number(r.declaration),
  }
}
