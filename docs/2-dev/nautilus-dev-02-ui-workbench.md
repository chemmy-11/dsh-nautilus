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
| U3 | 信息架构 | **六视图**（总览 / **告警** / 曲线与归因 / 假设台账 / 预言检验 / 归因报告）+ 右侧调查抽屉 + era 声明条；挂载 = `main` keyed 全局面板 + `sidebar.panellist` 图标（§3.0 宿主入口契约实测）。**告警为 A 系列（D-A4）增量视图，2026-09-24 入册** |
| U4 | 三层联动 | 同一时间范围 + 共享十字线 + 汇总 tooltip，NEXUS/INFER/PULSE 三层同窗对齐（w=30s 中位数） |
| U5 | 人工标注 | nexus 层轮次级人工标注：抽屉内登记（标签 + 备注），曲线红圈 / 对照表列 / 标注台账三处呈现；**判读层，不改原始读数** |
| U6 | 实现形态 | 零新依赖；React `createElement`；SVG 自绘；`--nt-*` 令牌层（默认值映射 `--dsw-alias-*`）；class 前缀 `nt-` |

---

## 1. 目标与验收

**目标**：把 L2「工作台呈现」的视觉与交互定版，产出可直接照做的客户端半区实现规范；人工标注闭环（登记 → 呈现 → 台账 → 删除/修改）可交互。

**验收标准**：

- [ ] 令牌层：`--nt-*` 变量表落地，除朱红外无硬编码色；浅/暗两态随宿主主题切换，组件零改动
- [ ] 六个视图 + 抽屉 + era 条全部可交互；原型覆盖前五视图，**告警视图以 §3.2 为准**（A 系列增量，原型无此页）
- [ ] 三层联动：同窗对齐、共享十字线、tooltip 汇总三层读数、点击下钻抽屉
- [ ] 人工标注：登记 / 修改 / 删除闭环；曲线红圈、对照表列、台账三处同步（§5）
- [ ] era 条：provider 集合展示、api/local 措辞分级联动（对照 vs 归因）
- [ ] 门禁五件套全绿（typecheck / build / test / check:deps / check-meta）；产物重建后在既有 URL 刷新验收（AGENTS.md §7 GUI 红线）
- [ ] 端上实测记录环境四元组（dsh 版本 + profile + 装配方式 + 结果）

---

## 2. 设计令牌与主题

### 2.1 令牌表（`--nt-*`，组件内样式唯一取色处）

**唯一定义处**：`src/client/theme.ts` 的 `NT_TOKENS` 表（生成 CSS，纯函数 `ntThemeCss()`）；组件内只允许 `var(--nt-*, <兜底>)` 取色，测试守卫「除该表外客户端零硬编码色」。

| # | 令牌 | 浅色 | 暗色 | 宿主来源（有值即 `var(--dsw-alias-*, 兜底)`） |
|---|---|---|---|---|
| ① 面层（S4 签名，**自持不绑宿主**，理由见 §2.3） | | | | |
| 1 | `--nt-bg` | `#f2f2f0` | `#121314` | —（图纸底） |
| 2 | `--nt-panel` | `#ffffff` | `#1a1b1d` | —（卡片面） |
| 3 | `--nt-panel2` | `#f7f7f5` | `#232427` | —（次级面：表头 / 条带 / 输入槽） |
| ② 墨与线（**绑定宿主**） | | | | |
| 4 | `--nt-text` | `#101010` | `#f2f2f0` | `--dsw-alias-label-primary` |
| 5 | `--nt-dim` | `#5f5f5c` | `#a9a9a4` | `--dsw-alias-label-secondary` |
| 6 | `--nt-faint` | `#9a9a95` | `#70706b` | `--dsw-alias-label-tertiary` |
| 7 | `--nt-ink` | `#101010` | `#f2f2f0` | `--dsw-alias-label-primary`（图表主线＝主读数） |
| 8 | `--nt-border` | `#d9d9d5` | `#35363a` | `--dsw-alias-border-l2` |
| 9 | `--nt-border2` | `#c8c8c3` | `#4a4b50` | `--dsw-alias-border-l3` |
| 10 | `--nt-ok` | `#1a7f37` | `#3fb950` | `--dsw-alias-state-success-primary`（正常 / 成功态） |
| 11 | `--nt-hover` | `rgba(20,20,18,.05)` | `rgba(255,255,255,.08)` | `--dsw-alias-interactive-bg-hover` |
| 12 | `--nt-mask` | `rgba(0,0,0,.28)` | `rgba(0,0,0,.5)` | `--dsw-alias-bg-mask-1`（抽屉遮罩） |
| ③ 自持 / 静态 | | | | |
| 13 | `--nt-shadow-color` | `rgba(0,0,0,.16)` | `rgba(0,0,0,.55)` | —（浮层投影色；暗色下黑投影不可见，必须加重） |
| 14 | `--nt-accent` | `#e6321e` | `#e6321e` | **静态色，不随主题**（Swiss 唯一颜色主张；语义：era 徽标 / 关键点 / 预警 / 假设进行中 / 标注环） |
| 15 | `--nt-font` | Helvetica 栈优先 | 同 | —（宿主无 `--dsw-font-family` 令牌，自持） |

