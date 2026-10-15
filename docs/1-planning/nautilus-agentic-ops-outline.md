# Nautilus 次阶段大纲 · LLM 层观测与 Agentic Ops 路线

> 版本 **v0.2**（2026-10-15 起草；同日按 PS / AL / A 三系列已签决策对齐，守谷人审批通过）· 形态：**大纲式方向文档**——不含全量 DDL、不含逐条验收命令与证据归档
> 上游：[nautilus-opening-report.md](./nautilus-opening-report.md)（三层架构 / §4.2 口径 / Phase 计划）· [nautilus-research-2-positioning.md](./nautilus-research-2-positioning.md)（L0–L3 阶梯）· [nautilus-package-split.md](./nautilus-package-split.md)（PS：分包与两库，§6 定义 LLM 层）· [nautilus-alignment.md](./nautilus-alignment.md)（AL：术语表 / §5 进化闭环 / §6 UI 收敛）· [nautilus-os-alerting.md](./nautilus-os-alerting.md)（A：提示与留证，不自动处置）· [../2-dev/nautilus-dev-01-phase0.md](../2-dev/nautilus-dev-01-phase0.md)（TTFT/model 可得性）· [../2-dev/nautilus-dev-03-os-layer.md](../2-dev/nautilus-dev-03-os-layer.md)（pulse 实现先例）
> 落点：**feat/nautilus 主线检出**（`L:\dsh-nautilus-al`）。后续拆 `../2-dev/nautilus-dev-08-llm-layer.md`（读数）与 `nautilus-dev-09-ops-loop.md`（工具与循环）——**编号避开已占用的 dev-04…07**
> 归属：路线大纲（改动即决策）；工程红线回写 `AGENTS.md`（本批已落）。

---

## 0. 本文件是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 次阶段（LLM 层观测 + agentic ops 起步）的**范围、选型结论、阶段划分、判定标准、待决点** | 完整开发文档：不写全量 DDL、不写逐条验收命令、不含证据归档 |
| 访谈共识 + 与 PS/AL/A 三系列对齐后的**收口稿**（v0.1 的三处过时已修，见 §9 末） | 对既有 Phase 计划的替代——沿用其编号，只细化 2a/2b 与 L1/L3 |

**命名与编号对照见附录 B**（层名/指标命名空间 `infer` ↔ 包名 `dsh-nautilus-llm`；dev-08/09；2b-1…2b-4）。

---

## 1. 共识基线（2026-10-15）

### 1.1 决策（守谷人裁决）

| # | 决策 | 结论 | 影响 |
|---|---|---|---|
| **J1** | 拓扑 | **DSH 装在实验室 Windows 服务器上**，与推理服务同机（回环） | era=local 强因果闭合；无跨机时钟偏差；无需 `--host 0.0.0.0` 与防火墙放行 |
| **J2** | 首选引擎 | **Strata（qwen3.8-flash-next）为第一个引擎适配器**；llama.cpp（WSL, qwen3.8-27B）为第二适配器 | 口径映射零改写（§3.5）；llama.cpp 缺失族按「缺席即缺席」处理 |
| **J3** | 干预档位 | **白名单运维动作**：受控动作 + 人工批准 + 审计留痕 | 红线改写为「不干预推理路径」（§2.3，**AGENTS §0 已回写**） |
| **J4** | 引擎自报硬件族 | 归 **LLM 层**，命名 `infer.engine.host.*`，显式标注「引擎自报」 | 不违反 R9；与 pulse 的独立采集形成双源对照（§3.6） |
| **J5** | 交付形态 | 先出**大纲式文档**，评审后再拆开发文档 | 本文件 |
| **J6** | 命名映射 | 层名与指标命名空间沿用 `infer`（`nautilus.infer.*` 口径冻结）；**包名 `dsh-nautilus-llm`**（PS §6 / S3 已签） | 两者同指一物，文档不得再造第三名（附录 B） |

