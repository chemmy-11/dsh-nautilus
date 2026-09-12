# Nautilus 中的 nexus 定位与架构边界

> 版本 v0.1（2026-09-13 起草，**待开发组裁决**）
> 上游：[nautilus-opening-report.md](./nautilus-opening-report.md) §4.1/§4.3/§4.4 · [nautilus-research-2-positioning.md](./nautilus-research-2-positioning.md) §二/§三 · [../2-dev/nautilus-dev-01-phase0.md](../2-dev/nautilus-dev-01-phase0.md) §3/§4
> 归属：本文件是**决策文档**（改动即决策）；实现落 [../2-dev/](../2-dev/)，工程红线落 `CONTRIBUTING.md`。
> 本文件只做**定位与边界**，不重启 M5（M5 已挂起）。

---

## 0. 先澄清三个「nexus」（命名纪律）

| 名称 | 指什么 | 状态 |
|---|---|---|
| `dsh-nexus` / `@dsh-external/dsh-nexus` | **本仓库这枚插件**（原 xuegulin，2026-08-31 改名）：宿主平面观测——vault 元数据 + 会话读数 + 双面板 | 已上线运行 |
| Nautilus 的 **nexus 层** | 三层架构中的**应用层腿**（app layer），与 pulse（OS/GPU）、infer（模型）并列 | 本文件定义 |
| **DSH_Nexus 神经系统规范** | **另一个未立项插件**（暂名 `dsh-nexus`）：漂移度量（输出对声明意图的遵从度，工程量） | N1 待立项 |

⚠️ **第三项与第一项重名**：规范 v3.0（08-27/28）把漂移层暂名 `dsh-nexus`，而 xuegulin 于 08-31 改名 `dsh-nexus`。规范 §七明确二者「正交」（漂移度 ≠ A 投影）——重名会持续制造误读，见 **D-N0**。

---

## 1. 定位（一句话）

**nexus = Nautilus 的应用层腿：把宿主会话事件变成「应用层事实」，并保留自己独立的 vault/会话看板；对 Nautilus 只承担「被聚合」，不承担「聚合」。**

| 维度 | 做 | 不做 |
|---|---|---|
| 采集 | `session/event` 直采（turn 级 token/缓存/耗时/tps）、自评三行、问答全文、vault 元数据与编辑流 | 不采 OS/GPU（pulse）、不采推理引擎（infer）、不互相打点 |
| 存储 | 自己的表、自己的口径、自己的迁移 | 不做指标注册中心、不做时间窗对齐、不做 era 判定、不做关联快照（全归 core） |
| 界面 | 自己两个 tab（Vault 观测 / 会话读数） | 不承担 Nautilus 三层联动视图与归因报告页（L2） |
| 对外 | 只读查询面 + 已定稿的归属/指向语义 | 不写 vault、不写他人数据目录、不 import 宿主实现或其它插件值 |

**红线沿用**：观测不干预；`session/event` 直采零宿主改动；数据私有 `~/.dsh/nexus/`。

---

## 2. 当前实现事实（供架构判断，非愿景）

- **包/入口**：单包双半；`exports` 目前只有 `.` 与 `./client`（多入口需新增子路径）。
- **数据所有权**：`~/.dsh/nexus/nexus.db`（9 表，`PRAGMA user_version = 3`）；`v1/v2/v3` 迁移**全部写在 `src/store.ts`，由 nexus 独家执行**。
- **对外面**：8 条 REST + 1 个工具（`record_turn_selfcheck`）+ 2 个 client tab；**未暴露任何 cordis 服务**（全库无 `ctx.set`）。
- **采集方式**：`session/event` 订阅 + `fs.watch`；未消费 `ctx.subprocess`/`ctx.fs` 等 seam（当前不需要）。
- **Nautilus 规划对 nexus 的两处接口假设**：① 「SQLite（`~/.dsh/nexus/`，长表 + 事件表 + **现有 turn 库**）」→ 同库；② 「L2 面板**复用 nexus client**」。

---

## 3. 架构风险（「不出问题」= 逐条钉死）

