/**
 * @dsh-external/dsh-nexus — 计数器族的**常驻助手**（Windows 系统计数器的低成本通道）。
 *
 * 为什么需要它（实测，2026-09-13，Windows PowerShell 5.1）：
 *   · **一次性进程**：每次约 `wall 3.0s / CPU 2.9s`——其中 ~2.5s 是解释器启动与 CIM 模块自动加载；
 *   · **常驻会话**：预热后单次查询 `wall ~0.9s / CPU 16–31ms`（wall 主要是 WMI 等待，不占 CPU）。
 * 结论：按 5–15s 周期采样，常驻助手把 CPU 开销从「单核 ~19%」压到「<0.2%」。
 *
 * 形态：一个常驻 PowerShell 子进程 + **行协议**——父进程写一行 `sample`，子进程回一行 JSON。
 * 子进程由调用方注入（宿主走 `ctx.subprocess` seam，离线探针走 node:child_process），本模块不认识宿主。
 * 失败语义：启动失败 / 进程退出 / 读超时 → 会话标记为死，返回空样本（该族缺席），下次周期重试启动。
 */
import { PWSH_CANDIDATES, parseCounters, METRIC_PREFIX, type Sample } from './collect.js'

/** 助手脚本：预热一次（吃掉模块加载）→ 打印 ready → 逐行应答 sample。 */
export const HELPER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  // 预热：CIM 类首次访问会加载模块（约 0.7s CPU）——放在 ready 之前，别让首个采样点背这笔账
  "$null = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_System",
  "$null = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk",
  "$null = Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface",
  "$null = Get-CimInstance -ClassName Win32_PageFileUsage",
  "[Console]::Out.WriteLine('{\"ready\":true}')",
  "[Console]::Out.Flush()",
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  try {',
  '    $sys = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_System',
  "    $disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1",
  '    $net = Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface',
  '    $pf = Get-CimInstance -ClassName Win32_PageFileUsage',
  '    $netSum = 0.0; foreach ($n in $net) { $netSum += [double]$n.BytesTotalPersec }',
  '    $pfSum = 0.0; foreach ($p in $pf) { $pfSum += [double]$p.CurrentUsage }',
  '    $json = [pscustomobject]@{ ctxSwitchesPerSec = [double]$sys.ContextSwitchesPersec; diskBytesPerSec = [double]$disk.DiskBytesPersec; diskQueueLength = [double]$disk.AvgDiskQueueLength; netBytesPerSec = $netSum; pageFileUsedMiB = $pfSum } | ConvertTo-Json -Compress',
  '  } catch {',
  '    $json = \'{"error":"query-failed"}\'',
  '  }',
  '  [Console]::Out.WriteLine($json)',
  '  [Console]::Out.Flush()',
  '}',
].join('\n')

/** 子进程的最小面（宿主与离线探针各自适配；本模块只认这个面）。 */
export interface ChildLike {
  write(text: string): void
  onStdout(cb: (chunk: string) => void): void
  onExit(cb: () => void): void
  closeStdin(): void
  terminate(): void
}
export type ChildSpawner = (argv: readonly string[]) => ChildLike | null

const HELPER_ARGS = (shell: string): readonly string[] => [shell, '-NoProfile', '-NonInteractive', '-Command', HELPER_SCRIPT]

export class CountersSession {
  private child: ChildLike | null = null
  private buffer = ''
  private queue: string[] = []
  private waiter: ((line: string | null) => void) | null = null
  private dead = false
  private ready = false
  private starting: Promise<boolean> | null = null
  private shell: string | null = null
  private samples = 0
  private restarts = 0
  /** 代际：候选进程切换/重启时自增——迟到的 onExit/onStdout 不得影响当前代（否则会把新候选取代掉）。 */
  private gen = 0

  constructor(private readonly spawn: ChildSpawner, private readonly preferredShell = '') {}

  /** 已采样本数 / 重启次数（面板与证据用）。 */
  stats(): { samples: number; restarts: number; alive: boolean; shell: string | null } {
    return { samples: this.samples, restarts: this.restarts, alive: this.child !== null && !this.dead, shell: this.shell }
  }