### 1.2 事实（本次实测 / 上游已签决策核对，非推测）

| # | 事实 | 来源 |
|---|---|---|
| **F1** | Strata `GET /metrics` 双形态：Prometheus 文本用 **vLLM 指标名**（`vllm:kv_cache_usage_perc`、`vllm:time_to_first_token_seconds`、`vllm:inter_token_latency_seconds`、`vllm:e2e_request_latency_seconds`、`vllm:num_requests_running`/`_waiting`、`vllm:prompt_tokens_total`、`vllm:generation_tokens_total`、`vllm:prefix_cache_queries_total`/`_hits_total`、`vllm:spec_decode_num_draft_tokens_total`/`_accepted_tokens_total`、`vllm:request_success_total`）＋ `strata:*`（`live_state`/`live_tok_s`/`live_prefill_tok_s_mean`/`live_slots`/`last_hit_rate`/`engine_max_context`/`totals_*`）＋硬件族（`gpu_util`/`gpu_mem_used_bytes`/`gpu_mem_total_bytes`/`gpu_temp_celsius`/`gpu_power_watts`/`cpu`/`ram_used_bytes`/`ram_total_bytes`）；JSON 形态给 Monitor 全量，**含最近请求明细**（`ram_blobs`/`file_blobs`/`file_mb`）。**无值不写样本**（与「缺席即缺席」一致） | Strata `docs/DETAILS.md`、`docs/monitoring/grafana-strata.json`（2026-10-15 核对） |
| **F2** | llama.cpp `GET /metrics` 需 `--metrics` 启动；指标 = token 计数、tokens/s、`requests_processing`/`deferred`、`n_tokens_max`、`n_decode_total`、`n_busy_slots_per_decode`、spec-decode 计数；**无 KV cache、无 TTFT/TPOT 直方图、无硬件族** | llama.cpp `tools/server/README.md`（2026-10-15 核对） |
| **F3** | 宿主对**任何 provider** 都记录内嵌带时间流 ⇒ LLM 层 TTFT / token / 耗时**不依赖引擎**；逐调用 `provider/model` 可得且历史可回填（实测 783/783） | Phase 0 §2.1/§2.2 |
| **F4** | 两条腿**都还没有 DSH 流量**（只把模型跑起来了） | 本次访谈 |
| **F5** | **迁移账本已落地**（AL.2 = D-N1 方案 B 落点）：`src/migrations.ts` 定义 `{version, owner, name, apply}`、顺序执行、**回读校验**、未注册号入 `skipped`；当前最高 **v10**（v4 属他腿） | `src/migrations.ts` · `src/store.ts`（2026-10-15 核对） |
| **F6** | **PS 系列已全签**（S1–S7）：只有聚合包带 `dsh.client`/bundle patch；子包无客户端半区；**两库方案已签**（nexus.db / pulse.db，跨层对齐在聚合层做、不在 SQL 跨库 join）；llm 层库「倾向 `~/.dsh/nautilus/llm.db`」；发版纪律 = **只增迁移 + schema 地板** | `nautilus-package-split.md` §2–§6 |
| **F7** | AL 系列（6 签通过）：术语表**废止「契合」「L 场」**（留表停用、零残留）；**不做独立 LLM 裁判**（token 开销）；「**假设**」「**预言**」两板块与 `/api/nautilus/m2/annotations` + `PROPHECY_SEED` **停用**，替代物是 §5 的 **Correction 四步闭环**（发现→记录→修复→回归） | `nautilus-alignment.md` §0/§1/§3.3/§5/§6 |

**F1+F3 是选型的决定性依据**：Strata 的 Prometheus 面直接讲上游 §4.2 要的 vLLM 方言，而应用侧口径保证即使引擎族整族缺席也能出读数。

---

## 2. 目标、不变量与红线修订

### 2.1 阶段目标（一句话）

