# 开发文档七 · 桌面宿主适配（dsh-desktop）

> **状态**：2026-09-28 实测定稿（目标宿主 **dsh-desktop 0.2.0-rc.1**；§1–§5 的 0.1.7 时代实测结论仍然成立）。
> **适用**：本插件挂进 **dsh-desktop**（Electron 桌面壳）时的装配、请求链路、同源门判据、**宿主兼容门**与自查路径。
> **为什么单开一篇**：AL.6d 那轮的故障不是「代码写错」而是「宿主形态与判据不符」——症状离根因很远
> （面板部分可用、挂门路由恒 403），定位**全靠门自己回显的 `seen`**。AL.7 那轮同理：症状像「HTTP/工具/事件契约坏了」，
> 真根因是**插件被宿主的兼容门整体拒装**。把实测事实写全，别人（以及未来的我们）不必再踩一遍。

## 1. 装配形态（桌面宿主）

- 桌面宿主通过 **`link:`** 装配本仓库（开发态直连检出目录，不是从 npm/git 装一份副本）。
- **profile 由 Electron 独占管理**：`dsh --profile desktop --dump-config` 这类 **CLI 验证会被拒**
  （CLI 拿不到那个 profile 的锁/权限）。因此「桌面装配是否生效、装的是哪一份」**不能用 CLI 证明**，
  只能在应用内观察（这也是本仓库「验收要指名确切 origin、从外部观察」那条纪律的由来）。
- **本包必须列进 profile 的 `dsh.profile.bundles`**（0.2.0 实测，见 §6）：组合器
  （`@deepseek-ai/dsh-app-boot/lib/index.js` 的 `loadProfileDirectory`，:920-945）**只**按
  `package.json` 的 `dsh.profile.bundles` 顺序读每个 bundle 的 `dsh.bundle.patch`；
  不在该列表里的依赖——即使已经装好、即使它在 `dependencies` 里——**它的 `cordis.patch.yml` 永远不会被读**，
  于是 `insert: nautilus` 这一行根本不存在。`dsh plugin --profile <name> add` 会把它写进去；
  任何「重装/清理依赖」的操作之后都要**回读这个列表**。
- **改动需重启应用生效——桌面端没有热更新**：客户端半区由 `lib/client.js` 在应用启动时加载；
  `npm run build` 只更新磁盘产物，**不触达已在运行的 Electron 进程**。
  所以顺序恒定：**改客户端半区 → `npm run build` → 重启桌面端 → 在既有页面刷新后观察**。
- `dsh.client.platform` 只做**字符串校验**、**不按平台过滤**（官方 `dsh-client-modules` 源码实证，0.2.0-rc.1 未变）：
  本包声明 `"platform": "web"`，在桌面端**照常加载**——**客户端半区在桌面端工作正常**，无需为桌面另出产物。

## 2. 请求链路：页面源与代理（这是判据的物理前提）

- 渲染层页面源是**自定义协议 `dsh-app://app`**，不是 `http://`。
- 页面发出的 `/api/*` 请求由**应用协议处理器在「主进程」代理转发**到本地 HTTP 服务（宿主 webserver）。
  即：到达插件路由的请求**由主进程发出**，而不是渲染进程直发——这就解释了下一节的实测头形。
- **0.2.0 补充（实测）**：主进程转发器（`app.asar/lib/main.js` 的 `forwardWebRequest`，:7181-7212）
  会先向宿主换取**浏览器会话 cookie**（`authenticateWebHost`，:7142-7149 走 `GET /?token=…` 拿 `set-cookie`），
  转发时删掉 `host`/`origin`/`cookie`/`sec-fetch-site` 再**注入该 cookie**（:7188-7195）。
  所以桌面端发到插件路由的请求带的是**宿主的会话凭证**，而不是浏览器 cookie。

## 3. 实测头形（403 的真因面）

