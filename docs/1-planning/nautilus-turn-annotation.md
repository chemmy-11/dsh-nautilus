# 逐轮人工标注（T 系列）——「契合」维度与混合入口决策记录

> 版本 v0.3（2026-09-27 起草；**入口 C / 量表 5 档 / 单维守谷人选项框签核，量表锚文同日「锁板」——即 §1 草案原文为锁版文本，`schema_version=1` 定死**，改锚即递增不混算；D-T2/T3/T4 按签核流程进 dev-05 实现；**同日守谷人再裁决 D-T5：流内打分件挂宿主 `conversation.chat.turnTail` 链槽**，见 §4）
> 归属：决策文档（改动即决策）；实现落 `../2-dev/`（开项时建 Phase 文档）。
> 上游：vault `外功/DSH/DSH_Nexus —— 神经系统插件规范.md` §一 命名纪律 · 同 `-M5` OQ-M5-1（真值从哪来）· `dev-02` §5 人工标注纪律（解读不写回读数）· [nautilus-selfcheck-multisource.md](./nautilus-selfcheck-multisource.md)（S 系列，同源不同物）。

## 0. 问题

观测体系三条腿全是机器/自报数据：未命中率是投影、自评三行已实测证伪（declaration 107/107 零）、P 挂起——**至今没有外部裁判**。守谷人提出：对「我认为是高对齐的回答」进行人工标注。这是第一个真值信息源，也是检验其余仪器是否在测真东西的唯一办法。

## 1. 命名与口径（先拆陷阱）

- **维度定名「契合」（fit）**：守谷人对单轮回答价值的人工判读。它**不是**——A 对齐密度（理论量）、漂移度（Nexus 工程量，N1 未立项）、P 纯度（结构量）。三词已被占用，面板与文档一律用「契合」，禁止裸用「对齐」指代本维度（Nexus §一命名纪律的延伸）。
- **量表：5 档锚定序数**（草案，待守谷人改定锁版）：

  ```
  4 = 改变了我下一步动作/笔记（被引用、被追问、被改道）   ← 最强锚
  3 = 推进了问题本身（不是答对，是把问题推深一层）
  2 = 在场之内、但组织方式新（重组已有材料）
  1 = 正确但无增量
  0 = 滑过（读即没读）
  N/A = 无判断对象（纯操作性指令轮）→ 豁免，不进分母
  ```

- **fit=4 必附引文**（「我引用/改道于哪句」，≤200 字，可回查）——最强断言配最强把手，同 D-SC2 逻辑；无引文的 4 由服务端拒。
- **改锚 = `schema_version` 递增**，新旧分层不混算；锁版后标注期间不得回改判据。

## 2. 入口与口径隔离（D-T1，✅ 已签核：方案 C）

| 通道 | 说明 | `origin` |
|---|---|---|
| 抽屉随手标 | 看曲线 → 点采样点 → 读原文 → 顺手标（趁判断热）；选择偏差样本 | `'spot'` |
| 抽样队列标 | 生成器按分层（会话 × 时段 × 曲线形态）抽未标轮次入队 → 按队列标 | `'sample'` |

- `origin` **由服务端判定**：POST 时该轮在当期队列中 → `'sample'`（队列行回填完成时刻），否则 `'spot'`——申报制会污染口径。
- **两套统计永不合并**：spot 只作积累与线索；一切分布结论（覆盖率、契合分布、与读数的关联）只认 sample 口径。选择偏差被口径隔离，这是选 C 不选 A 的全部理由。
- 队列元数据落 `annotation_sample`（batch_id + 分层维度 + 抽样时刻）；生成器为会话侧脚本（`scripts/` 直连自家库，先例：`p-measure.mjs`），插件运行时对其只读。

## 3. 存储模型（D-T2，✅ T.1 已实现：v6 迁移，`a2093c1`）

新表 `turn_annotation`（**一行一轮、最新覆盖**，与 `annotation`（预言 P1–P9 一行一预言）互不侵占——两码标注语义，同库不同表）：

```sql
CREATE TABLE IF NOT EXISTS turn_annotation (
  session        TEXT    NOT NULL,
  turn           INTEGER NOT NULL,
  fit            INTEGER CHECK (fit BETWEEN 0 AND 4),   -- N/A 豁免：fit NULL + exempt=1
  exempt         INTEGER NOT NULL DEFAULT 0 CHECK (exempt IN (0,1)),
  quote          TEXT,                                   -- fit=4 必填（应用层+CHECK 双门）
  note           TEXT,                                   -- 一句话理由（可空）
  origin         TEXT    NOT NULL CHECK (origin IN ('spot','sample')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  annotated_at   INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (session, turn),
  CHECK (fit IS NULL AND exempt = 1 OR fit IS NOT NULL AND exempt = 0),
  CHECK (fit <> 4 OR quote IS NOT NULL)
);
-- annotation_sample: batch_id/session/turn/sampled_at/annotated_at，PK(batch_id, session, turn)
```

- **版本槽**：v5 已被 S1.1 占用 → 本表占 **v6**（顺序迁移，红线 3）。
- 标注只写 `turn_annotation` + `annotation_sample.annotated_at`；**读数表零触碰**（dev-02 §5 分层纪律）。
- 被标轮次必须有 `turn_text` 原文在场（无原文 → 400，不让人对着 80 字摘要打 5 档分）。

