/**
 * @dsh-external/dsh-nautilus — pure-function regression tests (zero deps, node:test).
 * Tests the BUILT artifacts (lib/) — run `npm run build` first (CI: install → build → test).
 * Coverage: analysis.ts (A 投影/S 形/爆发段/τ_e) + selfcheck/ingest (M3-F.1 工具 + S1.1 多源通道) + pulse + 装配路径。
 * 依赖 node:sqlite（Node ≥ 22.13/24，CI node-version 24）与临时目录（mkdtemp）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { missRateOf, smoothedMissRate, detectBurst, estimateTauE, analyzeSession, analyze } from '../lib/nexus/analysis.js'
import { processSelfCheck, buildSelfCheckTool } from '../lib/nexus/selfcheck.js'
import { validateIngest, ingestSelfCheck, QUOTE_MAX } from '../lib/nexus/selfcheck-ingest.js'
import { openStore } from '../lib/store.js'
import { DatabaseSync } from 'node:sqlite'
// PS.0fix：多端共享前置（显式数据目录 / 连接级 PRAGMA / 采集丢写可见化）
import { resolveDataDir } from '../lib/home.js'
import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/sqlite.js'
import { TurnsCollector } from '../lib/nexus/turns.js'
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

// ── selfcheck.ts / selfcheck-ingest.ts（M3-F.1 工具 + S1.1 共享口径）───────────

function makeStore(rows) {
  const records = []
  return {
    rows, records,
    turnReads: (limit) => rows.slice(0, limit),
    insertSelfCheckRecord: (row) => { records.push(row); return records.length === 1 ? 'inserted' : 'duplicate' },
    selfcheckWorkspaceOf: () => null,
  }
}

test('processSelfCheck（AL.3 新形）: align/boundary/declaration 落共享 ingest，缺省归一但不夹取', () => {
  const store = makeStore([{ session: 's1', turn: 3 }])
  const msg = processSelfCheck(store, { align: 3, session: 's1', turn: 3 })
  assert.ok(msg.startsWith('已记录 turn 3 自评'))
  // 主存储 = 共享 ingest：身份字段齐备（agent/ext_ref 同源 sessionId，workspace 未归属 = null）
  assert.equal(store.records.length, 1)
  const r = store.records[0]
  assert.equal(r.sourceKind, 'dsh_tool')
  assert.equal(r.agent, 's1')
  assert.equal(r.extRef, 's1')
  assert.equal(r.turnOrdinal, 3)
  assert.equal(r.align, 3)
  assert.equal(r.boundary, 'none', 'boundary 缺省 = none（未越界）')
  assert.equal(r.declaration, 0, 'declaration 缺省 = 0')
  assert.equal(r.clarity, null, 'AL.3：新形 clarity 必须 NULL——不造假值填旧列')
  assert.equal(r.defense, null, 'AL.3：新形 defense 必须 NULL')
  assert.equal(r.rubricVersion, 'al-v1')
  assert.equal(r.workspace, null)
  // align 越界**不夹取**（旧工具对 clarity 的夹取随旧维度一起退场）：拒且零写入
  const store2 = makeStore([{ session: 's1', turn: 1 }])
  assert.ok(processSelfCheck(store2, { align: 6, session: 's1', turn: 1 }).startsWith('自评被拒'))
  assert.equal(store2.records.length, 0, '越界不得落库')
})

test('processSelfCheck（AL.3 硬门）: align≥4 或 declaration=1 无引文 → 拒且零写入', () => {
  const store = makeStore([{ session: 's1', turn: 2 }])
  assert.ok(processSelfCheck(store, { align: 4, session: 's1', turn: 2 }).startsWith('自评被拒'), '拒绝文案必须显式')
  assert.equal(store.records.length, 0, 'align=4 无引文：任何表都不得被写')
  assert.ok(processSelfCheck(store, { align: 5, session: 's1', turn: 2 }).startsWith('自评被拒'))
  assert.ok(processSelfCheck(store, { align: 3, declaration: 1, session: 's1', turn: 2 }).startsWith('自评被拒'))
  assert.equal(store.records.length, 0, '三个硬门都不落库')
  // 超长引文同样拒
  assert.ok(processSelfCheck(store, { align: 4, quote: '字'.repeat(QUOTE_MAX + 1), session: 's1', turn: 2 }).startsWith('自评被拒'))
  assert.equal(store.records.length, 0)
})

test('processSelfCheck: align≥4 带引文 → 落库含 quote；align≤3 且 declaration=0 带引文 → 引文丢弃', () => {
  const store = makeStore([{ session: 's1', turn: 5 }])
  const ok = processSelfCheck(store, { align: 4, boundary: 'coercion', quote: ' 「我不需要你替我做决定。」 ', evidence: '他改道', session: 's1', turn: 5 })
  assert.ok(ok.startsWith('已记录 turn 5 自评'))
  assert.equal(store.records[0].quote, '「我不需要你替我做决定。」', '引文要 trim 后存')
  assert.equal(store.records[0].boundary, 'coercion', '越界项如实落库（正交轴，不改 align）')
  assert.equal(store.records[0].evidence, '他改道')
  const before = store.records.length
  processSelfCheck(store, { align: 3, quote: '多余引文', session: 's1', turn: 5 })
  assert.equal(store.records[before].quote, null, 'align≤3 且 declaration=0 的引文不落库（防歧义行）')
})

test('processSelfCheck: 缺省 session/turn → 最近一轮；空库 → 失败文案', () => {
  const store = makeStore([{ session: 's2', turn: 7 }])
  processSelfCheck(store, { align: 2 })
  assert.deepEqual(
    { s: store.records[0].agent, t: store.records[0].turnOrdinal, a: store.records[0].align },
    { s: 's2', t: 7, a: 2 },
  )
  const empty = makeStore([])
  assert.ok(processSelfCheck(empty, { align: 2 }).includes('尚无任何会话轮次'))
})

test('buildSelfCheckTool（AL.3）: al-v1 锚文注入 + align 必填 1–5 + boundary 枚举 + canonical output', () => {
  const tool = buildSelfCheckTool(makeStore([{ session: 's', turn: 1 }]))
  assert.equal(tool.name, 'record_turn_selfcheck')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['align'], 'align 必填（boundary/declaration 有锁版缺省）')
  assert.equal(tool.parameters.properties.align.type, 'integer')
  assert.equal(tool.parameters.properties.align.minimum, 1)
  assert.equal(tool.parameters.properties.align.maximum, 5)
  assert.deepEqual(tool.parameters.properties.boundary.enum, ['none', 'substitution', 'possession', 'coercion', 'projection'])
  assert.equal(tool.parameters.properties.quote.type, 'string', 'D-SC2：quote 参数必须在场')
  assert.equal(tool.parameters.properties.quote.maxLength, QUOTE_MAX)
  for (const s of ['1 = 没接住', '2 = 接住了但没延展', '3 = 接+顺一层', '4 = 顺+推', '5 = 推到了改变下一步动作']) {
    assert.ok(tool.description.includes(s), '注入面缺锚文句：' + s)
  }
  assert.ok(tool.description.includes('quote'), '描述必须把引文要求说给模型')
  assert.equal(tool.output.schema.type, 'string')
  const rendered = tool.output.render({}, 'ok')
  assert.equal(rendered[0].text, 'ok')
})

test('validateIngest: 严格口径——旧形（clarity/defense）与新形（align/boundary）同门各判据（不夹取、不猜默认）', () => {
  const base = { sourceKind: 'http', agent: 'harness-A', extRef: 'conv-9', turnOrdinal: 2, clarity: 0.5, defense: 'light', declaration: 0 }
  assert.equal(validateIngest(base).ok, true)
  assert.equal(validateIngest({ ...base, clarity: 1.2 }).error, 'invalid:clarity')
  assert.equal(validateIngest({ ...base, clarity: '0.5' }).error, 'invalid:clarity')
  assert.equal(validateIngest({ ...base, defense: 'max' }).error, 'invalid:defense')
  assert.equal(validateIngest({ ...base, declaration: 2 }).error, 'invalid:declaration')
  assert.equal(validateIngest({ ...base, sourceKind: 'carrier-pigeon' }).error, 'invalid:source_kind')
  assert.equal(validateIngest({ ...base, turnOrdinal: 0 }).error, 'invalid:turn_ordinal')
  assert.equal(validateIngest({ ...base, agent: '  ' }).error, 'invalid:agent')
  assert.equal(validateIngest({ ...base, declaration: 1 }).error, 'quote-required')
  assert.equal(validateIngest({ ...base, declaration: 1, quote: '原句' }).ok, true)
  assert.equal(validateIngest({ ...base, declaration: 1, quote: '字'.repeat(QUOTE_MAX + 1) }).error, 'quote-too-long')
  // ts_client / schema_version 非法即拒；合法归一为整数
  assert.equal(validateIngest({ ...base, tsClient: -5 }).error, 'invalid:ts_client')
  assert.equal(validateIngest({ ...base, tsClient: 1.9 }).record.tsClient, 1)
  assert.equal(validateIngest({ ...base, schemaVersion: 0 }).error, 'invalid:schema_version')
  // AL.3 新形：同一份 ingest 收两代（有 align 即新路径），越界/缺引文一律拒
  const al = { sourceKind: 'http', agent: 'harness-A', extRef: 'conv-9', turnOrdinal: 2, align: 3, declaration: 0 }
  const okv = validateIngest(al)
  assert.equal(okv.ok, true)
  assert.equal(okv.record.clarity, null, '新形 clarity 必须 NULL')
  assert.equal(okv.record.defense, null, '新形 defense 必须 NULL')
  assert.equal(okv.record.rubricVersion, 'al-v1')
  assert.equal(okv.record.boundary, 'none', 'boundary 缺省 none')
  assert.equal(validateIngest({ ...al, align: 0 }).error, 'invalid:align')
  assert.equal(validateIngest({ ...al, align: 6 }).error, 'invalid:align')
  assert.equal(validateIngest({ ...al, align: 3.5 }).error, 'invalid:align')
  assert.equal(validateIngest({ ...al, align: '4' }).error, 'invalid:align')
  assert.equal(validateIngest({ ...al, boundary: 'weird' }).error, 'invalid:boundary')
  assert.equal(validateIngest({ ...al, align: 4 }).error, 'align-quote-required')
  assert.equal(validateIngest({ ...al, align: 5 }).error, 'align-quote-required')
  assert.equal(validateIngest({ ...al, declaration: 1 }).error, 'quote-required')
  assert.equal(validateIngest({ ...al, align: 4, quote: '引文' }).ok, true)
  assert.equal(validateIngest({ ...al, align: 4, quote: 'x'.repeat(QUOTE_MAX + 1) }).error, 'quote-too-long')
  assert.equal(validateIngest({ ...al, evidence: 'e'.repeat(501) }).error, 'evidence-too-long')
  // 两代不混：带 align 的 payload 即使塞了 clarity/defense 也一律 NULL（代际分层，决策 §9.3）
  const mixed = validateIngest({ ...al, clarity: 0.9, defense: 'heavy' })
  assert.equal(mixed.record.clarity, null)
  assert.equal(mixed.record.defense, null)
})

test('ingestSelfCheck + store: 同键重投 = 修正覆盖（duplicate 标），行数不双增', () => {
  const store = openStore(':memory:')
  try {
    const inp = { sourceKind: 'http', agent: 'h', extRef: 'c1', turnOrdinal: 1, clarity: 0.3, defense: 'none', declaration: 0 }
    const first = ingestSelfCheck(store, inp)
    assert.deepEqual(first, { ok: true, result: 'inserted' })
    const second = ingestSelfCheck(store, { ...inp, clarity: 0.6 })
    assert.deepEqual(second, { ok: true, result: 'duplicate' })
    assert.equal(store.countSelfCheckRecords(), 1, '修正覆盖不得双写')
    assert.equal(store.countSelfCheckRecords('http'), 1)
    assert.equal(store.countSelfCheckRecords('dsh_tool'), 0)
    // 唯一键含 source_kind：不同源同 (ext_ref, turn) 各存一行
    assert.equal(ingestSelfCheck(store, { ...inp, sourceKind: 'dsh_tool' }).result, 'inserted')
    assert.equal(store.countSelfCheckRecords(), 2)
    // AL.3：同一唯一键由新形（align）覆盖旧形 = 整行换维度——仍判 duplicate、行数不增
    const alNew = { sourceKind: 'http', agent: 'h', extRef: 'c1', turnOrdinal: 1, align: 3, declaration: 0 }
    assert.deepEqual(ingestSelfCheck(store, alNew), { ok: true, result: 'duplicate' })
    assert.equal(store.countSelfCheckRecords(), 2, '换维度覆盖也不得双写')
  } finally { store.close() }
})

test('migrateV5: v4 存库升级幂等、turn_read 数字不变、新库直达 v5（pulse 不冲突）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-v5-'))
  try {
    const file = join(tmp, 'n.db')
    // 伪造「升级前」状态：turn_read 有数据、user_version=4（pulse 已推进的存库形态）
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
        CREATE TABLE metric_sample (ts INTEGER NOT NULL, layer TEXT NOT NULL, metric TEXT NOT NULL, value REAL, tags TEXT, era TEXT NOT NULL DEFAULT 'api');
        PRAGMA user_version = 4;
      `)
      raw.close()
    }
    const s1 = openStore(file)
    assert.equal(s1.schemaVersion(), 9, 'v4 存库经 S1.1(v5)+T(v6)+A(v7)+AL(v8) 后到 v8')
    assert.deepEqual(s1.turnTotals(), { turns: 3, tokenIn: 0, tokenOut: 0, cacheRead: 0 }, 'turn_read 数字不变')
    assert.equal(s1.countSelfCheckRecords(), 0)
    s1.close()
    const s2 = openStore(file)
    assert.equal(s2.schemaVersion(), 9, '重开幂等：不重复迁移、不回退')
    assert.deepEqual(s2.turnTotals(), { turns: 3, tokenIn: 0, tokenOut: 0, cacheRead: 0 })
    s2.close()
    // 新库直达 v5；pulse 侧 v>4 直接返回（其表由自身构造 exec 幂等创建，不抢版本）
    const fresh = openStore(join(tmp, 'fresh.db'))
    assert.equal(fresh.schemaVersion(), 9, '新库直达当前最新（v8）')
    fresh.close()
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Windows 句柄 GC 滞后：容忍 %TEMP% 残留 */ }
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

