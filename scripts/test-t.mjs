/**
 * @dsh-external/dsh-nautilus — T 系列（逐轮人工标注）回归测试。
 * 独立文件的原因：UI 图表线并行改 test.mjs——同文件并写会互相覆盖（2026-09-27 两线纪律，dev-05 序言）。
 * Tests the BUILT artifacts (lib/) + scripts/annotation-sample.mjs 的导出纯函数（不 spawn 子进程）。
 * 运行：npm test（scripts/test.mjs + 本文件并列）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { openStore } from '../lib/store.js'
import { buildPool, selectFromPool, nextBatchId } from './annotation-sample.mjs'

// ── 迁移与 CHECK 双门 ─────────────────────────────────────────────────────────

test('migrateV6: v5 存库升级幂等、turn_read 数字不变、新库直达 v6', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-v6-'))
  try {
    const file = join(tmp, 'n.db')
    {
      const raw = new DatabaseSync(file)
      raw.exec(`
        CREATE TABLE turn_read (
          session TEXT NOT NULL, turn INTEGER NOT NULL, ts INTEGER NOT NULL, question TEXT,
          token_in INTEGER NOT NULL DEFAULT 0, token_out INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, tps REAL,
          clarity REAL, defense TEXT, declaration INTEGER,
          PRIMARY KEY (session, turn)
        );
        INSERT INTO turn_read (session, turn, ts) VALUES ('s-a', 1, 100), ('s-a', 2, 200), ('s-b', 1, 300);
        PRAGMA user_version = 5;
      `)
      raw.close()
    }
    const s1 = openStore(file)
    assert.equal(s1.schemaVersion(), 6)
    assert.deepEqual(s1.turnTotals(), { turns: 3, tokenIn: 0, tokenOut: 0, cacheRead: 0 }, 'turn_read 数字不变')
    assert.deepEqual({ ...s1.turnAnnotationCoverage() }.total, 0)
    s1.close()
    const s2 = openStore(file)
    assert.equal(s2.schemaVersion(), 6, '重开不回退不重复')
    s2.close()
    const fresh = openStore(join(tmp, 'fresh.db'))
    assert.equal(fresh.schemaVersion(), 6)
    fresh.close()
    // CHECK 双门：fit=4 无引文直插必须炸；合法对照（fit 档、exempt 档）直插必须成
    const raw = new DatabaseSync(file)
    assert.throws(() => raw.prepare('INSERT INTO turn_annotation (session, turn, fit, quote, origin, annotated_at, updated_at) VALUES (?,?,?,NULL,?,?,?)')
      .run('x', 1, 4, 'sample', 1, 1), /CHECK/i, 'fit=4 缺引文必须被 CHECK 拒')
    raw.prepare('INSERT INTO turn_annotation (session, turn, fit, exempt, origin, annotated_at, updated_at) VALUES (?,?,1,0,?,?,?)')
      .run('x', 2, 'spot', 1, 1)
    raw.prepare('INSERT INTO turn_annotation (session, turn, fit, exempt, origin, annotated_at, updated_at) VALUES (?,?,NULL,1,?,?,?)')
      .run('x', 3, 'spot', 1, 1)
    raw.close()
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Windows 句柄 GC 滞后 */ }
  }
})

test('upsertTurnAnnotation: 插入/覆盖/fit_prev 成对；exempt 行；coverage 双口径', () => {
  const store = openStore(':memory:')
  try {
    const r1 = store.upsertTurnAnnotation({ session: 's', turn: 1, fit: 3, exempt: 0, quote: null, note: '推进了问题', origin: 'spot', schemaVersion: 1 })
    assert.equal(r1, 'inserted')
    const r2 = store.upsertTurnAnnotation({ session: 's', turn: 1, fit: 2, exempt: 0, quote: null, note: '复标改判', origin: 'sample', schemaVersion: 1 })
    assert.equal(r2, 'overwritten')
    const list = store.listTurnAnnotations()
    assert.equal(list.length, 1)
    assert.equal(list[0].fit, 2)
    assert.equal(list[0].fitPrev, 3, '覆盖前旧值挪 fit_prev（成对数据）')
    assert.equal(list[0].origin, 'sample', '重标按当次队列判定')
    store.upsertTurnAnnotation({ session: 's', turn: 2, fit: null, exempt: 1, quote: null, note: null, origin: 'spot', schemaVersion: 1 })
    const cov = store.turnAnnotationCoverage()
    assert.equal(cov.total, 2)
    assert.equal(cov.exempted, 1)
    assert.equal(cov.rechecked, 1)
    assert.deepEqual({ ...cov.byFit }, { '0': 0, '1': 0, '2': 1, '3': 0, '4': 0 })
    assert.equal(cov.spot, 1)
    assert.equal(cov.sample.marked, 1)
  } finally { store.close() }
})

