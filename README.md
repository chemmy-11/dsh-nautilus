# dsh-nautilus

**简体中文** | [English](README.en.md)

## 简介

**Nautilus 是一个「只看不改」的会话观测插件**：挂在 DeepSeek Harness（下称 dsh）上，把每一轮对话的读数
（token / 缓存 / 耗时 / tps）连同质量判断记成可回看的数字与台账，并集中呈现在一个叫 **「Nautilus 工作台」** 的面板里。

- **它解决什么问题**：长对话里「哪几轮真正往前走了、代价是多少」平时只留模糊印象。这个插件把它变成**可复查的记录**——
  逐轮读数、模型自评、你的人工判读并排放在同一行，还能回头给历史上的会话补打分。
- **它不做什么**：**不改宿主源码、不改宿主行为、不写你的数据**；**不读也不写任何 Obsidian vault**。
  观测数据只落在你自己的 `~/.dsh/nautilus/`（SQLite）。定位是**观测，不干预**——结论由人下，插件只提供证据。

## 安装

> **装完必须重启宿主**：桌面端（dsh-desktop）**没有热更新**，改完不重启就等于没改（实测事实，见
> [桌面宿主适配](docs/2-dev/nautilus-dev-07-desktop-host.md)）。

### 方式 A：web profile（`dsh web`）

```sh
# git 形式：装到 profile 目录（推荐用于长期使用）
dsh plugin --profile <profile-name> add github:chemmy-11/dsh-nautilus

# 本地检出形式：直接指向本仓库（推荐用于开发）
cd <本仓库>
npm run build                                        # link: 之前必须先构建
dsh plugin --profile <profile-name> add link:<本仓库绝对路径>
```

**git 装配**：本仓库不提交构建产物 `lib/`，安装时会**就地构建**（`prepare` / `prepack` → `scripts/prepare.mjs`）。
pnpm ≥10 默认**拒绝执行依赖的构建脚本**，所以必须在 profile 的 `pnpm-workspace.yaml` 里放行：

```yaml
allowBuilds:
  '@dsh-external/dsh-nautilus': true
```

- **为什么必须放行**：放行 = **授权这个依赖在安装时执行构建代码**（等同信任本仓库的构建脚本）；
  不放行的后果不是报错，而是**静默装出一个没有 `lib/` 的坏包**（pnpm 11.24 实测：不报错、不警告，症状是插件根本不出现）。
- **生产装配请锁定 commit SHA**：`github:chemmy-11/dsh-nautilus#<sha>`。

**`link:` 装配**：profile 直接指向本仓库目录，改完代码重新 `npm run build` 即可生效（无需重新安装）。
同样因为产物不入库，**`link:` 之前必须先 `npm run build`**，否则装到的是没有产物的空壳。

### 方式 B：桌面端（dsh-desktop）

桌面宿主用 **`link:`** 装配本仓库：

```sh
cd <本仓库>
npm run build
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

- **profile 由 Electron 独占管理**：`dsh --profile desktop --dump-config` 这类 CLI 验证**会被拒**，
  所以「桌面装配是否生效」不能用 CLI 证明——只能在应用内观察。
- **装完必须回读 profile 的 `dsh.profile.bundles`**：组合器**只**读这个列表，不在列表里的依赖即使装好了也不会挂载
  （症状是插件整个缺失：路由 401、工具不存在、面板不出现）。
  `dsh plugin add` 会写进去；任何重装/清理之后的第一次自检就是回读它。
- **改动需重启应用生效**：客户端半区由 `lib/client.js` 在应用启动时加载，`npm run build` 只更新磁盘上的产物，
  **不触达已在运行的进程**。顺序恒定为：**改码 → `npm run build` → 重启应用 → 在既有页面刷新后观察**。
- 请求链路与实测头形（页面源 `dsh-app://app`、`/api/*` 由主进程代理转发）见
  [docs/2-dev/nautilus-dev-07-desktop-host.md](docs/2-dev/nautilus-dev-07-desktop-host.md)。

### 装完自检

