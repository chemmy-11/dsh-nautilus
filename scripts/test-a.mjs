/**
 * @dsh-external/dsh-nautilus — A 系列（OS 层红线告警）回归测试。
 * 独立文件的原因：与 test.mjs / test-t.mjs 分文件并行演进（两线纪律，dev-05 序言同款）。
 * Tests the BUILT artifacts (lib/) + 真实 ctx.plugin 装配（同源门 / 路由注册）。
 * 运行：npm test（test.mjs + test-t.mjs + 本文件并列）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'

import { AlertEngine, DEFAULT_ALERT_RULES, alertIdFor, alertMetricExpr, validateAlertRules } from '../lib/pulse/alerts.js'
import { computeCoverage, freezeSnapshot, pruneSnapshots, samplesToJsonl, snapshotStats } from '../lib/pulse/snapshot.js'
import { aggregateMetrics, buildDigest, composeReport, composeResultNote, digestFacts, parseHypotheses } from '../lib/pulse/report.js'
import { openPulseStore } from '../lib/pulse/store.js'
import { openStore } from '../lib/store.js'

/** 规则工厂：默认 gte/时间窗 1s，字段按需覆盖。 */
function rule(over = {}) {
  return {
    id: 'r', label: '规则', enabled: true, metric: 'm', refMetric: '', op: 'gte',
    threshold: 1, clear: 0, forMs: 1000, cooldownMs: 0, ...over,
  }
}
const vals = (o) => new Map(Object.entries(o))

// ── 检测内核：判据是「时刻」不是「tick 数」 ──────────────────────────────────

test('AlertEngine 确认窗：按时间窗累计（tick 密度无关），并记录 first_exceeded_at', () => {
  const e = new AlertEngine([rule({ id: 'w', forMs: 1000 })])
  const opened = []
  for (let i = 0; i < 10; i++) opened.push(...e.observe(vals({ m: 2 }), 1000 + i * 100))
  assert.equal(opened.length, 0, '900ms（10 个 tick）不该确认——tick 数不是判据')
  opened.push(...e.observe(vals({ m: 2 }), 2000))
  assert.equal(opened.length, 1)
  assert.equal(opened[0].kind, 'opened')
  assert.equal(opened[0].firstExceededAt, 1000, '起点是最早越线时刻')
  assert.equal(opened[0].confirmedAt, 2000)
  assert.equal(opened[0].alertId, alertIdFor(2000, 'w'))
  // 对照：稀疏 tick（每 500ms、只 3 次）同样在 1000ms 处确认
  const e2 = new AlertEngine([rule({ id: 'w', forMs: 1000 })])
  e2.observe(vals({ m: 2 }), 0)
  e2.observe(vals({ m: 2 }), 500)
  assert.equal(e2.observe(vals({ m: 2 }), 1000).length, 1, '同一时间判据下，tick 稀疏不影响确认时刻')
})

test('AlertEngine 滞回与计时重置：E26 边界案例（0.89926 打断连续段）逐帧复现', () => {
  const e = new AlertEngine([rule({ id: 'mem', metric: 'used', refMetric: 'total', threshold: 0.90, clear: 0.85, forMs: 30000 })])
  const v = (used, total = 100) => vals({ used, total })
  e.observe(v(95), 0)                        // 19:54:21 越线
  const dip = e.observe(v(89.926), 6000)     // 19:54:27 回落 0.89926（滞回带，但连续段被打断）
  assert.equal(dip.length, 0)
  assert.equal(e.stateOf('mem').firstExceededAt, null, '滞回带内未确认的连续段必须重置计时')
  e.observe(v(95), 11000)                    // 19:54:32 重新连续
  assert.equal(e.stateOf('mem').firstExceededAt, 11000)
  const opened = e.observe(v(96), 41000)     // +30s
  assert.equal(opened.length, 1)
  assert.equal(opened[0].firstExceededAt, 11000, '确认用的是重置后的起点')
  assert.equal(opened[0].peak, 0.96)
  // 滞回带内已确认的保持开放
  const band = e.observe(v(87), 50000)
  assert.equal(band.length, 0)
  assert.equal(e.stateOf('mem').open, true, '0.85–0.90 区间保持（滞回）')
  const cleared = e.observe(v(84), 60000)
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].kind, 'cleared')
  assert.equal(cleared[0].durationMs, 19000, 'duration = 确认 → 解除')
  assert.equal(cleared[0].peak, 0.96, '峰值取越线段内极值')
  assert.equal(e.stateOf('mem').open, false)
})

// ── 检测内核：缺样本 / 冷却 / 停用 / lte ─────────────────────────────────────

test('AlertEngine 缺样本：跳过且状态保持（缺席 ≠ 恢复）；分母缺席或为 0 同样跳过', () => {
  const e = new AlertEngine([rule({ id: 'm', metric: 'a', refMetric: 'b', threshold: 0.9, clear: 0.8, forMs: 1000 })])
  e.observe(vals({ a: 95, b: 100 }), 0)
  assert.equal(e.stateOf('m').firstExceededAt, 0)
  assert.equal(e.observe(vals({ a: 95 }), 500).length, 0)
  assert.equal(e.stateOf('m').skippedTicks, 1)
  assert.equal(e.stateOf('m').firstExceededAt, 0, '缺席不清零连续段——缺席不等于恢复')
  assert.equal(e.observe(vals({ a: 95, b: 0 }), 800).length, 0)
  assert.equal(e.stateOf('m').skippedTicks, 2, '分母 0 不可比 → 也算跳过')
  const opened = e.observe(vals({ a: 95, b: 100 }), 1000)
  assert.equal(opened.length, 1, '恢复后继续按原起点累计')
  assert.equal(opened[0].firstExceededAt, 0)
  // 已确认后缺席不会解除
  assert.equal(e.observe(vals({ a: 0 }), 2000).length, 0)
  assert.equal(e.stateOf('m').open, true, '缺席不是解除信号')
  // ratio 表达式（落台账 metric 列）
  assert.equal(alertMetricExpr(rule({ metric: 'a', refMetric: 'b' })), 'a / b')
  assert.equal(alertMetricExpr(rule({ metric: 'a' })), 'a')
})

