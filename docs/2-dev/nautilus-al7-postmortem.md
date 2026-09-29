# 0.2.0-rc.1 适配复盘 · 卡点与解法（**答辩版**）

> **一句话**：宿主跨小版本升级后，插件「看起来是接口坏了」，实际是**宿主在装配阶段就把整个插件拒装了**——
> 症状离根因隔了三层（兼容门 → 整层跳过 → `/api` 兜底 401），而**诊断信息被桌面壳吞掉**。
> 定位靠三条自制判据（门自证、活性看时间戳、用「本该命中」的路径探测），修复只改了**一行版本范围**。

---

## 一、问题（现场）

| 项 | 事实 |
|---|---|
| 触发 | dsh-desktop 由 **0.1.7-rc.2** 升级到 **0.2.0-rc.1** |
| 症状 1 | 工作台面板**无数据** |
| 症状 2 | 打分提交返回 **`forbidden`** |
| 症状 3 | 控制台刷屏：`GET dsh-app://app/api/nautilus/pulse/alerts?limit=20 403`（桌面壳内） |
| 症状 4 | 我（AI 侧）每轮调用的自评工具**消失**（`record_turn_selfcheck is not a function`） |
| 症状 5 | 逐轮读数**停止入库**（`turn_read` 断档） |
| 迷惑点 | 同宿主的**别的插件正常**（`/api/pet/state` → 200）；宿主自身服务正常 |

## 二、定位过程（三层剥离）

### 第 1 层：版本面 —— 先确认真实宿主版本，不凭 npm 推断
直接解析 `D:/dsh/resources/app.asar` 索引读出组件矩阵：

| 组件 | 0.1.7-rc.2 | 0.2.0-rc.1 | 判定 |
|---|---|---|---|
| `@deepseek-ai/dsh-desktop` | 0.1.7-rc.2 | **0.2.0-rc.1** | 宿主跳版本 |
| `@deepseek-ai/cordis` | 4.0.4 | 4.0.4 | **未变** ✓ |
| `@deepseek-ai/schemastery` | 3.18.4 | 3.18.4 | **未变** ✓ |
| `dsh-host-webserver` | 0.1.7-rc.2 | **0.2.0-rc.1** | **peer 覆盖不到** ✗ |
| `dsh-client-modules` / `client-ui-*` | 0.1.7-rc.2 | **0.2.0-rc.1** | 形态未变 ✓ |

### 第 2 层：契约面 —— 逐项核对，并**读同宿主里能跑的插件当参照**
- `ctx.webServer.register({kind:'exact'|'prefix', path, handler})`：形态未变（`match()` 仍是 exact 表先命中）✓
- `dsh.client` 校验字段（`platform/inject/external/immediately`）：未变 ✓
- `window.__ModuleLoader__.load({id, factory})`：未变 ✓
- `ctx.slots.inject/register`：仍被宿主自家 `ui-chat` 这么用 ✓
- **参照实现**：同宿主里能跑的 `@linxin666/dsh-pet` —— `inject:['webServer']` + `{kind:'exact', path:'/api/pet/...'}`，客户端裸 `fetch`，**与我们完全同构**。
  → 说明「HTTP 契约没坏」，问题不在我们的代码。