**在实验室服务器上把 LLM 层跑通（引擎侧 + 应用侧双通道），把这套读数做成宿主内 agent 可调用的工具，并在人工批准下开放一组白名单运维动作——形成「agent 用自己工作负载的遥测运维自己」的自反式最小闭环。**

### 2.2 不变量

1. **数据私有**：只落服务器本机 `~/.dsh/nautilus/`，不外发，无云依赖。
2. **三条腿互不生成对方读数（R9）**：引擎自报硬件族不得参与计算 pulse 读数，反之亦然；并列展示不算生成（J4）。
3. **依赖方向**（PS S4）：`llm → pulse`（复用 counters）；**llm 不依赖 nexus**（会话维度只做松关联）。AL.6 的依赖方向门禁已进六件套，必须过。
4. **不做独立 LLM 裁判**（AL §0-3）：报告与候选假设由宿主内 agent 自己产出（自反式），不引第二个模型、不落 API key。
5. **观测不阻塞主循环**：采集走后台串行队列 + 增量水位。
6. **人工门控 + 措辞分级**：动作需批准；`api` 时代只谈「对照」、`local` 时代（本阶段）才谈「归因」；跨机观测退化为对照。

### 2.3 红线修订（**本批已落**）

`AGENTS.md` §0 原「定位红线：**观测，不干预**」→ 已改为：

> **不干预被观测对象的推理路径**（不改宿主源码、不改宿主行为、不写用户数据）；**运维动作走白名单 + 人工批准 + 审计留痕**（J3）。

A 系列的「不自动处置」与 J3 **并列成立**：前者禁的是「未经批准的自动处置」，后者管的是「已批准动作的执行与留痕」——[nautilus-os-alerting.md](./nautilus-os-alerting.md) §1 已加互指句。

---

## 3. LLM 层观测

### 3.1 共同底座：应用侧逐调用口径（不依赖引擎）

- **新表 `call_read`**（调用粒度一等公民，落地 D-N3 建议 a）：`provider`/`model`/`endpoint`、TTFT、usage（input/output/cacheRead）、duration、`session`/`turn`/`step`、`era`。
- **TTFT 口径**（Phase 0 已定稿，不重议）：`assistant/message.data.stream` 首块时间 − `step/start` 时间；回放通道（历史回填、基线）＋实时通道（面板）分工不变。
- **作用**：给引擎侧读数提供**时间锚点**——每个 call 的 `ts` 即同期快照窗口中心。
- **降级**：TTFT 缺席即整列缺席（沿用 OQ-P0-3），不得用 0 或推算值填充。
- **标注/自评口径按 AL 术语表**：`align` 1–5 · `boundary` 枚举 · `declaration`+`quote` · `evidence`；**不得出现「契合」「L 场」**，也不得称 A（分辨率提升速率）为「对齐」。

### 3.2 引擎适配器 A：Strata（首选）

- **取数**：`GET /metrics`（Prometheus 文本，`Accept: text/plain`）为主；JSON 形态为辅——最近请求明细进 `metric_event`（逐请求事件，含 SSD 读取量；llama.cpp 无对应面）。
- **节律两档**：快档 5–10 s（gauge：队列 / KV / live state / 硬件族）；慢档 15–30 s（counter 差分：token 速率、前缀缓存命中、草稿接受率）。
- **计数语义**：`*_total` 存**原始累计值**，速率由查询层差分（同 pulse 的 `ctx_switches` 口径）；采集失败后的跨度按 `Δ/Δt` 处理；引擎重启导致计数回退 → 视为**重置**，不产出负速率。
- **直方图**：桶按 `le` 落多行（tags 带 `le`），分位数在查询层算；读数须标注「分位数为近似（受 scrape 间隔与桶边界限制）」。
- **缺失即缺席**：源没有的指标（如 `request_queue_time_seconds`）**不补造**；适配器不得把缺失写成 0。
- **配置（Config + Schemastery，默认值进 schema）**：`endpoint`、`apiKey`（**`role('secret')`**）、`pollIntervalMs`、`timeoutMs`、`enabled`、`modelFilter`；非法配置加载即失败。
- **软失败姿态**：解析不出即整族缺席，不报错、不重试风暴；版本漂移做版本化快照测试。
- **待探针确认**（附录 A）：部署版本是否含 `/metrics`、`api_monitor` 语义与默认值、是否已设 api-key、绑定地址（回环拓扑下 `127.0.0.1` 足够）。

