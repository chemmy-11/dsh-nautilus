# DSH Nautilus 开题报告

**课题名称**：端侧 AI Ops 全链路可观测性聚合——面向个人 AI 工作负载的三层指标闭环与关联归因

| 项 | 值 |
|---|---|
| 版本 | v0.1（draft，待开发组评审） |
| 日期 | 2026-09-12 |
| 前身文档 | 《DSH Nautilus 插件开发规划书 v1.1》（AI 起草）——本报告在其方向上重做技术设计与调研支撑，差异见附录 A |
| 基座仓库 | `dsh-nautilus`（原 `dsh-nautilus`；应用层插件，功能冻结待迁移） |
| 状态 | 含 **3 个待决策点（D1–D3）**，决策通过后方可进入 Phase 0 |

---

## 0. 摘要

本课题在已验证的应用层观测闭环（dsh-nautilus：268 轮 / 3.99 亿 token 真实会话、缓存未命中率分桶定位、主客观交叉验证）基础上，向下扩展系统资源层与模型推理层，以核心调度层完成三层指标的时间对齐与关联归因，形成端侧 AI Ops 全链路闭环。与现有云数据中心方案（DeepFlow、Prometheus 系、LLM tracing 生态）对比，本课题的定位空隙在于：**单机 Windows 端侧、观测对象跨越 API 时代与本地部署时代的切换、假设驱动的闭环归因**。报告给出同类工作综述、指标口径的行业标准对齐、era 因果上下文设计、运行时选型决策点与修订后的阶段计划。

---

## 一、课题背景与问题提出

### 1.1 背景

LLM 工作负载正从数据中心向个人端侧迁移（本地推理、Agent 桌面工具、知识库会话），但可观测性工具生态仍呈两极：

- **系统监控生态**（Netdata、Prometheus 系）只懂资源语义，不理解 token、缓存命中、推理延迟；
- **LLM 观测生态**（OpenLLMetry、Langfuse、Phoenix 等）只到应用/链路层，观测单元止步于 request/trace，不闭合到 OS 与 GPU 资源层；
- **跨层关联方案**（DeepFlow 等）面向 Linux/K8s 数据中心，依赖 eBPF，无法落地 Windows 个人端。

对「个人 AI 工作负载」（一个宿主进程 + 一条 LLM 通路 + 一个知识库）做**跨层、跨时代、闭环归因**的观测，目前没有现成方案。这是本课题的选题依据。

### 1.2 已有基础（dsh-nautilus 现状盘点）

| 能力 | 现状 | 对本课题的意义 |
|---|---|---|
| 会话遥测 | 官方 `session/event` 直采，零宿主源码修改；逐轮 `token_in/out`、`cache_read`、`duration_ms`、`tps`（`src/store.ts`） | API 时代的「模型层」指标**大半已存在**，Phase 2 的真实工作是注册与补口，不是新采集 |
| 数据规模 | 268 轮 / 3.99 亿 token 真实交互 | 归因研究有真实底料，非玩具数据 |
| 分析管线 | 形态分类 / τ_e 检出 / 分桶对照，首轮实证 13.7% vs 5.6% | 分桶方法可复用到跨层对照 |
| 方法论 | 主客观交叉验证、预言检验表（P1–P9）、证据归档、可重复管线 | 防止关联归因退化为相关系数表演的纪律基础 |
| 工程 | 纯 TS Cordis 插件，CI 门禁 + tag 发布，SQLite 私有存储（`~/.dsh/nautilus/`） | 聚合包的安装链与数据目录约束 |

### 1.3 核心研究问题

- **RQ1（指标统一）**：三层异构指标（5s 采样 gauge、每请求事件、逐轮事件）如何用统一口径建模，使跨层对照在语义上成立？——采用 OpenTelemetry GenAI 语义约定 + USE 方法对齐（§4.2）。
- **RQ2（时间对齐）**：秒级采样与毫秒级事件在统一存储上如何高效对齐？——统一长表 + 对齐窗口定义（§4.3）。
- **RQ3（因果上下文）**：**观测对象在 API 模型与本地部署之间切换时，如何保证归因不跨因果边界？**——本课题提出 era 因果上下文设计（§4.4）。这是对前身规划书最关键的修正：应用层当前流量命中云端 API，本机 GPU/KV Cache 与云端缓存命中率之间不存在因果通路，不显式声明时代就无法解释归因结果。

