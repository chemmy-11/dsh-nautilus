/**
 * @dsh-external/dsh-nexus — pulse（OS/GPU 层）采集器：Nautilus 三层指标的系统层腿。
 *
 * 依据：docs/1-planning/nautilus-opening-report.md §4.2（指标口径）/ §4.3（存储）/ D1 决策
 *      + docs/2-dev/nautilus-dev-03-os-layer.md（本层开发文档）。
 *
 * 三条硬约束：
 *  1. **零依赖自采**：Node 内置（node:os / process）+ 每 tick 一次 PowerShell CIM 批量取计数器
 *     + nvidia-smi 取 GPU——不引 systeminformation / pidusage（D1 的 A′ 档）。
 *  2. **exec 可注入**：宿主路径经 `ctx.subprocess` seam 起子进程（AGENTS.md §2：不 import 宿主实现、
 *     不自己 child_process）；测试与离线验收注入 node:child_process。采集核心不认识宿主。
 *  3. **软失败**：无 N 卡 / 无 PowerShell / 字段缺失 → 该族整体缺席，不抛错、不拖累其余族。
 */
import { cpus, freemem, totalmem, hostname } from 'node:os'

/** 层名（metric_sample.layer）。 */
export const LAYER = 'pulse'
/** 指标名前缀（存 metric 列；对外导出时再加 `nautilus.`，见 §4.2）。 */
export const METRIC_PREFIX = 'pulse.'

export interface ExecResult {
  stdout: string
  /** 退出码；被信号杀死时为 null。 */
  exitCode: number | null
  /** 终止信号（与 exitCode 各自独立，不嵌套——AGENTS.md §2）。 */
  signal: string | null
  /** 由调用方按自己的 deadline 判定（seam 只反应 abort）。 */
  timedOut: boolean
}
export type Exec = (argv: readonly string[], timeoutMs: number) => Promise<ExecResult>

export interface Sample {
  metric: string
  value: number
  tags: Record<string, string | number>
}

const HOST = hostname()

// ── CPU：node:os tick 差值（零依赖、无子进程）──────────────────────────────────

export interface CpuTimes { user: number; nice: number; sys: number; idle: number; irq: number }

/** 全部核心累计 tick 之和。 */
export function cpuTimes(): CpuTimes {
  const acc: CpuTimes = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  for (const c of cpus()) {
    acc.user += c.times.user
    acc.nice += c.times.nice
    acc.sys += c.times.sys
    acc.idle += c.times.idle
    acc.irq += c.times.irq
  }
  return acc
}

/**
 * 两次采样的 CPU 使用率（0..1）。
 * 无 tick 增量（同刻重复采样 / 计数器回绕）→ null（缺席，不写 0——0 是合法读数）。
 */
export function cpuUtilization(prev: CpuTimes, cur: CpuTimes): number | null {
  const busy = (cur.user - prev.user) + (cur.nice - prev.nice) + (cur.sys - prev.sys) + (cur.irq - prev.irq)
  const idle = cur.idle - prev.idle
  const total = busy + idle
  if (!Number.isFinite(total) || total <= 0) return null
  const util = busy / total
  return util < 0 ? 0 : util > 1 ? 1 : util
}

// ── 系统计数器（Windows）：**解析**归本模块，**取数通道**归 counters.ts 的常驻助手 ──

export interface SystemCounters {
  ctxSwitchesPerSec: number | null
  diskBytesPerSec: number | null
  diskQueueLength: number | null
  netBytesPerSec: number | null
  pageFileUsedBytes: number | null
}

/** PowerShell 候选：`pwsh`（7+）可能缺席，`powershell`（Windows PowerShell 5.1）通常在场——由助手逐个试。 */
export const PWSH_CANDIDATES: readonly string[] = ['pwsh', 'powershell']

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 解析助手返回的计数器 JSON；结构不符或全字段缺失 → null（软失败，缺该族而非报错）。 */
export function parseCounters(stdout: string): SystemCounters | null {
  const text = stdout.trim()
  if (text === '') return null
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) as Record<string, unknown> } catch { return null }
  if (raw === null || typeof raw !== 'object') return null
  const pageMiB = num(raw.pageFileUsedMiB)
  const out: SystemCounters = {
    ctxSwitchesPerSec: num(raw.ctxSwitchesPerSec),
    diskBytesPerSec: num(raw.diskBytesPerSec),
    diskQueueLength: num(raw.diskQueueLength),
    netBytesPerSec: num(raw.netBytesPerSec),
    pageFileUsedBytes: pageMiB === null ? null : pageMiB * 1024 * 1024,
  }
  const anyValue = Object.values(out).some((v) => v !== null)
  return anyValue ? out : null
}