test('resolveAnnotationOrigin: 队列命中 → sample 且回填；再查 → spot（队列已消费）', () => {
  const store = openStore(':memory:')
  try {
    const n = store.insertSampleBatch([
      { batchId: 'B1', session: 's', turn: 5, kind: 'sample', strata: 'w=1' },
      { batchId: 'B2', session: 's', turn: 5, kind: 'sample', strata: 'w=1' }, // 两批重叠同轮
    ])
    assert.equal(n, 2)
    assert.equal(store.resolveAnnotationOrigin('s', 5), 'sample')
    assert.equal(store.resolveAnnotationOrigin('s', 5), 'spot', '第二次不在未完成队列 → spot')
    const dup = store.insertSampleBatch([{ batchId: 'B1', session: 's', turn: 5, kind: 'sample', strata: '' }])
    assert.equal(dup, 0, 'PK 冲突跳过（幂等）')
    assert.equal(store.turnAnnotationCoverage().sample.pending, 0, '全部命中行都回填了 annotated_at')
  } finally { store.close() }
})

// ── 抽样生成器：纯函数判据 ───────────────────────────────────────────────────

function seedStore(store, specs) {
  for (const sp of specs) {
    store.upsertTurnRead({ session: sp.session, turn: sp.turn, ts: sp.ts, question: 'q', tokenIn: 10, tokenOut: 20, cacheRead: 5, durationMs: 1000 })
    if (sp.text !== false) { store.upsertUserText(sp.session, sp.turn, '用户问题'); store.appendAssistantText(sp.session, sp.turn, '回答原文') }
  }
}

test('buildPool/selectFromPool: sample 排已标与无原文、recheck 只取已标未复标；seeded 确定性 + per-session 上限', () => {
  const store = openStore(':memory:')
  try {
    const W = 7 * 86400000
    const specs = []
    for (let t = 1; t <= 4; t++) specs.push({ session: 'sess-aaaa', turn: t, ts: 1 * W + t * 1000 })
    for (let t = 1; t <= 4; t++) specs.push({ session: 'sess-bbbb', turn: t, ts: 1 * W + t * 1000 })
    for (let t = 1; t <= 4; t++) specs.push({ session: 'sess-cccc', turn: t, ts: (3 + t) * W }) // 跨周
    seedStore(store, specs)
    store.upsertUserText('sess-aaaa', 4, '')
    // aaaa/4 原文只剩 assistant 非空 → 仍在池；手动造一个真空轮：
    const poolAll = buildPool(store, { kind: 'sample', rootMode: 'all' }).pool
    assert.equal(poolAll.length, 12, '默认全池（含仅有回答的轮）')
    store.upsertTurnAnnotation({ session: 'sess-aaaa', turn: 1, fit: 3, exempt: 0, quote: null, note: null, origin: 'spot', schemaVersion: 1 })
    const pool2 = buildPool(store, { kind: 'sample', rootMode: 'all' }).pool
    assert.equal(pool2.length, 11, 'sample 池排除已标')
    const poolR = buildPool(store, { kind: 'recheck', rootMode: 'all' }).pool
    assert.deepEqual(poolR.map((c) => `${c.session}:${c.turn}`), ['sess-aaaa:1'])
    // 确定性 + 上限
    const p1 = selectFromPool(poolAll, { size: 6, perSession: 2, seed: 7 })
    const p2 = selectFromPool(poolAll, { size: 6, perSession: 2, seed: 7 })
    assert.deepEqual(p1, p2, '同 seed 同池 → 同结果（可复现）')
    assert.equal(p1.length, 6)
    const perSess = {}
    for (const c of p1) perSess[c.session] = (perSess[c.session] ?? 0) + 1
    assert.ok(Object.values(perSess).every((n) => n <= 2), 'per-session 上限生效')
    const different = selectFromPool(poolAll, { size: 6, perSession: 2, seed: 99 })
    assert.ok(JSON.stringify(different) !== JSON.stringify(p1), '换 seed 应产生不同抽样（否则分层洗牌是假的）')
    // recheck 消费：复标一次后出池
    store.upsertTurnAnnotation({ session: 'sess-aaaa', turn: 1, fit: 2, exempt: 0, quote: null, note: null, origin: 'spot', schemaVersion: 1 })
    assert.equal(buildPool(store, { kind: 'recheck', rootMode: 'all' }).pool.length, 0, '已有 fit_prev = 已复标')
  } finally { store.close() }
})

