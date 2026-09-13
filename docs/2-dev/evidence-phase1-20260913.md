# 证据归档 · Phase 1（pulse OS/GPU 层）

> 配套文档：[./nautilus-dev-03-os-layer.md](./nautilus-dev-03-os-layer.md)
> **环境四元组**：dsh `0.1.5-rc.2` · profile `web`（**本层尚未装配**——证据走离线探针，端上装配见 §E8）· 运行方式：Node 直调 `lib/pulse/*`（不经宿主）· Windows 11 / Windows PowerShell 5.1（**本机无 pwsh**）/ RTX 5060 Laptop 8GB / Node v24.18.0
> 归档纪律：执行命令 / 预期 / 实际 / 观察结论；**只读验收**（数据写入探针临时库或 `$TEMP`，不污染 `~/.dsh/nexus/nexus.db`）。

---

## E1 交付与门禁

**命令**：`npm run typecheck && npm run build && npm test && npm run check:deps && npm run check:exports && node .github/scripts/check-meta.mjs`

**预期**：全绿；`lib/pulse/*.js` 产出齐全。

**实际**：typecheck 0 · build 0（`lib/pulse/{collect,counters,store,routes,index}.js` + client 重建）· test **18/18**（新增 6 例 pulse 用例）· check:deps OK · check:exports OK · check-meta OK。

**观察结论**：新增插件行未破坏任何既有门禁；`check-meta` 的「patch 必须按包名引用」对新行同样成立。

---

## E2 本地族首采（零依赖通道）

**命令**
```js
const { collectLocal, cpuTimes } = require('./lib/pulse/collect.js')
const t0 = cpuTimes(); setTimeout(() => console.log(collectLocal(t0, cpuTimes(), {user:0,system:0}, 1000, process.memoryUsage().rss)), 600)
```

**实际**：`cpu.utilization=0.18` · `mem.used=13178855424` · `mem.total=16890322944` · `proc.dsh.rss=65073152` · `proc.dsh.cpu=0`（标签 `{host:'Xuegulin'}`、进程族带 `pid`）。

**观察结论**：本地族零依赖、零子进程、单 tick <1 ms；进程级指标即宿主进程（插件在宿主进程内运行）。

---

## E3 离线探针整轮（15 条序列 / 6 族）

**命令**：`node scripts/pulse-probe.mjs --ticks 4 --intervalMs 4000`

**实际（汇总）**
```
计数器助手：已就绪（powershell）
落库行数：34，指标族数：15
pulse.cpu.ctx_switches  n=1  last=29411
pulse.cpu.utilization   n=3  last=0.12  min=0.11  max=0.17
pulse.disk.io_rate      n=1  last=963049
pulse.disk.queue        n=1  last=0
pulse.gpu.mem.used      n=2  last=1449   (total 8151 MiB)
pulse.gpu.power         n=2  last=22.25  (W)
pulse.gpu.temp          n=2  last=59     (°C)
pulse.gpu.util          n=2  last=6      (%)
pulse.mem.swap.used     n=1  last=3304062976
pulse.mem.used          n=4  last=13947011072
pulse.net.io_rate       n=1  last=0
pulse.proc.dsh.cpu      n=4  last=0
pulse.proc.dsh.rss      n=4  last=68444160
RSS：64.6MB → 65.3MB
```

**预期**：≥6 类指标、≥3 条时间序列即可通过 Phase 1 验收。

**观察结论**：**6 族 15 条序列全部落库**（CPU/内存/交换/磁盘/网络/进程/GPU），超出验收下限；采样粒度按设计（本地族每 tick、计数器 15 s、GPU 10 s）。

---

## E4 计数器通道成本（本层最关键的实测）

**命令**：`Measure-Cmd`（`Start-Process -PassThru -Wait` 取子进程 `TotalProcessorTime`）分别跑「一次性 CIM 脚本」「一次性 Get-Counter 变体」；会话内成本用同一 PowerShell 进程连跑 3 次取每次差值。

**实际**

| 通道 | wall/次 | CPU/次 |
|---|---|---|
| 一次性 `powershell -Command`（CIM 版） | 3292 / 3024 ms | **2891 / 2859 ms** |
| 一次性 `Get-Counter` 变体 | 3078 / 3020 ms | **3047 / 2828 ms** |
| **常驻会话内查询**（预热后） | 889 / 897 ms | **31 / 16 ms** |

**预期**：D1 设定的回退线是「5 s tick 采集 > 单核 2% 则降级到 systeminformation」。

**观察结论**：一次性进程的开销由「解释器启动 + CIM 模块自动加载」主导（首次会话内查询单独计 688 ms CPU 即为证据），**与查询内容几乎无关**；按 15 s 周期，一次性通道 ≈ 单核 19%（**超线**），常驻助手 ≈ **0.2%**（**达标**）。故本层采用常驻助手，并把该结论写进开发文档 §3.2。

---

## E5 内存稳定性（Phase 1 验收：连续 1 小时无内存增长）

**命令**：`node scripts/pulse-probe.mjs --minutes 60 --intervalMs 5000 --json --db %TEMP%\pulse-soak3.db`

**中间检查（前 7 tick / 约 35 s）**：RSS 65.4 → 64.7 → … → 65.1 MB（min 64.7 / max 65.4，**无单调增长**）；`samples/tick` 交替 5/10/15（本地 + GPU + 计数器到点）符合设计。

**状态**：⏳ **1 小时档运行中**——完成后回填完整 RSS 序列与结论（本文件随后续提交更新）。

