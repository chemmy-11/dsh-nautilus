# 开发文档四 · S1 自评多源采集（存储 + ingest 通道）

> 版本 v0.1（2026-09-27 开项）。上游决策：[../1-planning/nautilus-selfcheck-multisource.md](../1-planning/nautilus-selfcheck-multisource.md)（D-SC1/2/3 已签核，D-SC3a MCP 前瞻）。
> 子项拆分：**S1.1（本文档）= 存储模型 + 共享 ingest + DSH 工具改造 + HTTP 通道**；S1.2（后置）= 面板分层读数与覆盖率三态（D-SC4 落点）；S1.3（远期）= MCP server 薄壳（守谷人意向，另立文档）。

## 1. 目标与验收标准

| # | 验收项 | 判据 |
|---|---|---|
| 1 | v4→v5 迁移 | 存量库升级幂等可重跑；`turn_read` 既有统计**前后数字不变**（对照证据入 E21）；新库直达 v5 且不抢 pulse 语义 |
| 2 | 共享 ingest | 校验/去重/落库一个实现（`src/nexus/selfcheck-ingest.ts`），DSH 工具与 HTTP 路由都是薄壳（D-SC3a 约束 1） |
| 3 | 工具改造（D-SC2） | `declaration=1` 无 `quote` → **拒绝并要求重提**（不写入、不降级）；`quote` ≤200 字 |
| 4 | HTTP 通道（D-SC1） | 禁用 403 / 缺错 token 401 / 非法 400 / 合法 200；重复投递 = 修正覆盖 + `duplicate:true`，不双写 |
| 5 | 测试红线 | 迁移/四分支/口径一致经 **真实装配路径**（`ctx.plugin(mod)` + 已注册 handler）断言外部世界 |
| 6 | 门禁 | 六件套全绿；零新依赖；`check:meta` 单 Loader 条目不变 |
| 7 | 端上 | 宿主半区**需重启生效**（诚实边界：本轮离线证据为主，端上四元组待守谷人重启窗口） |

## 2. 模块划分

> **路径变更（2026-09-28，AL.6 解耦第一步）**：下表中的 `src/selfcheck-ingest.ts` 与 `src/selfcheck.ts`
> 已移入 `src/nexus/`（同文件名），本表其余内容与口径不变。

| 文件 | 内容 | 性质 |
|---|---|---|
| `src/nexus/selfcheck-ingest.ts` | `IngestInput` / `validateIngest` / `ingestSelfCheck`（唯一口径：校验→去重→落库） | 纯逻辑，零 HTTP / 零工具依赖 |
| `src/store.ts` | `migrateV5`（建表+两索引，v→5）+ `insertSelfCheckRecord` / `countSelfCheckRecords` / `schemaVersion` / `selfcheckWorkspaceOf` | 迁移唯一权威不变（D-N1 前） |
| `src/nexus/selfcheck.ts` | 工具半壳：兼容夹取（clarity/defense）→ 调 ingest（`source_kind='dsh_tool'`）→ **双写**旧 `turn_read` 列（过渡期，S1.2 切读后停） | 契约变更点：`quote` |
| `src/routes.ts` | `POST ${API_PREFIX}/selfcheck`：token 门 → `readJson` → `validateIngest`（严格）→ 落库 | 集中常量：`SELFCHECK_TOKEN_HEADER` |
| `src/index.ts` | `Config.selfcheck.ingest = { enabled, token, maxBodyBytes }`；**enabled=true 且 token 空 → 加载时抛错**（响亮失败） | 默认关 |

## 3. 数据契约

### 3.1 表（定案版）

见决策文档 D-SC3（`selfcheck_record`，`turn_ordinal NOT NULL`，唯一键 `(source_kind, ext_ref, turn_ordinal)`，`source_kind` 枚举含 `'mcp'` 预占）。**建表只走 `migrateV5`**，构造函数 DDL 不加（与 vault 残留表同理：新库也经迁移序列创建，保持版本单调）。

