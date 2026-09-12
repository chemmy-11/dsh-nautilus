# Nautilus 开发文档一 · Phase 0：选型决策与因果链确认

> 版本 v0.1（2026-09-12 起草，**待开发组评审**）
> 上游：[../1-planning/nautilus-opening-report.md](../1-planning/nautilus-opening-report.md) §六 Phase 0 · [../1-planning/nautilus-research-2-positioning.md](../1-planning/nautilus-research-2-positioning.md) §五
> 证据归档：[./evidence-phase0-20260912.md](./evidence-phase0-20260912.md)（执行命令 / 预期 / 实际输出 / 观察结论）
> 核查环境：dsh `0.1.5-rc.1` · Node `v24.18.0` · Windows · nexus 库 427 轮 / 70 会话 · 会话日志 18 份（v3 格式）

---

## 0. 结论速览

| # | 项 | 结论 | 状态 |
|---|---|---|---|
| V1 | **TTFT 可得性** | ✅ **可得，且历史可回填**——宿主把「带精确时间的流」内嵌在 `assistant/message.data.stream`；实测 18 会话 / 783 次调用 **100% 覆盖** | 已验证 |
| V2 | **model / endpoint 可得性** | ✅ 逐调用可得 `message.source.{provider,model}`；实测已出现 3 个 provider | 已验证 |
| V3 | **OTLP 兼容（R10）** | ✅ 宿主自带遥测 seam（`ctx.sessionTelemetry` + `dsh-session-telemetry-otel`，本机已装）；官方 OTel JS 指标栈 ≈18.5 MiB 解压，**零依赖 OTLP/HTTP JSON 可行** | 已验证 |
| V4 | **OpenLIT GPU 管线纠偏** | ⚠️ 1-planning 称其走 nvidia-smi，**实测为 NVML（pynvml / go-nvml）**；可借鉴项改为命名与降级姿态 | 已验证 |
| D1 | 运行时选型 | 推荐 **全 Node**；采集实现建议以「零依赖自采」起步，`systeminformation` 为回退档 | **待裁决** |
| D2 | 聚合包载体 | 推荐 **原地演进**（现有 `dsh.bundle` + patch 机制已支持单包插多行） | **待裁决** |
| D3 | 本地推理栈 | 建议**改写决策形态**：由「vLLM vs Ollama 单选」改为「引擎适配器优先级」（Ollama 首选 / vLLM 走 WSL2） | **待裁决** |

---

## 1. Phase 0 目标与验收（引用上游）

上游 Phase 0 产出 = ① D1/D2/D3 决策纪要；② era 设计定稿；③ 宿主事件 TTFT/model/endpoint 字段可得性验证报告。验收标准：决策纪要归档；TTFT 可得性有明确结论（可得 → 字段定义；不可得 → 记录并放弃）。

第二期追加三项（§五）：TTFT 可得性捷径（读 loongsuite 源码）· OTLP 兼容评估 · OpenLIT GPU 管线研读。

**本文件交付 ①②③ 与追加三项的全部结论；三个决策点保持「待裁决」，不单方面生效。**

---

## 2. 可得性验证

### 2.1 TTFT：可得（双通道，含历史回填）

**宿主自身的口径**（源码即定义，非我方推测）：

```js
// dsh-client-ui-chat/lib/client.js:3790
ttftMs: timing.stepStartTime !== null && timing.firstTokenTime !== null
  ? Math.max(0, timing.firstTokenTime - timing.stepStartTime) : null
// :3798 注释：TTFT is the turn's lowest-step request-dispatch-to-first-token reading
// :4465  firstTokenTime 取「第一条 token 增量」chunk 的 time
// :4497  stepStartTime = step/start 事件的 time
```

**数据来源**：v3 会话日志的 `assistant/message` 事件带 `data.stream` —— 由 `dsh-session-format-v1-to-v2` 迁移把顶层 `assistant/chunk` 的**精确带时间流内嵌进消息**（每项带 `time`，或 `time0` + `dt` 增量数组）。

**实测**（18 会话 / 783 次 assistant 调用，详见证据归档）：

| 指标 | 值 |
|---|---|
| 带内嵌 `stream` 的调用 | 783 / 783（**100%**） |
| TTFT min / p50 / p90 / p99 / max | 448 / 3067 / 9275 / 26313 / 32101 ms |

**两条通道的分工**（本课题相对 loongsuite 的差异点）：

| 通道 | 来源 | 能否回填历史 | 用途 |
|---|---|---|---|
| **回放通道** | `assistant/message.data.stream` | ✅ 能（日志里就有） | 历史基线、Phase 2a 注册、归因报告 |
| 实时通道 | `session/event` 首块 / `llm/stream` | ✗（只对当下） | 实时面板、OTel span |