// ── client half（lib/client.js：loader 形态 + 注册路径）────────────────────────

test('client bundle：ModuleLoader 往返 + 命名导出面 + 面板注册契约', () => {
  // 在 loader 形态下物化产物：断言「加载器收到了什么」，而不是模块的自我报告
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration = null
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load(r) { registration = r } } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, URL, Blob: class {}, fetch: () => Promise.reject(new Error('no-network')),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'lib/client.js' })
  assert.ok(registration !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, '@dsh-external/dsh-nautilus')

  const react = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    // 错误隔离用的是类组件：材料化时就会 extends Component，shim 必须给到
    Component: class { constructor(props) { this.props = props; this.state = {} } setState() {} },
    useEffect: () => {},
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    Fragment: 'Fragment',
  }
  const exportsObj = registration.factory((spec) => {
    if (spec === 'react' || spec === 'react/jsx-runtime') return react
    throw new Error('非基线模块请求：' + spec)
  })
  // postmortem 0001：命名空间插件绝不能有 default 导出（unwrapExports 会丢掉 inject/name/Config）
  assert.deepEqual(Object.keys(exportsObj).sort(), ['apply', 'inject'])
  assert.equal(Object.prototype.hasOwnProperty.call(exportsObj, 'default'), false)
  // 跨 realm：vm 里造出来的数组原型不同，deepStrictEqual 会因此报错——先摊平成宿主数组
  assert.deepEqual([...exportsObj.inject], ['slots', 'layout'])

  const calls = []
  const ctx = {
    layout: { selectPanel: (id) => { calls.push('selectPanel:' + String(id)) } },
    effect: (cb, name) => { calls.push('effect:' + name); cb() },
    slots: {
      inject: (key, cb) => { calls.push('inject:' + key); cb(); return () => {} },
      register: (def, comp) => {
        // 槽位标识字段随 kind 不同：list 槽用 id，keyed 槽（main）用 key——
        // 给错字段会抛 "keyed slot main requires options.key"，并拖垮整个浏览器半区插件集
        const identity = def.name === 'main' ? def.key : def.id
        assert.ok(identity !== undefined, 'register 必须带槽位标识（list→id / keyed→key）')
        calls.push('register:' + def.name + '|' + String(identity))
        assert.equal(typeof comp, 'function')
        if (def.name === 'main') {
          // main 的组件是注册闭包包出来的宿主组件：渲染它不应触发导航（只有点了「返回会话」才调 selectPanel(null)）
          const el = comp({})
          assert.ok(el !== null && el !== undefined, 'main 组件必须能产出元素')
          assert.equal(calls.some((c) => c.startsWith('selectPanel:')), false, '渲染不应触发导航')
        }
        return () => {}
      },
    },
  }
  exportsObj.apply(ctx)
  // 2026-09-27：vault 观测 tab 与逐会话读数 tab 均已下线（能力已搬进工作台）——客户端 = 工作台双注册
  // + T 系列契合按钮（守谷人改口：assistant-actions 列表槽 IconActions 行内，见 dev-05 §3 / D-T5b）
  assert.deepEqual(calls, [
    'effect:@dsh-external/dsh-nautilus: workbench icon',
    'inject:sidebar.panellist',
    'register:sidebar.panellist|nautilus-workbench',
    'effect:@dsh-external/dsh-nautilus: workbench panel',
    'inject:main',
    'register:main|nautilus-workbench',
    'effect:@dsh-external/dsh-nautilus: turn fit action',
    'inject:conversation.chat.assistant-actions',
    'register:conversation.chat.assistant-actions|nautilus-fit',
  ])
  // 工作台契约（§3.0 实测）：panellist 的 list id 与 main 的 key 必须同值——否则图标行点不到主区
  const panelIds = calls.filter((c) => c.startsWith('register:sidebar.panellist|') || c.startsWith('register:main|')).map((c) => c.split('|')[1])
  assert.deepEqual(panelIds, ['nautilus-workbench', 'nautilus-workbench'])
})

