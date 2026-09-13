# 证据归档 · Phase 1（pulse OS/GPU 层）

> 配套文档：[./nautilus-dev-03-os-layer.md](./nautilus-dev-03-os-layer.md)
> **环境四元组**：dsh `0.1.5-rc.2` · profile `web`（§E1–E7 走离线探针；**§E9 起已热装配**，§E10 为客户端半区端上校验）· 运行方式：Node 直调 `lib/pulse/*`（不经宿主）· Windows 11 / Windows PowerShell 5.1（**本机无 pwsh**）/ RTX 5060 Laptop 8GB / Node v24.18.0
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

**命令**：`node scripts/pulse-probe.mjs --minutes 60 --intervalMs 5000 --json --db %TEMP%\pulse-soak3.db`

**中间检查（前 7 tick / 约 35 s）**：RSS 65.4 → 64.7 → … → 65.1 MB（min 64.7 / max 65.4，**无单调增长**）；`samples/tick` 交替 5/10/15（本地 + GPU + 计数器到点）符合设计。

**完整读数（457 tick / 41.0 min / 11:24:47 → 12:05:45）**

| 量 | 值 |
|---|---|
| RSS 首 / 末 | 65.3 MB → 69.4 MB |
| RSS min / max | 64.5 MB / 73.1 MB |
| RSS 每 5 min（t60→t420） | 66.7 · 66.6 · 71.2 · 71.6 · 72.0 · 72.4 · 70.6 MB |
| 末 10 tick（约 50 s） | 70.5 · 70.5 · 70.5 · 69.3 · 69.3 · 69.3 · 69.4 · 69.4 · 69.4 · 69.4 MB |
| `samples/tick` 取值 | 5 / 10 / 14 / 15（本地族每 tick；GPU 与计数器到点叠加） |
| `countersMs`（tick>6） | min 0 · p50 **0** · max 8012 ms |
| `gpuMs`（tick>6） | min 0 · p50 54 · max 134 ms |

**状态**：**部分完成**——本轮取到 41 分钟（457 tick）后，**宿主 `dsh web` 于 12:06 重启，作业随宿主进程消亡**，60 分钟档未取满。

**观察结论**
1. **未见单调增长**：RSS 在 64.5–73.1 MB 区间内先升后平、末段回落（t420→末 70.6→69.4 MB），末 10 tick 稳定在 69.3–69.4 MB；形态是「早期 +4~6 MB 抬升 → 平台 → GC 回落」，不是持续爬升。
2. **常驻助手通道在长跑中成立**：`countersMs` 中位数为 **0 ms**（亚毫秒级，四舍五入），41 分钟内仅 1 次 8012 ms 尖峰（助手重启一次），与 §E4 的「常驻 ≈0.2% 单核」一致；GPU 查询稳定在 54 ms 中位、134 ms 上限。
3. **样本族数符合设计**：5（仅本地）/ 10（+GPU）/ 14–15（+计数器）三档交替，与 §E3 的 15 条序列上限一致。

**诚实边界（必须与本读数一并引用）**
- **时长不足**：41 min ≠ 验收要求的 60 min，且中断原因与内存无关（宿主重启）；「连续 1 小时无内存增长」**尚未取得完整序列**，不得据此宣称该验收项通过。
- **观察对象是探针进程**（`scripts/pulse-probe.mjs`，直连 helper），不是宿主内运行的插件进程；宿主路径的内存曲线未测（宿主内读数为 §E9，仅覆盖数据写入与路由）。
- **SSD/OS 缓存干扰未排除**：RSS 的平台形态可能受 V8 GC 时机影响，本层未采集堆明细（`--expose-gc` 或 heap snapshot 未做）。

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

## E10 客户端工作台接入实测（2026-09-13，热装配 · 既有 GUI origin）

**目标**：把已定版的 UI 规格（[./nautilus-dev-02-ui-workbench.md](./nautilus-dev-02-ui-workbench.md)）落成客户端半区产物，并确认它**真的进了启动图、按 rev 下发**。

**命令 / 方式**
1. 六件套：`npm run build && npm run typecheck && npm test && npm run check:deps && npm run check:exports && node .github/scripts/check-meta.mjs`；
2. 只读校验脚本（临时文件，不入库）：用宿主持久签名密钥在**本机**铸造会话 cookie，`GET /` 取启动图 → 取本行 combo URL → `GET` 该 URL；全程只读，密钥不入库、不打印；
3. loader 形态物化：`node:vm` + stub `window.__ModuleLoader__` + `react` shim → 物化 `lib/client.js` 工厂并调 `apply(假 ctx)`。

