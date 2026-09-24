/**
 * @dsh-external/dsh-nautilus — AL 系列（对齐体系重构）回归测试 + 结构守卫。
 *
 * 内容：
 *  · AL.6 边界守卫：`src/nexus/**` 自包含、只在 src/nexus 下、两腿互不 import（决策 §7.2）。
 *  · AL.2 迁移账本与 v8 迁移：按序应用 / 跳号如实记录 / 幂等 / 旧契合行一个不丢 / 1–5 与边界 CHECK。
 *  · AL.3 自评通道换 al-v1 对齐量表：工具面 = rubric 注入面 / 硬门零写入 / 双形 ingest / 覆盖语义。
 *  · AL.4a 收敛守卫：假设/预言/工作区指向零残留（源码级）+ 抽样生成器不再查已删的 store.lfieldRoot。
 *  · AL.4b 对齐读侧：GET /m2/alignments 契约形状 / 同源门与方法门 / 覆盖与一致性数字 / 口径单点守卫；
 *    v2 增量：scale.min（阈值单点）· selfTotal/selfRatio（selfTotal=0 → null）· legacySelfRows（与 human 侧各自独立计数）·
 *    consistency.holdout（与 AL.5 脚本同库逐字相同）· self[] 只含 al-v1 行（代际行只计数）。
 *  · AL.4 写路径：POST /m2/turn-annotations 双形（body 有 align/boundary 键 → 对齐 1–5 与豁免；否则旧 fit 0–4
 *    逐字不变）· 硬门零写入（align≥4 无引文）· 新量表豁免判据（不再掉进 legacyFitRows 的代际错判）·
 *    契约 v3 的 human[] 收豁免行（humanAligned/exempted 语义不变）。
 * 已知例外（记在案）：`../store.js` 允许 nexus import——数据核心仍共享，真正抽离属 OQ-AL4。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runMigrations, readUserVersion } from '../lib/migrations.js'
import { openStore } from '../lib/store.js'
import { processSelfCheck, buildSelfCheckTool } from '../lib/nexus/selfcheck.js'
import { ingestSelfCheck, QUOTE_MAX, EVIDENCE_MAX, RUBRIC_VERSION } from '../lib/nexus/selfcheck-ingest.js'
import { MIN_PAIRS } from '../lib/nexus/consistency.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')
const NEXUS_MODULES = ['analysis.ts', 'consistency.ts', 'selfcheck-ingest.ts', 'selfcheck.ts', 'turns.ts']
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

// ── AL.4a 收敛守卫：假设 / 预言 / 工作区指向零残留 ────────────────────────────

test('AL.4a 源码守卫：假设/预言/工作区指向在 src/client/** 与 src/routes.ts 零残留', () => {
  // 作用域（守谷人 2026-09-28 裁决，逐条写明理由）：
  //  · src/client/** + src/routes.ts：断「零残留」，无例外；
  //  · src/store.ts：只断方法已删——表名与迁移体字符串**必须保留**（红线 3：表一律不 drop），故不 grep 字符串；
  //  · src/index.ts：**显式豁免**。那里的 `lField` 是 Config 公开字段名（lField.enabled / lField.historyDays），
  //    删或改名等于改破坏性配置面（需同步 schema / README 双语 / 部署侧 cordis.yml），
  //    且该文件当时由主线 AL.3 执行者并行编辑——列为独立改动，由主线收敛时统一改名。
  const FORBIDDEN = ['PROPHECY_SEED', 'lfield', 'Lfield', '/m2/annotations', 'L 场', 'HypothesesView', 'ProphecyView', 'AnnotationsState', 'prophecy']
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : (d.name.endsWith('.ts') ? [join(dir, d.name)] : []))
  const files = [...walk(join(SRC, 'client')), join(SRC, 'routes.ts')]
  assert.ok(files.length >= 3, '守卫样本太少，路径可能写错：' + String(files.length))
  const hits = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const token of FORBIDDEN) {
      if (text.includes(token)) hits.push(f.replace(REPO, '') + ' 命中 ' + token)
    }
  }
  assert.deepEqual(hits, [], '假设/预言/工作区指向残留：\n' + hits.join('\n'))
})

test('AL.4a store 守卫：标注与指向的读写方法已删，表名与迁移体仍保留', () => {
  const text = readFileSync(join(SRC, 'store.ts'), 'utf8')
  for (const m of ['listAnnotations', 'upsertAnnotation', 'lfieldRoot', 'setLfieldRoot', 'sessionRootCounts']) {
    assert.ok(!text.includes(m), 'store.ts 仍残留已删方法：' + m)
  }
  // 反向守卫：撤方法不等于删表——DDL 与迁移体必须原样在场（红线 3，历史数据不删）
  for (const keep of [
    'CREATE TABLE IF NOT EXISTS lfield_config',
    'CREATE TABLE IF NOT EXISTS session_root',
    'INSERT OR IGNORE INTO lfield_config',
  ]) {
    assert.ok(text.includes(keep), 'store.ts 丢了必须保留的 DDL/迁移体：' + keep)
  }
})

test('AL.4a 回归：抽样生成器不再查已删的 store.lfieldRoot——默认入参（CLI 不传 --root）必须可跑', async () => {
  // 回归根因：AL.4a 删了 store.lfieldRoot()，而 buildPool 的默认分支（旧 rootMode='pointed'）还在查它
  // → 不带 --root=all 直接 TypeError。此例打的就是「默认入参」这条 CLI 真实路径。
  const { buildPool } = await import('./annotation-sample.mjs')
  const store = openStore(':memory:')
  try {
    assert.equal(typeof store.lfieldRoot, 'undefined', '前置：store.lfieldRoot 已删（回归的根因）')
    store.upsertTurnRead({ session: 's-1', turn: 1, ts: Date.now(), question: 'q', tokenIn: 1, tokenOut: 1, cacheRead: 0, durationMs: 10 })
    store.upsertUserText('s-1', 1, '问')
    store.appendAssistantText('s-1', 1, '答')
    const { pool, root } = buildPool(store, { kind: 'sample' })
    assert.equal(pool.length, 1, '默认入参必须取到全局池（旧代码在此 TypeError）')
    assert.equal(root, undefined, 'root 恒 undefined = 全局口径')
    assert.equal(buildPool(store, { kind: 'recheck' }).pool.length, 0, 'recheck 默认入参同样可跑')
  } finally { store.close() }
  // 源码守卫：不查已删方法、不再有「指向 / 全局」分支（rootMode 仅作 --root 的取值变量，走响亮失败）
  const text = readFileSync(join(REPO, 'scripts', 'annotation-sample.mjs'), 'utf8')
  assert.ok(!text.includes('lfieldRoot'), '生成器仍查已删的 store.lfieldRoot')
  assert.ok(!/rootMode === 'all' \?/.test(text), '生成器仍有指向/全局分支（root 必须恒 undefined）')
})

test('AL.4a 保留面守卫：曲线 / 白盒 analysis / 自评 ingest 未被误删', () => {
  // 「只做减法」的反向保险：撤两项时最容易顺手删掉共享的 analysis 与曲线取数
  const wb = readFileSync(join(SRC, 'client', 'workbench.ts'), 'utf8')
  for (const keep of ['CurveView', 'curveValue', 'curveLabel', 'SHAPE_LABEL', 'AnalysisRow', 'selfcheck']) {
    assert.ok(wb.includes(keep), 'workbench.ts 丢了保留面：' + keep)
  }
  const rt = readFileSync(join(SRC, 'routes.ts'), 'utf8')
  for (const keep of ['/m2/state', '/m2/analysis', '/m2/turn-text', '/selfcheck', '/m2/turn-annotations']) {
    assert.ok(rt.includes(keep), 'routes.ts 丢了保留路由：' + keep)
  }
})
// ── AL.4b 对齐视图：SSR 渲染 + 源码守卫（契约 = 主线冻结的 /m2/alignments）────────

/** 假数据（fixture 驱动，不依赖真路由存在）：覆盖双路台账 / 分布 / 边界 / 一致性 / 代际隔离。 */
const AL_FIXTURE = {
  revision: 1,
  scale: {
    schemaVersion: 2,
    rubricVersion: 'al-v1',
    min: 50,
    anchors: [
      { score: 1, text: '1 = 没接住（绕开对方状态、答非所问）' },
      { score: 2, text: '2 = 听到了但只做了字面回应' },
      { score: 3, text: '3 = 接住了，推进有限' },
      { score: 4, text: '4 = 顺着对方状态把问题推深' },
      { score: 5, text: '5 = 推到了改变下一步动作' },
    ],
  },
  coverage: {
    humanTotal: 7, humanAligned: 6, exempted: 1, legacyFitRows: 3,
    byAlign: { '1': 1, '2': 0, '3': 2, '4': 2, '5': 1 },
    byBoundary: { none: 3, substitution: 1, possession: 1, coercion: 0, projection: 1 },
    selfTotal: 20, selfAligned: 5, selfRatio: 0.25,
    selfByAlign: { '1': 0, '2': 1, '3': 1, '4': 2, '5': 1 },
    legacySelfRows: 2,
  },
  // 契约实测：human[] **只含 align 非空行**——豁免行进 coverage.exempted、旧行进 legacyFitRows，都不进数组。
  // （视图对 align:null 有兜底，但 fixture 必须按契约造，否则测的是不存在的形状。）
  human: [
    { session: 'session-aaaa1111', turn: 3, align: 4, boundary: 'none', exempt: 0, quote: '把问题推深的那句', note: null, origin: 'spot', schemaVersion: 2, annotatedAt: 1000, updatedAt: 2000 },
    { session: 'session-cccc3333', turn: 2, align: 5, boundary: 'projection', exempt: 0, quote: '他引用了我那句', note: null, origin: 'sample', schemaVersion: 2, annotatedAt: 1700, updatedAt: 1800 },
  ],
  self: [
    { extRef: 'session-aaaa1111', turnOrdinal: 3, align: 3, boundary: 'substitution', declaration: 0, quote: null, evidence: '自评依据', rubricVersion: 'al-v1', tsMs: 2100, agent: 'dsh' },
    { extRef: 'session-cccc3333', turnOrdinal: 2, align: 5, boundary: 'projection', declaration: 0, quote: null, evidence: null, rubricVersion: 'al-v1', tsMs: 1900, agent: 'dsh' },
    { extRef: 'session-dddd4444', turnOrdinal: 1, align: 2, boundary: 'possession', declaration: 0, quote: null, evidence: null, rubricVersion: 'al-v1', tsMs: 1200, agent: 'dsh' },
  ],
  consistency: { pairs: 2, exact: 0.5, near: 1, kappa: 0.615, holdout: { pairs: 1, exact: 1, near: 1, kappa: null } },
}