迁移顺序与 pulse 兼容：新库 nautilus 0→2→3→**5**，pulse 侧 `v > 4` 直接返回（其建表在构造 exec 里幂等完成，不依赖版本推进）——**pulse 代码零改动**，此结论入测试断言。

### 3.2 DSH 工具 `record_turn_selfcheck`（v2 口径，`schema_version=1`）

- 新增参数 `quote: string（可选，声明 declaration=1 时必填）`，`additionalProperties: false` 不变。
- 行为：`declaration=1 && quote 缺/空/超 200 字` → 返回拒绝文案「自评被拒：declaration=1 必须附 quote（宣告原句，≤200 字），补充后重提」，**两库都不写**；`declaration=0` 时传入的 quote 一律丢弃（不静默存——防「0+引文」歧义行）。
- 落库：ingest（`dsh_tool`）+ 旧列双写；返回串保持 `已记录 turn N 自评（…）` 前缀（下游有匹配）。
- 缺省 session/turn 回退「最近一轮」保留（工具侧便利），但 **ingest 本体要求显式身份**——回退只发生在工具半壳。

### 3.3 HTTP `POST /api/nautilus/selfcheck`

```
请求头：x-nautilus-selfcheck-token: <token>
请求体：{ agent*, ext_ref*, turn_ordinal*, clarity*, defense*, declaration*,
        quote?, model?, workspace?, ts_client?, schema_version? }   // * 必填
响应：  200 { ok:true, result:'inserted'|'duplicate' }
        400 { ok:false, error:'bad-json' | 'invalid:<字段>' | 'quote-required' }
        401 { ok:false, error:'unauthorized' }      403 { ok:false, error:'ingest-disabled' }
        405 其余方法
```

- **严格校验**：非法即 400（不做工具侧的夹取兼容）；`clarity` 必须 `[0,1]` 有限数；`turn_ordinal` 必须正整数；`declaration=1` 无引文 → 400 `quote-required`。
- 体长上限 `maxBodyBytes`（默认 8192；超限 400 `too-large`）。同源标记守卫**不适用**（本路由的调用方是外部 harness 钩子，不是浏览器），以 token 为唯一门——**默认关**，开启动作即部署决策。
- 幂等：同键重投按修正覆盖处理（响应标 `duplicate`）。

## 4. 配置（cordis.yml 可改，零代码变更即换部署）

```yaml
nautilus:
  selfcheck:
    ingest:
      enabled: false        # 默认关：路由存在但恒 403
      token: ""             # enabled=true 且空 → 加载失败（响亮）
      maxBodyBytes: 8192
```

## 5. 诚实边界（随读数引用）

同决策文档 §3；另加一条：**S1.1 期间面板仍读旧 `turn_read` 列**——HTTP/MCP 来源的自评在 S1.2 切读前**不进面板**，只进库；不得把面板覆盖率当作多源总覆盖。

## 6. 测试清单（scripts/test.mjs 追加）

1. `migrateV5`：v4 存库（含 `turn_read` 数据）升级 → v5、表在、行数对照不变；重开幂等。
2. ingest 纯函数：合法 / clarity 越界 / defense 枚举外 / declaration=1 无引文 / turn_ordinal 非法 → 各判据。
3. 工具新契约：无引文拒绝（零写入）、带引文成功（双写在案）、`schema` 含 quote。
4. 真实装配路径（`ctx.plugin` + handler 表）：路由清单含 `/api/nautilus/selfcheck`；四分支（403/401/400/200）+ duplicate + pulse 兼容（v5 库上 pulse 不抢版本、表在）。
5. 既有 22 测不回归（`buildSelfCheckTool` schema 断言同步更新）。

## 7. 关联

- 证据归档：E21（本目录 evidence-phase1-20260913.md 追加，沿 E13–E20 先例）。
- issue：GitHub「S1 自评多源采集（通道 A）」。
- 回写清单见决策文档 §5（M5 状态行 / 谷规第 6 条——守谷人点头后经 /obsidian 通道执行）。
