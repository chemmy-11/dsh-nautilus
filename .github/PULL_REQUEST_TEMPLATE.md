<!-- 标题格式：<type>(<scope>): <一句话改动>——与 squash 后的提交信息一致，保持 main 线性可读 -->

<!-- 目标分支：线内子任务 → 所在线（feat/nexus 插件线 / feat/ui UI 支线 / feat/nautilus Nautilus 主线）；UI 线验收节点收敛 → feat/nautilus；线 → main 的收敛 PR 直接对 main。跨线公共约定（AGENTS.md / CI / 模板 / docs 结构）先落一条线，再合并进其余线。 -->

## 背景与动机

<!-- 为什么做这个改动；上游依据在哪（vault 外功/DSH/ 对应规范或开发文档小节）；关联 issue：Closes #N / Refs #N -->

## 改动内容

-

## 验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过（npm-devDeps 模式，CI 同款）
- [ ] `npm test` 通过（涉 analysis/selfcheck/scan 纯函数时必须；未涉可划掉并说明）
- [ ] `npm run check:deps` + `npm run check:exports` + `node .github/scripts/check-meta.mjs` 通过（单实例合约 / prerelease 分支 / peer 覆盖 devDep pin / 命名空间插件无 default 导出 / bundle+client 双半 / files 清单）
- [ ] 改了 `.github/workflows/` 时本地跑过 `actionlint`（+ shellcheck）：CI 内自查救不了工作流本身解析失败（0 jobs 静默形态）
- [ ] 实弹验证：涉及面板 / 路由 / 迁移 / 事件订阅的改动，在注入器或 profile 环境实测并记录**环境四元组**（dsh 版本 + profile 名 + 装配方式 + 结果）
- [ ] 数据兼容：schema 变更带 v{N+1} 幂等迁移，旧库（`~/.dsh/nautilus/nautilus.db`）可无损升级；改名/搬迁类迁移只在新缺失时执行，绝不覆盖

## 自查（工程红线，详见 CONTRIBUTING）

- [ ] 单实例合约：in-box 包（`@deepseek-ai/*`、cordis/vendor 系）只在 peerDependencies，未进 dependencies；peer 范围带显式 prerelease 分支，且覆盖 devDep pin 的宿主版本（`check:deps` R3）
- [ ] 宿主适配（如涉及）：契约面逐项核对（session/event · webServer.register · tools.register · 客户端 slots / 虚拟模块名），README 兼容性节与 vault 适配记录已同步
- [ ] profile 装配：bundle 变更走 `dsh plugin add/remove`；若用过 patch 热装配，重启前已收敛（无同 `id` 双挂载）
- [ ] vault 只读：未对 vaultRoot 写入任何文件；观测数据仅在 `~/.dsh/nautilus/`
- [ ] 事件名 / 路由前缀 / 配置项走集中常量与 Config schema，无裸字符串漂移
- [ ] 无敏感信息（token / 密钥 / 不必要的本机绝对路径）
- [ ] 导出形态：函数形态插件只用命名导出（`name` / `inject` / `Config` / `apply`），**无 `export default`**；可选服务用 `ctx.get(name)`，不写 `ctx.<name>`（AGENTS.md §2）
- [ ] 测试打在真实路径上：涉插件装配 / 工具 / 路由的改动有经 Loader / 组合路径的验证（手动 `ctx.plugin(...)` 挂载不算），断言的是外部世界而非自我报告
- [ ] 客户端半区改动：已重建产物（`npm run build`）并在**既有 URL 刷新后**验收（不另起替代服务器）

## CI 与合并

- [ ] CI 全绿（typecheck + build + 元数据校验 + test）
- [ ] 合并方式 squash；PR 描述属实，README 功能描述与实现状态一致
