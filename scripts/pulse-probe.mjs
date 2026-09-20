/**
 * @dsh-external/dsh-nautilus — pulse 离线验收器（不经宿主；Phase 1 证据链的执行入口）。
 *
 * 用法：
 *   node scripts/pulse-probe.mjs [--ticks N] [--intervalMs N] [--minutes M] [--db <file>] [--json] [--no-counters] [--no-gpu]
 * 前置：`npm run build`（读 lib/pulse/*.js）。
 *
 * 与宿主路径的差别（必须随读数一起引用）：
 *   · 子进程走 `node:child_process`（宿主里走 `ctx.subprocess` seam）；
 *   · 本地族口径完全一致（同一份 lib/pulse/collect.js）；
 *   · 默认写**临时库**（--db 可指向真实库），故本器不污染 ~/.dsh/nautilus/nautilus.db。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectGpu, collectLocal, cpuTimes, LAYER } from '../lib/pulse/collect.js'
import { CountersSession } from '../lib/pulse/counters.js'
import { spawn } from 'node:child_process'
import { openPulseStore } from '../lib/pulse/store.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const has = (name) => argv.includes('--' + name)

const intervalMs = Number(flag('intervalMs', 5000))
const minutes = Number(flag('minutes', 0))
const ticks = minutes > 0 ? Math.max(1, Math.round((minutes * 60000) / intervalMs)) : Number(flag('ticks', 6))
const jsonOut = has('json')
const tmp = has('db') ? null : mkdtempSync(join(tmpdir(), 'pulse-probe-'))
const dbFile = has('db') ? flag('db') : join(tmp, 'probe.db')

const exec = (a, timeoutMs) => new Promise((resolve) => {
  const child = execFile(a[0], a.slice(1), { timeout: timeoutMs, maxBuffer: 1 << 22, windowsHide: true }, (err, stdout, stderr) => {
    resolve({
      stdout: String(stdout ?? ''),
      exitCode: err === null ? 0 : (typeof err.code === 'number' ? err.code : null),
      signal: err !== null && err.killed === true ? 'SIGTERM' : null,
      timedOut: err !== null && err.killed === true,
    })
  })
  child.on('error', () => resolve({ stdout: '', exitCode: null, signal: null, timedOut: false }))
})

// 计数器族：常驻助手（与宿主同一条代码路径，只是子进程由 node:child_process 起）
const spawner = (a) => {
  try {
    const p = spawn(a[0], a.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    return {
      write: (t) => { try { p.stdin.write(t) } catch { /* 管道已断 */ } },
      onStdout: (cb) => { p.stdout.on('data', (b) => cb(String(b))) },
      onExit: (cb) => { p.on('close', () => cb()); p.on('error', () => cb()) },
      closeStdin: () => { try { p.stdin.end() } catch { /* 已断 */ } },
      terminate: () => { try { p.kill() } catch { /* 已退出 */ } },
    }
  } catch { return null }
}
const counters = has('no-counters') ? null : new CountersSession(spawner, '')
const warm = counters === null ? false : await counters.start(10000)
if (!has('no-counters') && !jsonOut) console.log('计数器助手：' + (warm ? '已就绪（' + counters.stats().shell + '）' : '启动失败（该族缺席）'))

const store = openPulseStore(dbFile)
const rssStart = process.memoryUsage().rss
let prevCpu = cpuTimes()
let prevUsage = process.cpuUsage()
let lastCountersTs = 0
let lastGpuTs = 0
const stats = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < ticks; i++) {
  const started = Date.now()
  const samples = []
  const now = cpuTimes()
  const usage = process.cpuUsage()
  const elapsed = i === 0 ? intervalMs : started - (started - intervalMs)
  samples.push(...collectLocal(i === 0 ? null : prevCpu, now, { user: usage.user - prevUsage.user, system: usage.system - prevUsage.system }, elapsed, process.memoryUsage().rss))
  prevCpu = now
  prevUsage = usage
  let countersMs = 0
  let gpuMs = 0
  if (!has('no-counters') && started - lastCountersTs >= 15000) {
    lastCountersTs = started
    const t = Date.now()
    if (counters !== null) samples.push(...(await counters.sample(8000)))
    countersMs = Date.now() - t
  }
  if (!has('no-gpu') && started - lastGpuTs >= 10000) {
    lastGpuTs = started
    const t = Date.now()
    samples.push(...(await collectGpu(exec, 8000)))
    gpuMs = Date.now() - t
  }
  store.insert(started, LAYER, samples)
  for (const s of samples) {
    const cur = stats.get(s.metric) ?? { n: 0, min: Infinity, max: -Infinity, last: 0 }
    cur.n += 1
    cur.min = Math.min(cur.min, s.value)
    cur.max = Math.max(cur.max, s.value)
    cur.last = s.value
    stats.set(s.metric, cur)
  }
  const rss = process.memoryUsage().rss
  if (jsonOut) {
    console.log(JSON.stringify({ tick: i + 1, ts: started, samples: samples.length, countersMs, gpuMs, rss, metrics: samples.map((s) => s.metric) }))
  } else {
    console.log('[tick ' + (i + 1) + '/' + ticks + '] samples=' + samples.length + ' counters=' + countersMs + 'ms gpu=' + gpuMs + 'ms rss=' + (rss / 1048576).toFixed(1) + 'MB ' + samples.map((s) => s.metric.replace('pulse.', '') + '=' + s.value.toFixed(2)).join(' '))
  }
  if (i + 1 < ticks) await sleep(intervalMs)
}

const rssEnd = process.memoryUsage().rss
if (counters !== null) await counters.close()
const status = store.status()
store.close()
if (tmp !== null) { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录 */ } }

if (jsonOut) {
  console.log(JSON.stringify({ summary: { dbFile, ticks, rows: status.rows, metrics: status.metrics.map((m) => ({ metric: m.metric, rows: m.rows })), rssStart, rssEnd } }))
} else {
  console.log('\n== 汇总 ==')
  console.log('库：' + dbFile + '（探针默认临时库，已清理）')
  console.log('落库行数：' + status.rows + '，指标族数：' + status.metrics.length)
  for (const m of status.metrics) {
    const s = stats.get(m.metric)
    console.log('  ' + m.metric.padEnd(28) + ' n=' + String(m.rows).padStart(3) + '  last=' + (s === undefined ? '-' : s.last.toFixed(2)) + '  min=' + (s === undefined ? '-' : s.min.toFixed(2)) + '  max=' + (s === undefined ? '-' : s.max.toFixed(2)))
  }
  console.log('RSS：' + (rssStart / 1048576).toFixed(1) + 'MB → ' + (rssEnd / 1048576).toFixed(1) + 'MB')
}