/** 客户端半区是 TS：按 test.mjs 同款姿势 esbuild 打临时 ESM（react 必须 external，否则两份实例）。 */
async function withWorkbenchClient(fn) {
  const esbuild = await import('esbuild')
  const react = await import('react')
  const rds = await import('react-dom/server')
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(repo, '.align-smoke-'))
  const out = join(dir, 'wb.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL('../src/client/workbench.ts', import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    })
    const wb = await import(pathToFileURL(out).href)
    return await fn({ wb, react, h: rds.renderToStaticMarkup })
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

test('AL.4b 对齐视图 SSR：双路台账 / 分布 / 边界 / 一致性 / 版本面（fixture 不依赖真路由）', async () => {
  await withWorkbenchClient(async ({ wb, react, h }) => {
    assert.equal(typeof wb.AlignmentsView, 'function', '对齐视图必须导出')
    const html = h(react.createElement(wb.AlignmentsView, { align: AL_FIXTURE }))
    // ① 双路台账：同轮并列 + Δ = 自评 − 人工 + 只有一侧也列出（不补齐）
    // 轮次列 = 会话短 id + turn（B5：不再带 tNN 角标）
    for (const s of ['双路台账', 'aaaa1111 · 3', 'cccc3333 · 2', 'dddd4444 · 1', '把问题推深的那句']) {
      assert.ok(html.includes(s), '台账缺内容: ' + s)
    }
    assert.ok(!/>t\d+</.test(html), 'B5：台账不得出现 tNN 角标')
    assert.ok(html.includes('豁免 1'), '豁免计数只在覆盖率里（human[] 按契约不含豁免行）')
    assert.ok(html.includes('title="Δ = 自评 − 人工">-1</td>'), 'aaaa1111 t3：Δ = 3 − 4 = −1')
    assert.ok(html.includes('title="Δ = 自评 − 人工">0</td>'), 'cccc3333 t2：Δ = 5 − 5 = 0')
    // ② 锚文进 title（来源 scale.anchors）
    assert.ok(html.includes('title="5 = 推到了改变下一步动作"'), '锚文必须进 hover title')
    assert.ok(html.includes('title="align 4 · 4 = 顺着对方状态把问题推深"'), '台账分数格的 title 也要带锚文')
    // ③ 分布：两组独立柱 + 代际行隔离
    for (const s of ['分布（align 1–5）', '人工（6 行有分）', '自评（5 行有分）', '旧 0–4 档行', '不混算']) {
      assert.ok(html.includes(s), '分布缺内容: ' + s)
    }
    // ④ 边界：五类中文计数（正交轴）
    for (const s of ['边界计数（正交轴）', '<td>替代</td>', '<td>占有</td>', '<td>强迫</td>', '<td>投射</td>']) {
      assert.ok(html.includes(s), '边界缺内容: ' + s)
    }
    // ⑤ 一致性：聚合 + **留出集（采纳判据）** 两行 + 样本不足纪律（pairs=2 < 契约 scale.min=50）
    for (const s of ['<th>口径</th>', '全部配对', '留出集（采纳判据）', '50.0%', '100.0%', '0.615', '只作观察，不得据此调整 rubric', '阈值取自契约 scale.min']) {
      assert.ok(html.includes(s), '一致性缺内容: ' + s)
    }
    // ⑥ v2 覆盖三件套：真比率 / 代际两侧各自独立计数
    for (const s of ['25.0%', '自评 5 / 全局 20 轮', '人工 3 · 自评 2 行']) assert.ok(html.includes(s), 'v2 覆盖缺内容: ' + s)
    // ⑦ 版本面 + 术语纪律
    for (const s of ['schema_version=2', 'rubric_version=al-v1']) assert.ok(html.includes(s), '版本面缺内容: ' + s)
    assert.ok(!html.includes('契合'), '对齐视图不得出现已废止术语「契合」')
  })
})

test('AL.4b 对齐视图：consistency=null → 样本不足；接口缺席 → 显式缺席（都不写 0）', async () => {
  await withWorkbenchClient(async ({ wb, react, h }) => {
    const none = h(react.createElement(wb.AlignmentsView, { align: { ...AL_FIXTURE, consistency: null } }))
    // 渲染层：React 会把 '<' 转义成 '&lt;'，故此处断语义文本；字面措辞由下面的源码守卫逐字校验
    assert.ok(none.includes('样本不足') && none.includes('一致性三指标不可计算'), '对数 <2 必须显示样本不足（而不是 0）')
    assert.ok(!none.includes('<th>口径</th>'), '不可计算时不得渲染三指标表（否则看起来像 0）')
    assert.ok(!none.includes('只作观察'), '无对数时不该出现采纳纪律提示（避免暗示有样本）')
    assert.ok(none.includes('双路台账'), '一致性缺席不影响台账照常呈现')
    const absent = h(react.createElement(wb.AlignmentsView, { align: null }))
    assert.ok(absent.includes('对齐接口不可用'), '接口缺席必须显式（不静默空白）')
    assert.ok(absent.includes('不写 0 假读数'), '缺席态口径')
  })
})

test('AL.4b 源码守卫：视图不自造接口 / 术语零残留 / 自评覆盖口径已换', () => {
  const wb = readFileSync(join(SRC, 'client', 'workbench.ts'), 'utf8')
  const start = wb.indexOf('// ── 视图：对齐台账')
  const end = wb.indexOf('// ── 根组件')
  assert.ok(start > 0 && end > start, '对齐视图切片锚点必须存在（注释被改名？）')
  const view = wb.slice(start, end)
  assert.ok(view.includes('export function AlignmentsView'), '切片必须含视图本体')
  assert.ok(!view.includes('契合'), '对齐视图不得出现已废止术语「契合」（代际行改称「旧 0–4 档行」）')
  const apis = [...new Set([...view.matchAll(/\/api\/[A-Za-z0-9/_-]+/g)].map((m) => m[0]))]
  assert.deepEqual(apis, ['/api/nautilus/m2/alignments'], '视图不得自造别的 API（读侧契约冻结）')
  // 接线：ViewKey 登记 / 总览之后 / 唯一取数口 / 视图分派
  assert.ok(wb.includes("alignments: '对齐'"), 'VIEW_LABEL 必须登记对齐')
  assert.ok(wb.includes("'overview', 'alignments', 'alerts'"), '顶栏 seg 位置：总览之后')
  assert.ok(wb.includes("useJson<AlignmentsState>('/api/nautilus/m2/alignments'"), '工作台取数口')
  assert.ok(wb.includes('createElement(AlignmentsView, { align: alignments })'), '视图分派')
  // 自评覆盖口径已换（真实回归：turn_read.clarity 自 AL.3 起停写，旧口径会静默停更）
  assert.ok(wb.includes('props.align.coverage.selfAligned'), '自评覆盖必须改读 alignments 的 self 计数')
  assert.ok(!wb.includes('selfcheck.checked'), '不得再读旧口径 selfcheck.checked')
  // 契约措辞逐字在场：pairs<2 时显示「样本不足（<2 对）」，不是 0
  assert.ok(wb.includes('样本不足（<2 对）'), '必须逐字显示「样本不足（<2 对）」')
  // AL.4c v2：阈值改读契约（不得再留本地常量）、留出集行、自评真比率与两侧代际计数
  assert.ok(!wb.includes('ALIGN_MIN_PAIRS'), '本地阈值常量必须撤除（改读契约 scale.min）')
  assert.ok(wb.includes('a.scale.min'), '阈值必须取自契约 scale.min（单点来源）')
  assert.ok(wb.includes('留出集（采纳判据）'), '一致性必须给出留出集行（决策 §5 采纳判据口）')
  assert.ok(wb.includes('c.selfRatio'), '自评覆盖必须读契约 selfRatio（真比率，selfTotal=0 时缺席）')
  assert.ok(wb.includes('c.legacySelfRows'), '代际隔离必须两侧各自独立计数')
  // A7 两句诚实声明：边界是描述性的、三指标只算 align
  assert.ok(wb.includes('边界计数是描述性的'), '边界面板必须声明「描述性」')
  assert.ok(wb.includes('口径仅 align，不含 boundary'), '一致性面板必须声明「只算 align」')
})
// ── AL.4b 对齐读侧（GET /m2/alignments：契约形状 / 覆盖与一致性数字 / 路径安全）──────────

const ALIGN_PATH = '/api/nautilus/m2/alignments'
const TURN_ANNOTATIONS_PATH = '/api/nautilus/m2/turn-annotations'
const TOP_KEYS = ['consistency', 'coverage', 'human', 'revision', 'scale', 'self']
const HUMAN_KEYS = ['align', 'annotatedAt', 'boundary', 'exempt', 'note', 'origin', 'quote', 'schemaVersion', 'session', 'turn', 'updatedAt']
const SELF_KEYS = ['agent', 'align', 'boundary', 'declaration', 'evidence', 'extRef', 'quote', 'rubricVersion', 'tsMs', 'turnOrdinal']

/**
 * 真实装配：临时 DSH_HOME + 真 ctx.plugin（不手挂路由——手动挂载绕过的正是 postmortem 0001 崩掉的那条路径）。
 * seed 在装配前落库（apply 自己会开同一个库文件）。
 * call 打**任意已注册路由**（path 指定；body 走同一只读流）——AL.4 写路径（POST）与读侧共用这一条真实装配。
 */
async function mountApi(seed) {
  const { Context } = await import('@deepseek-ai/cordis')
  const tmp = tmpDir('nautilus-al4b-')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  const file = join(tmp, 'nautilus', 'nautilus.db')
  if (seed !== undefined) { const s = openStore(file); seed(s, file); s.close() }
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  const routes = new Map()
  const ctx = new Context()
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => {} } })
  ctx.provide('tools', { register() {} })
  const fiber = ctx.plugin(mod, { pulse: { enabled: false } })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !routes.has(ALIGN_PATH)) await new Promise((r) => setTimeout(r, 25))
  const call = async (method, { path = ALIGN_PATH, sameOrigin = true, url = path, body } = {}) => {
    const h = routes.get(path)?.handler
    assert.equal(typeof h, 'function', '路由必须注册：' + path)
    const r = new Readable({ read() {} })
    r.method = method
    r.url = url
    r.headers = sameOrigin ? { 'sec-fetch-site': 'same-origin' } : {}
    if (body !== undefined) r.push(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'))
    r.push(null)
    const res = { statusCode: 0, body: null, writeHead(s) { this.statusCode = s }, end(t) { this.body = JSON.parse(String(t ?? '{}')) } }
    h(r, res)
    const dl = Date.now() + 3000
    while (Date.now() < dl && res.statusCode === 0) await new Promise((x) => setTimeout(x, 10))
    assert.notEqual(res.statusCode, 0, '路由未在 3s 内响应（挂起）：' + path)
    return res
  }
  const close = async () => {
    await fiber.dispose()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    cleanup(tmp)
  }
  return { call, close, routes, file }
}