> loongsuite/dsh-plugin 走的是**实时通道**：在 `llm/stream` 钩子里对首个可见 token 打 `performance.now()`，最终写成 `gen_ai.response.time_to_first_token`（纳秒）。它**不读** `step/start`/`request/header` 的事件时间，因此**无法回填历史**——这正好是我们可互补的地方。其属性名可直接作为我们 OTLP 导出时的对齐名。

**对 Phase 2a 的影响（重要）**：TTFT 从上游表里的「待 Phase 0 验证宿主事件可得性 / 本地时代才有」升级为 **2a 即可注册**。且该通道**与 era 无关**——宿主对任何 provider 都记录内嵌流（推论：本地时代 TTFT 免采集，见 D3）。

### 2.2 model / endpoint：逐调用可得

三处独立可得，互为校验：

| 位置 | 内容 |
|---|---|
| `assistant/message.data.message.source` | `{kind:'model', provider, model, replayState}` —— **逐调用** |
| `request/header.data.header.config` | `{provider, model, reasoningEffort, maxTokens}` |
| `request/context` | `{provider, model, contextWindow}` |

实测分布（同 783 次调用）：`tokenrhythm/deepseek-flash` 331 · `opencode-go/deepseek-flash` 300 · `deepseek-official/deepseek-flash` 152。

→ **provider 维度在既有数据里天然存在**，era 判定与对照集划分可直接建立其上（§4）。

### 2.3 OTLP 兼容（R10）：宿主自带遥测 seam

- seam：`ctx.sessionTelemetry`（[dsh-docs/subsystems/session-telemetry]）；后端：`@deepseek-ai/dsh-session-telemetry-otel`（原样配置 OTel JS SDK 日志流水线）——**两个包在本机 dsh 安装树内实测存在**。
- 契约要点：ledger 记录与 session 事件 **1:1 镜像**（接收端按 `(session.id, event.seq)` 去重）；**每 `(turn, step)` 只发出第一条 `assistant/chunk`**——即「流已开始」信号，天然就是 TTFT 的实时口径；sharing 策略 `full | feedback-only | disabled`。
- 成本量化：官方 OTel JS 指标栈合计 **≈18.5 MiB 解压**（其中 `semantic-conventions` 单包 12.0 MB）；OTLP/HTTP **JSON 编码为规范允许**（客户端须设 `Content-Type: application/json`，64 位整数用十进制字符串），可用内置 `fetch` 手写 resourceMetrics → **零依赖可行**。
- **建议**：R10 按「零依赖 OTLP/JSON 可选导出」实现，指标名对齐 `gen_ai.*`；不引官方 SDK，不阻塞 Phase 0–3。Phase 4 再评估是否复用 loongsuite 的 MeterProvider。

### 2.4 OpenLIT GPU 管线纠偏（对 1-planning 的回写项）

1-planning §1.5/§五-3 记「OpenLIT 的 nvidia-smi → OTel 指标实现是 pulse 方案 A 的现成参照」——**实测不成立**：其 Go 收集器走 go-nvml（Windows 用 `nvml.dll`），Python SDK 走 `pynvml`/`amdsmi`，全仓 grep `exec.Command|nvidia-smi` **零命中**。

**改为可借鉴的两项**：① 指标命名与属性（`hw.gpu.utilization`、`hw.gpu.memory.utilization`、`hw.temperature`、`hw.power`，属性 `hw.id/hw.name/gpu.index`）；② **无卡软失败姿态**（发现不到 GPU 即跳过 GPU 族、继续导出主机指标，每 30s 重试发现）——与上游 R5/R8 的降级口径同构。pulse 的 GPU 实现参照物改为 **nvitop / DCGM 口径（NVML）**，实现层可用 `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`。

---

## 3. 决策点（待开发组裁决）

### D1 运行时选型

**结论建议：全 Node（方案 A 系），采集实现以「零依赖自采」起步。**

| 方案 | 说明 | 证据 / 成本 |
|---|---|---|
| **A′ 全 Node·零依赖自采**（建议） | Node 内置（`node:os` / `process.cpuUsage` / `memoryUsage` / `resourceUsage`）+ 每 tick 一次批量 CIM/PowerShell 取磁盘·网络·上下文切换计数 + `nvidia-smi --query-gpu` 取 GPU | 现包**运行时依赖为 0**（`dependencies` 字段不存在）；`check-deps` R1 仅禁 in-box；进程级指标因为插件**跑在 dsh 进程内**而天然免费 |
| A 全 Node·引第三方 | `systeminformation` 5.33.10（**867 KB 解压 / 27 文件**）+ `pidusage` 4.0.1（36 KB / 13 文件） | Windows 下这两个库内部同样是 PowerShell/CIM 轮询——买的是跨平台与解析健壮性，不是新能力 |
| B Python 采集器 | psutil + pynvml，经子进程/文件接力 | 双运行时：`dsh plugin add` 安装链被破坏，Phase 4 与复现成本上升 |
| C Python 独立 pip 包 | core 只读其 SQLite | 「聚合包」名存实亡，装机复杂度最高 |

