# 自评多源采集（S 系列）——规则完善与通道决策记录

> 版本 v0.1（2026-09-27 起草；**D-SC1 / D-SC2 已由守谷人「按建议继续」签核**，其余条目为建议待核）
> 归属：决策文档（改动即决策）；实现落 `../2-dev/`（开项时建 Phase 文档）。
> 数据口径：`~/.dsh/nautilus/nautilus.db` **2026-09-20 探测快照**（只读副本，非实时）；裁决日期以守谷人批复轮次标注为准（沿 E18 先例）。
> 上游：vault `外功/DSH/雪谷观测插件开发文档-M3`（自评三行出处）· 同 `-M5`（declaration 全零触发与 P 腿挂起）· [nautilus-nexus-positioning.md](./nautilus-nexus-positioning.md)（D-N1 迁移主权，未裁不阻塞本项目）。

## 0. 问题（为什么要立项）

- 谷规第 6 条要求**每个 Agent** 每轮记录自评三行，但落库工具 `record_turn_selfcheck` 只注册在 DSH 宿主里——**非 DSH 的 Agent（同样进出 L-theory 的其它 harness）产生的自评没有入库通道**；规则也未要求任何身份字段，多源自评无法分层、不可对照。
- 实测（2026-09-20 库快照）：`turn_read` 552 轮 / 85 会话，自评仅 **107 轮（19.4%）**；有自评的会话 34/85；最长会话 67 轮零记录。
- 仪器侧：**`declaration` 107 条全零**（M5 立项时 57 全零，样本翻倍仍全零——自我报告结构性失效坐实，非样本量问题）；`defense` none/light = 100/7（93.5% 挤安全档）；`clarity` 73% 落 (0.6, 1]。

## 1. 决策点

### D-SC1 多源自评的进库通道 —— ✅ 已签核：**A. HTTP ingest**

| 方案 | 做法 | 取舍结论 |
|---|---|---|
| **A（定案）** | 宿主新增 `POST <API_PREFIX>/selfcheck`，各 harness 结束钩子投递 | 一份实现、与 DSH 工具同口径；只写自家库（红线 2 不变） |
| B | outbox 投件 + watch 入账 | 落选：要重养 watcher，纪律靠文件名约定 |
| C | 仓库外脚本回填存量 transcript | 非长期通道，降级为 D-SC5 一次性考古 |

契约要点（实现期进 Phase 文档，这里钉方向）：

1. 配置 `selfcheck.ingest = { enabled: false（默认关）, token: role('secret'), maxBodyBytes }`——**未启用 403 / token 不符 401 / 参数非法 400（含 `declaration=1` 无引文）**，非法即拒，不静默收下。
2. 去重键唯一：重复投递返回 200 + `duplicate: true`，不双写。
3. 路由经 `ctx.webServer.register`（随卸载撤销）；处理器只落单行 INSERT，不做批量计算（不阻塞主循环）。
4. **DSH 工具与 HTTP 走同一 ingest 函数**——只有 `source_kind` 不同，不出现第二套口径。

### D-SC2 declaration 改造 —— ✅ 已签核：**证据要求，不复活 M5**

- `declaration=1` 必须附 `quote`（宣告原句，≤200 字，可回查）；无引文**拒绝并要求重提**（isError），不静默降级——旧「全零」正是静默降级的归宿。
- 0/1 与引文一并落库；P2 检验以**人工复核引文**为准。结构判据（P 腿）随 M5 继续挂起，复活另行立项（届时与 D-N3 粒度一并裁）。
- **版本槽改判**：pulse 已占 `user_version=4`、M5 曾顺延预留 v5；本条签核后 **v5 划拨给本项目新表**，M5 若复活改占 v6（回写 M5 文档，见 §5）。

### D-SC3 存储模型 —— 建议，待核

新表 `selfcheck_record`（append-only）；`turn_read` 三列自评**冻结保留**（观测记录是实证；既有读数面不断裂），面板读侧逐步切统一视图。草案：

