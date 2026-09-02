<!-- 标题格式：<type>(<scope>): <一句话改动>——与 squash 后的提交信息一致，保持 main 线性可读 -->

## 背景与动机

<!-- 为什么做这个改动；上游依据在哪（vault 外功/DSH/ 对应规范或开发文档小节）；关联 issue：Closes #N / Refs #N -->

## 改动内容

-

## 验证

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过（npm-devDeps 模式，CI 同款）
- [ ] `npm test` 通过（涉 analysis/selfcheck/scan 纯函数时必须；未涉可划掉并说明）
- [ ] 实弹验证：涉及面板 / 路由 / 迁移 / 事件订阅的改动，在注入器或 profile 环境实测并记录（环境：profile 名 + dsh 版本）
- [ ] 数据兼容：schema 变更带 v{N+1} 幂等迁移，旧库（`~/.dsh/nexus/nexus.db`）可无损升级；改名/搬迁类迁移只在新缺失时执行，绝不覆盖

## 自查（工程红线，详见 CONTRIBUTING）

- [ ] 单实例合约：in-box 包（`@deepseek-ai/*`、cordis/vendor 系）只在 peerDependencies，未进 dependencies；peer 范围带显式 prerelease 分支
- [ ] vault 只读：未对 vaultRoot 写入任何文件；观测数据仅在 `~/.dsh/nexus/`
- [ ] 事件名 / 路由前缀 / 配置项走集中常量与 Config schema，无裸字符串漂移
- [ ] 无敏感信息（token / 密钥 / 不必要的本机绝对路径）

## CI 与合并

- [ ] CI 全绿（typecheck + build + 元数据校验 + test）
- [ ] 合并方式 squash；PR 描述属实，README 功能描述与实现状态一致
