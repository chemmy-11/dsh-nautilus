# Nautilus 开发文档二 · 工作台 UI（S4 定版）

> 版本 **v0.2**（2026-09-12 起草；2026-09-20 增补 §4.5 图表语法升级）
> 定版依据：守谷人 2026-09-12 裁定——**S4「瑞士制图」为主皮肤**，浅/暗双主题随宿主 UI 切换；nexus 层补人工标注 UI 后设计定版。
> 交互原型（视觉与交互的唯一权威参照）：[./ui-s4-prototype.html](./ui-s4-prototype.html)——本文档描述其落地口径，与原型冲突时以原型视觉、本文档契约为准并回写修订。
> 上游：[../1-planning/nautilus-nautilus-positioning.md](../1-planning/nautilus-nautilus-positioning.md)（L2 工作台呈现 · 差异化矩阵）· AGENTS.md §3（客户端半区契约）

---

## 0. 结论速览

| # | 项 | 定版结论 |
|---|---|---|
| U1 | 皮肤 | **S4 瑞士制图**（白底发丝线 + 唯一朱红 `#e6321e`；Fact First 仪器图纸语言），唯一主皮肤 |
| U2 | 主题 | **浅/暗双主题随宿主**：中性色全量映射 `--dsw-alias-*`；朱红为静态色不随主题 |
| U3 | 信息架构 | 五视图（总览 / 曲线与归因 / 假设台账 / 预言检验 / 归因报告）+ 右侧调查抽屉 + era 声明条；挂载 = `main` keyed 全局面板 + `sidebar.panellist` 图标（§3.0 宿主入口契约实测） |
| U4 | 三层联动 | 同一时间范围 + 共享十字线 + 汇总 tooltip，NEXUS/INFER/PULSE 三层同窗对齐（w=30s 中位数） |
| U5 | 人工标注 | nexus 层轮次级人工标注：抽屉内登记（标签 + 备注），曲线红圈 / 对照表列 / 标注台账三处呈现；**判读层，不改原始读数** |
| U6 | 实现形态 | 零新依赖；React `createElement`；SVG 自绘；`--nt-*` 令牌层（默认值映射 `--dsw-alias-*`）；class 前缀 `nt-` |

---

## 1. 目标与验收

**目标**：把 L2「工作台呈现」的视觉与交互定版，产出可直接照做的客户端半区实现规范；人工标注闭环（登记 → 呈现 → 台账 → 删除/修改）可交互。

**验收标准**：

- [ ] 令牌层：`--nt-*` 变量表落地，除朱红外无硬编码色；浅/暗两态随宿主主题切换，组件零改动
- [ ] 五视图 + 抽屉 + era 条全部可交互，与原型一致（视图内容以 §3 为准）
- [ ] 三层联动：同窗对齐、共享十字线、tooltip 汇总三层读数、点击下钻抽屉
- [ ] 人工标注：登记 / 修改 / 删除闭环；曲线红圈、对照表列、台账三处同步（§5）
- [ ] era 条：provider 集合展示、api/local 措辞分级联动（对照 vs 归因）
- [ ] 门禁五件套全绿（typecheck / build / test / check:deps / check-meta）；产物重建后在既有 URL 刷新验收（AGENTS.md §7 GUI 红线）
- [ ] 端上实测记录环境四元组（dsh 版本 + profile + 装配方式 + 结果）

---

## 2. 设计令牌与主题

### 2.1 令牌表（`--nt-*`，组件内样式唯一取色处）

| 令牌 | 浅色 | 暗色 | 宿主来源（随宿主亮暗自动切换） |
|---|---|---|---|
| `--nt-bg / --nt-panel / --nt-panel2` | `#f2f2f0 / #fff / #f7f7f5` | `#121314 / #1a1b1d / #232427` | `--dsw-alias-bg-layer-1 / -2 / -3` |
| `--nt-border / --nt-border2` | `#d9d9d5 / #c8c8c3` | `#35363a / #4a4b50` | `--dsw-alias-border-l1 / -l2` |
| `--nt-text / --nt-dim / --nt-faint` | `#101010 / #5f5f5c / #9a9a95` | `#f2f2f0 / #a9a9a4 / #70706b` | `--dsw-alias-label-primary / -secondary / -tertiary` |
| `--nt-ok` | `#1a7f37` | `#3fb950` | `--dsw-alias-state-success-*`（兜底自持） |
| `--nt-accent` | `#e6321e` | `#e6321e` | **静态色，不随主题**（Swiss 唯一颜色主张；语义：era 徽标 / 关键点 / 预警 / 假设进行中 / 标注环） |
| `--nt-ink / --nt-gray` | `#101010 / #9a9a95` | `#f2f2f0 / #70706b` | 图表线色（墨线＝主读数，灰＝对照层），取 `label-primary/tertiary` |
| `--nt-font` | Helvetica 栈优先 | 同 | `--dsw-font-family` 兜底 |