/** AL.4b 读侧装配：固定打 /m2/alignments（既有用例的 call 形状保持不变）。 */
async function mountAlignRoutes(seed) {
  const m = await mountApi(seed)
  const route = m.routes.get(ALIGN_PATH)
  assert.equal(typeof route?.handler, 'function', 'AL.4b 路由必须注册：' + ALIGN_PATH)
  return { ...m, route, call: (method, opts) => m.call(method, { ...opts, path: ALIGN_PATH }) }
}

test('AL.4b 路由门与空库：同源 403 / 非 GET 405 / 空库结构齐备（consistency=null）', async () => {
  const m = await mountAlignRoutes()
  try {
    assert.equal(m.route.kind, 'exact', 'AL.4b 路由必须是 exact（不做前缀匹配）')
    assert.equal(m.routes.has(ALIGN_PATH + '/extra'), false, '子路径不得命中——路径安全')
    const noOrigin = await m.call('GET', { sameOrigin: false })
    assert.equal(noOrigin.statusCode, 403, '非同源必须 403')
    assert.equal(noOrigin.body.error, 'forbidden')
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const r = await m.call(method)
      assert.equal(r.statusCode, 405, method + ' 必须 405（只 GET）')
      assert.equal(r.body.error, 'method-not-allowed')
    }
    // 异常 url：本路由不解析 url，但**绝不许** 500（fail 路径收敛为结构化响应，不是抛异常）
    for (const url of [ALIGN_PATH + '?session=../../../../etc/passwd', ALIGN_PATH + '?%', 'http://evil.example' + ALIGN_PATH, '']) {
      const r = await m.call('GET', { url })
      assert.equal(r.statusCode, 200, '异常 url 不得 500：' + url)
      assert.deepEqual(Object.keys(r.body).sort(), TOP_KEYS)
    }
    const g = await m.call('GET')
    assert.equal(g.statusCode, 200)
    assert.deepEqual(Object.keys(g.body).sort(), TOP_KEYS, '顶层契约形状')
    assert.equal(typeof g.body.revision, 'number')
    assert.deepEqual(Object.keys(g.body.scale).sort(), ['anchors', 'min', 'rubricVersion', 'schemaVersion'])
    assert.equal(g.body.scale.schemaVersion, 2)
    assert.equal(g.body.scale.rubricVersion, 'al-v1')
    // v2：样本不足阈值从契约读（UI 删掉本地 ALIGN_MIN_PAIRS 常量，改读 scale.min）
    assert.equal(g.body.scale.min, MIN_PAIRS, 'v2：scale.min = 共享模块的样本不足阈值（单点来源）')
    assert.equal(g.body.scale.min, 50)
    assert.deepEqual(g.body.scale.anchors.map((a) => a.score), [1, 2, 3, 4, 5], '锚文 1–5 齐备')
    assert.deepEqual(Object.keys(g.body.scale.anchors[0]).sort(), ['score', 'text'])
    // 同源守卫：面板显示的锚文 = agent 看到的注入面（逐字同源，不各写一份）
    const tool = buildSelfCheckTool(openStore(':memory:'))
    for (const a of g.body.scale.anchors) {
      assert.ok(tool.description.includes(a.score + ' = ' + a.text), '锚文与工具注入面不一致：' + String(a.score))
    }
    assert.deepEqual(g.body.human, [])
    assert.deepEqual(g.body.self, [])
    assert.equal(g.body.consistency, null, '空库：配对 0 → consistency null（不给假读数）')
    assert.deepEqual({ ...g.body.coverage }, {
      humanTotal: 0, humanAligned: 0, exempted: 0, legacyFitRows: 0,
      byAlign: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      byBoundary: { none: 0, substitution: 0, possession: 0, coercion: 0, projection: 0 },
      selfTotal: 0, selfAligned: 0, selfRatio: null, selfByAlign: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      legacySelfRows: 0,
    })
    // v2 空库：分母为 0 → selfRatio **必须 null**（0/0 报 0 是假读数），且不许写成 0
    assert.equal(g.body.coverage.selfTotal, 0, '空库：turn_read 全局轮数 = 0')
    assert.equal(g.body.coverage.selfRatio, null, 'v2：selfTotal=0 → selfRatio null（不是 0）')
  } finally { await m.close() }
})