---

## 二、同类工作调研

> 调研说明：检索于 2026-09-12，来源以官方文档与仓库为准（链接见 §九）。LLM 生态迭代快，Phase 2b 启动前需复核版本现状。

### 2.1 系统资源层采集

| 项目 | 形态 | 资源开销（量级） | 可借鉴 | 不可用/不适用 |
|---|---|---|---|---|
| Netdata | 一体化 agent + 内置看板 + dbengine | ~150–300 MB 内存，每秒级采集 | 指标全景与开箱体验；**内置无监督 ML 异常检测**（端侧 AIOps 的现成参照） | 对单机个人端过重 |
| node_exporter + Prometheus | 极简拉模型 exporter | ~10–30 MB | 指标口径与命名纪律 | 需自建整套栈，Windows 支持为功能子集 |
| Telegraf | 插件式管道（input→processor→output） | ~30–80 MB | 「采集插件向注册中心声明」的架构，与 nautilus-core 的指标注册同构 | 引入 InfluxDB 生态依赖 |
| psutil / 性能计数器 | 编程接口 | 可忽略 | **Windows 亲和的事实标准**，覆盖 CPU/内存/磁盘/网络 | 无 |
| [systeminformation](https://github.com/sebhildebrandt/systeminformation)（3.1k★）/ [pidusage](https://github.com/soyuka/pidusage)（545★） | 编程接口（Node） | 可忽略 | Node 侧对应物：前者系统全景 API，后者跨平台**进程级** CPU%/RSS——`pulse.proc.dsh.*` 的直接基座 | GPU 不在其射程（需 nvidia-smi 轮询） |

结论：端侧采集走**编程接口（psutil 类）而非部署独立 agent**；指标口径采用 USE 方法（Utilization / Saturation / Errors，Brendan Gregg）组织，避免堆砌裸数字。

### 2.2 GPU 遥测

- 数据中心标准为 **NVIDIA DCGM / dcgm-exporter**（利用率、显存、温度、SM 占用、ECC），口径可作为 `gpu.*` 指标族参照；
- 单机工具 [nvitop](https://github.com/XuehaiPan/nvitop)（7.1k★，NVML 轮询 + 内置 Prometheus exporter 模式）/ `nvidia-smi dmon` 证明 NVML 轮询路线在个人端可行，Windows 下 `nvidia-smi` 可用；
- **降级口径必须预设**：无 N 卡时 GPU 指标族整体缺席，验收标准不能硬性依赖显存读数。

### 2.3 推理引擎观测（本课题 Phase 2b 的直接对标）

| 引擎 | 原生指标能力 | 关键指标（实测文档口径） |
|---|---|---|
| **vLLM** | 原生 Prometheus `/metrics`，**指标最全，本地时代首选** | `vllm:time_to_first_token_seconds`、`vllm:request_time_per_output_token_seconds`、`vllm:e2e_request_latency_seconds`、`vllm:request_queue_time_seconds`、`vllm:kv_cache_usage_perc`（1=100%）、`vllm:num_requests_running/waiting`；前缀缓存为计数器 `vllm:prefix_cache_hits/queries`（命中率需相除计算） |
| **Ollama** | **无原生 `/metrics`**（[issue #3144](https://github.com/ollama/ollama/issues/3144) 长期开放）；社区靠 dcgm-exporter + node_exporter + 第三方 exporter 拼装 | 但 `/api/chat`、`/api/generate` 响应自带 `load_duration` / `prompt_eval_duration` / `eval_duration` / `prompt_eval_count` / `eval_count`，可推导 TTFT 近似与 TPS——不依赖 /metrics 也能达到最小闭环 |
| llama.cpp server | 内置 Prometheus `/metrics`（token 计数族） | 备选 |
| NVIDIA GenAI-Perf（测量工具，非引擎） | [perf_analyzer](https://github.com/triton-inference-server/perf_analyzer) 仓库内的 GenAI-Perf | TTFT/TPOT/并发/吞吐的**标准化测量方法学**——Phase 2b 自研采集的口径参照 |
| 社区 [ollama-exporter](https://github.com/frcooper/ollama-exporter)（47★） | Ollama 的 Prometheus exporter 社区先例 | Phase 2b 走 Ollama 路线时的口径参考 |

**对前身规划书的纠偏**：3.2 节「KV Cache 占用——采集方式 pynvml」不成立。pynvml 只有进程/总显存；KV cache 用量是引擎内部量，仅 vLLM 等暴露（`kv_cache_usage_perc`）。Ollama 路线该指标降级为「推理进程显存增量近似」。

### 2.4 LLM 应用/链路观测生态

生态图谱（均为活跃开源，本轮未逐个深调研）：

- **OpenLLMetry（Traceloop）**：OpenTelemetry 原生的 LLM SDK 埋点方案；
- **OpenLIT**（[openlit/openlit](https://github.com/openlit/openlit)，2.7k★）：OTel 原生，且已含 **GPU/主机监控（nvidia-smi 路线）**、扩展至 coding agents 观测——「LLM trace + GPU 指标」同屋檐的开源先例；形态为 SDK + 自托管服务端（ClickHouse），与 Nautilus「插件聚合、零服务化」不同；
- **Langfuse**、**Arize Phoenix**：应用层 tracing + eval，自托管友好；
- **Helicone**：网关代理式，成本/延迟/缓存观测；
- **OpenInference**（[Arize-ai/openinference](https://github.com/Arize-ai/openinference)，1.2k★）：LLM/Agent trace 的另一套语义约定（OTel 兼容）——指标命名对齐时的第二参照。

**对齐基准：OpenTelemetry GenAI 语义约定**（已独立为 [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) 仓库）：

| 指标 | 状态 | 本课题对应 |
|---|---|---|
| `gen_ai.client.operation.duration` | 稳定 | nautilus 逐轮 `duration_ms`（已有） |
| `gen_ai.client.token.usage`（`gen_ai.token.type=input/output`） | 稳定 | nautilus `token_in/out`（已有） |
| `gen_ai.server.time_to_first_token` | incubating | API 时代待验证可得性（§4.4/Phase 0）；本地时代取 vLLM `time_to_first_token_seconds` |
| `gen_ai.server.time_per_output_token` | incubating | nautilus `tps` 的倒数语义；vLLM `request_time_per_output_token_seconds` |

**共同局限**：以上方案全部是「服务端/应用侧」视角，不闭合资源层——这正是本课题与它们的分界线。采用其命名体系的价值：指标口径外部可比，未来可无痛桥接 OTel 生态。

### 2.5 跨层关联与 AIOps 归因

- **DeepFlow**（Apache-2.0）：当前跨层关联的工程标杆——eBPF 零侵扰采集，universal map + SmartEncoding 将云资源/K8s/CMDB 标签**注入所有信号**实现全栈关联，可作 OTel/Prometheus 的存储后端，profile 开销 <1%，关联链路可下探到内核与 CUDA 函数。**但其架构锚定 eBPF，Linux/K8s 专属，Windows 个人端不可用**。可借鉴的是思想：**全栈标签传播**（对应本课题的 era + session/model 标签设计）与「零侵扰」伦理（对应本课题的零宿主源码修改原则）。
- **[microsoft/ebpf-for-windows](https://github.com/microsoft/ebpf-for-windows)**（3.5k★）：eBPF 的 Windows 实现——DeepFlow 式「零侵扰全栈」在 Windows 端侧的远期可能性钩子（pulse 的 v2 方向，本期不依赖）；
- **Apache SkyWalking**：APM 三柱（指标/日志/trace）的成熟实现，归因仍以人工下钻为主。
- **Netdata** 内置 ML 异常检测：端侧「异常打点→人工归因」的现成参照，与本课题「机器打点、人下结论」的立场一致。
- 学术界的根因分析多走三柱数据时序对齐 + 因果发现路线，尚未见到面向「个人端侧 AI 工作负载跨 API/本地时代」的封闭工作（调研范围内）。

### 2.6 差距分析与课题定位

| 维度 | 数据中心方案 | LLM 观测生态 | 本课题（Nautilus） |
|---|---|---|---|
| 部署环境 | Linux/K8s 集群 | 服务端应用 | **单机 Windows 端侧** |
| 观测纵深 | app→内核→CUDA | 止步应用层 | OS/GPU ↔ 推理 ↔ 应用三层闭合 |
| LLM 语义 | 无 | 有（但不下沉） | 有，且贯通三层 |
| 观测对象切换 | 固定拓扑 | 固定拓扑 | **era 显式建模（API↔本地）** |
| 归因方式 | 平台内置/黑盒 | 无 | **假设驱动闭环，结论人工主导** |

---

## 三、研究目标

- **G1** 三层指标统一建模：对齐 OTel GenAI 命名 + USE 口径，一份指标口径文档覆盖三层；
- **G2** 时间对齐管道：统一长表 + 对齐窗口，core 可输出任意事件的同期跨层快照；
- **G3** 因果上下文显式化：era 设计落地，归因报告强制声明时代与对照集；
- **G4** 假设驱动的关联归因：至少 1 个真实排障案例走完「假设→采集→验证→归档→检验表回写」全流程。

---

## 四、总体设计

### 4.1 架构

```
┌──────────────────────────── DSH Nautilus ────────────────────────────┐
│                                                                       │
│  pulse（OS/GPU 层）         infer（模型推理层）        nexus（应用层）    │
│  系统指标 5s 轮询            API 时代：会话事件派生       现有 dsh-nautilus  │
│  + dsh 宿主进程级指标        本地时代：引擎 /metrics      功能冻结，只加接口│
│        │                        │                        │            │
│        └───────────┬────────────┴────────────────────────┘            │
│                    ▼                                                  │
│               nautilus-core                                           │
│    指标注册 · era 因果上下文 · 时间窗对齐 · 关联快照 · 插件生命周期       │
│                    ▼                                                  │
│      SQLite（~/.dsh/nautilus/，长表 + 事件表 + 现有 turn 库）              │
│                    ▼                                                  │
│            看板 / 关联快照报告 / 归因案例归档                            │
└───────────────────────────────────────────────────────────────────────┘
```

注意：pulse / infer / nexus 是**三路并行数据源汇入 core**，非串行管道（修正前身规划书的数据流图）。

### 4.2 指标口径与命名

统一命名 `nautilus.<layer>.<metric>`，语义对齐行业标准，tags 携带 `era / host / pid / device / model / session`：

| 指标 | 层 | 含义 | 行业对齐 | 采集 | 频率 | 异常阈值（初值） |
|---|---|---|---|---|---|---|
| `nautilus.pulse.cpu.utilization` | OS | CPU 使用率 | USE / psutil | psutil 类接口 | 5s | >85% 持续 3 窗 |
| `nautilus.pulse.cpu.ctx_switches` | OS | 上下文切换速率 | USE(Saturation) | 同上 | 5s | — |
| `nautilus.pulse.mem.used` / `swap.used` | OS | 内存/交换 | USE | 同上 | 5s | >90% |
| `nautilus.pulse.disk.io_rate` | OS | 磁盘读写速率 | USE | 同上（**统一 psutil，不用 /proc、iostat**） | 5s | — |
| `nautilus.pulse.net.io_rate` | OS | 网络收发速率 | USE | 同上 | 5s | — |
| `nautilus.pulse.proc.dsh.<rss|cpu>` | OS | **dsh 宿主进程级** | USE(进程视角) | 同上 | 5s | 与应用层弱因果对照的主指标 |
| `nautilus.pulse.gpu.<util|mem|temp>` | OS | GPU 利用率/显存/温度 | DCGM 口径 | nvidia-smi/NVML 轮询；**无 N 卡整族缺席** | 5s | 显存 >95% |
| `nautilus.infer.turn.duration` | 应用/模型 | 逐轮耗时 | `gen_ai.client.operation.duration` | nautilus 已有 `duration_ms` | 每轮 | P95 基线偏移 |
| `nautilus.infer.turn.tokens` | 应用/模型 | 输入/输出 token | `gen_ai.client.token.usage` | nautilus 已有 | 每轮 | — |
| `nautilus.infer.turn.tps` | 应用/模型 | 解码吞吐 | `time_per_output_token` 倒数语义 | nautilus 已有 | 每轮 | — |
| `nautilus.infer.turn.ttft` | 模型 | 首 token 延迟 | `gen_ai.server.time_to_first_token` | **待 Phase 0 验证宿主事件可得性** | 每轮（若可得） | — |
| `nautilus.infer.session.model/endpoint` | 应用 | 命中的模型/端点 | OTel 属性 | session/event 字段落库 | 每会话 | era 判定依据 |
| `nautilus.infer.engine.ttft/tpot` | 模型 | 引擎侧 TTFT/TPOT | vLLM `time_to_first_token_seconds` 等 | vLLM `/metrics`（本地时代） | 每请求 | — |
| `nautilus.infer.engine.kv_cache_usage` | 模型 | KV cache 占用比 | vLLM `kv_cache_usage_perc` | 仅 vLLM；Ollama 降级为显存增量近似 | 每请求/轮询 | >90% |
| `nautilus.infer.engine.queue` | 模型 | 排队/并发 | vLLM `num_requests_running/waiting`、`request_queue_time_seconds` | 同上 | 每请求 | waiting 持续 >0 |

### 4.3 数据模型与存储

沿用 `~/.dsh/nautilus/`；驱动沿用现有 `node:sqlite`（`DatabaseSync`，零依赖，`src/store.ts` 已用，符合插件零依赖惯例）；新增两张表，**不与现有 turn 库混表**（修正前身「写入同一张表」的 schema 坏味道）：

```sql
-- 采样型（pulse 全部 + infer 引擎 gauge）
CREATE TABLE metric_sample (
  ts      INTEGER NOT NULL,   -- epoch ms，采集器统一宿主机时钟
  layer   TEXT    NOT NULL,   -- 'pulse' | 'infer'
  metric  TEXT    NOT NULL,   -- 'pulse.cpu.utilization'
  value   REAL,
  tags    TEXT,               -- JSON: {host,pid,device,era,...}
  era     TEXT    NOT NULL DEFAULT 'api'   -- 冗余列，归因过滤主键之一
);
CREATE INDEX idx_sample_q ON metric_sample(metric, ts);

-- 事件型（infer 引擎每请求 + 未来扩展）
CREATE TABLE metric_event (
  ts INTEGER NOT NULL,
  layer TEXT NOT NULL,        -- 'infer'
  metric TEXT NOT NULL,
  value REAL,
  attrs TEXT,                 -- JSON: {model,endpoint,session,request_id,...}
  era TEXT NOT NULL DEFAULT 'api'
);
```

**保留策略**：`metric_sample` 原始 5s 档保留 14 天，聚合为 1min 档长期保留；turn/事件表永久（延续现有库惯例）。启动时校验体积并 vacuum。

**对齐窗口**：任意事件 E 的「同期快照」= `metric_sample` 中 `ts ∈ [E.ts−w, E.ts+w]` 的窗口聚合（默认 w=30s，中位数口径），窗口宽度进归因报告元数据。

### 4.4 era 因果上下文（本课题关键设计）

1. **定义**：某时段的 era 由「该时段应用层流量实际命中的推理端点」决定；`api` = 云端 API，`local` = 本地推理栈。
2. **落库**：会话记录补 `model` / `endpoint` 字段（大概率 session/event 已含，Phase 0 确认）；指标源注册时声明 era 标签；两张新表带 era 列。
3. **归因规则**：归因报告强制声明 era 与对照集——
   - `api` 时代对照集 = { `pulse.proc.dsh.*` 宿主进程级, `infer.turn.*` }（客户端资源争用影响体感的**弱因果**，结论措辞用「对照」而非「归因」）；
   - `local` 时代对照集 = 全三层（强因果闭合）。
4. **切换**：本地部署落地后，core 切换 era 上下文即可，Phase 0–3 的管道工作零改动复用；历史数据按 endpoint 回溯分类（与 nautilus 已有的 vault 指向回溯机制同构，设计直接复用）。

### 4.5 运行时选型（**决策点 D1**）

Phase 1 的采集器就是未来 pulse 本体，语言决策必须先于第一行代码，否则违背「跑通即归档」的积累原则：

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. 全 Node**：`systeminformation`（系统全景）+ `pidusage`（进程级）+ `nvidia-smi` 轮询解析 | 单运行时；聚合包仍是一个 dsh 插件，`dsh plugin add` 安装链不断；Windows 亲和；与 nautilus 工程链（TS/CI/测试）统一 | GPU 指标依赖 nvidia-smi 输出解析（脆弱点，需版本化快照测试；OpenLIT 有现成 nvidia-smi→OTel 实现可借鉴） | **推荐** |
| **B. Python 采集器**（psutil+pynvml）+ core 经 child_process/文件接力 | 采集生态最成熟，原型最快 | 双运行时：分发碎片化，`dsh plugin add` 体验破坏，Phase 4 集成与跨机复现都要处理 Python 环境 | 备选 |
| **C. Python 独立 pip 包**，core 只读其 SQLite | 最解耦 | 「聚合包」名存实亡，装机复杂度最高 | 不倾向 |

**其余两个决策点**：

- **D2 聚合包载体**：本仓库原地演进 vs 新建 monorepo 仓库。**建议推迟到 M4 收尾后**再定；Phase 0–2b 期间所有新代码放独立目录/仓库，不碰 `dsh-cowork` 主线。
- **D3 本地推理栈首选**：**建议 vLLM**（指标最全、KV cache 可观测），Ollama 作为易用备选（无 /metrics，靠 API 响应字段推导）；若本地硬件不支持 vLLM 部署形态，Phase 2b 启动时重议。

---

## 五、研究方法与验证设计

1. **最小闭环法**：每 Phase 产出一个可运行、可复现、有验收标准的闭环，附运行命令与预期输出。
2. **证据归档**：每 Phase 输出《证据归档文档》（执行命令 / 预期输出 / 实际输出 / 观察结论），延续仓库现有惯例。
3. **注入自检**：Phase 3 用人为注入异常（如 CPU 压力）验证管道连通性——**明确定性为管道自检，不作为归因能力证明**。
4. **假设驱动归因**：真实排障（Phase 5）必须先立假设、预登记预言（延续预言检验表方法），再查数验证；归因结论人工主导，AI 仅辅助检索与编码。
5. **主客观交叉验证**：延续 nautilus 的双指标互相限制偏差原则——客观曲线有混杂变量，主观自评有报告偏差，跨层归因报告同样要求双源佐证。

---

## 六、阶段计划（修订版）

| Phase | 目标 | 产出 | 验收标准 | 预估 | 依赖 |
|---|---|---|---|---|---|
| **0** | 选型与因果链确认 | D1/D2/D3 决策纪要；era 设计定稿；宿主事件 TTFT/model/endpoint 字段可得性验证报告 | 决策纪要归档；TTFT 可得性有明确结论（可得→字段定义；不可得→API 时代放弃并记录） | 1 天 | 无 |
| **1** | pulse 最小闭环 | 采集器（5s 轮询 ≥6 类指标，含 dsh 宿主进程级，写入 `metric_sample`） | 连续运行 1 分钟输出 ≥3 指标时间序列；**连续 1 小时无内存增长**；证据归档 | 2 天 | D1 |
| **2a** | 模型层·API 时代 | 已有逐轮 duration/tps/token 注册进 core 指标注册表；`model`/`endpoint` 字段落库 | core 可按会话查询逐轮模型层指标 | 1 天 | Phase 0 |
| **2b** | 模型层·本地时代 | 引擎侧采集器（vLLM `/metrics` → `metric_event`/gauge） | 与 pulse 同库；TTFT/TPOT/KV cache 落表；证据归档 | **挂起至本地部署完成**（解除条件：本地推理栈可用且有一条会话流经） | D3 |
| **3** | core 管道与对齐 | 指标注册中心；时间窗对齐；注入异常 → 同期跨层快照报告 | 模拟异常输出关联快照报告（含 era 声明与窗口参数），证据归档 | 2–3 天 | Phase 1、2a |
| **4** | DSH 集成 | 各子插件 manifest；宿主生命周期事件订阅；bad case 筛选封装为 DSH 工具；聚合包安装链 | `dsh plugin add` 全链路在干净环境跑通（CI 化） | 3 天 | Phase 3；**D2 已决**；M4 已收尾 |
| **5** | 真实排障案例 | ≥1 个案例走完假设→采集→验证→归档→检验表回写 | 案例文档含证据链与反事实讨论 | 持续 | Phase 3（era=local 时价值完全兑现） |

执行约束（继承前身规划书并加严）：每次只推进一个 Phase；技术选型出 2–3 方案对比由开发组决策；**Phase 0–2b 不触碰 dsh-cowork 主线仓库**（与 M4.11 并行不冲突；冲突从迁移/改名开始，而迁移被排在 M4 收尾之后）。

---

## 七、预期成果

1. **Nautilus 原型**：pulse + core + 2a（API 时代闭环）可运行，本地部署落地后 2b 零改动接入；
2. **指标口径文档**：三层指标一张表，命名对齐 OTel GenAI，含阈值与降级口径；
3. **管道自检证据**：注入异常的关联快照报告（含 era 与窗口元数据）；
4. **真实排障案例 ≥1**：假设驱动、证据链完整、预言检验表回写；
5. **era 切换的可重用性证明**：同一套管道跨越 API→本地时代的对齐能力。

---

## 八、风险与应对

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | era 未显式化导致跨时代假关联（如拿本地 GPU 温度「归因」云端缓存未命中） | 高 | 高（结论不可信） | era 列强制；报告强制声明时代与对照集；评审人工把关 |
| R2 | 相关被过度解读为因果 | 高 | 高 | 结论措辞分级（api 时代只用「对照」）；假设驱动流程；归因人工主导 |
| R3 | 双运行时导致分发碎片化 | 中 | 高 | D1 前置决策；Phase 4 安装链 CI 验证 |
| R4 | Windows 采集 API 差异（无 /proc、iostat） | 高 | 低 | 统一 psutil 类接口；禁止 Linux 专属工具进依赖 |
| R5 | 无 N 卡 / Ollama 无 KV cache 指标 | 中 | 低 | GPU 族整体降级口径；D3 倾向 vLLM；降级口径写进指标文档 |
| R6 | 5s 采样致 SQLite 膨胀（现库已有 399M token 数据） | 中 | 中 | 保留 + 降采样策略（§4.3）；启动体积校验 |
| R7 | 与 M4 主线冲突 | 中 | 中 | Phase 0–2b 隔离于主线仓库；迁移/改名排在 M4 收尾后（D2） |
| R8 | nvidia-smi 输出格式随驱动版本漂移（方案 A） | 中 | 低 | 解析层加版本化快照测试；失败时 GPU 族降级缺席而非报错 |

---

## 九、参考来源

1. OpenTelemetry GenAI 语义约定（独立仓库）：https://github.com/open-telemetry/semantic-conventions-genai
2. vLLM 生产指标文档（TTFT/TPOT/KV cache 等，2026-09 实测口径）：https://docs.vllm.ai/en/latest/usage/metrics.html
3. Ollama 原生 /metrics 诉求（长期开放 issue）：https://github.com/ollama/ollama/issues/3144
4. DeepFlow（eBPF 全栈关联，Linux/K8s）：https://github.com/deepflowio/deepflow
5. NVIDIA GPU 遥测 / DCGM：https://docs.nvidia.com/datacenter/cloud-native/gpu-telemetry/latest/kube-prometheus.html
6. 社区 Ollama + NVIDIA GPU 看板（Grafana ID 25193）：https://grafana.com/grafana/dashboards/25193-neurix-ollama-nvidia-gpu/
7. USE 方法（Brendan Gregg）：https://www.brendangregg.com/usemethod.html
8. Netdata（端侧一体化 + ML 异常检测）：https://github.com/netdata/netdata
9. 本仓库 README（dsh-nautilus 现状与指标口径）：./README.md
10. systeminformation（Node 系统全景 API，3.1k★）：https://github.com/sebhildebrandt/systeminformation
11. pidusage（跨平台进程级 CPU/RSS，545★）：https://github.com/soyuka/pidusage
12. nvitop（NVML GPU 监控 + exporter 模式，7.1k★）：https://github.com/XuehaiPan/nvitop
13. NVIDIA GenAI-Perf（TTFT/TPOT 标准化测量，位于 triton perf_analyzer 仓库）：https://github.com/triton-inference-server/perf_analyzer
14. OpenLIT（OTel 原生 LLM/GPU 观测，2.7k★）：https://github.com/openlit/openlit
15. OpenInference（Arize LLM trace 语义约定，1.2k★）：https://github.com/Arize-ai/openinference
16. microsoft/ebpf-for-windows（Windows eBPF，远期钩子，3.5k★）：https://github.com/microsoft/ebpf-for-windows
17. frcooper/ollama-exporter（Ollama 社区 Prometheus exporter，47★）：https://github.com/frcooper/ollama-exporter

---

## 附录 A：相对前身规划书（v1.1）的修订清单

| 位置 | 原文 | 修订 | 理由 |
|---|---|---|---|
| 数据流 | pulse→infer→nautilus→core 串行管道 | 三路并行源汇入 core | 实际依赖关系，避免实现者误做串联 |
| 3.2 指标源 | KV Cache 占用 = pynvml | 仅 vLLM `kv_cache_usage_perc`；Ollama 降级为显存增量近似 | pynvml 无 KV cache 语义（§2.3） |
| 3.2 Phase 2 | 选型 Ollama/vLLM 抓 /metrics | 拆为 2a（API 时代：注册已有逐轮指标）+ 2b（本地时代，挂起） | 当前流量命中云端 API，本地推理指标与应用层数据无因果通路（RQ3） |
| 3.1 采集方式 | psutil / iostat、/proc/net/dev | 统一 psutil 类接口 | Windows 无 /proc、iostat |
| 3.4 数据管道 | 「写入同一时序存储（SQLite）」 | 长表 + 事件表分置，era 列，保留/降采样策略 | 混表 schema 坏味道；5s 采样增长控制 |
| 四-2 插件注册 | （未展开） | 运行时决策 D1 前置：全 Node（推荐）/Python 外挂/pip 独立包 | DSH 插件机制装不进 Python 进程，决策晚于 Phase 1 将导致重写 |
| 开发路线 | Phase 1 为 P0，未处理与主线关系 | 新增 Phase 0（选型+因果链确认）；Phase 0–2b 隔离于主线，迁移排 M4 收尾后 | 与 M4.11 并行不冲突，冲突后移 |
| 归因表述 | 「自动关联归因」 | 管道自检（注入）与真实归因（假设驱动）分离；api 时代结论只称「对照」 | 防止相关/因果混淆与过度承诺 |

**保留不动的**：四模块架构、最小闭环优先、跑通即归档、每 Phase 验收标准、2–3 方案对比由开发组决策、归因结论人工主导、nautilus 功能冻结仅加接口。