### 2.2 主题规则

- 亮/暗切换 = **令牌源切换**，组件树零改动；宿主主题类驱动（现 client 已消费 `--dsw-alias-*`，机制同源）。
- 语义色使用纪律：朱红只用于「需要人工注意」的元素（阈值线、峰值标记、标注环、<80% 覆盖预警、验证中状态）；正常/成功一律中性或 `--nt-ok`。
- 图表对比度优先：曲线主线浅色主题用墨黑、暗色主题用纸白（`--nt-ink`），不用朱红画常规线。
- 版式语言：字距 1.5–2.5px 的大写微标签、大号细体数字（`font-variant-numeric: tabular-nums`）、直角（radius ≤2px）、FIG.NN 图号编排、口径注记块（`border-left: 2px` 灰）。

---

## 3. 信息架构（五视图 + 抽屉 + era 条）

### 3.0 宿主 UI 入口契约（2026-09-13 对 0.1.5-rc.2 安装树实测，slot 声明以 in-box 包 `lib/types` 为权威）

插件可占用的 UI 面共六类（工作台相关的为前两类）：

| 入口 | slot / 服务 | 作用域 | 约束与事实 |
|---|---|---|---|
| **全局面板**（工作台的正解） | `sidebar.panellist`（list，root）+ `main` keyed slot（root）+ `ctx.layout.selectPanel(id\|null)` | **root（与会话无关）** | panellist 注册图标项 `{id, order?, label}`（id 即 MainPanelId），侧栏按钮点击 → `selectPanel(id)` 后面板**占据整个中栏**（替换会话界面，composer 天然不在场）；`null` 回会话。布局几何：左栏 264–420px（收起 56px，窗口 <1024px 自动收起）、右栏首开 45%（上限 70%）、**中栏最小 400px**。`conversation` 这个 key 为会话界面保留。已装包中无消费者（task-board 走的是 `html[data-*]` overlay 绕法），一等注册需 `dsh.client.inject` 增列 `dsh-client-ui-layout`（服务）与 `dsh-client-ui-sidebar`（slot key 类型） |
| **会话 View 页签**（nautilus 现用） | `conversation.view`（list，**session**） | 逐会话 | 顶栏页签；**blank session 不渲染该 slot**；composer 同壳（现用 body 类隐藏是合规绕法）；View 选择规则 = 持久化偏好 > `chat`，绝不取第一个注册者 |
| 右侧停靠栏 | `rightbar.session` + `ctx.sidebarRight.openTab(kind)` / `openTabIn(sessionId, kind)` | 逐会话（可按 sessionId 寻址） | 页签式停靠面；宽度 45%~70%，可全屏；空间不足确定性收起 |
| 侧栏脚部动作 | `sidebar.footer.action`（list，root） | root | Settings 旁的小动作位（列宽状态 only） |
| 设置 | `settings.section` / 插件设置卡（`settings.plugin.item`） | root | 标准设置卡（host 半 `installSettingsSection` 配对） |
| 会话流内 | conversation nodes / composer chain / 工具 presentCall·Result | session | 对话流内节点、composer 临时项、工具卡（AGENTS.md §4） |

**主题机制佐证**：layout presenter 把解析后的主题快照投影为 `html{color-scheme}` + `body[data-ds-dark-theme]` + body 内联别名 token——`--nt-*` 经 `--dsw-alias-*` 跟随宿主亮暗即此机制，U1 实现方向无误。

### 3.1 工作台挂载（OQ-U2 据此收敛）

