# Nautilus 开发文档三 · Phase 1：pulse（OS/GPU 层）最小闭环

> 版本 v0.1（2026-09-13 起草）· 上游：[../1-planning/nautilus-opening-report.md](../1-planning/nautilus-opening-report.md) §4.2 指标口径 / §4.3 存储 / §6 Phase 1 · [./nautilus-dev-01-phase0.md](./nautilus-dev-01-phase0.md)（D1 决策）
> 证据归档：[./evidence-phase1-20260913.md](./evidence-phase1-20260913.md)
> 环境：Windows 11 · dsh 0.1.5-rc.2 · Node v24.18.0 · **Windows PowerShell 5.1**（本机无 pwsh）· RTX 5060 Laptop 8GB

## 1. 交付物

| 项 | 位置 | 说明 |
|---|---|---|
| 插件入口 | `src/pulse/index.ts` | **独立插件行** `id: pulse`（`cordis.patch.yml`），与 nautilus 同包不同入口、同库不同表 |
| 采集层 | `src/pulse/collect.ts` | 零依赖本地族 + GPU（纯函数解析，exec 可注入） |
| 计数器助手 | `src/pulse/counters.ts` | **常驻** PowerShell 子进程 + 行协议（见 §3.2） |
| 存储层 | `src/pulse/store.ts` | `metric_sample` + v3→v4 迁移 + 保留清理 |
| 只读校验路由 | `src/pulse/routes.ts` | `/api/nautilus/pulse/state`、`/api/nautilus/pulse/series`（UI 层导入的取数口） |
| 离线验收器 | `scripts/pulse-probe.mjs` | 不经宿主跑完整采集+落库，用于证据链与 soak |

## 2. 指标口径（实现值）

| 指标（`layer=pulse`） | 单位 | 通道 | 周期 | 上游 §4.2 对应 |
|---|---|---|---|---|
| `pulse.cpu.utilization` | 0–1 | `node:os` tick 差值 | 5 s | USE Utilisation |
| `pulse.cpu.ctx_switches` | 次/秒 | PowerShell 助手 | 15 s | USE Saturation |
| `pulse.mem.used` / `pulse.mem.total` | bytes | `node:os` | 5 s | USE |
| `pulse.mem.swap.used` | bytes | 助手（页文件 CurrentUsage 合计） | 15 s | USE |
| `pulse.disk.io_rate` | bytes/s | 助手（`_Total\Disk Bytes/sec`） | 15 s | USE |
| `pulse.disk.queue` | 平均队列长度 | 助手 | 15 s | USE Saturation（新增） |
| `pulse.net.io_rate` | bytes/s | 助手（各网卡 `Bytes Total/sec` 合计） | 15 s | USE |
| `pulse.proc.dsh.rss` | bytes | `process.memoryUsage()` | 5 s | USE 进程视角（**插件在宿主进程内 → 即宿主进程**） |
| `pulse.proc.dsh.cpu` | 单核=1 的分数 | `process.cpuUsage()` 差值 | 5 s | 同上 |
| `pulse.gpu.util` / `mem.used` / `mem.total` / `temp` / `power` | % / MiB / °C / W | `nvidia-smi --query-gpu` | 10 s | DCGM 口径 |

**标签**：`{host}`（系统族）、`{host,pid}`（进程族）、`{device,name}`（GPU 族）；`era` 列默认 `api`（§4.4 的 era 切换由 core 后续驱动）。
**缺席即缺席**：任何族拿不到数据就**不写行**，绝不写 0（0 是合法读数）。

## 3. 采集设计（三条由实测驱动的决策）

### 3.1 零依赖本地族（D1 的 A′ 档）

CPU 用 `os.cpus()` tick 差值、内存用 `os.totalmem/freemem`、进程级用 `process.memoryUsage/cpuUsage`——**零依赖、零子进程**，单 tick <1 ms。首轮无 CPU 差值时**不写** `cpu.utilization`（避免 0 假读数）。

### 3.2 计数器族：常驻助手而非一次性进程（本层最重要的工程决策）

实测（Windows PowerShell 5.1，本机）：

| 通道 | wall/次 | **CPU/次** | 5–15 s 周期下的开销 |
|---|---|---|---|
| 一次性 `powershell -Command` | ~3.0 s | **~2.9 s** | 单核 ~19%（15 s 周期）——**超出 D1 设的 2% 回退线** |
| 同一脚本 `Get-Counter` 变体 | ~3.0 s | ~2.8 s | 同上（瓶颈是解释器启动 + CIM 模块加载，不是查询本身） |
| **常驻会话内查询**（预热后） | ~0.9 s | **16–31 ms** | 单核 **<0.2%**（15 s 周期） |

→ 采用**常驻助手**：一个 PowerShell 子进程，预热后打印 `{"ready":true}`；父进程每次写一行 `sample`，子进程回一行 JSON。wall 的 ~0.9 s 是 WMI 等待（不占 CPU），且异步等待不阻塞事件循环。

工程细节（都对应一次真实故障）：
1. **解释器自动探测**：`pwsh` → `powershell` 依次试——本机只有 5.1 的 `powershell`（`pwsh` 不在 PATH）。
2. **代际标记**：候选进程切换/重启时 `gen += 1`，迟到的 `onExit/onStdout` 不得作废当前代——否则前一个候选的退出回调会把新候选的 `ready` 等待打断（实测表现为「助手启动失败」，9 ms 内返回）。
3. **读超时 → 代际作废 + 下周期重启**：单次失败只让该族本轮缺席，不拖累其余族。
4. **停稳**：`close()` 先关 stdin 让助手自然退出，宽限期（2 s）内没退再 terminate。