**推荐理由**：D1 的实质问题是**语言**（Node vs Python），A/A′ 都属 Node，可直接裁决「全 Node」；实现档位（自采 vs 引依赖）留给 Phase 1 首个闭环用实测数据决定——Windows 下 5s 节奏跑 PowerShell/CIM 子进程的 CPU 与内存占用属于**必须实测**的量（上游 R6 已关注 SQLite 膨胀，采集成同等量级关注）。

**回退触发线（建议写进 Phase 1 验收）**：若自采路径连续 1 小时出现内存增长，或 5s tick 的采集开销 > 单核 2%，则降级到方案 A（引 `systeminformation`）。

### D2 聚合包载体

**结论建议：原地演进（本仓库，单包多入口），M4 收尾与 Phase 0–2b 期间不动仓库结构。**

| 方案 | 说明 | 证据 / 成本 |
|---|---|---|
| **原地演进**（建议） | 继续用本包；`cordis.patch.yml` 追加 `insert` 行，多插件各行一个入口 | 机制已具备：`package.json` 已声明 `dsh.bundle.patch`，官方文档明确「组合包 = 附带配置层的 npm 包」，**单包可插多行**；安装链 `dsh plugin add github:chemmy-11/dsh-nexus` 不变 |
| monorepo 多包 | pnpm workspace 下 pulse/infer/core 各自成包 + 一个聚合 bundle 包 | 现有 CI（actionlint / check-deps / check-meta / client shim）是**单包假设**；升格需重做门禁与发布链 |
| 新仓库 | nexus 冻结，nautilus 另起 | 与上游 R7 的隔离诉求一致，但与「验收已建立的工程纪律」重复投入；且本工作区目录已改名为 `dsh-nautilus`，事实上已按原地演进的形态在走 |

**推荐理由**：D2 的原始诉求是「不要污染 M4 主线」——这在单包内也能做到：新代码落独立子目录（如 `src/pulse/`、`src/core/`）+ 独立 patch 行，等价于隔离，且不付出重建 CI 的代价。**真正需要重估的时点是 Phase 4**（安装链 CI 化）：届时按实际包边界再判。

### D3 本地推理栈

**结论建议：把「二选一」改写成「引擎适配器优先级」——Ollama 首选，vLLM 走 WSL2 作为第二引擎。**

本机实测（Phase 0 现场核查）：

| 项 | 值 |
|---|---|
| GPU | NVIDIA GeForce RTX 5060 Laptop，**8151 MiB 显存**，驱动 616.64 |
| CPU / 内存 | i7-14650HX（16C/24T）/ 15.7 GB |
| WSL | Ubuntu-24.04（WSL2）**已装** |
| 磁盘余量 | C: **15 GB** · D: 138 GB · L: 50 GB |

| 引擎 | 本机可行性 | 指标面 |
|---|---|---|
| **Ollama**（建议首选） | Windows 原生 + CUDA，安装即用；8 GB 显存档位（7–8B 量化）可跑通 | 无原生 `/metrics`；API 响应自带 `load_duration` / `prompt_eval_duration` / `eval_duration` / `*_count` |
| **vLLM**（第二引擎） | 官方安装文档只给 Linux 路径（CUDA/ROCm/CPU），Windows 实践走 WSL2；本机 WSL2 已具备，但需把权重缓存移出 C 盘（**C 盘仅 15 GB**） | 指标最全：TTFT/TPOT、`kv_cache_usage_perc`、排队与并发 |

**本文档最重要的一条口径修订**：**模型层指标（TTFT / TPOT / 耗时 / token）不依赖推理引擎**——宿主对任何 provider 都记录内嵌带时间流（§2.1）。因此：

- 本地时代的 TTFT/TPS **走应用层即可得**，无需引擎配合；
- 引擎侧采集的**独有价值收敛为三项**：KV cache 占用、排队/并发、批处理行为；
- D3 因此从「选一个引擎，否则指标拿不到」降级为「按需启用适配器」——**风险等级由高转低**。