| # | 风险 | 事实依据 | 落点 |
|---|---|---|---|
| **R1** | **schema/迁移主权冲突** | nexus 独家持有 `user_version` 与迁移；core 要加 `metric_sample`/`metric_event`；M5 曾要加 `call_p`。若各自门控：core 先置 `v4`，nexus 后加自己的 `v4` → `v < 4` 为假，**nexus 迁移被静默跳过** | D-N1 |
| **R2** | nexus→core 耦合方式未定 | 同库直读 vs 服务接口 vs 事件流，三种语义完全不同 | D-N2 |
| **R3** | 粒度模型未定稿 | `turn_read` 是 **turn 粒度**；era/TTFT/model 与 M5 的 P 都是 **调用粒度**；Phase 0 §4 已建议「另立 `call_read`」 | D-N3 |
| **R4** | 「复用 nexus client」与门禁相抵 | bundle 纯净度门禁**只允许 type-only 跨插件导入**；跨包复用组件不合法。同包则天然共享同一 client bundle | D-N4 |
| **R5** | 装载与降级方向未定 | core 依赖 nexus 还是 nexus 依赖 core？聚合包缺腿（无 GPU / 无引擎）时能否降级启动 | D-N1/D-N4 |
| **R6** | 交付通道缺陷 | 官方文档明示 pnpm 对 git 依赖**只跑 `prepare`**（publish.zh.md）；本包**只有 `prepack`** → git 到手无 `lib/`。当前靠 profile patch 热装配绕过 | §6 先决 |
| **R7** | 采集 seam | pulse 起子进程应走 `ctx.subprocess`（seam 已存在），不是 `node:child_process`；发现不到 GPU/引擎须**整族缺席而非报错** | 实现期 |
| **R8** | era 与措辞分级 | `api` 时代只谈「对照」，`local` 时代才谈「归因」；era 必须在 schema 强制，禁止跨时代 join | D-N1/D-N3 |
| **R9** | 观测面互不叠加 | 三条腿各自采集自己的源；**禁止**用另一条腿的产物生成读数（否则循环自证） | 长期约束 |

---

## 4. 待裁决点（方案对比，建议仅供参考）

### D-N0 命名收敛（先行）

| 方案 | 说明 |
|---|---|
| A | 本仓库插件继续叫 `dsh-nexus`；神经系统规范改名（如 `dsh-nexus-` → `dsh-snow-nexus` / `dsh-drift`），N1 立项时用新名 |
| B | 本仓库对外升格为 `dsh-nautilus`（目录名已是），`nexus` 让给漂移层 |
| C | 维持重名，仅靠文档区分 |

**倾向 A**：本仓库已上线、安装链与 GitHub 仓库名都在用 `dsh-nexus`，改名成本最高；漂移层未立项，改名零成本。

### D-N1 数据与迁移主权（最高优先）

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A** | nexus 即数据层：core/pulse/infer 经接口读写 nexus 的库与迁移 | 单一迁移权威；改动最小 | nexus 从「应用层腿」升格为「数据中枢」，与「功能冻结、只加接口」矛盾；core 加表要等 nexus 发版 |
| **B** | 同包内抽 `src/db/`：单例连接 + **迁移账本**（每条含 `version/owner/apply`）；nexus 注册自己 v1–v3，core 注册 v4+ | 单一 `user_version` 权威；nexus 的表定义与口径**不动**（符合「只加接口」）；独立可装（core 缺席时只跑 nexus 自己的迁移） | 需把 `store.ts` 的 `migrate()` 重构为注册表（行为不变，属内部重构）；仅适用于**同包** |
| C | 分库（`nexus.db` + `nautilus.db`），core 侧 ATTACH/JS 对齐 | 零迁移冲突、各自发版 | 拆掉「统一长表」，跨库对齐脆弱；与 §4.3 的时间窗对齐卖点相抵 |

**建议 B**（次选 A）：既保住 nexus 的独立与冻结，又给 core 一个正当的 schema 扩展位。