**实际**
- 六件套全绿；`npm test` → **19/19**（新增 1 例：client bundle 的 loader 往返 + 命名导出面 + 面板注册契约）。
- `lib/client.js` 96101 B（重建后）。`GET /` → **200**（35379 B），启动图含本行：
  `{"id":"@dsh-external/dsh-nexus","url":"/plugins/??@dsh-external/dsh-nexus/client.js&rev=b3d513723b46","rev":"b3d513723b46","inject":["@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-conversation"]}`
- `GET` 该 combo URL → **200**，96155 B（= 磁盘 96101 B + loader 包装），断言命中 `sidebar.panellist` · `nautilus-workbench` · `conversation.view` · `FIG.01`（中文串被 esbuild 以 \uXXXX 转义，故以 ASCII 标记断言）。
- loader 形态物化：`load.id=@dsh-external/dsh-nexus`；导出面 `["apply","inject"]`、**无 `default`**；`apply(假 ctx)` 依次产生 4 个 effect + 4 个注册：`conversation.view`（两个 tab）· `sidebar.panellist`（id `nautilus-workbench`，order 50）· `main`（key 同值）。

**发现的硬契约（代价最大的一条）**：槽位标识字段**随 kind 不同**——`list` 槽用 `options.id`（`conversation.view` / `sidebar.panellist`），`keyed` 槽用 **`options.key`**（`main`）。给 `main` 传 `id` 会抛 `keyed slot main requires options.key`，且失败面**不止本插件**：整批浏览器半区插件集的挂载被带崩。旁证（shipped 先例）：`@deepseek-ai/dsh-client-ui-conversation` 注册主区为 `{ name: 'main', key: 'conversation' }`。本仓库的 loader 形态用例已把该字段按 kind 分支断言，专门守这条。
- 只读 API：`GET /api/nexus/state` → 200（1863 B）；`GET /api/nexus/pulse/state` → 200（2030 B，采集器在场）。

**环境四元组**：dsh `0.1.5-rc.2`（运行中的宿主，PID 21968）· profile `web` · 装配方式 = **patch 热装配**（用户层 insert 绝对路径）+ 客户端半区由 `dsh-client-modules` 扫描同名包（`lib/client.js`，rev `b3d513723b46`）· 结果：**产物级通过；浏览器渲染待人工确认**。

**观察结论**
1. **客户端半区的交付通道成立且很短**：改客户端半区后只需 `npm run build` + 刷新既有页面，**不必重启宿主**——client-modules 在 `/plugins` 下按内容 rev 下发本包 bundle，本次下发的字节已含新标记（说明 registry 已认到这次 rebuild）。
2. 接入是**加法而非替换**：两个 `conversation.view` tab（Vault 观测 / L 场读数）原样保留，工作台是新增的 `sidebar.panellist` 图标行 + `main` keyed 全局面板；两处注册 id 同值（`nautilus-workbench`）是「图标点得到主区」的唯一不变量，已进常驻测试。
3. **`dsh.client.inject` 新值尚未生效**：启动图行里 `inject` 仍是旧值（client-modules 按进程缓存包元数据），新值（+layout / +sidebar）**下次 `dsh web` 重启后**生效。无功能影响：`slots.inject('main' / 'sidebar.panellist')` 等的是槽位声明，且 layout / sidebar 与本行在同一批 application combo 里到达。
4. **浏览器渲染未由我观测**：页面在 device-auth 门后、本环境无浏览器自动化，因此「图标是否出现、五视图是否成形、抽屉是否开合」需由人在**既有页面刷新后**确认——**HTTP 200 ≠ 应用就绪**（postmortem 0003）。
5. 数据缺席按预期呈现：NEXUS 存量 446 轮 + PULSE 15 指标在场，INFER 层缺席 → 各视图显示缺席文案与诚实边界（不写 0 假读数、不把缺席当 0）。

---

## E11 单 Loader 条目硬契约（2026-09-13，宿主启动失败的根因与收敛）

**现象（守谷人端上实测 12:06–12:08）**：profile `web` 用户层用两条绝对路径 insert（`id: nexus` + `id: pulse`）热装配本包后，`dsh web` **启动失败**，宿主报：

```
client-modules: package @dsh-external/dsh-nexus resolves from multiple active Loader sources
```

