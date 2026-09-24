/**
 * @dsh-external/dsh-nautilus — AL 系列（对齐体系重构）回归测试 + 结构守卫。
 *
 * 内容：
 *  · AL.6 边界守卫：`src/nexus/**` 自包含、只在 src/nexus 下、两腿互不 import（决策 §7.2）。
 *  · AL.2 迁移账本与 v8 迁移：按序应用 / 跳号如实记录 / 幂等 / 旧契合行一个不丢 / 1–5 与边界 CHECK。
 * 已知例外（记在案）：`../store.js` 允许 nexus import——数据核心仍共享，真正抽离属 OQ-AL4。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runMigrations, readUserVersion } from '../lib/migrations.js'
import { openStore } from '../lib/store.js'

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
    selfAligned: 5,
    selfByAlign: { '1': 0, '2': 1, '3': 1, '4': 2, '5': 1 },
  },
  human: [
    { session: 'session-aaaa1111', turn: 3, align: 4, boundary: 'none', exempt: 0, quote: '把问题推深的那句', note: null, origin: 'spot', schemaVersion: 2, annotatedAt: 1000, updatedAt: 2000 },
    { session: 'session-bbbb2222', turn: 1, align: null, boundary: 'none', exempt: 1, quote: null, note: '纯操作性轮', origin: 'spot', schemaVersion: 2, annotatedAt: 1500, updatedAt: 1600 },
    { session: 'session-cccc3333', turn: 2, align: 5, boundary: 'projection', exempt: 0, quote: '他引用了我那句', note: null, origin: 'sample', schemaVersion: 2, annotatedAt: 1700, updatedAt: 1800 },
  ],
  self: [
    { extRef: 'session-aaaa1111', turnOrdinal: 3, align: 3, boundary: 'substitution', declaration: 0, quote: null, evidence: '自评依据', rubricVersion: 'al-v1', tsMs: 2100, agent: 'dsh' },
    { extRef: 'session-cccc3333', turnOrdinal: 2, align: 5, boundary: 'projection', declaration: 0, quote: null, evidence: null, rubricVersion: 'al-v1', tsMs: 1900, agent: 'dsh' },
    { extRef: 'session-dddd4444', turnOrdinal: 1, align: 2, boundary: 'possession', declaration: 0, quote: null, evidence: null, rubricVersion: 'al-v1', tsMs: 1200, agent: 'dsh' },
  ],
  consistency: { pairs: 2, exact: 0.5, near: 1, kappa: 0.615 },
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
    for (const s of ['双路台账', 'aaaa1111 · t3', 'cccc3333 · t2', 'dddd4444 · t1', '豁免', '把问题推深的那句']) {
      assert.ok(html.includes(s), '台账缺内容: ' + s)
    }
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
    // ⑤ 一致性三指标 + 样本不足纪律（pairs=2 < 50）
    for (const s of ['<th>对数</th>', '50.0%', '100.0%', '0.615', '只作观察，不得据此调整 rubric']) {
      assert.ok(html.includes(s), '一致性缺内容: ' + s)
    }
    // ⑥ 版本面 + 术语纪律
    for (const s of ['schema_version=2', 'rubric_version=al-v1']) assert.ok(html.includes(s), '版本面缺内容: ' + s)
    assert.ok(!html.includes('契合'), '对齐视图不得出现已废止术语「契合」')
  })
})

test('AL.4b 对齐视图：consistency=null → 样本不足；接口缺席 → 显式缺席（都不写 0）', async () => {
  await withWorkbenchClient(async ({ wb, react, h }) => {
    const none = h(react.createElement(wb.AlignmentsView, { align: { ...AL_FIXTURE, consistency: null } }))
    // 渲染层：React 会把 '<' 转义成 '&lt;'，故此处断语义文本；字面措辞由下面的源码守卫逐字校验
    assert.ok(none.includes('样本不足') && none.includes('一致性三指标不可计算'), '对数 <2 必须显示样本不足（而不是 0）')
    assert.ok(!none.includes('<th>对数</th>'), '不可计算时不得渲染三指标表（否则看起来像 0）')
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
})