test('AL.4b 预置双路样本：覆盖数字正确（legacyFitRows 分层不混算）+ consistency 与手算一致', async () => {
  const m = await mountAlignRoutes((s, file) => {
    // 人工（新量表）：2 / 3 / 4 / 5 各一行（4、5 必附引文——CHECK 门）
    s.upsertTurnAlignment({ session: 's-1', turn: 1, align: 2, exempt: 0, boundary: 'none', quote: null, note: '接住无增量', origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-1', turn: 2, align: 3, exempt: 0, boundary: 'substitution', quote: null, note: null, origin: 'sample' })
    s.upsertTurnAlignment({ session: 's-2', turn: 1, align: 4, exempt: 0, boundary: 'none', quote: '「这句我抄进笔记了」', note: null, origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-2', turn: 2, align: 5, exempt: 0, boundary: 'possession', quote: '「他改道去查了那条引文」', note: null, origin: 'sample' })
    // 豁免行（N/A：不进 byAlign，也不进 self 台账）
    s.upsertTurnAlignment({ session: 's-3', turn: 2, align: null, exempt: 1, boundary: 'none', quote: null, note: '纯操作性指令轮', origin: 'spot' })
    // 旧契合行（0–4 代际）：只能直插；schema_version=1 + fit 才是合法旧行（红线 3：旧数据不删）
    const raw = new DatabaseSync(file)
    raw.prepare(`INSERT INTO turn_annotation
      (session, turn, fit, exempt, quote, note, origin, boundary, schema_version, annotated_at, updated_at)
      VALUES ('s-3', 1, 4, 0, '「旧尺子的引文」', NULL, 'spot', 'none', 1, 1, 1)`).run()
    raw.close()
    // 自评（dsh_tool，产出该轮的 agent）：与人工同键四行——2↔3 / 3↔3 / 4↔4 / 5↔5
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 1, align: 3, declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 2, align: 3, declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-2', extRef: 's-2', turnOrdinal: 1, align: 4, quote: '「我引用了他的判断」', declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-2', extRef: 's-2', turnOrdinal: 2, align: 5, quote: '「下一步动作改了」', declaration: 0 })
    // 干扰行（必须不进 self 台账）：① http 通道新形；② dsh_tool 旧三行（align NULL，代际分层）
    ingestSelfCheck(s, { sourceKind: 'http', agent: 'harness', extRef: 's-1', turnOrdinal: 1, align: 1, declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-9', extRef: 's-9', turnOrdinal: 1, clarity: 0.5, defense: 'none', declaration: 0 })
    // ③ v2 代际干扰行：dsh_tool + align 非空，但 rubric_version 早于 al-v1——
    //    只进 coverage.legacySelfRows 计数，**不得进 self[]**（直写以便构造非当期版本；ingest 只产 al-v1）
    s.insertSelfCheckRecord({
      tsMs: 1, tsClient: null, schemaVersion: 2, sourceKind: 'dsh_tool', agent: 's-9', model: null, workspace: null,
      extRef: 's-9', turnOrdinal: 2, clarity: null, defense: null, declaration: 0, quote: null,
      align: 4, boundary: 'none', evidence: null, rubricVersion: 'al-v0',
    })
    // v2 分母：turn_read 全局轮数（与 /m2/state 的 totals.turns 同式、不加 root）= 5 轮
    for (let t = 1; t <= 5; t++) {
      s.upsertTurnRead({ session: 's-1', turn: t, ts: 1_700_000_000_000 + t, question: 'q' + String(t), tokenIn: 1, tokenOut: 1, cacheRead: 0, durationMs: 10 })
    }
  })
  try {
    const g = await m.call('GET')
    assert.equal(g.statusCode, 200)
    const cov = g.body.coverage
    // humanTotal = **新量表**人工行数（有分 + 豁免，v8 CHECK 保证恰好二分）；旧契合行不进它、
    // 也不进 byAlign/byBoundary/humanAligned——只由 legacyFitRows 单列（分层不混算，§9.3）。
    assert.equal(cov.humanTotal, 5)
    assert.equal(cov.humanAligned, 4)
    assert.equal(cov.exempted, 1)
    assert.equal(cov.legacyFitRows, 1, '旧契合行单独成层')
    assert.equal(cov.humanTotal, cov.humanAligned + cov.exempted, 'humanTotal 恒等于 有分 + 豁免（旧行不混入）')
    assert.deepEqual(cov.byAlign, { 1: 0, 2: 1, 3: 1, 4: 1, 5: 1 })
    assert.deepEqual(cov.byBoundary, { none: 3, substitution: 1, possession: 1, coercion: 0, projection: 0 })
    assert.equal(cov.selfAligned, 4, 'self 只认 dsh_tool × align 非空 × rubric=al-v1（http 行 / 旧三行 / al-v0 行均排除）')
    assert.deepEqual(cov.selfByAlign, { 1: 0, 2: 0, 3: 2, 4: 1, 5: 1 })
    // v2：自评覆盖率（分子 = 当期代际自评行，分母 = turn_read 全局轮数）
    assert.equal(cov.selfTotal, 5, 'v2：selfTotal = turn_read 全局轮数（与 /m2/state 同式，无 root）')
    assert.equal(cov.selfRatio, 4 / 5, 'v2：selfRatio = selfAligned / selfTotal')
    assert.equal(cov.legacySelfRows, 2, 'v2：自评旧代际 = 旧三行(align NULL) 1 + rubric≠al-v1 的 1')
    assert.equal(cov.legacyFitRows, 1, 'human 侧旧契合行数不变')
    assert.notEqual(cov.legacySelfRows, cov.legacyFitRows, '两侧旧代际**各自独立计数**（不混算、不互相推算）')
    // 双路台账
    assert.equal(g.body.human.length, 5, 'v3：human[] 出**全部新量表行**（4 有分 + 1 豁免）；旧代际行不出场')
    assert.equal(g.body.human.filter((r) => r.align === null).length, 1, 'v3：豁免行以 align:null 入场（其余字段照旧）')
    assert.equal(g.body.human.length, cov.humanTotal, 'v3：human[] 与 humanTotal 同集合（旧代际仍只算 legacyFitRows）')
    assert.deepEqual(Object.keys(g.body.human[0]).sort(), HUMAN_KEYS, 'human 行契约形状')
    assert.equal(g.body.self.length, 4)
    assert.deepEqual(Object.keys(g.body.self[0]).sort(), SELF_KEYS, 'self 行契约形状')
    assert.deepEqual(g.body.self.map((x) => x.align).sort(), [3, 3, 4, 5])
    assert.ok(g.body.self.every((x) => x.rubricVersion === RUBRIC_VERSION), 'rubric_version 原样带出')
    assert.equal(g.body.self.filter((x) => x.rubricVersion !== RUBRIC_VERSION).length, 0, 'v2：self[] 不含 rubric_version ≠ al-v1 的行')
    assert.ok(!g.body.self.some((x) => x.extRef === 's-9'), 'v2：代际行（al-v0）只进 legacySelfRows，不出现在 self[]')
    assert.equal(g.body.self.filter((x) => x.turnOrdinal === 1).length, 2)
    // 一致性：4 对 (2,3)(3,3)(4,4)(5,5) → exact 3/4 · near 4/4 · κ = 1 − (1/16)/0.5 = 0.875
    assert.deepEqual(Object.keys(g.body.consistency).sort(), ['exact', 'holdout', 'kappa', 'near', 'pairs'])
    assert.deepEqual(Object.keys(g.body.consistency.holdout).sort(), ['exact', 'kappa', 'near', 'pairs'], 'v2：留出集四字段')
    // 确定性切分（FNV-1a % 5）：本 fixture 四对里 s-1:2 与 s-2:2 落留出集 —— 两对全对且边际有方差 → κ = 1
    assert.deepEqual(g.body.consistency.holdout, { pairs: 2, exact: 1, near: 1, kappa: 1 }, 'v2：holdout 与脚本同一份切分')
    assert.equal(g.body.consistency.pairs, 4)
    assert.equal(g.body.consistency.exact, 0.75)
    assert.equal(g.body.consistency.near, 1)
    assert.ok(Math.abs(g.body.consistency.kappa - 0.875) < 1e-12, '二次加权 κ = 0.875，实得 ' + String(g.body.consistency.kappa))
  } finally { await m.close() }
})

test('AL.4b 单对样本：pairs<2 → consistency null（一对恒「完全一致」，报出来是假读数）', async () => {
  const m = await mountAlignRoutes((s) => {
    s.upsertTurnAlignment({ session: 's-1', turn: 1, align: 3, exempt: 0, boundary: 'none', quote: null, note: null, origin: 'spot' })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 1, align: 3, declaration: 0 })
  })
  try {
    const g = await m.call('GET')
    assert.equal(g.statusCode, 200)
    assert.equal(g.body.coverage.humanTotal, 1)
    assert.equal(g.body.coverage.humanAligned, 1)
    assert.equal(g.body.coverage.selfAligned, 1)
    assert.equal(g.body.human.length, 1)
    assert.equal(g.body.self.length, 1)
    assert.equal(g.body.consistency, null)
  } finally { await m.close() }
})

test('AL.4b v2 留出集：路由 holdout 与 AL.5 脚本同库输出逐字相同（同一切分函数，禁第二份实现）', async () => {
  // 四对：s-1:1(3↔3) · s-1:2(2↔4) · s-2:1(4↔4) · s-2:2(5↔5)
  // 确定性切分（FNV-1a % 5 === 0）把 s-1:2 与 s-2:2 分进留出集——故意放一对不一致，让三指标都是真数字
  const m = await mountAlignRoutes((s) => {
    s.upsertTurnAlignment({ session: 's-1', turn: 1, align: 3, exempt: 0, boundary: 'none', quote: null, note: null, origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-1', turn: 2, align: 2, exempt: 0, boundary: 'substitution', quote: null, note: null, origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-2', turn: 1, align: 4, exempt: 0, boundary: 'none', quote: '「人工引文一」', note: null, origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-2', turn: 2, align: 5, exempt: 0, boundary: 'possession', quote: '「人工引文二」', note: null, origin: 'sample' })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 1, align: 3, declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 2, align: 4, quote: '「自评引文一」', declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-2', extRef: 's-2', turnOrdinal: 1, align: 4, quote: '「自评引文二」', declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-2', extRef: 's-2', turnOrdinal: 2, align: 5, quote: '「自评引文三」', declaration: 0 })
  })
  try {
    const g = await m.call('GET')
    assert.equal(g.statusCode, 200)
    const ho = g.body.consistency.holdout
    assert.equal(ho.pairs, 2, '确定性切分：s-1:2 与 s-2:2 落留出集（hash(session:turn)%5===0）')
    assert.equal(ho.exact, 0.5)
    assert.equal(ho.near, 0.5)
    assert.ok(Math.abs(ho.kappa - 3 / 7) < 1e-12, '留出集二次加权 κ = 3/7，实得 ' + String(ho.kappa))
    // 脚本同库跑一遍：holdout 四指标必须逐字相同（两边都走 lib/nexus/consistency.js 的 splitHoldout + metrics）
    const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'alignment-consistency.mjs'), '--db', m.file, '--json'], { encoding: 'utf8' })
    const script = JSON.parse(out)
    assert.deepEqual(
      { pairs: script.holdout.n, exact: script.holdout.exact, near: script.holdout.near, kappa: script.holdout.kappa },
      ho,
      '同一库上路由 holdout 与脚本输出必须逐字相同',
    )
    assert.equal(script.pairs, g.body.consistency.pairs, '全部配对数也同源')
    assert.equal(script.holdoutEvery, 5, '切分除数走共享模块默认值')
    assert.equal(script.min, g.body.scale.min, 'v2：阈值单点——脚本 --min 默认值与 scale.min 同源')
    assert.equal(script.legacySelfRows, g.body.coverage.legacySelfRows, '代际计数同判据')
  } finally { await m.close() }
})

test('AL.4b 口径守卫：一致性只有一份实现——脚本 import 共享模块，不得内联第二套', () => {
  const text = readFileSync(join(REPO, 'scripts', 'alignment-consistency.mjs'), 'utf8')
  assert.ok(text.includes("from '../lib/nexus/consistency.js'"), '脚本必须 import 构建产物 lib/nexus/consistency.js')
  for (const fn of ['pairAlignments(', 'metrics(', 'splitHoldout(']) {
    assert.ok(text.includes(fn), '脚本必须走共享模块入口：' + fn)
  }
  for (const bad of ['function metrics', 'function bucketOf', 'Math.pow(i - j, 2)']) {
    assert.ok(!text.includes(bad), '脚本仍内联了第二套口径：' + bad)
  }
  // v2：切分数与样本阈值也只许来自共享模块（脚本里不得再出现 5 / 50 这类常量，rubric 版本同理）
  for (const need of ['HOLDOUT_EVERY', 'MIN_PAIRS', 'RUBRIC_VERSION', "from '../lib/nexus/selfcheck-ingest.js'"]) {
    assert.ok(text.includes(need), '脚本必须从共享模块取：' + need)
  }
  for (const bad of ['holdout: 5', 'min: 50', "'al-v1'"]) {
    assert.ok(!text.includes(bad), '脚本仍写死了第二份常量：' + bad)
  }
  // 适配层必须在：SQL 行是 snake_case，共享模块要 camelCase——漏映射会静默配出 0 对（实测踩到）
  for (const need of ['extRef: String(r.ext_ref)', 'turnOrdinal: Number(r.turn_ordinal)']) {
    assert.ok(text.includes(need), '脚本缺 SQL→领域形状的映射：' + need)
  }
  // 路由侧同样只用共享模块（不自己算 κ）
  const rt = readFileSync(join(SRC, 'routes.ts'), 'utf8')
  assert.ok(rt.includes("from './nexus/consistency.js'"), '路由必须 import 共享一致性模块')
  assert.ok(!rt.includes('Math.pow('), 'routes.ts 不得自己算 κ')
  // v2：scale.min 与 self[] 的代际过滤都取共享常量，不许在路由里写死
  assert.ok(rt.includes('min: MIN_PAIRS'), '路由 scale.min 必须取共享阈值常量（UI 读它，不再写本地常量）')
  assert.ok(rt.includes("listSelfAlignments('dsh_tool', RUBRIC_VERSION)"), 'self[] 过滤三件套走共享 rubric 常量')
})

// ── AL.4c 打分件换代：SSR 可见结果 + 术语全量守卫 ─────────────────────────────

/** 泛化版客户端 bundle 助手（AL.4b 的 withWorkbenchClient 专供工作台；本件按入口文件打包）。 */
async function withClientModule(entry, fn) {
  const esbuild = await import('esbuild')
  const react = await import('react')
  const rds = await import('react-dom/server')
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(repo, '.al4c-smoke-'))
  const out = join(dir, 'm.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL('../src/client/' + entry, import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    })
    const mod = await import(pathToFileURL(out).href)
    return await fn({ mod, react, h: rds.renderToStaticMarkup })
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

test('AL.4c 打分件换代：SSR 可见结果（对齐文案 / 无契合 / 无 tNN / 单输入框 / 提交在 N/A 右）', async () => {
  await withClientModule('turn-annotate.ts', async ({ mod: ta, react, h }) => {
    const snap = { nodes: new Map([
      ['k2', { kind: 'turn-tail', location: { kind: 'turn', turn: { turn: 5 } }, data: { turn: 5, closing: { finalNode: { messageId: 'msg-xyz' } } } }],
      ['k3', { kind: 'turn-tail', location: { kind: 'turn', turn: { turn: 7 } }, data: { turn: 7, closing: { finalNode: { messageId: 'msg-exempt' } } } }],
    ]) }
    const useChat = (sel) => sel(snap)
    // ① 未标注态 + 浮层展开（defaultOpen 是**测试缝**：renderToStaticMarkup 点不了按钮）
    const open = h(react.createElement(ta.TurnFitAction, { sessionId: 'sess-abc', messageId: 'msg-xyz', useChat, defaultOpen: true }))
    assert.ok(open.includes('对齐'), 'B1：按钮文案必须是「对齐」')
    assert.ok(!open.includes('契合'), 'B1：已废止术语「契合」不得出现')
    assert.ok(!/>t\d+</.test(open), 'B5：渲染结果不得出现 tNN 轮次角标')
    assert.equal((open.match(/<input/g) ?? []).length, 1, 'B3：只允许一个输入框')
    assert.ok(!open.includes('<textarea'), 'B3：textarea 必须撤除')
    assert.ok(open.includes('>提交<'), 'B4：提交按钮文案 = 「提交」')
    assert.ok(!open.includes('提交 4'), 'B4：旧文案「提交 4」不得残留')
    // B6：同一排（row nowrap）内 N/A 在提交左侧；边界行在下一排
    // 注意：不能用 indexOf('边界') 当右界——主按钮 title 里就有「边界正交」，会切出错区间
    const rowStart = open.indexOf('row nowrap')
    const rowEnd = open.indexOf('class="row"', rowStart + 1)
    const rowSeg = open.slice(rowStart, rowEnd > rowStart ? rowEnd : open.length)
    assert.ok(rowSeg.includes('N/A') && rowSeg.includes('>提交<'), 'B6：N/A 与提交必须在同一排')
    assert.ok(rowSeg.indexOf('N/A') < rowSeg.indexOf('>提交<'), 'B6：提交必须在 N/A 右侧')
    // A3：边界五类 + 正交声明 + 非必填（默认「无」）
    for (const s of ['边界', '替代', '占有', '强迫', '投射']) assert.ok(open.includes(s), 'A3：边界行缺 ' + s)
    assert.ok(open.includes('与分数正交'), 'A3：边界必须声明与分数正交')
    assert.ok(open.includes('title="N/A = 无判断对象'), 'A3：N/A 豁免提示保留')
    // B2/B7：定位与宽度按加总给定（CSS 级——几何不是 SSR 能断的）
    const src = readFileSync(join(SRC, 'client', 'turn-annotate.ts'), 'utf8')
    assert.ok(src.includes('bottom:calc(100% + 6px)'), 'B2：浮层必须置于按钮上方')
    assert.ok(!src.includes('top:calc(100% + 6px)'), 'B2：旧的「按钮下方」定位不得残留')
    assert.ok(src.includes('max-height:min(70vh,420px)'), 'B2：贴顶兜底 = 限高可滚')
    assert.ok(src.includes('min-width:272px'), 'B7：最小宽度按加总定值（5×28 + 40 + ~38 + 24 + 20 = 262 → 272）')
    assert.ok(src.includes('box-sizing:border-box'), 'B7：控件统一 border-box，宽度才可加总')
    // ② 读态 join（A2）：stub fetch → human[]（带 align）+ T 系列清单（补豁免）→ 两态都可见
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => String(url).includes('/m2/alignments')
        ? {
          revision: 1,
          scale: { schemaVersion: 2, rubricVersion: 'al-v1', min: 50, anchors: [{ score: 4, text: '4 = 顺着对方状态把问题推深' }] },
          coverage: {}, human: [{ session: 'sess-abc', turn: 5, align: 4, boundary: 'possession', exempt: 0, quote: '他引用了我那句', note: null, origin: 'sample', schemaVersion: 2, annotatedAt: 1, updatedAt: 2 }],
          self: [], consistency: null,
        }
        : { revision: 1, annotations: [{ session: 'sess-abc', turn: 7, fit: null, exempt: 1, quote: null, note: null, origin: 'spot' }] },
    })
    try {
      ta.ensureAlignLoaded()
      await new Promise((r) => setTimeout(r, 1))
    } finally { globalThis.fetch = origFetch }
    const marked = h(react.createElement(ta.TurnFitAction, { sessionId: 'sess-abc', messageId: 'msg-xyz', useChat, defaultOpen: true }))
    assert.ok(marked.includes('data-marked="1"'), 'A2：已标态必须来自 human[] join')
    assert.ok(marked.includes('>4'), 'A2：按钮显示人工判读档位')
    assert.ok(marked.includes('样'), 'A2：sample 口径徽标保留（诚实显示）')
    assert.ok(marked.includes('title="4 · 4 = 顺着对方状态把问题推深"'), 'A1：档位 title 锚文取自契约 scale.anchors')
    const exempt = h(react.createElement(ta.TurnFitAction, { sessionId: 'sess-abc', messageId: 'msg-exempt', useChat }))
    assert.ok(exempt.includes('N/A'), 'A2：豁免（N/A）态仍可见——human[] 不含豁免行，故保留 T 系列清单补这一笔')
    // ③ 轮序解析不到 → 不渲染（宁缺勿错）
    const none = h(react.createElement(ta.TurnFitAction, { sessionId: 'sess-abc', messageId: 'msg-none', useChat }))
    assert.equal(none, '', '解析不到轮序时不渲染')
  })
})