- **五视图进「全局面板」**：`sidebar.panellist` 注册「Nautilus」图标 + `main` keyed 面板——原型中的左侧竖导航在宿主里**就是宿主自有 sidebar**（图标 = 入口），面板内部 = 原型的顶栏 + 视图内容；五视图用面板内 segmented 二级切换，无会话也可用（root 作用域，天然满足工作台的全局/vault 两态）。
- ~~现有双 tab 保持不动~~ **2026-09-27 更新（两次）**：vault 观测腿下线删掉「Vault 观测」tab；随后 L 场读数能力**全部搬进工作台**（视图两态 / 指向切换 / 累计输入 / 轮次轴 / 自评覆盖），「L 场读数」tab 一并删除——**客户端半区只剩工作台一个入口面**（`sidebar.panellist` 图标 + `main` 面板），`conversation.view` 不再注册。
- 面板内栅格须响应中栏压缩（右栏打开时中栏可到 ~400px）：沿用原型 <1080px 单列回退，另验窄栏形态。

```
┌─┬────────────────────────────────────────────┬───────┐
│左│ 顶栏：NAUTILUS · 视图切换(全局/指向) · 时间 │ 抽屉  │
│侧│ 范围 · era 条 · 主题切换                     │ (下钻)│
│导│────────────────────────────────────────────│       │
│航│  视图内容（五选一）                          │       │
└─┴────────────────────────────────────────────┴───────┘
```

| 视图 | 内容 | 关键交互 |
|---|---|---|
| **总览** | 三组 stat 面板（NEXUS 4 / INFER 4 / PULSE 4，Grafana stat 行式）；FIG.01 三层联动图；FIG.02 最近关联对照流；预言摘要 | 联动十字线；点击下钻 |
| **曲线与归因** | FIG.03 大曲线（指标三选：未命中/TPS/累计；会话筛选；阈值线；τ_e 标注；形态分布可展开）；FIG.04 最近关联对照表（可下钻）；FIG.05 标注台账 | 指标/会话/范围联动重绘；表格行下钻 |
| **假设台账** | H-x 卡片（状态徽标 + 证据链 + 反事实讨论）；登记新假设表单（陈述 + 预言关联勾选） | 展开/收起；登记；标记已检验/证伪 |
| **预言检验表** | P1–P9 行：状态下拉（待标注/进行中/已检验）+ 备注输入 + 保存；顶部计数徽标 | 即时保存 + toast |
| **归因报告** | 报告样例页：元数据块（era/provider 集合/对照集/窗口/范围）+ §1 假设与预言 + §2 证据链表 + §3 结论（措辞分级）+ §4 反事实 + 人工门控（批准归档/退回修订） | era 联动措辞；门控动作 |
| **调查抽屉** | 单轮下钻：三层同期快照表 + 问答原文 + **人工标注区** + 关联假设 + 操作（据此登记新假设 / 在报告中打开） | 从曲线点、对照表行、台账「定位」进入 |

**挂载与导航（实现注意）**：工作台 = **`main` keyed 全局面板**（入口契约见 §3.0），原型中的左侧竖导航在宿主里即宿主自有 sidebar 的 panellist 图标；era 声明条常驻视图顶部：`era=api` 显示 provider 集合与对照集 `{ pulse.proc.dsh.*, infer.turn.* }`；点击弹层给判定依据（`message.source.{provider,model}` 逐调用）与对照集规则；`local` 预览切换仅影响措辞分级（对照/归因），并明示「本地部署未落地，仅演示」。

---

## 4. 组件规范（关键条目）

| 组件 | 规范要点 |
|---|---|
| stat 面板 | 层级角标（NEXUS/INFER/PULSE，右上 8.5px 字距 1.5px）+ 大写微标签 + 25px 细体数值 + 灰色小注；预警态数值转朱红；4 列栅格 <1080px 回退单列 |
| 联动图 | 三层纵向堆叠（主图 168px + 对照层 88px），同一 x 域（轮次序）；发丝网格 + 4 档 y 刻度；朱红实心点＝峰值同窗轮；朱红虚线阈值 24%（P1）；τ_e 区间虚线注记；共享十字线 + 汇总 tooltip；空态「暂无数据」 |
| 曲线图 | 同上单层版 + 指标切换（未命中/TPS/累计）；累计为逐会话累加（弱代理口径注记必显） |
| 对照流/对照表 | 行＝单轮：时刻、轮号、CPU、TTFT、A 投影、标注徽标、判读（措辞随 era）；行可点下钻 |
| 假设卡 | id 加粗 + 陈述 + 状态徽标（验证中=朱红/成立=ok/证伪=灰）+ 预言关联 + 证据链/反事实展开区 |
| 预言表 | P1–P9 中文描述 + 状态下拉 + 备注输入 + 行内保存；顶部三态计数 |
| 报告页 | **唯一使用衬线正文处**（Georgia/思源宋栈，行高 1.95）——S2 气质的局部借用，仅限报告内容排版；元数据块网格化；人工门控朱红边框块 |
| 抽屉 | 400px 右滑 + 遮罩；Esc/遮罩/关闭钮三路退出；打开期间暂停轮询（沿 nautilus M4.2 惯例） |
| toast | 底部居中 2.2s，用于一切 mock 写操作回执 |
| 口径注记 | 每个图表下方必带（Fact First）：统计口径 / 混杂来源 / 诚实边界（示意数据声明） |

