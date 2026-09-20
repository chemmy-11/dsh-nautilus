# 证据归档 · Phase 0

> **命名说明（2026-09-20 追加）**：本归档成文时插件名为 `dsh-nexus`（包 `@dsh-external/dsh-nexus`）、路由前缀 `/api/nexus/*`、数据目录 `~/.dsh/nexus/`、Loader 条目 `id: nexus`；同日全仓库统一改名为 **nautilus**（包 `@dsh-external/dsh-nautilus`、`/api/nautilus/*`、`~/.dsh/nautilus/`、`id: nautilus`）。**下文命令与原始输出保留当时原文**（证据不可改写），阅读时按上述对照。旧数据目录由 `src/home.ts` 的改名迁移自动搬迁（只在新缺失时执行）。
（2026-09-12）

> 配套文档：[./nautilus-dev-01-phase0.md](./nautilus-dev-01-phase0.md)
> 归档纪律（沿用仓库惯例）：执行命令 / 预期输出 / 实际输出 / 观察结论四段式；**只读核查**——本轮除本仓库 `docs/` 外未改动任何文件，未触碰 vault、未改动 dsh profile。
> 环境：Windows · Node `v24.18.0` · dsh `0.1.5-rc.1` · nexus 库 `~/.dsh/nexus/nexus.db`（schema v3）

---

## E1 观测库现状（采集是否在跑）

**命令**

```js
// node:sqlite 直读 ~/.dsh/nexus/nexus.db
db.prepare('SELECT (SELECT COUNT(*) FROM turn_read) turns, (SELECT COUNT(DISTINCT session) FROM turn_read) sessions, ...')
```

**实际输出**

```json
{ "turns": 427, "sessions": 70, "texts": 507, "meta": 114, "edits": 229, "annos": 8 }
{ "root": "L:\\L_workspace\\weixin-connect\\LinsLive\\L-theory", "active": 1, "last_scan_ts": null }
```

**观察结论**：服务端半在跑（本轮会话 turn 1 已落库）；相对 M4 文档 §17 的「16:17 停顿前」快照（404 轮 / 60 会话），两日净增 23 轮 / 10 会话。运行通道仍是 profile `web` 的 `insert id=nexus` 绝对路径热挂载（**临时通道，待收敛**，见 M4 §17 遗留 1）。

---

## E2 仓库门禁复跑（当前分支 `feat/m4-11-two-views`）

| 命令 | 预期 | 实际 |
|---|---|---|
| `npm run typecheck` | 无输出、exit 0 | ✅ exit 0 |
| `npm test` | 12 用例全过 | ✅ `pass 12 / fail 0`（157.8 ms） |
| `node scripts/p-measure.mjs --selftest` | 5/5 | ✅ `selftest 5/5` |
| `node scripts/p-measure.mjs --vault` | 出曲线 | ✅ 3 会话 / 163 调用，P_text 均值 **0.331**（P_args 0.296） |

**观察结论**：M4.11 分支门禁全绿；M5 运行器管线仍可跑通。注意 `--vault` 现样本为 3 会话，与《纯度P首轮读数》的 9 会话 / 684 调用**不是同一集合**，两者不可直接比较。

---

## E3 宿主事件字段核查（TTFT / model / endpoint 的可得性来源）

**来源一：宿主会话事件词表**（官方文档 `dsh-docs/subsystems/session.zh.md`，857 行）

- `SessionEventMap` 12 类：`turn/start`·`turn/end`·`step/start`·`step/end`·`user/message`·`assistant/chunk`·`assistant/message`·`tool/call`·`tool/result`·`todo/write`·`request/header`·`request/context`（+`session/end-seed`）。
- `assistant/message`：`{turn, step, message, usage?, interrupted?}`，`usage` 与消息同体（无独立 usage 记录）。
- `request/header`：`EpochHeader` = 调用配置 + 系统提示词 + 工具 schema；**最新快照可重建请求**。

**来源二：持久化事件信封**（`dsh-docs/persistence-catalog.zh.md`）

```ts
type SessionEvent = { type, seq, time /* epoch ms */, data, ignorable?, sourceEventSeqs?, surfaceOp? }
```

**来源三：真实日志实测**（`~/.dsh/sessions/**/session.v3.jsonl.zstd`）

```
events: 885   events with numeric time: 884 / 885（唯一例外是首条 session 头，用 createdAt）
event keys: ["type","seq","time","data","surfaceOp"]
request/header.header.config = {provider:"opencode-go", model:"deepseek-flash", reasoningEffort:"max", maxTokens:384000}
request/context = {provider:"opencode-go", model:"deepseek-flash", contextWindow:1000000}
assistant/message.data keys = ["turn","step","message","usage","stream"]
assistant/message.message.source = {kind:"model", provider:"opencode-go", model:"deepseek-flash", replayState:{...}}
assistant/message.usage = {inputTokens, outputTokens, totalTokens, cacheReadTokens}
```