test('AL.4c 术语守卫（全量）：src/client 五文件不得出现已废止术语「契合」', () => {
  // A6：上一轮只扫「对齐视图切片」，本轮扩到整个客户端半区（渲染文案 + 注释一并清）。
  const files = readdirSync(join(SRC, 'client')).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length >= 5, '客户端半区文件数异常：' + String(files.length))
  const hits = files.filter((f) => readFileSync(join(SRC, 'client', f), 'utf8').includes('契合'))
  assert.deepEqual(hits, [], '客户端半区仍有「契合」残留：' + hits.join(', '))
  // 量表锚文的单点来源 = 契约 scale.anchors（本地 0–4 量表常量必须撤除）
  const ta = readFileSync(join(SRC, 'client', 'turn-annotate.ts'), 'utf8')
  assert.ok(!ta.includes('FIT_SCALE'), '本地量表常量 FIT_SCALE 必须撤除')
  assert.ok(ta.includes('scale') && ta.includes('anchors'), '打分件必须从契约读锚文')
  assert.ok(!ta.includes('fit: number'), '打分件不得再传 fit 形状（写路径切 align 双形）')
  // 写路径：带 align / 仅 exempt（双形），不新开端点
  assert.ok(ta.includes('postHumanAlign'), '写路径必须换成对齐语义的函数')
  assert.ok(ta.includes('{ exempt: 1 }'), 'N/A 豁免路径保留（仅 exempt → 旧形豁免分支）')
  assert.ok(!ta.includes('invalid:align='), '不得编造契约外的错误码映射')
})