### 3.3 引擎适配器 B：llama.cpp（第二）

- **前置**：需 `--metrics` 启动参数（属 J3 白名单动作 → 需人工批准 + 留痕，或由部署方自行加）。
- **缺口补位**：无 KV cache / 无 TTFT/TPOT 直方图 / 无硬件族 ⇒ 前三族由应用侧口径补位（TTFT、token 走 `call_read`），队列与吞吐走 `/metrics`。
- **部署**：WSL2 内；DSH 在 Windows 侧时走 WSL localhost 转发。**端口冲突**：Strata 与 llama-server 默认同为 8080 → 需分端口（待探针）。
- **价值**：验证「一套适配器接口两个实现」的抽象，并为跨引擎对照提供样本。

### 3.4 落库与保留（**OQ-1 就此归零**）

- **LLM 层自持库 `~/.dsh/nautilus/llm.db`**（PS §4.2 已给出倾向），**不参与** `nautilus.db` 的共享 `user_version` 序列。理由：① 共享序列逼出的「前置条件机制」在拆库后本就要消失（PS §5），自持库一步到位；② 与 PS 目标态一致，PS.2 拆 pulse 库时不需要二次迁移；③ 迁移账本按 `owner` 归属，llm 注册自己的版本序列（`owner: 'llm'`）。
- **迁移纪律**（PS S5）：**只增迁移**（新表/新列 + 默认值，不重建、不收紧 CHECK）+ **schema 地板**；每条迁移经账本注册 + 回读校验（F5）。
- **表**：`metric_sample`（采样型）＋ `metric_event`（事件型）＋ `call_read`（调用粒度）＋ `action_log`（§5）。
- **tags**：`{host, engine, model, source:'engine'|'sampler', device?}`；`era` 为 schema 强制列（禁止跨时代 join）。
- **保留**：原始档 14 天 + 1 分钟聚合档长期（与 pulse 同构）；量级同 pulse（≈20 序列 × 5 s ≈ 35 万行/天）。
- **跨层对齐在聚合层做**（PS §4.2 后果一）；**备份/搬运成对**（多库文件 + `-wal`/`-shm`，需随文档写明——PS §4.2 后果三）。

### 3.5 口径映射（初稿；完整表由首发 scrape 定稿）

| nautilus 口径 | 源（Strata 的 vLLM 名） | 类型 | 用途 |
|---|---|---|---|
| `infer.engine.ttft` | `vllm:time_to_first_token_seconds` | histogram | p50/p95 首 token 延迟 |
| `infer.engine.tpot` | `vllm:inter_token_latency_seconds` | histogram | p50/p95 解码间隔 |
| `infer.engine.e2e_latency` | `vllm:e2e_request_latency_seconds` | histogram | p50/p95 端到端 |
| `infer.engine.kv_cache.usage` | `vllm:kv_cache_usage_perc` | gauge | >90% 告警线 |
| `infer.engine.queue.running` / `.waiting` | `vllm:num_requests_running` / `_waiting` | gauge | waiting 持续 >0 |
| `infer.engine.tokens.prompt` / `.generation` | `vllm:prompt_tokens_total` / `generation_tokens_total` | counter | 差分速率 |
| `infer.engine.prefix_cache.hit_rate` | `vllm:prefix_cache_hits_total` / `_queries_total` | counter | 比值（提示词复用率） |
| `infer.engine.spec_decode.accept_rate` | `vllm:spec_decode_num_accepted_tokens_total` / `_draft_tokens_total` | counter | MTP 草稿效率 |
| `infer.engine.tps.live` / `prefill.tps` | `strata:live_tok_s` / `live_prefill_tok_s_mean` | gauge | 实时吞吐 |
| `infer.engine.state` | `strata:live_state` | gauge(labels) | reading / answering |
| `infer.engine.host.gpu.*` | `strata:gpu_util` / `gpu_mem_used_bytes` / `gpu_mem_total_bytes` / `gpu_temp_celsius` / `gpu_power_watts` | gauge | **引擎自报（J4）** |
| `infer.engine.host.cpu` / `ram` | `strata:cpu` / `ram_used_bytes` / `ram_total_bytes` | gauge | **引擎自报（J4）** |
| `infer.engine.ssd.read_per_request` | JSON 最近请求 `file_mb` / `file_blobs` / `ram_blobs` | event | 125B MoE 的 SSD 流式读取 |