### 4.5 图表语法升级（2026-09-20 守谷人裁决：方案 A「自绘借鉴」，不引入图表库）

**裁决背景**：观测看板此前只有折线 + 表格两种表达，守谷人判定「太单调」，指示借鉴大厂开源观测看板（Grafana / Netdata / Datadog），不反复造轮子。三方案对比（A 自绘语法升级 / B 最小改造 / C 引入 uPlot）后裁决 **方案 A 全量**：借组件语法、不借引擎——瓶颈在表达语法（构成/占比/排行/状态的缺席），不在图表引擎性能（数据 ≤240 点，SVG 自绘已解决等比缩放/缩放平移/全屏）。

| 借鉴组件 | 出处 | 落点 | 实现 |
|---|---|---|---|
| stat 卡内嵌走势线（sparkline） | Grafana Stat / Datadog Query Value | 总览 stat 卡（命中率=逐轮未命中率序列、读数规模=累计输入令牌；PULSE 头条 4 卡=近 1h 序列） | `charts.ts Sparkline` |
| 每指标一图 + 跨图同步十字线 | Netdata 方法论（「每个指标默认就有图」） | FIG.01 PULSE 15 指标：表格 → USE 资源族分区小图网格（3 列），共享 hoverTs，悬停读数列于网格上方 | `charts.ts MiniChart`（无 hooks，hover 由 OverviewView 持有） |
| 占比横条 gauge | Grafana Bar Gauge | FIG.01：CPU/GPU 利用率、内存/显存占比；朱红刻度＝阈值（CPU 85% / GPU·内存·显存 90%），越过转朱红 | `charts.ts BarGauge` |
| 堆叠构成柱 | Grafana Node Exporter Full 构成行 | 曲线视图新增「输入构成」档：每轮一根，缓存读（墨）+ 未命中输入（朱红）；输出令牌为另一维度不入图；悬停构成/点击下钻 | `charts.ts StackedBars` |
| 状态带 | Grafana State Timeline | FIG.01 采集健康带（近 1h 逐桶样本在场，空白=中断）；FIG.10 会话活跃带（首末轮跨度包络） | `charts.ts StateBand` |
| 排行条 | Datadog Top List | FIG.10 会话输入令牌排行 Top 8（附轮数） | `charts.ts TopList` |
| USE 资源族分区 | Brendan Gregg USE 方法 / node exporter 生态 | PULSE 指标按 CPU/内存/GPU/进程/磁盘/网络 分区呈现 | `metricGroup()`（已有）+ 族头样式 |

**实现纪律**：新原语集中 `src/client/charts.ts`（零第三方依赖、SVG/DIV 自绘）；**全部无 hooks**（可像 Stat/Spark 一样直调，交互状态由视图持有经 props 传入）；颜色只取 `--nt-*` 令牌（var() fallback 之外零硬编码色，测试守卫）；缺席态显式（无序列 → 「暂无数据」，无指标 → 对应 gauge 不渲染，不写 0）。测试：SSR 冒烟新增总览网格/排行/健康带 + 缺席诚实态断言，charts 原语形状/空态/纯度守卫（`scripts/test.mjs` 末尾三条）。

**布局二次修订（2026-09-20，守谷人对首版反馈：排版乱 / 主图太小 / 小图重复）**：