采集设计含义：`nautilus.infer.engine.*` 由**适配器**声明支持集合（vLLM 全量 / Ollama 仅显存增量近似 / llama.cpp 备选）；发现不到引擎即整族缺席，**不报错**（沿用 R5/R8 降级口径）。

---

## 4. era 因果上下文（定稿建议稿）

1. **判定依据**（原设计为「会话记录补 model/endpoint 字段」，现升级为逐调用）：`assistant/message.message.source.{provider,model}`。会话级 era = 该会话调用的 provider 集合 → 单值即该 era；**多值时标 `mixed`**，归因报告必须显式声明（见 OQ-P0-1）。
2. **落库**：`metric_sample` / `metric_event` 沿用 `era` 列；`turn_read` 侧补 `provider` / `model` 列（逐调用粒度建议另立 `call_read`，与 M5 的 `call_p` 同粒度，避免污染 turn 口径）。
3. **回溯能力**：provider 字段在**全量历史**可得（实测 18 会话 783 调用 100%），故 era 可在部署后**一次性回溯标注**，与 nexus 既有的 vault 指向回溯机制同构。
4. **对照集规则**：沿用 1-planning §4.4——`api` 时代只用「对照」（弱因果），`local` 时代才谈「归因」（强因果闭合）。
5. **当前实测**：18 会话全部为云端 API provider（3 个），**库里尚不存在 local era 数据**——era 机制在 Phase 0–3 期间处于「已定义、待数据」状态。

---

## 5. 对 1-planning §4.2 指标口径表的回写建议

| 表项 | 原表述 | 建议修订 |
|---|---|---|
| `nautilus.infer.turn.ttft` | 「**待 Phase 0 验证宿主事件可得性**」 | **可得**（回放+实时双通道）；口径 = 首块 `stream` 时间 − `step/start` 时间；turn 级取最低 step；**实测 p50 3.1 s**；粒度建议按调用（与 M5 P 腿对齐） |
| `nautilus.infer.session.model/endpoint` | 「session/event 字段落库，每会话」 | 升级为**逐调用**可得（`message.source`），era 判定与对照集据此 |
| `nautilus.pulse.gpu.*` 采集 | 「nvidia-smi/NVML 轮询」 | 保留；参照物由 OpenLIT 改为 **nvitop/DCGM 口径**，外加 OpenLIT 的命名与软失败姿态 |
| `nautilus.infer.engine.*` | 「仅 vLLM；Ollama 降级」 | 保留，并明确「引擎族独有价值 = KV cache / 排队 / 批次」三项 |

---

## 6. Phase 0 验收对照

| 验收标准（上游） | 达成情况 |
|---|---|
| 决策纪要归档 | 本文件 §3（D1–D3 保持待裁决） |
| TTFT 可得性有明确结论（可得 → 字段定义） | ✅ §2.1，字段与口径已给出，附实测覆盖率与分布 |
| era 设计定稿 | 建议稿 §4，**待裁决** |
| 追加：TTFT 捷径（读 loongsuite 源码） | ✅ §2.1（其走实时 `llm/stream`，不能回填历史） |
| 追加：OTLP 兼容评估 | ✅ §2.3（含体积量化与零依赖路径） |
| 追加：OpenLIT GPU 管线研读 | ✅ §2.4（含对 1-planning 的纠偏） |

---

## 7. 遗留与开放问题

- **OQ-P0-1 混合 era 会话**：一个会话内切换 provider 时，era 标在会话还是调用？（建议：调用粒度存事实，会话粒度存「主 era + mixed 标记」）
- **OQ-P0-2 子代理会话**：`delegationDepth > 0` 的会话是否计入对照集与 TTFT 基线？（本机 18 份日志内含子代理会话，未分离统计）
- **OQ-P0-3 内嵌流的稳定性**：`data.stream` 是否受宿主配置/日志格式版本影响？当前实测 v3 格式 100% 覆盖；**Phase 1 首日需复核**（若未来格式变更导致缺失，须有「TTFT 缺席即整列缺席」的降级路径）。
- **OQ-P0-4 nvidia-smi 字段实测**：8 GB Laptop GPU 上 `--query-gpu` 的可用字段与刷新语义（显存/利用率/温度/功耗），Phase 1 动工首日实测并做版本化快照测试。

---

## 关联文件

- [../1-planning/nautilus-opening-report.md](../1-planning/nautilus-opening-report.md) — 上游：总体设计、Phase 计划、R1–R8
- [../1-planning/nautilus-research-2-positioning.md](../1-planning/nautilus-research-2-positioning.md) — 上游：定位、L0–L3 阶梯、R9–R11
- [./evidence-phase0-20260912.md](./evidence-phase0-20260912.md) — 本轮证据归档（命令与原始输出）