### 3.6 与 pulse 的双源对照（J4 的落点）

pulse（`nvidia-smi` 独立采样）与 `infer.engine.host.*`（引擎自报）**并列展示、分别命名、tags 标 `source`**：两源偏差本身是观测对象（引擎自报可能滞后、取整、缺卡），**不得互相覆盖**，面板必须分色分标。这同时是「主客观交叉验证」原则在硬件族的落点。

### 3.7 读数阶段判定标准

1. 服务器上 `dsh` + 插件装配完成，记录**环境四元组**（dsh 版本 + profile + 装配方式 + 结果）。
2. DSH 会话流量命中本地端点，产生**第一条 era=local 调用**并落 `call_read`（含 TTFT/provider/model）。
3. Strata 适配器连续运行 ≥1 小时：≥8 条 `nautilus.infer.engine.*` 序列落库；**无内存增长**；采集开销 <单核 2%（沿用 pulse 回退线）。
4. **同期快照可输出**：任选一个 call，给出窗口内跨层读数 + era 声明 + 窗口参数 + 缺口标注。
5. **软失败路径**：人为停一次 Strata，各族缺席而非报错、不写 0。
6. 迁移经账本注册并通过回读校验；**六件套 + `check:meta` + 依赖方向门禁**全绿。
7. 证据归档 `evidence-llm-<日期>.md`（执行命令 / 预期 / 实际 / 观察结论）。

---

## 4. 工具化 L1（agentic ops 的地基）

| 工具 | 形状 | 阶段 |
|---|---|---|
| `query_metrics` | 按指标/窗口取序列（对齐既有 `/pulse/series` 与未来的 `/llm/series`） | **最小集** |
| `correlated_snapshot(ts, windowMs)` | 跨层同期读数 + era 声明 + 窗口参数 + 缺口标注 | **最小集** |
| `annotate_turn` | 写**既有** `m2/turn-annotations` 契约（`align` 1–5 / `boundary` / `declaration`+`quote` / `evidence`），**不新开端点** | 同形状后续 |
| `triage_bad_cases` | 候选筛：慢轮 / 高 KV / 排队 / 前缀缓存未命中 | 同形状后续 |
| `attribution_report` | 报告骨架（三段式，人工主导） | 同形状后续 |

- 复用既有 `record_turn_selfcheck`；**不新增第二套自评口径**（AL §4 方案甲）。
- 契约要点：只返回 `output.schema` 推导的规范 JSON；异常收敛为 `isError`；遵守 `exec.signal`；长任务走 `ctx.jobs.start`；**审批 / 限流 / 重试不内建**——交宿主工具钩子（`tools/pre-execute`、`ctx.tools.guard()`、`tools/post-execute`、`tools/result`）。
- **判定标准**：在服务器上的 DSH 会话里，agent 仅凭工具回答「这段会话慢在哪：排队、KV 打满，还是前缀缓存没命中」，答案带时间窗与缺口标注。

---