| 请求头 | 桌面端实测 |
|---|---|
| `sec-fetch-mode` | **`cors`（在场）** |
| `sec-fetch-site` | **缺** |
| `origin` | **缺** |
| `referer` | **缺** |
| 来源地址 | 回环（主进程代理） |

**判据（`src/routes.ts` 的 `browserSameOriginMarker`，任一成立即放行）**：

1. `sec-fetch-site: same-origin` → 放行；
2. `sec-fetch-site: cross-site` / `same-site` → **拒**（声明跨站/同站子树一律拒——
   写请求即便跨源读不到响应也照样会被执行，打分/裁决都是写）；
3. `sec-fetch-site: none` → 放行（浏览器对「无发起方/直接请求」——导航、扩展、主进程代理——所发的值，
   **不是跨站信号**；早先只放行 same-origin 时把 none 误拒，桌面端因此恒 403）；
4. 存在 `origin` → 放行（原判据，保持原样）；
5. `referer` 以 `dsh-app://` 开头 → 放行（桌面壳内页面）；
6. **`sec-fetch-site` 与 `origin` 都缺 → 放行**（桌面协议代理实测正是这一形态；真实浏览器不可能两者全缺，
   故不对网页开口子）。

> **`sec-fetch-mode` 不是跨站信号**：它只描述「请求模式」（cors/no-cors/navigate…），
> 不描述「发起方 ↔ 目标」的关系。把它算进「取数元数据三者全缺」是本轮**实证驱动纠错**的根因——
> 关系信号由 `sec-fetch-site` 表达，且跨源请求必然带 `origin`。

## 4. 门拒绝时必须回显所见标记（纪律，不是实现细节）

403 响应体固定带 `seen`：

```json
{ "ok": false, "error": "forbidden",
  "seen": { "site": null, "mode": "cors", "origin": null, "referer": null } }
```

价值：把定位从「**重建 — 重启 — 猜**」变成「**读响应**」。AL.6d 就是靠它**一次**定位：
`site=null · mode=cors · origin=null · referer=null` → 一眼看出判据把 `mode` 也算进了「三者全缺」。
**新增任何门行为都必须带上同款回显**（见 `CONTRIBUTING.md`「宿主适配」）。

## 5. 版本矩阵（桌面实测）

| 组件 | 桌面 0.1.7-rc.2 实测 | 桌面 0.2.0-rc.1 实测 | 本包 peer 范围 | 结论 |
|---|---|---|---|---|
| dsh-desktop | 0.1.7-rc.2 | **0.2.0-rc.1** | — | — |
| `@deepseek-ai/cordis` | 4.0.4 | **4.0.4（未变）** | `>=4.0.0-rc <5` | ✅ |
| `@deepseek-ai/dsh-host-webserver` | 0.1.7-rc.2 | **0.2.0-rc.1** | `^0.1.1-rc.2 \|\| … \|\| ^0.1.7-rc.1 \|\| ^0.2.0-rc.1` | ✅ |
| `@deepseek-ai/schemastery` | 3.18.4 | **3.18.4（未变）** | `^3.18.0` | ✅ |
| `@deepseek-ai/dsh-client-connection` | —（不存在） | **0.2.0-rc.1（新增）** | — | 见 §6 |
| `@deepseek-ai/dsh-client-modules` / `-ui-{renderer,layout,sidebar}` | 0.1.7-rc.2 | **0.2.0-rc.1** | — | 契约未变 |
| `@deepseek-ai/dsh-client-ui-slots` | —（不存在） | **0.2.0-rc.1（新增）** | — | 只承载槽位**声明**；`ctx.slots` 仍由 renderer 提供，见 §6 |

> 版本矩阵读的是**装好的宿主**（`D:/dsh/resources/app.asar` 的 `package.json` 与
> `dsh/desktop-runtime.json`），不是 npm dist-tag 推断——这是「先确认宿主实际版本」那条纪律的落点。

## 6. 0.2.0-rc.1 契约变化与适配（AL.7，2026-09-28 实测）