> 变更自 v0.2 表：新增 11/12/13；`--nt-gray`（图表对照线）**暂不入表**——当前实现无对照层消费者，死令牌会漂移成假规格（守卫：声明了却无人 `var()` 即测试失败），待对照层回场再加；`--nt-font` 原写「`--dsw-font-family` 兜底」，实测宿主无此令牌（0.1.7-rc.1），改为自持。

### 2.2 主题规则

- 亮/暗切换 = **令牌源切换**，组件树零改动。**驱动源 = 宿主投影的 `body[data-ds-dark-theme]`**：theme-presenter 把「解析后的主题快照」投影为 `html{color-scheme}` + 该 body 属性 + body 内联 `--dsw-alias-*`（`@deepseek-ai/dsh-client-ui-layout` `DARK_ATTRIBUTE`，0.1.7-rc.1 实测），故本层**不做 JS 监听**、不读 `ctx.theme`——宿主换肤 → 属性翻转 → 令牌整块切换，与宿主零竞态、零闪烁。
- **档位**：默认「跟随宿主」；顶栏另给「浅色 / 深色」手动档（持久化在插件自有 localStorage 键 `dsh-nautilus:theme`）。手动档只覆盖 `.nt-wb` 子树，**不写宿主 body 属性、不调 `ctx.theme.setTheme`**——那会改掉整个 GUI 的主题，越「观测，不干预」的线。
- 语义色使用纪律：朱红只用于「需要人工注意」的元素（阈值线、峰值标记、标注环、<80% 覆盖预警、验证中状态）；正常/成功一律中性或 `--nt-ok`。
- 图表对比度优先：曲线主线浅色主题用墨黑、暗色主题用纸白（`--nt-ink`），不用朱红画常规线。
- 版式语言：字距 1.5–2.5px 的大写微标签、大号细体数字（`font-variant-numeric: tabular-nums`）、直角（radius ≤2px）、FIG.NN 图号编排、口径注记块（`border-left: 2px` 灰）。

### 2.3 绑定纪律：跟随发生在「模式」与「墨线」两层，面层自持（2026-09-24 落地实证）

落地前逐条核过宿主别名实值（dsh 0.1.7-rc.1，`@deepseek-ai/dsh-client-ui-theme/lib/client.js` 内联样式表：`body` / `body[data-ds-dark-theme]` 两块），据此定下三条纪律：

**① 墨 / 线 / 状态 / 交互 → 绑定宿主。** 宿主亮暗确实区分这些别名，且把宿主给的**半透明线压在本插件面上**算出的复合色与 S4 定版值几乎重合：

| 令牌 | 宿主别名 | 浅色复合（压 `#f2f2f0`） | S4 定版 | 暗色复合（压 `#1a1b1d`） | S4 定版 |
|---|---|---|---|---|---|
| `--nt-border` | `--dsw-alias-border-l2` | `#d9d9d8` | `#d9d9d5` | `#363738` | `#35363a` |
| `--nt-border2` | `--dsw-alias-border-l4` | `#cbcbc9` | `#c8c8c3` | `#48494a` | `#4a4b50` |

> 最初把 `--nt-border2` 绑在 `border-l3` 上——复合出 `#d5d5d3` / `#3f4041`，浅暗两侧都偏离定版；换 `-l4` 后两态同时贴合，故改绑（数值即选型依据，不靠手感）。

**② 三级面 → 自持 S4 定版色。** 宿主**浅色**把四级面折叠成同一个值：`bg-base` / `bg-layer-1` / `-2` / `-3` 全部 = `var(--dsw-static-neutral-bluish-00)` = `#fff`——照 §2.1 原表绑定，工作台会变成整片白，「图纸底 / 白卡片 / 次级面」的层次被抹平；暗色下宿主反而分四级（`#151517 / #232324 / #2c2c2e / #353638`）。**同一个别名在两态承载不同语义，不适合作设计层次的锚**，故面层自持原型定版值——宿主换肤时面层切到另一套定版值，墨线实时跟随宿主。

**③ 朱红静态。** 不绑任何宿主别名（Swiss 唯一颜色主张），亮暗同值；测试守卫：「亮暗同值令牌只允许 `--nt-accent` 与 `--nt-font`」。

**手动档为何不写宿主设置**：`ctx.theme.setTheme('dark')` 会连用户偏好（`ui-theme` 设置）一起改掉，越「观测，不干预」的红线；故手动档走 `.nt-wb[data-nt-theme]` 局部覆盖 + 插件自有 localStorage 键，且**只作用于工作台子树**——侧栏图标与流内契合条在 `.nt-wb` 之外，属宿主色谱面，永远跟随宿主。