## 5. L3 运维循环（白名单）

**循环七步**：巡检 → 异常发现 → **预登记** → 查数验证 → 报告 → **人工批准** → 执行白名单动作 → 留痕 + 回归。

- **预登记**：查数之前先把预期写进报告草稿（保留「先声明后验证」的方法论）；**不复活**已停用的 `/m2/annotations` 与 `PROPHECY_SEED` 台账（AL §3.3/§6）——落点见 OQ-9。
- **报告**：沿用 A 系列三段式（事实 / 候选假设 / 待查），默认关、上限、去重，走 `ctx.jobs` 后台；**不引独立 LLM 裁判**（AL §0-3）。
- **记录**：按 AL §5 的 Correction 四条写（**情境 / 错 / 根 / 修**），**只添不改**；同类反复 → 升级条款。
- **回归**：在**不可污染留出集**上复核；提升才采纳，否则回滚（「留出集只用于采纳判定，绝不进提示词」）。

**白名单动作表（初稿，待 §8 裁决与探针确认）**

| 动作 | 手段 | 风险 | 批准 | 留痕 |
|---|---|---|---|---|
| 改采样节律 / 立即采一次 | 插件自身 `/control`（已有先例） | 低 | 免批准（只动自身） | 采集状态 |
| 触发一次引擎快照 | 读 `/metrics`（只读） | 低 | 免批准 | — |
| 收缩/预留显存 | Strata `POST /v1/vram` | 中 | 需批准 | `action_log` |
| 卸载 / 加载模型 | Strata `/unload` / lazy_load | 中 | 需批准 | `action_log` |
| 改启动参数（如 `--metrics`） | 进程重启 / 启动脚本 | 高 | 需批准 | `action_log` + 前后状态 |
| 重启引擎进程 | kill + 重启脚本 | 高 | 需批准 | `action_log` + 前后状态 |

- **审计表 `action_log`**：动作 / 参数 / 批准来源 / 结果 / 前后状态 / 时间戳。
- **与 A 系列的边界（并列，互不废止）**：A 系列「做提示与留证，不自动处置」= **未经批准时任何动作都不得发生**；J3 允许的是**已批准**的白名单动作由 agent 代执行并留痕。
- **禁止项**：改宿主源码、改被观测对象以外的机器状态、无批准的写动作、**把动作结果当归因证据**（动作是实验，须标 regime）。
- **判定标准**：≥1 个真实案例走完七步（含**一次被批准的动作**与**一次被拒绝的动作**），报告含预登记结果与反事实讨论。

---

## 6. 与既有结构的接口

| 对象 | 本阶段做法 |
|---|---|
| **core**（Phase 3 未建） | 用「查询层直接窗口聚合」的临时实现，但函数签名按 core 契约形状设计（`snapshot(ts, window)` / `series(metric, window)`），避免返工 |
| **聚合包 / 子包**（PS） | 本轮落 **`src/llm/` 子插件**（与 `src/pulse/` 同形态：单条目内 `ctx.plugin(...)` 挂载、`exports` 增 `./llm`）；**PS.3 再提包**（`dsh-nautilus-llm`），届时控制台按 S3 = 聚合包客户端半区 |
| **pulse** | `llm → pulse` 复用 counters（PS S4）；硬件族双源并列（§3.6）；库分离（`llm.db` vs `pulse.db`） |
| **nexus** | **不依赖**（PS S4）：会话维度只做松关联（`session` 字段），不 import `src/nexus/**`；依赖方向门禁必须过（AL.6） |
| **迁移账本** | llm 的每条迁移注册进 `src/migrations.ts` 账本（`owner` 归属 + 回读校验）；只增迁移 + schema 地板（PS S5） |
| **工作台**（feat/ui 支线） | 只出只读路由 `/api/nautilus/llm/{state,series}`（与 pulse 同构）；**本阶段不碰 `src/client/**`** |
| **集中常量** | 新路由前缀与事件名进既有常量位（`API_PREFIX` / `SESSION_EVENT`），禁裸字符串 |
| **装配落点** | 两个 profile 现为 `link:L:/dsh-nautilus`（该检出已归 **feat/ui**）——端上验收 llm 层需按 sanctioned 通道改指 `L:/dsh-nautilus-al`（OQ-10） |