### 6.1 新增的连接授权层（`@deepseek-ai/dsh-client-connection`）

0.2.0 新增此包，它**持有唯一的 `/api` 前缀路由**（`lib/index.js` 的 `API_PATH = "/api"`）＋ Fetch bridge ＋
浏览器会话认证 ＋ Host/Origin 栅栏。要点（逐条对源码核过）：

- `/api` 是个 **prefix** 路由：先 `admit(request)`——Host/Origin 栅栏不过 → **403 `forbidden`**；
  过了栅栏但没有有效浏览器会话 cookie → **401 `unauthorized`**（裸文本，**不是**插件的 JSON）；
  两者都过才进 bridge。
- bridge 只认两样东西：**精确 Fetch 路由表**（`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`，
  路径必须在 `/api/` 下）与 Typert Gateway 的 Remote endpoint；都不匹配 → **404 `not found`**（裸文本）。
- 但**精确路由优先于前缀**：`dsh-host-webserver` 的 `match()` 先查 exact 表，再在前缀表里取**最长前缀**。
  所以插件用 `ctx.webServer.register({ kind: 'exact', … })` 注册的路由**根本不经过**这条认证管线
  （同一宿主里的第三方 pet 插件 `@linxin666/dsh-pet` 也是这么注册的，0.2.0 下 `/api/pet/state` = 200）。
- 因此 0.2.0 里「`/api/*` 全 401」**只有一种含义**：**你的路由没注册**，请求落到了连接层的 `/api` 兜底上
  （无 cookie → `unauthorized`；带 cookie → `not found`）。这是本轮的**首要判据**。

**我们的选择：继续用 `ctx.webServer.register` 的 exact 路由，不改注册机制。** 理由（不是图省事）：

1. `ctx.connection.fetch.register` 的精确路由是在 `admit()` **之后**才被查的——把路由搬过去 = 给所有调用方
   强加浏览器会话 cookie；而 `/api/nautilus/selfcheck` 的设计前提恰恰是**非浏览器调用方**（外部 harness 用
   `x-nautilus-selfcheck-token` 为门），本地脚本/桌面协议代理是另外的合法调用方。
2. 0.1.7 没有 `connection` 服务；为兼容旧宿主就得写能力探测分支，收益为负。
3. 既有同源门（§3）＋ `seen` 回显（§4）＋ selfcheck token 门已经承担了「谁能进来」的判定，
  且 0.2.0 的 exact 路由语义**明确保留在 webserver 侧**（连接层的 README 原文：
   「Host half 始终提供与载体无关的 RPC 注册表和精确 `GET`/`HEAD`/`POST` 路由注册表」）。

### 6.2 工具面：`ctx.tools.register` 多了一条硬校验

`@deepseek-ai/dsh-tools@0.2.0-rc.1` 的 `register(definition)`（`lib/index.js:2878-2887`）现在要求：

- `output` 必须是对象且 **`output.render` 必须是函数**（缺失 → `TypeError: tool "…" must declare output { schema, render, presentationMeta? }`）；
- `assertSupportedJsonSchema(output.schema)`；`timeoutMs` 若给必须是正的有限数；`name` 不得为保留名 `run_code`。

**我们的形状已经合规**：`src/nexus/selfcheck.ts` 的 `buildSelfCheckTool` 带
`output: { schema, render }`（:160-166）。实测：在 0.2.0 宿主里调 `record_turn_selfcheck` 得到
本插件自己的文案 `自评被拒：align 必须是 1–5 的整数……`（越界零写入，`selfcheck_record` 计数与 `max(ts_ms)` 不变）。
**工具描述 = al-v1 注入面、align≥4 引文硬门零写入这些口径一律未动。**

### 6.3 事件面：`session/event` 生产方与信封未变