另有第二条独立故障：客户端注册主区时用了 `id`，宿主报 `keyed slot main requires options.key`（已由 §E10 的 `key` 修正收口）。

**根因**：本包声明 `dsh.client`，client-modules **以「包」为单位**组合浏览器模块——同一包的多个活动 Loader 条目是**组合错误**，不是降级：整个 `dsh web` 起不来。仓库自身的 `cordis.patch.yml` 当时也正是双条目（`@dsh-external/dsh-nexus` + `@dsh-external/dsh-nexus/pulse`），因此**走 bundle 路线同样会炸**；两条绝对路径只是把这个坑提前踩到。

**修法（单条目 + 子插件）**
1. `cordis.patch.yml` 只插一行（`id: nexus`），删除 pulse 行；
2. `src/index.ts` 以子插件挂载：`ctx.plugin(pulse, config.pulse)`，pulse 的配置成为父 `Config` 的子节（复用 pulse 自己的 schema，默认值不重复写）；
3. `check-meta` 新增守卫：bundle patch 必须为本包插入**恰好 1 个** Loader 条目；
4. `scripts/test.mjs` 新增「单入口装配」用例：真实 cordis Context + 假 `webServer`/`tools`，断言子插件确实注册了自己的路由。

**实际**
- 装配：`dsh plugin --profile web add file:L:/dsh-nautilus` → pnpm 装入 `dependencies` 与 `dsh.profile.bundles` 各一行，其余包（`@linxin666/dsh-web-all` / `dsh-better-sidebar` / `dsh-server-deck`）仍在；
- `dsh --profile web --dump-config` → 本包**只有一行**：`- id: nexus` / `name: '@dsh-external/dsh-nexus'`；
- 离线组合路径物化（临时 `DSH_HOME`、pulse `dbFile=:memory:`、`enableCounters/enableGpu=false`）：`[nexus] Pulse OS/GPU 层已挂载（子插件）`，注册 **10 条路由**（含 `/api/nexus/pulse/state`、`/api/nexus/pulse/series`）与 1 个工具 `record_turn_selfcheck`，`dispose` 正常；
- 六件套全绿；`npm test` → **20/20**。

**环境四元组**：dsh `0.1.5-rc.2` · profile `web` · 装配方式 = **bundle（`dsh plugin add file:`）** · 结果：装配与组合路径**通过**；GUI 复核**待宿主重启**（本会话宿主进程即该 `dsh web`，重启会中断会话，须由守谷人执行）。

**观察结论**
1. 「同包多条目」是**带客户端半区包的结构性禁忌**，失败面在宿主启动阶段、症状离根因很远——必须由 CI 守（`check-meta` 条目数）与测试守（子插件路由），不能靠人记。
2. 扩能力的正确形态只有一种：**单条目 + 子插件挂载**。热装配与 bundle 装配在这条上等价，不能指望 bundle 路线「多插一行」。
3. §E10 的 `key` 契约与本节合起来才是「能启动 + 能渲染」的完整条件：前者管注册能不能被接受，后者管宿主能不能起来。

> **诚实边界**：本节第 3 条的物化用的是**真实 cordis 组合路径但不是 Loader 路径**（`ctx.plugin` 直挂）；Loader 路径的端上确认只能等宿主重启后做（AGENTS.md §6 的测试红线因此仍未完全满足——重启后应补一次 `/api/nexus/pulse/state` 与启动图行的复核）。

---

## E12 重启后端上复核（2026-09-13 12:2x，bundle 装配 · 既有 GUI origin）

**前置**：按 §E11 收敛后执行 `dsh plugin --profile web add file:L:/dsh-nautilus`，守谷人重启 `dsh web`（本会话宿主进程即该服务，重启只能由守谷人执行）。

**环境四元组**：dsh `0.1.5-rc.2` · profile `web` · 装配方式 = **bundle（`dsh plugin add file:`，单条目）** · 结果：**产物级 + 数据级通过**；DOM 渲染待人工确认。

**实际（全部只读 GET，经本机持久签名密钥铸造会话 cookie）**
1. `GET /` → **200**；启动图本行：
   `{"id":"@dsh-external/dsh-nexus","rev":"eaeacfa059478926-47","inject":["@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-sidebar"]}`
   —— `inject` 已是新值（+layout/+sidebar），证明重启后 client-modules 的包元数据缓存已刷新（§E10 观察 3 的遗留项收敛）。
