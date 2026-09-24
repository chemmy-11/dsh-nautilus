/**
 * @dsh-external/dsh-nautilus — pulse 插件入口（OS/GPU 层；Nautilus 三层指标的系统层腿）。
 *
 * 相位：Phase 1「pulse 最小闭环」（docs/1-planning/nautilus-opening-report.md 六、Phase 1）。
 * 装配：本包带客户端半区，**只允许一个 Loader 条目**——pulse 不是独立 patch 行，而是由父插件
 *       `ctx.plugin(pulse, config.pulse)` 挂载的子插件（见 cordis.patch.yml 顶部契约）。
 *       两者同库（`~/.dsh/nautilus/nautilus.db`）不同表——本层不动主插件的任何代码与表。
 *
 * 采集模型：**单条串行循环**（setTimeout 递归，不重叠、不并发）；
 *   · 本地族（CPU/内存/dsh 宿主进程）每次 tick 必采——零依赖、零子进程；
 *   · 计数器族（上下文切换/页文件/磁盘/网络）与 GPU 族各自有独立周期，到点才起子进程；
 *   · 子进程一律经 `ctx.get('subprocess')` seam（可选服务：缺席则该族整体缺席，不报错）。
 * 失败语义：任一族抛错只记状态、不影响其余族；无 N 卡 / 无 PowerShell → 该族缺席（R5/R8 降级口径）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver' // 拉声明合并：ctx.webServer 类型
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDataDir } from '../home.js'
import { LAYER, collectGpu, collectLocal, cpuTimes, type Exec, type ExecResult, type Sample } from './collect.js'
import { CountersSession, type ChildLike, type ChildSpawner } from './counters.js'
import { openPulseStore, type PulseStore } from './store.js'
import { registerPulseRoutes, type PulseControl } from './routes.js'
import { AlertEngine, DEFAULT_ALERT_RULES, alertMetricExpr, type AlertRule } from './alerts.js'
import { appendLedger, appendLedgerText, freezeSnapshot, pruneSnapshots, snapshotStats, type FreezeResult } from './snapshot.js'
import { REPORT_PROMPT_VERSION, aggregateMetrics, buildDigest, buildPrompt, composeReport, composeResultNote, digestFacts, type AlertDigest } from './report.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export const name = 'pulse'
/** webServer 必需（校验路由）；subprocess 可选，经 ctx.get 取（AGENTS.md §2）。 */
export const inject = ['webServer']

