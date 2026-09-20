# AGENTS.md — Nautilus（dsh-nautilus）插件开发守则

> 本文件由 DeepSeek Harness 每次会话自动加载（渲染预算 64 KiB）。它是**常驻指令**：只写「做什么 / 不做什么 / 去哪查」，完整论证留在归属地，不在此复述。
>
> **来源**：本地 `community-plugin-developer` 技能（官方 bundle 标准 + 社区索引契约）· 雪谷 vault 根 `dsh-docs/`（宿主官方文档快照，含 postmortem 0001–0003）· 本仓库 `CONTRIBUTING.md` 与会话教训。
>
> **归属地**：`CONTRIBUTING.md`（工程约定与红线，**本仓库权威**）· `docs/1-planning/`（决策）· `docs/2-dev/`（阶段开发文档 + 证据归档）· 雪谷 vault `外功/DSH/`（M1–M5 开发文档、分析读数、PROJECT-MOC）· vault 根 `dsh-docs/`（宿主契约引用以它为准）。
>
> **冲突优先级**：与本文件冲突 → 以 `CONTRIBUTING.md` 为准并回写本文件；与 vault 开发文档冲突 → 以 vault 为准（决策在上游）。

## 0. 项目是什么

- **观测插件**（`@dsh-external/dsh-nautilus`，bundle 形态）：vault 元数据快照 + 编辑统计 + 逐轮会话遥测 + L 场读数面板。扩展方向见 `docs/1-planning/`（三层指标 pulse / infer / nexus + era 因果上下文 + Agentic Ops 工作台）。
- 定位红线：**观测，不干预**。不改宿主源码、不改宿主行为、不写用户数据；归因结论人工主导，AI 只辅助检索与编码。

## 1. 五条不可违（违反即回滚，不看进度）

