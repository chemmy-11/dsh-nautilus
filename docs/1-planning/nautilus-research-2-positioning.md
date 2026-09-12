# Nautilus 第二期调研：产品定位与路线（Agent 工作台形态）

| 项 | 值 |
|---|---|
| 版本 | v0.1（draft，待开发组评审） |
| 日期 | 2026-09-12 |
| 前序文档 | [开题报告（第一期：技术调研与总体设计）](./nautilus-opening-report.md) |
| 本期范围 | **路线与产品定位**；技术设计以第一期为准，不重复 |
| 定位锚点（开发组已明确） | ① 形态 = DSH 插件**聚合包**；② 最终呈现 = **基于 DSH 内核的、面向 AI Ops 全链路的 Agent 工作台** |
| 证据等级说明 | DSH 生态插件均为 GitHub 实证（本期逐条核验）；国际大厂为官方文档/发布稿；**国内大厂部分（华为/腾讯产品描述）沿用开发组第一版报告，未独立核验，已标注** |

---

## 一、竞争格局全景

### 1.1 国际线（本期自研调研）：三条产品线正在合流

**A 线 · 观测 Agent 的平台**（观测对象 = LLM 应用/Agent）

| 产品 | 核心形态 | 观测闭环 |
|---|---|---|
| LangSmith | trace → monitor（成本/延迟 P50/P99/在线 eval）→ Insights（trace 自动聚类找失败模式）→ eval；SmithDB 自研 trace 库，自托管/VPC 可选 | 「Trace → Monitor → Analyze → Iterate」，迭代靠人加评测 |
| AgentOps | 会话 trace 可视化 + **Time Travel 回放**（时间点级重放 agent 运行）+ 成本监控 + 调试审计 | 回放式调试闭环 |
| **OpenLIT**（[openlit/openlit](https://github.com/openlit/openlit)，2.7k★） | OTel 原生 SDK + 自托管服务端（ClickHouse）；**已含 GPU/主机指标（nvidia-smi 路线）**，并扩展至 coding agents（claude-code/codex/cursor）观测 | 采集覆盖最广的开源平台；但闭环止于 trace/看板/评测，**无跨层时间对齐与归因** |
| Braintrust / W&B Weave / Arize | 同赛道，eval 与实验管理侧重（本期未逐个深调研） | — |

**局限**：观测单元止步于 request/trace，不闭合 OS/GPU 资源层；SaaS 为主，数据出本地。

**B 线 · 干运维活的 Agent**（观测对象 = 基础设施/云资源，Agent 是运维主体）

| 产品 | 关键能力 |
|---|---|
| **Datadog Bits AI** | 五件套：Bits Chat（自然语言查遥测/建看板）、**Bits Investigation（"AI SRE" 自主调查告警、给根因、写 postmortem）**、Bits Code（基于生产遥测生成修复代码）、Security Analyst（自动分诊 SIEM）、**Agent Builder（用户自建调查/修复 agent，2000+ 预置动作）**。明确的话术：agent 自主行动 + 人保持知情与控制（human-in-the-loop） |
| **Grafana Assistant** | 2025-10 GA；Assistant Investigations：分析观测栈、**生成 findings 与 hypotheses**、给缓解建议；前身 Sift 做自动诊断检查；2026-07 扩展六项 agentic 能力（分析 profile、开 PR、生成看板、Slack 协作等） |

**C 线 · 工具化与协议化**（运维数据 → agent 可用工具）

| 事实 | 说明 |
|---|---|
| **Grafana 官方 MCP server**（[mcp-grafana](https://github.com/grafana/mcp-grafana)） | 开源，把看板/指标/告警暴露为 agent 工具，含 agent observability 工具组 |
| **Datadog 官方 MCP server** | 官方文档定位：「Datadog 观测数据与任何支持 MCP 的 AI agent 之间的桥梁」 |
| **OpenAI AgentKit** | Agent Builder（可视化拖拽画布）+ ChatKit（现成 agentic UI）+ Evals + Guardrails——大厂把「工作台」做成产品级形态 |
| **Claude Code 遥测** | 官方 OTel 指标/事件导出（token 用量、会话、成本等）供外部后端消费——coding agent 厂商把「自身可观测」作为一等能力 |

**合流判断**：三条线正汇聚为同一个命题——**Agentic Ops：agent 成为运维的主体**。数据侧的标准动作是「观测数据工具化」（MCP 已成事实协议），行为侧的标准动作是「调查归因 agent 化」（Bits Investigation / Assistant Investigations），界面侧从 dashboard 走向 chat + canvas（AgentKit/Agent Builder）。

### 1.2 国内线（沿用开发组第一版报告，未独立核验）

- **华为云 AgentArts**：AgentStudio（开发态）+ AgentRun（运行态）+ **AgentOps（运营运维态）**三组件；华为 AIOps 三阶段演进（传统 ML+专家经验 → 串并联智能运维 → **LLM + AI Agent + 运维小模型深度融合**）；智能全栈可观测四层指标体系（业务/应用/中间件/基础设施）。
- **腾讯云 CloudQ**：ChatOps + AIOps + CloudOps 三栈一体的 Cloud DevOps Agent，**7×24 主动巡检/主动诊断/主动决策**，全渠道接入——与国际线 Bits Investigation / Assistant Investigations 的国内对应物。
- **腾讯云 ADP 4.0**（建管一体）、**嘉为蓝鲸 OpsPilot**（知识库+工具调用+LLM 三位一体）。

同构性：华为「开发/运行/运维三态」≈ AgentKit（开发）+ APM（运行）+ Bits AI（运维）的大厂分工；CloudQ 主动巡检 ≈ Investigation 类产品。**国内外大厂对「Agentic Ops」的判断一致，只是载体是云平台。**

### 1.3 DSH 生态（本期逐条 GitHub 实证，全部真实存在）

| 插件 | 实证 | 定位 | 与 Nautilus 的关系 |
|---|---|---|---|
| [loongsuite/dsh-plugin](https://github.com/loongsuite/dsh-plugin)（阿里 LoongSuite，24★，2026-08-15 建） | ✅ | 把 DSH 每个 agent turn 转成 **OTel GenAI span 树**（steps / LLM 调用**含 TTFT** / 工具执行 / token 用量），标准 OTLP 导出至 Jaeger/Tempo/SigNoz/Langfuse | **关键相邻**：① 证明 OTel GenAI 语义已在 DSH 生态落地（第一期 D 设计选对了基准）；② 它能产出 TTFT → **DSH 原生事件流里有足够的逐级时间戳，Phase 0 的 TTFT 可得性问题有一条读源码即答的捷径**（§五） |
| [TencentCloud/tencentcloud-agentobs-sdk-dsh](https://github.com/TencentCloud/tencentcloud-agentobs-sdk-dsh)（**腾讯云官方组织**，13★，2026-08-18 建） | ✅ | 观察 DSH 原生 session/agent loop/LLM stream/tool 生命周期，转成五层 span 模型（entry→agent→step→chat→tool）上报**云端 CLS** | 数据源参考（结构化 span 字段设计）；**更重要的是信号：云厂商官方组织已在给 DSH 出观测插件，方向是上云** |
| [xingzhen199186/dsh-insight-tree](https://github.com/xingzhen199186/dsh-insight-tree)（2026-09-07 建） | ✅ | DSH 运行时可观测 + 插件诊断面板（Profile 装了什么/插件是否加载/兼容性） | 相邻不重叠：观测 **DSH 自身健康**，非 AI Ops 全链路 |
| [songofhawk/dsh-alpha](https://github.com/songofhawk/dsh-alpha) | ✅ | 多机多 Agent 编排控制平台（路由/审批/恢复） | 不重叠：控制面 vs 观测面 |
| [LeslieWylie/dsh-ops-kit](https://github.com/LeslieWylie/dsh-ops-kit) | ✅ | 证据驱动的记忆/编排/基准/插件发布工具集 | 不重叠：操作与证据管理，非指标观测；「证据优先」理念与 Nautilus 证据归档同构 |
| [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot)（**181★**，2026-06 建）⚠️ 第一版报告未提及，本期新发现 | ✅ | **本地优先（local-first）遥测收集器 for AI coding agents**：Claude Code / Codex / Cursor / dsh 统一 OTel 事件，token 用量/成本/trace/安全审计 | **最近的哲学邻居**：local-first + OTel + coding agents 三重同构。分界线：它统一的是「coding agents 的事件口径」，我们统一的是「机器的物理上下文」——无 OS/GPU 层、无三层归因、无工作台 UI、无 era 概念 |

### 1.4 空位复核：第一版的关键判断成立，但边界必须收紧

第一版判断：「现有插件全部集中在 DSH 作为 Agent 运行时自身的可观测性，无人做三层采集 + 时间对齐 + 关联归因」——**经实证仍然成立**，但要加两个限定：

1. **「trace 插件」本身已不是空位**。loongsuite（8/15）、腾讯云（8/18）、insight-tree（9/7）在一个月内密集进场 DSH 观测赛道。Nautilus 若只多一个 trace/看板插件，一个月后就没有差异化。
2. **真正的空位是三件事的合取**：跨层（OS/模型/应用）× 关联归因 × **数据不出本机的工作台**。三个条件同时满足的，DSH 生态内外都没有（loongsuite-pilot 满足 local-first 但不跨层；Bits AI 跨层但上云）。注：OpenLIT 已覆盖「LLM trace + GPU 指标」两块采集，但采集 ≠ 对齐归因——它无三层时间对齐、无 era、无工作台形态，合取空位判断不变。

### 1.5 可借鉴开源项目清单（按 Nautilus 模块组织，GitHub 实证 2026-09-12）

| 模块 | 项目 | 借鉴点 | 用法 |
|---|---|---|---|
| pulse | [systeminformation](https://github.com/sebhildebrandt/systeminformation)（3.1k★） | cpu/mem/disk/net 统一跨平台 API，Windows 亲和 | 方案 A 依赖 |
| pulse | [pidusage](https://github.com/soyuka/pidusage)（545★） | 跨平台**进程级** CPU%/RSS | 方案 A 依赖——`pulse.proc.dsh.*` 直接基座 |
| pulse | [nvitop](https://github.com/XuehaiPan/nvitop)（7.1k★） | NVML 轮询口径 + Prometheus exporter 模式 | GPU 指标口径参照 |
| pulse | [microsoft/ebpf-for-windows](https://github.com/microsoft/ebpf-for-windows)（3.5k★） | Windows eBPF：DeepFlow 式零侵扰的远期钩子 | 远期方向，本期不依赖 |
| infer | [loongsuite/dsh-plugin](https://github.com/loongsuite/dsh-plugin) | DSH 事件→OTel GenAI span 树（**含 TTFT**）——读源码确认 TTFT 推导字段 | Phase 0 源码研读 + Phase 2a 数据源参照 |
| infer | NVIDIA [GenAI-Perf](https://github.com/triton-inference-server/perf_analyzer) | TTFT/TPOT/并发的标准化测量方法学 | Phase 2b 口径参照 |
| infer | [frcooper/ollama-exporter](https://github.com/frcooper/ollama-exporter)（47★） | Ollama 指标化社区先例 | Phase 2b Ollama 路线口径参照 |
| core | `node:sqlite`（nexus 已用，零依赖） | `DatabaseSync` 存储驱动，延续零依赖惯例 | 沿用，不引原生依赖 |
| core | [OpenLIT](https://github.com/openlit/openlit)（2.7k★） | GPU/主机指标的 nvidia-smi→OTel 管线（含解析健壮性处理） | Phase 1 前研读其实现；同时监控其走向（竞合，见 §1.1） |
| core | OTel JS SDK（@opentelemetry/*） | 官方 SDK，OTLP 导出 | R10 兼容桥（Phase 4 可选） |
| 工作台 | [mcp-grafana](https://github.com/grafana/mcp-grafana) | ops 数据工具化的官方参考实现（工具粒度/只读边界） | L1 工具集设计参照 |
| 工作台 | nexus client（本仓库已有） | DSH client slots + 双 tab SVG 看板（放大/筛选/问答回看） | L2 面板复用 |
| 工作台 | [Grafana 看板 25193](https://grafana.com/grafana/dashboards/25193-neurix-ollama-nvidia-gpu/) | Ollama+NVIDIA 联动面板布局 | L2 三层联动视图布局参照 |

---

## 二、产品定位（第二期结论）

### 2.1 三层定位：继承第一版框架，三处校准

| 层 | 第一版表述 | 第二期校准 | 校准理由 |
|---|---|---|---|
| 生态位 | 「DSH 生态中第一个 AI Ops 全链路可观测性聚合插件」 | 保留，但限定词改为「**第一个跨层归因的**」——单纯「全链路 trace」不再是空位（loongsuite 已做） | §1.4 空位收紧 |
| 技术定位 | 「跨层关联归因引擎，而非单一采集器」 | **不变**，补一条与 loongsuite-pilot 的分界句：「它统一 coding agents 的事件口径，Nautilus 统一机器的物理上下文；前者是后者的数据源之一，不是竞争者」 | 最近邻居已出现，分界线要主动划 |
| 产品定位 | 「带 UI 的 Agentic Ops 平台，聚合包交付」 | 升级为开发组已定的锚点表述：**基于 DSH 内核的 AI Ops 全链路 Agent 工作台**——工作台内生（会话内 agent 工具 + client 面板），不是外挂 dashboard；被观测对象是 **agent 自己的工作负载**（自反式） | 国际线没有任何产品做「自反式」：LangSmith 观测你的应用、Bits AI 观测你的基础设施，都不观测「运维 agent 自己」 |

### 2.2 差异化矩阵（第二期扩版）

| 维度 | 华为 AgentArts / 腾讯 CloudQ | LangSmith / AgentOps | Datadog Bits AI / Grafana Assistant | DSH 生态观测插件 | **DSH Nautilus** |
|---|---|---|---|---|---|
| 部署形态 | 云平台 SaaS | SaaS（可自托管企业版） | 云平台 SaaS | 本地插件 | **本地插件，聚合包** |
| 观测对象 | 云上 Agent 应用 / 云资源 | Agent 应用 trace | 基础设施全栈 | DSH 运行时自身 | **本地 Agent 全负载：OS/算力 + 推理 + 应用质量** |
| 数据主权 | 上云 | 上云（企业版可 VPC） | 上云 | 腾讯云版上云 | **完全本地，可审计** |
| Agent 主体 | 平台内置 | 无（人来分析） | 平台内置 agent | 无 | **宿主内 DSH agent 即运维主体（自反式）** |
| 观测数据工具化 | — | API | MCP server（外部 agent 连云端） | — | **DSH 工具集（本地数据 → 宿主内 agent）** |
| 归因方式 | 平台内置（黑盒） | 聚类 + 人工 | 内置调查 agent（黑盒） | 无 | **假设驱动 + 预言检验 + 人工门控（白盒）** |
| 跨时代（API↔本地部署） | — | — | — | — | **era 显式建模（独有）** |

### 2.3 一句话叙事（面试版，升级）

> 大厂在做「云平台上的 Agentic Ops」——华为把 AgentOps 做成平台组件，腾讯 CloudQ 让 agent 主动巡检云资源，Datadog Bits AI 让 agent 自主调查告警。**我做的是「本地 DSH 运行时上的 Agentic Ops」**：以聚合包形式把 OS 层、模型层、应用层打通，让 DSH agent 用自己的遥测数据运维自己的工作负载——开发者在自己机器上看到 Agent 任务的全链路消耗与质量归因，数据不出本机。国际大厂刚刚把「观测数据工具化（MCP）+ 调查归因 agent 化」定为主流路线，我在端侧做同构的事，而且观测对象就是 agent 自己（自反式），这条没人做。

---

## 三、路线：能力阶梯 L0–L3（工作台形态的分期兑现）

「Agent 工作台」不一次性建成，拆为四级能力阶梯，**每级都有独立可交付物**（防范围蔓延的护栏）；映射到第一期 Phase 0–5：

| 阶梯 | 能力 | 形态 | 对标 | Phase 映射 |
|---|---|---|---|---|
| **L0 数据底座** | 三层指标统一建模（OTel GenAI 对齐）+ era 因果上下文 + 时间窗对齐管道 | 无 UI，core + SQLite | LangSmith SmithDB（本地极简版） | Phase 0–3（第一期计划不变） |
| **L1 工具化** | ops 能力封装为 DSH 工具集：`query_metrics` / `correlated_snapshot(ts, window, era)` / `triage_bad_cases` / `annotate` / `attribution_report` | agent 可调用 | mcp-grafana、Datadog MCP——**方向相反**：大厂把云上数据暴露给外部 agent，Nautilus 把本地数据暴露给宿主内 agent | **Phase 4 重心调整**（原「bad case 封装为工具」扩为完整工具集） |
| **L2 工作台呈现** | 双通道：client 面板（三层联动视图 + 归因报告页，复用 nexus client slots）+ 会话内工具调用可视化 | 用户看的 | ChatKit / Agent Builder 的 agentic UI 思路，但**内生零外挂** | 新增（Phase 4 与 5 之间，独立小 Phase） |
| **L3 自主运维循环** | 定期巡检 → 发现异常 → 建立假设 → 查数验证 → 输出报告 → **人工批准**改进动作 | agent 干活的 | Bits Investigation / Assistant Investigations；差异 = **假设驱动 + 预言检验表 + 人工门控（白盒 vs 黑盒）** | Phase 5 形态升级；era=local 时代完全兑现 |

阶梯依赖：L1 依赖 L0；L2 依赖 L1（面板展示的就是工具返回的数据）；L3 依赖 L0–L2 全部。每一级独立可发布、可归档证据，延续「跑通即归档」纪律。

**节奏建议**：窗口期以月计（大厂 8–9 月密集进场，§1.4），建议 Phase 0–1 提上日程而不再等 M4 完全收尾——两者仓库隔离（第一期 R7 对策），可并行；Phase 4（L1/L2）排在 M4 收尾后。

---

## 四、新增风险（在第一期 R1–R8 之上）

| # | 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|---|
| R9 | **赛道热化**：云厂商/开源组织 2026-08 起密集进场 DSH 观测，trace 类差异化窗口已关闭 | 高（已发生） | 中 | 聚焦合取空位（跨层×归因×本地工作台）；Phase 0–1 与 M4 并行提速；定位表述主动与 trace 插件划界 |
| R10 | **loongsuite 生态引力**：OTel/OTLP 可能成为 DSH 观测事实标准，自建管道被边缘化 | 中 | 中 | 指标命名已对齐 OTel GenAI（第一期 §4.2）；预留 OTLP export 兼容桥（Phase 4 可选项），把 loongsuite 视为数据源而非对手 |
| R11 | **范围蔓延**：工作台野心吞噬最小闭环纪律 | 中 | 高 | L0–L3 阶梯护栏：每级独立可交付可归档，未过验收不开下一级 |

---

## 五、Phase 0 待办更新（相对第一期）

第一期 Phase 0（选型 + 因果链确认）新增两条，原 D1–D3 决策点不变：

1. **TTFT 可得性捷径**：读 `loongsuite/dsh-plugin` 源码，确认它从哪些 DSH 原生事件字段推导 TTFT——其 span 树已含 TTFT，说明宿主事件流有逐级时间戳；若属实，Phase 2a 可直接采 TTFT，无需等本地时代。
2. **OTLP 兼容评估**（对应 R10）：评估 core 增加可选 OTLP export 的成本，作为对 loongsuite 生态的兼容姿态，不作为依赖。
3. **OpenLIT GPU 管线研读**：其 nvidia-smi→OTel 指标实现是 pulse 方案 A 的现成参照（解析健壮性/降级处理），Phase 1 动工前浏览。

---

## 六、参考来源

**国际线（本期官方文档/发布稿核验）**
1. Datadog Bits AI：https://www.datadoghq.com/product/bits-ai/
2. Grafana Assistant Investigations（GA 与 findings/hypotheses 机制）：https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/platform/investigation/ ；六项 agentic 能力扩展（2026-07）：https://www.helpnetsecurity.com/2026/07/28/grafana-assistant-ai-capabilities/
3. Grafana Sift（前身自动诊断）：https://grafana.com/docs/grafana-cloud/ai-tools/machine-learning/sift/
4. mcp-grafana（官方 MCP server）：https://github.com/grafana/mcp-grafana ；Grafana Cloud MCP：https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/
5. Datadog MCP Server：https://docs.datadoghq.com/mcp_server/
6. OpenAI AgentKit（Agent Builder/ChatKit/Evals/Guardrails）：https://openai.com/index/introducing-agentkit/
7. LangSmith：https://www.langchain.com/langsmith
8. AgentOps（Time Travel 回放）：https://www.agentops.ai/
9. Claude Code 遥测（OTel 指标/事件）：https://code.claude.com/docs/en/monitoring-usage

**DSH 生态（GitHub 实证，2026-09-12）**
10. loongsuite/dsh-plugin：https://github.com/loongsuite/dsh-plugin
11. TencentCloud/tencentcloud-agentobs-sdk-dsh：https://github.com/TencentCloud/tencentcloud-agentobs-sdk-dsh
12. xingzhen199186/dsh-insight-tree：https://github.com/xingzhen199186/dsh-insight-tree
13. songofhawk/dsh-alpha：https://github.com/songofhawk/dsh-alpha
14. LeslieWylie/dsh-ops-kit：https://github.com/LeslieWylie/dsh-ops-kit
15. alibaba/loongsuite-pilot：https://github.com/alibaba/loongsuite-pilot

**国内线（开发组第一版报告提供，未独立核验，引用前需按其原始链接复核）**
16. 华为云 AgentArts（AgentStudio/AgentRun/AgentOps 三组件）、华为 AIOps 三阶段演进与四层指标体系、腾讯云 CloudQ、腾讯云 ADP 4.0、嘉为蓝鲸 OpsPilot——原始链接清单待开发组补齐后归档于此

**可借鉴开源项目（2026-09-12 GitHub 实证，按模块组织详见 §1.5）**
17. systeminformation（Node 系统全景 API，3.1k★）：https://github.com/sebhildebrandt/systeminformation
18. pidusage（跨平台进程级 CPU/RSS，545★）：https://github.com/soyuka/pidusage
19. nvitop（NVML GPU 监控 + exporter 模式，7.1k★）：https://github.com/XuehaiPan/nvitop
20. NVIDIA GenAI-Perf（TTFT/TPOT 标准化测量，位于 triton perf_analyzer 仓库）：https://github.com/triton-inference-server/perf_analyzer
21. OpenLIT（OTel 原生 LLM/GPU 观测，2.7k★）：https://github.com/openlit/openlit
22. OpenInference（Arize LLM trace 语义约定，1.2k★）：https://github.com/Arize-ai/openinference
23. microsoft/ebpf-for-windows（Windows eBPF，3.5k★）：https://github.com/microsoft/ebpf-for-windows
24. frcooper/ollama-exporter（Ollama 社区 Prometheus exporter，47★）：https://github.com/frcooper/ollama-exporter