1. **FIG.01 主图 2×2**：CPU 利用率 / 内存占用 / GPU 利用率 / 宿主 RSS 四项升为交互大图（`PulseChart`，设计坐标 1000×170、meet 等比）：**滚轮放缩**（指针为锚，min 8 点）· **左键按住拖动平移** · **双击复位**，交互口径与曲线视图 CurveChart 一致；悬停读数显示在图头（原始值，不取插值）。原「头条 stat 卡 + sparkline」撤销——它们与主图重复。
   **平移改左键（2026-09-20 四次反馈）**：右键拖动与浏览器手势冲突——两处平移（`PulseChart` + `CurveChart`）统一改**左键按住拖动**，以 4px 位移阈值区分点击与拖动（曲线视图 <4px 松开＝点击采样点下钻，逻辑自 svg onClick 迁至 mouseup）；右键还原给浏览器（contextmenu 抑制已移除），拖动期间 `user-select:none` 防误选。
   **拖动灵敏度同鼠标（2026-09-20 五次反馈）**：索引位移 = 像素位移 ÷ 缩放 × (窗口跨度 ÷ 绘图区宽)——旧实现漏乘 `跨度/绘图区宽`，拖 1px 跳 1 索引、比鼠标快约 4 倍；修正后按住时指针下的数据点全程跟手（抓点绑定，取整误差 ≤0.5 索引）。
2. **小图去重**：USE 分区小图网格只列**主图之外的次要指标**；全部为次要指标时（未来可能）读数位随之隐藏。
3. **次要看板折叠**：`Panel` 新增 `collapsible`/`defaultCollapsed`（原生 `<details>/<summary>`，无 hooks、SSR 友好）；总览默认收起 FIG.02（最近轮次——数据曲线视图在）与 FIG.08（L 场指向——低频配置操作）。
4. 测试同步：SSR 冒烟断言 `nt-maingrid`/主图图头（最新值 + 交互提示）/`<details>` 折叠/主图恰 4 格；缺席诚实态断言保留。
5. **曲线刷新与心跳对齐（2026-09-20 三次反馈）**：PULSE 序列取数不再固定 60 s——`heartbeatSeriesMs()`：auto 档 = max(1s, 心跳档位间隔)，手动档 = 0（不轮询，采样完成经 nonce 触发重取），PULSE 缺席 = 60 s 兜底；总览主图/小图（`usePulseSeriesMap`）与曲线视图 PULSE 模式（`useJson`）统一走该口径，图注显式标注当前刷新频率（`heartbeatRefreshLabel`）。悬停缩放窗为索引窗，随滑动窗口整体前移（每桶位前移一格），与 Grafana 实时看板行为一致。

---

## 5. 人工标注 UI（本轮新增，定版）

### 5.1 定位与边界

- 标注是 nexus 层读数之上的**人工判读层**：记录「这轮发生了什么 / 为何异常 / 如何处置」，**不修改、不删除任何原始读数**（红线：采集数据不可变）。
- 与既有两套标注的关系：**预言标注**（`m2/annotations`，prophecy 维度，已有）不动；**自评**（clarity/defense/declaration，agent 侧产出）不动；本节新增的是**轮次维度的人工标注**。

### 5.2 交互流

1. **入口**：曲线/联动图上点击任意轮点位、对照表行、对照流行 → 抽屉；
2. **登记**：抽屉「人工标注」区 = 标签下拉 + 备注输入 + 保存；
3. **呈现**（三处同步）：曲线点位外圈**朱红虚线圆环**；对照表「标注」列徽标；曲线页 FIG.05 标注台账（轮次/标签/备注/定位/删除）；总览对照流内联徽标；
4. **维护**：抽屉内修改/删除；台账内定位/删除。全程 toast 回执。

### 5.3 数据结构（提案，落地见 §6）

```ts
{ session: string, turn: number,            // 轮次身份（唯一键）
  tag: 'burst'|'mixed'|'external'|'review', // 爆发 / 混杂 / 干扰 / 复核
  note: string | null,                      // 判据 / 混杂来源 / 处置
  author: string, createdAt: number, updatedAt: number }
```

- 标签枚举四值起步：`爆发`（朱红徽标）`混杂`（灰）`干扰`（朱红）`复核`（灰）；枚举扩充需回写本文档（OQ-U3）。
- 展示色纪律：徽标底色随标签语义（需要行动＝朱红边），台账不引入第二种强调色。

---

## 6. 数据契约与 API（对齐 §5 + 现有面）

**现有**（`src/routes.ts`，实现时逐条核对，不凭本文档）：`GET m2/state` · `GET m2/analysis` · `GET m2/turn-text` · `GET/POST m2/annotations`（预言）· `GET/POST lfield` · pulse 三条（`state`/`series`/`control`）。**vault 观测腿 2026-09-27 下线后** `GET state` / `POST action` / `GET+POST vault` 已删除；原文保留如下：`GET state` · `POST action` · `GET/POST m2/annotations`（预言）· `GET m2/state` · `GET m2/analysis` · `GET m2/turn-text` · `GET/POST lfield` · `GET/POST vault`。