export interface Config {
  enabled: boolean
  /** 本地族周期（§4.2 基准 5s）。 */
  intervalMs: number
  /** 计数器族周期（PowerShell 一次进程；比本地族稀疏以压开销）。 */
  countersIntervalMs: number
  /** GPU 族周期（nvidia-smi 一次进程）。 */
  gpuIntervalMs: number
  /** 子进程单次超时。 */
  execTimeoutMs: number
  /** 原始采样保留天数（§4.3；1 分钟档聚合留 Phase 3）。 */
  retentionDays: number
  /** 保留清理周期。 */
  pruneIntervalMs: number
  enableCounters: boolean
  enableGpu: boolean
  pwshPath: string
  nvidiaSmiPath: string
  /** 空 = `$DSH_HOME/nautilus/nautilus.db`（与 nautilus 同库）。 */
  dbFile: string
  /** A 系列：OS 层红线告警总开关（默认开；关掉 = 不检测、不收口台账）。 */
  alertEnabled: boolean
  /** A 系列：告警规则表（可扩展；默认四个主要对象 + dsh-rss 关闭）。 */
  alertRules: AlertRule[]
  /** A 系列：证据目录（空 = <库目录>/alerts）。快照/报告/台账都落在这里。 */
  alertsDir: string
  /** A 系列：证据回看窗口（确认时刻往前抽多久的原始采样）。 */
  alertLookbackMs: number
  /** A 系列：快照独立保留期（天；与 metric_sample 的 retentionDays 无关）。 */
  alertSnapshotRetentionDays: number
  /** A 系列：LLM 报告门禁（D-A2 **默认关**——开启动作本身是部署决策）。 */
  alertLlmEnabled: boolean
  /** A 系列：报告单次生成上限（token）。 */
  alertLlmMaxTokens: number
  /** A 系列：报告单次超时。 */
  alertLlmTimeoutMs: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().min(1000).default(5000),
  countersIntervalMs: z.number().min(1000).default(15000),
  gpuIntervalMs: z.number().min(1000).default(10000),
  execTimeoutMs: z.number().min(500).default(8000),
  retentionDays: z.number().min(1).default(14),
  pruneIntervalMs: z.number().min(60000).default(3600000),
  enableCounters: z.boolean().default(true),
  enableGpu: z.boolean().default(true),
  /** 空 = 自动探测（pwsh → powershell）；探测失败则该族缺席。 */
  pwshPath: z.string().default(''),
  nvidiaSmiPath: z.string().default('nvidia-smi'),
  dbFile: z.string().default(''),
  alertEnabled: z.boolean().default(true),
  // 规则表逐字段可配（只改 cordis.yml 就能加规则/改阈值）；语义与交叉约束由 AlertEngine 在
  // 装配时校验（非法即加载失败，见 alerts.ts validateAlertRules）
  alertRules: z.array(z.object({
    id: z.string(),
    label: z.string().default(''),
    enabled: z.boolean().default(true),
    metric: z.string(),
    refMetric: z.string().default(''),
    op: z.string().default('gte'),
    threshold: z.number(),
    clear: z.number(),
    forMs: z.number().min(0).default(30000),
    cooldownMs: z.number().min(0).default(0),
  })).default(DEFAULT_ALERT_RULES.map((r) => ({ ...r }))),
  alertsDir: z.string().default(''),
  alertLookbackMs: z.number().min(60_000).default(2 * 3600_000),
  alertSnapshotRetentionDays: z.number().min(1).default(30),
  alertLlmEnabled: z.boolean().default(false),
  alertLlmMaxTokens: z.number().min(64).max(8192).default(900),
  alertLlmTimeoutMs: z.number().min(1000).default(60000),
})

export interface PulseCollectorStatus {
  startedAt: number
  ticks: number
  lastTickTs: number | null
  lastDurationMs: number | null
  lastSampleCount: number
  lastError: string | null
  countersOk: boolean
  gpuOk: boolean
  gpuSamples: number
  execAvailable: boolean
  /** 计数器助手的实际 PowerShell（null = 未启动）。 */
  shellPath: string | null
  /** 助手重启次数（读超时/进程退出 → 下个周期重启）。 */
  countersRestarts: number
  sealed: boolean
  /** 心跳档位：auto = 按 intervalMs 定时；manual = 只在 UI 手动触发时采样。 */
  mode: 'auto' | 'manual'
  /** 当前（或最近一次）自动档间隔 ms；manual 档保留上次值以便切回。 */
  intervalMs: number
}

/** `ctx.subprocess` 的最小鸭子类型（可选 seam；不 import 宿主实现，见 AGENTS.md §2）。 */
interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore' | 'pipe'; stdout: 'pipe' | { maxBytes: number }; stderr: 'pipe' | { maxBytes: number } }
    graceMs: number
    signal?: AbortSignal
  }): {
    collected?: { stdout?: { readFrom(offset: number): { text: string } } }
    done: Promise<{ exitCode: number | null; signal: string | null }>
    terminate(): void
  }
}

