/**
 * @dsh-external/dsh-nautilus — pure-function regression tests (zero deps, node:test).
 * Tests the BUILT artifacts (lib/) — run `npm run build` first (CI: install → build → test).
 * Coverage: analysis.ts (A 投影/S 形/爆发段/τ_e) + selfcheck.ts (自评三行) + scan.ts (R4 分支).
 * 依赖 node:sqlite（Node ≥ 22.13/24，CI node-version 24）与临时目录（mkdtemp）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
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
    const store = openStore(join(tmp, 'nautilus.db'))
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
  assert.deepEqual(calls, [
    'effect:@dsh-external/dsh-nautilus: panel',
    'inject:conversation.view',
    'register:conversation.view|@dsh-external/dsh-nautilus-panel',
    'effect:@dsh-external/dsh-nautilus: lfield panel',
    'inject:conversation.view',
    'register:conversation.view|@dsh-external/dsh-nautilus-lfield-panel',
    'effect:@dsh-external/dsh-nautilus: workbench icon',
    'inject:sidebar.panellist',
    'register:sidebar.panellist|nautilus-workbench',
    'effect:@dsh-external/dsh-nautilus: workbench panel',
    'inject:main',
    'register:main|nautilus-workbench',
  ])
  // 工作台契约（§3.0 实测）：panellist 的 list id 与 main 的 key 必须同值——否则图标行点不到主区
  const panelIds = calls.filter((c) => c.startsWith('register:sidebar.panellist|') || c.startsWith('register:main|')).map((c) => c.split('|')[1])
  assert.deepEqual(panelIds, ['nautilus-workbench', 'nautilus-workbench'])
})

// ── 客户端半区：视图组件禁止直调（源码级守卫）──────────────────────────────────

test('workbench 视图必须渲染为元素：禁止 View({...}) 直调（hooks 会算进父组件，切视图即崩）', () => {
  // 教训（§E13）：把带 hooks 的视图当普通函数调用，切视图时 hooks 数量变化 → React 整页渲染失败。
  // 只查「带 hooks 的组件」：Stat / Panel / Empty / Spark 是无 hooks 的纯呈现助手，按契约允许直调。
  const src = readFileSync(new URL('../src/client/workbench.ts', import.meta.url), 'utf8')
  const components = ['Workbench', 'OverviewView', 'CurveView', 'HypothesesView', 'ProphecyView', 'ReportView', 'Drawer']
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
    ctx.provide('webServer', { register(route) { routes.push(route.path); handlers.set(route.path, route.handler); return () => {} } })
    ctx.provide('tools', { register(def) { tools.push(def.name) } })
    const fiber = ctx.plugin(mod, {
      vaultRoot: '',
      pulse: { enabled: true, enableCounters: false, enableGpu: false, intervalMs: 60000, dbFile: ':memory:' },
    })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !routes.includes('/api/nautilus/pulse/state')) await new Promise((r) => setTimeout(r, 25))
    assert.deepEqual([...routes].sort(), [
      '/api/nautilus/action',
      '/api/nautilus/lfield',
      '/api/nautilus/m2/analysis',
      '/api/nautilus/m2/annotations',
      '/api/nautilus/m2/state',
      '/api/nautilus/m2/turn-text',
      '/api/nautilus/pulse/control',
      '/api/nautilus/pulse/series',
      '/api/nautilus/pulse/state',
      '/api/nautilus/state',
      '/api/nautilus/vault',
    ])
    assert.deepEqual([...tools], ['record_turn_selfcheck'])
    await fiber.dispose()
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
      vaultRoot: '',
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
