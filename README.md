# dsh-nexus

Vault 观测插件（`@dsh-external/dsh-nexus`）——为 DeepSeek Harness（`dsh`）提供 Obsidian vault 的**元数据快照与编辑活动统计**：文件清单（路径/修改时间/大小/字数）、编辑操作计数（`fs.watch` 实时感知 + 去抖合并）、观测面板（今日/本周/活跃 Top/最近编辑流）。

`vaultRoot` 指向任意 Obsidian vault 即可观测（不限于特定库）；统计与快照存插件私有目录（`~/.dsh/nexus/`），**vault 本体零写入**（只读扫描，不创建/修改任何 vault 内文件）。

## 功能（M1）

- **全量扫描**：启动 + 周期校准（默认 6h）——路径/修改时间/大小/字数（去空白字符，排除 frontmatter）；
- **编辑监听**：`fs.watch`（recursive）实时感知 vault 变更（Obsidian 关闭时同样可采），500ms 去抖合并，kind 区分 `created`/`modified`/`deleted`；重复事件幂等（`session_key`），热重载/重启不重复记账；
- **观测面板**：对话页「Vault 观测」标签——文件总数/总字数、今日与本周编辑次数/修改文件数/新增文件、活跃文件 Top 5、最近编辑流；
- **排除规则**：默认排除 `dsh-docs/` 等（`exclude` 可调），统计与展示均不涉及被排除目录；
- **只读姿态**：对 vault 只读；观测数据（SQLite）与面板配置全部在私有无目录（`~/.dsh/nexus/`）。

## 安装

```sh
dsh plugin --profile <name> add github:chemmy-11/dsh-nexus
```

git 形式安装会在本机构建（`prepare` 脚本需要 dsh 源码 checkout：自动探测 `$DSH_CHECKOUT` 或 `~/dsh-harness`）；pnpm ≥10 首次安装需在 profile 的 `pnpm-workspace.yaml` 按提示放行 `allowBuilds`。

配置示例（profile 的 `cordis.patch.yml` 覆盖行，整行替换；`vaultRoot` 必配）：

```yaml
- id: nexus
  config:
    vaultRoot: 'C:/path/to/your/obsidian/vault'
    exclude: [dsh-docs]
    watchEnabled: true
    pollIntervalMs: 21600000
    debounceMs: 500
```

## 面板数据

`GET /api/nexus/state`（同源访问）返回：`totals`（文件数/字数）、`today`/`week`（编辑次数/修改文件数/新增文件/活跃 Top）、`recent`（最近 20 条编辑流）。

## 构建

```sh
DSH_CHECKOUT=<dsh-checkout> bash scripts/build.sh   # = node scripts/prepare.mjs（host tsc + client esbuild）
```

构建链为纯 Node 实现（`scripts/prepare.mjs` + `scripts/build-client.mjs`），不依赖 bash 环境差异。

**两种构建模式**（`scripts/prepare.mjs` 自动选择）：
- **checkout 模式**（本地开发）：探测到 `$DSH_CHECKOUT` / `~/dsh-harness` → 从 checkout junction 链接 `cordis`/`schemastery`/`dsh-host-webserver` 并复用其 tsc/esbuild；
- **npm-devDeps 模式**（CI / 无 checkout）：`npm install` 装好 devDependencies（含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`schemastery`、`typescript`、`esbuild`）后直接用本地依赖构建，无需 dsh 源码。

## CI

`.github/workflows/ci.yml` 在每次 push/PR 上跑 `typecheck` + `build`（npm-devDeps 模式）+ 元数据校验（bundle patch / client 双半 / files 清单）；`.github/workflows/release.yml` 在 `v*` tag 上自动构建 tgz 并创建 GitHub Release。

## 设计原则

- **独立可装**：仅依赖官方 `cordis`/`schemastery`/`dsh-host-webserver`，不与任何其它插件耦合；
- **观测即留痕**：编辑事件从部署起前向积累（SQLite 持久化，重启/重载不丢不重）；
- **边界意识**：只读 vault、数据私有化（不进 vault、不混入其它数据源）。

## 安全说明

安装插件等于在机器上运行第三方代码，权限与运行者相同。安装前请先阅读源码；本插件对目标 vault 只读，不执行写入。