- **OQ-U7（留口，非阻塞）**：是否接受「浅色下也把三级面交给宿主」＝工作台整片白、只靠发丝线分层（更贴宿主、更失去 S4 图纸感）？——**2026-09-24 验收按自持形态判通过**（默认形态成立），此项仍留口待日后裁决。

---

## 3. 信息架构（五视图 + 抽屉 + era 条）

> **2026-09-28 AL.4a 收敛（UI 线，feat/ui）**：工作台视图由六收敛为**四**（总览 / 告警 / 曲线 / 报告）——
> 「假设台账」「预言检验表」两视图连同其标注读写层（`GET/POST /m2/annotations`、`PROPHECY_SEED`、标注 UI）整块撤除；
> 「工作区指向」抽象（视图两态 pointed/all、指向切换、总览 FIG.08 面板、`GET/POST /lfield`）同步撤除。
> 因此本面板**已无任何写路径**；曲线（未命中率 / 时长 / tps / 累计输入）与白盒 analysis（形态 / τ_e）**全部保留**。
> `annotation` / `lfield_config` / `session_root` 三表**保留不 drop**（红线 3，历史数据不删）。
> 下列原型描述保留为设计沿革，落地以 `src/client/workbench.ts` 为准。

> **2026-09-28 AL.4b 增补（UI 线，feat/ui）**：工作台新增**「对齐」视图**（位次：总览之后），视图数四 → 五。
> 只读消费主线冻结的读侧契约 GET /api/nautilus/m2/alignments，**不自造任何接口**（源码守卫：该视图切片内出现的 /api/ 路径只允许这一个）。
> 五块内容：**双路台账**（人工 (session,turn) 与自评 (ext_ref,turn_ordinal) 同键并列；列 轮次 / 人工 / 自评 / Δ / 边界 / 引文备注 / 时间；只有一侧有行的也列出）·
> **分布**（人工与自评各一组 align 1–5 计数柱；legacyFitRows 单列为「旧 0–4 档行（代际，不混算）」）·
> **边界计数**（无 / 替代 / 占有 / 强迫 / 投射，正交轴，不与分数合并）· **一致性**（pairs / 完全一致率 / 相邻档一致率 / 二次加权 κ；consistency 为 null 时显示「样本不足（<2 对）」而非 0）·
> **版本面**（schema_version=2 · rubric_version=al-v1；1–5 锚文进 hover title）。pairs < 50 时显式标注「只作观察，不得据此调整 rubric」（决策 §5 纪律）。
> 术语纪律：视图内**不得出现「契合」**（该词已随量表换代废止，代际行改称「旧 0–4 档行」）。
> 同步修一条真实回归：面板「自评覆盖」原读 turn_read.clarity（AL.3 起停写，会静默停更）→ 改读 alignments 的 coverage.selfAligned。

