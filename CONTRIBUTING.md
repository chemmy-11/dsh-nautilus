# 开发规范（CONTRIBUTING）

> 上游文档在雪谷 vault `外功/DSH/`（PROJECT-MOC → 规范 / M1–M5 开发文档 / 首轮分析报告）；本文件只固化**仓库工程约定**，PR 模板自查项与此同源；面向 agent 会话的常驻守则见 [`AGENTS.md`](./AGENTS.md)——两者冲突时**以本文件为准**并回写 AGENTS.md。

## 分支与提交

- `main` 为主干，保持线性；小步本地提交，**push 时机按用户明确指令**（本地领先 origin 是常态）。
- **三条长驻开发线**，各自一条分支、互不混提：
  - `feat/nexus` —— **插件线**：应用层观测插件本体（采集 / 存储 / 路由 / 面板 / 宿主适配）；
  - `feat/nautilus` —— **Nautilus 主线**：三层指标（pulse / infer / nexus）、era 因果上下文、Agentic Ops 工作台；**包含**插件线全部内容，插件线前进后用 `git merge feat/nexus` 同步（不 rebase，保留既有提交 hash）；
  - `feat/ui` —— **UI 支线**：工作台 UI（`--nt-*` 令牌层、S4「瑞士制图」皮肤、五视图、人工标注 UI，规范见 `docs/2-dev/nautilus-dev-02-ui-workbench.md`）；自 `feat/nautilus` 分出、**包含**主线全部内容，主线前进后 `git merge feat/nautilus` 跟随（同样不 rebase）。改动边界 = `src/client/**` 与 UI 文档（`docs/2-dev/ui-*`）；涉 host 半区的配套改动（store / routes / 迁移）仍归插件线。
  同步方向（一律 `merge`，不 rebase）：`feat/nexus` → `feat/nautilus`（常规收敛）；`feat/ui` → `feat/nautilus`（按 UI 开发文档验收节点收敛，如 U1 令牌层、U5 标注闭环达成时）；`feat/nautilus` → `feat/ui`（支线跟随主线）。
  各线收敛 `main` 仍走 squash；跨线公共约定（AGENTS.md / CI / PR 模板 / docs 结构）**改动先落一条线、随即 `merge` 进其余线**，保证各线始终同一份（`main` 尚未被线合并前，模板 / CONTRIBUTING 以线为准；GitHub 上 PR 模板取**目标分支**、issue 模板取**默认分支**，故对 `main` 的 PR 会在 `main` 追平后才看到新模板）。
- 分支命名：`feat/<slug>` / `fix/<slug>` / `chore/<slug>`，与 PR 主题一致（如 `chore/dsh-0.1.5-compat`）；线内子任务挂在线名之后（如 `feat/nexus-m5`）。
- 提交信息：`<type>(<scope>): <中文描述>——<为什么/细节>`；type ∈ feat / fix / refactor / docs / test / ci / chore / build；scope 用里程碑子项（如 `M4-A`、`N1-x`）、模块名或面（`contributing` / `deps` / `client` / `routes`）。
- **宿主适配类提交**（依赖升级 / 契约面适配）的描述必须写明目标宿主版本（如 `dsh 0.1.5-rc.1`），便于按版本回溯。
- 一次提交一个语义单元；无关改动不混提。

## PR 与合并

- 有风险 / 多步改动走功能分支 + PR，描述按模板（背景 / 改动 / 验证 / 自查）。
- 合并一律 **squash**，提交信息即 PR 标题；issue 关联用 `Closes #N` / `Refs #N`。
- **base 约定**：线内子任务 PR 对所在线（`feat/nexus` / `feat/ui` / `feat/nautilus`）；UI 线验收节点收敛 PR 对 `feat/nautilus`；线 → `main` 的收敛 PR 直接对 `main`，同样 squash。
- issue 先行：里程碑子项、缺陷、技术债开 issue 记账，完成在 issue 下留结论后关闭。