### 第 3 层：真根因 —— 宿主的**插件兼容门**
`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 对 peerDependencies 里**每个** `@deepseek-ai/dsh*` 做：
```js
semver.satisfies(runtimeVersion, peerRange, { includePrerelease: true })
```
我们的旧末段是 `^0.1.7-rc.1`（`>=0.1.7-rc.1 <0.2.0-0`）——**覆盖不到 `0.2.0-rc.1`**（semver 实测 false，开关 `includePrerelease` 都 false）。

**后果是「整包拒装」**，两条门任一即致命：
1. `loadProfileDirectory` 对该 bundle **整层跳过** → 我们 `cordis.patch.yml` 的 `insert: nautilus` 根本不进组合；
2. `prepareProfileEntries` 把该行直接 `row.disabled = true`。

**为什么现场只看到 401**：拒装后我们的 exact 路由不存在，请求落到 0.2.0 的 `/api` 承载层兜底（prefix 路由 + 认证门），无会话 → **裸文本 401 `unauthorized`**；
而拒装的诊断只写 **stderr**，桌面壳把 stderr 塞进 64 KiB 环形缓冲、**仅致命错误才弹窗** → 界面上只剩 401，根因完全不可见。

**可控复现**（证明因果，而非相关性）：把 peer 收窄成旧范围的**副本**装进隔离 profile，启动即打印：
```
dsh: skipping profile bundle "@dsh-external/dsh-nautilus": Error: Plugin @dsh-external/dsh-nautilus@0.0.1
is incompatible with dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh-host-webserver":"^0.1.1-rc.2 || … || ^0.1.7-rc.1"}.
```
该实例上**本该已注册**的 exact 路由全 401；修复侧同一路径 **200**。另：`dsh plugin add` 用收窄副本会**安装期就拒**（`installation rejected`）。

## 三、解法（一行版本范围）

```diff
  "@deepseek-ai/dsh-host-webserver":
