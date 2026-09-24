# 开发文档六 · A 系列 OS 层红线告警（越线报警 / 证据冻结 / LLM 报告 / 台账）

> 版本 v0.1（2026-09-28 重建）。上游决策：[../1-planning/nautilus-os-alerting.md](../1-planning/nautilus-os-alerting.md)（D-A1/A2/A3 已签核；D-A8 阈值）。
> **重建说明**：A.1–A.5 的原实现提交（`677eb1b`/`6d4e521`/`ce6f8b5`/`b23c42b`/`d587bc2`）**从未 push**，
> 随本地检出误删丢失；本文件与实现一起按 issue #6 的规格与四条实施评论重建。
> 证据归档：`evidence-phase1-20260913.md` §E25–E28（含「哪些是重建值、哪些不可复现」的如实标注）。

## 1. 目标与验收标准

| 目标 | 验收 |
|---|---|
| 四个主要观测对象越线 → 报警 | `GET /api/nautilus/pulse/alerts` 运行态正确；UI 图标「活跃即闪红」 |
| 越线确认那一刻冻结前 N 小时原始证据 | `<alertsDir>/<id>/{samples.jsonl.gz,meta.json,digest.json}` + sha256 落台账 |
| LLM 报告成文（默认关） | `reports/<id>.md` 三段式；门禁关时事实段仍在、假设段标注缺席 |
| 沉淀台账 | `alert_event` 行 + `ledger.md` 人读日志（含报告内联）+ 人工裁决 `human_verdict` |
| **不干预** | 无任何进程操作 / 配置改写 / vault 读写（红线 2） |

## 2. 模块与契约

| 件 | 位置 | 契约 |
|---|---|---|
| 检测内核（纯函数） | `src/pulse/alerts.ts` | `AlertRule`/`AlertEngine.observe(values, ts) → AlertTransition[]`；`DEFAULT_ALERT_RULES`；`validateAlertRules` 装配期响亮失败 |
| 证据冻结 | `src/pulse/snapshot.ts` | `computeCoverage`（**去重时间戳**）· `samplesToJsonl`（定序）· `freezeSnapshot` · `pruneSnapshots`（独立保留期）· `appendLedgerText` |
| 报告（纯函数） | `src/pulse/report.ts` | `aggregateMetrics` · `buildDigest` · `digestFacts` · `buildPrompt` · `parseHypotheses` · `composeReport` · `composeResultNote` |
| 存储 | `src/pulse/store.ts` + `src/store.ts` migrateV7 | `ALERT_EVENT_DDL` **单一定义处**（主库迁移与 pulse 建表共用）；台账方法 insert/close/open/closeStaleAlerts/counts/recent/setAlertSnapshot/setAlertReport/setAlertVerdict/windowRows/activeSessions |
| 路由 | `src/pulse/routes.ts` | `GET /pulse/alerts` · `POST /pulse/alerts/verdict` · `GET /pulse/alerts/report?id=`（同源门；只读口 405） |
| 装配 | `src/pulse/index.ts` | tick 内检测 → 确认/解除落台账 → 冻结 → digest → 报告；启动自愈收口；prune 节拍里清快照 |
| 客户端 | `src/client/alerts.ts` + workbench 接线 | `AlertsView` · `useAlertBadge` · `alertBadgeOf`/`ruleText` 纯函数 · 图标 `nt-icon-alert` 闪红 |
| 回测 | `scripts/alert-threshold-backtest.mjs` | 只读 · 同判据（回放走 `AlertEngine`）· `--db/--days/--rule/--json/--candidates` |

## 3. 存储 schema（v7）

`alert_event` 的 DDL 逐字对齐 2026-09-21 原实现留在真库里的 schema——**这是本次重建唯一完整幸存的原件**
（从 `.dsh-next/nautilus/nautilus.db` 的 `sqlite_master` 回收）：列含 `op CHECK(gte|lte)` ·
`report_status CHECK(pending|done|skipped|failed)` · `human_verdict CHECK(true-positive|false-positive|unknown)` ·
`snapshot_path/snapshot_hash/report_model/prompt_version/ack_at/note`；索引 `ix_alert_open(cleared_at, confirmed_at)`、
`ix_alert_rule(rule_id, confirmed_at)`。行语义：**一行一条已确认告警**（确认时 INSERT，解除时补 `cleared_at/duration_ms`）。

