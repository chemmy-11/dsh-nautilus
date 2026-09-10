# 开发规范（CONTRIBUTING）

> 上游文档在雪谷 vault `外功/DSH/`（PROJECT-MOC → 规范 / M1–M4 开发文档 / 首轮分析报告）；本文件只固化**仓库工程约定**，PR 模板自查项与此同源。

## 分支与提交

- `main` 为主干，保持线性；小步本地提交，**push 时机按用户明确指令**（本地领先 origin 是常态）。
- 分支命名：`feat/<slug>` / `fix/<slug>` / `chore/<slug>`，与 PR 主题一致（如 `chore/dsh-0.1.5-compat`）。
- 提交信息：`<type>(<scope>): <中文描述>——<为什么/细节>`；type ∈ feat / fix / refactor / docs / test / ci / chore / build；scope 用里程碑子项（如 `M4-A`、`N1-x`）、模块名或面（`contributing` / `deps` / `client` / `routes`）。
- **宿主适配类提交**（依赖升级 / 契约面适配）的描述必须写明目标宿主版本（如 `dsh 0.1.5-rc.1`），便于按版本回溯。
- 一次提交一个语义单元；无关改动不混提。

## PR 与合并

- 有风险 / 多步改动走功能分支 + PR，描述按模板（背景 / 改动 / 验证 / 自查）。
- 合并一律 **squash**，提交信息即 PR 标题；issue 关联用 `Closes #N` / `Refs #N`。
- issue 先行：里程碑子项、缺陷、技术债开 issue 记账，完成在 issue 下留结论后关闭。

## CI 门禁（`ci.yml`，push / PR 全量）

1. `actionlint` 工作流静态检查（YAML 语义 / 表达式 / shell 语法）。解析失败表现为 **0 jobs 静默无检查**（2026-08-28 事故形态），CI 内自查救不了本文件——推工作流改动前本地跑一次：`go install github.com/rhysd/actionlint/cmd/actionlint@latest` 或直接下载 release 二进制。**注意需同时装 shellcheck 才与 runner 等效**（runner 自带；本机缺失时 SC 系告警漏检，2026-09-04 首跑即栽在 SC2035）。
2. `npm run typecheck`（tsc --noEmit）；
3. `npm run build`（npm-devDeps 模式，无 DSH checkout 也可构建）；
4. `npm run check:deps`（依赖合规：R1 单实例合约 / R2 显式 prerelease 分支 / R3 peer 覆盖 devDep pin）；
5. 元数据校验：bundle patch / client 双半 / files 清单 / client shim 断言；
6. `npm test`（纯函数回归：analysis / selfcheck / scan）。

## 发布（`release.yml`）

- `v*` tag 触发：构建 tgz → GitHub Release；发布前核对 version 与 tag 一致、README 功能描述与实现状态相符（不得含"设计阶段 / 未发布"之类不实声明）。
- `workflow_dispatch` 手动触发 = **干跑**：走完整验证 + 打包管线但不创建 Release——打 tag 前先干跑验证发布链路（release 管线修复后未经真实 tag 验证过，首次发布务必先干跑）。

## 宿主版本适配（dsh 升级流程）

宿主发新版本（尤其 prerelease 线）时按序执行；**先确认宿主实际版本，不凭 npm dist-tag 推断**（本机 `dsh --version`、profile 实际加载的 `@deepseek-ai/dsh-host-webserver` 版本）。

1. **依赖面**：devDep 精确 pin 到目标版本；peer 追加 `^<ver>` 分支并**保留旧分支**（旧宿主仍支持时）。两者必须同步——`check:deps` R3 会拒绝 peer 未覆盖 devDep pin 的组合。
2. **契约面逐项核对**（插件只消费官方契约，不 import 宿主实现）：
   - `session/event`：`turn/start`·`step/start`（`data.turn`·`step`）、`user/message`（`content` 文本块）、`assistant/message`（`data.message.content` + `usage.inputTokens/outputTokens/cacheReadTokens`）、事件信封 `{type, seq, time, data}`；
   - 宿主服务：`ctx.webServer.register(WebRoute{kind,path,handler})`、`ctx.tools.register(ToolDefinition{name,description,parameters,output.schema,output.render,execute})`、`ctx.effect` / `ctx.on`；
   - 客户端：`ctx.slots.inject('conversation.view')` + `slots.register(def, Component)` 的 `kind=list` / `scope=session`；`dsh.client.inject` 列出的模块名在当前宿主**可解析**（历史名如 `@deepseek-ai/dsh-client-runtime` 已消失，属死名要清理）；`scripts/build-client.mjs` 的 externals 与宿主客户端基线一致。