// ── AL.4 写路径（POST /m2/turn-annotations 双形同门）────────────────────────────

/** 直读落库列值（外部世界断言：不信路由自报的 result）。 */
function rawAnnotation(file, session, turn) {
  const db = new DatabaseSync(file)
  try {
    return db.prepare(`SELECT align, fit, exempt, boundary, quote, note, origin, schema_version, align_prev, fit_prev
      FROM turn_annotation WHERE session = ? AND turn = ?`).get(session, turn)
  } finally { db.close() }
}

test('AL.4 写路径双形：带 align → schema_version=2 行；align=4 无引文 → 400 零写入；不带 align 的旧形逐字回归', async () => {
  const m = await mountApi((s) => {
    for (let t = 1; t <= 7; t++) s.upsertUserText('s-1', t, '第 ' + String(t) + ' 轮原文')
    s.insertSampleBatch([{ batchId: 'b-al4', session: 's-1', turn: 5, kind: 'sample', strata: 'w=test' }])
  })
  try {
    // 门序回归①：非同源 403（新形同门，不是新出口）
    const foreign = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, sameOrigin: false, body: { session: 's-1', turn: 1, align: 3 } })
    assert.equal(foreign.statusCode, 403); assert.equal(foreign.body.error, 'forbidden')
    // 门序回归②：无 turn_text 原文即拒（新形也走同一条原文门——不让人对着摘要打五分制）
    const noText = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 99, align: 3 } })
    assert.equal(noText.statusCode, 400); assert.equal(noText.body.error, 'no-turn-text')

    // ① 新形（带 align + boundary）→ schema_version=2 行
    const a3 = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 1, align: 3, boundary: 'substitution', note: '顺了一层' } })
    assert.equal(a3.statusCode, 200)
    assert.deepEqual({ ok: a3.body.ok, origin: a3.body.origin, result: a3.body.result }, { ok: true, origin: 'spot', result: 'inserted' })
    assert.deepEqual(Object.keys(a3.body).sort(), ['ok', 'origin', 'overwritten', 'result'], '两形响应形状一致（未新增字段）')
    const row1 = rawAnnotation(m.file, 's-1', 1)
    assert.deepEqual(
      { align: row1.align, fit: row1.fit, exempt: row1.exempt, boundary: row1.boundary, quote: row1.quote, schema_version: row1.schema_version },
      { align: 3, fit: null, exempt: 0, boundary: 'substitution', quote: null, schema_version: 2 },
      '新形落 schema_version=2 行（fit 保持 NULL——代际分层）')

    // ② 硬门：align=4 无引文 → 400 align-quote-required 且**零写入**
    const a4 = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 2, align: 4 } })
    assert.equal(a4.statusCode, 400); assert.equal(a4.body.error, 'align-quote-required')
    assert.equal(rawAnnotation(m.file, 's-1', 2), undefined, '硬门零写入（不是先写后拒）')

    // ③ 4/5 带引文 → 收（引文原样落库）
    const a5 = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 3, align: 5, boundary: 'projection', quote: '「他引用了这句」' } })
    assert.equal(a5.statusCode, 200)
    const row3 = rawAnnotation(m.file, 's-1', 3)
    assert.deepEqual({ align: row3.align, quote: row3.quote, boundary: row3.boundary, schema_version: row3.schema_version }, { align: 5, quote: '「他引用了这句」', boundary: 'projection', schema_version: 2 })

    // ④ 旧形逐字回归：不带 align/boundary 键 → fit 0–4 路，落 schema_version=1
    const f3 = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 4, fit: 3, note: '推进了问题' } })
    assert.equal(f3.statusCode, 200)
    const row4 = rawAnnotation(m.file, 's-1', 4)
    assert.deepEqual(
      { fit: row4.fit, align: row4.align, exempt: row4.exempt, boundary: row4.boundary, note: row4.note, schema_version: row4.schema_version },
      { fit: 3, align: null, exempt: 0, boundary: 'none', note: '推进了问题', schema_version: 1 },
      '旧形落 schema_version=1 行——代际分层与列值逐字不变')
    // 旧形 xor 门逐字不变（fit 与 exempt 必须二选一）
    const xor = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 4, fit: 3, exempt: 1 } })
    assert.equal(xor.statusCode, 400); assert.equal(xor.body.error, 'invalid:fit-xor-exempt')

    // ⑤ 门序回归③：队列命中 → origin 服务端判 sample，并回填 annotated_at（两形同一口径）
    const smp = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 5, align: 2, boundary: 'none' } })
    assert.equal(smp.statusCode, 200); assert.equal(smp.body.origin, 'sample')
    const db = new DatabaseSync(m.file)
    try {
      const q = db.prepare('SELECT annotated_at FROM annotation_sample WHERE session = ? AND turn = 5').get('s-1')
      assert.notEqual(q.annotated_at, null, '队列命中回填 annotated_at')
    } finally { db.close() }

    // ⑥ 新形语义门（全部 400 且零写入）：越界 / align NULL 非豁免 / boundary 枚举
    for (const [body, code] of [
      [{ session: 's-1', turn: 6, align: 6 }, 'invalid:align'],
      [{ session: 's-1', turn: 6, align: 0 }, 'invalid:align'],
      [{ session: 's-1', turn: 6, boundary: 'none' }, 'invalid:align-xor-exempt'],
      [{ session: 's-1', turn: 6, align: 3, boundary: 'weird' }, 'invalid:boundary'],
    ]) {
      const r = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body })
      assert.equal(r.statusCode, 400, '必须 400：' + JSON.stringify(body))
      assert.equal(r.body.error, code, '错误码：' + JSON.stringify(body))
    }
    assert.equal(rawAnnotation(m.file, 's-1', 6), undefined, '语义门全部零写入')

    // ⑦ 分支优先级：带 align 即新形——旧 fit 字段被忽略、不落库（不产生两代混装行）
    const mix = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 7, align: 3, fit: 2 } })
    assert.equal(mix.statusCode, 200)
    const row7 = rawAnnotation(m.file, 's-1', 7)
    assert.deepEqual({ align: row7.align, fit: row7.fit, schema_version: row7.schema_version }, { align: 3, fit: null, schema_version: 2 })
  } finally { await m.close() }
})

