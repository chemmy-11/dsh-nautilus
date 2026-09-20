# dsh-nautilus

[English](./README.en.md) | 中文

DeepSeek Harness（`dsh`）的观测插件（`@dsh-external/dsh-nautilus`）：**会话级量化观测**——逐轮遥测（token/缓存/耗时/tps + 自评）与形态分析，外加 OS/GPU 采集层（pulse）。观测数据全部私有化存储（`~/.dsh/nautilus/`），重启/重载不丢不重。

> ⚠️ **vault 观测腿已于 2026-09-27 下线**：本插件不再读写任何 vault（原「Vault 观测」面板与 `/api/nautilus/{state,vault,action}` 三条路由已删除）。笔记检索 / 移动 / 重命名请在**会话侧**用 `/obsidian` 技能（读 Obsidian 的 `obsidian.json` 解析活动 vault，多库可切换）。

## ① Vault 观测（已下线）

2026-09-27 起本插件**不再观测 vault**：全量扫描、`fs.watch` 编辑监听、vault 统计面板与指向切换整体移除（vault 侧工作交给会话侧 `/obsidian` 技能，多库支持更自然）。
老库里的 `vault_meta` / `edit_event` / `vault_config` 三张表**保留不删**（红线：绝不销毁既有数据），但代码不再读写。

## ② 会话读数（L 场读数）

把「一段对话对知识库走了多远」变成数字——**会话级 LLM 观测 + 量化自评 + 曲线形态分析**：

- **指标口径**：token（输入/输出/缓存命中）、缓存命中率与未命中率（未命中率 = A 投影）、TPS 与解码耗时、每轮主观清晰度自评（0–1）——**主客观双指标交叉验证，互相限制偏差**（客观曲线有缓存预热与新话题混杂，主观自评有报告偏差）；
- **官方事件直采**：订阅宿主 `session/event`（**零宿主源码修改、无第三方插件依赖**），数据私有目录隔离（`~/.dsh/nautilus/`，SQLite，重启/重载不丢不重）；
- **双 tab 看板**：SVG 曲线支持**放大、筛选（时间窗/会话）、问答回看**（逐轮完整问答原文）；
- **可重复分析管线**：形态分类（S 形/上升/下降/反转 S）· 特征时间 τ_e 检出 · 分桶对照——首轮实证：**指向工作区会话未命中率 13.7% vs 其它工作区 5.6%**（当时按 vault 指向分组），与知识型会话探索密度更高一致；
- **自评覆盖**：逐会话覆盖徽标（已评/总轮次 + 缺口轮号），低于 80% 预警；
- **预言检验表**：P1–P9 假设逐条标注（待验证/进行中/已检验），分析结论回写。

> 「L 场」是作者私人研究框架（L-theory）的用语；对外部使用者，把这块读作**会话级 LLM 观测看板**即可——指标本身（token/缓存/TPS/自评）都是标准的可观测性量。

## 指向与视图

- 插件只有一个指向：**L 场指向**（会话归属的工作区根），可在面板内确认/切换（二次确认，历史归属不删）；vault 指向已随 vault 观测腿下线；
- 会话归属规则：**发起时所在工作区**——在指向工作区内发起的会话归入「指向」视图，其余只在全局视图出现；历史会话按同一规则回溯归类；
- 看板两视图：**全局**（全部工作区会话）/ **〈指向短名〉**（在指向工作区发起的会话），对照分析即视图切换。

## 兼容性