**重启宿主后，侧栏应出现「Nautilus 工作台」图标行**，点开即工作台（默认落在「总览」）。
看不到 → 见 [FAQ](#faq)（多数是没重启，或 git 装配漏了 `allowBuilds`）。

## 快速开始

第一次打开工作台：顶部是一排视图按钮，右上角有刷新与「返回会话」。

| 视图 | 一句话 |
|---|---|
| **总览** | 会话读数的汇总与逐会话列表（点开有逐轮抽屉）：token、缓存命中、耗时、tps。 |
| **对齐** | 「对齐 1–5」人工判读与模型自评的**双路台账**（同一轮并列，Δ = 自评 − 人工）+ 四条边界的分布 + 样本一致性。 |
| **会话** | 往期会话清单（工作区名 · 会话名 / 轮次数 / 读数合计 / 人工覆盖）；点开逐轮明细，**每轮可以直接打分**。 |
| **告警** | OS / GPU 层红线告警：越线检测、证据冻结、报告与人工裁决。 |
| **曲线** | 会话读数曲线：时间档位、指标切换、轮次轴、全屏、悬停下钻。 |
| **报告** | 可重复的分析报告：形态分类、特征时间 τ_e、分桶对照。 |

### 给某一轮打分

1. 打开 **会话** 视图 → 点某一行的会话名，展开它的逐轮明细；
2. 每轮最右一列是打分入口，点 **「对齐」** 展开：选 **1–5** 档，或选 **N/A**；
3. 选 **4 或 5 必须附引文**（你引用 / 追问 / 改道于哪一句）——这是硬性要求，不填提交不了；
4. 点「提交」。

**几个词的意思**：

- **对齐 1–5**：这一轮在「接 → 顺 → 推」的校准回路上推进了对方真正问题的程度——
  `1` 没接住（绕开对方状态、答非所问）· `2` 接住了但没延展（正确、无增量）· `3` 接+顺一层（在已有表达上点亮一处）·
  `4` 顺+推（指出他还没命名的结构或方向）· `5` 推到了改变下一步动作（他改道 / 引用 / 追问，可回查）。
- **N/A**：这一轮**没有可判断的对象**（纯操作性指令轮）→ 豁免，不进分母。
- **四条边界**（与档位正交，越界不改变档位但要记录）：**不替代 · 不占有 · 不强迫 · 不投射**。
- **重新提交即覆盖**：同一轮的判读是**覆盖**语义（服务端 upsert），**不会**追加一条新记录；
  已标注的轮次展开打分件时会**预填当前分**，改哪档点哪档再提交即可。
- **原文缺失的轮次不能打分**：入口会**禁用**并写明原因（该轮原文不在库里，服务端会拒绝写入）——不给假按钮。

## 你能做什么

- **逐轮遥测**：每轮的 token（输入 / 输出 / 缓存命中）、耗时、tps，自动采集，无需手动记录；
- **自评**：模型按「对齐 1–5 + 四条边界」给自己的判断（通过 dsh 工具或 HTTP 通道）；
- **人工判读与一致性**：你给人自评打分（或独立打你自己的分），工作台把两路并排、算差值、给覆盖率与一致性指标；
- **往期回顾**：会话视图列出历史会话，展开即可对**之前的轮次**补打分或改分；
- **OS / GPU 红线告警**：按规则检测越线（含滞回与冷却），冻结证据快照，可选三段式 LLM 报告，并在工作台里人工裁决；
- **可重复分析**：形态分类、特征时间、分桶对照——同一份数据可以反复跑出同一份结论。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里。**所有字段都有默认值，通常不需要配置**：

```yaml
- id: nautilus
  config:
    dataDir: ''            # 空 = $DSH_HOME/nautilus（默认）；多端共享同一份数据时指向同一目录
    readings:
      enabled: true        # 是否采集会话读数
      historyDays: 30      # 读数保留窗口
    selfcheck:
      ingest:
        enabled: false     # 外部 harness 自评通道，默认关闭
        token: ''          # 开启时必须填非空 token（空 token + enabled=true 会在加载时报错）
        maxBodyBytes: 8192
    pulse:
      enabled: true        # OS/GPU 采集子插件
      intervalMs: 5000
      enableCounters: true
      enableGpu: true
      alertEnabled: true   # 红线告警
```

> **配置键注意**：读数采集项自 AL.4g 起叫 **`readings`**（旧键 `lField` 已改名、**不再被读取**）；
> 若你的配置里还写着 `lField`，请改名，否则该项会**静默回落到默认值**。
>
> pulse 子插件还有更多字段（采样间隔、保留期、告警规则 `alertRules`、`alertsDir` 等，均有默认值），
> 见 [docs/2-dev/nautilus-dev-03-os-layer.md](docs/2-dev/nautilus-dev-03-os-layer.md) 与
> [docs/2-dev/nautilus-dev-06-os-alerting.md](docs/2-dev/nautilus-dev-06-os-alerting.md)。

## 数据与隐私

- **数据只落在你自己的机器上**：`~/.dsh/nautilus/nautilus.db`（SQLite；pulse 子插件同库不同表）。
  `dataDir` 可改为别的目录（多端共享同一份数据时用）。
- **不读也不写 vault**：本插件与 Obsidian vault 零耦合（vault 观测腿已于 2026-09-27 下线）。
- **不改宿主**：不修改宿主源码、不改变宿主行为；数据采集走官方 `session/event` 事件，零侵入。
- **自评 ingest 默认关闭**，且开启必须配 `token`（请求头 `x-nautilus-selfcheck-token`）；没开通道时该路由恒 403。
- **本地 API 有同源门**：所有 `/api/nautilus/*` 路由只接受本机同源请求，跨站请求一律 403（拒绝时会回显所见标记，
  便于定位）——细节见 [桌面宿主适配](docs/2-dev/nautilus-dev-07-desktop-host.md)。

## FAQ

**Q：为什么改完代码要重启宿主？**
A：桌面端**没有热更新**：客户端半区由 `lib/client.js` 在启动时加载，`npm run build` 只更新磁盘产物。
顺序永远是 **改码 → `npm run build` → 重启应用 → 刷新既有页面**。

**Q：桌面端面板空白 / 请求一直 403？**
A：这是已修的问题：本插件的同源门曾把 `sec-fetch-mode` 误当作跨站信号，导致桌面端（`dsh-app://app` 页面源 +
主进程代理转发）的请求恒 403。**升级到最新版本即可**；成因与判据见
[docs/2-dev/nautilus-dev-07-desktop-host.md](docs/2-dev/nautilus-dev-07-desktop-host.md)。

**Q：桌面端请求返回 401（不是 403）？**
A：这是另一条路径，两件事别混：
（1）**0.1.x**：同源门误判 → **403**（上面那条；响应体回显 `seen` 所见标记）；
（2）**0.2.0-rc.1**：宿主**兼容门**按 peer 范围判定本插件不可用 → **整包拒装**（`insert: nautilus` 不进组合），
症状是**本该已注册的 `/api/nautilus/*` 路径返回 401 裸文本 `unauthorized`**，且工具与采集一起消失。
注意：**未知路径**（如 `/api/nautilus/nope`，乃至别的插件的 `/api/pet/nope`）的 401 只是连接层 `/api` 前缀兜底，
**任何插件都一样**，**不能**用它判断本插件是否注册。
**修法 = 升级本插件**（peer 已覆盖 `0.2.0-rc.1`）；判据与证据见
[docs/2-dev/nautilus-dev-07-desktop-host.md](docs/2-dev/nautilus-dev-07-desktop-host.md)。

**Q：为什么历史会话的工作区显示「未知工作区」？**
A：工作区归属**从 v10 才开始采集**，且**不回填历史数据**（forward-only，避免用今天的归属去改写过去的记录）。
所以早期会话显示「未知工作区」是设计结果，不是缺陷。

**Q：「会话名」是怎么来的？是宿主的真名字吗？**
A：**不是真名，是派生名**：取该会话**第一条不以 `<` 开头且去空白非空的提问**的首行前 24 个字；
找不到就退回**会话 id 的末 8 位**。因为真库里大量提问以 `<system-reminder>` 之类的块开头，只好这么取——
所以列表里的名字只用于**辨认**，不是权威标题。

**Q：为什么两个地方的「轮次数」不一样？**
A：口径不同。**「会话」视图（`/m2/sessions`）是并集口径**——「有读数」**或**「有原文」都算一轮
（故意把「原文在、读数缺」的轮次也列出来，因为**那些轮次照样可以打分**）；**「总览」的读数是读数口径**，只数有读数的轮次。
合计（token / 时长 / tps）始终只累加**有读数**的轮次，缺读数的位置显示 `—`（不写 0，0 是真实读数）。

## 开发

```sh
npm run typecheck && npm run build && npm test      # 提交前的本地门禁（三件）
npm run check:deps && npm run check:exports && node .github/scripts/check-meta.mjs
```

- 工程约定与红线：[CONTRIBUTING.md](CONTRIBUTING.md)（分支 / 提交信息 / 六件套 / 宿主适配 / profile 卫生）；
- 开发文档索引：[docs/2-dev/README.md](docs/2-dev/README.md)——含
  [桌面宿主适配（dev-07）](docs/2-dev/nautilus-dev-07-desktop-host.md)、
  [工作台 UI（dev-02）](docs/2-dev/nautilus-dev-02-ui-workbench.md)、
  [对齐量表决策](docs/1-planning/nautilus-alignment.md) 与
  [UI 线证据归档](docs/2-dev/evidence-al-20260928.md)；
- 提交与评审：issue 先行、PR 一律 squash；`lib/` 不入库（构建入口只有 `scripts/prepare.mjs`）。

### 兼容性

- **当前主用宿主**：dsh **0.2.0-rc.1**（桌面端 **dsh-desktop 0.2.0-rc.1** 实测可用）；
  也已实测 **0.1.5-rc.2**（稳定线）、**0.1.6-alpha.2**（并存安装 `dsh-next`）、**0.1.7-rc.1** 与桌面端 **0.1.7-rc.2**
  （组件版本矩阵见 [dev-07](docs/2-dev/nautilus-dev-07-desktop-host.md)）。
- **宿主升级会先过一道兼容门**：宿主按 `package.json` 的 `@deepseek-ai/dsh*` peer 范围判定插件是否可用，
  不覆盖运行版本的 peer 会让插件**被整体拒装**（症状：路由 401、工具消失、面板不出现，且日志在桌面端被吞掉）。
  升级 devDep 后**先跑 `npm run check:deps`**（R3 就是这条护栏）；peer 范围现覆盖 `0.1.1-rc.2 … 0.2.0-rc.1`。
- 依赖面与 peer 范围、宿主升级五步流程见 [CONTRIBUTING.md](CONTRIBUTING.md)「宿主版本适配」。

## 许可

**BSD-3-Clause**（见 `package.json` 的 `license` 字段；仓库当前未单独附 LICENSE 文件）。