---

## E6 软失败路径

| 场景 | 命令 | 预期 | 实际 |
|---|---|---|---|
| 无 GPU 工具 / 无 N 卡 | `collectGpu(exec, 3000, 'no-such-smi-binary')` | 0 样本，不抛错 | ✅ `样本数 0` |
| 计数器助手起不来 | 探针 `--no-counters` | 12 条序列（少 5 条），其余族正常 | ✅（E3 前一轮实测：无助手时 10 族，其余族不受影响） |
| 库未到 v3 | 新库打开 | 建表、不推进版本、不报错 | ✅ 见 E7 |

**观察结论**：三处失败都是**该族缺席**而非报错或 0 值——与 §4.2「缺席即缺席」口径一致（R5/R8 的降级口径）。

---

## E7 存储与迁移（单测 + 手测）

**命令**：`npm test`（pulse 用例）+ 手工核对 `PRAGMA user_version`

**实际**
- 全新库（v0）：打开后 `schemaVersion()=0`（**不抢版本**）、`metric_sample` 已建、重复打开仍为 0（幂等）；
- 预置 `user_version=3` 的库：打开后 `schemaVersion()=4`，再开仍 4；
- `insert/latest/series(桶均值)/prune` 行为符合预期（prune 删 3 行 → 剩 1 行）；
- `close()` 在语句未 GC 时可能抛错：已改为**记警告而非静默吞掉**（Windows + WAL 下表现为文件句柄滞留；为测试可见性而暴露）。

**观察结论**：迁移语义正确且不越权推进共享版本号；**副作用已登记**——M5 设计文档原预留的 v4（`call_p`）顺延为 v5。

---

## E9 端上装配实测（2026-09-13，热装配）

**命令**：在 profile `web` 的 `cordis.patch.yml` 用户层插入 pulse 行（绝对路径 + `patchReload: live`），保存后等待 25 s，再读库与 API：

```yaml
- insert:
    - id: nexus
      name: 'L:/dsh-nautilus/lib/index.js'
    - id: pulse
      name: 'L:/dsh-nautilus/lib/pulse/index.js'
```

**环境四元组**：dsh `0.1.5-rc.1`（运行中的宿主）· profile `web` · 装配方式 = **patch 热装配（用户层 insert 绝对路径）** · 结果 **通过**

**实际（真实库 `~/.dsh/nexus/nexus.db`，只读查询）**
```
tables: annotation,edit_event,lfield_config,metric_sample,session_root,step_seen,turn_read,turn_text,vault_config,vault_meta
user_version: 4
metric_sample: rows=69  first=2026-09-13T03:38:17.900Z  last=2026-09-13T03:38:52.905Z
metrics: cpu.ctx_switches(3) cpu.utilization(7) disk.io_rate(3) disk.queue(3) gpu.mem.total(4) gpu.mem.used(4)
         gpu.power(4) gpu.temp(4) gpu.util(4) mem.swap.used(3) mem.total(7) mem.used(7) net.io_rate(3)
         proc.dsh.cpu(6) proc.dsh.rss(7)
nexus 侧 turn_read: 446（最新 2026-09-13T03:38:55Z，未受影响）
```

**API（带 `Origin` 头过同源守卫）**
- `GET /api/nexus/pulse/state` → **200**；`collector: ticks=5 shell=powershell countersOk=True gpuOk=True execAvailable=True`；`db.rows=49`（当时）`schemaVersion=4`；15 条 latest 值齐全。
- `GET /api/nexus/m2/state`（nexus 面板）→ **200**，同步核对：patch 重载未影响既有插件。

**观察结论**
1. 宿主路径全链路成立：**`ctx.subprocess` seam 可用**（`execAvailable=True`）、计数器助手在宿主内起的是 `powershell`、GPU 族在场。
2. pulse 与 nexus 同库共存、互不干扰（`user_version` 已为 4，nexus 的 turn 采集持续增长）。
3. **遗留（必须收口）**：本次是热装配例外，重启前要按 CONTRIBUTING 工程红线 5 收敛为 `dsh plugin --profile web add`，否则 patch 层与 bundle 层同 `id` 双挂载（`webServer.register` 对重复 `(kind,path)` 直接抛错）。

---

## E8 诚实边界（引用本归档时必须一并引用）

1. **未经宿主**：本层尚未装配进 profile（无 `id: pulse` patch 行），全部证据来自离线探针；宿主路径的差异只有「子进程经 `ctx.subprocess` 起」——同一份 `lib/pulse/*`，尚无端上四元组读数（OQ-3）。
2. **单机单卡**：GPU 族仅在本机一张 RTX 5060 Laptop 上验证；无卡/多卡的解析路径只有单测覆盖（无真实无卡环境）。
3. **1 小时档未回填**：E5 目前是中间读数（35 s），Phase 1 的「连续 1 小时无内存增长」尚未给出完整序列。
4. **Windows 专属**：计数器族依赖 PowerShell + CIM；非 Windows 下该族缺席（本地族仍可采），未在 Linux/macOS 上验证。
5. **探针写临时库**：默认库是 `%TEMP%` 下的临时文件，与 `~/.dsh/nexus/nexus.db` 的结构一致但**不是**同一个库；端上装配后的读数需重新采集。
6. **采样成本只测了 CPU 与 wall**：未测内存占用增量与磁盘/网络 IO 增量（soak 的 RSS 序列部分覆盖内存）。