- **宿主支持矩阵**：`dsh` **0.1.5-rc.2**（稳定主用，已实测）+ **0.1.6-alpha.2**（并存安装 `dsh-next`，已实测，见下「适配验证」）；peer 范围 `@deepseek-ai/dsh-host-webserver` = `^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1`——**每个分支都必须自带预发布标签**：按 semver 预发布规则，`0.1.6-alpha.2` 只能被「同元组且带预发布」的比较器匹配，写裸 `^0.1.6` 会静默排除 alpha 线（`check:deps` R4 拦此）；带 tag 的分支同时覆盖 alpha 与日后转正的 stable；
- **契约面**：宿主侧只消费官方 `session/event`、`ctx.webServer.register`、`ctx.tools.register`，客户端只消费 `ctx.slots`（`conversation.view`）——不 import 宿主实现，故跨 prerelease 版本无需改码；
- **依赖面**：运行时只 import 随 dsh 安装提供的 in-box 包——`@deepseek-ai/cordis`（类型）、`@deepseek-ai/schemastery`（Config schema）、`@deepseek-ai/dsh-host-webserver`（路由类型）；非 scoped 的 `cordis`/`schemastery` 不在安装闭包内，已迁移；
- **客户端入口**：客户端插件就是普通 Cordis 插件（`Context` 来自 `@deepseek-ai/cordis`；`@deepseek-ai/dsh-client-runtime` 在 0.1.5 已移除）；UI 注册表 `ctx.slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 提供；只 type-only 跨插件导入，运行时只 require 基线 `react`；
- **适配验证（2026-09-13，dsh 0.1.5-rc.2）**：先做契约面对照——rc.1→rc.2 的 `dsh-host-webserver` / `dsh-session` / `dsh-tools` / `dsh-client-ui-renderer` / `dsh-client-ui-conversation` 产物除版本号外逐字节一致（无接口变更，故不改码）；devDep 精确 pin 升 `0.1.5-rc.2`（cordis 4.0.2 / schemastery 3.18.2 与 rc.2 依赖一致）；`typecheck` / `build` / `test`（12/12）/ `check:deps` / `check-meta` / client shim 全绿；隔离 `DSH_HOME` 的入口冒烟通过（Standard Schema 默认值与非法值拒绝 + 8 路由 + 1 工具 + 2 事件订阅 + 6 disposer + 新库 schema v3/9 表）。上一轮 0.1.5-rc.1（2026-09-10）同为全绿。

- **适配验证（2026-09-20，dsh 0.1.6-alpha.2 · 并存安装 `dsh-next`）**：契约面逐项对照 `C:\Users\15266\dsh-next\node_modules\@deepseek-ai\*` 的类型声明——槽位注册选项（`keyed → options.key` / `list → options.id|order|label`，label 仍支持函数形，新增可选 `priority`）、`ctx.layout.selectPanel(MainPanelId|null)`、`sidebar.panellist` 与 `SidebarPanelMetadata`、`WebRoute{kind,path,handler}`、`ctx.subprocess`（`spawn(graceMs/maxBytes/signal)` + `exitCode/signal/readFrom`）、`dsh.client` 清单字段（`platform/inject/immediately?/external?`）**全部未变**，故**不改码**；peer 追加 `^0.1.6-alpha.1` 分支（devDep 仍 pin `0.1.5-rc.2`，两版共存）；`check:deps` 新增 R4（宿主 peer 每个分支必须带预发布标签）并做反向验证（裸 `^0.1.6` 被拦下并给出确切分支名）。**端上实测**：`dsh-next --profile web --patch <临时叠加> ` 起 0.1.6（端口 3099，探测走进程内叠加、**不改 profile**），启动日志 `[nautilus] Pulse OS/GPU 层已挂载（子插件）`、`[pulse] mode=auto interval=5000ms exec=ctx.subprocess db=…\.dsh-next\nautilus\nautilus.db`；启动图含本行（rev `a05f2c1db892a264-51`），下发 bundle 含工作台与心跳控件标记；`/api/nautilus/{state,vault,lfield,m2/state,m2/analysis,m2/annotations,pulse/state}` 全 **200**（注：`state`/`vault` 两条已于 2026-09-27 随 vault 观测腿下线）（pulse 15 指标、`shell=powershell`、`gpuOk=true`）；`POST /pulse/control` 切 1s→`{mode:auto,intervalMs:1000}`、`{mode:manual,sample:true}`→ticks 5→6、非法档位→**400**；六件套全绿（`test` 22/22）。

## 安装

```sh
dsh plugin --profile <name> add github:chemmy-11/dsh-nautilus
```

本仓库不提交 `lib/`，故 **git 形式安装在安装时就地构建**（`prepare` / `prepack` → `scripts/prepare.mjs`）：pnpm ≥10 **必须在 profile 的 `pnpm-workspace.yaml` 放行 `allowBuilds`**（键形如 `@dsh-external/dsh-nautilus@git+…#<sha>`）——实测未放行时 pnpm 会直接报错并给出该键（不报错的形态更危险：装出没有 `lib/` 的包，加载期才炸）；放行等同授权该包在安装时执行构建代码，**建议锁定 commit SHA**。构建需要 dsh 源码 checkout，自动探测 `$DSH_CHECKOUT` 或 `~/dsh-harness`，探测不到则回退 npm-devDeps 模式（git 安装时 devDependencies 由包管理器装好）。本地 `npm install` / `npm ci` 不隐式整包构建（本地开发用 `npm run build`）。