**新增提案**（轮次人工标注；命名沿用 `m2` 前缀，路由进 `API_PREFIX` 集中常量）：

| 端点 | 方法 | 语义 |
|---|---|---|
| `/api/nautilus/m2/turn-annotations?root=` | GET | 当前视图口径的标注列表（session/turn/tag/note/author/时间戳） |
| `/api/nautilus/m2/turn-annotations` | POST | upsert（`session+turn` 唯一；带 `revision` 乐观校验，冲突 409） |
| `/api/nautilus/m2/turn-annotations` | DELETE | 按 `session+turn` 删除（软删或硬删见 OQ-U4） |

**存储**：新表 `turn_annotation`（`session`/`turn` 复合主键 + `tag`/`note`/`author`/`ts`），走 v{N+1} 幂等迁移；`annotation` 表（预言）不动。`author` 取宿主侧可得的会话主体标识，取不到先落 `'local'`。

---

## 7. 工程实现对齐（客户端半区）

- 形态：普通 Cordis 客户端插件，命名导出（**无 `export default apply`**，AGENTS.md §2）；`inject` 列 `slots`；slot key `conversation.view`。
- 渲染：React `createElement`（无 JSX）；**零新依赖**；图表 SVG 自绘（沿 nautilus LineChart 路线扩展联动层）；样式组件内 `<style>` 一次性注入，class 前缀已迁移为 `nt-`（U1）。
- 全局面板注入（§3.0）：`dsh.client.inject` 增列 `@deepseek-ai/dsh-client-ui-layout`（`ctx.layout.selectPanel`）与 `@deepseek-ai/dsh-client-ui-sidebar`（`sidebar.panellist` slot key 类型）；panellist 项写 `options.id`、main 写 `options.key`，两值同为 `MainPanelId`（同值即「图标行 ↔ 主区面板」的绑定）。
- 令牌层落地步骤：现 `STYLE` 中硬编码别名处改写为 `--nt-*` 引用；`--nt-*` 默认值取 `var(--dsw-alias-*, <fallback>)` 形式（宿主令牌优先，原型色为 fallback）——**亮暗切换零组件改动**的关键。
- 状态与轮询：沿 nautilus 现有 `revision` 轮询惯例；抽屉打开期间暂停（M4.2 惯例）；标注写操作走 §6 API，失败 toast 不静默。
- 原型 → 组件映射：原型每视图 ≈ 一个组件函数；stat/面板/表格/抽屉先抽公共件再铺视图；era 措辞分级收口为单一 `eraWord()` 帮助函数（避免「对照/归因」裸串漂移——集中常量纪律）。
- 门禁：五件套 + client shim 断言；`lib/` 重建后**在既有 URL 刷新**验收（postmortem 0003）。

---

## 7.5 落地状态（2026-09-13，实现已入主线）

