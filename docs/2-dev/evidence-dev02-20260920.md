# 证据归档 · dev-02 图表语法升级（2026-09-20）

> 对应：`nautilus-dev-02-ui-workbench.md` §4.5（2026-09-20 守谷人裁决：方案 A「图表语法升级 · 自绘」全量——stat 走势 + PULSE 小图网格 + 构成柱/占比 gauge + 状态带/会话排行 + USE 资源族分区）。
> 改动面：`src/client/charts.ts`（新增，图表原语库）· `src/client/workbench.ts`（总览 FIG.01 网格化 + FIG.10 + 曲线「输入构成」档 + `fmtK` 修复）· `scripts/test.mjs`（末尾追加 3 条测试）。

## 执行命令与实际输出

| 命令 | 预期 | 实际 |
|---|---|---|
| `npm run typecheck` | 无错误 | ✅ 无错误（启动时曾见 `selfcheck.ts:50` 红，为并行 S1.1 工作线中途笔误，其会话已自行修复，与本线无关） |
| `npm run build` | host + client 双产物重建 | ✅ `lib/index.js` + `lib/client.js` 均重建（中途两次 esbuild 语法错：fams.map 括号数错——当场修正） |
| `npm test` | 全绿 | ✅ **tests 30 / pass 30 / fail 0**（含本线新增 3 条；并行 S1.1 线新增 5 条亦全绿） |
| `npm run check:deps` | OK | ✅ 单实例合约 + 预发布分支 + peer/devDep 同步合规 |
| `npm run check:exports` | OK | ✅ 命名空间插件无 default 导出混用 |
| 元数据校验 | bundle patch / client 双半 / files 清单 / client shim | ✅ 含于 `npm test`（client bundle 往返 + panellist/main 同值断言） |

## 新增测试断言（源码级 + 真实 react SSR）

1. **总览图表升级 SSR**：USE 分区族头、gauge（`nt-gauges`）、同步十字线读数位默认文案、采集健康带占位、会话排行（`2.0k · 2 轮`）、活跃带均在场；**缺席诚实态**——无 `gpu.mem.*` 指标时「显存占比」gauge 不得渲染、序列未取数时小图显式「暂无数据」而非编造曲线。
2. **charts 原语 SSR**：StackedBars 柱/刻度/空态、StateBand 泳道几何（left:10.00% / width:50.00%）、TopList 排行与零值剔除、BarGauge 警示与阈值刻度（width:95.0% + left:90.0%）、Sparkline 点不足渲染 null。
3. **charts 纪律守卫**：源码零 `useState/useEffect/useRef/useLayoutEffect`（无 hooks ⇒ 可像 Stat/Spark 一样直调）；`var(--nt-*, fallback)` 之外零硬编码色。

## 顺手修复（记录在案）

- `workbench.ts` `fmtK` 被引用但从未定义（客户端半区被 tsconfig 排除、无 tsc 把关而漏网）——运行时切「累计输入」档会 ReferenceError（被 ViewBoundary 兜住表现为该视图渲染失败）。本线补上定义；建议后续评估把 `src/client` 纳入独立 tsconfig 检查。
- `M2Point` 类型补 `missToken?` 字段（`curveValue` 实际访问该字段，此前类型不实）。

## 布局二次修订（2026-09-20 同日，守谷人对首版反馈）

反馈：排版乱、主图太小、小图与主图重复。修订（六件套复跑全绿 30/30）：

- FIG.01 四主图（CPU 利用率/内存占用/GPU 利用率/宿主 RSS）升为 **2×2 交互大图**（新组件 `PulseChart`，workbench.ts）：滚轮放缩（指针锚点，min 8 点）+ 右键拖动平移 + 双击复位；图头显示最新/悬停读数；原头条 stat 卡+sparkline 撤销（重复）。
- 小图网格只列主图之外的次要指标；总览 FIG.02（最近轮次）/ FIG.08（L 场指向）默认折叠（`Panel` 原生 `<details>` 折叠，无 hooks）。
- 新增断言：`nt-maingrid`、主图恰 4 格、图头交互提示、`<details>/<summary>`、最新值渲染（92.0%）。