## CI 门禁（`ci.yml`：push = `main` / `feat/nexus` / `feat/nautilus` / `feat/ui`，PR = 全部分支）

1. `actionlint` 工作流静态检查（YAML 语义 / 表达式 / shell 语法）。解析失败表现为 **0 jobs 静默无检查**（2026-08-28 事故形态），CI 内自查救不了本文件——推工作流改动前本地跑一次：`go install github.com/rhysd/actionlint/cmd/actionlint@latest` 或直接下载 release 二进制。**注意需同时装 shellcheck 才与 runner 等效**（runner 自带；本机缺失时 SC 系告警漏检，2026-09-04 首跑即栽在 SC2035）。
2. `npm run typecheck`（tsc --noEmit）；
3. `npm run build`（npm-devDeps 模式，无 DSH checkout 也可构建）；
4. `npm run check:deps`（依赖合规：R1 单实例合约 / R2 显式 prerelease 分支（仅约束 `@deepseek-ai/dsh*` 宿主族）/ R3 peer 覆盖 devDep pin）；
5. `npm run check:exports`（导出形态守卫：命名空间插件禁混 `export default` —— Loader 会丢 `inject`，事故 0001）；
6. `npm test`（纯函数回归：analysis / selfcheck / scan）；
7. 元数据校验 `node .github/scripts/check-meta.mjs`（bundle patch / client 双半 / files 清单）+ client shim 断言 + 产物齐全断言（`lib/index.js` · `lib/client.js` · `lib/types/index.d.ts`）。

## 发布（`release.yml`）

- `v*` tag 触发：构建 tgz → GitHub Release；发布前核对 version 与 tag 一致、README 功能描述与实现状态相符（不得含"设计阶段 / 未发布"之类不实声明）。
- `workflow_dispatch` 手动触发 = **干跑**：走完整验证 + 打包管线但不创建 Release——打 tag 前先干跑验证发布链路（release 管线修复后未经真实 tag 验证过，首次发布务必先干跑）。

## 交付与安装通道

`lib/` 不入库，故三条分发路径的构建来源必须各自成立：

| 路径 | 构建由谁触发 | 说明 |
|---|---|---|
| 本地开发 | `npm run build` | **始终构建**；构建链纯 Node（`scripts/prepare.mjs` + `scripts/build-client.mjs`） |
| 本地 dev 循环（装进 profile 后） | **`dsh plugin --profile web add link:<仓库路径>`** → `npm run build` → 重启宿主 | **用 `link:`（Windows 下是 Junction，指向仓库）**：`lib/` 建完即回流，无需重装。**`file:` 是安装副本，且「重跑 add」是空操作**——pnpm 认为依赖已装（`added 0`），副本会停在旧产物，实测因此出现「重启后毫无变化」；真要刷新得先 `remove` 再 `add`。`link:` 下实测**无需重启**：产物变更后启动图 rev **自动更新**（宿主 PID 未变、rev 连换两次，§E14），刷新页面即可；`file:` 副本下 rev 不更新，必须重启（§E13 实测） |
| **git 安装**（`dsh plugin add github:chemmy-11/dsh-nautilus`） | `prepare`（条件）+ `prepack` | 实测（pnpm 11.24）：pnpm 对 git 依赖**两个钩子都会跑**；真正构建的是 `prepack`，条件 `prepare`（`--if-dependency`）在被安装的副本（无 `.git`）里也构建、本地检出跳过，并让 allowBuilds 门**响亮报错**而非静默跳过。构建必须自包含，不得依赖旁边的 monorepo / 项目引用 |
| npm / tarball | `prepack`（`npm pack` / `publish` 前） | 无条件构建，产物随 tarball 分发 |

