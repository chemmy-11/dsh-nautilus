# 开发文档五 · T 系列 逐轮人工标注（契合 · 混合入口）

> 版本 v0.1（2026-09-27 开项）。上游决策：[../1-planning/nautilus-turn-annotation.md](../1-planning/nautilus-turn-annotation.md) v0.2（D-T1 签核；量表锁版 `schema_version=1`；D-T2/T3/T4 本文定案）。
> **两线并行纪律**（2026-09-27 已收敛）：UI 图表线由守谷人完成并先期入库（`0504028`），**UI 半区（流内契合条 + 曲线人工层标记）已随本线交付，见 E23**。`src/client` 不进 tsc（tsconfig exclude），客户端类型纪律 = 本地类型 + 运行时契约测试。

## 1. 锁版量表（schema_version=1，2026-09-27 守谷人「锁板」）

```
4 = 改变了我下一步动作/笔记（被引用、被追问、被改道）    ← 必附引文 quote（≤200 字）
3 = 推进了问题本身（不是答对，是把问题推深一层）
2 = 在场之内、但组织方式新（重组已有材料）
1 = 正确但无增量
0 = 滑过（读即没读）
N/A = 无判断对象（纯操作性指令轮）→ exempt=1 豁免，不进分母
```

## 2. 存储（v6 迁移；红线 3 幂等）

```sql
CREATE TABLE IF NOT EXISTS turn_annotation (          -- 一行一轮、最新覆盖
  session TEXT NOT NULL, turn INTEGER NOT NULL,
  fit INTEGER CHECK (fit BETWEEN 0 AND 4),
  exempt INTEGER NOT NULL DEFAULT 0 CHECK (exempt IN (0,1)),
  quote TEXT, note TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('spot','sample')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  fit_prev INTEGER, quote_prev TEXT,                  -- recheck 批次覆盖前旧值挪入（噪声地板成对数据）
  annotated_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (session, turn),
  CHECK (fit IS NULL AND exempt = 1 OR fit IS NOT NULL AND exempt = 0),
  CHECK (fit <> 4 OR quote IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS annotation_sample (        -- 抽样队列（一行一候选）
  batch_id TEXT NOT NULL, session TEXT NOT NULL, turn INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sample' CHECK (kind IN ('sample','recheck')),
  strata TEXT NOT NULL DEFAULT '',                    -- 分层标签（如 s=<会话短id>;w=<周>;h=<形态>）
  sampled_at INTEGER NOT NULL, annotated_at INTEGER,
  PRIMARY KEY (batch_id, session, turn)
);
```

`turn_read` 槽位说明：契合**不落** `turn_read`（人工解读层与机械读数分层，dev-02 §5）；面板关联计算属 S1.2/UI 期。

## 3. 写读通道（宿主半区，工作台同源门，**不走 S1.1 token**——那是外部 harness 专用）

- `POST /api/nautilus/m2/turn-annotation` `{session, turn, fit?, exempt?, quote?, note?}`
  - 门序：同源标记 → JSON → **语义校验**：fit 0–4 或 exempt 二选一互斥；`fit=4` 必附非空 quote（≤200 字，trim 后存）；被标轮次 `turn_text` 必须在场（无原文拒 `no-turn-text`——不让人对着摘要打五分制）。
  - **origin 服务端判定**：`(session,turn)` 在任一 `annotated_at IS NULL` 的队列行中 → `'sample'`（并回填全部命中行 `annotated_at`）；否则 `'spot'`。申报制污染口径，杜绝。
  - recheck 语义：覆盖已有标注时旧值挪入 `fit_prev/quote_prev`（复标批次靠它成对）。
  - 200 → `{ok, origin, overwritten, fit_prev_available}`。
- `GET /api/nautilus/m2/turn-annotations` → `{annotations:[...], coverage:{spot:{n}, sample:{marked, pending}, exempted, byFit:{0..4}, rechecked}}`——**spot 与 sample 计数分开呈现，永不合并成单一"覆盖率"**。`rechecked` 语义（E24 端上实测注记）= 「被覆盖过 ≥1 次的行数」，**不分** D-T4 复标批次与随手改标；噪声地板成对数据以 `annotation_sample.kind='recheck'` 队列为准，不得直接引用此计数。
- **流内契合按钮（D-T5b，UI 半区主入口）**：客户端注册 `conversation.chat.assistant-actions`（kind `list` / scope `session` / owner `{ messageId }`——宿主 IconActions 行，赞/踩同排，每条定稿助手消息必渲染；~~D-T5 turnTail 链槽~~废弃，端上实测最新轮 tail 不稳定出现，守谷人改口）。行内无框文本按钮（`--dsw-alias-*` 令牌、零 Nautilus 背景）+ 最小中性浮层：5 档 + N/A、fit=4 引文框、理由、已标回显（按钮显 `契合 N`，sample 口径加「样」）。messageId→轮序：`useChat` 快照扫描（SessionStandardProps 文档化 hook：turn-tail 节点 `closing.finalNode.messageId` 匹配取 `location.turn.turn`），解析不到不渲染。`useChat` 轮序与库键同源，端上核对一次（标注后 GET 回读核对 turn 序号一致）再记证据。零新依赖、`nt-` 前缀。

## 4. 抽样生成器 `scripts/annotation-sample.mjs`（会话侧，直连自家库）

- 池：`turn_read` ∩ `turn_text` 非空 ∩ **未标**（recheck 批次反之：**已标且未复标**）；取数恒为**全局口径**（AL.4a 已撤除工作区指向两态：`--root` 只认 `all`，其它值响亮失败）。
- 分层：会话（`--per-session` 上限）× 周桶 × 形态（`analyze()` 的 shape/无形态）；`--seed` 确定性 PRNG（可复跑复现）；`--size N --kind sample|recheck`；产出 `batch_id=T-<UTC日期>-<kind>-<序号>`。
- 只 INSERT `annotation_sample`（幂等：PK 冲突跳过），不碰其它表。

## 5. 测试（独立文件 `scripts/test-t.mjs`——避开与 UI 线在 test.mjs 上的同文件并写；`npm test` 并列运行两文件）

1. v6 迁移：v5 存库（含数据）→ v6 幂等、既有数字不变；新库直达 v6；`turn_annotation` CHECK 双门生效（直插违规必须失败）。
2. 路由门序（真实 ctx.plugin 装配 + 同源头）：非源 403 / fit+exempt 冲突 400 / 无原文 400 / fit=4 无引文 400 / 合法 200。
3. origin 判定：预置队列行 → `'sample'` 且 `annotated_at` 回填；不在队 → `'spot'`。
4. recheck：覆盖旧值 → `fit_prev` 在场。
5. 生成器：构造 3 会话 × 已知分布 → 固定 seed 抽样确定性、per-session 上限、recheck 只取已标未复标。

## 6. 验收与边界

- 六件套全绿 + E22 归档（宿主半区离线证据；端上四元组仍等守谷人重启窗口——S1.1 同批生效）。
- UI 半区（T.2）：**已交付（E23）**——流内契合条（turnTail 链槽）+ 构成柱徽标 + 曲线描边环；dev-02 §5.4 已登记呈现位。端上核对（`TurnLocation.turn` 序号 vs 库键、实际视觉）待宿主重启窗口。
- 诚实边界照抄决策文档 §7（人标也是自报，噪声地板等 D-T4 复标量化；spot 不进分布结论；era=api 只作对照）。