3. **门禁**：typecheck + build + test + check:deps + check-meta + client shim 全绿；确认 `lib/` 产物与源码同步、构建模式（checkout / npm-devDeps）符合本机实际。
4. **profile 实测**：记录 profile 名 + 宿主版本 + 装配方式 + 结果（涉数据给前后数字）；装配遵守「工程红线 · profile 卫生」的热装配收敛要求。
5. **记录**：README 双语「兼容性」节更新目标版本；vault 开发文档追加「适配记录」小节（触发 / 改动表 / 契约核对结论 / 验证数据 / 遗留）。

> 契约面稳定时适配**不改码**，只动依赖声明与文档；某条契约变了才按上表定位对应模块，不整包重写。

## 工程红线（事故教训固化）

1. **单实例合约**：in-box 包（`@deepseek-ai/*`、cordis/vendor 系）只进 peerDependencies，严禁 dependencies；peer 范围带显式 prerelease 分支（当前 `@deepseek-ai/dsh-host-webserver`: `^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1`），且 **devDep pin 的版本必须落在 peer 范围内**（`check:deps` R3 自动校验）；遇「peer 装不上」查解析路径，禁止塞 dependencies 修复（hoist 双实例 → 模块级 Symbol 错位 → 全 tool 链崩溃）。
2. **vault 只读**：对 vaultRoot 零写入（不创建 / 不修改任何 vault 内文件）；观测数据与配置只在 `~/.dsh/nexus/`。
3. **迁移幂等**：SQLite schema 变更走 v{N+1} 顺序迁移，可重复执行；改名 / 搬迁类迁移仅在新缺失时执行，绝不覆盖已有数据。
4. **集中常量**：事件名 / 路由前缀 / API 路径集中定义，避免裸字符串拼写漂移失去编译期保护。
5. **profile 卫生**：装配变更只走 `dsh plugin add/remove` + `dsh --profile <name> --dump-config` 验证；禁手改 profile 的 package.json、禁在 profile 内手动 install。
   **热装配例外**（重启会中断会话时的本地调试）：只允许在 profile 的 `cordis.patch.yml` 用户层用 `insert` 挂本地路径（`patchReload: live` 保存即生效），且 (a) 不动 bundle 列表；(b) **重启前必须收敛**——删掉 patch 行、改走 `dsh plugin add`，否则 bundle 层与 patch 层同 `id` 双挂载（`webServer.register` 对重复 `(kind,path)` 直接抛错）；(c) 跨重启的正式装配一律走 bundle。
6. **敏感信息**：token / 密钥 / 不必要的本机绝对路径不进仓库；分析结论与验收记录回写 vault 文档，仓库侧保持代码与 README 如实。

## 验证纪律

- **本地门禁五件套**再提交：typecheck + build + test + `check:deps` + `check-meta`（含 client shim 断言），与 CI 同款。
- 端上行为（面板 / 路由 / 迁移 / 事件订阅）用注入器通道（`dev_build_plugin` / `dev_inject_plugin` / `dev_reload_package`）或 profile 实测，记录**环境四元组**：dsh 版本 + profile 名 + 装配方式（bundle / patch 热装配 / 注入器）+ 结果。
- 宿主升级后另核 `lib/` 构建模式与 `~/dsh-harness`（或 `$DSH_CHECKOUT`）可用性——checkout 缺失时走 npm-devDeps 模式，不要用「能构建」掩盖 checkout 失效。
- 涉统计口径的改动（归属 / 覆盖率 / 曲线基线）须给出前后对照数字。
