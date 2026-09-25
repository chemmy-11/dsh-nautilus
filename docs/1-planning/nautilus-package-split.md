# Nautilus 分包决策（PS 系列 v0.1 · 待逐条签核）

> 缘起：守谷人 2026-09-25 提出「os 层与 nexus 层解耦成两个包，后续 llm 层也单独做一个包，nautilus 以聚合包插件形式发布」，并已裁定**两个库**。
> 本文只写决定与边界。**未签核项不得动代码**（同 AL 系列纪律）。

## 1. 驱动（为什么拆）

| 驱动 | 说明 | 是否成立 |
|---|---|---|
| **独立发版** | 各层按自己的节奏发版；LLM 层迭代最快，不该被会话/OS 层拖着走 | 成立（**守谷人 2026-09-25 明确**：主驱动） |
| **项目管理** | 分包后各层边界、门禁、负责人可分开；仓库结构与里程碑按包组织 | 成立（**守谷人 2026-09-25 明确**） |
| 能力可选 | 不采集 OS/GPU 的部署只装 nexus；不接本地 LLM 的部署不装 llm | 成立 |
| **多端（web + desktop）** | **不构成驱动**：单条目 + 子插件挂载已能让两个前端同时工作；多端的真实问题是**同机两个 home 之间的数据共享**（见 §7） | 不成立，需澄清 |

## 2. 硬约束（AGENTS §3，决定拆法长什么样）

- **单 Loader 条目**：带 dsh.client 的包整个包只允许一个 Loader 条目；bundle patch 插两行 → client-modules 抛 resolves from multiple active Loader sources → **dsh web 直接起不来**。
- **推论一**：**只有聚合包**可带 dsh.bundle.patch 与 dsh.client。
- **推论二**：**客户端半区不能拆散成多包**——子包一律无 dsh.client（宿主侧库或 cordis 子插件），由聚合包 ctx.plugin(...) 挂载。
- **推论三**：子包若要有 UI，只能把**客户端源码**交给聚合包的客户端构建打包（lib/client.js 仍是聚合包一份）。

## 3. 目标形态

```
@dsh-external/dsh-nautilus          ← 聚合包：唯一 Loader 条目 + dsh.client（工作台 UI）+ Config 聚合 + 发布面
  ├─ @dsh-external/dsh-nautilus-nexus  ← 会话/对齐数据层（turns·analysis·selfcheck·consistency·sessions + m2 路由 + 自己的库）
  ├─ @dsh-external/dsh-nautilus-pulse  ← OS/GPU 采集层（collect·counters·snapshot·alerts + pulse 路由 + 自己的库）
  └─ @dsh-external/dsh-nautilus-llm    ← 【未来】本地部署 LLM 的观测层 + 本地控制台
```