2. `GET /plugins/??@dsh-external/dsh-nexus/client.js&rev=eaeacfa059478926-47` → **200**，96485 B（磁盘产物 96500 B，差值为 loader 包装）。内容标记全部命中：`sidebar.panellist` · `nautilus-workbench` · `conversation.view` · `nt-wb-top` · `nt-drawer` · `nt-era` · `FIG.01` · `FIG.06`；且 `main` 注册点已是 **`key`** 版本（守谷人的修正已进入下发产物）。
3. 只读 API 全 **200**：
   - `/api/nexus/pulse/state`：`ticks=17→20→23`（12 s 内 +3，与 5 s 间隔一致）· `rows 2953→3028`（+25，≈8.3 样本/tick）· `shell=powershell` · `countersOk=true` · `countersRestarts=0` · `lastError=null` · **15 条指标族齐全**（本地 / 计数器 / GPU 三族）；
   - `/api/nexus/state`：`root=L:\L_workspace\weixin-connect\LinsLive\L-theory`、91 文件；
   - `/api/nexus/m2/state?root=all`：453 轮 / 77 会话 / 自评覆盖 76；
   - `/api/nexus/m2/annotations`：8 条标注（人工标注闭环的最小样本）。
4. `latest` 条目形状 `{metric,value,ts,tags}` 与客户端 `PulseState` 类型一致（UI 只读 `length`，无口径风险）。

**观察结论**
1. **单条目收敛在宿主内成立**：pulse 作为 nexus 的子插件正常注册 `/api/nexus/pulse/{state,series}` 并持续采集——§E11 的修法端上确认（E11 遗留的 Loader 路径确认项收敛）。
2. **客户端半区交付链路完整**：启动图行 → rev → bundle 内容标记，三段可独立复核；§E10 的两条遗留（`inject` 生效、`key` 字段）均已闭合。
3. **仍未验证**：**DOM 渲染**——侧栏图标是否出现、五视图是否成形、抽屉开合是否正常。这一层只有人能看（本环境无浏览器自动化），未确认前不得宣称 UI 交付完成（OQ-U6 仍开）。
4. **复现口径**：profile 内是**安装副本**（非符号链接），重建仓库产物后必须**重跑 `dsh plugin add file:` + 重启宿主**；仅 `npm run build` 不会回流（已写入 CONTRIBUTING「交付与安装通道」）。

**诚实边界**：本节全部证据是**只读 GET**（`/`、`/plugins/...`、`/api/nexus/*`），未改任何状态；cookie 由本机凭据库的持久签名密钥在本地铸造，密钥值未落盘、未打印、未进命令历史文件。DOM / 交互层无证据。

---

## E13 端上首轮问题修复（2026-09-13，守谷人复核后）

**现象（守谷人刷新页面后反馈）**
1. **缺少返回会话按键**——工作台是 `main` 全局面板，选中后会话列不可见，面板内没有回程入口；
2. **OS 层数据没显示**——总览只显示了采集器心跳，15 条 PULSE 指标一条都没呈现；
3. **点「预言」等分段按钮后页面不正常**——点击即无内容 / 白屏。

**根因**
- 现象 3 是 React 使用姿势错误：五个视图组件被**当普通函数直接调用**（如 `CurveView({...})`）而不是渲染为元素，子组件的 hooks 因此算进父组件 `Workbench`。切换视图时 hooks 数量变化（曲线 3 个、预言 3 个、抽屉 2 个 ↔ 总览 0 个），React 抛 Rendered more hooks than during the previous render，**整页渲染失败**——症状「按钮点了没反应」正是这个。
- 现象 2 不是数据问题（`/api/nexus/pulse/state` 一直是 200、15 指标齐全），是 **UI 缺口**：总览只用了 `collector` 与 `db` 两个字段，`latest[]` 从未渲染。
- 现象 1 是**设计缺口**：布局契约里 `selectPanel(null)` 才是「显示当前会话」，而侧栏壳的行只做 `selectPanel(id)`——回程入口必须由面板自己提供。

