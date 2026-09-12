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

（待建：Phase 1「pulse 最小闭环」开发文档 + `evidence-phase1-<日期>.md`；Phase 2a 模型层 API 时代；开发文档二「系统层 OPS 观测框架 + Agentic Ops 工作台壳」）
