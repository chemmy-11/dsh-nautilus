/**
 * @dsh-external/dsh-nautilus — A 系列（OS 层红线告警）回归测试。
 * 独立文件的原因：与 test.mjs / test-t.mjs 分文件并行演进（两线纪律，dev-05 序言同款）。
 * Tests the BUILT artifacts (lib/) + 真实 ctx.plugin 装配（同源门 / 路由注册）。
 * 运行：npm test（test.mjs + test-t.mjs + 本文件并列）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'

import { AlertEngine, DEFAULT_ALERT_RULES, alertIdFor, alertMetricExpr, validateAlertRules } from '../lib/pulse/alerts.js'
import { computeCoverage, freezeSnapshot, pruneSnapshots, samplesToJsonl, snapshotStats } from '../lib/pulse/snapshot.js'
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
    assert.ok(snap.evidence !== null && snap.evidence.dirs >= 1, '证据目录现状随快照一起可见')
    await fiber.dispose()
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