### D-N2 nexus→core 接口形态

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A** | cordis 服务 `ctx.nexus`（只读方法：turn 查询/总量/会话元信息） | 明确的契约面，符合「只加接口」；需定义 Service + 类型 |
| B | 事件推送（写库后 `emit`，core 订阅增量） | 增量友好，但冷启动/回填仍需查询面；建议作为 A 的可选补充 |
| C | core 直读同一 DB 的表 | 最省事，但绕过契约，schema 变更会静默破坏对方 |

**建议 A（+B 可选）**。若 D-N1 选 A，C 降级为内部实现细节，不作为接口。

### D-N3 粒度模型定稿

现状：`turn_read`（turn 粒度，口径已冻结）。era/TTFT/model 与 P 均为**调用粒度**。

| 方案 | 说明 |
|---|---|
| **a（建议）** | 定稿「**调用**」为一等粒度：新增 `call_read`（provider/model/endpoint/TTFT/usage/era）承载 infer 与 era；M5 重启时 P 只加列或加旁表（`n` 进主键），**不再造第二张调用表** |
| b | 只给 `turn_read` 加列 | 会污染已冻结的 turn 口径（一个 turn 多调用时无法归属） |
| c | 等 M5 重启再定 | 期间 era/TTFT 无落点，Phase 2a 无法开工 |

### D-N4 包与入口结构（承接 D2）

| 方案 | 说明 | 对 R4 的影响 |
|---|---|---|
| **A（建议）** | 单包多入口：`exports` 增 `./pulse` `./core` 等；`cordis.patch.yml` 多 `insert` 行（官方文档实证子路径入口可行） | 同包 ⇒ 同一 client bundle ⇒ **L2 复用组件合法** |
| B | 多包 / monorepo，各自 client bundle | 跨包复用违反纯净度门禁，L2 需重画或另抽公共包 |

**实现注意**：每个入口必须导出自己的 `name/inject/Config/apply`（**不得 default export**，postmortem 0001）；client 侧要么单一入口聚合各视图，要么多 client bundle，需在实现文档中定。

---

## 5. 边界契约（建议稿，待 D-N1/D-N2 裁决后定稿）

1. **nexus 只增不改**：已有表结构与统计口径冻结；对 core 的暴露是**新增只读面**，不改既有语义。
2. **core 不反向依赖 nexus 的内部**：只消费公开面；不 import nexus 的值。
3. **数据只进不出**：观测数据不外发；era 声明与措辞分级在报告层强制。
4. **缺腿降级**：任一层缺席（无 GPU、无本地引擎、core 未装配）时，其余层正常启动，缺失面显式标注「整族缺席」。
5. **零污染**：三条腿互不生成对方读数（R9）；任何注入类实验另行立项并标 regime。

---

## 6. 零风险先决动作（不涉裁决）

- 本文件入库，并在 [README.md](./README.md) 登记。
- **R6 写进 `CONTRIBUTING.md` 交付节**：官方文档已明示 git 安装走 `prepare`（且必须自包含），本包只有 `prepack`——补法是工程必修，不再是取舍。
- **R4 写进定位口径**：禁止按「跨包复用 nexus 组件」设计 L2。

---

## 7. 建议裁决顺序

**D-N0**（命名，避免后续文档继续混用）→ **D-N4**（决定 R4 是否有解、core 与 nexus 同包还是分家）→ **D-N1**（迁移主权）→ **D-N2 / D-N3**（接口与粒度）。

---

## 关联文件

- [nautilus-opening-report.md](./nautilus-opening-report.md) — 三层架构、era 因果上下文、Phase 计划、R1–R8
- [nautilus-research-2-positioning.md](./nautilus-research-2-positioning.md) — 定位、L0–L3 阶梯、R9–R11
- [../2-dev/nautilus-dev-01-phase0.md](../2-dev/nautilus-dev-01-phase0.md) — TTFT/model/endpoint 可得性、D1–D3
- 雪谷 vault `外功/DSH/DSH_Nexus —— 神经系统插件规范.md` — 漂移度量（与 nexus 正交，N1 未立项）
- 雪谷 vault `外功/DSH/雪谷观测插件开发文档-M5.md` — P 腿（**已挂起**；`call_p` 粒度见 D-N3）
