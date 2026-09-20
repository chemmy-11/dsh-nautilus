# 2-dev · 开发文档

Nautilus 各阶段的具体开发文档：模块设计、接口契约、schema、验收标准与证据归档索引。

## 内容约定

- 每个开发阶段（Phase）对应至少一份开发文档，含：目标与验收标准、模块划分、指标口径引用（指向 1-planning 的开题报告 §4.2）、存储 schema、运行命令与预期输出。
- 「跑通即归档」：每个 Phase 的《证据归档文档》（执行命令 / 预期输出 / 实际输出 / 观察结论）放本目录，命名 `evidence-<phase>-<日期>.md`。
- 约束（继承自规划）：每次只推进一个 Phase；选型变更需回写 [../1-planning/](../1-planning/) 决策记录。

## 现有文档

| 文档 | 内容 | 状态 |
|---|---|---|
| [nautilus-dev-01-phase0.md](./nautilus-dev-01-phase0.md) | 开发文档一 · Phase 0：选型决策（D1–D3）与因果链确认——TTFT / model / endpoint 可得性实测、era 定稿建议、OTLP 成本量化 | v0.1，**待开发组评审** |
| [evidence-phase0-20260912.md](./evidence-phase0-20260912.md) | 证据归档 · Phase 0：命令 / 预期 / 实际输出 / 观察结论，含可复现测量脚本 | 已归档（2026-09-12） |
| [nautilus-dev-02-ui-workbench.md](./nautilus-dev-02-ui-workbench.md) | 开发文档二 · S4 工作台 UI 定版：五视图 / 三层联动 / era 措辞分级 / `--nt-*` 令牌映射 / `turn_annotation` 契约 | v0.1（UI 支线） |
| [nautilus-dev-03-os-layer.md](./nautilus-dev-03-os-layer.md) | 开发文档三 · Phase 1：pulse（OS/GPU 层）——15 条序列 / 6 族口径、常驻计数器助手的成本实测、`metric_sample` 与 v3→v4 迁移、只读取数路由 | v0.1，**待开发组评审** |
| [evidence-phase1-20260913.md](./evidence-phase1-20260913.md) | 证据归档 · Phase 1 + S 系列：通道成本对比、15 族落库、迁移与 soak（E21 起含 S1.1 自评多源采集） | 归档中（soak 回填后定稿） |
| [nautilus-dev-04-selfcheck-ingest.md](./nautilus-dev-04-selfcheck-ingest.md) | 开发文档四 · **S1.1 自评多源采集**：`selfcheck_record`（v5 迁移）、共享 ingest、`POST /selfcheck`（token 门默认关）、工具 quote 硬门、MCP 前瞻约束 | v0.1（**S1.1 已交付**，见 E21；S1.2 面板切读待建） |

（待建：**S1.2「自评读侧统一与覆盖率三态」开发文档**（面板切读 `selfcheck_record`、按 source_kind/agent 分层、缺口三态——决策 D-SC4 落点）；Phase 2a「模型层 API 时代」开发文档；Phase 3「core 管道与时间窗对齐」；1 分钟档聚合与 OTLP 导出按 [nautilus-dev-03-os-layer.md](./nautilus-dev-03-os-layer.md) §7 的 OQ 推进）
