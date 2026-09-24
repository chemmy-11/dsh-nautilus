/**
 * @dsh-external/dsh-nautilus — AL 系列（对齐体系重构）回归测试 + 结构守卫。
 *
 * 内容：
 *  · AL.6 边界守卫：`src/nexus/**` 自包含、只在 src/nexus 下、两腿互不 import（决策 §7.2）。
 *  · AL.2 迁移账本与 v8 迁移：按序应用 / 跳号如实记录 / 幂等 / 旧契合行一个不丢 / 1–5 与边界 CHECK。
 *  · AL.3 自评通道换 al-v1 对齐量表：工具面 = rubric 注入面 / 硬门零写入 / 双形 ingest / 覆盖语义。
 * 已知例外（记在案）：`../store.js` 允许 nexus import——数据核心仍共享，真正抽离属 OQ-AL4。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { runMigrations, readUserVersion } from '../lib/migrations.js'
import { openStore } from '../lib/store.js'
import { processSelfCheck, buildSelfCheckTool } from '../lib/nexus/selfcheck.js'
import { ingestSelfCheck, QUOTE_MAX, EVIDENCE_MAX, RUBRIC_VERSION } from '../lib/nexus/selfcheck-ingest.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')
const NEXUS_MODULES = ['analysis.ts', 'selfcheck-ingest.ts', 'selfcheck.ts', 'turns.ts']
const tmpDir = (p) => mkdtempSync(join(tmpdir(), p))
const cleanup = (d) => { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Windows 句柄 GC 滞后 */ } }