// ── 工作台渲染冒烟（真实 react SSR；删旧读数 tab 的前置证据）────────────────────

test('workbench 渲染冒烟：真实 react SSR 渲染四视图并断言内容', async () => {
  const esbuild = await import('esbuild')
  const rds = await import('react-dom/server')
  const react = await import('react')
  const renderToStaticMarkup = rds.renderToStaticMarkup ?? rds.default?.renderToStaticMarkup
  assert.equal(typeof renderToStaticMarkup, 'function', 'react-dom/server 必须可用（devDep）')
  // 临时产物放仓库内（便于 Node 解析 node_modules/react），且 react 必须 external：
  // 若把 react 打进 bundle 就出现**两份 react 实例** → 渲染时报 `Cannot read properties of null (reading 'useState')`
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(repo, '.render-smoke-'))
  const out = join(dir, 'wb.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL('../src/client/workbench.ts', import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    })
    const wb = await import(pathToFileURL(out).href)
    const el = (Type, props, ...kids) => react.createElement(Type, props, ...kids)
    const h = (node) => renderToStaticMarkup(node)
    const noop = () => {}

    const now = Date.now()
    const pt = (turn, session, miss, cache) => ({ session, turn, ts: now - (40 - turn) * 60000, tokenIn: miss, tokenOut: 100, cacheRead: cache, durationMs: 1200, tps: 42.5, clarity: 0.7, defense: 'none', declaration: 0 })
    const curve = [pt(1, 'session-aaaa1111', 500, 100), pt(2, 'session-aaaa1111', 400, 300), pt(3, 'session-bbbb2222', 100, 900), pt(4, 'session-bbbb2222', 50, 950)]
    const m2 = {
      totals: { turns: 4, tokenIn: 1050, tokenOut: 400, cacheRead: 2250, missToken: 1050, hitRate: 0.68 },
      curve, recent: curve.slice().reverse(),
      selfcheck: { checked: 3, total: 4, bySession: { 'session-aaaa1111': { checked: 2, total: 2, missing: [] }, 'session-bbbb2222': { checked: 1, total: 2, missing: [9] } } },
      sessionMeta: { 'session-aaaa1111': { startTs: now - 3600000, turns: 2 }, 'session-bbbb2222': { startTs: now - 1800000, turns: 2 } },
    }
    const pulse = {
      collector: { ticks: 120, lastTickTs: now - 2000, countersOk: true, gpuOk: true, shellPath: 'powershell', execAvailable: true, lastError: null, mode: 'auto', intervalMs: 5000 },
      db: { rows: 12345, oldestTs: now - 86400000, newestTs: now, schemaVersion: 4 },
      latest: [
        { metric: 'pulse.cpu.utilization', value: 0.18, ts: now, tags: {} },
        { metric: 'pulse.mem.used', value: 1.2e10, ts: now, tags: {} },
        { metric: 'pulse.gpu.util', value: 8, ts: now, tags: {} },
        { metric: 'pulse.proc.dsh.rss', value: 5.5e8, ts: now, tags: {} },
      ],
    }
    const analysis = [{ session: 'session-aaaa1111', shape: 'sigmoid', tauE: 2, burst: { fromTurn: 2, toTurn: 3, direction: 'up' } }]

    // ① 总览：OS 读数（AL.4a：工作区指向面板与其控件已撤除）
    const ov = h(el(wb.OverviewView, { m2, pulse, onOpenTurn: noop }))
    for (const s of ['系统层读数', 'CPU 利用率', '读数规模']) {
      assert.ok(ov.includes(s), '总览缺内容: ' + s)
    }
    for (const s of ['L 场', '切换指向', '确认切换', '归属根']) {
      assert.ok(!ov.includes(s), '总览仍有已撤除的工作区指向残留: ' + s)
    }
    // ② 曲线：逐会话读数三件套（累计输入 / 轮次轴 / 自评覆盖）
    const cv = h(el(wb.CurveView, { m2, era: 'api', pulse, analysis, sessionNameOf: () => ({ name: 'ws', title: 'demo' }) }))
    for (const s of ['未命中率', '累计输入', '轮次轴', '日期轴', '自评覆盖', 'NEXUS 轮次', 'PULSE 采样']) {
      assert.ok(cv.includes(s), '曲线缺内容: ' + s)
    }
    // ③ 报告（AL.4a：假设 / 预言两视图与标注层已撤除；白盒分析保留）
    const rp = h(el(wb.ReportView, { m2, pulse, era: 'api', analysis }))
    for (const s of ['导出 JSON 快照', '四、白盒分析']) assert.ok(rp.includes(s), '报告缺内容: ' + s)
    for (const s of ['人工标注', '预言']) assert.ok(!rp.includes(s), '报告仍有已撤除的标注层残留: ' + s)
    // ④ 根组件：数据全缺席也不得抛错（首帧渲染路径）
    const root = h(el(wb.Workbench, { onExitToConversation: noop }))
    for (const s of ['NAUTILUS', '总览', '曲线', '报告', '心跳', '返回会话', '主题', '跟随', '浅色', '深色']) {
      assert.ok(root.includes(s), '根组件缺内容: ' + s)
    }
    // U2 主题档位：根属性是覆盖把手（host 档不落覆盖块 → 走 body 级跟随块）
    assert.ok(root.includes('data-nt-theme="host"'), '工作台根必须带 data-nt-theme（手动档覆盖把手）')
    assert.ok(root.includes('nt-sch-l') && root.includes('nt-sch-d'), '跟随档必须同时给出浅/暗两版标签（纯 CSS 切换）')
    // ⑤ 错误隔离：SSR 不执行错误边界（React 限制），故按「静态派生 + 状态级」校验回退 UI
    const boundary = new wb.ViewBoundary({ label: 'X' })
    assert.deepEqual(wb.ViewBoundary.getDerivedStateFromError(new Error('boom')), { error: 'Error: boom' })
    boundary.state = { error: 'Error: boom' }
    const fallback = h(boundary.render())
    assert.ok(fallback.includes('视图渲染失败') && fallback.includes('重试渲染'), '错误隔离回退 UI 未生效')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// ── 客户端半区：视图组件禁止直调（源码级守卫）──────────────────────────────────

test('workbench 视图必须渲染为元素：禁止 View({...}) 直调（hooks 会算进父组件，切视图即崩）', () => {
  // 教训（§E13）：把带 hooks 的视图当普通函数调用，切视图时 hooks 数量变化 → React 整页渲染失败。
  // 只查「带 hooks 的组件」：Stat / Panel / Empty / Spark 是无 hooks 的纯呈现助手，按契约允许直调。
  const src = readFileSync(new URL('../src/client/workbench.ts', import.meta.url), 'utf8')
  const components = ['Workbench', 'OverviewView', 'CurveView', 'ReportView', 'Drawer']
  const offenders = []
  for (const [i, line] of src.split(/\r?\n/).entries()) {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    for (const name of components) {
      if (new RegExp('(^|[^\\w.$])' + name + '\\s*\\(').test(line) && !new RegExp('function\\s+' + name + '\\b').test(line)) {
        offenders.push(name + ' @' + String(i + 1) + ': ' + t.slice(0, 70))
      }
    }
  }
  assert.deepEqual(offenders, [])
})
// ── 宿主半区单入口装配（pulse 子插件）────────────────────────────────────────────

test('host bundle 单入口：pulse 作为子插件挂载并注册自身路由', async () => {
  // 本包带客户端半区 → 只允许一个 Loader 条目，pulse 必须由父插件 ctx.plugin 挂载。
  // 双条目会让 client-modules 抛 "resolves from multiple active Loader sources"（dsh web 起不来）。
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-mount-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const routes = []
    const tools = []
    const ctx = new Context()
    const handlers = new Map()
    // 造册键 = kind + path：AL.5s 起 `/m2/sessions` 有**两条**（exact 列表 + prefix 详情）——
    // 宿主 webserver 里本就是两张表（exact 表优先、其后最长前缀），只记 path 会看不出这件事。
    ctx.provide('webServer', { register(route) { routes.push(route.kind + ' ' + route.path); handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register(def) { tools.push(def.name) } })
    const fiber = ctx.plugin(mod, {
      pulse: { enabled: true, enableCounters: false, enableGpu: false, intervalMs: 60000, dbFile: ':memory:' },
    })
    // 断言一律包在 try 里：断言失败也必须拆 fiber——pulse 采集定时器不会自己停，fiber 漏拆 =
    // 子进程不退出、npm test 整体挂死且**没有任何报错输出**（2026-09-28 实测：路由清单漏一项即复现）。
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !routes.includes('exact /api/nautilus/pulse/state')) await new Promise((r) => setTimeout(r, 25))
      // vault 观测腿下线（2026-09-27）后：无 /state · /vault · /action 三条；S1.1 新增 /selfcheck；
      // AL.4b 新增 /m2/alignments；AL.5s 新增 /m2/sessions（exact 列表 + prefix 详情，同路径两种 kind）
      assert.deepEqual([...routes].sort(), [
        'exact /api/nautilus/m2/alignments',
        'exact /api/nautilus/m2/analysis',
        'exact /api/nautilus/m2/sessions',
        'exact /api/nautilus/m2/state',
        'exact /api/nautilus/m2/turn-annotations',
        'exact /api/nautilus/m2/turn-text',
        'exact /api/nautilus/pulse/alerts',
        'exact /api/nautilus/pulse/alerts/report',
        'exact /api/nautilus/pulse/alerts/verdict',
        'exact /api/nautilus/pulse/control',
        'exact /api/nautilus/pulse/series',
        'exact /api/nautilus/pulse/state',
        'exact /api/nautilus/selfcheck',
        'prefix /api/nautilus/m2/sessions',
      ])
      assert.deepEqual([...tools], ['record_turn_selfcheck'])
    } finally { await fiber.dispose() }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ── OS 层心跳档位控制（/api/nautilus/pulse/control）──────────────────────────────

test('pulse 心跳控制：档位切换 / 立即采样 / 非法入参 400', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-hb-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    const fiber = ctx.plugin(mod, {
      pulse: { enabled: true, enableCounters: false, enableGpu: false, intervalMs: 60000, dbFile: ':memory:' },
    })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !handlers.has('/api/nautilus/pulse/control')) await new Promise((r) => setTimeout(r, 25))
    const control = handlers.get('/api/nautilus/pulse/control')
    const state = handlers.get('/api/nautilus/pulse/state')
    assert.equal(typeof control, 'function', 'control 路由必须注册')
    assert.equal(typeof state, 'function', 'state 路由必须注册')

    const req = (method, body) => ({
      method,
      headers: { 'sec-fetch-site': 'same-origin' },
      on(ev, cb) { if (ev === 'data' && body !== undefined) cb(JSON.stringify(body)); if (ev === 'end') cb(); return this },
    })
    const res = () => ({ statusCode: 0, payload: null, writeHead(s) { this.statusCode = s }, end(text) { this.payload = JSON.parse(String(text ?? '{}')) } })
    // handler 内部是异步 IIFE：等 response 落地
    const call = async (method, body) => { const r = res(); control(req(method, body), r); const dl = Date.now() + 3000; while (Date.now() < dl && r.statusCode === 0) await new Promise((x) => setTimeout(x, 10)); return r }

    assert.equal((await call('GET')).statusCode, 405, '非 POST 必须 405')
    const manual = await call('POST', { mode: 'manual' })
    assert.equal(manual.statusCode, 200)
    assert.equal(manual.payload.collector.mode, 'manual')
    const back5 = await call('POST', { intervalMs: 5000 })
    assert.equal(back5.statusCode, 200)
    assert.equal(back5.payload.collector.mode, 'auto')
    assert.equal(back5.payload.collector.intervalMs, 5000)
    const fast = await call('POST', { intervalMs: 1000 })
    assert.equal(fast.payload.collector.intervalMs, 1000)
    assert.equal((await call('POST', { intervalMs: 500 })).statusCode, 400, '低于下限必须 400')
    assert.equal((await call('POST', { mode: 'bogus' })).statusCode, 400, '非法 mode 必须 400')
    assert.equal((await call('POST', { intervalMs: 999999999 })).statusCode, 400, '超上限必须 400')

    const ticksBefore = fast.payload.collector.ticks
    const sampled = await call('POST', { mode: 'manual', sample: true })
    assert.equal(sampled.statusCode, 200)
    assert.ok(sampled.payload.collector.ticks > ticksBefore, '手动采样必须真的跑了一次 tick')
    assert.equal(sampled.payload.collector.mode, 'manual')

    // state 必须暴露档位（UI 靠它渲染当前档）
    const sr = res()
    state(req('GET'), sr)
    assert.equal(sr.statusCode, 200)
    assert.equal(sr.payload.collector.mode, 'manual')
    assert.equal(sr.payload.collector.intervalMs, 1000)
    await fiber.dispose()
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ── S1.1 自评 HTTP ingest（POST /api/nautilus/selfcheck：门序四分支 + 修正覆盖；真实装配路径）──

test('selfcheck ingest 通道：默认关 403 → token 门 401 → 非法 400 → 合法 200/duplicate；空 token 启用即加载失败', async () => {
  const { Readable } = await import('node:stream')
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-sc-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const { SELFCHECK_TOKEN_HEADER } = await import(new URL('../lib/routes.js', import.meta.url).href)

    const waitRoute = async (handlers) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !handlers.has('/api/nautilus/selfcheck')) await new Promise((r) => setTimeout(r, 25))
      const handler = handlers.get('/api/nautilus/selfcheck')
      assert.equal(typeof handler, 'function', 'selfcheck 路由必须注册（禁用态也在场——403 可判别，不是 404）')
      return handler
    }
    // 真 Readable：handler 走 for-await（异步迭代），伪造 on() 的假流不可靠
    const req = (method, body, token) => {
      const r = new Readable({ read() {} })
      r.method = method
      r.headers = token === undefined ? {} : { [SELFCHECK_TOKEN_HEADER]: token }
      if (body !== undefined) r.push(Buffer.from(JSON.stringify(body), 'utf8'))
      r.push(null)
      return r
    }
    const res = () => ({ statusCode: 0, payload: null, writeHead(s) { this.statusCode = s }, end(t) { this.payload = JSON.parse(String(t ?? '{}')) } })
    const call = async (handler, method, body, token) => {
      const r = res()
      handler(req(method, body, token), r)
      const dl = Date.now() + 3000
      while (Date.now() < dl && r.statusCode === 0) await new Promise((x) => setTimeout(x, 10))
      return r
    }
    const goodBody = { agent: 'harness-x', ext_ref: 'conv-1', turn_ordinal: 1, clarity: 0.3, defense: 'none', declaration: 0 }

    // ① 默认关：恒 403
    {
      const handlers = new Map()
      const ctx = new Context()
      ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
      ctx.provide('tools', { register() {} })
      const fiber = ctx.plugin(mod, { pulse: { enabled: false } })
      const captured = await waitRoute(handlers)
      const off = await call(captured, 'POST', goodBody, 'anything')
      assert.equal(off.statusCode, 403, '未启用必须 403')
      assert.equal(off.payload.error, 'ingest-disabled')
      assert.equal((await call(captured, 'GET', undefined, 'anything')).statusCode, 405, '非 POST 必须 405')
      await fiber.dispose()
    }

    // ② 配置响亮失败：enabled=true 且 token 空 → apply 直接抛（不留运行时静默 401）
    assert.throws(
      () => mod.apply({ effect: () => () => undefined }, { selfcheck: { ingest: { enabled: true, token: '   ', maxBodyBytes: 8192 } } }),
      /token/,
    )

    // ③ 启用后全分支：401 → 400 → 200 inserted → 200 duplicate（修正覆盖，落库可验）
    {
      const handlers = new Map()
      const ctx = new Context()
      ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
      ctx.provide('tools', { register() {} })
      const fiber = ctx.plugin(mod, {
        pulse: { enabled: false },
        selfcheck: { ingest: { enabled: true, token: 't-123', maxBodyBytes: 8192 } },
      })
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !handlers.has('/api/nautilus/selfcheck')) await new Promise((r) => setTimeout(r, 25))
      const h = handlers.get('/api/nautilus/selfcheck')

      assert.equal((await call(h, 'POST', goodBody)).statusCode, 401, '缺 token 必须 401')
      assert.equal((await call(h, 'POST', goodBody, 'wrong')).statusCode, 401, '错 token 必须 401')
      assert.equal((await call(h, 'POST', { ...goodBody, clarity: 1.4 }, 't-123')).payload.error, 'invalid:clarity', '非法 clarity 必须 400+字段名')
      const noQuote = await call(h, 'POST', { ...goodBody, declaration: 1 }, 't-123')
      assert.equal(noQuote.statusCode, 400)
      assert.equal(noQuote.payload.error, 'quote-required', 'D-SC2：declaration=1 无引文必须拒')
      // JSON 合法但非对象体（字符串）→ bad-json 拒
      const notObj = await call(h, 'POST', 'bare-string', 't-123')
      assert.equal(notObj.statusCode, 400)
      assert.equal(notObj.payload.error, 'bad-json')
      const ins = await call(h, 'POST', { ...goodBody }, 't-123')
      assert.equal(ins.statusCode, 200)
      assert.equal(ins.payload.result, 'inserted')
      const dup = await call(h, 'POST', { ...goodBody, clarity: 0.9 }, 't-123')
      assert.equal(dup.payload.result, 'duplicate')
      assert.equal(dup.payload.duplicate, true)
      // AL.3：同通道收新形（align）——门序不变（405→403→401→400→200），硬门也在 400 这一档
      // declaration 是新形的**必填**判断（与旧形同口径：不替调用方猜「有没有宣告」）
      const alNoDecl = await call(h, 'POST', { agent: 'harness-y', ext_ref: 'conv-2', turn_ordinal: 1, align: 4 }, 't-123')
      assert.equal(alNoDecl.statusCode, 400)
      assert.equal(alNoDecl.payload.error, 'invalid:declaration', 'declaration 缺省不得由服务端代填')
      const alNoQuote = await call(h, 'POST', { agent: 'harness-y', ext_ref: 'conv-2', turn_ordinal: 1, align: 4, declaration: 0 }, 't-123')
      assert.equal(alNoQuote.statusCode, 400)
      assert.equal(alNoQuote.payload.error, 'align-quote-required', 'align=4 无引文必须 400')
      const al = await call(h, 'POST', { agent: 'harness-y', ext_ref: 'conv-2', turn_ordinal: 1, align: 4, declaration: 0, quote: '你还没命名的那处结构' }, 't-123')
      assert.equal(al.statusCode, 200)
      assert.equal(al.payload.result, 'inserted')
      await fiber.dispose()

      // 外部世界断言：旧形 1 行（覆盖后 clarity=0.9）+ 新形 1 行（clarity/defense NULL、rubric=al-v1）
      const raw = new DatabaseSync(join(tmp, 'nautilus', 'nautilus.db'))
      const rows = raw.prepare(`
        SELECT source_kind, agent, clarity, defense, declaration, quote, align, boundary, rubric_version
        FROM selfcheck_record ORDER BY id
      `).all()
      assert.equal(rows.length, 2, '修正覆盖不得双写；新形另起一行（不同 ext_ref）')
      assert.deepEqual({ ...rows[0] }, {
        source_kind: 'http', agent: 'harness-x', clarity: 0.9, defense: 'none',
        declaration: 0, quote: null, align: null, boundary: null, rubric_version: null,
      }, '旧形行不得带任何 al-v1 字段（代际不混算）')
      assert.deepEqual({ ...rows[1] }, {
        source_kind: 'http', agent: 'harness-y', clarity: null, defense: null,
        declaration: 0, quote: '你还没命名的那处结构', align: 4, boundary: 'none', rubric_version: 'al-v1',
      }, '新形行：clarity/defense NULL + align/boundary/rubric_version 齐全')
      raw.close()
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    // Windows：node:sqlite 的文件句柄要等 GC 才释放，重试也可能吃 EPERM——%TEMP% 由系统回收，不因清理竞态误报测试失败
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 容忍残留 */ }
  }
})