**观察结论**：① 每个事件都带 epoch 毫秒 `time`；② `assistant/message` 额外带 **`stream`（带精确时间的流）**；③ provider/model 逐调用可得。**注意：日志里没有顶层 `assistant/chunk`**——按 `dsh-session-format-v1-to-v2` 的说明，顶层 chunk 已被**内嵌**进对应 `assistant/message` 的 `stream` 字段。

---

## E4 TTFT 全量测量（核心证据）

**复现脚本**（`ttft-survey.mjs`，只读）

```js
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function sessionText (file) {                       // 多帧 zstd：单次调用只解第一帧，必须按 magic 切帧
  const buf = readFileSync(file); const idx = []; let p = 0
  while ((p = buf.indexOf(MAGIC, p)) !== -1) { idx.push(p); p += 4 }
  if (!idx.length) return ''
  if (idx.length === 1) return zstdDecompressSync(buf).toString('utf8')
  const parts = []
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(idx[k], end)).toString('utf8')) } catch {}
  }
  return parts.join('')
}
function walk (dir, acc = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) walk(p, acc)
    else if (d.name === 'session.v3.jsonl.zstd') acc.push(p)
  }
  return acc
}
const files = walk(process.argv[2]).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
let nSessions = 0, nCalls = 0, nWithStream = 0, nNoStream = 0
const ttfts = [], models = {}
for (const f of files) {
  let evs
  try { evs = sessionText(f).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { continue }
  if (!evs.length) continue
  nSessions++
  const starts = new Map()
  for (const e of evs) if (e.type === 'step/start') starts.set(e.data.turn + '/' + e.data.step, e.time)
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    nCalls++
    const st = e.data?.stream
    const has = Array.isArray(st) && st.length > 0
    if (has) nWithStream++; else nNoStream++
    const src = e.data?.message?.source
    const key = (src?.provider ?? '?') + '/' + (src?.model ?? '?')
    models[key] = (models[key] || 0) + 1
    if (has) {
      const first = st.find(x => typeof x?.time === 'number')
      const t0 = starts.get(e.data.turn + '/' + e.data.step)
      if (first && t0 !== undefined) ttfts.push(first.time - t0)
    }
  }
}
ttfts.sort((a, b) => a - b)
const q = (p) => ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(ttfts.length * p))] : null
console.log('session files found =', files.length, ' parsed =', nSessions)
console.log('assistant/message =', nCalls, ' 带内嵌 stream =', nWithStream, ' 无 stream =', nNoStream)
console.log('TTFT n=' + ttfts.length, JSON.stringify({ min: ttfts[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: ttfts[ttfts.length - 1] }))
console.log('models:', JSON.stringify(models))
```

**执行**

```bash
node ttft-survey.mjs "%USERPROFILE%\.dsh\sessions"
```

**预期**：若 TTFT 只能实时采集，则绝大多数历史调用应**无** `stream` 字段。

**实际输出**

```
session files found = 18  parsed = 18
assistant/message = 783  带内嵌 stream = 783  无 stream = 0
TTFT n=783 {"min":448,"p50":3067,"p90":9275,"p99":26313,"max":32101}
models(provider/model -> calls): {"tokenrhythm/deepseek-flash":331,"opencode-go/deepseek-flash":300,"deepseek-official/deepseek-flash":152}
```

**stream 内部结构抽样**（同一会话，23 段）

```json
{"type":"chunk","time":1789045668816,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}
{"type":"reasoning-chunks","time0":1789045668816,"index":0,"dt":[53,16,1,0,...],"texts":["We"," need",...]}
{"type":"chunk","time":1789045669644,"chunk":{"type":"finish","reason":{"kind":"tool-calls"}, ...}}
```

**观察结论**：**TTFT 全量可得，含历史回填**（预期被证伪）；且除首块绝对时间外还有 `time0 + dt[]` 增量数组——解码曲线可做到逐块粒度，比只取首尾时间更细。

---

## E5 宿主自身的 TTFT 口径（源码即定义）

```js
// @deepseek-ai/dsh-client-ui-chat/lib/client.js
:3790  ttftMs: timing !== void 0 && timing.stepStartTime !== null && timing.firstTokenTime !== null
         ? Math.max(0, timing.firstTokenTime - timing.stepStartTime) : null,
:3791  decodeMs: timing !== void 0 && timing.firstTokenTime !== null
         ? Math.max(0, timing.completedTime - timing.firstTokenTime) : null,
:3798  // TTFT is the turn's lowest-step request-dispatch-to-first-token reading
:4465  ...firstToken && state.firstTokenTime === void 0 ? { firstTokenTime: time } : {}
:4497  stepStartTime: context.start?.event.time ?? null,
:4499  completedTime: event.time   // event = assistant/message
```

```js
// @deepseek-ai/dsh-client-connection/lib/client.js
:3069  value.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime)
:3073  value.decodeMs += Math.max(0, event.time - openStep.firstTokenTime)
```