- **动构建入口或产物路径（新增/移除钩子、改 `files` 白名单、改 `main`/`exports`）时，`build` / `prepack` / `prepare` 三个钩子一起核**，并同 PR 更新 README 双语安装节与本节。
- **`allowBuilds` 是硬门槛**：实测未放行时，只有 `prepack` 的包会被 pnpm **静默跳过构建**（装出来没有 `lib/`，加载期才炸）；声明条件 `prepare` 后 pnpm 改为直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 并给出确切的键（形如 `@dsh-external/dsh-nautilus@git+…#<sha>`）。放行等同授权该包在安装时执行构建代码，按官方建议**锁定 commit SHA**。

## 宿主版本适配（dsh 升级流程）

宿主发新版本（尤其 prerelease 线）时按序执行；**先确认宿主实际版本，不凭 npm dist-tag 推断**（本机 `dsh --version`、profile 实际加载的 `@deepseek-ai/dsh-host-webserver` 版本）。

1. **依赖面**：devDep 精确 pin 到目标版本；peer 追加 `^<ver>` 分支并**保留旧分支**（旧宿主仍支持时）。两者必须同步——`check:deps` R3 会拒绝 peer 未覆盖 devDep pin 的组合。运行时只可 import **随安装提供**的 in-box 包（`@deepseek-ai/*`）；非 scoped 的 `cordis`/`schemastery` 不在 dsh 安装闭包内，写了装不上。
2. **契约面逐项核对**（插件只消费官方契约，不 import 宿主实现）：
   - `session/event`：`turn/start`·`step/start`（`data.turn`·`step`）、`user/message`（`content` 文本块）、`assistant/message`（`data.message.content` + `usage.inputTokens/outputTokens/cacheReadTokens`）、事件信封 `{type, seq, time, data}`；
   - 宿主服务：`ctx.webServer.register(WebRoute{kind,path,handler})`、`ctx.tools.register(ToolDefinition{name,description,parameters,output.schema,output.render,execute})`、`ctx.effect` / `ctx.on`；
   - 客户端：客户端插件就是普通 Cordis 插件（`Context` 来自 `@deepseek-ai/cordis`；`@deepseek-ai/dsh-client-runtime` 在 0.1.5 已移除，属死名）；UI 注册表 `ctx.slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 提供，`slots.inject(key)` + `slots.register(def, Component)`（kind/scope/owner 由归属 UI 包的 SlotMap 增强声明）；`dsh.client.inject` 是**信息性**包名边（列 UI 提供方包名），`dsh.client.external` 才是硬模块边（同步 `require` 决定代码到达），非基线模块请求必须列入；只允许 type-only 跨插件导入（bundle 纯净度门禁），运行时协作走 cordis 服务。
3. **门禁**：typecheck + build + test + check:deps + check:exports + check-meta + client shim 全绿；确认 `lib/` 产物与源码同步、构建模式（checkout / npm-devDeps）符合本机实际。
4. **profile 实测**：记录 profile 名 + 宿主版本 + 装配方式 + 结果（涉数据给前后数字）；装配遵守「工程红线 · profile 卫生」的热装配收敛要求。
5. **记录**：README 双语「兼容性」节更新目标版本；vault 开发文档追加「适配记录」小节（触发 / 改动表 / 契约核对结论 / 验证数据 / 遗留）。

> 契约面稳定时适配**不改码**，只动依赖声明与文档；某条契约变了才按上表定位对应模块，不整包重写。

## 工程红线（事故教训固化）

1. **单实例合约**：in-box 包（`@deepseek-ai/*`：宿主族 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis`/`@deepseek-ai/schemastery`；非 scoped 的 `cordis`/`schemastery` 不在 dsh 安装闭包内、不要用）只进 peerDependencies，严禁 dependencies；peer 范围带显式 prerelease 分支（当前 `@deepseek-ai/dsh-host-webserver`: `^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1`；**每个分支都必须自带预发布标签**——裸 `^0.1.6` 会静默排除 alpha 线，`check:deps` R4 拦此），且 **devDep pin 的版本必须落在 peer 范围内**（`check:deps` R3 自动校验）；遇「peer 装不上」查解析路径，禁止塞 dependencies 修复（hoist 双实例 → 模块级 Symbol 错位 → 全 tool 链崩溃）。
2. **vault 只读**：对 vaultRoot 零写入（不创建 / 不修改任何 vault 内文件）；观测数据与配置只在 `~/.dsh/nautilus/`。
3. **迁移幂等**：SQLite schema 变更走 v{N+1} 顺序迁移，可重复执行；改名 / 搬迁类迁移仅在新缺失时执行，绝不覆盖已有数据。
4. **集中常量**：事件名 / 路由前缀 / API 路径集中定义，避免裸字符串拼写漂移失去编译期保护。
5. **profile 卫生**：装配变更只走 `dsh plugin add/remove` + `dsh --profile <name> --dump-config` 验证；禁手改 profile 的 package.json、禁在 profile 内手动 install。
   **热装配例外**（重启会中断会话时的本地调试）：只允许在 profile 的 `cordis.patch.yml` 用户层用 `insert` 挂本地路径（`patchReload: live` 保存即生效），且 (a) 不动 bundle 列表；(b) **重启前必须收敛**——删掉 patch 行、改走 `dsh plugin add`，否则 bundle 层与 patch 层同 `id` 双挂载（`webServer.register` 对重复 `(kind,path)` 直接抛错）；(c) 跨重启的正式装配一律走 bundle。
6. **单 Loader 条目**（带客户端半区的包）：本包声明 `dsh.client`，因此**整个包只允许一个 Loader 条目**。在 bundle patch / profile patch 里为同一包插两行（例如 `@dsh-external/dsh-nautilus` + `@dsh-external/dsh-nautilus/pulse`，或再用绝对路径手动 insert 一次）会让 client-modules 组合期抛
   `client-modules: package <name> resolves from multiple active Loader sources`，
   后果不是降级而是**宿主启动失败**（2026-09-13 实测：`dsh web` 起不来，且症状离根因很远）。
   **多能力的正确形态**：单条目 + 源码内子插件挂载（`ctx.plugin(pulse, config.pulse)`），配置收进父插件 `Config` 的一个子节。
   守卫：`check-meta` 断言 bundle patch 为本包插入恰好 1 个条目；运行时由 `scripts/test.mjs` 的「单入口装配」用例断言子插件确实注册了自己的路由。
7. **敏感信息**：token / 密钥 / 不必要的本机绝对路径不进仓库；分析结论与验收记录回写 vault 文档，仓库侧保持代码与 README 如实。

## 验证纪律

- **本地门禁六件套**再提交：typecheck + build + test + `check:deps` + `check:exports` + `check-meta`（含 client shim 断言），与 CI 同款。
- **产物的 mtime 要当场核**：门禁全绿≠产物是新的。踩过的坑：`prepare.mjs` 曾只 `warn` 客户端构建失败（旧 `lib/client.js` 留着、六件套照样全绿），端上表现为「改了没变化」——现改为**构建失败即 `process.exit`**；提交前用 `lib/client.js` 的字节数/mtime 或产物内标记（如新面板的 `FIG.0x`）确认这一次真的写进去了。
- 端上行为（面板 / 路由 / 迁移 / 事件订阅）用注入器通道（`dev_build_plugin` / `dev_inject_plugin` / `dev_reload_package`）或 profile 实测，记录**环境四元组**：dsh 版本 + profile 名 + 装配方式（bundle / patch 热装配 / 注入器）+ 结果。
- 宿主升级后另核 `lib/` 构建模式与 `~/dsh-harness`（或 `$DSH_CHECKOUT`）可用性——checkout 缺失时走 npm-devDeps 模式，不要用「能构建」掩盖 checkout 失效。
- 涉统计口径的改动（归属 / 覆盖率 / 曲线基线）须给出前后对照数字。