// ── 工作台图表语法升级（2026-09-20 方案 A）：SSR 冒烟 + charts 原语纪律 ──────────

test('workbench 图表升级 SSR：总览 PULSE 网格/gauge/排行/健康带 + 曲线构成柱入口', async () => {
  const esbuild = await import('esbuild')
  const rds = await import('react-dom/server')
  const react = await import('react')
  const renderToStaticMarkup = rds.renderToStaticMarkup ?? rds.default?.renderToStaticMarkup
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(repo, '.charts-smoke-'))
  const out = join(dir, 'wb.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL('../src/client/workbench.ts', import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    })
    const wb = await import(pathToFileURL(out).href)
    const el = (Type, props, ...kids) => react.createElement(Type, props, ...kids)
    const h = (node) => renderToStaticMarkup(node)
    const noop = () => {}
    const now = Date.now()
    const pt = (turn, session, miss, cache) => ({ session, turn, ts: now - (40 - turn) * 60000, tokenIn: miss, tokenOut: 100, cacheRead: cache, durationMs: 1200, tps: 42.5 })
    const curve = [pt(1, 'session-aaaa1111', 500, 100), pt(2, 'session-aaaa1111', 400, 300), pt(3, 'session-bbbb2222', 100, 900), pt(4, 'session-bbbb2222', 50, 950)]
    const m2 = {
      totals: { turns: 4, tokenIn: 1050, tokenOut: 400, cacheRead: 2250, missToken: 1050, hitRate: 0.68 },
      curve, recent: curve.slice().reverse(),
      selfcheck: { checked: 3, total: 4, bySession: {} },
      sessionMeta: { 'session-aaaa1111': { startTs: now - 3600000, turns: 2 }, 'session-bbbb2222': { startTs: now - 1800000, turns: 2 } },
    }
    const pulse = {
      collector: { ticks: 120, lastTickTs: now - 2000, countersOk: true, gpuOk: true, shellPath: 'powershell', execAvailable: true, lastError: null, mode: 'auto', intervalMs: 5000 },
      db: { rows: 12345, oldestTs: now - 86400000, newestTs: now, schemaVersion: 4 },
      latest: [
        { metric: 'pulse.cpu.utilization', value: 0.92, ts: now, tags: {} },
        { metric: 'pulse.cpu.ctx_switches', value: 1200, ts: now, tags: {} },
        { metric: 'pulse.mem.used', value: 1.2e10, ts: now, tags: {} },
        { metric: 'pulse.mem.total', value: 3.4e10, ts: now, tags: {} },
        { metric: 'pulse.gpu.util', value: 95, ts: now, tags: {} },
        { metric: 'pulse.proc.dsh.rss', value: 5.5e8, ts: now, tags: {} },
      ],
    }
    // ① 总览：主图 2×2 + USE 资源族分区（仅次要指标）+ 占比 gauge + 健康带占位 + 会话排行/活跃带 + 折叠面板
    const ov = h(el(wb.OverviewView, { m2, pulse, onOpenTurn: noop }))
    for (const s of ['采集健康带', '输入令牌排行', '会话活跃带', '悬停任一小图', 'nt-gauges', 'CPU 利用率', '内存占比', '2.0k · 2 轮', 'aaaa1111']) {
      assert.ok(ov.includes(s), '总览图表升级缺内容: ' + s)
    }
    // 布局二次修订：主图 2×2 在场（图头含最新值与交互提示）；次要看板为可折叠 details/summary
    for (const s of ['nt-maingrid', 'nt-maincell', '滚轮放缩 · 左键按住拖动 · 双击复位', '92.0%', '<details', '<summary']) {
      assert.ok(ov.includes(s), '总览主图/折叠缺内容: ' + s)
    }
    // 曲线刷新与心跳对齐：auto 档（fixture intervalMs=5000）→ 图注应写明 5 s/次
    for (const s of ['曲线刷新与心跳对齐', '5 s/次']) {
      assert.ok(ov.includes(s), '总览心跳对齐缺内容: ' + s)
    }
    assert.ok(ov.split('nt-maincell').length - 1 === 4, '主图应为 4 格（每格容器类名恰好一次）')
    // 缺席诚实态：无 gpu.mem 指标 → 显存占比 gauge 不得出现；SSR 无取数 → 小图空态而非编造曲线
    assert.ok(!ov.includes('显存占比'), '总览渲染了缺席指标的 gauge（显存占比）')
    assert.ok(ov.includes('暂无数据'), '总览小图缺空态（序列未取数时应显式缺席）')
    // ② 曲线：构成柱入口（按钮）在场；默认仍为未命中率曲线
    const cv = h(el(wb.CurveView, { m2, era: 'api', pulse, analysis: [], sessionNameOf: () => ({ name: 'ws', title: 'demo' }) }))
    assert.ok(cv.includes('输入构成'), '曲线视图缺「输入构成」档位')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('charts 原语 SSR：StackedBars/StateBand/TopList/BarGauge/Sparkline 形状与空态', async () => {
  const esbuild = await import('esbuild')
  const rds = await import('react-dom/server')
  const react = await import('react')
  const renderToStaticMarkup = rds.renderToStaticMarkup ?? rds.default?.renderToStaticMarkup
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(repo, '.charts-unit-'))
  const out = join(dir, 'charts.mjs')
  try {
    esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL('../src/client/charts.ts', import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime'],
    })
    const ch = await import(pathToFileURL(out).href)
    const h = (node) => renderToStaticMarkup(node)
    const rows = [
      { x: 1, segs: [{ key: 'read', v: 100, fill: 'black', name: '缓存读' }, { key: 'miss', v: 50, fill: 'red', name: '未命中' }] },
      { x: 2, segs: [{ key: 'read', v: 0, fill: 'black', name: '缓存读' }, { key: 'miss', v: 80, fill: 'red', name: '未命中' }] },
    ]
    const sb = h(react.createElement(ch.StackedBars, { rows, hoverIndex: 1, xTick: (v) => 't' + v }))
    assert.ok(sb.includes('<rect') && sb.includes('t1') && sb.includes('t2'), 'StackedBars 缺柱或刻度')
    assert.ok(h(react.createElement(ch.StackedBars, { rows: [] })).includes('暂无数据'), 'StackedBars 空态缺失')
    const band = h(react.createElement(ch.StateBand, { domain: [0, 100], lanes: [{ label: 'CPU 采样', spans: [{ from: 10, to: 60 }] }], xTick: (t) => String(t) }))
    assert.ok(band.includes('CPU 采样') && band.includes('left:10.00%') && band.includes('width:50.00%'), 'StateBand 泳道/片段几何缺失')
    const tl = h(react.createElement(ch.TopList, { rows: [{ label: 'a', value: 300, display: '300' }, { label: 'b', value: 100, display: '100' }, { label: 'z', value: 0, display: '0' }] }))
    assert.ok(tl.includes('>a<') && tl.includes('width:100.0%') && !tl.includes('>z<'), 'TopList 排行条/零值剔除缺失')
    const g = h(react.createElement(ch.BarGauge, { label: 'GPU', display: '95%', ratio: 0.95, threshold: 0.9, warn: true }))
    assert.ok(g.includes('warn') && g.includes('width:95.0%') && g.includes('left:90.0%'), 'BarGauge 警示/阈值刻度缺失')
    assert.equal(h(react.createElement(ch.Sparkline, { values: [1] })), '', 'Sparkline 点不足应渲染 null（不占位）')
    assert.ok(h(react.createElement(ch.Sparkline, { values: [1, 2, 3] })).includes('<path'), 'Sparkline 缺折线')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('charts 原语纪律：无 hooks（可像 Stat/Spark 一样直调）+ --nt-* 令牌外零硬编码色', () => {
  const src = readFileSync(new URL('../src/client/charts.ts', import.meta.url), 'utf8')
  for (const bad of ['useState(', 'useEffect(', 'useRef(', 'useLayoutEffect(']) {
    assert.ok(!src.includes(bad), 'charts.ts 出现 hooks（破坏「无 hooks 可直调」纪律）: ' + bad)
  }
  const stripped = src.replace(/var\(--nt-[a-z0-9-]+\s*,[^)]*\)/gi, '')
  const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g)
  assert.deepEqual(hex, null, 'charts.ts 在 --nt-* 令牌 fallback 之外出现硬编码色: ' + JSON.stringify(hex))
})

// ── U2 令牌层：--nt-* 亮暗双主题跟随 DSH（2026-10-02 落地）──────────────────────
// 背景：令牌层此前**只有引用没有定义**（153 处 var(--nt-*, 浅色兜底) 全部吃兜底），插件恒为浅色。
// 这一组测试守的是「四态齐全 + 亮暗确实分叉 + 手动档不泄漏宿主别名 + 零硬编码色」。

test('主题令牌层：四块齐全 / 亮暗分叉 / 覆盖档不吃宿主别名 / 令牌表无死条目', async () => {
  const esbuild = await import('esbuild')
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(repo, '.theme-smoke-'))
  const out = join(dir, 'theme.mjs')
  let th
  try {
    // react 必须 external（两份实例会让 JSX/hooks 崩），platform=node 以便直接 import
    esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL('../src/client/theme.ts', import.meta.url))],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      external: ['react', 'react/jsx-runtime', 'react-dom'],
    })
    th = await import(pathToFileURL(out).href)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }

  const css = th.ntThemeCss()
  // 四块：①②跟随（亮/暗）由宿主 body 属性驱动，③④覆盖（浅/深）由工作台根属性驱动
  const blocks = new Map()
  for (const m of css.matchAll(/([^{}\n]+)\{([^{}]*)\}/g)) blocks.set(m[1].trim(), m[2])
  const light = blocks.get('body')
  const dark = blocks.get('body[data-ds-dark-theme]')
  const ovLight = blocks.get('.nt-wb[data-nt-theme="light"]')
  const ovDark = blocks.get('.nt-wb[data-nt-theme="dark"]')
  for (const [name, b] of [['body（跟随·浅）', light], ['body[data-ds-dark-theme]（跟随·暗）', dark], ['.nt-wb[data-nt-theme="light"]', ovLight], ['.nt-wb[data-nt-theme="dark"]', ovDark]]) {
    assert.ok(typeof b === 'string' && b.length > 0, '令牌层缺块: ' + name)
  }
  const namesOf = (b) => [...b.matchAll(/(--nt-[a-z0-9-]+)\s*:/g)].map((m) => m[1])
  const names = namesOf(light)
  assert.ok(names.length >= 14, '令牌数异常（表被删空？）: ' + names.length)
  for (const [label, b] of [['跟随·暗', dark], ['覆盖·浅', ovLight], ['覆盖·暗', ovDark]]) {
    assert.deepEqual(namesOf(b), names, label + ' 块令牌集合与跟随·浅不一致（漏一个 = 该态下组件吃硬编码兜底）')
  }

  const val = (b, n) => (b.match(new RegExp(n + ':([^;]+)')) || [])[1]
  // 暗色必须真的分叉：只允许静态朱红与字体栈同值（否则「暗色主题」是假的）
  const same = names.filter((n) => val(light, n) === val(dark, n))
  assert.deepEqual(same.sort(), ['--nt-accent', '--nt-font'], '亮暗同值令牌只允许静态朱红与字体栈，实得: ' + same.join(','))

  // 跟随档：有宿主别名的必须走 var(--dsw-alias-*, S4 兜底)；自持令牌不得引用宿主别名
  for (const t of th.NT_TOKENS) {
    const d = val(light, t.name)
    assert.ok(typeof d === 'string' && d.length > 0, '令牌未声明: ' + t.name)
    if (t.dsh === undefined) assert.ok(!d.includes('--dsw-alias-'), t.name + ' 无宿主别名却引用了宿主令牌')
    else assert.ok(d.startsWith('var(' + t.dsh + ','), t.name + ' 未绑定宿主别名 ' + t.dsh + '，实得 ' + d)
  }
  // 覆盖档：一律字面值——手动档的语义就是「不听宿主的」（混入别名会被宿主值反压、手动档失效）
  for (const [label, b] of [['覆盖·浅', ovLight], ['覆盖·暗', ovDark]]) {
    assert.ok(!b.includes('--dsw-alias-'), label + ' 块混入宿主别名')
  }
  // 覆盖档值必须逐条等于令牌表的 S4 定版值（手动档 = 原型视觉，不受宿主 palette 漂移影响）
  for (const t of th.NT_TOKENS) {
    assert.equal(val(ovLight, t.name), t.light, '覆盖·浅与表值不符: ' + t.name)
    assert.equal(val(ovDark, t.name), t.dark, '覆盖·暗与表值不符: ' + t.name)
  }
  // 宿主暗色属性名是硬契约（@deepseek-ai/dsh-client-ui-layout theme-presenter: DARK_ATTRIBUTE）
  assert.ok(css.includes('body[data-ds-dark-theme]'), '跟随暗块必须以宿主投影的 body 属性为选择器')
  assert.ok(css.indexOf('body[data-ds-dark-theme]') > css.indexOf('body{'), '暗块必须在亮块之后（同选择器层序决定胜出）')
})