/** 把 `ctx.subprocess` 适配成采集器要的 Exec；服务缺席 → null（依赖子进程的族整体缺席）。 */
export function makeExecFrom(ctx: Context): Exec | null {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const sub = typeof get === 'function' ? (get.call(ctx, 'subprocess') as SubprocessLike | undefined) : undefined
  if (sub === undefined || sub === null || typeof sub.spawn !== 'function') return null
  return async (argv: readonly string[], timeoutMs: number): Promise<ExecResult> => {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)
    try {
      const handle = sub.spawn({
        argv,
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } },
        graceMs: 2000,
        signal: ac.signal,
      })
      let exitCode: number | null = null
      let signal: string | null = null
      try {
        const outcome = await handle.done
        exitCode = outcome.exitCode
        signal = outcome.signal
      } catch {
        try { handle.terminate() } catch { /* 已终止 */ }
      }
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      return { stdout, exitCode, signal, timedOut }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) {
    console.warn('[pulse] Config.enabled=false —— 不启动采集（只保留路由空态）')
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 默认与主插件同库；走共享助手（父插件已迁移过则为无操作，独立挂载时也能自愈）
  const dbFile = config.dbFile !== '' ? config.dbFile : resolveDataDir(dshHome).dbFile
  const store: PulseStore = openPulseStore(dbFile)
  ctx.effect(() => () => store.close())

  // A 系列：告警检测内核（构造即校验——非法规则在这里响亮失败，不留到运行时静默失效）
  const engine = config.alertEnabled ? new AlertEngine(config.alertRules) : null
  // A 系列：证据目录（快照 / 报告 / 台账）。默认落库目录旁的 alerts/；
  // ':memory:' 这种无目录库退到系统临时目录，绝不往仓库/当前工作目录写垃圾。
  const alertsRoot = config.alertsDir !== ''
    ? config.alertsDir
    : (dbFile === ':memory:' ? join(tmpdir(), 'nautilus-alerts-mem-' + String(process.pid)) : join(dirname(dbFile), 'alerts'))
  const ledgerPath = join(alertsRoot, 'ledger.md')
  if (engine !== null) {
    // 启动自愈：上个进程遗留的未解除行收口（重启后连续段与峰值都不可考，不装「还活着」）
    const stale = store.closeStaleAlerts(Date.now())
    if (stale.length > 0) console.warn('[pulse] 告警启动自愈：收口 ' + stale.length + ' 条遗留未解除告警（' + stale.join(', ') + '）')
  }
  // A.3：报告落点与去重（同一告警只成文一次；在飞请求可随插件卸载中止）
  const reportsDir = join(alertsRoot, 'reports')
  const reportedIds = new Set<string>()
  const reportAborts = new Set<AbortController>()
  /** 台账人读日志一行（结构化数据仍以 alert_event 为准）。 */
  const ledger = (text: string): void => {
    try { appendLedger(ledgerPath, '- `' + new Date().toISOString() + '` ' + text) } catch (err) {
      console.warn('[pulse] 台账日志追加失败（不影响结构化台账）：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const exec = makeExecFrom(ctx)
  const status: PulseCollectorStatus = {
    startedAt: Date.now(), ticks: 0, lastTickTs: null, lastDurationMs: null, lastSampleCount: 0,
    lastError: null, countersOk: false, gpuOk: false, gpuSamples: 0,
    execAvailable: exec !== null, shellPath: null, countersRestarts: 0, sealed: false,
    mode: config.enabled ? 'auto' : 'manual', intervalMs: config.intervalMs,
  }

  let prevCpu = cpuTimes()
  let prevUsage = process.cpuUsage()
  let lastCountersTs = 0
  let lastGpuTs = 0
  let lastPruneTs = Date.now()
  const sessionSpawner = makeSessionSpawnerFrom(ctx)
  const counters = sessionSpawner === null ? null : new CountersSession(sessionSpawner, config.pwshPath)
  ctx.effect(() => () => { void counters?.close() })
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let ticking = false
  let pendingManual = false

  /** 按当前档位重排下一次自动采样；manual 档（或已停）不排。 */
  const reschedule = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (stopped || status.mode !== 'auto') return
    timer = setTimeout(() => { void tick() }, status.intervalMs)
  }

  const tick = async (): Promise<void> => {
    // 与定时 tick 串行：手动触发撞上自动 tick 时排队一次，不并发采（同库同连接）
    if (ticking) { pendingManual = true; return }
    ticking = true
    const started = Date.now()
    const samples: Sample[] = []
    try {
      const now = cpuTimes()
      const usage = process.cpuUsage()
      const elapsed = started - (status.lastTickTs ?? started)
      samples.push(...collectLocal(prevCpu, now, { user: usage.user - prevUsage.user, system: usage.system - prevUsage.system }, elapsed, process.memoryUsage().rss))
      prevCpu = now
      prevUsage = usage

      if (counters !== null && config.enableCounters && started - lastCountersTs >= config.countersIntervalMs) {
        lastCountersTs = started
        const rows = await counters.sample(config.execTimeoutMs)
        samples.push(...rows)
        status.countersOk = rows.length > 0
        const st = counters.stats()
        status.shellPath = st.shell
        status.countersRestarts = st.restarts
      }
      if (exec !== null && config.enableGpu && started - lastGpuTs >= config.gpuIntervalMs) {
        lastGpuTs = started
        const rows = await collectGpu(exec, config.execTimeoutMs, config.nvidiaSmiPath)
        samples.push(...rows)
        status.gpuOk = rows.length > 0
        status.gpuSamples = rows.length
      }

      store.insert(started, LAYER, samples)
      status.lastSampleCount = samples.length
      status.lastError = null

      // A 系列：把本 tick 的最新值喂检测内核。缺席的指标不进 map → 相关规则跳过且**状态保持**
      // （缺席不等于恢复）。迁移只在本 tick 内处理，不跨 tick 攒批——确认/解除都落在真实时刻上。
      if (engine !== null) {
        const values = new Map<string, number>()
        for (const s of samples) if (Number.isFinite(s.value)) values.set(s.metric, s.value)
        for (const t of engine.observe(values, started)) {
          if (t.kind === 'opened') {
            const ins = store.insertAlert({
              id: t.alertId, ruleId: t.rule.id, metric: alertMetricExpr(t.rule), op: t.rule.op,
              threshold: t.rule.threshold, firstExceededAt: t.firstExceededAt, confirmedAt: t.confirmedAt,
              peakValue: t.peak, createdAt: Date.now(),
            })
            console.warn('[pulse] 告警确认 ' + t.alertId + '（' + t.rule.label + ' ' + alertMetricExpr(t.rule) +
              ' ' + t.rule.op + ' ' + String(t.rule.threshold) + '，连续 ' + String(Math.round((t.confirmedAt - t.firstExceededAt) / 1000)) + 's）· 台账 ' + ins)
            ledger('**确认** `' + t.alertId + '` · ' + t.rule.label + ' · ' + alertMetricExpr(t.rule) + ' ' + t.rule.op + ' ' +
              String(t.rule.threshold) + ' · 峰值 ' + String(t.peak) + ' · 连续 ' + String(Math.round((t.confirmedAt - t.firstExceededAt) / 1000)) + 's')
            // A.2：证据冻结（抽取确认时刻往前 lookback 的原生采样 → gz + 覆盖率 + 指纹）
            freezeEvidence(t)
          } else {
            const closed = store.closeAlert(t.alertId, t.ts)
            console.info('[pulse] 告警解除 ' + t.alertId + '（持续 ' + String(Math.round(t.durationMs / 1000)) + 's' + (closed ? '' : '，台账行已收口') + '）')
            ledger('**解除** `' + t.alertId + '` · 值 ' + String(t.value) + ' · 持续 ' + String(Math.round(t.durationMs / 1000)) + 's' +
              (closed ? '' : '（台账行本已收口）'))
            appendResultNote({ alertId: t.alertId, clearedAt: t.ts, durationMs: t.durationMs, peak: t.peak, value: t.value })
          }
        }
      }
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      ticking = false
      status.ticks += 1
      status.lastTickTs = started
      status.lastDurationMs = Date.now() - started
      if (Date.now() - lastPruneTs >= config.pruneIntervalMs) {
        lastPruneTs = Date.now()
        try { store.prune(Date.now() - config.retentionDays * 86400000) } catch (err) { status.lastError = err instanceof Error ? err.message : String(err) }
        // A.2：快照独立保留期（不受原始采样 14 天影响——证据是给人回查的，留得更久）
        if (engine !== null) {
          try {
            const gone = pruneSnapshots(alertsRoot, Date.now() - config.alertSnapshotRetentionDays * 86400000)
            if (gone.length > 0) console.info('[pulse] 快照保留期清理：删除 ' + String(gone.length) + ' 份过期证据（保留 ' + String(config.alertSnapshotRetentionDays) + ' 天）')
          } catch (err) { status.lastError = err instanceof Error ? err.message : String(err) }
        }
      }
      // 手动排队优先；否则按当前档位重排（manual 档不会排下一次）
      if (pendingManual) { pendingManual = false; void tick() } else reschedule()
    }
  }

  if (config.enabled) {
    timer = setTimeout(() => { void tick() }, Math.min(1000, status.intervalMs))
  }

  // 运行时心跳控制：档位可变（auto@intervalMs / manual），手动档只在 sampleNow 时采一次。
  // 采样始终走同一条 tick 路径（同库同表），控制面只改节律——不产生第二套口径。
  const control: PulseControl = {
    setAuto: (ms) => { status.intervalMs = ms; status.mode = 'auto'; reschedule() },
    setManual: () => { status.mode = 'manual'; if (timer !== null) { clearTimeout(timer); timer = null } },
    sampleNow: () => tick(),
  }

  registerPulseRoutes(ctx, {
    store,
    status: () => status,
    control,
    alerts: () => ({
      enabled: config.alertEnabled,
      rules: engine === null ? config.alertRules.map((r) => ({ ...r })) : engine.rulesView(),
      states: engine === null ? [] : engine.statesView(),
      evidence: engine === null ? undefined : snapshotStats(alertsRoot),
    }),
  })

  ctx.effect(() => () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    // A.3：在飞的报告请求随插件卸载中止（不留孤儿请求；台账仍是 pending，重启后不会静默补写）
    for (const ac of reportAborts) { try { ac.abort(new Error('plugin-dispose')) } catch { /* 已结束 */ } }
    reportAborts.clear()
    status.sealed = true
  })

  console.info('[pulse] 告警' + (engine === null ? '已停用（pulse.alertEnabled=false，不做检测也不收口台账）' : '就绪：规则 ' + String(engine.rulesView().filter((r) => r.enabled).length) + '/' + String(engine.rulesView().length) + ' 启用'))
  console.info('[pulse] 采集启动：mode=' + status.mode + ' interval=' + status.intervalMs + 'ms counters=' + config.countersIntervalMs + 'ms gpu=' + config.gpuIntervalMs + 'ms exec=' + (exec !== null ? 'ctx.subprocess' : '不可用（只采本地族）') + ' db=' + dbFile)

  /**
   * A.2 + A.3：冻结越线证据 → 写确定性 digest → 生成报告（门禁默认关）。
   * 冻结失败**不改判定结果**（告警已确认、已落台账），只把报告态标 failed 并留一条警告——
   * 「证据没冻上」本身是必须被看见的事实，不能静默吞掉。
   */
  function freezeEvidence(t: { rule: AlertRule; alertId: string; confirmedAt: number; firstExceededAt: number; peak: number }): void {
    const from = t.confirmedAt - config.alertLookbackMs
    let res: FreezeResult
    let rows: Array<{ ts: number; metric: string; value: number | null; tags: string }>
    try {
      rows = store.windowRows(from, t.confirmedAt)
      res = freezeSnapshot({
        root: alertsRoot, alertId: t.alertId, ruleId: t.rule.id,
        metric: alertMetricExpr(t.rule), op: t.rule.op,
        threshold: t.rule.threshold, clear: t.rule.clear,
        from, to: t.confirmedAt, rows,
        activeSessions: store.activeSessions(from, t.confirmedAt),
        now: Date.now(),
      })
      store.setAlertSnapshot(t.alertId, res.samplesPath, res.snapshotHash)
      const pct = (res.meta.coverage * 100).toFixed(1)
      const gaps = res.meta.gapCount > 0 ? '（最大 ' + String(Math.round(res.meta.maxGapMs / 60000)) + 'min）' : ''
      console.info('[pulse] 证据冻结 ' + t.alertId + '：' + String(res.meta.rows) + ' 行 / ' + String(res.meta.metrics.length) +
        ' 指标 / 覆盖 ' + pct + '% / 空洞 ' + String(res.meta.gapCount) + gaps + ' / sha256 ' + res.snapshotHash.slice(0, 12))
      ledger('**冻结** `' + t.alertId + '` · 回看 ' + String(Math.round(config.alertLookbackMs / 3600000)) + 'h · ' +
        String(res.meta.rows) + ' 行 · 覆盖 ' + pct + '% · 空洞 ' + String(res.meta.gapCount) + ' · sha256 `' + res.snapshotHash.slice(0, 16) + '`')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try { store.setAlertReport(t.alertId, 'failed', null, null) } catch { /* 连标记都失败：下面还有日志 */ }
      console.error('[pulse] 证据冻结失败 ' + t.alertId + '：' + msg)
      ledger('**冻结失败** `' + t.alertId + '` · ' + msg)
      return
    }
    // A.3：digest 是「事实段」的唯一素材，无论模型开不开都落盘（证据自足、可离线复算）
    try {
      const digest = buildDigest({
        alertId: t.alertId, ruleId: t.rule.id, ruleLabel: t.rule.label,
        metric: alertMetricExpr(t.rule), op: t.rule.op,
        threshold: t.rule.threshold, clear: t.rule.clear,
        firstExceededAt: t.firstExceededAt, confirmedAt: t.confirmedAt, peak: t.peak,
        meta: res.meta, snapshotHash: res.snapshotHash,
        metrics: aggregateMetrics(rows), now: Date.now(),
      })
      writeFileSync(join(res.dir, 'digest.json'), JSON.stringify(digest, null, 2), 'utf8')
      void generateReport(digest)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try { store.setAlertReport(t.alertId, 'failed', null, null) } catch { /* 见上 */ }
      console.error('[pulse] digest 生成失败 ' + t.alertId + '：' + msg)
      ledger('**报告失败** `' + t.alertId + '` · digest 生成失败：' + msg)
    }
  }

  /**
   * A.3：生成报告并落三处日志（台账行 / ledger.md 内联报告 / reports/<id>.md）。
   * 门禁：默认关；关或不可用时**照样写完整事实段**，只把假设段标缺席（禁止假装有结论）。
   */
  async function generateReport(digest: AlertDigest): Promise<void> {
    if (reportedIds.has(digest.alertId)) return
    reportedIds.add(digest.alertId)
    const facts = digestFacts(digest)
    const target = join(reportsDir, digest.alertId + '.md')
    let raw: string | null = null
    let skipReason: string | null = null
    let model: string | null = null
    let status: 'done' | 'skipped' | 'failed' = 'skipped'
    const picked = config.alertLlmEnabled ? pickLlm(ctx) : null
    if (!config.alertLlmEnabled) skipReason = '门禁默认关（pulse.alertLlmEnabled=false）'
    else if (picked === null) skipReason = '无 ctx.llm seam 或默认模型未选定'
    else {
      model = picked.provider + '/' + picked.model
      const ac = new AbortController()
      reportAborts.add(ac)
      const timer = setTimeout(() => { ac.abort(new Error('report-timeout')) }, config.alertLlmTimeoutMs)
      try {
        const { system, user } = buildPrompt(digest, facts)
        raw = await collectLlmText(picked.llm, {
          provider: picked.provider,
          model: picked.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          maxTokens: config.alertLlmMaxTokens,
          signal: ac.signal,
        })
        if (raw.trim() === '') { status = 'failed'; skipReason = '模型返回空文本'; raw = null } else status = 'done'
      } catch (err) {
        status = 'failed'
        skipReason = err instanceof Error ? err.message : String(err)
        raw = null
      } finally {
        clearTimeout(timer)
        reportAborts.delete(ac)
      }
    }
    try {
      mkdirSync(reportsDir, { recursive: true })
      const body = composeReport({ digest, facts, raw, skipReason, model })
      writeFileSync(target, body, 'utf8')
      store.setAlertReport(digest.alertId, status, model, raw === null ? null : REPORT_PROMPT_VERSION)
      console.info('[pulse] 告警报告 ' + digest.alertId + ' → ' + status + (skipReason === null ? '' : '（' + skipReason + '）') + ' · ' + target)
      ledger('**报告** `' + digest.alertId + '` · ' + status + (model === null ? '' : ' · ' + model) + (skipReason === null ? '' : ' · ' + skipReason))
      // 三层日志之「ledger 内联报告」：全文投进人读台账；超长截断（全文永远在 reports/<id>.md）
      const cap = 4000
      appendLedgerText(ledgerPath, '\n' + (body.length > cap ? body.slice(0, cap) + '\n…（截断，全文见 reports/' + digest.alertId + '.md）\n' : body) + '\n---\n')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try { store.setAlertReport(digest.alertId, 'failed', model, null) } catch { /* 见上 */ }
      console.error('[pulse] 报告落盘失败 ' + digest.alertId + '：' + msg)
      ledger('**报告失败** `' + digest.alertId + '` · 落盘失败：' + msg)
    }
  }

  /** 解除补记（不重复调模型；报告文件在则追加）。 */
  function appendResultNote(t: { alertId: string; clearedAt: number; durationMs: number; peak: number; value: number }): void {
    const target = join(reportsDir, t.alertId + '.md')
    try {
      if (!existsSync(target)) return
      const note = composeResultNote({ clearedAt: t.clearedAt, durationMs: t.durationMs, peak: t.peak, value: t.value })
      writeFileSync(target, readFileSync(target, 'utf8') + note, 'utf8')
      appendLedgerText(ledgerPath, '\n' + note + '---\n')
    } catch (err) {
      console.warn('[pulse] 解除补记失败（不影响台账）：' + (err instanceof Error ? err.message : String(err)))
    }
  }

  /** 计数器助手用的常驻子进程 spawner（stdin/stdout 双管道；宿主 seam 缺席 → null）。 */
  function makeSessionSpawnerFrom(c: Context): ChildSpawner | null {
    const get = (c as unknown as { get?: (name: string) => unknown }).get
    const sub = typeof get === 'function' ? (get.call(c, 'subprocess') as SubprocessLike | undefined) : undefined
    if (sub === undefined || sub === null || typeof sub.spawn !== 'function') return null
    return (argv) => {
      try {
        const handle = sub.spawn({
          argv,
          cwd: process.cwd(),
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1 << 16 } },
          graceMs: 2000,
        })
        const child: ChildLike = {
          write: (t) => { const stdin = (handle as unknown as { stdin?: { write(s: string): void } }).stdin; stdin?.write(t) },
          onStdout: (cb) => { const out = (handle as unknown as { stdout?: { on(e: string, f: (b: unknown) => void): void } }).stdout; out?.on('data', (b) => cb(String(b))) },
          onExit: (cb) => { void handle.done.then(() => cb(), () => cb()) },
          closeStdin: () => { const stdin = (handle as unknown as { stdin?: { end(): void } }).stdin; stdin?.end() },
          terminate: () => { try { handle.terminate() } catch { /* 已终止 */ } },
        }
        return child
      } catch { return null }
    }
  }
}