配置示例（profile 的 `cordis.patch.yml`；全部字段都有默认值，通常无需配置）：

```yaml
- id: nautilus
  config:
    lField:
      enabled: true
      historyDays: 30
    pulse:            # OS/GPU 采集子插件
      intervalMs: 5000
      enableCounters: true
      enableGpu: true
```

## API（同源访问）

| 端点 | 说明 |
|---|---|
| `GET /api/nautilus/m2/state` | 会话读数（latest / totals / curve / selfcheck 覆盖；`?root=all` 切全局视图） |
| `GET/POST /api/nautilus/m2/annotations` | 预言标注读写 |
| `GET /api/nautilus/m2/turn-text` | 某轮完整问答原文 |
| `GET /api/nautilus/m2/analysis` | 白盒分析（S 形 / 爆发段 / τ_e） |
| `GET/POST /api/nautilus/lfield` | L 场指向状态 / 切换 |

## 构建

```sh
DSH_CHECKOUT=<dsh-checkout> bash scripts/build.sh   # = node scripts/prepare.mjs（host tsc + client esbuild）
```

构建链为纯 Node 实现（`scripts/prepare.mjs` + `scripts/build-client.mjs`），不依赖 bash 环境差异。

**两种构建模式**（`scripts/prepare.mjs` 自动选择）：
- **checkout 模式**（本地开发）：探测到 `$DSH_CHECKOUT` / `~/dsh-harness` → 从 checkout junction 链接 `cordis`/`schemastery`/`dsh-host-webserver` 并复用其 tsc/esbuild；
- **npm-devDeps 模式**（CI / 无 checkout）：`npm install` 装好 devDependencies 后直接用本地依赖构建，无需 dsh 源码。

## CI

`.github/workflows/ci.yml` 在每次 push/PR 上跑 `typecheck` + `build`（npm-devDeps 模式）+ 测试 + 元数据校验（bundle patch / client 双半 / files 清单）；`.github/workflows/release.yml` 在 `v*` tag 上自动构建 tgz 并创建 GitHub Release。

## 设计原则

- **独立可装**：仅依赖官方 `cordis`/`schemastery`/`dsh-host-webserver`，不与任何其它插件耦合；
- **观测即留痕**：编辑与会话读数从部署起前向积累（SQLite 持久化，重启/重载不丢不重）；
- **边界意识**：**不碰 vault**（vault 观测腿已下线）、数据私有化（`~/.dsh/nautilus/`，不混入其它数据源）；
- **归属不混数**：会话按发起工作区归属，指向工作区会话与其它工作区会话分开分析（同一分类规则，不做时间分代）。

## 安全说明

安装插件等于在机器上运行第三方代码，权限与运行者相同。安装前请先阅读源码；本插件**不访问 vault**，只写自己的数据目录 `~/.dsh/nautilus/`。