生产方仍是 `@deepseek-ai/dsh-session`（`lib/index.js` 里
`invokeContainedSessionObservers(entry.emitCtx, "session/event", entry.id, callbackArgs, callbacks)`），
信封仍是 `{ type, seq, time, data }`。实测：`TurnsCollector` 在 0.2.0 宿主里持续写
`turn_read`/`turn_text`/`step_seen`。**`TurnsCollector` 无需改动。**

### 6.4 客户端面：`ctx.slots` 提供方未变

`ctx.slots` 仍由 `@deepseek-ai/dsh-client-ui-renderer` 提供（`lib/client.js`：`super(ctx, "slots")`）；
新增的 `@deepseek-ai/dsh-client-ui-slots` 只承载槽位**声明**。`window.__ModuleLoader__.load({ id, factory })`
与 `dsh.client` 的校验字段（platform/inject/external/immediately）均未变。
**不要**把新包加进 `dsh.client.inject`：那是信息性包名边，而 0.1.7 没有这个包。

### 6.5 真根因：不是契约变了，是**插件被兼容门整体拒装**

三处症状（`/api/nautilus/*` 全 401、`record_turn_selfcheck` 不可调用、`turn_read` 停写）**同源**：
本包没被组合进桌面 profile。链路（全部有源码/实测证据）：