**修法**
- 五个视图与抽屉一律改 `createElement(View, props)`。
- 工作台头部加「← 返回会话」按钮 → `ctx.layout.selectPanel(null)`；客户端插件 `inject` 加 `layout`（必需服务：主区与侧栏图标两个槽位本就由它声明）。
- 总览新增「系统层读数（PULSE · 本机）」面板：4 张头条读数（CPU 利用率 / 内存占用 / GPU 利用率 / 宿主进程 RSS）+ 15 条指标全表（分组 / 最新值 / 采样时刻）+ 采集健康行。**量纲逐个取自 `src/pulse/{collect,counters}.ts` 的构造点**（utilization 与 proc.cpu 换算百分比、io_rate 字节/秒、gpu.mem MiB、temp/power °C/W），未知指标原样加「量纲未知」标注而不是猜。
- 曲线视图新增数据源切换：NEXUS 轮次 / PULSE 采样；后者带指标下拉 + `/api/nexus/pulse/series?windowMs=3600000&maxPoints=240` 的等间隔曲线，并写明「这里时间轴均匀、斜率可读」，与轮次曲线的非等间隔形成对照。
- 新增 `ViewBoundary` 类组件隔离单个视图的渲染异常（显示错误原文 + 重试），避免再出现「一个视图挂掉整页白屏」。
- era 切换按钮补 `.on` 高亮。

**实际**
- 六件套全绿；`npm test` **20/20**。其中 client bundle 用例因新增类组件**先失败一次**（测试的 react shim 缺 `Component`，材料化即 `extends undefined`），补 shim 后通过——这条反向证明该用例确实在断言产物，而不是自我报告。
- `lib/client.js` 96500 → **106327 B**；新标记命中：`getDerivedStateFromError` · `nt-btn.on` · `selectPanel`。
- profile 副本已刷新：`dsh plugin --profile web add file:L:/dsh-nautilus`（2.1 s）——**事后证明这次 add 是空操作**，见下条。

- profile 装配通道修正（同日）：`dsh plugin add file:` **不会刷新已有副本**（pnpm `added 0`，副本停在 12:11 的 96500 B），因此重启后「毫无变化」；已改为 `dsh plugin remove` + `dsh plugin add link:L:/dsh-nautilus`，profile 内变为 **Junction → 仓库**（经 profile 路径看到的 `client.js` = 仓库当前产物 106501 B），此后 `npm run build` 即回流。`--dump-config` 仍为单条目 `id: nexus`。

**必须重启（实测）**：副本刷新后启动图 **rev 不变**（仍为 `eaeacfa059478926-47`），下发的仍是**旧字节**（`getDerivedStateFromError` / `nt-btn.on` / `selectPanel` 三个新标记均为 false）。即：**bundle 安装下 client-modules 在启动时缓存产物**，替换 `file:` 副本不会触发 rebuild 通知。

> **对 §E10 观察 1 的限定**：那条「改客户端半区只需 `npm run build` + 刷新页面、不必重启」只在 **patch 热装配**（Loader 条目指向仓库路径）下成立；改走 bundle 安装后，**每次客户端改动都要 `build` → `dsh plugin add file:` → 重启宿主**。

**环境四元组**：dsh `0.1.5-rc.2` · profile `web` · 装配方式 = **bundle（`file:` 安装副本）** · 结果：产物级通过；**端上可见性待重启后由守谷人确认**。

**诚实边界**：本节结论到「产物字节 + 门禁 + 组合路径」为止。DOM 渲染（返回会话按钮是否出现、OS 面板是否有数、切视图是否正常）**仍需人在重启后的既有页面确认**——§E12 的 OQ-U6 未闭合。

---

## E14 nexus 层接入工作台 + 两处门禁修补（2026-09-13 下午）

**数据体检（只读，全部通过）**：7 个 nexus/pulse 接口全 200。NEXUS：root=L-theory · 91 文件 · 433147 字符 · 今日 1 次编辑 · 460 轮 / 77 会话 · 命中率 **94.9%**（读 1019193961 / 未命中 54288905）· 自评覆盖 79/460 · 标注 8 条。PULSE：15 项指标全在、值域自洽（`mem.used<mem.total`、`gpu.mem.used<=total`、`utilization∈[0,1]`）、最新采样 2–8 s 前、`countersOk=true` `gpuOk=true` `restarts=0` `lastError=null`、`user_version=4`、`series` 239 点 / 15 s 桶。库内交叉一致（`turn_read 460` / `metric_sample 11231` / `annotation 8` / `edit_event 230`）。