> **2026-09-28 AL.4c 换代（UI 线，feat/ui）**：会话内打分件由「契合 0–4」换成**「对齐 1–5」**，并同步契约 v2 增量。
>
> **A. 换代**：① 锚文不再写死在客户端——1–5 锚文取契约 scale.anchors（本地量表常量 FIT_SCALE 撤除），标签 / 浮层标题 / 提示一律「对齐」。
> ② 写路径改走 POST /m2/turn-annotations 的**双形 body**（带 align / 仅 exempt），不再发 fit。
> ③ 读态改 join 契约 human[]（(session,turn) 同键），锚文同源。**已知偏差（已回报）**：契约 human[] 只含 align 非空行、豁免行不进数组，
> 单靠它会丢掉「已标 N/A」态——故豁免态仍由既有 T 系列 GET 补一笔（不新增端点；契约若补 human 侧豁免键即可撤掉这一路）。
> ④ 视图吃 v2：selfRatio 真比率（selfTotal=0 显示「分母为 0（缺席）」而非 0%）、代际隔离 human/self **两侧各自独立计数**、
> 一致性表补**留出集（采纳判据）**一行、**删本地阈值常量改读契约 scale.min**（守卫：不得再出现本地阈值常量）。
> ⑤ Drawer：「推理态自评」三行 clarity/defense/declaration（取自 turn_read，AL.3 起停写 → 永久显示「未落盘」）→
> 换成 per-turn 人工/自评 align（human[] + self[] 同键 join，缺就是缺、不写 0）。
> ⑥ 术语守卫扩到**整个客户端半区**（不再只扫对齐视图切片）；负控：往打分件注入「契合」→ 视图 SSR 断言与术语守卫**同时**变红。
>
> **B. 布局（B1–B7 的裁决依据，守谷人 2026-09-28）**：浮层 = 「对齐 1–5」一行 + 「边界」可选第二行（默认「无」、**非必填**）+ 单一输入框；提交按钮在 N/A 右侧同排。
> · **边界为什么必须由人填**：边界是「对齐」定义里信息量最大的那一半（推进 = 接 / 顺 / 推 + **不越四条边界**）；
>   若人工侧只能填 none，boundary 轴就只剩自评在填，人工/自评的边界计数**不可比**，AL.5 的边界统计会退化成「自评自说自话」——
>   那是拒绝独立裁判之后最该警惕的另一种自证。
> · **为什么默认「无」+ 按需展开**：不改变现有 5 档那一行的点击路径，只有真要标越界时才多点一下（渐进披露，零额外摩擦）。
> · **为什么不做必填**：纯操作性轮本来就走 N/A 豁免（工具通道是「不调用」，人工侧是 exempt），别用必填把豁免路径堵死。
> · **两条硬约束**：**正交**——边界与分数各自落库（两条列），UI 不做任何方向的互相推导（标「占有」不改分数，改分数不清边界）；
>   **诚实的边界**——一致性三指标只算 align、**不含 boundary**，故边界计数是**描述性**的，不得暗示「边界一致性已被度量」；
>   日后要算边界一致性属新口径，另开 OQ。
> · **改动明细**：B1 文案「契合」→「对齐」（未标 / N/A / 已标三处渲染）· B2 浮层移到按钮**上方**（bottom:100%+6px、去掉 top；
>   贴顶由 max-height:min(70vh,420px) 限高滚动兜底，不做翻转）· B3 两个输入框（引文 textarea + 理由 input）**合一**
>   （≥4 走引文必填、否则走可空理由；提交时映射服务端两列，**不绕过**「≥4 必附引文」硬门）· B4「提交 4」→「提交」
>   · B5 删浮层轮次角标 tNN（原位置 = 打分框第一排 N/A 右侧的 hint 文本）· B6 提交并入 N/A 右侧同一排（row nowrap）
>   · B7 **先量后画**：min-width 由加总得出——5 档 × 28 + N/A 40 + 提交 ≈38 + 间距 6×4 + 内边距 9×2 + 边框 1×2 = **262 → 取 272**（留字体度量余量）；
>   控件统一 box-sizing:border-box（否则 min-width 落在内容盒，档位实际 ≈42px/个）。**改前**：min-width:230px 且 content-box → 一排需 ≈340px，
>   故旧「提交 4」被迫换行到第二排。
>
> **未闭环（如实记录，不假装已通）**：写侧双形路由**尚未上线**——当前 POST /m2/turn-annotations 仍是旧形（fit XOR exempt），
> 故对齐写入在此之前会收到 400（errText 已给人话：「服务端尚未接受对齐量表」）。
> 另：N/A 豁免走「不带 align」分支时服务端落**旧代际**行（schema_version=1），不进 humanTotal/exempted 而计入 legacyFitRows——
> 需写路由把判据补成「新量表豁免」（建议：boundary 键在场，或显式 align 键在场即可判新形），UI 侧无需改动。
> 测试缝：TurnFitAction 增 defaultOpen 仅供 SSR 断言浮层内容（renderToStaticMarkup 点不了按钮），线上不传、行为不变。
> 连带：scripts/test-t.mjs 的 T 系列 UI 测试断言了旧文案与 postFit({fit})，随换代改了 5 行（范围例外，已上报）。
>
> **端上验收的诚实边界**：活库当前 user_version=7（宿主未重启，v8/v9 迁移未跑），故**活宿主里没有 /m2/alignments 路由**；
> 本轮交付证据 = SSR 测试 + 负控（不依赖活宿主）。端上刷新看「对齐」视图需先重启宿主（会中断当前会话，属守谷人的决定）；
> 若在未重启的宿主上看到「对齐接口不可用（/m2/alignments）」，那是**预期形态**，不是缺陷。

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

- **六视图进「全局面板」**：`sidebar.panellist` 注册「Nautilus」图标 + `main` keyed 面板——原型中的左侧竖导航在宿主里**就是宿主自有 sidebar**（图标 = 入口），面板内部 = 原型的顶栏 + 视图内容；六视图用面板内 segmented 二级切换，无会话也可用（root 作用域，天然满足工作台的全局/vault 两态）。顶栏另有一个「告警 N · 24h M」快捷按钮直接跳告警视图（活跃时按钮转朱红）。
- ~~现有双 tab 保持不动~~ **2026-09-27 更新（两次）**：vault 观测腿下线删掉「Vault 观测」tab；随后 L 场读数能力**全部搬进工作台**（视图两态 / 指向切换 / 累计输入 / 轮次轴 / 自评覆盖），「L 场读数」tab 一并删除——**客户端半区只剩工作台一个入口面**（`sidebar.panellist` 图标 + `main` 面板），`conversation.view` 不再注册。
- 面板内栅格须响应中栏压缩（右栏打开时中栏可到 ~400px）：沿用原型 <1080px 单列回退，另验窄栏形态。

