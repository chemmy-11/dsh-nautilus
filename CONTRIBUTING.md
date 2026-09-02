# 开发规范（CONTRIBUTING）

> 上游文档在雪谷 vault `外功/DSH/`（PROJECT-MOC → 规范 / M1–M4 开发文档 / 首轮分析报告）；本文件只固化**仓库工程约定**，PR 模板自查项与此同源。

## 分支与提交

- `main` 为主干，保持线性；小步本地提交，**push 时机按用户明确指令**（本地领先 origin 是常态）。
- 提交信息：`<type>(<scope>): <中文描述>——<为什么/细节>`；type ∈ feat / fix / refactor / docs / test / ci / chore / build；scope 用里程碑子项（如 `M4-A`、`N1-x`）或模块名。
- 一次提交一个语义单元；无关改动不混提。

## PR 与合并

- 有风险 / 多步改动走功能分支 + PR，描述按模板（背景 / 改动 / 验证 / 自查）。
- 合并一律 **squash**，提交信息即 PR 标题；issue 关联用 `Closes #N` / `Refs #N`。
- issue 先行：里程碑子项、缺陷、技术债开 issue 记账，完成在 issue 下留结论后关闭。

## CI 门禁（`ci.yml`，push / PR 全量）

1. `npm run typecheck`（tsc --noEmit）；
2. `npm run build`（npm-devDeps 模式，无 DSH checkout 也可构建）；
3. 元数据校验：bundle patch / client 双半 / files 清单 / client shim 断言；
4. `npm test`（纯函数回归：analysis / selfcheck / scan）。

## 发布（`release.yml`）

- `v*` tag 触发：构建 tgz → GitHub Release；发布前核对 version 与 tag 一致、README 功能描述与实现状态相符（不得含"设计阶段 / 未发布"之类不实声明）。

## 工程红线（事故教训固化）

1. **单实例合约**：in-box 包（`@deepseek-ai/*`、cordis/vendor 系）只进 peerDependencies，严禁 dependencies；peer 范围带显式 prerelease 分支（如 `^0.1.1-rc.2 || ^0.1.2-alpha.2`）；遇「peer 装不上」查解析路径，禁止塞 dependencies 修复（hoist 双实例 → 模块级 Symbol 错位 → 全 tool 链崩溃）。
2. **vault 只读**：对 vaultRoot 零写入（不创建 / 不修改任何 vault 内文件）；观测数据与配置只在 `~/.dsh/nexus/`。
3. **迁移幂等**：SQLite schema 变更走 v{N+1} 顺序迁移，可重复执行；改名 / 搬迁类迁移仅在新缺失时执行，绝不覆盖已有数据。
4. **集中常量**：事件名 / 路由前缀 / API 路径集中定义，避免裸字符串拼写漂移失去编译期保护。
5. **profile 卫生**：装配变更只走 `dsh plugin add/remove` + dump-config 验证，禁手改 profile 的 package.json + 手动 install。
6. **敏感信息**：token / 密钥 / 不必要的本机绝对路径不进仓库；分析结论与验收记录回写 vault 文档，仓库侧保持代码与 README 如实。

## 验证纪律

- 代码改动三件套本地全绿再提交：typecheck + build + test。
- 端上行为（面板 / 路由 / 迁移 / 事件订阅）用注入器通道（`dev_build_plugin` / `dev_inject_plugin` / `dev_reload_package`）或 profile 实测，记录环境（profile 名 + dsh 版本）与结果。
- 涉统计口径的改动（归属桶 / 覆盖率 / 曲线基线）须给出前后对照数字。