1. **单实例合约**：in-box 包（`@deepseek-ai/*`）只进 `peerDependencies`，严禁 `dependencies`；peer 范围必须带**显式 prerelease 分支**且**覆盖 devDep 的 pin**；非 scoped 的 `cordis`/`schemastery` 不在 dsh 安装闭包内，一律用 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`。`npm run check:deps` 自动校验（R1/R2/R3）。
2. **vault 只读**：对 `vaultRoot` 零写入（不创建、不修改任何 vault 内文件）；观测数据与配置只在 `~/.dsh/nautilus/`。
3. **迁移幂等**：SQLite schema 变更走 v{N+1} 顺序迁移，可重复执行；改名/搬迁类迁移仅在新缺失时执行，**绝不覆盖既有数据**。
4. **集中常量**：事件名 / 路由前缀 / API 路径集中定义（范例：`src/index.ts` 的 `SESSION_EVENT`、`src/routes.ts` 的 `API_PREFIX`），禁止裸字符串散落——拼写漂移没有编译期保护。
5. **profile 卫生**：装配只走 `dsh plugin add/remove` + `dsh --profile <name> --dump-config` 验证；禁手改 profile 的 `package.json`、禁在 profile 内手动 install。热装配只在重启会中断会话时允许，且必须**重启前收敛**（patch 层与 bundle 层同 `id` 会双挂载，`webServer.register` 对重复 `(kind,path)` 直接抛错）。

## 2. 插件形态与宿主契约

- **形态**：`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`（插入插件行）+ `dsh.client`（browser 半区）+ `files` 白名单；host 半区 `src/index.ts`、browser 半区 `src/client/`。
- **函数形态插件必须用命名导出**（`export const name` / `export const inject` / `export const Config` / `export function apply`）——**绝不加 `export default apply`**：Loader 的 `unwrapExports` 优先取 `.default`，会把同级的 `inject`/`name`/`Config` 一起丢掉，症状是加载即抛 `cannot get property "X" without inject`（postmortem 0001 根因 #1）。对象形态与类形态才用 `export default`。
- `inject` 列全**必需**服务；**可选服务一律用 `ctx.get(name)`，不要写 `ctx.<name>`**——未注入的读取会走 shadow 解析并抛错（0001 根因 #2）。服务消失时插件会被自动卸载、恢复后重载，不要自己轮询就绪。
- **消费声明的 seam，不 import 宿主实现包**：shell / fs / subprocess / web 等能力走 `ctx.*` 服务（例如起子进程走 `ctx.subprocess`，而不是自己 `node:child_process`）——这是「零侵扰 + 不锁死宿主实现」的落点，也是未来 pulse 采集（nvidia-smi 轮询）要走的路。子进程结果里 `timedOut` / `signal` / `exitCode` **各自独立成字段、不互相嵌套**——嵌套会把「超时」与「被信号杀掉」混成一件事。
- **`!!js` 只在插件 `config` 内求值**：`disabled:` 等 Loader 条目元数据不求值，写表达式对象恒为 truthy（postmortem 0002）。条件式组态用独立 overlay 文件，不用 `disabled: !!js`。
- **配置**：导出 `Config` 接口 + 同名 Schemastery schema，默认值写进 schema；**不要导出普通对象当 Config**（不满足 Standard Schema）。凡不同部署可能取不同值的参数都必须是配置字段——检验标准：能否只改 `cordis.yml` 而不改代码。让非法配置在加载时响亮失败。
- **生命周期**：`ctx.on` / `ctx.tools.register` / `ctx.webServer.register` / `ctx.effect` 的注册随卸载自动撤销；需要手动清理的资源放进 `ctx.effect(() => cleanup)`。**有顺序依赖的清理必须收进同一个 `ctx.effect` 的处置器**——多个异步处置器并发执行，不保证逐个完成。分发器（事件/回调总线）内部要 `try/catch` 包住每个回调，不让单个监听器异常饿死后续监听器；停止时要**停稳**（先摘监听器与通知注册，再等子进程真正退出）。
- **交付通道**：`lib/` 不入库，构建入口只有 `scripts/prepare.mjs`，挂两个钩子——`prepack`（`npm run build` / `npm pack` / git 安装都走它）+ **条件 `prepare`**（`--if-dependency`：本地检出跳过、被安装的副本构建；判据 = 包目录下有无 `.git`）。**实测（pnpm 11.24）**：只声明 `prepack` 时，未放行 `allowBuilds` 的 git 安装会**静默跳过构建**、装出无 `lib/` 的坏包；声明 `prepare` 后 pnpm 才报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 并给出确切键。消费侧必须在 profile 的 `pnpm-workspace.yaml` 放行该键（等同授权安装时执行构建代码）并**锁定 commit SHA**。**动构建入口或产物路径时三个入口一起核**：`build` / `prepack` / `prepare`。

## 3. 客户端半区（browser half）

- **两半同包**：host 在 `src/`、浏览器在 `src/client/`，以 `./client` 子路径导出并用 `dsh.client` 声明；产物必须是 loader 的 **lazy-CJS factory**（本仓库由 `scripts/build-client.mjs` 产出，`window.__ModuleLoader__.load`）。
- **单 Loader 条目（硬契约）**：带 `dsh.client` 的包**整个包只允许一个 Loader 条目**——bundle patch 里插两行（如 `@dsh-external/dsh-nautilus` + `.../pulse`）或 profile patch 再手动 insert 一次，会让 client-modules 组合期抛 `resolves from multiple active Loader sources`，后果是 **`dsh web` 直接启动失败**。多能力用**单条目 + 子插件挂载**（`ctx.plugin(pulse, config.pulse)`），子配置进父插件 `Config` 的子节；`check-meta` 守条目数，测试守子插件路由。
- 客户端插件就是普通 Cordis 插件：`Context` 来自 `@deepseek-ai/cordis`（`@deepseek-ai/dsh-client-runtime` 在 0.1.5 已移除，属死名）；`ctx.slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 提供，slot key 类型由归属 UI 包增强声明，`slots.inject(key)` + `slots.register(def, Component)`。
- **注册选项随槽位 kind 变**：`list` 槽（`conversation.view` / `sidebar.panellist`）用 `id`，`keyed` 槽（`main`）用 **`key`**；给错字段抛 `keyed slot main requires options.key`，且**整批浏览器半区插件集挂载失败**（旁证：ui-conversation 注册主区为 `{ name: 'main', key: 'conversation' }`）。全局面板 = `sidebar.panellist` 图标行 + `main` 面板，两值同为 `MainPanelId`。
- `dsh.client.inject` 是**信息性**包名边（列 UI 提供方包名）；`dsh.client.external` 才是**硬模块边**——非基线模块的同步 `require` 不列进去就是运行时模块缺失。
- **只允许 type-only 跨插件导入**（bundle 纯净度门禁拒绝跨插件值导入）；运行时协作一律走 cordis 服务。
- 呈现约定沿用：样式经组件内 `<style>` 一次性注入（class 前缀 `nt-`）、SVG 自绘、主题令牌化（`--nt-*` 层，默认值映射 `--dsw-alias-*`，映射表见 `docs/2-dev/nautilus-dev-02-ui-workbench.md` §2）、零新依赖。