```
┌─┬────────────────────────────────────────────┬───────┐
│左│ 顶栏：NAUTILUS · 视图切换(全局/指向) · 时间 │ 抽屉  │
│侧│ 范围 · era 条 · 主题切换                     │ (下钻)│
│导│────────────────────────────────────────────│       │
│航│  视图内容（六选一）                          │       │
└─┴────────────────────────────────────────────┴───────┘
```

| 视图 | 内容 | 关键交互 |
|---|---|---|
| **总览** | 三组 stat 面板（NEXUS 4 / INFER 4 / PULSE 4，Grafana stat 行式）；FIG.01 三层联动图；FIG.02 最近关联对照流；预言摘要 | 联动十字线；点击下钻 |
| **告警**（A 系列增量，§3.2） | 顶部计数条（活跃 / 近 24h / 累计 / 总开关 / 手动档盲区 / 证据量）；『活跃告警』表 +『告警台账』表（确认时刻 · 规则 · 峰值 · 持续/解除 · 证据指纹 · 报告状态 · 裁决 · 操作）；报告查看面板；规则运行态表 + 两处口径注记 | 真/假阳性/未知裁决（不设审批门）+ 备注；查看报告（行内开合）；顶栏另有跳转入口 |
| **曲线与归因** | FIG.03 大曲线（指标三选：未命中/TPS/累计；会话筛选；阈值线；τ_e 标注；形态分布可展开）；FIG.04 最近关联对照表（可下钻）；FIG.05 标注台账 | 指标/会话/范围联动重绘；表格行下钻 |
| **假设台账** | H-x 卡片（状态徽标 + 证据链 + 反事实讨论）；登记新假设表单（陈述 + 预言关联勾选） | 展开/收起；登记；标记已检验/证伪 |
| **预言检验表** | P1–P9 行：状态下拉（待标注/进行中/已检验）+ 备注输入 + 保存；顶部计数徽标 | 即时保存 + toast |
| **归因报告** | 报告样例页：元数据块（era/provider 集合/对照集/窗口/范围）+ §1 假设与预言 + §2 证据链表 + §3 结论（措辞分级）+ §4 反事实 + 人工门控（批准归档/退回修订） | era 联动措辞；门控动作 |
| **调查抽屉** | 单轮下钻：三层同期快照表 + 问答原文 + **人工标注区** + 关联假设 + 操作（据此登记新假设 / 在报告中打开） | 从曲线点、对照表行、台账「定位」进入 |

### 3.2 告警视图（A 系列增量 · 2026-09-24 入册）

> 上游：[../1-planning/nautilus-os-alerting.md](../1-planning/nautilus-os-alerting.md) §4 A.4 + D-A4 裁决（**不做 ack**：图标「活跃即闪红」，人只做事后裁决）· 实现：[../../src/client/alerts.ts](../../src/client/alerts.ts) · 契约：[nautilus-dev-06-os-alerting.md](./nautilus-dev-06-os-alerting.md) §2。**原型（ui-s4-prototype.html）没有这一页**，故本节即视觉与交互权威。

| 面 | 规格 | 纪律 |
|---|---|---|
| **图标三态**（侧栏 panellist） | 正常＝无红点无徽标；**活跃＝朱红点 + 1.1s 阶跃闪烁**（`nt-icon-alert`）；**有未裁决＝朱红点半透明常亮 + 数字徽标**（>9 显示 9） | 三态由 `alertBadgeOf()` 纯函数算；`aria-label` 三态齐全（含条数与未裁决数）——状态不能只靠颜色 |
| 顶部计数条 | chip 行：活跃（>0 转朱红）· 近 24h · 累计 · **[总开关关]** · **[手动档盲区]** · 证据 N 份/KB · 「裁决只做事后标注，不设审批门」 | 两个方括号项是**红态警示**，位置紧邻计数——它们是「读数不可信」的前提，不是附录 |
| **手动采样档盲区条** | 手动档时显式声明：「手动采样档：没有连续监测——此时的静默不是『没越线』，是没在看」 | planning §7.5 的 UI 落点。**只在 `mode==='manual'` 出现**——长期挂着等于狼来了；auto 档出现即测试失败 |
| 告警表 | 行＝一条已确认告警；列：确认时刻（+id 小标签）· 规则 · 峰值 · 持续/解除（未解除＝朱红标签）· 证据（sha256 前 10 位，`title` 给全路径）· 报告状态（failed 转朱红；模板版本单列小标签，换模板后新旧不混算）· 裁决 · 操作 | 峰值/时长走 `tabular-nums`；`snapshotHash` 缺失显 `—` 不编造 |
| 裁决 | 三按钮（真阳性/假阳性/未知，当前值高亮）+ 备注输入（≤500 字，`placeholder` 标明）+ 行内提交；**无审批门、无二次确认** | 提交中 `disabled`；失败走 toast **不静默**；成功后 `reload()` 重取 |
| 报告查看 | 行内开合面板：路径头 + 正文。正文是**全站唯一衬线正文处**（Georgia/思源宋栈，行高 1.95）——原文是 markdown 文本，**只换排版不引渲染器**（零依赖纪律） | `reportStatus==='pending'` 时按钮位显示「报告生成中」而非空按钮 |
| 规则运行态表 | 列：规则（+id）· 判据一句话（`ruleText()`：表达式 / 阈值 / 解除线 / 窗 / 冷却）· 当前值 · 运行态（**活跃＝朱红 / 越线计时中＝中性 / 正常＝`--nt-ok` / 已停用＝降透明度**）· 连续段起点 | 状态色纪律：朱红只给「活跃」（需要人工注意）；「正常」用 `--nt-ok` 而非朱红 |
| **口径注记** | 规则表下与台账下**各一块**（`nt-al-note`）：判据来源（D-A8：p99 之上、max 之下；确认窗是时间窗不是 tick 数；缺样本状态保持；换机器必须重跑回测）+ 台账口径（噪声地板由人工裁决量化，**未裁决不计入阳性率**；冻结的是原始采样切片，尖峰可能被平滑） | 沿 §4「口径注记」纪律：**图表/表格下方必带**口径 / 混杂来源 / 诚实边界 |
| 缺席态 | `state===null` → 「告警能力缺席（pulse 未挂载或路由 503）」；空台账 → 「台账为空（还没有越线确认）」；空活跃 → 「当前无未解除告警」 | 不写 0 假读数 |

