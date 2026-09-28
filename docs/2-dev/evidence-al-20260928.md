# 证据归档 · 对齐体系重构（AL 系列）

> 期间：2026-09-28 · 仓库：`chemmy-11/dsh-nautilus` · 归档时三线同点 tip：`693c7ff`
> 归属：决策见 [nautilus-alignment.md](../1-planning/nautilus-alignment.md)；本文件只记**可复核的执行与读数**（AGENTS §7「跑通即归档」）。
> 格式：每项给「执行命令 / 预期 / 实际 / 结论」；**诚实边界随读数一起给**，不单独成段修饰。

## 0. 环境四元组

| 项 | 值 |
|---|---|
| 宿主版本 | **dsh 0.1.7-rc.2**（官方 dsh-desktop；内含 cordis 4.0.4 · host-webserver 0.1.7-rc.2 · schemastery 3.18.4 · client-ui-* 0.1.7-rc.2） |
| profile | `desktop`（由 Electron 应用独占管理）· 另用 `web` profile 做过对照 |
| 装配方式 | `link:L:/dsh-nautilus`（`dsh.profile.bundles` 内含本包）· **非** git 安装 |
| 结果 | 端上可用（守谷人 2026-09-28 确认「可以了」）；**改动需重启应用生效——实测无热更新** |

数据面：库 `~/.dsh/nautilus/nautilus.db`，归档时 `PRAGMA user_version = 10`；
`turn_annotation` 2 行 · `selfcheck_record` 42 行 · `turn_read` 99+ 行 · `alert_event` 3 行（持续增长中，数字仅作量级参照）。

## 1. AL.1 决策文档与签核

| | |
|---|---|
| 执行 | 撰写 `docs/1-planning/nautilus-alignment.md` v0.1（术语收敛 / 1–5 量表 / 迁移账本 / 进化闭环 / nexus 解耦甲）；守谷人逐条签核 |
| 预期 | 6 条待签核项逐条给出裁决后方可动对应代码 |
| 实际 | 「6 签均同意」（记录于该文档 §10）；提交 `7f12ce9` |
| 结论 | 口径锁版。后续所有实现以该文档为唯一依据；口径变更必须回写该文档 |

## 2. AL.6a nexus 解耦（宿主侧）

| | |
|---|---|
| 执行 | `git mv` 四模块入 `src/nexus/`（turns / analysis / selfcheck / selfcheck-ingest）；新增边界守卫测试 |
| 预期 | nexus 只允许 `node:*` / 同目录 / `../store.js`；**pulse 不得反向 import nexus**；顶层同名文件不得回退 |
| 实际 | 守卫进 `scripts/test-al.mjs` 并随 `npm test` 常跑；`d88d81d`（搬迁）+ `0dec1e1`（补引用面） |
| 结论 | 目录自包含成立。**遗留**：pulse 的 v4 尚未进迁移账本 → OQ-AL5（见 §4） |

## 3. AL.2 迁移账本 + v8 迁移

| | |
|---|---|
| 执行 | `npm run build && npm test`；`node --test scripts/test-al.mjs`（账本用例） |
| 预期 | 新库按版本升序应用 v2/v3/v5/v6/v7/v8；跳号 v1/v4 如实记入 `skipped`；重开幂等；重复版本号响亮失败 |
| 实际 | 61/61 通过；账本 `applied=[2,3,5,6,7,8]` · `skipped=[1,4]`；v8 重建 `turn_annotation`（对齐 1–5 + boundary + 代际分层 CHECK），旧 0–4 契合行**一条不丢**（`schema_version=1` / `align NULL` / `fit_prev` 成对） |
| 结论 | 提交 `b2087d6`。**分层纪律**：`legacyFitRows` 与新量表分列，永不合并统计 |

**过程教训（记档）**：本轮先跑测试后才发现测试跑的是 `lib/` 产物——**改完源码必须先 build 再 test**。同一条这天又犯了两次（见 §9）。

## 4. AL.3 自评通道换 al-v1 量表

| | |
|---|---|
| 执行 | 先 v9 迁移把 `selfcheck_record.clarity/defense` 转可空（`de90e2f`），再把工具面换成 al-v1 锚文 + 双形 ingest（`edc3623`） |
| 预期 | 工具描述 = rubric 注入面（1–5 锚文 + 四条边界 + 接/顺/推 逐字）；`align≥4` 无引文**拒且零写入**；`rubric_version=al-v1` 只盖新形行 |
| 实际 | 66/66；锚文逐字在场（程序化校验）；硬门实测 `align-quote-required` / `invalid:align` 均零写入；HTTP 新形 `align=4` 无引文 → 400、带引文 → 200 |
| 结论 | **自评就此进入 1–5 口径**。后续每轮 `record_turn_selfcheck` 用的就是它（本会话自评记录可回查） |