test('客户端取色纪律：theme.ts 是唯一硬编码色处 + 令牌表无死令牌 + 产物内含令牌层', () => {
  const dir = fileURLToPath(new URL('../src/client', import.meta.url))
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'theme.ts')
  assert.ok(files.length >= 4, '客户端半区文件清单异常: ' + files.join(','))
  const srcOf = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
  const strip = (s) => s.replace(/var\(--(?:nt|dsw-alias)-[a-z0-9-]+\s*,[^)]*\)/gi, '')
  for (const [f, src] of srcOf) {
    const bad = strip(src).match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)
    assert.deepEqual(bad, null, f + ' 在 --nt-* 令牌 fallback 之外出现硬编码色: ' + JSON.stringify(bad))
  }
  // 反向守卫：令牌表里声明了却无人消费的条目 = 死令牌（会漂移成假规格）
  const thSrc = readFileSync(join(dir, 'theme.ts'), 'utf8')
  const consumed = [...srcOf.values()].join('\n')
  const declared = [...thSrc.matchAll(/name: '(--nt-[a-z0-9-]+)'/g)].map((m) => m[1])
  assert.ok(declared.length >= 14, '令牌表解析异常: ' + declared.length)
  const dead = declared.filter((n) => !consumed.includes('var(' + n))
  assert.deepEqual(dead, [], '死令牌（声明了但客户端无人消费）: ' + dead.join(','))

  // 产物面：令牌层与主题档位真的进了 bundle（构建漏挂新模块时，本行是唯一哨兵）
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const s of ['body[data-ds-dark-theme]', '--dsw-alias-border-l2', 'data-nt-theme', 'nt-theme-style']) {
    assert.ok(bundle.includes(s), 'lib/client.js 缺令牌层标记: ' + s)
  }
})