## 4. 工具、设置与卡片（做 L1/L2 与 pulse 采集时看）

- **工具**：`ctx.tools.register`（本包按 defineTool 返回形状手写 duck-type 子集，**零第三方 import**——`dsh-tools` 未装配，运行时 import 会崩）。显式的对象节点必须写 `additionalProperties`；`execute` 前参数已按 schema 校验，不要重复校验成另一套口径。
- `args` 只读、身份字段不可变；**只返回 `output.schema` 推导的规范 JSON 值**，异常与非法值都收敛为 `isError`；遵守 `exec.signal`。需要异步补充上下文时用 `exec.agent.inject` 并 `try/catch` 已 dispose 的 agent。
- **长任务用 `ctx.jobs.start`**，发布任务 id 后改用任务自有的取消信号，不再挂 `exec.signal`。
- **不内建部署策略**：审批 / 重试 / 限流这类策略交给宿主的工具钩子（`tools/pre-execute`、`ctx.tools.guard()`、`tools/post-execute`、`tools/result`），插件只负责能力本身。结果期的事实（耗时、路径、计数）放 `output.presentationMeta`，不要塞进返回值。
- **卡片 / 渲染器必须是 `args` + result 的纯函数**：无 I/O、不读会话状态、无时钟或随机数（否则回放不可复现）。
- **设置卡**：host 半用 `installSettingsSection` 注册命名空间，browser 半用 `ctx.settingsScope` 读写，卡片以自身命名空间为键注册进 `settings.plugin.item`；**命名空间是配对键——只挑一次，两半侧都写出来**。schema 表达不了的约束放 `validate`（写入即拒，而不是下次使用才失败）；机密字段标 `role('secret')`；需重启才生效的标 `applies: 'restart'`。
- **会话节点（发布可回放事件族时）**：同一 Node 的每条事件都携带稳定业务 id；delta 必须带 id 且按 `seq` 可确定性重建 State（不依赖实时内存）；`match(event)` 只是身份提取器、只收到当前事件；append 热路径**不得**遍历事件窗口、Context 或已渲染节点；已发布 Node 的 `context.key` 保持稳定，隐藏用 `visibility: 'hidden'` 而不是 `null`。

## 5. 观测数据层

- **存储**：`node:sqlite`（`DatabaseSync`，零依赖），库在 `~/.dsh/nautilus/nautilus.db`，schema 版本记在 `PRAGMA user_version`。
- **采集**：官方 `session/event` 直采（零宿主源码修改）；事件信封 `{type, seq, time, data}`；逐轮用量 `usage.{inputTokens,outputTokens,cacheReadTokens}`。
- **已实测可得**（Phase 0，见 `docs/2-dev/`）：TTFT = `assistant/message.data.stream` 首块时间 − `step/start` 时间（宿主 GUI 同式）；model/endpoint = `assistant/message.message.source.{provider,model}`（逐调用）。新增指标先查这两处，别急着自己打点。
- **不得阻塞主循环**：全量扫描 / 分析 / P 计算走后台串行队列 + 增量水位（`file_size` 之类），一次一个会话，处理完释放。

## 6. 门禁、测试与提交

- 提交前本地**六件套**（与 CI 同款）：`npm run typecheck` · `npm run build` · `npm test` · `npm run check:deps` · `npm run check:exports` · 元数据校验（bundle patch / client 双半 / `files` 清单 / client shim 断言）。
- **测试红线**：必须有**经真实 Loader / 组合路径**的测试——手动 `ctx.plugin(...)` 挂载绕过的正是 postmortem 0001 崩掉的那条路径（178 个单测全绿仍线上崩溃：行覆盖必要非充分）。无 `inject` 的模块加断言「模块上没有默认导出」并做一次 `unwrapExports` 往返；断言**外部世界**而不是自我报告；测试从源码解析，不落构建后的 `lib/`。
- 提交信息：`<type>(<scope>): <中文描述>——<为什么/细节>`；scope 用里程碑子项（`M4-A` / `M5.1` / `N1-x`）或模块名；**宿主适配类必须写明目标宿主版本**（如 `dsh 0.1.5-rc.1`）。
- issue 先行、PR 一律 squash、**push 时机按用户明确指令**（本地领先 origin 是常态）。
- 宿主升级按 `CONTRIBUTING.md`「宿主版本适配」五步：依赖面 → 契约面逐项核对 → 门禁 → profile 实测 → 记录。**先确认宿主实际版本，不凭 npm dist-tag 推断**；契约没变就**不改码**。