### 3.3 GPU 族

`nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`，CSV 纯函数解析：字段为 `N/A` → 该指标缺席；解析不出任何行的整族缺席（R8：驱动输出漂移时降级而非报错）。

### 3.4 子进程通道：走声明的 seam

宿主路径经 `ctx.get('subprocess')`（**可选**服务，缺席则依赖子进程的两族整体缺席——AGENTS.md §2 的 `ctx.get` 口径）；离线探针注入 `node:child_process`。采集核心不认识宿主，两者共用同一份 `lib/pulse/*`。

## 4. 存储与迁移

```sql
CREATE TABLE metric_sample (
  ts INTEGER NOT NULL, layer TEXT NOT NULL, metric TEXT NOT NULL,
  value REAL, tags TEXT, era TEXT NOT NULL DEFAULT 'api'
);
CREATE INDEX idx_sample_q ON metric_sample(metric, ts);
CREATE INDEX idx_sample_ts ON metric_sample(ts);
```

- **同库不同表**：`~/.dsh/nautilus/nautilus.db`，**不动** turn 系表；`journal_mode=WAL` + `busy_timeout=3000`（与 nautilus 是两个连接）。
- **迁移 v3 → v4 且只在 v3 推进**：`user_version` 是全库共享序列——若库仍停在 v<3（nautilus 未迁移），pulse **只建表不推进版本**，否则会把 nautilus 的 v1–v3 迁移永久跳过。**副作用**：M5 设计文档原预留的 v4（`call_p`）顺延为 **v5**，已在此登记。
- **保留**：每小时 `prune` 掉早于 `retentionDays`（默认 14 天）的原始采样；**1 分钟档聚合留 Phase 3**（OQ-1）——5 s × 15 指标 ≈ 26 万行/天，14 天 ≈ 360 万行（SQLite 可承受，但长期历史需要降采样档）。

## 5. 接口（UI 层导入用）

| 路由 | 说明 |
|---|---|
| `GET /api/nautilus/pulse/state` | 采集器状态（ticks/最近一次耗时/各族可用性/助手 shell 与重启次数）+ 每指标最新值 + 库统计 |
| `GET /api/nautilus/pulse/series?metric=&windowMs=&maxPoints=` | 单指标序列（按桶取均值，点数 ≤ maxPoints） |
| `POST /api/nautilus/pulse/control` | **心跳运行时控制**（2026-09-13 新增）：`{ intervalMs: 1000\|5000 }` 定时档 · `{ mode: 'manual' }` 手动档（停定时器）· `{ sample: true }` 立即采一次（任何档位可用）。合法区间 1000–600000ms，非法即 400；只改节律，采样仍走同一条 tick 路径（同库同表，不产生第二套口径）。响应回 `{ ok, collector }` |

**心跳档位（UI 暴露三档）**：`1 s` / `5 s` / `手动`。1 s 档只加密**本地族**的采样；计数器族与 GPU 族仍按各自周期（`countersIntervalMs` 15 s / `gpuIntervalMs` 10 s）——它们是重活，不随心跳线性加密。手动档下读数只在点「采一次」时更新。

同源标记守卫。读路由**只读**；`/control` 只改采集节律（不写业务读数）。UI 层已接入（工作台「系统层读数」面板 + 心跳档位控件，见 §E14/§E15）。

## 6. Phase 1 验收对照

| 上游验收标准 | 本层状态 |
|---|---|
| 采集器 5 s 轮询 ≥6 类指标（含 dsh 宿主进程级），写入 `metric_sample` | ✅ **15 条序列 / 6 族**（含 `pulse.proc.dsh.*`） |
| 连续运行 1 分钟输出 ≥3 指标时间序列 | ✅ 离线探针 4 tick 落库 34 行 / 15 族（证据 §E3） |
| 连续 1 小时无内存增长 | ⏳ 20 分钟 soak 已完成（RSS 见证据 §E5）；**1 小时档待续**（守谷人确认是否补跑） |
| 证据归档 | ✅ `evidence-phase1-20260913.md` |

## 7. 未做 / 开放问题

- **OQ-1 分钟档聚合**：Phase 3（core 对齐管道）一并做，届时决定聚合表形态与保留分档。
- **OQ-2 GPU 版本化快照测试**：当前只做「字段缺失即缺席」的软失败，未固化驱动输出样例（R8 的完整对策）。
- ~~**OQ-3 端上装配**~~ **已完成（2026-09-13，热装配）**：profile `web` 的 `cordis.patch.yml` 已插入 pulse 行，宿主实时出数（环境四元组见证据 §E9）。**遗留**：属热装配例外，重启前收敛为 `dsh plugin --profile web add`（CONTRIBUTING 工程红线 5）。
- **OQ-4 非 Windows**：计数器族缺席（本地族与 GPU 族仍可采）；若将来要跨平台，需为 Linux 写 `/proc` 通道（上游 §2.1 的 psutil 类接口）。
- **OQ-5 采集与 UI 的联动**：UI 层导入时是否需要 `pulse.*` 的事件推送（现在只有轮询路由）。

## 关联文件

- [../1-planning/nautilus-opening-report.md](../1-planning/nautilus-opening-report.md) — §4.2 指标表 / §4.3 存储 / Phase 1 验收
- [./nautilus-dev-01-phase0.md](./nautilus-dev-01-phase0.md) — D1 决策（全 Node、零依赖自采起步）、TTFT 与 provider 可得性
- [./evidence-phase1-20260913.md](./evidence-phase1-20260913.md) — 本轮证据归档