1. **兼容门**：`@deepseek-ai/dsh-app-boot/lib/index.js` 的 `evaluatePluginCompatibility`（:286-313）对
   `peerDependencies` 里**每个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 做
   `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。
   旧 peer 末段是 `^0.1.7-rc.1`（= `>=0.1.7-rc.1 <0.2.0-0`），**不覆盖 `0.2.0-rc.1`**。
2. **bundle 级拒绝**：`loadProfileDirectory`（:920-945）对不兼容的 bundle **整层跳过**（记入 `skippedBundles`），
   于是本包 `dsh.bundle.patch` 指向的 `cordis.patch.yml` 压根不读 → `insert: nautilus` 不存在。
   诊断行由 `reportSkippedBundles`（:515-517）写到 **stderr**：`dsh: skipping profile bundle "…": Plugin … is incompatible …`。
3. **row 级拒绝**（第二道，独立生效）：`prepareProfileEntries` → `preflight`（:2057-2100）会把任何
   解析出「声明不兼容」的条目直接 `row.disabled = true`，并打印 `dsh: disabling profile plugin row "nautilus": …`。
4. **诊断被吞**：桌面壳以 `spawn(..., { stdio: ['ignore','pipe','pipe','ipc'] })` 起宿主
   （`app.asar/lib/main.js` :3674-3691），stderr 只被塞进 64 KiB 环形缓冲、**仅在致命错误对话框里出现**
   （:3693-3696）。所以「插件被跳过」这条最关键的日志在 GUI 与磁盘上都看不到——症状只剩 401。
5. semver 数值复核：旧范围 `^0.1.7-rc.1` vs `0.2.0-rc.1` → **false**（`includePrerelease` 开/关都是 false）；
   现范围（`… || ^0.2.0-rc.1`）→ **true**。

**改法**：把 `@deepseek-ai/dsh-host-webserver` 的 peer 范围补上 `|| ^0.2.0-rc.1`（`package.json`），
并确认 `@dsh-external/dsh-nautilus` 回到 profile 的 `dsh.profile.bundles`。
**本包运行时/客户端代码一行未改**——契约面逐项核对下来没有变化，符合「契约没变就不改码」。

> **`check:deps` 本可拦住这一步**：`scripts/check-deps.mjs` 的 **R3** 就是「peer 范围必须覆盖 devDep pin 的
> 宿主版本线」。升级 devDep 后**先跑 `npm run check:deps`**，再谈重启实测。

### 6.6 修好之后的实测证据（0.2.0-rc.1，桌面端）

宿主进程：`DeepSeek Harness.exe --expose-internals …dsh-desktop-host\lib\index.js … .dsh\profiles\desktop`，
监听 `127.0.0.1:19387`。用**宿主自己的签名 cookie**（`.credentials.yaml` 的
`client-connection/browser-session` 密钥 + `dsh-auth-<sha256(authority)>`）与不带 cookie 两种方式探：

| 探测 | 结果 |
|---|---|
| `GET /api/nautilus/m2/state`（带 / 不带 cookie） | **200**，本插件 JSON（`revision`/`sessionMeta`…） |
| `GET /api/nautilus/nope`（带 cookie） | 404 `not found`（落到连接层兜底，说明我们的 exact 表已生效、前缀兜底没被误拦） |
| `GET /api/nautilus/nope`（不带 cookie） | **401 `unauthorized`**（= 用户早先看到的形态：路由不存在时的兜底） |
| `GET /`（带 cookie） | index 注入里含 `@dsh-external/dsh-nautilus` 与 `plugins/??@dsh-external/dsh-nautilus/client.js&rev=…` → 客户端半区已组合 |
| 调 `record_turn_selfcheck({align: 99})` | 返回本插件校验文案，`selfcheck_record` 计数/水位不变（硬门零写入成立） |
| `metric_sample` / `turn_read` / `turn_text` / `step_seen` | 两次采样间隔 65 s，行数与 `max(ts)` 全部增长 → pulse 与逐轮采集都在写 |

**诚实边界**：上面是**同一进程内**的实测（未重启应用）。「插件被拒装 → 症状」这条因果链的
直接证据是：拒绝时刻（`turn_read` 在 22:00–22:45 窗口为 0 行；`metric_sample` 22:18:44→22:45:08 断档）
与恢复时刻（peer 修正 + bundle 回列之后全部恢复）对齐，加上 §6.5 的源码级拒绝路径与 semver 数值复核；
**没有**留到「被拒装时进程内日志」的原始抓取（它写在被吞掉的 stderr 上，见 §6.5 第 4 点）。

## 7. 自查路径（症状 → 动作）

| 症状 | 先做什么（按序） |
|---|---|
| **`/api/nautilus/*` 全 401（裸文本 `unauthorized`）** | ① 先看**不存在的子路径**：带宿主签名 cookie 若是 404 `not found`，说明你打的是**连接层兜底**，即**插件没被组合**；② 查 profile `package.json` 的 `dsh.profile.bundles` 有没有本包（§1）；③ 跑 `npm run check:deps`（R3：peer 是否覆盖 devDep pin）；④ 查 peer 是否覆盖**运行中的**宿主版本（§6.5）。**不要**先怀疑同源门——门拒绝给的是 **403 + `seen`**，不是 401。 |
| 面板**部分可用**、挂门路由**恒 403** | 看 403 响应体的 `seen`，对照 §3 判据；**不要**先怀疑路由没注册（未挂门的路由正常正是这个症状） |
| 工具「不是函数」/ 面板整个消失 | 同第 1 行：先确认插件是否被组合（被拒装时工具、客户端半区、采集**一起**消失） |
| 改了客户端半区、「端上没变化」 | 确认 `npm run build` 跑过 **且** 应用重启过（§1：桌面端无热更新）；再核 `lib/client.js` 的 mtime/字节数 |
| 想用 CLI 证明桌面装配 | 做不到（§1：profile 由 Electron 独占管理）——只能在应用内观察，并记录环境四元组 |

## 8. 相关

- 同源门实现：`src/routes.ts` 的 `browserSameOriginMarker` / `forbiddenByGuard`；
- 兼容门与组合器：宿主 `@deepseek-ai/dsh-app-boot`（`evaluatePluginCompatibility` / `loadProfileDirectory` /
  `prepareProfileEntries`）、连接层 `@deepseek-ai/dsh-client-connection`；
- 工程约定：`CONTRIBUTING.md`「宿主适配（HTTP 路由与同源门）」与「宿主版本适配」；
- 客户端半区与视图：`docs/2-dev/nautilus-dev-02-ui-workbench.md`。