-   "^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1"
+   "^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1"
```
+ `devDependencies` 的 pin 升到 `0.2.0-rc.1`；**运行时与客户端代码一行未改**。
**不做的事**：刻意**不**把路由迁到 `ctx.connection.fetch.register` —— 那会把路由放到认证门之后，给外部 harness 的 `/selfcheck`（token 门、非浏览器）强加浏览器会话 cookie，且 0.1.7 无此服务。

## 四、验证（可复核）

| 层 | 判据 | 结果 |
|---|---|---|
| 装配 | index 注入含本包与其 `client.js&rev=` | ✓ 已组合 |
| 路由 | **本该已注册的 exact 路径**（`/api/nautilus/m2/state`） | 拒装期 401 → 修复后 **200** |
| 工具 | `record_turn_selfcheck` 实调 | 拒装期 `is not a function` → 修复后**成功落库**（id=69） |
| 采集 | `turn_read` / `metric_sample` 的 **max(ts) 前移** | 拒装窗口 22:00–22:45 **0 行** → 修复后 2s/5s 前 |
| 硬门 | `record_turn_selfcheck({align:99})` | 返回本插件文案且**零写入** |
| 双宿主 | 回归脚本在两版宿主上 | 0.1.7-rc.2 **6/6** · 0.2.0-rc.1 **6/6** |
| 端上 | 环境四元组（版本 / profile / 装配 / 结果） | dsh-desktop 0.2.0-rc.1 · `desktop` · `link:` · **通过** |

## 五、为什么原有护栏没拦住（关键一问）
`npm run check:deps` 的 **R3** 只校验「peer 覆盖 **devDep pin** 的版本线」——而当时 devDep 还停在 `0.1.7-rc.1`，
**它不知道 0.2.0 存在**。护栏校验的是「自洽」，不是「与真实宿主兼容」。

→ 新增 `scripts/test-host-compat.mjs`：用**能力探测取得的真实宿主版本**（env → 宿主目录 → app-boot → 桌面 asar → devDep 基线）
对每个 `@deepseek-ai/dsh*` peer 做 `semver.satisfies(..., { includePrerelease: true })`，并带**负向对照**（事故旧范围必须判 false，证明门有牙）。

## 六、沉淀（可直接复用的六条）

1. **版本面先证实**：读宿主安装包拿真实版本（asar 索引），**不凭 npm dist-tag 推断**；跨小版本升级先跑兼容范围断言。
2. **契约面靠「参照实现」**：同宿主里能跑的第三方插件是最好的规格说明（本次 pet 一条就排除了整类猜测）。
3. **判据必须可判别**：未知路径的 401 是**承载层兜底**（任何插件都一样，`/api/pet/nope` 亦 401），**不能**当「路由未注册」的证据；要打**本该命中的 exact 路径**。
4. **活性看时间戳，不看累计量**：`max(ts)` 前移才是活性；行数会把「拒装窗口内的旧样本」误读成「活着」（我们双方都踩过）。
5. **门要自证**：HTTP 门在拒绝时回显所见标记（`seen{site,mode,origin,referer}`）——本轮 0.1.7 时代那场 403 事故正是靠它从「重建—重启—猜」变成「读响应」。
6. **工程纪律**：改完必 `build` 再 `test`（测试跑 `lib/` 产物）· 门禁与推送之间**显式判成功**（我曾把红主干推上去）· 新增测试用到的依赖**必须显式声明**（否则护栏在别人机器上直接 ERREQ，等于护栏自身不可移植）。

## 七、协作方式（多 agent 并行的可复用分工）

| 角色 | 职责 | 本轮产出 |
|---|---|---|
| 实现线 | 读宿主源码定位、改码 | 根因链 + peer 修复（`baaf3e2`） |
| **QA 线**（专职排查与回归） | 建**不依赖真机**的可控复现环境、写回归护栏、**独立判定** | 隔离 profile 探针 + 三套回归（`d488484`） |
| 文档线 | 记录与对齐，**废弃过期版本而非叠加** | dev-07 §6/§6.7 + README + FAQ 分流（`3d27096`） |
| Lead | 冻结判据、集成、终验、收敛 | 三线同点、六件套、端上四元组 |

**三条硬纪律**：① **一线一检出**（worktree），共享检出被切走会吞掉另一条线的改动；② 各线**只推自己的分支**，Lead 统一集成；③ **实现者不自判**——修完由 QA 的护栏判（本轮 QA 复现出「兼容门拒装」并纠正了两条流传说法）。

## 八、被推翻的两条「想当然」（诚实清单）

1. **「401 是新连接层导致的」** → 错。`@deepseek-ai/dsh-client-connection` **0.1.7-rc.2 就已存在**（同一 CLI 闭包里），两版「未知 `/api` → 401 裸文本」**行为同形**；本次与它无关。
2. **「别的插件有特殊通道」** → 错。pet 只是 peer 覆盖了 0.2.0、**装上了**；同一张 exact 路由表、同一道兜底门。

另有我方三次误判（已记入提交与证据档）：把未知路径 401 当缺装证据 · 用行数当活性证据 · **把红的主干推了上去**（推送无条件串在测试之后）。

## 九、时间线（2026-09-28 → 09-29）

```
22:18:44  metric_sample 最后一个样本（此后断档）
22:00–22:45  turn_read 0 行（拒装窗口）
22:45:08  装载恢复（peer 修复 + bundles 正确）→ 采样恢复
23:06     修复提交 baaf3e2（peer + dev-07 §6 + README）
23:41     QA 交付回归护栏 d488484（可控复现环境 + 三套用例）
次日 00:07  端上验收通过 → 归档四元组（cb0e8c5）
```

## 十、一页话总结（答辩用）

> 这次不是「接口不兼容」，而是**宿主的插件兼容门在装配阶段就拒绝了整个插件**：
> peer 范围没覆盖新的宿主小版本 → 整层跳过 → 路由/工具/采集一起消失 → 界面上只剩承载层兜底的 401。
> 修复是**一行版本范围**；真正的产出是**四条可复用的判据**（真实版本断言 · 参照实现 · 可判别探针 · 时间戳活性）
> 与**一套独立回归护栏**——让同类事故下次在 CI 里就红，而不是在用户界面上表现为「莫名其妙用不了」。

> 归属：宿主适配五步见 [CONTRIBUTING.md](../../CONTRIBUTING.md)；桌面宿主实测与契约见 [nautilus-dev-07-desktop-host.md](./nautilus-dev-07-desktop-host.md)；
> 原始证据见 [evidence-al7-020a-20260928.md](./evidence-al7-020a-20260928.md)。