test('AL.6 边界守卫：nexus 模块自包含、只在 src/nexus 下、两腿互不 import', () => {
  const nexusDir = join(SRC, 'nexus')
  assert.equal(existsSync(nexusDir), true, 'src/nexus/ 必须存在（AL.6 解耦落点）')
  assert.deepEqual(readdirSync(nexusDir).filter((f) => f.endsWith('.ts')).sort(), NEXUS_MODULES, 'nexus 模块集合')
  for (const n of NEXUS_MODULES) {
    assert.equal(existsSync(join(SRC, n)), false, 'src/' + n + ' 不该再存在（已移入 src/nexus/）')
  }
  for (const n of NEXUS_MODULES) {
    const text = readFileSync(join(nexusDir, n), 'utf8')
    for (const spec of [...text.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((m) => m[1])) {
      const allowed = spec.startsWith('node:') || spec.startsWith('./') || spec === '../store.js'
      assert.ok(allowed, 'src/nexus/' + n + ' 的 import 越界：' + spec + '（只允许 node:* / 同目录 / ../store.js）')
    }
    for (const bad of [/from '[^']*\/pulse\//, /from '[^']*\/client\//, /alerts\.js'/, /from '[^']*\/routes\.js'/, /from '[^']*\/index\.js'/]) {
      assert.ok(!bad.test(text), 'src/nexus/' + n + ' 命中禁止项：' + String(bad))
    }
  }
  for (const f of readdirSync(join(SRC, 'pulse')).filter((x) => x.endsWith('.ts'))) {
    assert.ok(!/from '[^']*nexus\//.test(readFileSync(join(SRC, 'pulse', f), 'utf8')), 'src/pulse/' + f + ' 不得 import nexus')
  }
})

// ── AL.2 迁移账本 ────────────────────────────────────────────────────────────

test('AL.2 迁移账本：新库按序到 v8、跳号（v1/v4）如实记录、重开幂等、重复版本号响亮失败', () => {
  const tmp = tmpDir('nautilus-mig-')
  try {
    const file = join(tmp, 'n.db')
    const s1 = openStore(file)
    assert.equal(s1.schemaVersion(), 9)
    const run1 = s1.migrationLog()
    assert.deepEqual(run1.applied.map((m) => m.version), [2, 3, 5, 6, 7, 8, 9], '按版本升序应用本腿注册的迁移')
    assert.deepEqual(run1.skipped, [1, 4], '跳号如实记录（v1 已废弃 / v4 属 pulse，不假装连续）')
    assert.ok(run1.applied.every((m) => m.owner === 'nautilus'), '本腿注册的迁移 owner 均为 nautilus（长度不写死，随版本自然增长）')
    s1.close()
    const s2 = openStore(file)
    assert.deepEqual(s2.migrationLog().applied, [], '重开不再应用任何迁移（幂等）')
    assert.equal(s2.schemaVersion(), 9, '不回退')
    s2.close()
    // 账本自身的守卫：重复版本号 = 装配错误（后一条永远不会被应用）
    const db = new DatabaseSync(join(tmp, 'ledger.db'))
    assert.throws(() => runMigrations({
      db, log: () => {},
      list: [
        { version: 1, owner: 'x', name: 'a', apply: () => db.exec('PRAGMA user_version = 1') },
        { version: 1, owner: 'y', name: 'b', apply: () => db.exec('PRAGMA user_version = 1') },
      ],
    }), /重复的迁移版本号/)
    // apply 不推进版本号 → 响亮失败（静默跳步是最难查的事故）
    assert.throws(() => runMigrations({ db, log: () => {}, list: [{ version: 9, owner: 'x', name: 'noop', apply: () => {} }] }), /与声明不符/)
    db.close()
  } finally { cleanup(tmp) }
})

// ── AL.2 v8 迁移：turn_annotation 重建 ────────────────────────────────────────

const V6_TURN_ANNOTATION = `
  CREATE TABLE turn_annotation (
    session TEXT NOT NULL, turn INTEGER NOT NULL,
    fit INTEGER CHECK (fit BETWEEN 0 AND 4),
    exempt INTEGER NOT NULL DEFAULT 0 CHECK (exempt IN (0,1)),
    quote TEXT, note TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('spot','sample')),
    schema_version INTEGER NOT NULL DEFAULT 1,
    fit_prev INTEGER, quote_prev TEXT,
    annotated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (session, turn),
    CHECK ((fit IS NULL AND exempt = 1) OR (fit IS NOT NULL AND exempt = 0)),
    CHECK (fit <> 4 OR quote IS NOT NULL)
  );`

test('AL.2 v8 重建：旧 0–4 契合行一个不丢（schema_version=1 / align NULL / fit_prev 成对保留）', () => {
  const tmp = tmpDir('nautilus-v8-')
  try {
    const file = join(tmp, 'n.db')
    {
      const raw = new DatabaseSync(file)
      raw.exec(V6_TURN_ANNOTATION)
      raw.exec(`
        INSERT INTO turn_annotation (session, turn, fit, exempt, quote, note, origin, schema_version, fit_prev, quote_prev, annotated_at, updated_at)
        VALUES ('s-a', 1, 3, 0, NULL, '推进了问题', 'spot', 1, NULL, NULL, 100, 100),
               ('s-a', 2, 2, 0, '旧引文', '复标改判', 'sample', 1, 3, '更早的引文', 200, 300),
               ('s-b', 1, NULL, 1, NULL, NULL, 'spot', 1, NULL, NULL, 400, 400);
        PRAGMA user_version = 7;
      `)
      raw.close()
    }
    const s = openStore(file)
    assert.equal(s.schemaVersion(), 9, 'v7 → v8')
    const rows = s.listTurnAlignments()
    assert.equal(rows.length, 3, '旧行一个不丢')
    const r1 = rows.find((r) => r.session === 's-a' && r.turn === 1)
    assert.equal(r1.align, null, '旧行 align 为 NULL（未迁移成对齐分）')
    assert.equal(r1.schemaVersion, 1, '旧行 version=1 —— 与新量表分层，永不合并统计')
    assert.equal(r1.boundary, 'none', 'boundary 补默认值 none')
    assert.equal(r1.quote, null)
    const r2 = rows.find((r) => r.session === 's-a' && r.turn === 2)
    assert.equal(r2.quote, '旧引文'); assert.equal(r2.note, '复标改判'); assert.equal(r2.origin, 'sample')
    const r3 = rows.find((r) => r.session === 's-b')
    assert.equal(r3.exempt, 1, '豁免行保持豁免')
    // 分布分层：3 条旧行全部计入 legacyFitRows，aligned = 0
    const cov0 = s.turnAlignmentCoverage()
    assert.deepEqual({ total: cov0.total, aligned: cov0.aligned, legacyFitRows: cov0.legacyFitRows }, { total: 3, aligned: 0, legacyFitRows: 3 })
    // 新量表写入 + 覆盖成对
    assert.equal(s.upsertTurnAlignment({ session: 's-a', turn: 1, align: 4, exempt: 0, boundary: 'none', quote: '「把问题推深的那句」', note: null, origin: 'spot' }), 'overwritten', '同一轮覆盖旧行')
    assert.equal(s.upsertTurnAlignment({ session: 's-c', turn: 1, align: 5, exempt: 0, boundary: 'projection', quote: '他引用了我那句', note: '越界一次', origin: 'sample' }), 'inserted')
    const after = s.listTurnAlignments().find((r) => r.session === 's-a' && r.turn === 1)
    assert.equal(after.align, 4); assert.equal(after.schemaVersion, 2)
    // 代际分层：align 行不得携带 fit；旧 fit 挪进 fit_prev（成对数据，AL.5 用）
    const rawRow = new DatabaseSync(file).prepare('SELECT fit, fit_prev FROM turn_annotation WHERE session = ? AND turn = 1').get('s-a')
    assert.equal(rawRow.fit, null, 'align 行的 fit 必须清空（CHECK 强制代际互斥）')
    assert.equal(rawRow.fit_prev, 3, '旧契合分挪入 fit_prev，不丢')
    const cov = s.turnAlignmentCoverage()
    assert.equal(cov.aligned, 2); assert.equal(cov.legacyFitRows, 2, '被覆盖的那条已转 v2，剩下两条仍是旧行')
    assert.equal(cov.byAlign['4'], 1); assert.equal(cov.byAlign['5'], 1)
    assert.equal(cov.byBoundary.projection, 1, '边界计数正交于分数')
    // 代际分层纪律：豁免计数**只认新量表行**——旧行的 N/A 已计入 legacyFitRows，不混算
    assert.equal(cov.exempted, 0, '旧行的豁免不进新口径')
    assert.equal(s.upsertTurnAlignment({ session: 's-d', turn: 1, align: null, exempt: 1, boundary: 'none', quote: null, note: null, origin: 'spot' }), 'inserted', 'N/A 豁免行（纯操作性轮）')
    const cov2 = s.turnAlignmentCoverage()
    assert.deepEqual({ total: cov2.total, aligned: cov2.aligned, exempted: cov2.exempted, legacyFitRows: cov2.legacyFitRows }, { total: 5, aligned: 2, exempted: 1, legacyFitRows: 2 }, '五条 = 2 新对齐 + 1 新豁免 + 2 旧契合')
    s.close()
  } finally { cleanup(tmp) }
})

test('AL.2 v8 CHECK 三门：align 1–5 越界拒 / 4 与 5 无引文拒 / exempt 与 align 互斥 / boundary 枚举', () => {
  const tmp = tmpDir('nautilus-v8c-')
  try {
    const db = openStore(join(tmp, 'n.db'))
    db.close()
    const raw = new DatabaseSync(join(tmp, 'n.db'))
    const ins = (cols) => raw.prepare(`INSERT INTO turn_annotation (session, turn, align, exempt, boundary, quote, origin, schema_version, annotated_at, updated_at) VALUES (?,?,?,?,?,?,?,2,1,1)`)
      .run(...cols)
    assert.throws(() => ins(['x', 1, 0, 0, 'none', null, 'spot']), /CHECK/i, 'align=0 越界（量表 1–5）')
    assert.throws(() => ins(['x', 2, 6, 0, 'none', null, 'spot']), /CHECK/i, 'align=6 越界')
    assert.throws(() => ins(['x', 3, 4, 0, 'none', null, 'spot']), /CHECK/i, 'align=4 无引文（签-2）')
    assert.throws(() => ins(['x', 4, 5, 0, 'none', null, 'spot']), /CHECK/i, 'align=5 无引文（签-2）')
    assert.throws(() => ins(['x', 5, 3, 1, 'none', null, 'spot']), /CHECK/i, 'exempt 与 align 互斥')
    assert.throws(() => ins(['x', 6, 3, 0, 'weird', null, 'spot']), /CHECK/i, 'boundary 枚举')
    ins(['x', 7, 4, 0, 'coercion', '引文', 'spot'])
    ins(['x', 8, 5, 0, 'substitution', '引文', 'spot'])
    ins(['x', 9, null, 1, 'none', null, 'spot'])
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM turn_annotation').get().n, 3, '合法三种形态都收')
    // selfcheck_record 新列（AL.3 才写入，AL.2 只证明列在位且 receive 留而未用）
    const cols = raw.prepare('PRAGMA table_info(selfcheck_record)').all().map((c) => c.name)
    for (const c of ['align', 'boundary', 'self_align', 'evidence', 'rubric_version', 'receive']) {
      assert.ok(cols.includes(c), 'selfcheck_record 缺列：' + c)
    }
    raw.close()
  } finally { cleanup(tmp) }
})

// ── AL.3 自评通道换 al-v1 对齐量表（工具面 = rubric 注入面 + 双形 ingest）─────────────

const SC_COLS = 'ts_ms, ts_client, schema_version, source_kind, agent, model, workspace, ext_ref, turn_ordinal, clarity, defense, declaration, quote, align, boundary, self_align, evidence, rubric_version, receive'

/** 开一个只读旁证连接（外部世界断言：不信被测代码的自报计数）。 */
function rawCount(file, where = '') {
  const db = new DatabaseSync(file)
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM selfcheck_record' + where).get().n) } finally { db.close() }
}

test('AL.3 工具面：align 必填 1–5 + boundary 四边界枚举 + description 逐字含锁版锚文与边界英文', () => {
  const store = openStore(':memory:')
  try {
    const tool = buildSelfCheckTool(store)
    assert.equal(tool.name, 'record_turn_selfcheck')
    assert.deepEqual(tool.parameters.required, ['align'], 'align 必填；boundary/declaration 走锁版缺省')
    assert.equal(tool.parameters.additionalProperties, false)
    const align = tool.parameters.properties.align
    assert.equal(align.type, 'integer'); assert.equal(align.minimum, 1); assert.equal(align.maximum, 5)
    assert.deepEqual(tool.parameters.properties.boundary.enum, ['none', 'substitution', 'possession', 'coercion', 'projection'])
    assert.equal(tool.parameters.properties.quote.maxLength, QUOTE_MAX)
    assert.equal(tool.parameters.properties.evidence.maxLength, EVIDENCE_MAX)
    // 注入面（§2.4）：锁版定义句 + 1–5 各档关键句
    for (const s of [
      '对齐 = 在「接→顺→推」的校准回路上推进了对方真正的问题，且没有越过四条边界。',
      '1 = 没接住', '2 = 接住了但没延展', '3 = 接+顺一层', '4 = 顺+推', '5 = 推到了改变下一步动作',
    ]) assert.ok(tool.description.includes(s), '注入面缺锚文：' + s)
    // 四条边界的英文枚举（模型要能把越界项直接填进 boundary）
    for (const b of ['substitution', 'possession', 'coercion', 'projection']) {
      assert.ok(tool.description.includes(b), '注入面缺边界英文：' + b)
      assert.ok(tool.parameters.properties.boundary.enum.includes(b), 'boundary 枚举缺项：' + b)
    }
  } finally { store.close() }
})

test('AL.3 硬门：align≥4 无引文 / declaration=1 无引文 / align 越界 → 拒且零写入（行数不变）', () => {
  const tmp = tmpDir('nautilus-al3-gate-')
  try {
    const file = join(tmp, 'n.db')
    const store = openStore(file)
    assert.equal(rawCount(file), 0, '前置：空库')
    // 拒绝即零写入（D-SC2 先例）：三条硬门逐条试，行数必须始终为 0
    for (const input of [{ align: 4 }, { align: 5 }, { align: 3, declaration: 1 }]) {
      const msg = processSelfCheck(store, { ...input, session: 's-1', turn: 1 })
      assert.ok(msg.startsWith('自评被拒'), '硬门必须显式拒：' + JSON.stringify(input))
      assert.equal(rawCount(file), 0, '硬门拒绝后 selfcheck_record 行数必须不变：' + JSON.stringify(input))
    }
    // align 越界（0 / 6 / 非整数）→ 拒（不夹取、不猜默认）
    for (const align of [0, 6, 3.5]) {
      assert.ok(processSelfCheck(store, { align, session: 's-1', turn: 1 }).startsWith('自评被拒'), '越界必须拒：align=' + String(align))
      assert.equal(rawCount(file), 0, '越界不得写入：align=' + String(align))
    }
    assert.equal(store.countSelfCheckRecords(), 0, '两条读数口径一致：零写入')
    store.close()
  } finally { cleanup(tmp) }
})

test('AL.3 正路：align=4 + quote 落库——align/boundary/rubric_version 正确，clarity/defense 为 NULL', () => {
  const tmp = tmpDir('nautilus-al3-ok-')
  try {
    const file = join(tmp, 'n.db')
    const store = openStore(file)
    const quote = '你把它写成了「人应该成为什么」，而不是准则本身'
    const msg = processSelfCheck(store, { align: 4, boundary: 'projection', quote, evidence: '第四条边界的判读依据', session: 's-1', turn: 7 })
    assert.ok(msg.startsWith('已记录 turn 7 自评'), msg)
    assert.equal(rawCount(file), 1, '正路必须恰好落一行')
    const raw = new DatabaseSync(file)
    const row = raw.prepare('SELECT ' + SC_COLS + ' FROM selfcheck_record').get()
    assert.equal(row.align, 4)
    assert.equal(row.boundary, 'projection', '越界项如实落库（正交轴）')
    assert.equal(row.rubric_version, RUBRIC_VERSION)
    assert.equal(row.rubric_version, 'al-v1')
    assert.equal(row.clarity, null, 'AL.3：新路径 clarity 留 NULL（v9 已允许，不造假值）')
    assert.equal(row.defense, null, 'AL.3：新路径 defense 留 NULL')
    assert.equal(row.declaration, 0, '缺省 declaration=0')
    assert.equal(row.quote, quote)
    assert.equal(row.evidence, '第四条边界的判读依据')
    assert.equal(row.schema_version, 2, 'align 行 = 1–5 量表代际（同 turn_annotation 的 align 行）')
    assert.equal(row.source_kind, 'dsh_tool')
    assert.equal(row.agent, 's-1'); assert.equal(row.ext_ref, 's-1'); assert.equal(row.turn_ordinal, 7)
    assert.equal(row.self_align, null); assert.equal(row.receive, null, 'receive 语义未定（OQ-AL1）——不写')
    raw.close(); store.close()
  } finally { cleanup(tmp) }
})

test('AL.3 双形兼容：旧形 payload 仍落库且 clarity 有值；新形落 al-v1——两代分层不混算', () => {
  const tmp = tmpDir('nautilus-al3-dual-')
  try {
    const file = join(tmp, 'n.db')
    const store = openStore(file)
    // 旧形（S1.1 三行，老 harness 走 HTTP 的形状）
    assert.deepEqual(
      ingestSelfCheck(store, { sourceKind: 'http', agent: 'harness-old', extRef: 'conv-legacy', turnOrdinal: 1, clarity: 0.42, defense: 'light', declaration: 0 }),
      { ok: true, result: 'inserted' },
    )
    // 新形（al-v1 对齐量表）
    assert.deepEqual(
      ingestSelfCheck(store, { sourceKind: 'http', agent: 'harness-new', extRef: 'conv-new', turnOrdinal: 1, align: 3, declaration: 0 }),
      { ok: true, result: 'inserted' },
    )
    assert.equal(rawCount(file), 2)
    const raw = new DatabaseSync(file)
    const old = raw.prepare('SELECT ' + SC_COLS + ' FROM selfcheck_record WHERE ext_ref = ?').get('conv-legacy')
    assert.equal(old.clarity, 0.42, '旧形 clarity 必须有值（老通道不断线）')
    assert.equal(old.defense, 'light')
    assert.equal(old.align, null); assert.equal(old.boundary, null); assert.equal(old.rubric_version, null)
    assert.equal(old.schema_version, 1)
    const neu = raw.prepare('SELECT ' + SC_COLS + ' FROM selfcheck_record WHERE ext_ref = ?').get('conv-new')
    assert.equal(neu.align, 3); assert.equal(neu.boundary, 'none'); assert.equal(neu.rubric_version, 'al-v1')
    assert.equal(neu.clarity, null); assert.equal(neu.defense, null)
    assert.equal(neu.schema_version, 2)
    raw.close(); store.close()
  } finally { cleanup(tmp) }
})

test('AL.3 覆盖语义：同 (source_kind, ext_ref, turn_ordinal) 重投 → duplicate、行数不增、整行换维度', () => {
  const tmp = tmpDir('nautilus-al3-ovw-')
  try {
    const file = join(tmp, 'n.db')
    const store = openStore(file)
    const key = { sourceKind: 'http', agent: 'h', extRef: 'c-1', turnOrdinal: 5 }
    assert.equal(ingestSelfCheck(store, { ...key, clarity: 0.5, defense: 'none', declaration: 0 }).result, 'inserted')
    assert.equal(ingestSelfCheck(store, { ...key, clarity: 0.8, defense: 'heavy', declaration: 0 }).result, 'duplicate')
    assert.equal(rawCount(file), 1, '同键重投 = 修正覆盖，不得双写')
    const raw = new DatabaseSync(file)
    assert.equal(raw.prepare('SELECT clarity FROM selfcheck_record').get().clarity, 0.8, 'last-writer-wins')
    // 新形覆盖旧形：整行换维度——旧列清空（同带 clarity 与 align 的行会让两代混算）
    assert.equal(ingestSelfCheck(store, { ...key, align: 5, quote: '他引用了我那句', declaration: 0 }).result, 'duplicate')
    assert.equal(rawCount(file), 1, '换维度覆盖也不得双写')
    const alRow = raw.prepare('SELECT ' + SC_COLS + ' FROM selfcheck_record').get()
    assert.equal(alRow.align, 5); assert.equal(alRow.quote, '他引用了我那句')
    assert.equal(alRow.clarity, null); assert.equal(alRow.defense, null); assert.equal(alRow.rubric_version, 'al-v1')
    // 反向：旧形覆盖新形 → al-v1 列一并清空
    assert.equal(ingestSelfCheck(store, { ...key, clarity: 0.2, defense: 'none', declaration: 0 }).result, 'duplicate')
    const back = raw.prepare('SELECT ' + SC_COLS + ' FROM selfcheck_record').get()
    assert.equal(back.clarity, 0.2); assert.equal(back.align, null); assert.equal(back.boundary, null)
    assert.equal(back.rubric_version, null, '旧形行不得带 al-v1 版本号')
    assert.equal(rawCount(file), 1)
    raw.close(); store.close()
  } finally { cleanup(tmp) }
})