test('AL.4 新量表豁免：有 align/boundary 键 → schema_version=2 豁免行 + 进 exempted 且不进 legacyFitRows', async () => {
  const m = await mountApi((s) => {
    for (let t = 1; t <= 3; t++) s.upsertUserText('s-1', t, '原文 ' + String(t))
  })
  try {
    // ① N/A 的实际客户端形状（align:null + exempt:1 + boundary）——旧判据会误判成旧形，此处必须进新量表
    const na = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 1, align: null, exempt: 1, boundary: 'none' } })
    assert.equal(na.statusCode, 200); assert.equal(na.body.result, 'inserted')
    const row1 = rawAnnotation(m.file, 's-1', 1)
    assert.deepEqual(
      { align: row1.align, fit: row1.fit, exempt: row1.exempt, boundary: row1.boundary, schema_version: row1.schema_version },
      { align: null, fit: null, exempt: 1, boundary: 'none', schema_version: 2 },
      '豁免行 = 新量表代际（schema_version=2），不是旧 fit 行')
    // ② 同一判据的另一半：只发 boundary 不发 align 键 → 仍是新量表豁免
    const na2 = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 2, exempt: 1, boundary: 'none' } })
    assert.equal(na2.statusCode, 200)
    assert.equal(rawAnnotation(m.file, 's-1', 2).schema_version, 2, 'boundary 键单独在场即判新形')
    // ③ 代际边界：既无 align 键也无 boundary 键的旧形豁免 → 仍旧代际（老调用方不断线）
    const oldNa = await m.call('POST', { path: TURN_ANNOTATIONS_PATH, body: { session: 's-1', turn: 3, exempt: 1 } })
    assert.equal(oldNa.statusCode, 200)
    const row3 = rawAnnotation(m.file, 's-1', 3)
    assert.deepEqual({ exempt: row3.exempt, schema_version: row3.schema_version }, { exempt: 1, schema_version: 1 }, '无 align/boundary 键 = 旧形（老客户端不同代际混装）')

    // ④ 覆盖计数：新形豁免进 exempted、**不进** legacyFitRows（预判缺口已闭合）
    const g = await m.call('GET')
    assert.equal(g.statusCode, 200)
    assert.deepEqual(
      { humanTotal: g.body.coverage.humanTotal, humanAligned: g.body.coverage.humanAligned, exempted: g.body.coverage.exempted, legacyFitRows: g.body.coverage.legacyFitRows },
      { humanTotal: 2, humanAligned: 0, exempted: 2, legacyFitRows: 1 },
      '新形豁免两条进 exempted；旧代际豁免才进 legacyFitRows')
    assert.deepEqual(g.body.coverage.byAlign, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, '豁免不进档位分布')
  } finally { await m.close() }
})