```sql
CREATE TABLE IF NOT EXISTS selfcheck_record (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms          INTEGER NOT NULL,            -- 宿主接收时刻（权威时钟）
  ts_client      INTEGER,                     -- 来源自报时刻（仅对照）
  schema_version INTEGER NOT NULL DEFAULT 1,  -- 口径版本：锚例/字段变更递增，旧值不重标
  source_kind    TEXT    NOT NULL,            -- dsh_tool | http | backfill
  agent          TEXT    NOT NULL,            -- 自评者标识（DSH 侧 = sessionId；外部 = harness/agent 名）
  model          TEXT,                        -- 有则报
  workspace      TEXT,                        -- 归属工作区路径字符串（L 场口径；不读该路径）
  ext_ref        TEXT    NOT NULL,            -- 来源内部会话标识
  turn_ordinal   INTEGER,                     -- 来源侧轮次（可空）
  clarity        REAL    NOT NULL CHECK (clarity BETWEEN 0 AND 1),
  defense        TEXT    NOT NULL CHECK (defense IN ('none','light','heavy')),
  declaration    INTEGER NOT NULL CHECK (declaration IN (0,1)),
  quote          TEXT,
  CHECK (declaration = 0 OR quote IS NOT NULL)
);
-- 去重唯一索引（source_kind, ext_ref, turn_ordinal 或 ts_client）细节留 Phase 文档
```

**为什么不把身份列加在 `turn_read`**：非 DSH 轮次在宿主里没有对应 `turn_read` 行（该表来自 DSH `session/event` 直采）——多源自评不该伪造宿主轮次，另立表是唯一干净口径。迁移沿 `store.ts` 现有唯一权威顺序执行（v4→v5）；D-N1 案 B（迁移账本）若日后裁决，本表迁移原样入册。

### D-SC4 规则完善（谷规第 6 条与工具描述同步）—— 待核

1. **分层强制**：一切聚合读数按 `source_kind` / `agent` 分层显示；跨 Agent / 跨模型的自评**只作对照、不作归因**（era 措辞纪律的延伸，进面板诚实边界）。
2. **锚定样例**：三行定义各附 2–3 个锚例（现描述只有抽象定义，是分布塌缩的温床）；改口径 = `schema_version` 递增，新旧不混算。
3. **反 Goodhart 声明**：谷规明文「自评数只用于测量，不用于对任何 Agent 的奖惩考核」——defense 93.5% none 就是无声明下的自然塌缩。
4. **缺口三态**：覆盖率拆「未接通道 / 漏记 / 豁免」；豁免清单（子代理会话？单工具轮？）留 OQ。

### D-SC5 存量回填（一次性考古）—— 待核

仓库外脚本解析各 harness 自有 transcript 中的已写自评标 `source_kind='backfill'`，只做历史对照、**不进当期覆盖率**。非插件能力（不绑他家日志格式），放 `scripts/` 或 dsh-cowork 侧。

## 2. 范围与非范围

- **做**：路由 + 配置 + v5 迁移 + 工具改造（quote 必填、与 HTTP 同 ingest）+ 面板分层读数 + 《证据归档》。
- **不做**：M5 复活；读 vault（红线 2 不变——`workspace` 只是归属字符串）；任何自动重试/修正；改宿主源码。

## 3. 诚实边界（引用读数必须带上）

1. 一切自评皆为自我报告，分布天然偏安全档（实测：defense 93.5% none；declaration 改造前 107/107 零）。
2. 跨 Agent / 跨模型可比性**无保证**，只能层内对照。
3. 引文改造后 declaration 仍是自报——只是多了可审计抓手；「本轮是否真有无前因宣告」仍无真值（P2 检验需人工真值标注，沿承 M5 OQ-M5-1）。
4. 19.4% 覆盖率的三种成因（未接/漏记/豁免）未分离前，**历史覆盖率不得解读为任何 Agent 的「勤奋度」**。

## 4. 验收草案（开项时细化进 Phase 文档）

1. v4→v5 迁移幂等可重跑；`turn_read` 既有统计前后数字不变（对照证据）。
2. POST 四分支测试：禁用 403 / 错 token 401 / 非法 400（含无引文的 declaration=1）/ 重复投递不双写。
3. **经真实 Loader 的路径测试**（测试红线）；DSH 工具与 HTTP 落库同口径断言。
4. 端上环境四元组 + 既有 URL 刷新后分层读数可见（OQ-U6 教训）；六件套全绿。

## 5. 关联与回写清单

- **回写 vault**（守谷人裁定后执行，走会话侧 /obsidian 通道）：M5 文档状态行（declaration 口径改造脱离 M5；v5 槽改占、M5 复活改 v6）；谷规第 6 条（身份、锚例、豁免、反 Goodhart 声明）。
- **GitHub issue**：「S1 自评多源采集（通道 A）」开项挂本文件（issue 先行约定）。
- 不阻塞项：D-N0 / D-N1–N4 架构裁决与本专项正交（v5 迁移仍在现行唯一权威处执行）。