**N/A 的落法（已确认口径）**：工具通道 `align` 必填 → 纯操作性轮**不调用本工具**（= 等价豁免、不进分母），不造 `align:null` 豁免行。

## 5. AL.5 一致性闭环（机制就位，**数字未产生**）

| | |
|---|---|
| 执行 | `npm run consistency`（只读）· 自建样本库冒烟 |
| 预期 | 三指标（完全一致率 / 相邻档一致率 \|Δ\|≤1 / 二次加权 κ）+ 确定性留出集；样本 <50 只报数不给结论；配对键不符时大声提示 |
| 实际 | **自建样本**：5 对 → 40.0% / 100.0% / κ 0.800；留出集 2 对 → 50.0% / κ 0.667。**真实库**：`pairs=0`（自评旧代际不进配对，人工标注尚少） |
| 结论 | 机制可信、口径单一（脚本与路由共用 `src/nexus/consistency.ts`）。**诚实边界：尚无任何真实一致性数字**——`n<50`，一次真实读数都没跑过 |

## 6. 工作台与打分件（AL.4a–AL.4f，迭代密集）

| 提交 | 内容 | 验收读数 |
|---|---|---|
| `13d5294` | AL.4a 删「假设/预言」两视图 + 撤工作区指向抽象与两态 | 路由删净（grep 0 命中）；守卫 + 负控（注入术语即变红） |
| `4d93e40` | AL.4b「对齐」视图（双路台账 + 分布 + 边界 + 一致性） | 67/67 |
| `27839a5` / `9c4c6de` | 契约 v2（`selfTotal/selfRatio/legacySelfRows/holdout/scale.min`）+ 打分件换代「契合 0–4」→「对齐 1–5」 | 80/80；真库副本实测响应体 |
| `131c6a8` / `11e313e` / `f900e55` / `cd52218` | AL.4d–4f：撤边界行 · 提交键右上 → 改回**与分数同排同高** → 再**右端与输入框右端对齐** · 输入框高度翻倍 | 各轮 87/87；无头 Edge 实测像素（`submitRight == inputRight == 68`） |
| `1fa5b98` | AL.4g：Config `lField` → **`readings`**（破坏性配置改名） | 动前先查活 profile **未设该键** → 硬改名安全；撤销术语守卫对 `src/index.ts` 的豁免后，守卫**当场咬住我自己新写的注释**里的废止术语 |

## 7. AL.5s / AL.6e 会话数据面

| | |
|---|---|
| 执行 | `/m2/sessions` 列表 + 详情（`45cb098`）；v10 落 `turn_read.workspace` + 会话并集（`0e173f7`） |
| 预期 | label = 工作区名 · 会话名（服务端单点派生）；`hasText` 与服务端原文门**同一谓词**；并集轮次指标**为 null 而非 0** |
| 实际 | 真库副本：并集增量**恰 +3**（`session-08665854` 的 turn 10/30/31），详情 55 → **58** 轮；活库 `user_version=10`、`workspace` 列已建 |
| 结论 | 「手里有数据却看不见」的两类（无工作区列、有原文无读数）都补回。**诚实边界**：历史行不回填 → 历史会话仍显「未知工作区」；「会话名」是**派生名**（首条非 `<` 开头 question 首行 24 字，缺则 session id 末 8 位），**不是宿主真会话名** |

## 8. 桌面宿主适配（AL.6d）——本轮最贵的一课

**症状**：dsh-desktop 里工作台无数据、打分恒「提交失败 forbidden」，控制台 300+ 条同 URL 403 刷屏。

**取证与结论**：