## 曲线刷新与心跳对齐（2026-09-20 三次反馈，六件套复跑全绿 30/30）

反馈：曲线渲染频率应与心跳对齐。修订：

- 新增 `heartbeatSeriesMs()` / `heartbeatRefreshLabel()`（workbench.ts）：auto 档 = max(1s, 心跳档位间隔)；手动档 = 0（不轮询，采样完成经 nonce 触发重取——复用 PulseHeartbeat 的 reload→nonce 通道）；PULSE 缺席 = 60 s 兜底。
- 生效面：总览 FIG.01 主图 + 小图（`usePulseSeriesMap` 加 nonce 参数）+ 曲线视图 PULSE 模式（`useJson` 已有 nonce 参数，间隔改对齐口径）；`useJson`/`usePulseSeriesMap` 对 intervalMs ≤ 0 不挂定时器。
- 图注显式标注当前刷新频率（fixture auto 5s 档 → 「曲线刷新与心跳对齐：5 s/次（随心跳档位）」，SSR 断言在场）。
- 诚实边界：1s 档下序列取数为逐指标并行（15 条/秒，SQLite 桶聚合，量级与既有 1s 心跳轮询同阶）；缩放窗为索引窗，新桶滑入时窗口内容整体前移一格（实时看板常规行为，非 bug）。

## 平移交互改左键按住拖动（2026-09-20 四次反馈，六件套复跑全绿 30/30）

反馈：右键拖动与浏览器手势重合。修订：

- `PulseChart`（FIG.01 主图）与 `CurveChart`（曲线视图）平移统一改**左键按住拖动**；4px 位移阈值区分点击与拖动——曲线视图 <4px 松开＝点击采样点下钻（逻辑自 svg `onClick` 迁至 window `mouseup`，hover 经 ref 透传避免闭包过期）；拖动中清 hover、`user-select:none` 防误选。
- 右键还原给浏览器：两处 `onContextMenu` 抑制移除；图头提示与全部图注文案同步（「滚轮放缩 · 左键按住拖动 · 双击复位」等 5 处），SSR 断言更新并全绿。

## 拖动灵敏度修正（2026-09-20 五次反馈，六件套复跑全绿 30/30）

反馈：拖动灵敏度太高，应与鼠标同步（抓住的点跟手）。根因：索引位移公式漏乘 `窗口跨度/绘图区宽`——`di = Δpx/缩放` 直接当索引数用，全窗 240 点、绘图区 1052 视图单位时拖动比鼠标快约 4.4×。修正：`di = Δpx ÷ 缩放 × (跨度 ÷ 绘图区宽)`（`PulseChart` 除数 DW=1000、`CurveChart` 除数 DW−padL−padR=1052）。修正后按住时指针下数据点全程保持在指针下（≤0.5 索引取整误差，约 1–2px）。

## 观察结论与诚实边界

- 本地构建通道（六件套）全绿即本归档范围；**SSR 冒烟 ≠ 浏览器视觉验收**——新图表在真实宿主中的观感、悬停交互（同步十字线）、构成柱点击下钻，需按 AGENTS §7 红线在**既有页面刷新后**人工确认。
- **端上验收通道约束（守谷人 2026-09-20 口头指令）**：本改动属实验性质，装配/验收只走 **dsh-next（0.1.6 alpha）对应 profile**，稳定版 dsh 的 profile 不动。端上环境四元组待补：`dsh 版本 + profile 名 + 装配方式 + 结果`。
- 图表借鉴仅取**组件语法与组织原则**（Grafana/Netdata/Datadog 的公开文档与设计方法论），未复制任何代码；实现为零依赖自绘（AGENTS §3 零新依赖红线不破）。
- 会话活跃带语义为「首末轮跨度包络」，不代表全程活跃；排行按输入令牌（命中+未命中）合计——口径已随图注记。
