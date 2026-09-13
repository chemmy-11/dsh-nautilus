/**
 * @dsh-external/dsh-nexus — pure-function regression tests (zero deps, node:test).
 * Tests the BUILT artifacts (lib/) — run `npm run build` first (CI: install → build → test).
 * Coverage: analysis.ts (A 投影/S 形/爆发段/τ_e) + selfcheck.ts (自评三行) + scan.ts (R4 分支).
 * 依赖 node:sqlite（Node ≥ 22.13/24，CI node-version 24）与临时目录（mkdtemp）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { missRateOf, smoothedMissRate, detectBurst, estimateTauE, analyzeSession, analyze } from '../lib/analysis.js'
import { processSelfCheck, buildSelfCheckTool } from '../lib/selfcheck.js'
import { openStore } from '../lib/store.js'
import { scanVault } from '../lib/scan.js'
import { DatabaseSync } from 'node:sqlite'
import { cpuTimes, cpuUtilization, parseCounters, parseNvidiaSmi, collectLocal } from '../lib/pulse/collect.js'
import { openPulseStore } from '../lib/pulse/store.js'

// ── analysis.ts ───────────────────────────────────────────────────────────────

test('missRateOf: 正常比值 + 分母 0 → null（与 0% 合法值区分）', () => {
  assert.equal(missRateOf({ tokenIn: 2, cacheRead: 8 }), 0.2)
  assert.equal(missRateOf({ tokenIn: 0, cacheRead: 10 }), 0)
  assert.equal(missRateOf({ tokenIn: 0, cacheRead: 0 }), null)
})

test('smoothedMissRate: 邻窗移动平均（跳过 null）', () => {
  const pts = [
    { session: 's', turn: 1, ts: 1, tokenIn: 0, cacheRead: 10, durationMs: null, tps: null },
    { session: 's', turn: 2, ts: 2, tokenIn: 10, cacheRead: 0, durationMs: null, tps: null },
    { session: 's', turn: 3, ts: 3, tokenIn: 0, cacheRead: 10, durationMs: null, tps: null },
  ]
  const sm = smoothedMissRate(pts, 3)
  assert.deepEqual(sm.map((p) => p.rate), [0.5, 1 / 3, 0.5])
  // 全零分母 → null 序列（窗口内全 null 时 rate=null）
  const nulls = smoothedMissRate([
    { session: 's', turn: 1, ts: 1, tokenIn: 0, cacheRead: 0, durationMs: null, tps: null },
    { session: 's', turn: 2, ts: 2, tokenIn: 0, cacheRead: 0, durationMs: null, tps: null },
  ])
  assert.ok(nulls.every((p) => p.rate === null))
})

test('detectBurst: 下降爆发段检出（3 显著步，direction=down）', () => {
  const sm = [
    { turn: 1, rate: 0.8 },
    { turn: 2, rate: 0.45 },
    { turn: 3, rate: 0.2 },
    { turn: 4, rate: 0.18 },
    { turn: 5, rate: 0.19 },
  ]
  const burst = detectBurst(sm, 2, 0.15)
  assert.deepEqual(burst, { fromTurn: 1, toTurn: 3, direction: 'down' })
})

test('detectBurst: 平线/无显著变化 → null', () => {
  const flat = [
    { turn: 1, rate: 0.2 },
    { turn: 2, rate: 0.21 },
    { turn: 3, rate: 0.19 },
  ]
  assert.equal(detectBurst(flat, 2, 0.15), null)
})

test('estimateTauE: down 方向 1/e 衰减 → 中位 gap（turn 差）', () => {
  const pts = [
    { session: 's', turn: 1, ts: 1, tokenIn: 8, cacheRead: 2, durationMs: null, tps: null },
    { session: 's', turn: 2, ts: 2, tokenIn: 9, cacheRead: 11, durationMs: null, tps: null },
    { session: 's', turn: 3, ts: 3, tokenIn: 1, cacheRead: 4, durationMs: null, tps: null },
  ]
  // rates: 0.8 → 0.45 → 0.2；down：ratio ≤ 1/e ⇒ (1,3) gap=2
  assert.equal(estimateTauE({ fromTurn: 1, toTurn: 3, direction: 'down' }, pts), 2)
  // 无任何 e 倍配对 → null
  assert.equal(estimateTauE({ fromTurn: 1, toTurn: 3, direction: 'up' }, pts), null)
})

test('analyzeSession: 下降后平缓 → inverse-sigmoid（带爆发段与 τ_e）', () => {
  const pts = [
    { session: 's', turn: 1, ts: 1, tokenIn: 8, cacheRead: 2, durationMs: null, tps: null },
    { session: 's', turn: 2, ts: 2, tokenIn: 9, cacheRead: 11, durationMs: null, tps: null },
    { session: 's', turn: 3, ts: 3, tokenIn: 1, cacheRead: 4, durationMs: null, tps: null },
    { session: 's', turn: 4, ts: 4, tokenIn: 2, cacheRead: 8, durationMs: null, tps: null },
    { session: 's', turn: 5, ts: 5, tokenIn: 2, cacheRead: 8, durationMs: null, tps: null },
  ]
  const r = analyzeSession(pts)
  assert.equal(r.shape, 'inverse-sigmoid')
  assert.equal(r.burst?.direction, 'down')
  assert.ok(r.burst !== null && r.burst.fromTurn === 1 && r.burst.toTurn === 4)
  assert.equal(typeof r.tauE, 'number')
})

test('analyze: 多会话分组（组内按 turn 升序）', () => {
  const pts = [
    { session: 'A', turn: 2, ts: 2, tokenIn: 8, cacheRead: 2, durationMs: null, tps: null },
    { session: 'A', turn: 1, ts: 1, tokenIn: 8, cacheRead: 2, durationMs: null, tps: null },
    { session: 'B', turn: 1, ts: 1, tokenIn: 0.1, cacheRead: 9.9, durationMs: null, tps: null },
  ]
  const out = analyze(pts)
  assert.equal(out.length, 2)
  const a = out.find((x) => x.session === 'A')
  assert.deepEqual(a?.points.map((p) => p.turn), [1, 2]) // 组内升序
})

// ── selfcheck.ts ─────────────────────────────────────────────────────────────

function makeStore(rows) {
  let recorded = null
  return {
    rows,
    turnReads: (limit) => rows.slice(0, limit),
    setSelfCheck: (session, turn, check) => { recorded = { session, turn, check } },
    get recorded() { return recorded },
  }
}

test('processSelfCheck: 夹取/默认/落库/返回串', () => {
  const store = makeStore([{ session: 's1', turn: 3 }])
  const msg = processSelfCheck(store, { clarity: 1.5, defense: 'light', declaration: 1, session: 's1', turn: 3 })
  assert.ok(msg.startsWith('已记录 turn 3 自评'))
  assert.deepEqual(store.recorded, { session: 's1', turn: 3, check: { clarity: 1, defense: 'light', declaration: 1 } })
  // 非法值兜底：clarity<0 → 0；defense 未知 → none；declaration≠1 → 0
  const store2 = makeStore([{ session: 's1', turn: 1 }])
  processSelfCheck(store2, { clarity: -0.2, defense: 'nope', declaration: 2, session: 's1', turn: 1 })
  assert.deepEqual(store2.recorded.check, { clarity: 0, defense: 'none', declaration: 0 })
})

test('processSelfCheck: 缺省 session/turn → 最近一轮', () => {
  const store = makeStore([{ session: 's2', turn: 7 }])
  processSelfCheck(store, { clarity: 0.5, defense: 'heavy', declaration: 0 })
  assert.deepEqual(store.recorded, { session: 's2', turn: 7, check: { clarity: 0.5, defense: 'heavy', declaration: 0 } })
})

test('processSelfCheck: 空库 → 失败文案', () => {
  const store = makeStore([])
  const msg = processSelfCheck(store, { clarity: 0.5, defense: 'none', declaration: 0 })
  assert.ok(msg.includes('尚无任何会话轮次'))
})

test('buildSelfCheckTool: schema 契约（additionalProperties/required/canonical output）', () => {
  const tool = buildSelfCheckTool(makeStore([{ session: 's', turn: 1 }]))
  assert.equal(tool.name, 'record_turn_selfcheck')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['clarity', 'defense', 'declaration'])
  assert.equal(tool.parameters.properties.defense.enum.length, 3)
  assert.equal(tool.output.schema.type, 'string')
  const rendered = tool.output.render({}, 'ok')
  assert.equal(rendered[0].text, 'ok')
})

// ── scan.ts（R4 分支：mtime/size 未变跳过 readFile；复活/更新路径） ──────────

test('scanVault: 基线创建 → 未变跳过（R4）→ 改动更新', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xg-scan-'))
  const vault = join(tmp, 'vault')
  mkdirSync(vault)
  try {
    writeFileSync(join(vault, 'a.md'), '---\ntitle: x\n---\n正文 abc', 'utf8')
    writeFileSync(join(vault, 'b.md'), 'hello world', 'utf8')
    const store = openStore(join(tmp, 'nexus.db'))
    try {
      const r1 = await scanVault(store, vault, [])
      assert.deepEqual({ created: r1.created, updated: r1.updated, removed: r1.removed }, { created: 2, updated: 0, removed: 0 })
      assert.equal(store.getMeta('a.md', vault).chars, 5) // 正文abc（去空白）
      assert.equal(store.getMeta('b.md', vault).chars, 10) // helloworld

      // M4：root 口径——root 列 = 被扫描 vault；totals 按 activeRoot 过滤
      assert.equal(store.getMeta('a.md', vault).root, vault)
      assert.equal(store.totals(vault).totalFiles, 2)
      assert.equal(store.totals('').totalFiles, 0)

      const r2 = await scanVault(store, vault, []) // 未变 → R4 跳过分支
      assert.equal(r2.created, 0)
      assert.equal(r2.updated, 0)

      // 改动 a.md（显式设置未来 mtime，避免同 ms 竞态）
      writeFileSync(join(vault, 'a.md'), '---\n---\n正文 abc def', 'utf8')
      const t = new Date(Date.now() + 5000)
      utimesSync(join(vault, 'a.md'), t, t)
      const r3 = await scanVault(store, vault, [])
      assert.equal(r3.updated, 1)
      assert.equal(store.getMeta('a.md', vault).chars, 8) // 正文abcdef

      // 删除 b.md → removed 校准
      rmSync(join(vault, 'b.md'))
      const r4 = await scanVault(store, vault, [])
      assert.equal(r4.removed, 1)
      assert.equal(store.getMeta('b.md', vault).deleted, 1)
    } finally {
      store.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── pulse（OS 层）：采集纯函数 ────────────────────────────────────────────────

test('cpuUtilization: 差值算使用率；零增量/回绕 → null（缺席而非 0）', () => {
  const a = { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 }
  const b = { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 } // busy 100 / idle 100 → 0.5
  assert.equal(cpuUtilization(a, b), 0.5)
  assert.equal(cpuUtilization(a, a), null)
  assert.equal(cpuUtilization(b, a), null)
})

test('parseCounters: 合法 JSON 映射（字符串数字 + MiB→bytes）；空/非法/全缺 → null', () => {
  const ok = parseCounters(JSON.stringify({ ctxSwitchesPerSec: '43001', diskBytesPerSec: 24855079, diskQueueLength: 0, netBytesPerSec: 1102, pageFileUsedMiB: 2 }))
  assert.equal(ok.ctxSwitchesPerSec, 43001)
  assert.equal(ok.diskQueueLength, 0)
  assert.equal(ok.pageFileUsedBytes, 2 * 1024 * 1024)
  assert.equal(parseCounters(''), null)
  assert.equal(parseCounters('not json'), null)
  assert.equal(parseCounters(JSON.stringify({ unrelated: 1 })), null)
})

test('parseNvidiaSmi: CSV 解析（N/A → null）；垃圾行跳过；空输出 → []', () => {
  const out = parseNvidiaSmi('0, NVIDIA GeForce RTX 5060 Laptop GPU, 8, 1503, 8151, 64, 24.67\n1, Fake, N/A, N/A, N/A, N/A, N/A\n')
  assert.equal(out.length, 2)
  assert.deepEqual(
    { index: out[0].index, util: out[0].util, memUsedMiB: out[0].memUsedMiB, powerW: out[0].powerW },
    { index: 0, util: 8, memUsedMiB: 1503, powerW: 24.67 },
  )
  assert.equal(out[1].util, null)
  assert.equal(parseNvidiaSmi('garbage line without commas').length, 0)
  assert.equal(parseNvidiaSmi('').length, 0)
})

test('collectLocal: 首轮无 CPU 使用率；进程级 CPU 按单核分数口径', () => {
  const t = cpuTimes()
  const first = collectLocal(null, t, { user: 0, system: 0 }, 5000, 12345)
  assert.deepEqual(first.map((s) => s.metric), ['pulse.mem.used', 'pulse.mem.total', 'pulse.proc.dsh.rss', 'pulse.proc.dsh.cpu'])
  const prev = { user: t.user - 100, nice: t.nice, sys: t.sys - 100, idle: t.idle - 800, irq: t.irq }
  const second = collectLocal(prev, t, { user: 5000, system: 5000 }, 5000, 12345)
  assert.ok(second.some((s) => s.metric === 'pulse.cpu.utilization'))
  assert.equal(second.find((s) => s.metric === 'pulse.proc.dsh.cpu').value, 10000 / 1000 / 5000)
})

// ── pulse（OS 层）：存储与迁移 ──────────────────────────────────────────────

test('PulseStore: 全新库只建表不抢版本；v3 库推进到 v4 且幂等', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pulse-store-'))
  try {
    const fresh = join(tmp, 'fresh.db')
    const s1 = openPulseStore(fresh)
    assert.equal(s1.schemaVersion(), 0)
    s1.close()
    const s1b = openPulseStore(fresh)
    assert.equal(s1b.schemaVersion(), 0)
    s1b.insert(1000, 'pulse', [{ metric: 'pulse.cpu.utilization', value: 0.5, tags: { host: 'h' } }])
    assert.equal(s1b.status().rows, 1)
    s1b.close()

    const v3 = join(tmp, 'v3.db')
    const raw = new DatabaseSync(v3)
    raw.exec('PRAGMA user_version = 3')
    raw.close()
    const s2 = openPulseStore(v3)
    assert.equal(s2.schemaVersion(), 4)
    s2.close()
    const s3 = openPulseStore(v3)
    assert.equal(s3.schemaVersion(), 4)
    s3.close()
    // Windows：SQLite 关闭后 wal/shm 可能被短暂占用 → 带重试清理
  } finally { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('PulseStore: insert/latest/series 桶均值/prune 保留', () => {
  // 用内存库：同一套 SQL，避开 Windows 上「语句未 GC → 文件句柄滞留」的清理竞态
  {
    const store = openPulseStore(':memory:')
    store.insert(1000, 'pulse', [{ metric: 'm', value: 1, tags: {} }, { metric: 'm2', value: 10, tags: {} }])
    store.insert(2000, 'pulse', [{ metric: 'm', value: 3, tags: {} }])
    store.insert(9000, 'pulse', [{ metric: 'm', value: 5, tags: {} }])
    const latest = store.latest().filter((r) => r.metric === 'm')
    assert.equal(latest.length, 1)
    assert.equal(latest[0].value, 5)
    const series = store.series('m', 0, 10000, 2)
    assert.equal(series.length, 2)
    assert.equal(series[0].value, 2)
    assert.equal(series[1].value, 5)
    assert.equal(store.prune(5000), 3) // ts<5000 的三行：m@1000、m2@1000、m@2000
    assert.equal(store.status().rows, 1)
    store.close()
  }
})