## 7. 验收与证据

- **「跑通即归档」**：每个 Phase 产出《证据归档》（执行命令 / 预期输出 / 实际输出 / 观察结论），落 `docs/2-dev/evidence-<phase>-<日期>.md`。
- 端上验收记录**环境四元组**：dsh 版本 + profile 名 + 装配方式（bundle / patch 热装配 / 注入器）+ 结果；**涉数据必须给前后数字**。
- **GUI 类验收红线**（postmortem 0003）：HTTP 200 ≠ 应用就绪；必须指名确切 origin、在**既有页面刷新后**从外部观察；不要另起替代服务器；长时进程用受管任务生命周期，不用 shell `&` 绕过。改客户端半区后必须重建产物（本仓库 `npm run build`）并在**既有 URL 刷新后**验收；`dsh web --dev` 只挂 HMR 接收端，**不会**替你重建插件 bundle。
- 涉统计口径（归属 / 覆盖率 / 曲线基线）改动必须给前后对照；**诚实边界随读数一起引用**（绝对值高估、样本口径、混杂来源）。

## 8. 社区插件索引（登记进 dsh-web 时）

- **只索引、不内嵌**：索引仓库只登记元数据（`community.json`），第三方实现永远留在本仓库；生成文件禁手改，一律由索引脚本重生成并通过 `--check` 门禁。
- 条目字段契约：`id` 唯一小写 kebab；`repo` 必须是 **path-safe 的 `https://` URL**（会被拼进安装命令，空格与 shell 元字符直接拒绝）；`category` 必须在枚举内；`npm` 字段**实际发布后才填**；中英描述成对；无 emoji。
- PR 附设置页截图；条目由维护者审核。

## 9. 会话工作约定

- **动手前**：读 `CONTRIBUTING.md` + 当前里程碑开发文档（vault `外功/DSH/雪谷观测插件开发文档-M*.md`）+ `docs/2-dev/` 当前 Phase 文档；不确定归属就问，不猜。
- **一次只推进一个 Phase / 一个里程碑子项**；选型与口径变更出 2–3 方案对比，由守谷人裁决，**不自行拍板**。
- 归因与因果措辞分级：`api` 时代只用「对照」（弱因果），`local` 时代才谈「归因」；不把相关当因果。
- 每轮回答结束前调用 `record_turn_selfcheck`（承雪谷 vault `AGENTS.md` 工作约定第 6 条）。
- token / 密钥 / 不必要的本机绝对路径不进仓库；分析结论回写 vault，仓库侧保持代码与 README 如实。

## 10. 该查哪（宿主官方文档地图）

| 要做什么 | 查哪（vault 根 `dsh-docs/`，除非另注） |
|---|---|
| 第一个插件 / apply·inject·Config 契约 | `user/develop/basic/index.zh.md` |
| 配置 schema / 默认值 / HMR 生效 | `user/develop/basic/config.zh.md` |
| 工具定义全规范（canonical/render 分离、presentCall/presentResult、jobs） | `cookbook/adding-a-tool.zh.md` · `user/develop/basic/tool.zh.md` |
| 打包 / profile 装配 / 层序 / git 安装三坑 | `user/develop/basic/publish.zh.md` |
| 生命周期 / 清理顺序 / dispose | `user/develop/framework/index.zh.md` |
| 事件订阅姿势 | `user/develop/framework/events.zh.md` · `event-producer-consumer.zh.md` |
| 服务与缝隙（谁能被替换、三角色） | `user/develop/framework/service.zh.md` · `capability-seams.zh.md` |
| 设置卡（host namespace + client 卡片配对） | `cookbook/adding-a-settings-card.zh.md` |
| 会话节点（可回放事件族） | `cookbook/adding-a-conversation-node.zh.md` |
| 持久化事件全目录（含 surface 标记） | `persistence-catalog.zh.md` |
| 不变式伴生插件 | `subsystems/invariants.zh.md` |
| 防御性写法（竞态 / 取消 / 所有权） | `defensive-patterns.zh.md` |
| 测试与质量门 / 贡献者工作流 | `testing.zh.md` · `development.zh.md` |
| 事故复盘（三条红线） | `postmortem/0001…0003` |
| 全量导航 | vault `外功/DSH/PROJECT-MOC.md` |