**未裁决口径（不擅改，仅记录）**：`alertBadgeOf()` 只数台账行（`recent`）并按 id 去重（`active` 是其子集），且 **`reportStatus==='pending'` 的行不计入未裁决**——语义是「先读报告再裁决」，代价是报告长期卡 pending 时该行不进徽标。改这条口径＝改验收语义，须先出方案由守谷人裁决。

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
| 告警台账/裁决 | 行＝一条已确认告警；朱红只给「活跃」「未解除」「报告失败」三种态，「正常」用 `--nt-ok`；裁决三按钮无审批门、提交中禁用、失败 toast 不静默（§3.2） |
| 告警报告面板 | 全站唯一衬线正文处（Georgia/思源宋栈，行高 1.95）+ 路径元数据头；markdown 只换排版不引渲染器 |
| 手动档盲区条 | 朱红描边 chip，**仅 `mode==='manual'` 出现**：说清「静默 ≠ 没越线」（A 系列 planning §7.5 的 UI 落点） |
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
- 与既有两套标注的关系：**预言标注**（`m2/annotations`，prophecy 维度）已于 2026-09-28 AL.4a 撤除；**自评**（clarity/defense/declaration，agent 侧产出）不动；本节新增的是**轮次维度的人工标注**。

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

### 5.4 T 系列契合标注呈现（2026-09-27 已落地；口径 = 决策 D-T5b，契约 = dev-05 §3）

与 §5.1–5.3 的「标签式标注」**并行的第二套轮次人工判读**（5 档契合量表，锁版 `schema_version=1`）：

| 呈现位 | 形态 | 纪律 |
|---|---|---|
| **流内契合按钮**（主入口，D-T5b） | 助手消息 IconActions 行内无框文本按钮（赞/踩同排，宿主 `data-actions-reveal`：最新轮 always / 旧轮 hover）；点击弹最小中性浮层：5 档 + N/A、fit=4 引文框、理由；已标态按钮显 `契合 N`（sample 口径加「样」） | 挂宿主 `conversation.chat.assistant-actions` 列表槽（~~D-T5 turnTail 链槽~~废弃：端上实测最新轮 tail 不稳定出现）；轮序经 `useChat` 快照解析（messageId→turn-tail 节点 `location.turn.turn`，解析不到不渲染）；按钮零 Nautilus 背景（`--dsw-alias-*` 令牌融入宿主行）；写路径同源 POST，**与读数零耦合** |
| 构成柱徽标 | 已标轮柱顶描边圆 + 档位数字（`marks` 平行 rows，加法 prop） | 只改点样貌，柱体/读数不动 |
| 曲线描边环 | miss/cum/tps/ms 主图已标点外环 + 档位数字（`marks` 平行 points） | 悬停环（r7.5）在场时让位；读数线/点本体不变形 |

曲线人工层数据源：`GET /m2/turn-annotations` 取一次不轮询（nonce 重取）；N/A 显示为 `N`。

---

## 6. 数据契约与 API（对齐 §5 + 现有面）