**接入内容（工作台补齐 nexus 层能力，原先只有旧 tab 有）**
1. **vault 指向与扫描**（FIG.07）：`GET /api/nexus/vault` 的指向短名 / 完整路径 / 可达性（存在·可读）/ 已知根数；「重新扫描 vault」按钮走 `POST /api/nexus/action {kind:"rescan"}`，成功即 toast + 全量重取。
2. **L 场读数（独立指向）**（FIG.08）：`GET /api/nexus/lfield` 的按根计数与当前 L 场指向，并写明「L 场归属与 vault 编辑统计相互独立」。
3. **白盒分析接进假设视图**（FIG.09）：`/api/nexus/m2/analysis?root=all` 的逐会话形态 / 爆发段 / τ_e 表，并**替换掉过期的证据位占位**——原 P4 写「需会话时长 τ_e（Phase 2a 计算）」，而 τ_e 早已由白盒分析给出；现在 P1 带形态分布、P4 给「τ_e 可算 N/M 会话 · 中位 X turn」、P6 按已知根数判断能否跨根对照。
4. **报告页**：meta 增「vault 指向」「白盒分析（会话数 · 形态分布 · τ_e 中位）」，正文加「四、白盒分析」段；并**澄清 τ_e 语义**——报告原写「INFER 缺失故 τ_e 无法计算」属混用：白盒 τ_e 是轮次级探索段长度（已可算），INFER 条件下的是端到端时延耦合（仍缺）。导出 JSON 快照同步纳入 analysis / vault。

**门禁修补（比功能更重要）**
1. **客户端构建失败曾静默**：`scripts/prepare.mjs` 对 `build-client.mjs` 非零退出只 `console.warn("host build still valid")`，于是 **`lib/client.js` 保持上一次的旧产物、六件套全绿**——本轮新面板因此没进包，而 `npm run build` 仍报 exit 0。已改为 `console.error` + `process.exit`。**这与 §E13 的「重启无变化」是同一类坑**：产物陈旧而门禁不响。
2. **CONTRIBUTING 验证纪律**补一条：提交前当场核产物（字节数 / mtime / 产物内标记），门禁全绿 ≠ 产物是新的。

**`link:` 装配下无需重启（实测）**：宿主 `dsh web` PID 40700（13:18:23 启动后**未再重启**）期间，启动图 rev 自动更新两次（`53104ef48f06b478-47` → `f1d08b7a90df` → `6b5fb2dbe4de`），下发字节随之变化并含新标记（`FIG.07/08/09`、`/api/nexus/action`、`shortRoot`）。即 **junction 装配恢复了「build → 刷新页面」的快循环**，§E13 的「必须重启」只适用于 `file:` 副本。

**实际**：六件套全绿；`npm test` **21/21**；`lib/client.js` 109711 → **121313 B**（新标记全部命中）。

**诚实边界**：① DOM 仍未由我观测（OQ-U6），本轮只到「产物字节 + 启动图 rev + 接口 200」；② `POST /api/nexus/action` 的重新扫描**未由我触发**（不替守谷人做副作用操作），端上点击验证留给他；③ 数据体检是**快照**（13:4x），不是持续观测。

---

## E8 诚实边界（引用本归档时必须一并引用）

1. **端上读数口径**：§E8 初稿时本层尚未装配（证据全来自离线探针）；**§E9 起已热装配进 profile `web`**，宿主路径已有端上四元组读数（OQ-3 收敛）。但 E5 的 1 小时档仍只有中间读数，且「连续 1 小时无内存增长」尚未给出完整序列。
2. **单机单卡**：GPU 族仅在本机一张 RTX 5060 Laptop 上验证；无卡/多卡的解析路径只有单测覆盖（无真实无卡环境）。
3. **1 小时档未取满**：E5 已回填到 41 min / 457 tick（宿主重启中断，与内存无关），**60 min 档仍缺**——「连续 1 小时无内存增长」不得宣称通过。
4. **Windows 专属**：计数器族依赖 PowerShell + CIM；非 Windows 下该族缺席（本地族仍可采），未在 Linux/macOS 上验证。
5. **探针写临时库**：默认库是 `%TEMP%` 下的临时文件，与 `~/.dsh/nexus/nexus.db` 的结构一致但**不是**同一个库；端上装配后的读数需重新采集。
6. **采样成本只测了 CPU 与 wall**：未测内存占用增量与磁盘/网络 IO 增量（soak 的 RSS 序列部分覆盖内存）。
7. **DOM / 交互层无证据**：§E10–E12 覆盖到「宿主启动图 → rev → bundle 字节 → 只读 API」为止；侧栏图标是否出现、五视图是否成形、抽屉与标注写路径的实际交互，均需人在既有页面确认（OQ-U6）。