> `ack_at` 列保留但**没有 ack 通道**（D-A4 裁决：不做 ack）。保留列 = 不动既有库结构（红线 3），不是待办。

## 4. 配置面（只改 cordis.yml 即可加规则/改阈值）

`pulse.alertEnabled`（默认 true）· `pulse.alertRules[]`（id/label/enabled/metric/refMetric/op/threshold/clear/forMs/cooldownMs）·
`pulse.alertsDir`（空 = <库目录>/alerts）· `pulse.alertLookbackMs`（4h）· `pulse.alertSnapshotRetentionDays`（30 天）·
`pulse.alertLlmEnabled`（**默认 false**）· `pulse.alertLlmMaxTokens`（900）· `pulse.alertLlmTimeoutMs`（60s）。
非法组合（重复 id / op 非法 / 解除线方向反 / forMs 负）**加载即抛**，不留到运行时静默失效。

## 5. 子项与提交（重建链）

| 子项 | 内容 | 提交 |
|---|---|---|
| A.1 | 检测内核 + 配置 + v7 迁移 + `GET /pulse/alerts` | `dbbb620` |
| A.2 | 快照冻结 + 覆盖率/指纹 + 独立保留期 | `a49456d` |
| A.3 | digest + 三段式报告 + `ctx.llm` 门禁 + 三层日志 | `89003ba` |
| A.4 | UI（活跃即闪红 + 台账视图 + 报告查看）+ 人工裁决 | `9e63dd1` |
| A.5 | 阈值回测脚本 + D-A8 修订 + 防漂移测试 | `74057dc` |

## 6. 测试清单（`scripts/test-a.mjs`，15 条）

内核：时间窗确认（tick 密度无关）· 滞回与连续段重置（E26 边界逐帧）· 缺样本跳过且状态保持 · 冷却计时继续累积 ·
停用不擅自解除 + lte 峰值取 min + 非法配置响亮失败 · ratio 分母缺席/为 0。
存储：v7 迁移幂等 + 三 CHECK · 台账方法（insert 幂等/close 一次性/closeStaleAlerts/counts/recent）。
A.2：覆盖率口径（去重时间戳回归位）+ 指纹确定性 · freezeSnapshot 产物与 meta · pruneSnapshots 只清自己的 a-* 目录。
A.3：aggregateMetrics/digestFacts 确定性 · parseHypotheses/composeReport（含缺席路径）· **假 llm seam 端到端**（模型段进报告与台账、`report_status=done`、只调一次模型）。
A.4：告警视图真实 react SSR + 徽标纯函数 + 缺席态 · 接线源码级守卫 · 路由 e2e 里的 verdict 门序/落库回读与 report 查看入口。
A.5：默认值 = D-A8 选定值（防漂移）+ 回看 4h + 滞回方向自洽 + 回测脚本只读守卫。

**测试红线遵守**：路由类用例走**真实 `ctx.plugin` 装配**（不是手动 `ctx.plugin(pulse)` 绕过 Loader 路径）；
客户端用例走**真实 react SSR 渲染**并断言外部可见内容。

## 7. 验收与边界

- 离线门禁：六件套全绿（`npm test` 55/55）。端上四元组见 §E29（装配阶段做，见下）。
- **诚实边界**：
  1. 端上四元组（真实越线 → 台账/快照/报告三面一致）**尚未做**——需宿主重启窗口 + 一次真实越线。
  2. 原 A.1 的端上证据（E26：两条真实内存告警、峰值与原始读数逐一核对）**随本地库删除丢失、无法复现**；
     现存的 `.dsh-next` 库（user_version=8、`alert_event` 0 行）只能证明「v7 迁移与表结构曾在该机器上生效」。
  3. A.3 的模型段经**假模型**端到端验证；**真模型输出未验**（原 E28 也停在同一处：真模型输出待一次真实越线）。
  4. 阈值回测窗口从 8.5 天缩到 3.49 天（原库已删），D-A8 的 0.93 在新窗口上仍低于 p99 → OQ-A6。
  5. 手动采样档下没有连续监测——静默不等于没越线（UI 与决策文档均已明示）。