// ── A.3：LLM seam 与流式取文（宿主契约 duck-type；不 import 宿主实现）──────────────

/** `ctx.llm` 的最小鸭子类型：只要一个 stream()。 */
interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<{ type?: unknown; text?: unknown }>
}

/** 默认模型选择（`ctx.agentDefaultModel.currentSelection()`）。 */
interface DefaultModelLike {
  currentSelection?: () => { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
}

export interface PickedLlm {
  llm: LlmLike
  provider: string
  model: string
  reasoningEffort: string | undefined
}

/**
 * 取 LLM seam + 跟随默认模型（决策 D-A2）。任一缺席 → null（报告标 skipped，不编第二条通道）。
 * 可选服务一律 `ctx.get()`（AGENTS §2：未注入的 `ctx.x` 会走 shadow 解析并抛错）。
 */
export function pickLlm(ctx: Context): PickedLlm | null {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return null
  const llm = get.call(ctx, 'llm') as LlmLike | undefined
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') return null
  const dm = get.call(ctx, 'agentDefaultModel') as DefaultModelLike | undefined
  const sel = dm?.currentSelection?.()
  if (sel === undefined || typeof sel.provider !== 'string' || typeof sel.model !== 'string') return null
  if (sel.provider === '' || sel.model === '') return null
  return {
    llm,
    provider: sel.provider,
    model: sel.model,
    reasoningEffort: typeof sel.reasoningEffort === 'string' ? sel.reasoningEffort : undefined,
  }
}

/** 把 stream 里的 text-delta 拼成完整文本（只认 `text-delta`；reasoning 不进报告）。 */
export async function collectLlmText(llm: LlmLike, options: Record<string, unknown>): Promise<string> {
  let out = ''
  const stream = llm.stream(options)
  for await (const chunk of stream) {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  return out
}