test('AlertEngine 冷却：冷却内不开新告警，但计时继续累积（冷却一过立刻确认）', () => {
  const e = new AlertEngine([rule({ id: 'c', forMs: 1000, cooldownMs: 5000 })])
  e.observe(vals({ m: 2 }), 0)
  assert.equal(e.observe(vals({ m: 2 }), 1000).length, 1)
  const cleared = e.observe(vals({ m: -1 }), 1100)   // 低于解除线 0（clear=0），不是滞回带
  assert.equal(cleared.length, 1)
  assert.equal(e.stateOf('c').cooldownUntil, 6100)
  e.observe(vals({ m: 2 }), 1200)                 // 冷却期内再次越线
  assert.equal(e.stateOf('c').firstExceededAt, 1200)
  assert.equal(e.observe(vals({ m: 2 }), 2200).length, 0, '冷却未过：即便窗已满也不开新告警')
  const reopened = e.observe(vals({ m: 2 }), 6100)
  assert.equal(reopened.length, 1, '冷却一过立刻确认')
  assert.equal(reopened[0].firstExceededAt, 1200, '计时在冷却期内继续累积，不重新起算')
})

test('AlertEngine 停用不擅自解除 + lte 峰值取 min + 非法配置响亮失败', () => {
  // 停用的规则完全不参与判定（既不开新、也不解除——后者由插件半区启动自愈收口）
  const off = new AlertEngine([rule({ id: 'off', enabled: false })])
  for (let i = 0; i < 10; i++) assert.equal(off.observe(vals({ m: 99 }), i * 1000).length, 0)
  assert.equal(off.stateOf('off').open, false)
  // 同引擎里一条停用不影响另一条启用
  const mix = new AlertEngine([rule({ id: 'off', enabled: false }), rule({ id: 'on', metric: 'n', forMs: 0 })])
  const ev = mix.observe(vals({ m: 99, n: 99 }), 0)
  assert.deepEqual(ev.map((x) => x.rule.id), ['on'])
  // lte：越线看 ≤ threshold，峰值取 min
  const lo = new AlertEngine([rule({ id: 'l', op: 'lte', threshold: 10, clear: 20, forMs: 0 })])
  const o = lo.observe(vals({ m: 8 }), 0)
  assert.equal(o.length, 1, 'forMs=0：首个越线 tick 即确认')
  assert.equal(o[0].peak, 8)
  lo.observe(vals({ m: 1 }), 10)
  assert.equal(lo.stateOf('l').peak, 1, 'lte 的峰值随更小值下降（取 min）')
  assert.equal(lo.observe(vals({ m: 25 }), 20)[0].kind, 'cleared')
  // 非法配置：schema 表达不了的交叉约束在装配时抛错
  assert.throws(() => validateAlertRules([rule({ clear: 2 })]), /解除线必须在阈值另一侧/)
  assert.throws(() => validateAlertRules([rule({ id: 'dup' }), rule({ id: 'dup' })]), /重复 id/)
  assert.throws(() => validateAlertRules([rule({ op: 'ratio' })]), /op 必须是 gte\|lte/)
  assert.throws(() => validateAlertRules([rule({ forMs: -1 })]), /forMs/)
  assert.throws(() => new AlertEngine([rule({ clear: 5 })]), /解除线/)
  // 默认规则表：四个主要对象启用 + dsh-rss 默认关（OQ-A1 未裁）
  assert.deepEqual(DEFAULT_ALERT_RULES.map((r) => r.id), ['mem-occupancy', 'gpu-mem-occupancy', 'cpu-utilization', 'gpu-utilization', 'dsh-rss'])
  assert.equal(DEFAULT_ALERT_RULES.filter((r) => r.enabled).length, 4)
  assert.equal(DEFAULT_ALERT_RULES.find((r) => r.id === 'dsh-rss').enabled, false)
})

// ── 存储：v7 迁移与 CHECK 三道门 ────────────────────────────────────────────