| 项 | 落地位置 | 状态 |
|---|---|---|
| 五视图 + 抽屉 + era 条 | `src/client/workbench.ts`（600 行） | ✅ 已实现，产物已下发（§E10） |
| 全局面板入口 | `src/client/index.ts`：`sidebar.panellist`（list 槽 → `id`，order 50，label 走函数形）+ `main`（**keyed 槽 → `key`**），两值同 `nautilus-workbench` | ✅ 已注册并进常驻测试 |
| 槽位标识字段 | `list` → `options.id`；`keyed` → `options.key`（传错抛 `keyed slot main requires options.key`，并拖垮整批浏览器半区插件集） | ⚠️ 硬契约，见 §E10 |
| 逐会话双 tab | ~~同文件，`conversation.view` ×2~~ **2026-09-27 收敛**：vault 观测 tab 随观测腿下线删除、L 场读数 tab 能力搬进工作台后删除——客户端半区只剩工作台一个入口面（`client/index.ts` 仅 inject + sessionNameOf + 工作台双注册），`conversation.view` 不再注册 | ✅ 已收敛 |
| 图表语法升级（§4.5） | `src/client/charts.ts`（Sparkline/MiniChart/BarGauge/StackedBars/StateBand/TopList，全部无 hooks）+ 总览 FIG.01 网格化（USE 分区/同步十字线/gauge/健康带）+ FIG.10 会话活跃与排行 + 曲线视图「输入构成」堆叠柱档 | ✅ 2026-09-20 落地（六件套 30/30；端上验收待 dsh-next 刷新，稳定版 dsh 不动） |
| `fmtK` 缺失修复 | `curveLabel('cum')` 的 y 轴格式引用了未定义的 `fmtK`（客户端半区无 tsc 把关漏网）——切「累计输入」档会 ReferenceError | ✅ 顺手修复 |
| 取数口径 | §6 现成只读 API：`/state` · `/m2/state?root=all` · `/m2/annotations` · `/m2/turn-text` · `/pulse/state` | ✅ 未命中率对齐 `routes.ts:167`（`tokenIn/(tokenIn+cacheRead)`） |
| 唯一写路径 | `POST /api/nautilus/m2/annotations`（预言标注） | ✅ 失败 toast 不静默 |
| 缺席态 | INFER 层未接入 / 无数据 → 缺席文案与诚实边界，不写 0 | ✅ 全视图覆盖 |
| 浏览器渲染确认 | 既有页面刷新后人工确认（device-auth 门，无自动化） | ⏳ 待守谷人 |
| `dsh.client.inject` 新值生效 | 重启后已生效（启动图行含 layout/sidebar 两条边，§E12） | ✅ 收敛 |
| 返回会话入口 | `src/client/workbench.ts` 头部「← 返回会话」→ `ctx.layout.selectPanel(null)`；客户端 `inject` 加 `layout` | ✅ 端上首轮反馈修复（§E13） |
| OS 层读数呈现 | 总览「系统层读数（PULSE · 本机）」面板：4 头条 + 15 指标全表 + 采集健康行；量纲取自 `src/pulse/{collect,counters}.ts` | ✅ §E13 |
| PULSE 采样曲线 | 曲线视图数据源切换（NEXUS 轮次 / PULSE 采样）+ 指标下拉 + `/pulse/series?windowMs=3600000&maxPoints=240` | ✅ §E13 |
| 视图错误隔离 | `ViewBoundary`（类组件）：单视图抛错只替换该视图并显示错误原文 + 重试 | ✅ §E13 |
| **视图必须渲染为元素** | 禁 `CurveView({...})` 直调——子组件 hooks 会算进父组件，切视图即 hooks 数量变化 → 整页渲染失败 | ⚠️ 硬教训，见 §E13 |

---

## 8. 验收证据要求

- 视觉验收：对照原型逐视图截图归档（浅/暗两态）；
- 标注闭环：登记 → 三处呈现 → 修改 → 删除，各一步实际操作记录（环境四元组）；
- era 联动：api/local 切换后对照表与报告措辞变化的前后对照；
- 涉统计口径无变更（标注为判读层），但需给出「标注前后读数一致」的说明性对照（诚实边界）。

## 9. 遗留与开放问题

- **OQ-U1 报告页载体**：归因报告进面板视图（现方案）还是落 vault 文档 + 面板只读预览？涉 vault 写边界，待裁决。
- ~~OQ-U2 导航形态~~ **已收敛（2026-09-13，§3.0/§3.1 实测）**：工作台 = `main` keyed 全局面板 + `sidebar.panellist` 图标入口；面板内 segmented 二级切换；现有双 tab 保留为逐会话快捷视图（是否迁入工作台另议，不扩本文件 scope）。
- **OQ-U3 标签枚举**：四值是否够用（如需「污染-预热 / 污染-截断」细分），守谷人裁定后回写 §5.3。
- **OQ-U4 标注删除语义**：硬删 vs 软删留痕（审计诉求 vs 库体积）；倾向软删 + `deletedAt`。
- **OQ-U5 标注 author**：多主体使用时的身份来源（宿主用户标识可得性）。
- **OQ-U6 浏览器渲染验收**：实现已下发（§E10），但「图标出现 / 五视图成形 / 抽屉开合」需人工在既有页面刷新后确认；确认前不宣称 UI 交付完成。

## 关联文件

- [./ui-s4-prototype.html](./ui-s4-prototype.html) — 交互原型（视觉与交互权威参照，含双主题与人工标注演示）
- [../1-planning/nautilus-nautilus-positioning.md](../1-planning/nautilus-nautilus-positioning.md) — 上游：L2 阶梯、差异化矩阵
- `../AGENTS.md` §3/§7 — 客户端半区契约、GUI 验收红线；`../../CONTRIBUTING.md` — 工程约定权威