- 工作台 UI（src/client/**：workbench·charts·turn-annotate·alerts·pulse-controls·theme）**留在聚合包**——它是聚合面本身，不是数据层。
- 依赖方向**单向**：聚合 → 各子包；子包之间互不 import（nexus 与 pulse 的守卫已由 AL.6 建立）；**任何子包不得 import 聚合包**。

## 4. 两个库（**已签 S2**）——注意：这是**目标态**，现状是一个库

> **现状更正（实现取证）**：`src/pulse/store.ts:4` 明写「与 nautilus **同库不同表**（`~/.dsh/nautilus/nautilus.db`）」。
> 即今天是**单文件、两张表族、共享同一个 `user_version` 序列**。pulse 的 v4 保守守卫（「只在库已到 v3 时推进版本」）就是这个共享序列逼出来的（OQ-AL5 的根因）。
> **推论**：两库不是「配置一下就有」，而是**一次拆库迁移**（见下）；而拆库完成后，**OQ-AL5 会自然消失**——两个库各有自己的版本序列，不再需要跨层前置条件。

### 4.1 拆库迁移路径（PS.2 的一部分，需单独签核再动）

1. 目标文件：`~/.dsh/nautilus/nautilus.db`（nexus 表族留原位）· `~/.dsh/nautilus/pulse.db`（`metric_sample` 迁出）；
2. 步骤：新建 pulse.db → 建 pulse 自己的表与 `user_version` → **拷贝** `metric_sample` 全量行 → 校验行数与最大时间戳一致 → 旧库中**保留**该表一段时间（不 drop，红线 3）→ 双读校验后再由后续版本停用；
3. 风险：pulse 采集是**持续写入**的，拷贝期间的新行必须补一次（二次增量：按 ts 水位补）——否则会丢采样点；
4. 回滚：pulse.db 可弃（旧表仍在），改回单库只需删文件；
5. **在拆库之前，「两库」只体现在文档与目标里，代码仍按单库走**——所以当下的数据共享方案（§7.1）只需处理**一个文件**。

## 4.2 两库的长期形态（已签）

| 包 | 库文件 | 拥有的表（现状） |
|---|---|---|
| nexus | ~/.dsh/nautilus/nautilus.db | turn_read·turn_text·step_seen·selfcheck_record·turn_annotation·annotation_sample·annotation·session_root·lfield_config（后三者为停用遗留） |
| pulse | ~/.dsh/nautilus/pulse.db（现由其自带 store 所管） | metric_sample·alert_event |
| llm（未来） | 待定（倾向 ~/.dsh/nautilus/llm.db） | 待定 |

- **后果一**：跨层查询（如「本轮耗时 vs 当时的 GPU 占用」）**在聚合层做**，不在 SQL 里跨库 join。
- **后果二**：迁移**按包各自演进**，由聚合包持账本汇总（见 §5）；一库迁移失败不得连坐另一库。
- **后果三**：备份/搬运**成对**（两文件 + -wal/-shm），文档与脚本必须写明——今天「换 home 丢数据」的坑就是这么来的。

## 5. 迁移归属与账本

- 迁移账本（AL.2 落地）已带 owner 字段，正是为此预留：**每包注册自己的版本区间**，账本按版本号全局排序、按 owner 归属。
- **前置条件机制**：**仅在拆库完成之前需要**（那时 pulse 与 nexus 仍共享一个 `user_version` 序列）。拆库后每库自有版本序列，OQ-AL5 自然消失——所以 PS.2 应先**拆库**、再谈是否需要前置条件；若拆库先行，这个机制可以不实现。
- **发版纪律（拟）**：schema 地板（min_reader_version）+ **只增迁移**（新表/新列+默认值，不重建、不收紧 CHECK）。理由：多端 + 多包并存时，旧写者撞新 CHECK 是已实测故障形态（旧形写压对齐行 → CHECK 异常 → 后补 409 收口）。

## 6. LLM 层（守谷人 2026-09-25 澄清）

**定义修正**：不是「告警报告的三段式 LLM」，而是**本地部署 LLM 的观测层 + 本地控制台**。观测对象是本地推理服务（模型加载/卸载、显存占用、吞吐与排队、请求错误率、上下文占用…），数据源大概率是本地推理服务 API/metrics + 复用自己的 OS/GPU 计数。

**必须现在定的两件事**：

1. **控制台形态**（决定它能否独立成条目）：
   - **A（推荐）**：控制台作为**聚合包客户端半区的一部分**（llm 包只出客户端源码，聚合包构建时打包）→ 符合单条目契约、UI 风格统一；代价是 UI 发版跟随聚合包。
   - **B**：控制台是**独立 HTTP 页面**（llm 包宿主路由直接服务，不进 DSH 客户端槽位）→ 与 DSH UI 完全解耦、可独立发版；代价是两套 UI 体系、主题与鉴权要重做（工作台的 --nt-* 令牌层不适用）。
2. **依赖方向**：llm 需要 GPU/显存计数 → **llm → pulse（复用 counters）**；若要「这一轮对话用的哪个本地模型」则需 llm → nexus，但那会让它依赖两条腿——**建议先不依赖 nexus**，用 session 维度松关联留待以后。

## 7. 与包无关但必须同时解决的当下问题（多端）

1. **同机两 home 的数据共享**：已定「只共享数据目录、保留 home 隔离」。两库决定意味着**要共享的是两个文件**，方案要成对处理。
2. **dataDir 配置字段**：按 AGENTS §2「凡不同部署可能取不同值的参数都必须是配置字段」，数据目录应提升为配置字段（默认 $DSH_HOME/nautilus）；**联接只是权宜**（pnpm 重装会冲掉、会掩盖配置面缺口）。
3. **缺维度**：turn_read 无 workspace；metric_sample/alert_event 无 host/instance。同机多端不需要 host 维度，但 **workspace 仍缺**（轮次命名的工作区段目前恒为「未知工作区」）。
4. **多写者纪律**：store.ts 现无 busy_timeout；collector 写失败只 console.error（**静默丢轮次**）。共享库之前必须补：busy_timeout + 丢写可见化。

## 8. 分阶段与门禁

| 阶段 | 内容 | 门禁 |
|---|---|---|
| **PS.0** | **本文档签核** + 发布面清单（每包需要什么才能发） | 守谷人逐条签 |
| **PS.1** | 提 nexus 包（AL.6 已解耦，是现成第一块砖）；验证三套发布面（build/check:deps/check:exports/check-meta ×2）跑得通 | 六件套全绿 + 聚合包功能零回归 |
| **PS.2** | 提 pulse 包 + 账本**前置条件**机制（OQ-AL5 收口） | 同上 + 两库各自迁移独立可验 |
| **PS.3** | 提 llm 包（形态取决于 §6 裁决） | 同上 |

**每阶段必须保持**：聚合包仍是**唯一 Loader 条目**（check-meta 守）、工作台 UI 零回归、dsh web 与 desktop 两前端都能起来。

## 9. 签核（**守谷人 2026-09-25：全部同意**）

> 原话：「拆包就是为了独立发版以及后续便于项目管理。都签，先写planning文档，然后做修复让当下数据跑通。」

- [x] **S1** 只有聚合包带 `dsh.client` 与 bundle patch，子包无客户端半区 —— 签。
- [x] **S2** 两库方案（nexus.db / pulse.db 各自独立，跨层在聚合层对齐）—— 签（注意 §4 现状更正与 §4.1 拆库路径）。
- [x] **S3** 控制台形态 —— 按 **A（聚合包客户端半区）** 执行（若日后要控制台独立发版再改判 B）。
- [x] **S4** `llm → pulse`（复用 counters）、先不依赖 nexus —— 签。
- [x] **S5** 发版纪律：schema 地板 + **只增迁移** —— 签。
- [x] **S6** `dataDir` 作正式修复 + 三项共享前置 —— 签。
- [x] **S7** 拆包时点 —— **先做修复让当下数据跑通**，再按 PS.1 → PS.2 → PS.3 推进。

### 9.1 签核后的执行顺序（Lead 记录）

1. **当下修复**（不拆包即可做）：`dataDir` 配置字段 · `busy_timeout` · 丢写可见化 · 同机两 home 的数据共享；
2. 仍待裁：**workspace 维度**的数据源（A 加列 forward-only / B + 宿主存储回填 / C 复活 session_root）；
3. 然后 PS.1 提 nexus 包 → PS.2 拆库 + 提 pulse 包 → PS.3 提 llm 包。

## 9.2 原待签核项（存档）

- [ ] S1：认可「只有聚合包带 dsh.client 与 bundle patch，子包无客户端半区」这条总边界。
- [ ] S2：认可两库方案（nexus.db / pulse.db 各自独立，跨层在聚合层对齐）。
- [ ] S3：§6 控制台形态选 **A（聚合包客户端半区）** 还是 **B（独立 HTTP 控制台）**。
- [ ] S4：认可 llm → pulse（复用 counters）、**先不依赖 nexus**。
- [ ] S5：认可发版纪律：schema 地板 + **只增迁移**。
- [ ] S6：认可 dataDir 作为**正式**修复（联接为权宜），并把「workspace 维度 + busy_timeout + 丢写可见化」作为共享数据前置。
- [ ] S7：拆包**时点**：现在就开 PS.1，还是等 AL 系列收尾（端上验收 / AL.5 真实数字 / 证据归档）之后。

## 10. 未决（本文档不预设答案）

- 包名是否都用 @dsh-external/dsh-nautilus-* 前缀（沿用现有作用域，社区索引按 id 唯一）。
- llm 层库文件是否与 nexus/pulse 同目录（倾向同目录便于成对备份）。
- 拆包后是否需要**跨包版本兼容矩阵**（聚合包 X 要求 nexus ≥ Y）——走 npm 发版需要，都 link: 则不需要。