  /** 选一个可用的 PowerShell 并启动助手；成功返回 true。并发调用共享同一次启动。 */
  async start(timeoutMs = 15000): Promise<boolean> {
    if (this.child !== null && !this.dead) return true
    if (this.starting !== null) return await this.starting
    this.starting = (async () => {
      const candidates = this.preferredShell !== '' ? [this.preferredShell, ...PWSH_CANDIDATES.filter((c) => c !== this.preferredShell)] : [...PWSH_CANDIDATES]
      for (const shell of candidates) {
        const child = this.spawn(HELPER_ARGS(shell))
        if (child === null) continue
        const myGen = ++this.gen
        this.child = child
        this.shell = shell
        this.dead = false
        this.ready = false
        this.buffer = ''
        this.queue = []
        child.onStdout((chunk) => { if (myGen === this.gen) this.onChunk(chunk) })
        child.onExit(() => {
          if (myGen !== this.gen) return
          this.dead = true
          this.child = null
          this.resolveWaiter(null)
        })
        const line = await this.readLine(timeoutMs)
        if (line !== null && line.includes('ready')) {
          this.ready = true
          return true
        }
        // 该解释器起不来（缺 CIM / 权限）→ 换下一个（先把这一代作废，迟到的回调不再干扰）
        this.gen += 1
        try { child.terminate() } catch { /* 已终止 */ }
        this.child = null
        this.dead = true
      }
      return false
    })()
    try { return await this.starting } finally { this.starting = null }
  }

  /** 采一次：写一行 sample，读一行 JSON → 样本；失败返回 []（该族缺席）。 */
  async sample(timeoutMs = 8000): Promise<Sample[]> {
    if (!this.ready && !(await this.start(timeoutMs))) return []
    const child = this.child
    if (child === null || this.dead) return []
    child.write('sample\n')
    const line = await this.readLine(timeoutMs)
    if (line === null) {
      // 读超时/进程死：标记不可用，下个周期重启（不阻塞本轮其余族）
      this.gen += 1
      this.dead = true
      try { child.terminate() } catch { /* 已终止 */ }
      this.child = null
      this.restarts += 1
      return []
    }
    const c = parseCounters(line)
    if (c === null) return []
    this.samples += 1
    const tags = { host: process.env.COMPUTERNAME ?? '' }
    const out: Sample[] = []
    if (c.ctxSwitchesPerSec !== null) out.push({ metric: METRIC_PREFIX + 'cpu.ctx_switches', value: c.ctxSwitchesPerSec, tags })
    if (c.pageFileUsedBytes !== null) out.push({ metric: METRIC_PREFIX + 'mem.swap.used', value: c.pageFileUsedBytes, tags })
    if (c.diskBytesPerSec !== null) out.push({ metric: METRIC_PREFIX + 'disk.io_rate', value: c.diskBytesPerSec, tags })
    if (c.diskQueueLength !== null) out.push({ metric: METRIC_PREFIX + 'disk.queue', value: c.diskQueueLength, tags })
    if (c.netBytesPerSec !== null) out.push({ metric: METRIC_PREFIX + 'net.io_rate', value: c.netBytesPerSec, tags })
    return out
  }

  /** 停稳：关 stdin 让助手自然退出，宽限期内没退再 terminate。 */
  async close(graceMs = 2000): Promise<void> {
    const child = this.child
    this.child = null
    this.dead = true
    if (child === null) return
    try { child.closeStdin() } catch { /* 管道已断 */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { child.terminate() } catch { /* 已终止 */ } resolve() }, graceMs)
      const prev = this.waiter
      this.waiter = (line) => { void line; clearTimeout(t); this.waiter = prev; resolve() }
    })
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line !== '') {
        if (this.waiter !== null) {
          const w = this.waiter
          this.waiter = null
          w(line)
        } else {
          this.queue.push(line)
        }
      }
      idx = this.buffer.indexOf('\n')
    }
  }

  private readLine(timeoutMs: number): Promise<string | null> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.dead) return Promise.resolve(null)
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { if (this.waiter === resolve) this.waiter = null; resolve(null) }, timeoutMs)
      this.waiter = (line) => { clearTimeout(timer); resolve(line) }
    })
  }

  private resolveWaiter(line: string | null): void {
    const w = this.waiter
    if (w !== null) { this.waiter = null; w(line) }
  }
}

/** 离线探针 / 测试用的 spawner（node:child_process）。宿主请用 ctx.subprocess 适配器。 */
export function spawnerFromChildProcess(create: (argv: readonly string[]) => ChildLike | null): ChildSpawner {
  return create
}