test('migrateV7：v6 存库升级幂等、既有数字不变、新库直达 v7；alert_event 三 CHECK 生效', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-v7-'))
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
        INSERT INTO turn_read (session, turn, ts, token_in) VALUES ('s-a', 1, 100, 7), ('s-a', 2, 200, 8);
        PRAGMA user_version = 6;
      `)
      raw.close()
    }
    const s1 = openStore(file)
    assert.equal(s1.schemaVersion(), 7)
    assert.deepEqual(s1.turnTotals(), { turns: 2, tokenIn: 15, tokenOut: 0, cacheRead: 0 }, '既有数字不变')
    s1.close()
    const s2 = openStore(file)
    assert.equal(s2.schemaVersion(), 7, '重开不回退不重复')
    s2.close()
    const fresh = openStore(join(tmp, 'fresh.db'))
    assert.equal(fresh.schemaVersion(), 7, '新库直达 v7')
    fresh.close()
    // 三 CHECK：op / report_status / human_verdict
    const raw = new DatabaseSync(file)
    const insert = (cols) => raw.prepare(`INSERT INTO alert_event (id, rule_id, metric, op, threshold, first_exceeded_at, confirmed_at, report_status, human_verdict, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(...cols)
    assert.throws(() => insert(['x1', 'r', 'm', 'ratio', 1, 1, 1, 'skipped', null, 1]), /CHECK/i, 'op 只允许 gte|lte')
    assert.throws(() => insert(['x2', 'r', 'm', 'gte', 1, 1, 1, 'weird', null, 1]), /CHECK/i, 'report_status 枚举')
    assert.throws(() => insert(['x3', 'r', 'm', 'gte', 1, 1, 1, 'skipped', 'maybe', 1]), /CHECK/i, 'human_verdict 枚举')
    insert(['x4', 'r', 'm', 'gte', 1, 1, 1, 'skipped', null, 1])
    raw.close()
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Windows 句柄 GC 滞后 */ }
  }
})

test('台账方法：insert 幂等 / close 一次性 / closeStaleAlerts 收口 / counts 与 recent', () => {
  const store = openPulseStore(':memory:')
  try {
    const now = Date.now()
    const row = (id, confirmedAt) => ({
      id, ruleId: 'mem-occupancy', metric: 'pulse.mem.used / pulse.mem.total', op: 'gte',
      threshold: 0.9, firstExceededAt: confirmedAt - 30000, confirmedAt, peakValue: 0.98, createdAt: confirmedAt,
    })
    assert.equal(store.insertAlert(row('a-1-mem-occupancy', now - 1000)), 'inserted')
    assert.equal(store.insertAlert(row('a-1-mem-occupancy', now - 1000)), 'duplicate', '同 id 重放 = 幂等忽略')
    store.insertAlert(row('a-2-mem-occupancy', now))
    assert.deepEqual(store.alertCounts(now), { open: 2, total: 2, last24h: 2 })
    assert.equal(store.closeAlert('a-1-mem-occupancy', now), true)
    assert.equal(store.closeAlert('a-1-mem-occupancy', now + 1), false, '已解除的行不再改（幂等）')
    const closed = store.alertById('a-1-mem-occupancy')
    assert.equal(closed.durationMs, 1000)
    assert.equal(closed.reportStatus, 'skipped', '默认报告态 skipped（A.3 门禁默认关）')
    // 启动自愈：把遗留未解除行收口
    const healing = store.closeStaleAlerts(now + 5000)
    assert.deepEqual(healing, ['a-2-mem-occupancy'])
    assert.equal(store.alertCounts(now + 5000).open, 0)
    assert.equal(store.openAlerts().length, 0)
    assert.equal(store.recentAlerts(10).length, 2, '台账历史行保留（不删）')
    assert.equal(store.closeStaleAlerts(now + 6000).length, 0, '再次自愈无操作')
  } finally { store.close() }
})

// ── 路由 e2e：/pulse/alerts（同源门 + 结构 + 真实 tick 触发确认）──────────────