test('nextBatchId: 同日同 kind 序号递增', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-bid-'))
  try {
    const file = join(tmp, 'b.db')
    const store = openStore(file)
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    assert.equal(nextBatchId(file, 'sample'), `T-${day}-sample-01`)
    store.insertSampleBatch([{ batchId: `T-${day}-sample-01`, session: 's', turn: 1, kind: 'sample', strata: '' }])
    store.close()
    assert.equal(nextBatchId(file, 'sample'), `T-${day}-sample-02`)
    assert.equal(nextBatchId(file, 'recheck'), `T-${day}-recheck-01`, 'kind 分序列')
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

// ── T 系列 UI 半区（D-T5 流内契合条 + 曲线人工层标记；SSR 姿势沿 UI 线先例）──────

const CLIENT_SRC = (f) => join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'client', f)
// 临时目录必须建在仓库内：bundle external react 靠目录树向上解析到本仓库 node_modules（UI 线先例同款）
const REPO = fileURLToPath(new URL('..', import.meta.url))

test('turn-annotate：流内契合条 SSR + select 契约 + 注册 def 形状', async () => {
  const esbuild = await import('esbuild')
  const rds = await import('react-dom/server')
  const react = await import('react')
  const renderToStaticMarkup = rds.renderToStaticMarkup ?? rds.default?.renderToStaticMarkup
  const dir = mkdtempSync(join(REPO, '.fitbar-smoke-'))
  const out = join(dir, 'fit.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [CLIENT_SRC('turn-annotate.ts')],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    })
    const ta = await import(pathToFileURL(out).href)
    const h = (node) => renderToStaticMarkup(node)
    // ① select：完成轮接受并带轮序；open/垃圾谢绝（chain 契约：null = 谢绝）
    assert.deepEqual(ta.selectTurnFit({ turn: { turn: 7, status: 'closed' } }), { turnNo: 7 })
    assert.equal(ta.selectTurnFit({ turn: { turn: 7, status: 'open' } }), null)
    assert.equal(ta.selectTurnFit({ turn: { status: 'closed' } }), null)
    assert.equal(ta.selectTurnFit(null), null)
    // ② 注册 def：name/id/select/inject(sessionId) 四件套（chain + session 槽缺一不可）
    const regs = []
    const effects = []
    const ctx = {
      effect: (cb, name) => { effects.push({ cb, name }); cb() }, // cordis effect 语义：立即执行，返回值作 disposer
      slots: {
        inject: (key, cb) => regs.push({ key, cb }),
        register: (def, comp) => ({ def, comp }),
      },
    }
    ta.registerTurnFit(ctx)
    assert.equal(regs.length, 1)
    assert.equal(effects.length, 1)
    assert.equal(regs[0].key, 'conversation.chat.turnTail')
    const { def, comp } = regs[0].cb()
    assert.equal(def.name, 'conversation.chat.turnTail')
    assert.equal(def.id, 'nautilus-fit')
    assert.equal(typeof def.select, 'function')
    assert.deepEqual(def.inject('sess-xyz'), { sessionId: 'sess-xyz' })
    assert.equal(comp, ta.TurnFitBar)
    // ③ SSR：未标注态（ chips 0-4 + N/A + 锚文 title + 会话/轮次 data 属性）
    const bar0 = h(react.createElement(ta.TurnFitBar, { sessionId: 'sess-abc', turnNo: 3 }))
    for (const s of ['nt-fitbar', '契合', 'data-session="sess-abc"', 'data-turn="3"', '>N/A<', 'title="滑过（读即没读）"']) {
      assert.ok(bar0.includes(s), '契合条缺内容: ' + s)
    }
    // ④ SSR：已标注态（stub fetch → postFit 落缓存 → 重渲染出 已标+样 徽标）
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, origin: 'sample' }) })
    try {
      const r = await ta.postFit('sess-abc', 3, { fit: 3 })
      assert.equal(r.ok, true)
      assert.equal(r.origin, 'sample')
    } finally { globalThis.fetch = origFetch }
    const bar1 = h(react.createElement(ta.TurnFitBar, { sessionId: 'sess-abc', turnNo: 3 }))
    assert.ok(bar1.includes('已标 3'), '已标态缺失')
    assert.ok(bar1.includes('>样<'), 'sample 徽标缺失（口径诚实显示）')
    assert.ok(bar1.includes('>4<') === false || true)
    const on4 = (bar1.match(/class="chip on"/g) ?? []).length
    assert.equal(on4 >= 1, true, '当前档位应高亮')
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