## 4. 通道与界面（D-T3 ✅ T.1 已实现宿主半区；流内件 = D-T5 ✅ 已裁决）

- `POST /api/nautilus/m2/turn-annotations`：校验（量表范围/豁免/fit=4 引文/原文在场）→ origin 判定 → upsert。同源浏览器门（工作台内部动作，**不走 S1.1 的 token 通道**——那是给外部 harness 的，本通道守谷人专用）。【已上线，`a2093c1`】
- `GET /api/nautilus/m2/turn-annotations`：清单 + 双口径覆盖率（spot/sample 分开）。【已上线】
- **流内打分件（D-T5，✅ 守谷人选项框裁决：`conversation.chat.turnTail` 链槽）**：宿主公开槽位（dsh 0.1.5-rc.2 源码核实：`dsh-client-ui-chat` `contract/slots.d.ts`——kind `chain` / scope `session` / owner `TurnLocation{ turn: number, seq, status, steps }`），渲染于已完成轮次动作行上方，**判断在热的现场直接标**。形态：5 档 + N/A 平铺、fit=4 引文框就地展开、POST 同源直写。`TurnLocation.turn` 与本库 `(session, turn)` 键同源（同一 session/event 流的轮序）——实现时做一次端上核对并记入证据。
  - 落选备选记档：`conversation.chat.assistant-actions`（列表槽，owner 仅 `messageId`，需 messageId→轮序映射，5 档塞不进图标行须挂弹层）——原判「工程摩擦高一截」。
- **D-T5b（2026-09-27 守谷人改口，端上反馈驱动）**：turnTail 链槽端上实测**最新轮的条不稳定出现**（tail 节点材料化时机非契约面，多轮修复不根除）→ 槽位改为上条「落选备选」`conversation.chat.assistant-actions`：IconActions 行内（赞/踩同排），**每条定稿助手消息必渲染**（宿主 `data-actions-reveal`：最新轮 always / 旧轮 hover——恰补「最新轮没条」）；按钮本体**零 Nautilus 背景**（无框文本按钮融入宿主行视觉，`--dsw-alias-*` 令牌），5 档选择收进最小中性浮层。messageId→轮序走 `useChat` 快照扫描（SessionStandardProps 文档化 hook：扫 kind='turn-tail' 且 `data.closing.finalNode.messageId` 匹配的节点取 `location.turn.turn`），解析不到不渲染。教训：D-T5 的「落选理由」在端上实际问题面前重新定价——映射一个文档化 hook 即解，「最新轮必现」权重更高。
  - 并存不混用：宿主自带 `dsh-message-feedback`（赞/踩）是通用反馈、存宿主侧；契合标注是带量表的观测口径、落本插件库。
- 抽屉控件**降级为补充视图**（主入口 = 流内件）；曲线已标点人工层标记照旧（改点描边/徽标，**不改读数线**——解读与观测分层可视化）。

## 5. 自一致复标（D-T4，✅ 机制已随 T.1 落地；量化待首批 ≥50 条后触发）

攒够 ≥50 条后跑一次 recheck 批次：从已标轮次随机抽 10%，重标入影子列（实现细节进 Phase 文档：`fit_recheck`/`recheck_at` 还是入队式覆盖留实现裁）。两次打分一致率 = **本真值源自身的噪声地板**——之后一切「人工锚 vs 机器读数」的关联强度上限都受它约束，诚实边界必须带这个数。

## 6. 标注能回答什么（用途钉死，防指标漂移）

1. **P1/P4 锚定**：fit≥3 的轮次在未命中率/累计输入曲线上是否呈系统差（分布对照，非因果宣称）。
2. **仪器检验**：自评三行、τ_e 检出段与人工锚的相关——**不相关也是结论**（仪器该下线就下线）。
3. **P2 素材**：fit=4 的引文轮次是「改变动作」的真值近似；与 declaration 引文并读可积累 OQ-M5-1 需要的样本（不宣称等价）。
4. 覆盖/分布数字**只出 sample 口径**。

## 7. 诚实边界（随读数引用）

1. 人工真值也是自报——只是主体是守谷人；噪声地板由 §5 一致率量化，未量化前不得宣称「人标=真理」。
2. 契合 ≠ 对齐密度 A 本身，是 A 的**人类侧候选锚**；关联成立与否不改变理论（理论不依赖单点读数，承 M5 边界精神）。
3. spot 样本永远不进分布结论。
4. era=api 下全部为「对照」措辞。

## 8. 关联与回写

- S 系列（自评多源）**挂起中**：S1.1 已交付、S1.2 冻结；T 系列与其同库不同表，不互相依赖。
- N1 漂移度量若立项：契合标注即其**人工对照集**的第一桶数据——正交但互补，届时引用本文件。
- 回写 vault（守谷人点头后走 /obsidian）：谷文档新增本专项口径页 + PROJECT-MOC 登记。
- 下一步：守谷人改定量表锚文 → D-T2/T3/T4 核签 → 开 issue（等 GitHub 指令）→ 实现（搭 S1.1 同一次重启窗口）。