test('pulse/alerts 路由：403 同源门 + 规则/运行态/台账结构 + 真实 tick 首轮越线确认', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-alertroute-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    // 规则：内存占比阈值 0（真机必然越线）、forMs 0 → 首轮 tick 即确认；CPU 规则反向对照（阈值 2 永不越线）
    const fiber = ctx.plugin(mod, {
      pulse: {
        enabled: true, enableCounters: false, enableGpu: false, intervalMs: 1000,
        dbFile: join(tmp, 'n.db'),
        alertRules: [
          { id: 'mem-occupancy', label: '内存占比', metric: 'pulse.mem.used', refMetric: 'pulse.mem.total', op: 'gte', threshold: 0, clear: -1, forMs: 0 },
          { id: 'cpu-utilization', label: 'CPU 利用率', metric: 'pulse.cpu.utilization', op: 'gte', threshold: 2, clear: 1, forMs: 0 },
        ],
      },
    })
    let disposed = false
    const dispose = async () => { if (!disposed) { disposed = true; await fiber.dispose() } }
    try {
    const deadline0 = Date.now() + 5000
    while (Date.now() < deadline0 && !handlers.has('/api/nautilus/pulse/alerts')) await new Promise((r) => setTimeout(r, 25))
    const h = handlers.get('/api/nautilus/pulse/alerts')
    assert.equal(typeof h, 'function', 'alerts 路由必须注册')

    const req = (method, sameOrigin = true) => ({ method, headers: sameOrigin ? { 'sec-fetch-site': 'same-origin' } : {}, url: '/api/nautilus/pulse/alerts' })
    const res = () => ({ statusCode: 0, payload: null, writeHead(s) { this.statusCode = s }, end(t) { this.payload = JSON.parse(String(t ?? '{}')) } })
    const call = async (method, sameOrigin) => {
      const r = res()
      h(req(method, sameOrigin), r)
      const dl = Date.now() + 3000
      while (Date.now() < dl && r.statusCode === 0) await new Promise((x) => setTimeout(x, 10))
      return r
    }
    assert.equal((await call('GET', false)).statusCode, 403, '非同源必须 403')
    assert.equal((await call('POST')).statusCode, 405, '只读口')

    // 等首轮 tick 确认（tick 在挂载后 ~1s 触发）
    let snap = null
    const dl = Date.now() + 8000
    while (Date.now() < dl) {
      const r = await call('GET')
      if (r.payload.recent.length > 0) { snap = r.payload; break }
      await new Promise((x) => setTimeout(x, 100))
    }
    assert.ok(snap !== null, '首轮越线必须落台账（threshold=0 必然越线）')
    assert.equal(snap.enabled, true)
    assert.deepEqual(snap.counts.rules, 2)
    assert.equal(snap.counts.rulesEnabled, 2)
    const mem = snap.rules.find((r) => r.id === 'mem-occupancy')
    assert.equal(mem.expr, 'pulse.mem.used / pulse.mem.total')
    assert.equal(mem.state.open, true, '运行态与台账一致')
    assert.ok(mem.state.lastValue > 0)
    const cpu = snap.rules.find((r) => r.id === 'cpu-utilization')
    assert.equal(cpu.state.open, false, '永不越线的规则不该开告警')
    const ev = snap.recent[0]
    assert.equal(ev.ruleId, 'mem-occupancy')
    assert.equal(ev.op, 'gte')
    assert.ok(ev.peakValue >= mem.threshold, '峰值与阈值同口径')
    assert.ok(String(ev.id).startsWith('a-'), '台账 id = a-<base36>-<ruleId>')
    assert.equal(snap.active.length, 1, '未解除告警出现在 active')
    // A.2：确认那一刻必须真的冻结证据（不是「状态里有、磁盘上没有」）
    const snapDir = join(tmp, 'alerts', ev.id)
    assert.equal(existsSync(join(snapDir, 'samples.jsonl.gz')), true, '快照 gz 必须落盘')
    const meta = JSON.parse(readFileSync(join(snapDir, 'meta.json'), 'utf8'))
    assert.ok(meta.rows > 0, '真库里必然有窗口内采样')
    assert.equal(meta.ruleId, 'mem-occupancy')
    assert.equal(meta.op, 'gte')
    assert.equal(meta.alertId, ev.id)
    assert.ok(String(ev.snapshotHash).length === 64, 'sha256 指纹落台账')
    assert.equal(ev.snapshotPath, join(snapDir, 'samples.jsonl.gz'))
    const ledgerText = readFileSync(join(tmp, 'alerts', 'ledger.md'), 'utf8')
    assert.ok(ledgerText.includes('确认') && ledgerText.includes('冻结'), '台账人读日志含确认与冻结两行')
    // A.3：门禁默认关 → 报告照样落盘（事实段在场，假设段如实缺席，绝不假装有结论）
    const reportPath = join(tmp, 'alerts', 'reports', ev.id + '.md')
    assert.equal(existsSync(reportPath), true, '报告文件必须落盘（门禁关也要有事实段）')
    const reportText = readFileSync(reportPath, 'utf8')
    assert.ok(reportText.includes('## 一、事实（程序生成，不经模型）'), '事实段永远在场')
    assert.ok(reportText.includes('门禁默认关'), '缺席原因如实写明')
    assert.ok(reportText.includes('## 三、待查'), '三段结构完整')
    assert.equal(ev.reportStatus, 'skipped', '台账报告态 = skipped')
    assert.ok(ledgerText.includes('报告'), '台账人读日志含报告行')
    assert.ok(snap.evidence !== null && snap.evidence.dirs >= 1, '证据目录现状随快照一起可见')

    // A.4：人工裁决（不设审批门）+ 报告查看入口
    const vh = handlers.get('/api/nautilus/pulse/alerts/verdict')
    const rh = handlers.get('/api/nautilus/pulse/alerts/report')
    assert.equal(typeof vh, 'function', 'verdict 路由必须注册')
    assert.equal(typeof rh, 'function', 'report 路由必须注册')
    const { Readable } = await import('node:stream')
    const postReq = (body, sameOrigin = true) => {
      const rq = new Readable({ read() {} })
      rq.method = 'POST'
      rq.url = '/api/nautilus/pulse/alerts/verdict'
      rq.headers = sameOrigin ? { 'sec-fetch-site': 'same-origin' } : {}
      rq.push(Buffer.from(JSON.stringify(body), 'utf8'))
      rq.push(null)
      return rq
    }
    const callV = async (rq) => {
      const out = res()
      vh(rq, out)
      const dl2 = Date.now() + 3000
      while (Date.now() < dl2 && out.statusCode === 0) await new Promise((x) => setTimeout(x, 10))
      return out
    }
    const callG = async (url, sameOrigin = true) => {
      const out = res()
      rh({ method: 'GET', headers: sameOrigin ? { 'sec-fetch-site': 'same-origin' } : {}, url }, out)
      const dl2 = Date.now() + 3000
      while (Date.now() < dl2 && out.statusCode === 0) await new Promise((x) => setTimeout(x, 10))
      return out
    }
    assert.equal((await callV(postReq({ id: ev.id, verdict: 'true-positive' }, false))).statusCode, 403, '非同源必须 403')
    assert.equal((await callV(postReq({ verdict: 'true-positive' }))).payload.error, 'id-required')
    assert.equal((await callV(postReq({ id: ev.id, verdict: 'maybe' }))).payload.error, 'invalid-verdict', '枚举外的裁决值拒收')
    assert.equal((await callV(postReq({ id: 'a-nope-x', verdict: 'unknown' }))).statusCode, 404, '未知 id 404')
    const okV = await callV(postReq({ id: ev.id, verdict: 'false-positive', note: '  一次误报  ' }))
    assert.equal(okV.statusCode, 200)
    assert.equal(okV.payload.verdict, 'false-positive')
    assert.equal(okV.payload.note, '一次误报', '备注 trim 后存')
    const s2 = openPulseStore(join(tmp, 'n.db'))
    assert.equal(s2.alertById(ev.id).humanVerdict, 'false-positive', '裁决落台账')
    assert.equal(s2.alertById(ev.id).note, '一次误报')
    s2.close()
    const rp = await callG('/api/nautilus/pulse/alerts/report?id=' + encodeURIComponent(ev.id))
    assert.equal(rp.statusCode, 200)
    assert.ok(rp.payload.markdown.includes('## 一、事实'), '报告查看入口返回全文')
    assert.ok(String(rp.payload.path).endsWith(ev.id + '.md'))
    assert.equal((await callG('/api/nautilus/pulse/alerts/report?id=a-nope-x')).statusCode, 404, '未成文如实 404')
    assert.equal((await callG('/api/nautilus/pulse/alerts/report', false)).statusCode, 403)
    assert.ok(readFileSync(join(tmp, 'alerts', 'ledger.md'), 'utf8').includes('裁决'), '裁决进人读台账')
    } finally { await dispose() }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

// ── A.2 证据冻结：覆盖率口径 / 指纹确定性 / 独立保留期 ───────────────────────

test('computeCoverage：以**去重时间戳**算采样档与空洞（同 tick 15 条指标不得把间隔算成 0）', () => {
  // 回归位：同一时刻写多条指标——若用原始行算间隔，cadence 恒为 0、空洞永远检不出（2026-09-21 真 bug）
  const dupHeavy = []
  for (let t = 0; t <= 40; t += 10) for (let m = 0; m < 15; m++) dupHeavy.push(t)   // 5 个 tick × 15 指标
  const ok = computeCoverage(dupHeavy, 40)
  assert.equal(ok.distinctTicks, 5, '去重后只剩 5 个真实 tick')
  assert.equal(ok.cadenceMs, 10, '采样档 = 相邻间隔中位数，不是 0')
  assert.equal(ok.gaps.length, 0)
  assert.equal(ok.coverage, 1)
  // 一个 100ms 的空洞（阈值 3×cadence）：missingMs = 100 − 10 = 90，span 200 → 覆盖 55%
  const withGap = [0, 10, 20, 120, 130, 140, 150, 160, 170, 180, 190, 200]
  const g = computeCoverage(withGap, 200)
  assert.equal(g.cadenceMs, 10)
  assert.equal(g.gaps.length, 1)
  assert.equal(g.gaps[0].from, 20)
  assert.equal(g.gaps[0].to, 120)
  assert.equal(g.gaps[0].gapMs, 100)
  assert.equal(g.missingMs, 90)
  assert.equal(g.coverage, 1 - 90 / 200, 'coverage = 1 − missingMs/span（可复算）')
  // 极端：0 / 1 个 tick 不除零
  assert.equal(computeCoverage([], 1000).coverage, 0)
  assert.equal(computeCoverage([5], 1000).coverage, 1)
  // 定序：JSONL 与输入顺序无关（指纹可复算）
  const a = samplesToJsonl([{ ts: 2, metric: 'b', value: 1, tags: '{}' }, { ts: 1, metric: 'a', value: 1, tags: '{}' }])
  const b = samplesToJsonl([{ ts: 1, metric: 'a', value: 1, tags: '{}' }, { ts: 2, metric: 'b', value: 1, tags: '{}' }])
  assert.equal(a, b, '同样内容必得同样字节')
  assert.equal(a.split('\n')[0].includes('"ts":1'), true)
})

test('freezeSnapshot：写 gz + meta，指纹对内容确定；meta 覆盖覆盖率/空洞/活跃会话/era', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-snap-'))
  try {
    const rows = []
    for (const ts of [0, 5000, 10000, 15000]) for (const m of ['pulse.mem.used', 'pulse.mem.total']) rows.push({ ts, metric: m, value: 1, tags: '{}' })
    const opt = {
      root: tmp, alertId: 'a-test-1-mem-occupancy', ruleId: 'mem-occupancy',
      metric: 'pulse.mem.used / pulse.mem.total', op: 'gte', threshold: 0.9, clear: 0.85,
      from: 0, to: 15000, rows, activeSessions: 3, now: 1790000000000,
    }
    const r1 = freezeSnapshot(opt)
    const r2 = freezeSnapshot({ ...opt, rows: [...rows].reverse() })   // 乱序输入
    assert.equal(r1.snapshotHash, r2.snapshotHash, '指纹只认内容，不认输入顺序')
    assert.equal(r1.snapshotHash.length, 64, 'sha256 hex')
    const gz = readFileSync(r1.samplesPath)
    const text = gunzipSync(gz).toString('utf8')
    assert.equal(text.trim().split('\n').length, rows.length, '原始行不丢不重')
    const meta = JSON.parse(readFileSync(r1.metaPath, 'utf8'))
    assert.equal(meta.rows, 8)
    assert.equal(meta.distinctTicks, 4)
    assert.equal(meta.cadenceMs, 5000)
    assert.equal(meta.coverage, 1)
    assert.equal(meta.gapCount, 0)
    assert.equal(meta.activeSessions, 3)
    assert.equal(meta.era, 'api', 'era 缺省 api（措辞分级：只作对照）')
    assert.deepEqual(meta.metrics, ['pulse.mem.total', 'pulse.mem.used'])
    assert.equal(meta.lookbackMs, 15000)
    assert.equal(meta.generator.startsWith('nautilus/pulse/snapshot@'), true)
    // 空窗口也能冻结（如实记 0 行，不抛错、不编数据）
    const empty = freezeSnapshot({ ...opt, alertId: 'a-empty-r', rows: [], from: 0, to: 1000 })
    assert.equal(JSON.parse(readFileSync(empty.metaPath, 'utf8')).rows, 0)
    assert.equal(JSON.parse(readFileSync(empty.metaPath, 'utf8')).coverage, 0)
    // 目录统计
    const st = snapshotStats(tmp)
    assert.equal(st.dirs, 2)
    assert.ok(st.bytes > 0)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

test('pruneSnapshots：只清理过期 a-* 快照与对应报告，不动新目录、不动外来目录', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-prune-'))
  try {
    const now = 1790000000000
    const oldId = alertIdFor(now - 90 * 86400000, 'mem-occupancy')   // 90 天前
    const newId = alertIdFor(now - 1 * 86400000, 'mem-occupancy')    // 1 天前
    for (const id of [oldId, newId]) {
      mkdirSync(join(tmp, id), { recursive: true })
      writeFileSync(join(tmp, id, 'samples.jsonl.gz'), 'x')
    }
    mkdirSync(join(tmp, 'reports'), { recursive: true })
    writeFileSync(join(tmp, 'reports', oldId + '.md'), '# old')
    writeFileSync(join(tmp, 'reports', newId + '.md'), '# new')
    mkdirSync(join(tmp, 'someone-elses-dir'), { recursive: true })   // 非本插件命名 → 不碰
    const removed = pruneSnapshots(tmp, now - 30 * 86400000)
    assert.deepEqual(removed, [oldId])
    assert.equal(existsSync(join(tmp, oldId)), false)
    assert.equal(existsSync(join(tmp, 'reports', oldId + '.md')), false, '报告随快照一起清')
    assert.equal(existsSync(join(tmp, newId)), true, '保留期内不动')
    assert.equal(existsSync(join(tmp, 'someone-elses-dir')), true, '只碰自己命名的 a-* 目录（红线 3）')
    assert.equal(pruneSnapshots(join(tmp, 'nope'), now).length, 0, '目录不存在 = 无操作')
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

// ── A.3 报告：确定性 digest / 事实段 / 解析 / 三段式 ─────────────────────────

test('aggregateMetrics + buildDigest + digestFacts：确定性、定序、空值不计、措辞带 era 分级', () => {
  const rows = [
    { ts: 1, metric: 'pulse.mem.used', value: 10, tags: '{}' },
    { ts: 1, metric: 'pulse.mem.total', value: 100, tags: '{}' },
    { ts: 2, metric: 'pulse.mem.used', value: 30, tags: '{}' },
    { ts: 2, metric: 'pulse.mem.used', value: null, tags: '{}' },
    { ts: 3, metric: 'pulse.mem.used', value: 20, tags: '{}' },
  ]
  const agg = aggregateMetrics(rows)
  const used = agg.find((m) => m.metric === 'pulse.mem.used')
  assert.deepEqual(used, { metric: 'pulse.mem.used', n: 3, min: 10, max: 30, last: 20, mean: 20 }, 'null 不计入 n，末值取最后一个非空')
  assert.deepEqual(agg.map((m) => m.metric), ['pulse.mem.total', 'pulse.mem.used'], '按指标名定序')
  const meta = {
    alertId: 'a-1-r', ruleId: 'r', metric: 'pulse.mem.used', op: 'gte', threshold: 0.9, clear: 0.85,
    from: 0, to: 1800000, lookbackMs: 1800000, rows: 5, metrics: ['pulse.mem.used'], distinctTicks: 3,
    cadenceMs: 5, coverage: 0.82, missingMs: 1000, gapCount: 2, maxGapMs: 1260000, gaps: [],
    activeSessions: 2, era: 'api', createdAt: 5, generator: 'x',
  }
  const d = buildDigest({
    alertId: 'a-1-r', ruleId: 'r', ruleLabel: '内存占比', metric: 'pulse.mem.used / pulse.mem.total',
    op: 'gte', threshold: 0.9, clear: 0.85, firstExceededAt: 1000, confirmedAt: 31000, peak: 0.98,
    meta, snapshotHash: 'f'.repeat(64), metrics: agg, now: 99999,
  })
  assert.equal(d.window.lookbackMs, 1800000)
  assert.equal(d.evidence.coverage, 0.82)
  assert.equal(d.metrics.length, 2)
  const facts = digestFacts(d)
  assert.ok(facts[0].includes('内存占比') && facts[0].includes('gte 0.9'))
  assert.ok(facts[1].includes('首次越线') && facts[1].includes('连续 30s'))
  assert.ok(facts.some((f) => f.includes('覆盖 82.0%') && f.includes('最大 21min')), '覆盖率与最大空洞进事实段')
  assert.ok(facts.some((f) => f.includes('仅作对照')), 'api 时代措辞分级写进事实段')
  assert.deepEqual(digestFacts(d), facts, '纯函数：同输入同事实段')
})

test('parseHypotheses + composeReport + composeResultNote：两段解析、缺格式不丢内容、缺席不假装有结论', () => {
  const raw = '前缀\n=== 候选假设 ===\n- A（依据 x；验证 y）\n=== 待查 ===\n- 需要 z\n'
  const parsed = parseHypotheses(raw)
  assert.equal(parsed.parsed, true)
  assert.ok(parsed.hypotheses.includes('A（依据 x'))
  assert.ok(parsed.toCheck.includes('需要 z'))
  const bad = parseHypotheses('模型随口答的一段话')
  assert.equal(bad.parsed, false)
  assert.equal(bad.hypotheses, '模型随口答的一段话', '格式不符也不丢内容')
  assert.equal(bad.toCheck, '')

  const d = {
    alertId: 'a-1-r', ruleId: 'r', ruleLabel: '内存占比', metric: 'm', op: 'gte', threshold: 0.9, clear: 0.85,
    firstExceededAt: 0, confirmedAt: 1000, peak: 0.99,
    window: { from: 0, to: 1000, lookbackMs: 1000 },
    evidence: { rows: 10, distinctTicks: 2, cadenceMs: 500, coverage: 1, gapCount: 0, maxGapMs: 0, activeSessions: 1, snapshotHash: 'a'.repeat(64) },
    metrics: [], era: 'api', generatedAt: 0,
  }
  const facts = digestFacts(d)
  const withModel = composeReport({ digest: d, facts, raw, skipReason: null, model: 'fake/mod-1', now: 0 })
  for (const s of ['# 告警报告', '## 一、事实（程序生成，不经模型）', '## 二、候选假设（模型输出，仅供人工判定）', '## 三、待查', 'a-report-v1', 'fake/mod-1', '只作对照']) {
    assert.ok(withModel.includes(s), '报告缺内容: ' + s)
  }
  const noModel = composeReport({ digest: d, facts, raw: null, skipReason: '门禁默认关', model: null, now: 0 })
  assert.ok(noModel.includes('本段缺席：门禁默认关'), '缺席必须写明原因')
  assert.ok(noModel.includes('## 一、事实'), '事实段不受门禁影响')
  assert.ok(!noModel.includes('=== 候选假设 ==='), '未调用模型时不应有分隔符残留')
  const note = composeResultNote({ clearedAt: 5000, durationMs: 4000, peak: 0.99, value: 0.8 })
  assert.ok(note.includes('## 附：结果补记（程序生成）') && note.includes('持续：4s') && note.includes('不调用模型'))
})

test('告警报告端到端：门禁开 + 假 llm seam → done（模型段+台账内联），解除只补记不重调模型', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-alertreport-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const dbFile = join(tmp, 'n.db')
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    let calls = 0
    const fakeText = '=== 候选假设 ===\n- 会话拉长了存活期（依据：占比 0.98；验证：对比活跃会话数）\n=== 待查 ===\n- 需要同窗口的 dsh 进程 RSS'
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    ctx.provide('llm', {
      stream(opts) {
        calls += 1
        // 断言插件确实按契约传参（provider/model/messages/maxTokens/signal）
        if (typeof opts.provider !== 'string' || typeof opts.model !== 'string') throw new Error('bad options')
        if (!Array.isArray(opts.messages) || typeof opts.signal === 'undefined') throw new Error('bad options')
        async function* gen() { yield { type: 'reasoning-delta', text: '不计入' }; yield { type: 'text-delta', text: fakeText } }
        return gen()
      },
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'mod-1' }) })
    const fiber = ctx.plugin(mod, {
      pulse: {
        enabled: true, enableCounters: false, enableGpu: false, intervalMs: 1000, dbFile,
        alertLlmEnabled: true,
        alertRules: [{ id: 'mem-occupancy', label: '内存占比', metric: 'pulse.mem.used', refMetric: 'pulse.mem.total', op: 'gte', threshold: 0, clear: -1, forMs: 0 }],
      },
    })
    let disposed = false
    const dispose = async () => { if (!disposed) { disposed = true; await fiber.dispose() } }
    try {
    const dl = Date.now() + 8000
    let reportPath = ''
    while (Date.now() < dl) {
      const dir = join(tmp, 'alerts', 'reports')
      if (existsSync(dir)) {
        const any = readdirSync(dir).filter((f) => f.endsWith('.md'))
        if (any.length > 0) { reportPath = join(dir, any[0]); break }
      }
      await new Promise((x) => setTimeout(x, 100))
    }
    assert.ok(reportPath !== '', '报告必须生成')
    const text = readFileSync(reportPath, 'utf8')
    assert.ok(text.includes('会话拉长了存活期'), '模型段进报告')
    assert.ok(text.includes('fake/mod-1') && text.includes('a-report-v1'), '模型与模板版本记账')
    assert.ok(text.includes('需要同窗口的 dsh 进程 RSS'), '待查段进报告')
    assert.equal(calls, 1, '一次告警只调一次模型（去重）')
    const alertId = reportPath.split(/[\\/]/).pop().replace(/\.md$/, '')
    // 台账结构化回读：done + 模型名
    const s = openPulseStore(dbFile)
    const row = s.alertById(alertId)
    assert.equal(row.reportStatus, 'done')
    assert.equal(row.reportModel, 'fake/mod-1')
    assert.equal(row.promptVersion, 'a-report-v1')
    assert.ok(row.snapshotHash !== null)
    assert.equal(row.clearedAt, null, '该轮尚未解除')
    // 台账人读日志内联了报告全文
    const ledgerText = readFileSync(join(tmp, 'alerts', 'ledger.md'), 'utf8')
    assert.ok(ledgerText.includes('候选假设'), 'ledger.md 内联报告')
    assert.ok(ledgerText.includes('**报告**'), '台账报告行')
    // 解除 → 补记（不重调模型）
    s.close()
    const before = calls
    await dispose()
    assert.equal(calls, before, '解除不触发新模型调用（补记是程序生成的）')
    } finally { await dispose() }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

// ── A.4 客户端半区：徽标纯函数 + 告警视图 SSR（真实 react 渲染）────────────────

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))

test('告警视图 SSR + 徽标纯函数：台账/裁决/报告状态/规则表齐全，缺席态不编数', async () => {
  const esbuild = await import('esbuild')
  const rds = await import('react-dom/server')
  const react = await import('react')
  const renderToStaticMarkup = rds.renderToStaticMarkup ?? rds.default?.renderToStaticMarkup
  // 临时产物建在仓库内（bundle external react 靠目录树向上解析到本仓库 node_modules；UI 线先例同款）
  const dir = mkdtempSync(join(REPO_DIR, '.alerts-smoke-'))
  const out = join(dir, 'alerts.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [join(REPO_DIR, 'src', 'client', 'alerts.ts')],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    })
    const al = await import(pathToFileURL(out).href)
    const row = (over = {}) => ({
      id: 'a-mf3k-mem-occupancy', ruleId: 'mem-occupancy', metric: 'pulse.mem.used / pulse.mem.total',
      op: 'gte', threshold: 0.93, firstExceededAt: 1000, confirmedAt: 121000, clearedAt: null,
      peakValue: 0.9621, durationMs: null, snapshotPath: 'C:/x/samples.jsonl.gz', snapshotHash: 'a'.repeat(64),
      reportStatus: 'done', reportModel: 'fake/mod-1', promptVersion: 'a-report-v1', humanVerdict: null,
      note: null, createdAt: 121000, ...over,
    })
    const state = {
      revision: 1, enabled: true,
      counts: { open: 1, total: 3, last24h: 2, rules: 5, rulesEnabled: 4 },
      rules: [{
        id: 'mem-occupancy', label: '内存占比', enabled: true, metric: 'pulse.mem.used', refMetric: 'pulse.mem.total',
        expr: 'pulse.mem.used / pulse.mem.total', op: 'gte', threshold: 0.93, clear: 0.88, forMs: 120000, cooldownMs: 0,
        state: { exceeding: true, open: true, firstExceededAt: 1000, confirmedAt: 121000, alertId: 'a-mf3k-mem-occupancy', peak: 0.9621, lastValue: 0.951, lastTs: 200000, skippedTicks: 0 },
      }, {
        id: 'dsh-rss', label: '宿主 RSS', enabled: false, metric: 'pulse.proc.dsh.rss', refMetric: '',
        expr: 'pulse.proc.dsh.rss', op: 'gte', threshold: 4e9, clear: 3.5e9, forMs: 120000, cooldownMs: 0, state: null,
      }],
      active: [row()],
      recent: [row()],
      evidence: { dirs: 1, bytes: 78083, oldestTs: 121000, newestTs: 121000 },
      reportsDir: 'C:/x/reports',
    }
    const badge = al.alertBadgeOf(state)
    assert.deepEqual(badge, { active: 1, unjudged: 1, enabled: true })
    assert.deepEqual(al.alertBadgeOf(null), { active: 0, unjudged: 0, enabled: false }, '缺席不编数')
    assert.deepEqual(al.alertBadgeOf({ ...state, recent: [row({ humanVerdict: 'false-positive' })] }).unjudged, 0, '已裁决不计入未裁决')
    assert.equal(al.ruleText(state.rules[0]).includes('窗 120s'), true)
    assert.equal(al.ruleText(state.rules[0]).includes('解除 0.88'), true)
    const h = (n) => renderToStaticMarkup(n)
    const html = h(react.createElement(al.AlertsView, { state, toast: () => {}, reload: () => {} }))
    for (const s of ['活跃 1', '近 24h 2', 'mem-occupancy', '未解除', '真阳性', '假阳性', '未知',
      '查看报告', '规则表', '告警台账', '未裁决', '报告已成文', 'a-report-v1', '4/5 启用', '证据 1 份']) {
      assert.ok(html.includes(s), '告警视图 SSR 缺内容: ' + s)
    }
    assert.ok(html.includes('已停用'), '停用规则要显式标注')
    assert.ok(!html.includes('undefined'), 'SSR 不得出现 undefined')
    assert.ok(h(react.createElement(al.AlertsView, { state: null, toast: () => {}, reload: () => {} })).includes('告警能力缺席'))
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

test('告警视图接线：ViewKey/侧栏标签/取数口与图标徽标（源码级守卫）', () => {
  const wb = readFileSync(join(REPO_DIR, 'src', 'client', 'workbench.ts'), 'utf8')
  assert.ok(wb.includes("alerts: '告警'"), '视图标签必须登记')
  assert.ok(wb.includes("'overview', 'alerts', 'curve'"), '分段控件必须含告警')
  assert.ok(wb.includes("useJson<AlertsState>('/api/nautilus/pulse/alerts?limit=50'"), '工作台取数口')
  assert.ok(wb.includes('useAlertBadge()'), '图标徽标接线（活跃即闪红）')
  assert.ok(wb.includes('nt-icon-alert'), '图标闪红类')
  const ax = readFileSync(join(REPO_DIR, 'src', 'client', 'alerts.ts'), 'utf8')
  assert.ok(ax.includes("conversation") === false, '告警半区不该碰会话槽位')
  assert.ok(ax.includes('/api/nautilus/pulse/alerts/verdict'), '裁决走同源 POST')
  assert.ok(ax.includes('sec-fetch-site'), '同源标记必须带')
})