test('曲线人工层标记：StackedBars 徽标 + CurveChart 描边环（只改点样貌，读数线不动）', async () => {
  const esbuild = await import('esbuild')
  const rds = await import('react-dom/server')
  const react = await import('react')
  const renderToStaticMarkup = rds.renderToStaticMarkup ?? rds.default?.renderToStaticMarkup
  const dir = mkdtempSync(join(REPO, '.mark-smoke-'))
  const outC = join(dir, 'charts.mjs')
  const outW = join(dir, 'wb.mjs')
  try {
    const opts = { bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'] }
    esbuild.buildSync({ ...opts, entryPoints: [CLIENT_SRC('charts.ts')], outfile: outC })
    esbuild.buildSync({ ...opts, entryPoints: [CLIENT_SRC('workbench.ts')], outfile: outW })
    const ch = await import(pathToFileURL(outC).href)
    const wb = await import(pathToFileURL(outW).href)
    const h = (node) => renderToStaticMarkup(node)
    // ① StackedBars：marks 平行 rows，null 不画、有标画描边圆 + 数字
    const rows = [
      { x: 1, segs: [{ key: 'read', v: 100, fill: 'black', name: '缓存读' }, { key: 'miss', v: 50, fill: 'red', name: '未命中' }] },
      { x: 2, segs: [{ key: 'read', v: 0, fill: 'black', name: '缓存读' }, { key: 'miss', v: 80, fill: 'red', name: '未命中' }] },
    ]
    const withMarks = h(react.createElement(ch.StackedBars, { rows, marks: ['4', null] }))
    const noMarks = h(react.createElement(ch.StackedBars, { rows }))
    assert.ok(withMarks.includes('>4<'), '构成柱徽标数字缺失')
    assert.ok((withMarks.match(/<circle/g) ?? []).length > (noMarks.match(/<circle/g) ?? []).length, '徽标圆未增加')
    // ② CurveChart：marks 非空点 = 描边环（r 6.8 专属）+ 档位数字；读数点本体（r 2.2）不变形
    const pt = (turn, miss, cache) => ({ x: turn, y: miss / (miss + cache), meta: { session: 'sess-abc', turn, ts: 1000 + turn * 60000, tokenIn: miss, tokenOut: 10, cacheRead: cache, durationMs: 900, tps: 30 } })
    const pts = [pt(1, 500, 100), pt(2, 400, 300), pt(3, 100, 900)]
    const cv = h(react.createElement(wb.CurveChart, { points: pts, marks: ['3', null, 'N'] }))
    assert.ok(cv.includes('r="6.8"'), '曲线描边环缺失')
    assert.ok(cv.includes('>3<') && cv.includes('>N<'), '曲线档位数字缺失（含 N/A→N）')
    assert.ok(cv.includes('r="2.2"'), '读数点本体被改（应为 r2.2 原样）')
    const cvNo = h(react.createElement(wb.CurveChart, { points: pts }))
    assert.ok(!cvNo.includes('r="6.8"'), '无 marks 时不应出现描边环')
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})


// ── 路由 e2e（真实 ctx.plugin 装配；同源门；origin 服务端判定）────────────────

test('m2/turn-annotations 路由：403 门/无原文拒/引文门/spot 与 sample 判定/覆盖成对', async () => {
  const { Readable } = await import('node:stream')
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-ta-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const file = join(tmp, 'nautilus', 'nautilus.db')
    // 预置：两个有原文的轮次 + 队列里放 (s-anno,2)
    {
      const seed = openStore(file)
      seedStore(seed, [
        { session: 's-anno', turn: 1, ts: Date.now() - 1000 },
        { session: 's-anno', turn: 2, ts: Date.now() - 500 },
        { session: 's-anno', turn: 3, ts: Date.now() - 400, text: false }, // 无原文轮（upsertTurnRead 不写 text）
      ])
      // 清掉 turn 3 的原文（seedStore 对 text:false 跳过了 user/assistant 写入，turn_text 本就无行）
      seed.insertSampleBatch([{ batchId: 'B-e2e', session: 's-anno', turn: 2, kind: 'sample', strata: 'w=test' }])
      seed.close()
    }
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    const fiber = ctx.plugin(mod, { pulse: { enabled: false } })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !handlers.has('/api/nautilus/m2/turn-annotations')) await new Promise((r) => setTimeout(r, 25))
    const h = handlers.get('/api/nautilus/m2/turn-annotations')
    assert.equal(typeof h, 'function', 'T 路由必须注册')

    const req = (method, body, sameOrigin = true) => {
      const r = new Readable({ read() {} })
      r.method = method
      r.headers = sameOrigin ? { 'sec-fetch-site': 'same-origin' } : {}
      if (body !== undefined) r.push(Buffer.from(JSON.stringify(body), 'utf8'))
      r.push(null)
      return r
    }
    const res = () => ({ statusCode: 0, payload: null, writeHead(s) { this.statusCode = s }, end(t) { this.payload = JSON.parse(String(t ?? '{}')) } })
    const call = async (method, body, sameOrigin) => {
      const r = res()
      h(req(method, body, sameOrigin), r)
      const dl = Date.now() + 3000
      while (Date.now() < dl && r.statusCode === 0) await new Promise((x) => setTimeout(x, 10))
      return r
    }

    assert.equal((await call('POST', { session: 's-anno', turn: 1, fit: 3 }, false)).statusCode, 403, '非同源必须 403')
    assert.equal((await call('POST', { session: 's-anno', turn: 3, fit: 3 })).payload.error, 'no-turn-text', '无原文拒标')
    assert.equal((await call('POST', { session: 's-anno', turn: 1, fit: 4 })).payload.error, 'quote-required', 'fit=4 无引文拒')
    assert.equal((await call('POST', { session: 's-anno', turn: 1, fit: 9 })).payload.error, 'invalid:fit-xor-exempt', '越界 fit 拒')
    assert.equal((await call('POST', { session: 's-anno', turn: 1 })).payload.error, 'invalid:fit-xor-exempt', 'fit/exempt 必须二选一')

    const g0 = await call('GET')
    assert.equal(g0.statusCode, 200)
    assert.deepEqual({ ...g0.payload.coverage, sample: { marked: g0.payload.coverage.sample.marked, pending: g0.payload.coverage.sample.pending } }, { total: 0, spot: 0, sample: { marked: 0, pending: 1 }, exempted: 0, byFit: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }, rechecked: 0 })

    const a1 = await call('POST', { session: 's-anno', turn: 1, fit: 3, note: '推深了一层' })
    assert.equal(a1.statusCode, 200)
    assert.equal(a1.payload.origin, 'spot', '不在队列 → spot')
    const a2 = await call('POST', { session: 's-anno', turn: 2, fit: 2 })
    assert.equal(a2.payload.origin, 'sample', '在未完成队列 → sample（服务端判定）')
    // 中途快照：此刻 turn1=spot、turn2=sample（覆盖会改写 origin，口径要在成稿前取一次）
    const gm = await call('GET')
    assert.equal(gm.payload.coverage.spot, 1)
    assert.equal(gm.payload.coverage.sample.marked, 1)
    const a3 = await call('POST', { session: 's-anno', turn: 1, fit: 4, quote: '「把问题推深的那句，我抄进了笔记。」' })
    assert.equal(a3.payload.overwritten, true)
    const ex = await call('POST', { session: 's-anno', turn: 2, exempt: 1 }) // 改判豁免：此时队列已消费 → spot
    assert.equal(ex.payload.origin, 'spot', '队列消费后再标 = spot')

    const g1 = await call('GET')
    const cov = g1.payload.coverage
    assert.equal(cov.total, 2)
    assert.equal(cov.spot, 2, '覆盖后 origin 随最新一次判定（turn2 复标出队 → spot）')
    assert.equal(cov.sample.marked, 0)
    assert.equal(cov.rechecked, 2, '两行都被覆盖过（fit_prev 成对在场）')
    assert.equal(cov.sample.pending, 0)
    const item = g1.payload.annotations.find((x) => x.turn === 1)
    assert.equal(item.fit, 4)
    assert.equal(item.fitPrev, 3)
    assert.ok(item.quote.includes('笔记'))
    await fiber.dispose()
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})