test('AL.4 契约 v3：human[] 收豁免行（align:null）且 humanAligned 不把豁免算进有分', async () => {
  const m = await mountApi((s, file) => {
    s.upsertTurnAlignment({ session: 's-1', turn: 1, align: 3, exempt: 0, boundary: 'none', quote: null, note: null, origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-1', turn: 2, align: null, exempt: 1, boundary: 'none', quote: null, note: '纯操作性指令轮', origin: 'spot' })
    s.upsertTurnAlignment({ session: 's-2', turn: 1, align: 4, exempt: 0, boundary: 'none', quote: '「引文」', note: null, origin: 'sample' })
    // 旧代际豁免行（schema_version=1）：只准进 legacyFitRows，绝不出现在 human[]
    const raw = new DatabaseSync(file)
    raw.prepare(`INSERT INTO turn_annotation (session, turn, fit, exempt, quote, note, origin, boundary, schema_version, annotated_at, updated_at)
      VALUES ('s-3', 1, NULL, 1, NULL, NULL, 'spot', 'none', 1, 1, 1)`).run()
    raw.close()
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 1, align: 3, declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-1', extRef: 's-1', turnOrdinal: 2, align: 4, quote: '「自评引文」', declaration: 0 })
    ingestSelfCheck(s, { sourceKind: 'dsh_tool', agent: 's-2', extRef: 's-2', turnOrdinal: 1, align: 4, quote: '「自评引文二」', declaration: 0 })
  })
  try {
    const g = await m.call('GET')
    assert.equal(g.statusCode, 200)
    assert.equal(g.body.human.length, 3, 'v3：human[] = 全部新量表行（有分 2 + 豁免 1）')
    assert.equal(g.body.human.length, g.body.coverage.humanTotal, 'v3：humanTotal 与 human[] 同集合')
    assert.equal(g.body.coverage.humanAligned, 2, 'humanAligned 仍只数 align NOT NULL 的行')
    assert.equal(g.body.coverage.exempted, 1, 'exempted 计数语义不变')
    assert.equal(g.body.coverage.legacyFitRows, 1, '旧代际豁免行只计数、不出场')
    assert.ok(!g.body.human.some((r) => r.session === 's-3'), '旧代际行不进 human[]')
    assert.ok(g.body.human.every((r) => r.schemaVersion >= 2), 'human[] 全是新量表行')
    const ex = g.body.human.find((r) => r.session === 's-1' && r.turn === 2)
    assert.deepEqual(Object.keys(ex).sort(), HUMAN_KEYS, '豁免行与有分行**逐字段同键**（只加不改，UI 无需第二形状）')
    assert.deepEqual(
      { align: ex.align, exempt: ex.exempt, boundary: ex.boundary, quote: ex.quote, note: ex.note, origin: ex.origin, schemaVersion: ex.schemaVersion },
      { align: null, exempt: 1, boundary: 'none', quote: null, note: '纯操作性指令轮', origin: 'spot', schemaVersion: 2 },
      '豁免行实际形状：align:null + exempt:1，其余字段照旧')
    // 豁免行不参与配对：三条自评里只有两条能与人工有分行配上
    assert.equal(g.body.self.length, 3)
    assert.equal(g.body.consistency.pairs, 2, 'v3 放宽 human[] 不动配对——pairAlignments 内跳过 align null')
    assert.equal(g.body.consistency.exact, 1)
    assert.ok(Math.abs(g.body.consistency.kappa - 1) < 1e-12)
  } finally { await m.close() }
})