// ── PS.0fix：多端共享数据目录的三项前置修复 ────────────────────────────────────
// 背景：同机的 dsh-web 与 desktop 各有各的 home（~/.dsh / ~/.dsh-desktop），面板「有面板没数据」
// = 数据没共享。方案：只共享**数据目录**（config.dataDir），home 隔离保留。
//   A) dataDir 显式数据目录（取代「文件系统联接」）· B) 多写者就绪（busy_timeout + WAL）
//   C) 丢写可见化（采集写失败计数 + 诊断面暴露）

/** 读一条 PRAGMA 的标量值（列名随语句而变——如 PRAGMA busy_timeout 的列叫 timeout——故按位置取）。 */
function pragmaScalar(db, name) {
  const row = db.prepare('PRAGMA ' + name).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

test('PS.0fix-A：resolveDataDir(override) 用显式目录、无回落、不跑历史改名迁移', () => {
  const home = mkdtempSync(join(tmpdir(), 'nautilus-datadir-'))
  try {
    // 旧世代痕迹：默认分支会把它们「改名迁移」走——显式分支必须一个都不碰（不探测、不 rename）
    mkdirSync(join(home, 'xuegulin'), { recursive: true })
    writeFileSync(join(home, 'xuegulin', 'xuegu.db'), 'legacy')
    mkdirSync(join(home, 'nexus'), { recursive: true })
    writeFileSync(join(home, 'nexus', 'nexus.db'), 'legacy2')

    const warns = []
    const custom = join(home, 'shared', 'nested', 'data') // 多级不存在 → 证明 recursive 建目录
    const r = resolveDataDir(home, (m) => warns.push(m), custom)
    assert.equal(r.dir, custom, 'dataDir 就是数据目录本身')
    assert.equal(r.dbFile, join(custom, 'nautilus.db'), '库文件名固定 nautilus.db')
    assert.equal(r.fellBack, false, '显式目录没有「回落」语义')
    assert.deepEqual(warns, [], '显式目录不该产生迁移告警')
    assert.ok(existsSync(custom), '显式目录必须被建出（含多级父目录）')
    assert.ok(existsSync(join(home, 'xuegulin', 'xuegu.db')), '旧世代 xuegulin 原样保留（显式分支不探测）')
    assert.ok(existsSync(join(home, 'nexus', 'nexus.db')), '旧世代 nexus 原样保留（显式分支不探测）')
    assert.ok(!existsSync(join(home, 'nautilus')), '不该顺手建出默认目录')

    // 默认路径行为未变：同一 home 不传 override → 仍执行 nexus → nautilus 改名迁移
    const d = resolveDataDir(home, (m) => warns.push(m))
    assert.equal(d.dir, join(home, 'nautilus'))
    assert.equal(d.dbFile, join(home, 'nautilus', 'nautilus.db'))
    assert.ok(existsSync(join(home, 'nautilus', 'nautilus.db')), '默认分支仍把 nexus.db 改名为 nautilus.db')
    assert.ok(!existsSync(join(home, 'nexus')), '默认分支仍执行目录改名')
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('PS.0fix-A：dataDir 指向自定义目录 → 库真的落在那（pulse 同库），home 下不产生数据文件', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-datadir-mount-'))
  const prevHome = process.env.DSH_HOME
  const home = join(tmp, 'home')
  const custom = join(tmp, 'shared-data') // 刻意不存在：连「自动建目录」一起验
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    // 真实装配路径：config 过 Config schema（dataDir 是新增字段，默认值与显式值都要走一遍）
    const fiber = ctx.plugin(mod, { dataDir: custom, pulse: { enabled: false } })
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !handlers.has('/api/nautilus/m2/state')) await new Promise((r) => setTimeout(r, 25))
      assert.ok(handlers.has('/api/nautilus/m2/state'), '插件必须挂载（读侧路由在场）')

      const dbFile = join(custom, 'nautilus.db')
      assert.ok(existsSync(dbFile), '主库必须落在 dataDir 指定目录：' + dbFile)
      const db = new DatabaseSync(dbFile, { readOnly: true })
      try {
        assert.equal(Number(pragmaScalar(db, 'user_version')), 9, '落在那的确实是本插件的库（schema 版本在场）')
        assert.ok(
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metric_sample'").get() !== undefined,
          'pulse 的表必须同库（子插件跟随同一数据目录，否则面板半空）',
        )
      } finally { db.close() }
      assert.ok(!existsSync(join(home, 'nautilus')), 'home 下不该再出现默认数据目录（否则就是数据分叉）')
    } finally { await fiber.dispose() }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PS.0fix-B：两个库的连接级 PRAGMA 生效（busy_timeout=5000 + journal_mode=wal）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-pragma-'))
  try {
    // 同库不同表：两个 store 打开**同一个文件**——正是「多宿主进程同写一个库」的最小复现
    const dbFile = join(tmp, 'nautilus.db')
    const store = openStore(dbFile)
    let pulseStore
    try {
      // nautilus store 那条连接：连接级 busy_timeout + 持久 WAL 都要在
      assert.equal(Number(pragmaScalar(store.db, 'busy_timeout')), SQLITE_BUSY_TIMEOUT_MS, 'nautilus: busy_timeout 必须等于集中常量')
      assert.equal(String(pragmaScalar(store.db, 'journal_mode')).toLowerCase(), 'wal', 'nautilus: journal_mode 必须是 wal')

      pulseStore = openPulseStore(dbFile)
      assert.equal(Number(pragmaScalar(pulseStore.db, 'busy_timeout')), SQLITE_BUSY_TIMEOUT_MS, 'pulse: busy_timeout 必须等于集中常量')
      assert.equal(String(pragmaScalar(pulseStore.db, 'journal_mode')).toLowerCase(), 'wal', 'pulse: journal_mode 必须是 wal')

      // 第三方连接（等于「另一个宿主进程」）也必须看到同一份 WAL 模式（journal_mode 是库的持久属性）
      const side = new DatabaseSync(dbFile, { readOnly: true })
      try {
        assert.equal(String(pragmaScalar(side, 'journal_mode')).toLowerCase(), 'wal', '共享库文件本身必须是 WAL')
      } finally { side.close() }
    } finally { store.close(); pulseStore?.close() }
  } finally { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('PS.0fix-C：TurnsCollector 写失败计数 / 摘要截断 / 限流日志（首 5 全打，其后每 100 次）', () => {
  // 替身 store：只让 upsertTurnRead 抛（其余照常返回），复现「并发写不进去」的单点失败
  const boom = () => { throw new Error('database is locked') }
  const store = {
    classifySessionRoot() {},
    upsertUserText() {},
    marksStepSeen() { return true },
    appendAssistantText() {},
    upsertTurnRead: boom,
  }
  const collector = new TurnsCollector(store)
  assert.deepEqual(collector.diagnostics(), { writeFailures: 0, lastError: null, lastErrorAt: null }, '未失败时是诚实的全零/空')

  const logged = []
  const origError = console.error
  console.error = (...args) => { logged.push(args.join(' ')) }
  try {
    // 首 5 次全打，第 6/7 次静默（等第 100 次）
    for (let i = 1; i <= 7; i += 1) collector.handle('s-1', { type: 'assistant/message', time: 1000 + i, data: { turn: i, step: 1, usage: { inputTokens: 1 } } })
    assert.equal(collector.diagnostics().writeFailures, 7, '每次写失败都要计数')
    assert.equal(logged.length, 5, '首 5 次全打，第 6/7 次不重复刷屏')
    assert.match(logged[0], /turn collect write failed #1/)
    assert.match(collector.diagnostics().lastError, /upsertTurnRead: database is locked/)

    // 第 100 次记一条，其余静默
    logged.length = 0
    for (let i = 8; i <= 100; i += 1) collector.handle('s-1', { type: 'assistant/message', time: 1000 + i, data: { turn: i, step: 1, usage: { inputTokens: 1 } } })
    assert.equal(collector.diagnostics().writeFailures, 100, '计数到 100')
    assert.equal(logged.length, 1, '第 100 次记一条（其余静默）')
    assert.match(logged[0], /write failed #100/)
  } finally { console.error = origError }

  assert.ok(collector.diagnostics().lastErrorAt > 0, '失败时刻要留痕（诊断面据此判断「还在失败吗」）')

  // 摘要截断：超长错误不得整段搬上诊断面
  const long = new TurnsCollector({
    classifySessionRoot() {},
    upsertUserText() {},
    marksStepSeen() { return true },
    appendAssistantText() {},
    upsertTurnRead() { throw new Error('x'.repeat(500)) },
  })
  const origError2 = console.error
  console.error = () => {}
  try {
    long.handle('s-2', { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: {} } })
  } finally { console.error = origError2 }
  assert.ok(long.diagnostics().lastError.length <= 200, 'lastError 必须截断（实测 ' + long.diagnostics().lastError.length + '）')

  // 全部写路径都抛时也不得把异常抛回事件循环（否则一条坏库会连坐所有监听器）
  const dead = new TurnsCollector(new Proxy({}, { get: () => () => { throw new Error('readonly database') } }))
  const origError3 = console.error
  console.error = () => {}
  try {
    assert.doesNotThrow(() => {
      dead.handle('s-3', { type: 'turn/start', time: 1, data: { turn: 1 } }, 'C:\\work')
      dead.handle('s-3', { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'q' }] } })
      dead.handle('s-3', { type: 'assistant/message', time: 3, data: { turn: 1, step: 1, usage: { inputTokens: 1 }, message: { content: [{ type: 'text', text: 'a' }] } } })
    }, '写失败必须被护栏吃掉（计数可见），不得抛回采集热路径')
  } finally { console.error = origError3 }
  assert.ok(dead.diagnostics().writeFailures >= 3, '全抛场景每次写都计数：' + dead.diagnostics().writeFailures)
})

test('PS.0fix-C：真实装配下丢写计数增长，且 /m2/state 的 diagnostics 可见（此前是无声的）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-wfail-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    const fiber = ctx.plugin(mod, { pulse: { enabled: false } })
    const req = (method) => ({ method, headers: { 'sec-fetch-site': 'same-origin' } })
    const res = () => ({ statusCode: 0, payload: null, writeHead(s) { this.statusCode = s }, end(text) { this.payload = JSON.parse(String(text ?? '{}')) } })
    const getState = () => { const r = res(); handlers.get('/api/nautilus/m2/state')(req('GET'), r); return r }
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !handlers.has('/api/nautilus/m2/state')) await new Promise((r) => setTimeout(r, 25))
      assert.equal(getState().payload.diagnostics.collector.writeFailures, 0, '未失败时计数为 0（不是 null——采集器已挂载）')

      // 制造真实写失败：从**另一条连接**拆掉 turn_text（原文表）——采集的原文写路径随即抛 no such table
      const side = new DatabaseSync(join(tmp, 'nautilus', 'nautilus.db'))
      side.exec('DROP TABLE turn_text')
      side.close()

      // 走官方事件通道（真实 ctx.on 监听器 → 真实 collector → 真实 store）
      const session = { id: 's-wfail', header: { cwd: 'C:\\work' } }
      ctx.emit('session/event', session, { type: 'turn/start', time: 1000, data: { turn: 1 } })
      ctx.emit('session/event', session, { type: 'user/message', time: 1010, data: { content: [{ type: 'text', text: '第一轮的问题' }] } })
      ctx.emit('session/event', session, {
        type: 'assistant/message', time: 1100,
        data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7 }, message: { content: [{ type: 'text', text: '回答' }] } },
      })

      const state = getState()
      assert.equal(state.statusCode, 200, '诊断面必须仍可读（写失败不该打挂读侧）')
      const diag = state.payload.diagnostics.collector
      assert.equal(diag.writeFailures, 2, 'user/message 与 assistant 原文两次写失败都要计数：' + JSON.stringify(diag))
      assert.match(diag.lastError, /appendAssistantText/)
      assert.match(diag.lastError, /turn_text/)
      assert.ok(diag.lastErrorAt > 0)
      // 诚实边界：丢的是**原文**，逐轮读数本身仍在（turn_read 未受影响）——计数不该被读成「整轮没了」
      assert.equal(state.payload.totals.turns, 1, 'turn_read 仍写入（丢的是 turn_text，不是读数）')
    } finally { await fiber.dispose() }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PS.0fix-C：readings 关（无采集器）时 diagnostics.collector=null（不编造 0）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nautilus-nocol-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const handlers = new Map()
    const ctx = new Context()
    ctx.provide('webServer', { register(route) { handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register() {} })
    const fiber = ctx.plugin(mod, { readings: { enabled: false }, pulse: { enabled: false } })
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !handlers.has('/api/nautilus/m2/state')) await new Promise((r) => setTimeout(r, 25))
      const r = { statusCode: 0, payload: null, writeHead(s) { this.statusCode = s }, end(text) { this.payload = JSON.parse(String(text ?? '{}')) } }
      handlers.get('/api/nautilus/m2/state')({ method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } }, r)
      assert.equal(r.statusCode, 200)
      assert.equal(r.payload.diagnostics.collector, null, '无采集器 = null（与「零失败」区分开）')
    } finally { await fiber.dispose() }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