// ── GPU：nvidia-smi CSV（无 N 卡 → 整族缺席）──────────────────────────────────

export const NVIDIA_SMI_ARGS: readonly string[] = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
  '--format=csv,noheader,nounits',
]

export interface GpuReading {
  index: number
  name: string
  util: number | null
  memUsedMiB: number | null
  memTotalMiB: number | null
  tempC: number | null
  powerW: number | null
}

/** 解析 `--format=csv,noheader,nounits` 输出；无法解析的行跳过（驱动字段漂移的软失败，R8）。 */
export function parseNvidiaSmi(stdout: string): GpuReading[] {
  const out: GpuReading[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    const f = t.split(',').map((s) => s.trim())
    if (f.length < 3) continue
    const index = Number(f[0])
    if (!Number.isInteger(index)) continue
    out.push({
      index,
      name: f[1] ?? '',
      util: num(f[2]),
      memUsedMiB: num(f[3]),
      memTotalMiB: num(f[4]),
      tempC: num(f[5]),
      powerW: num(f[6]),
    })
  }
  return out
}

// ── 采集入口（每条返回该 tick 要落库的样本）──────────────────────────────────

export interface LocalReading {
  samples: Sample[]
  cpu: CpuTimes
  rss: number
}

/** 零依赖本地族：CPU 使用率 / 内存 / dsh 宿主进程（本插件跑在宿主进程内，即宿主进程）。 */
export function collectLocal(prev: CpuTimes | null, cpuNow: CpuTimes, cpuUsageDeltaUs: { user: number; system: number }, elapsedMs: number, rss: number): Sample[] {
  const samples: Sample[] = []
  if (prev !== null) {
    const util = cpuUtilization(prev, cpuNow)
    if (util !== null) samples.push({ metric: METRIC_PREFIX + 'cpu.utilization', value: util, tags: { host: HOST } })
  }
  const total = totalmem()
  const free = freemem()
  samples.push({ metric: METRIC_PREFIX + 'mem.used', value: total - free, tags: { host: HOST } })
  samples.push({ metric: METRIC_PREFIX + 'mem.total', value: total, tags: { host: HOST } })
  // dsh 宿主进程级（USE 的进程视角）：RSS 与 CPU 占用（单核为 1 的分数）
  samples.push({ metric: METRIC_PREFIX + 'proc.dsh.rss', value: rss, tags: { host: HOST, pid: process.pid } })
  if (elapsedMs > 0) {
    const cpuUs = cpuUsageDeltaUs.user + cpuUsageDeltaUs.system
    if (cpuUs >= 0) samples.push({ metric: METRIC_PREFIX + 'proc.dsh.cpu', value: cpuUs / 1000 / elapsedMs, tags: { host: HOST, pid: process.pid } })
  }
  return samples
}


/** GPU 族：无 nvidia-smi / 无 N 卡 → 返回空数组（整族缺席，R5 降级口径）。 */
export async function collectGpu(exec: Exec, timeoutMs: number, smiPath = 'nvidia-smi'): Promise<Sample[]> {
  let result: ExecResult
  try {
    result = await exec([smiPath, ...NVIDIA_SMI_ARGS], timeoutMs)
  } catch { return [] }
  if (result.exitCode !== 0) return []
  const samples: Sample[] = []
  for (const g of parseNvidiaSmi(result.stdout)) {
    const tags = { device: 'gpu' + g.index, name: g.name }
    if (g.util !== null) samples.push({ metric: METRIC_PREFIX + 'gpu.util', value: g.util, tags })
    if (g.memUsedMiB !== null) samples.push({ metric: METRIC_PREFIX + 'gpu.mem.used', value: g.memUsedMiB, tags })
    if (g.memTotalMiB !== null) samples.push({ metric: METRIC_PREFIX + 'gpu.mem.total', value: g.memTotalMiB, tags })
    if (g.tempC !== null) samples.push({ metric: METRIC_PREFIX + 'gpu.temp', value: g.tempC, tags })
    if (g.powerW !== null) samples.push({ metric: METRIC_PREFIX + 'gpu.power', value: g.powerW, tags })
  }
  return samples
}
