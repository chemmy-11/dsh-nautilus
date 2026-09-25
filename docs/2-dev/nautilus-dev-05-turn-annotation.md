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

- `POST /api/nautilus/m2/turn-annotations` `{session, turn, fit?, exempt?, quote?, note?}`（AL.4 起同门双形：带 `align`/`boundary` 键走 1–5 对齐量表，见决策 [§2.1](../1-planning/nautilus-alignment.md) 与 §9 边界 3「新旧不混算」）
  - 门序（AL.4 收口后）：同源标记 → JSON → 会话/轮次 → 无原文 `no-turn-text` → **语义校验**：fit 0–4 或 exempt 二选一互斥；`fit=4` 必附非空 quote（≤200 字，trim 后存）→ **代际冲突门** → origin 判定 → 落库。
  - **代际冲突门（`generational-conflict` → HTTP 409，AL.4 收口）**：旧形（fit 0–4）落到**已是对齐量表行**（`schema_version≥2`）的轮次即拒，响应 `{ok:false, error:'generational-conflict', message:"<人话>"}`，**零写入**（不改该行、也不回填 `annotation_sample.annotated_at`）。
    - 为什么拒而不是降级：旧形 upsert 只回填 fit、不清 align → 撞 v8 三态 CHECK（align 行不得携带 fit）→ SQLite 抛错冒到路由，**客户端拿不到响应**（实测状态码停在 0）。若改成「align 挪 `align_prev` 并清空、降级为 v1 行」，等于允许陈旧客户端**静默销毁新量表标注**——与「不静默降级」「代际不混算」两条纪律冲突，故不做。
    - 触发面：curl / 陈旧缓存的旧 UI 半区；新打分件只发 `align`/`boundary`，不走此路。
    - 判据单点：`store.turnAlignmentSchemaVersion(session, turn)`（只读；无行 → `null`，旧行 → 1，对齐行 → ≥2）。本门必须排在 origin 判定**之前**——`resolveAnnotationOrigin` 会写队列，排在后面 = 「拒了还改了队列」。
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


## 7. AL.5s 往期会话读侧（`GET /api/nautilus/m2/sessions`；工作台「往期打分」的数据面）

需求（守谷人）：工作台要能对**往期会话**的轮次打分、轮次名称用「工作区 + 会话名」、点开可看详细会话信息——
三件事共用这一条「列出往期会话与其轮次」的读接口（本仓库此前不存在）。

- `GET /api/nautilus/m2/sessions?limit=50&offset=0`（kind=**exact**；只 GET；同源门）→
  `{ revision, sessions: [{ session, label, workspace, workspaceName, sessionName, turns, firstTs, lastTs,
  totals: { tokenIn, tokenOut, cacheRead, durationMs, tpsAvg }, annotated: { human, self, legacyFit } }] }`
  ——**默认不带轮次**（列表页要的是会话 + 数字 + 计数，负载控制）。
- `GET /api/nautilus/m2/sessions/<sessionId>`（kind=**prefix**，同路径；只 GET；同源门；未知 id → 404）→
  `{ revision, session: {...同上单条...}, turns: [{ turn, ts, question, tokenIn, tokenOut, cacheRead, durationMs, tps,
  hasText, self: { align, boundary, declaration, quote, evidence, rubricVersion } | null,
  human: { align, boundary, exempt, quote, note, origin, schemaVersion, annotatedAt } | null }] }`
- 契约**冻结**（UI 线按同一份写视图；只加字段，不改既有字段名/类型）。
- `label` 派生是**服务端单点**（`src/nexus/sessions.ts`，UI 不再自己拼）：
  `label = workspaceName + " · " + sessionName`；
  `workspaceName` = `session_root` 里该会话工作区路径的 basename（**无记录/未归属 → 「未知工作区」**）；
  `sessionName` = 该会话**第一条不以 `<` 开头且去空白非空**的 question 的**首行前 24 字**，
  无 → **session id 短形（末 8 位）**。真库实测（2026-09-27 字节快照副本）：65 条 `turn_read` 里 8 条 question
  以 `<system-reminder>` 块开头——不跳过就会得到「<system-reminder>」这种伪会话名；**不存在的真会话名不编**。
- 口径：主干 `turn_read`（轮次读数）；`turn_text` 只用于 `hasText` 在场判定，**原文一律不返回**
  （question 截断 200 字）；`totals.tpsAvg` = 总输出 / 总时长（与 `turn_read` 行内同式，不是逐轮 tps 的算术平均）；
  标注计数只数**已附着到该会话轮次**的行（= 详情逐轮渲染的同一集合），`human` 只出 `schema_version≥2`
  （有分 + 豁免），旧尺行（=1）只进 `annotated.legacyFit`，`self` 只认 `dsh_tool × align 非空 × rubric_version=al-v1`。
- **往期打分**复用既有 `POST /api/nautilus/m2/turn-annotations`（双形与门序见 §3 不变）：`hasText=false` 的轮次
  **如实拒** `no-turn-text`（HTTP 400，**零写入**），且该门**先于**量表越界门；判据单点 = `store.hasTurnText`
  （与详情 `hasText` 同一谓词）。UI 据 `hasText` 禁用打分入口并说明「该轮原文未采集」——
  **门不放宽**（是否允许无原文打分是守谷人的裁决面，实现只如实反映现状）。
- 错误码（本组路由）：`forbidden`(403) / `method-not-allowed`(405) / `invalid:limit`·`invalid:offset`·`invalid:url`(400) /
  **`not-found`(404)**——未知 / 空 / 多段 / 解码失败的 sessionId 一律 404，**绝不 500**（id 只当 SQL 绑定参数，
  不拼路径、不拼 SQL，路径穿越类输入只是「查不到的键」）。
- 分页严格（不夹取、不猜默认）：`limit ∈ [1,200]` 缺省 50、`offset ≥ 0` 缺省 0；在场但非法 → 400
  （静默夹取会让 UI 以为「已经拿到全部会话」）。