---

## 7. 阶段划分（建议）

| 子阶段 | 内容 | 判定标准（摘要） | 依赖 |
|---|---|---|---|
| **2b-1 前置** | 服务器装 `dsh` + 插件；跑附录 A 探针；DSH 接本地端点 | 探针输出归档；环境四元组；装配走 `dsh plugin add` | 服务器权限 |
| **2b-2 读数** | `llm.db` + 账本迁移 + `call_read` + Strata 适配器 + 只读路由 | §3.7 的 1–7 | 2b-1 |
| **2b-3 工具** | `query_metrics` / `correlated_snapshot` 工具化 | §4 判定 | 2b-2 |
| **2b-4 循环** | 白名单动作 + `action_log` + 一次真实案例 | §5 判定 | 2b-3 |

每子阶段**独立可交付、独立证据归档**；未过判定不开下一子阶段（R11 范围蔓延护栏）。

---

## 8. 风险与待决点

| # | 项 | 说明 / 建议 |
|---|---|---|
| ~~OQ-1~~ | ~~迁移主权~~ | **已归零**：PS 两库已签 + 本轮取 LLM 层自持 `llm.db`（§3.4） |
| **OQ-3** | Strata 部署事实 | 版本是否含 `/metrics`、`api_monitor` 语义与默认值、是否已设 api-key —— 附录 A 探针 |
| **OQ-4** | 端口冲突 | Strata 与 llama-server 默认同 8080，需分端口 |
| **OQ-5** | 混合 era | 服务器上 DSH 若同时配云端 provider，会话级 era 需 `mixed` 标记，**禁止跨时代 join** |
| **OQ-6** | local 基线空白 | 本地 27B/125B 的 TTFT/TPS 分布无历史，基线须重新积累，**不得与 api 时代分布直接比** |
| **OQ-7** | 宿主版本 | 服务器 DSH 版本可能与开发机不同（开发机现为 dsh-desktop 0.2.0-rc.1），走「宿主版本适配五步」 |
| **OQ-8** | 双源呈现 | 引擎自报 vs 独立采集在小屏面板上的区分方式（留给 UI 支线） |
| **OQ-9** | 「预登记」落点 | AL 已删假设/预言板块与其 API：预登记改为**报告草稿内的文本段**，还是另立只写不读的轻量台账？**待裁** |
| **OQ-10** | 装配落点 | profile 的 `link:` 现指向 `L:/dsh-nautilus`（feat/ui）；llm 层端上验收需改指 `L:/dsh-nautilus-al`，还是反过来把 llm 线并回该检出？**待裁** |
| R-A | 社区项目漂移 | Strata 非标准件：软失败 + 版本化快照测试兜 |
| R-B | 白名单动作误伤 | 高风险动作需 dry-run 与前后状态留痕；动作结果不得进归因证据 |
| R-C | 范围蔓延 | 2b-1…2b-4 串行护栏；L1 只做两个工具 |

---

## 9. 回写项（本批 = 2026-10-15）