**现有**（`src/routes.ts`，实现时逐条核对，不凭本文档）：`GET m2/state` · `GET m2/analysis` · `GET m2/turn-text` · `GET/POST m2/turn-annotations` · `POST selfcheck` · pulse 四条（`state`/`series`/`control`/`alerts`）· **`GET /api/nautilus/m2/alignments`（AL.4b 读侧契约已冻结，由主线实现；UI 已按此写视图）**。**演进**：vault 观测腿 2026-09-27 下线删除 `GET state` / `POST action` / `GET+POST vault`；**2026-09-28 AL.4a** 再删 `GET/POST m2/annotations`（预言标注）与 `GET/POST lfield`（工作区指向）——三张相关表保留不 drop。

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
| 六视图 + 抽屉 + era 条 | `src/client/workbench.ts`（600+ 行；第六视图「告警」见 §3.2） | ✅ 已实现，产物已下发（§E10 / U3） |
| 全局面板入口 | `src/client/index.ts`：`sidebar.panellist`（list 槽 → `id`，order 50，label 走函数形）+ `main`（**keyed 槽 → `key`**），两值同 `nautilus-workbench` | ✅ 已注册并进常驻测试 |
| 槽位标识字段 | `list` → `options.id`；`keyed` → `options.key`（传错抛 `keyed slot main requires options.key`，并拖垮整批浏览器半区插件集） | ⚠️ 硬契约，见 §E10 |
| 逐会话双 tab | ~~同文件，`conversation.view` ×2~~ **2026-09-27 收敛**：vault 观测 tab 随观测腿下线删除、L 场读数 tab 能力搬进工作台后删除——客户端半区只剩工作台一个入口面（`client/index.ts` 仅 inject + sessionNameOf + 工作台双注册），`conversation.view` 不再注册 | ✅ 已收敛 |
| 图表语法升级（§4.5） | `src/client/charts.ts`（Sparkline/MiniChart/BarGauge/StackedBars/StateBand/TopList，全部无 hooks）+ 总览 FIG.01 网格化（USE 分区/同步十字线/gauge/健康带）+ FIG.10 会话活跃与排行 + 曲线视图「输入构成」堆叠柱档 | ✅ 2026-09-20 落地（六件套 30/30；端上验收待 dsh-next 刷新，稳定版 dsh 不动） |
| `fmtK` 缺失修复 | `curveLabel('cum')` 的 y 轴格式引用了未定义的 `fmtK`（客户端半区无 tsc 把关漏网）——切「累计输入」档会 ReferenceError | ✅ 顺手修复 |
| 取数口径 | §6 现成只读 API：`/m2/state`（全局口径）· `/m2/turn-text` · `/m2/turn-annotations` · `/pulse/state` | ✅ 未命中率对齐 `tokenIn/(tokenIn+cacheRead)` |
| 唯一写路径 | 无——2026-09-28 AL.4a 后本面板只读（原 `POST /api/nautilus/m2/annotations` 随假设/预言视图撤除） | —（写路径已撤，判定更新） |
| 缺席态 | INFER 层未接入 / 无数据 → 缺席文案与诚实边界，不写 0 | ✅ 全视图覆盖 |
| 浏览器渲染确认 | 既有页面刷新后人工确认（device-auth 门，无自动化） | ⏳ 待守谷人 |
| `dsh.client.inject` 新值生效 | 重启后已生效（启动图行含 layout/sidebar 两条边，§E12） | ✅ 收敛 |
| 返回会话入口 | `src/client/workbench.ts` 头部「← 返回会话」→ `ctx.layout.selectPanel(null)`；客户端 `inject` 加 `layout` | ✅ 端上首轮反馈修复（§E13） |
| OS 层读数呈现 | 总览「系统层读数（PULSE · 本机）」面板：4 头条 + 15 指标全表 + 采集健康行；量纲取自 `src/pulse/{collect,counters}.ts` | ✅ §E13 |
| PULSE 采样曲线 | 曲线视图数据源切换（NEXUS 轮次 / PULSE 采样）+ 指标下拉 + `/pulse/series?windowMs=3600000&maxPoints=240` | ✅ §E13 |
| 视图错误隔离 | `ViewBoundary`（类组件）：单视图抛错只替换该视图并显示错误原文 + 重试 | ✅ §E13 |
| **视图必须渲染为元素** | 禁 `CurveView({...})` 直调——子组件 hooks 会算进父组件，切视图即 hooks 数量变化 → 整页渲染失败 | ⚠️ 硬教训，见 §E13 |
| **令牌层落地（U1/U2）** | `src/client/theme.ts`：`NT_TOKENS` 15 条 + `ntThemeCss()`（纯函数，四块：跟随亮/暗 + 覆盖浅/深）+ `ensureNautilusTheme()`（`index.ts` 的 `apply()` 与 `Workbench()` 双点幂等注入）；`body` 级定义让侧栏图标与流内契合条也吃到令牌 | ✅ 2026-09-24 落地 —— **此前只有引用没有定义**：153 处 `var(--nt-*, 浅色兜底)` 全部吃兜底，插件恒为浅色、宿主暗色零影响（workbench 旧注释称「由 index.ts 注入」，实为未兑现的注释） |
| 主题跟随宿主 | 选择器 = `body[data-ds-dark-theme]`（ui-layout theme-presenter 的 `DARK_ATTRIBUTE`） | ✅ 纯 CSS 跟随：无 JS 监听、无 `ctx.theme` 依赖、无闪烁（宿主换肤 → 属性翻转 → 令牌整块切换） |
| 主题手动档 | 顶栏 `ThemeSeg`（跟随 / 浅色 / 深色）+ 根属性 `data-nt-theme` + localStorage `dsh-nautilus:theme` | ✅ 默认「跟随」；只覆盖 `.nt-wb` 子树，不写宿主 body 属性、不调 `ctx.theme.setTheme`（§2.2） |
| 跟随档标签 | 顶栏档位上的「跟随·浅 / ·深」两版文案由 `body[data-ds-dark-theme]` 纯 CSS 切换 | ✅ 跟随是否生效的肉眼证据，不需要 JS 读宿主状态 |
| 流内契合条死令牌 | `turn-annotate.ts` 引用的 `--dsw-alias-{fill-hover,border-secondary,border-accent,surface-primary}` **四个名字在宿主别名表里不存在** → 浮层一直吃硬编码浅色（暗色下白盒） | ✅ 改走 `--nt-*`（`--dsh-content-font-size-secondary` 已核实存在，保留） |
| 客户端取色守卫扩面 | `scripts/test.mjs`：从「仅 charts.ts」扩到 **整个客户端半区**（`theme.ts` 之外零硬编码色）+ 反向守卫「令牌表无死令牌」+ 产物哨兵（`lib/client.js` 含 `body[data-ds-dark-theme]` / `data-nt-theme`） | ✅ 57/57（新增 2 例） |
| 端上双态目视验收 | 既有页面刷新后人工确认（亮/暗两态 + 手动档三态） | ✅ 2026-09-24 守谷人目视通过（「验证通过，收敛」，OQ-U6 闭合；协议与可观察量见 evidence-u2 §5。**截图未入仓**，见该文件 §6 诚实边界） |
| **告警视图入册（A.4 · U3）** | dev-02 §3.2 新增（原型无此页 → 本节即权威）；IA 由「五视图」更正为「**六视图**」——实现早已是六视图，是**文档漂移**而非功能缺口 | ✅ 2026-09-24 入册（U3） |
| 手动采样档盲区条 | `AlertsView` 收 `collectorMode` prop（workbench 传 `pulse.collector.mode`）→ 手动档显式声明「静默 ≠ 没越线」 | ✅ U3 补 —— **dev-06 §7.5 原称「已在 UI 明示」，实测 `alerts.ts` 里 `manual` 零命中，只有文档那半兑现**；本轮补 UI 半 |
| 告警口径注记 | 规则表下 + 台账下各一块 `nt-al-note`（D-A8 判据来源 / 未裁决不计入阳性率 / 冻结的是采样切片不是现场） | ✅ U3 补（S4「图表下方必带口径注记」纪律） |
| 告警报告排版 | `nt-al-report` 由裸 `<pre>`（11px）升为 S4 报告排版（衬线 + 行高 1.95，S4 §4「唯一衬线正文处」） | ✅ U3 补 |
| 图标三态可访问性 | `aria-label` 补未裁决态（含条数与未裁决数）；原先只报「有活跃告警」 | ✅ U3 补 |

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
- **OQ-U7 面层是否也交给宿主**（§2.3，**留口非阻塞**）：浅色下三级面自持 S4 定版值 vs 全交宿主（整片白）——2026-09-24 验收按自持形态判通过，改动方案见 evidence-u2 §6。
- ~~OQ-U6 浏览器渲染验收~~ **2026-09-24 闭合**：图表语法与令牌层两批均已端上目视（令牌层七步协议见 evidence-u2 §5，守谷人判「验证通过，收敛」）。

## 关联文件

- [./ui-s4-prototype.html](./ui-s4-prototype.html) — 交互原型（视觉与交互权威参照，含双主题与人工标注演示；令牌块与实现同源）
- [./evidence-u2-20260924.md](./evidence-u2-20260924.md) — U2 主题层证据归档（令牌层落地 / 宿主主题机制实测 / 绑定纪律数值依据 / 七步端上验收协议）
- [./evidence-u3-20260924.md](./evidence-u3-20260924.md) — U3 告警视图入册证据归档（§3.2 规格来源 / 手动档盲区条 / 口径注记 / 端上六步清单）
- [../1-planning/nautilus-nautilus-positioning.md](../1-planning/nautilus-nautilus-positioning.md) — 上游：L2 阶梯、差异化矩阵
- `../AGENTS.md` §3/§7 — 客户端半区契约、GUI 验收红线；`../../CONTRIBUTING.md` — 工程约定权威