| 步骤 | 命令 / 手段 | 实际 |
|---|---|---|
| 机制 | 解析官方 `app.asar` 索引读源码 | `dsh-client-modules@0.1.7-rc.2`：扫 Loader 条目的 `dsh.client` 双面包 → `__DSH_BOOT__` 图 → `plugins/<id>/client.js`；**`dsh.client.platform` 只做字符串校验、不按平台过滤** → 先前「platform 被过滤」假设**撤回** |
| 版本面 | asar 内 package.json | 全部落在本插件 peer 范围内（cordis 4.0.4 / webserver·client-ui-* rc.2 / schemastery 3.18.4）→ **不是版本问题** |
| 装配面 | `dsh --profile desktop --dump-config` | **被拒**：`profile "desktop" is managed exclusively by the Electron application` → 桌面装配无法用 CLI 验证 |
| 真因 | DevTools Network → 请求头 + 门自证 `seen` | 代理请求实测：**`sec-fetch-mode: cors` 在场，`sec-fetch-site`/`origin`/`referer` 全缺**；而判据要求「三者全缺」→ 被 `mode` 卡死 |

**修法**（`b573c26` + `7a97061`）：判据改为「**`site` 与 `origin` 都缺 → 放行**；`cross-site`/`same-site` → 拒；`none` → 放行」——**`sec-fetch-mode` 不是跨站信号**。
新增 `forbiddenByGuard()`：门拒绝时**回显 `seen{site,mode,origin,referer}`**——正是它把定位从「重建—重启—猜」变成「读响应」。

**顺带堵住的真窟窿**（`4e7c6b5`）：原判据「存在 `Origin` 即放行」，实测 `cross-site` + `origin: https://evil.example` **返回 200**——跨源**响应**读不到，但**写请求照样执行**（打分/裁决都是写）。

**重启后复验（curl 打运行中的宿主）**：

```
mode: cors                          → 200     （此前恒 403）
mode: cors + cross-site + origin    → 403     （防护仍在）
无头                                 → 200     （本地脚本形态）
POST 同形态（不存在的轮次）            → 400 no-turn-text（语义层错误 = 门已放行；turn_annotation 行数不变，零写入）
```

**我（Lead）在这条上连错两次，记档以免重蹈**：
1. 用「无头 curl 返回 200」就宣布验证生效——**探针没复现应用的真实请求头**；
2. 收紧时只放行 `same-origin`，把浏览器会发的 `none` 误拒。

**热更新**：实测**不可用**——重建 `lib/` 后运行实例不变（真库仍 v9、详情仍 55 轮），`dsh-hmr` 的 `root: []` 且插件在 profile 目录之外。结论：**桌面端改动必须重启**。

## 9. 诚实边界与未闭环

1. **AL.5 无真实数字**：机制在位，`n<50`，一次真实「rubric v2 候选 → 留出集回归 → 采纳/回滚」都没跑过。
2. **工作区名 forward-only**：历史会话仍「未知工作区」（不回填）；新轮次从 v10 起积累。
3. **「会话名」是派生名**，非宿主真名；若要真名需捕获 `session/header.title`（另一条改动）。
4. **两个分母**：`/m2/sessions` 的 `turns` 是**并集**轮数（读数 ∪ 有原文），`/m2/state` 的 `totals.turns` 是**读数**口径——不是同一个数，文档已写明。
5. **端上 UI 验收**：AL.6f 的客户端改动需重启后由守谷人确认；本文件凡「实测」均指可复核的命令输出，SSR/守卫/负控不等价于端上。
6. **门的行为以响应体自证**：`seen` 回显是常设机制，后续任何宿主形态不符，先从 `403` 的响应体读原因。
7. **A 系列强制越线**（E30，另档）：那次录取是**强制**（threshold 0）而非自然越线，不可当作真实告警样本。

## 10. 可回查凭据（提交清单，按时间）

```
7f12ce9 docs(AL.1)  d88d81d 0dec1e1 (AL.6a)  b2087d6 (AL.2)  de90e2f edc3623 (AL.3)  c0847e4 (AL.5)
13d5294 (AL.4a)  4d93e40 (AL.4b)  45cb098 (AL.5s)  27839a5 (契约 v2)  9c4c6de (AL.4c)
86f8dfd (写路径双形)  bb77cb1 (409 代际门)  500eec6 (v3 纯简化)  5b2d713 (AL.4 合流)
1fa5b98 (AL.4g)  131c6a8 11e313e f900e55 cd52218 (AL.4d–4f)  0e173f7 (AL.6e)
03b70b9 4e7c6b5 b573c26 7a97061 (AL.6d 桌面适配)  693c7ff (AL.6f)
```

复核入口：`npm run typecheck && npm run build && npm test && npm run check:deps && npm run check:exports && node .github/scripts/check-meta.mjs`
（归档时 **106/106 通过**）；桌面形态复核见 [nautilus-dev-07-desktop-host.md](./nautilus-dev-07-desktop-host.md)。