| 目标 | 内容 | 状态 |
|---|---|---|
| `AGENTS.md` §0 | 红线修订（不干预推理路径 + 白名单动作）+ 层名/包名映射 | ✅ 本批已落 |
| `nautilus-os-alerting.md` §1 | 与 J3 的边界互指句 | ✅ 本批已落 |
| `1-planning/README.md` | 登记本大纲；**补登记** `nautilus-package-split.md` 与 `nautilus-nexus-positioning.md`（两者原文早已要求入表） | ✅ 本批已落 |
| `2-dev/README.md` | 待建行改为 **dev-08 / dev-09** 并指向本大纲 | ✅ 本批已落 |
| `nautilus-opening-report.md` | §4.2 口径表补「引擎适配器」注记；**D3 结论改写**：由「vLLM 首选」改为「适配器优先级：Strata 优先 / llama.cpp 第二，vLLM 降为口径参照」 | ⏳ 待落（D3 改写需守谷人过目） |
| `nautilus-nexus-positioning.md` | D-N3（调用粒度）落地状态 + D-N1 已由迁移账本落地 | ⏳ 待落 |
| vault（走 /obsidian，守谷人点头后） | 本大纲与 J1–J6 回写谷文档 + PROJECT-MOC 登记 | ⏳ 待落 |

**v0.1 → v0.2 修正的三处过时**（本次基线收敛发现）：① 开发文档编号（dev-04…07 已占用 → 本层用 08/09）；② §3.4 迁移主权写法（「只建表不推进版本」→ 账本 + 自持库）；③ §5 方法论用语（假设/预言板块及其 API 已由 AL 停用 → 预登记仅作纪律、替代物为 Correction 四步）。

---

## 附录 A：开工第 0 步探针清单（在实验室服务器上执行，输出回贴归档）

```powershell
# 1) 监听端口与进程（确认 Strata / llama-server 各自端口，查 8080 冲突）
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 8080,8081,8000,11434,9000 |
  Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize
Get-Process | Where-Object ProcessName -match 'strata|llama|python' | Select-Object Id,ProcessName,Path

# 2) Strata 指标面（若已设 api-key，填 $k；否则留空）
$k = ''
$h = if ($k) { @('-H', "Authorization: Bearer $k") } else { @() }
curl.exe -s @h -H 'Accept: text/plain' http://127.0.0.1:8080/metrics | Select-String '^(vllm|strata):' | Select-Object -First 30
curl.exe -s @h http://127.0.0.1:8080/health
curl.exe -s @h http://127.0.0.1:8080/props
curl.exe -s @h http://127.0.0.1:8080/slots
curl.exe -s @h http://127.0.0.1:8080/v1/models
curl.exe -s @h -H 'Accept: application/json' http://127.0.0.1:8080/metrics | Select-Object -First 1   # JSON 形态（含最近请求明细）

# 3) WSL 侧 llama-server（端口 + 启动参数里有没有 --metrics）
wsl.exe -e bash -lc "ss -ltnp | head -20; ps -eo pid,args | grep -E 'llama-server' | grep -v grep"

# 4) 硬件与宿主版本
nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader
dsh --version
```

> 判定用途：F1/F2 是**文档事实**，探针确认的是**该部署实例是否具备**这些面（版本闸门、开关默认值、端口、密钥）。探针若显示 Strata 无 `/metrics`，按 J2 的降级顺序回落到「应用侧口径 + llama.cpp 适配器」。

---

## 附录 B：命名与编号对照

| 概念 | 本大纲用词 | 上游出处 | 禁止 |
|---|---|---|---|
| 三层里的模型层 | **LLM 层**（近期文档）/ `infer` 腿（架构图） | PS §6 定名；开题报告 §4.1 架构图 | 不得据「infer」另造包名或第三名 |
| 指标命名空间 | `nautilus.infer.*`（**冻结**） | 开题报告 §4.2 | 不得改名 |
| 未来包名 | `dsh-nautilus-llm` | PS §3/§6（S3 = 控制台进聚合包客户端半区） | — |
| 本层开发文档 | **dev-08**（读数）/ **dev-09**（工具与循环） | 本文 §0 | 不得占用 dev-01…07 |
| 本阶段子阶段 | **2b-1…2b-4** | 本文 §7 | 不得与 PS.1–PS.3（分包阶段）混用 |
| 关键术语 | `align` / `boundary` / `declaration` | AL §1 术语表 | 「契合」「L 场」已废止 |
