# 开发文档七 · 桌面宿主适配（dsh-desktop）

> **状态**：2026-09-28 实测定稿（目标宿主 **dsh-desktop 0.1.7-rc.2**）。
> **适用**：本插件挂进 **dsh-desktop**（Electron 桌面壳）时的装配、请求链路、同源门判据与自查路径。
> **为什么单开一篇**：AL.6d 那轮的故障不是「代码写错」而是「宿主形态与判据不符」——症状离根因很远
> （面板部分可用、挂门路由恒 403），定位**全靠门自己回显的 `seen`**。把实测事实写全，别人（以及未来的我们）不必再踩一遍。

## 1. 装配形态（桌面宿主）

- 桌面宿主通过 **`link:`** 装配本仓库（开发态直连检出目录，不是从 npm/git 装一份副本）。
- **profile 由 Electron 独占管理**：`dsh --profile desktop --dump-config` 这类 **CLI 验证会被拒**
  （CLI 拿不到那个 profile 的锁/权限）。因此「桌面装配是否生效、装的是哪一份」**不能用 CLI 证明**，
  只能在应用内观察（这也是本仓库「验收要指名确切 origin、从外部观察」那条纪律的由来）。
- **改动需重启应用生效——桌面端没有热更新**：客户端半区由 `lib/client.js` 在应用启动时加载；
  `npm run build` 只更新磁盘产物，**不触达已在运行的 Electron 进程**。
  所以顺序恒定：**改客户端半区 → `npm run build` → 重启桌面端 → 在既有页面刷新后观察**。
- `dsh.client.platform` 只做**字符串校验**、**不按平台过滤**（官方 `dsh-client-modules@0.1.7-rc.2` 源码实证）：
  本包声明 `"platform": "web"`，在桌面端**照常加载**——**客户端半区在桌面端工作正常**，无需为桌面另出产物。

## 2. 请求链路：页面源与代理（这是判据的物理前提）

- 渲染层页面源是**自定义协议 `dsh-app://app`**，不是 `http://`。
- 页面发出的 `/api/*` 请求由**应用协议处理器在「主进程」代理转发**到本地 HTTP 服务（宿主 webserver）。
  即：到达插件路由的请求**由主进程发出**，而不是渲染进程直发——这就解释了下一节的实测头形。

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

价值：把定位从「**重建 — 重启 — 猜**」变成「**读响应**」。本轮就是靠它**一次**定位：
`site=null · mode=cors · origin=null · referer=null` → 一眼看出判据把 `mode` 也算进了「三者全缺」。
**新增任何门行为都必须带上同款回显**（见 `CONTRIBUTING.md`「宿主适配」）。

## 5. 版本矩阵（桌面实测）

| 组件 | 桌面 0.1.7-rc.2 实测 | 本包 peer 范围 | 结论 |
|---|---|---|---|
| dsh-desktop | 0.1.7-rc.2 | — | — |
| `@deepseek-ai/cordis` | 4.0.4 | `>=4.0.0-rc <5` | ✅ 落在范围内 |
| `@deepseek-ai/dsh-host-webserver` | 0.1.7-rc.2 | `^0.1.1-rc.2 \|\| … \|\| ^0.1.7-rc.1` | ✅ |
| `@deepseek-ai/schemastery` | 3.18.4 | `^3.18.0` | ✅ |

## 6. 自查路径（症状 → 动作）

| 症状 | 先做什么（按序） |
|---|---|
| 面板**部分可用**、挂门路由**恒 403** | 看 403 响应体的 `seen`，对照 §3 判据；**不要**先怀疑路由没注册（未挂门的路由正常正是这个症状） |
| 改了客户端半区、「端上没变化」 | 确认 `npm run build` 跑过 **且** 应用重启过（§1：桌面端无热更新）；再核 `lib/client.js` 的 mtime/字节数 |
| 想用 CLI 证明桌面装配 | 做不到（§1：profile 由 Electron 独占管理）——只能在应用内观察，并记录环境四元组 |

## 7. 相关

- 同源门实现：`src/routes.ts` 的 `browserSameOriginMarker` / `forbiddenByGuard`；
- 工程约定：`CONTRIBUTING.md`「宿主适配（HTTP 路由与同源门）」；
- 客户端半区与视图：`docs/2-dev/nautilus-dev-02-ui-workbench.md`。