**观察结论**：宿主 GUI 的「记录表 / 助手时间条」显示的就是这条读数（`stats.dialog.ttft`、`message.turnTime.ttft`），turn 级取最低 step。我方口径与之**同源同式**，无需自创定义。

---

## E6 遥测 seam 与 OTLP 成本

**本机实测（包存在性）**

```
@deepseek-ai/dsh/node_modules/@deepseek-ai/ 下：
  dsh-session-telemetry
  dsh-session-telemetry-otel
```

**契约要点**（官方文档 `dsh-docs/subsystems/session-telemetry.zh.md`）

> 「每个 `(turn, step)` 只发出第一条 `assistant/chunk`，即『流已开始』的信号；其余分片在捕获时丢弃……接收端对 ledger 记录基于 `(session.id, event.seq)` 去重。」

**OTLP 最小成本（npm registry `dist.unpackedSize`，调研于 2026-09-12）**

| 包 | 版本 | 解压体积 |
|---|---|---|
| `@opentelemetry/api` | 1.9.1 | 1.0 MB |
| `@opentelemetry/sdk-metrics` | 2.11.0 | 1.8 MB |
| `@opentelemetry/resources` / `core` | 2.11.0 | 0.44 / 0.58 MB |
| `exporter-metrics-otlp-proto` / `-http` | 0.222.0 | 0.07 / 0.12 MB |
| `otlp-transformer` / `otlp-exporter-base` | 0.222.0 | 1.05 / 0.65 MB |
| `semantic-conventions` | 1.43.0 | **12.0 MB** |
| 合计 | — | **≈18.5 MiB** |

零依赖替代：OTLP/HTTP 规范允许 JSON 编码（须 `Content-Type: application/json`，64 位整数用十进制字符串），内置 `fetch` 可直发 `resourceMetrics` → 零 npm 依赖。

**观察结论**：R10（OTLP 兼容）不必现在动工；真要动工时**优先零依赖 JSON 路径**或复用 loongsuite 的 MeterProvider，不引官方 SDK（18.5 MiB 与「零依赖」纪律和 R6 的体积关注都冲突）。

---

## E7 OpenLIT GPU 管线纠偏

**检索范围**：`openlit/openlit` 仓库的 Go 收集器（`internal/gpu/**`、`internal/discovery/**`、`internal/export/**`、`cmd/collector/main.go`）与 Python SDK（`sdk/python/.../instrumentation/gpu/__init__.py`），grep `exec.Command|nvidia-smi` → **0 命中**。

**实际实现**

```python
import pynvml
...
elif metric_name == "utilization":
    return pynvml.nvmlDeviceGetUtilizationRates(handle).gpu   # Python SDK：pynvml
```

Go 侧走 go-nvml（Windows 载入 `nvml.dll`）；轮询沿用 `OTEL_METRIC_EXPORT_INTERVAL`（默认 60000 ms）；指标族 `hw.gpu.utilization` / `hw.gpu.memory.utilization` / `hw.gpu.memory.{limit,usage,free}` / `hw.temperature` / `hw.power` / `hw.energy` / `hw.gpu.speed` / `hw.fan.speed_ratio` / `hw.status` / `hw.errors`，属性 `hw.id / hw.name / hw.vendor / gpu.index / gpu.pci_address`。

**降级姿态**：发现不到 GPU → `No GPU detected, skipping GPU metrics collection`（Go 侧 `nvidia_stub.go` 软失败），主机指标照常导出，每 30 s 重试发现。

**观察结论**：1-planning 的「OpenLIT 走 nvidia-smi」表述**应回写修正**；可借鉴项改为**命名/属性**与**无卡软失败**，实现参照改为 NVML（nvitop / DCGM 口径）。

---

## E8 硬件与推理栈可行性（D3 现场核查）

```
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
  → NVIDIA GeForce RTX 5060 Laptop GPU, 8151 MiB, 616.64
wsl --status → 默认发行版 Ubuntu-24.04（版本 2）
CPU = Intel(R) Core(TM) i7-14650HX  cores=16 / 24 线程   RAM = 15.7 GB
磁盘：C: 285/15 GB（已用/可用）· D: 433.6/138 GB · L: 1.5/50.4 GB
```

**观察结论**：有 N 卡（pulse 的 GPU 族在本机**不缺席**）；WSL2 可用（vLLM 有承载路径）；但 **C 盘仅余 15 GB** 是本地模型落地的硬约束（权重缓存须改路径）。8 GB 显存决定模型档位（7–8B 量化）。

---

## 复核清单（下次引用本归档前）

1. `stream` 字段覆盖率是否仍是 100%（宿主升版可能改变日志格式）→ OQ-P0-3
2. `nvidia-smi --query-gpu` 字段与刷新语义实测 → OQ-P0-4
3. `p-measure --vault` 样本集合变化（3 会话 vs 首轮 9 会话）——引用 P 读数时必须同时给出样本口径
