/**
 * @dsh-external/dsh-nexus — pulse 插件入口（OS/GPU 层；Nautilus 三层指标的系统层腿）。
 *
 * 相位：Phase 1「pulse 最小闭环」（docs/1-planning/nautilus-opening-report.md 六、Phase 1）。
 * 装配：本插件是**独立 patch 行**（`cordis.patch.yml` 的 `id: pulse`），与 nexus 插件同包不同入口；
 *       两者同库（`~/.dsh/nexus/nexus.db`）不同表——本层不动 nexus 任何代码与表。
 *
 * 采集模型：**单条串行循环**（setTimeout 递归，不重叠、不并发）；
 *   · 本地族（CPU/内存/dsh 宿主进程）每次 tick 必采——零依赖、零子进程；
 *   · 计数器族（上下文切换/页文件/磁盘/网络）与 GPU 族各自有独立周期，到点才起子进程；
 *   · 子进程一律经 `ctx.get('subprocess')` seam（可选服务：缺席则该族整体缺席，不报错）。
 * 失败语义：任一族抛错只记状态、不影响其余族；无 N 卡 / 无 PowerShell → 该族缺席（R5/R8 降级口径）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver' // 拉声明合并：ctx.webServer 类型
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { LAYER, collectGpu, collectLocal, cpuTimes, type Exec, type ExecResult, type Sample } from './collect.js'
import { CountersSession, type ChildLike, type ChildSpawner } from './counters.js'
import { openPulseStore, type PulseStore } from './store.js'
import { registerPulseRoutes } from './routes.js'

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
  /** 空 = `$DSH_HOME/nexus/nexus.db`（与 nexus 同库）。 */
  dbFile: string
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
  const dbFile = config.dbFile !== '' ? config.dbFile : join(dshHome, 'nexus', 'nexus.db')
  const store: PulseStore = openPulseStore(dbFile)
  ctx.effect(() => () => store.close())

  const exec = makeExecFrom(ctx)
  const status: PulseCollectorStatus = {
    startedAt: Date.now(), ticks: 0, lastTickTs: null, lastDurationMs: null, lastSampleCount: 0,
    lastError: null, countersOk: false, gpuOk: false, gpuSamples: 0,
    execAvailable: exec !== null, shellPath: null, countersRestarts: 0, sealed: false,
  }

  registerPulseRoutes(ctx, { store, status: () => status })

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

  const tick = async (): Promise<void> => {
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
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      status.ticks += 1
      status.lastTickTs = started
      status.lastDurationMs = Date.now() - started
      if (Date.now() - lastPruneTs >= config.pruneIntervalMs) {
        lastPruneTs = Date.now()
        try { store.prune(Date.now() - config.retentionDays * 86400000) } catch (err) { status.lastError = err instanceof Error ? err.message : String(err) }
      }
      if (!stopped && config.enabled) timer = setTimeout(() => { void tick() }, config.intervalMs)
    }
  }

  if (config.enabled) {
    timer = setTimeout(() => { void tick() }, Math.min(1000, config.intervalMs))
  }

  ctx.effect(() => () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    status.sealed = true
  })

  console.info('[pulse] 采集启动：interval=' + config.intervalMs + 'ms counters=' + config.countersIntervalMs + 'ms gpu=' + config.gpuIntervalMs + 'ms exec=' + (exec !== null ? 'ctx.subprocess' : '不可用（只采本地族）') + ' db=' + dbFile)

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
