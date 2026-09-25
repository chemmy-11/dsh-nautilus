/**
 * @dsh-external/dsh-nautilus — plugin entry（会话读数 + 自评工具 + pulse 子插件）。
 *
 * **vault 观测腿已于 2026-09-27 下线**：不再扫描/监听 vault、不再持有 vault 指向；vault 侧操作
 * 交给会话侧 /obsidian 技能（AGENTS §9 裁决）。本文件只做三件事：
 *   1) 打开库（默认 `$DSH_HOME/nautilus/nautilus.db`，含 xuegulin → nexus → nautilus 的改名迁移；
 *      `config.dataDir` 非空时改落该目录——多端共享同一份数据的正式开关，见 PS.0fix）；
 *   2) 采官方 `session/event` → 逐轮读数（TurnsCollector）；
 *   3) 挂 REST（m2 / selfcheck）+ 自评工具 + pulse 子插件。
 * 零写入 vault；观测数据只在 `~/.dsh/nautilus/`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver' // 拉声明合并获得 ctx.webServer 类型
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDataDir } from './home.js'
import { openStore } from './store.js'
import { registerNautilusRoutes } from './routes.js'
import { TurnsCollector, type TurnEventLike } from './nexus/turns.js'
import { registerSelfCheckTool } from './nexus/selfcheck.js'
// Phase 1：pulse（OS/GPU 层）以**子插件**挂载——本包带客户端半区，只允许一个 Loader 条目
// （双条目 → client-modules: resolves from multiple active Loader sources → dsh web 起不来）。
import * as pulse from './pulse/index.js'

// 官方会话事件名（集中常量，避免裸字符串与拼写漂移无编译期保护）。
const SESSION_EVENT = 'session/event'

// ctx.on 的事件名 key 不在 cordis 声明里（session/event 为官方事件 duck-type 通道）；
// 此处仅做监听器形状的窄化声明，事件体仍由 TurnsCollector 按官方契约 duck-type 校验。
type SessionEventOn = (event: string, listener: (session: unknown, event: unknown) => void) => () => boolean

export const name = 'nautilus'
export const inject = ['webServer', 'tools']

export interface Config {
  /**
   * 数据目录（库文件落点）。**默认空 = `$DSH_HOME/nautilus`**（与历史行为逐字一致）。
   *
   * 用途（PS.0fix，多端共享数据）：同机的 dsh-web 与 desktop 各有各的 home（`~/.dsh` / `~/.dsh-desktop`），
   * 默认各自的库互不可见——桌面端面板「有面板没数据」即由此而来。让两端把本字段指向**同一个目录**，
   * 即共享同一份观测数据；home 仍各自隔离（会话、配置、凭据不混）。正式修复，取代「文件系统联接」旁路。
   *
   * 语义：库文件名固定为该目录下的 `nautilus.db`（pulse 子插件同库不同表，跟随同一目录）；
   * 目录不存在会自动建出；**不跑**默认路径专属的历史改名迁移（见 home.ts）。
   */
  dataDir: string
  /**
   * 会话读数采集（**AL.4g 由旧键名 `lField` 改名**——「工作区指向」抽象已撤；破坏性配置变更，旧键不再读取）。
   */
  readings: {
    enabled: boolean
    /** 读数曲线窗口（天）。 */
    historyDays: number
  }
  /** S1.1：外部 harness 自评 ingest 通道（决策 D-SC1；默认关——开启动作本身是部署决策）。 */
  selfcheck: {
    ingest: {
      enabled: boolean
      token: string
      maxBodyBytes: number
    }
  }
  /** Phase 1：OS/GPU 采集层配置（子插件 pulse；enabled=false 时整层不挂载）。 */
  pulse: pulse.Config
}

export const Config = z.object({
  // 空 = 维持现状（$DSH_HOME/nautilus）——默认值不动，行为零变化
  dataDir: z.string().default(''),
  readings: z.object({
    enabled: z.boolean().default(true),
    historyDays: z.number().min(1).default(30),
  }).default({ enabled: true, historyDays: 30 }),
  selfcheck: z.object({
    ingest: z.object({
      enabled: z.boolean().default(false),
      token: z.string().default(''),
      maxBodyBytes: z.number().min(256).max(65536).default(8192),
    }).default({ enabled: false, token: '', maxBodyBytes: 8192 }),
  }).default({ ingest: { enabled: false, token: '', maxBodyBytes: 8192 } }),
  // 复用 pulse 自己的 schema（含全部默认值）：同一条目内组态，非法配置照旧在加载时响亮失败
  pulse: pulse.Config,
})

export function apply(ctx: Context, config: Config): void {
  // 响亮失败：开通道必须配 token（空 token 的「已启用」等于裸奔写库——非法组合在加载时拒，不留到运行时静默 401）
  if (config.selfcheck.ingest.enabled && config.selfcheck.ingest.token.trim() === '') {
    throw new Error('[nautilus] 非法配置：selfcheck.ingest.enabled=true 需要非空 token（默认 enabled=false 即关闭）')
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 显式数据目录（多端共享）：空白视为未配置（配置里写空串/空格与不写等价，避免造出「名为空白」的目录）
  const dataDir = config.dataDir.trim()
  // 数据目录 + 改名迁移（xuegulin → nexus → nautilus）：只在新目录缺失时搬，旧实例占用则回落旧路径，绝不覆盖数据。
  // dataDir 非空时走显式分支：用给定目录、不探测旧世代目录名（PS.0fix 任务 A）。
  const data = resolveDataDir(dshHome, console.warn, dataDir)
  const store = openStore(data.dbFile)
  ctx.effect(() => () => store.close())
  console.log('[nautilus] 数据目录 ' + data.dir
    + (dataDir !== '' ? '（config.dataDir 显式指定：多端共享同一份数据）' : '')
    + (data.fellBack ? '（迁移回落：旧实例占用，重启后自动迁移）' : ''))

  // PS.0fix C：采集写失败读数（丢写可见化）。collector 在下面的事件 effect 里创建，路由注册更早——
  // 故用取值器串起来（null = readings.enabled=false，采集未挂载；诊断面据此区分「没挂载」与「零失败」）。
  let collector: TurnsCollector | null = null

  // REST：会话读数（m2/*）+ 自评 ingest（selfcheck）。工作区指向路由随 AL.4a 撤除、vault 三条路由随观测腿下线。
  ctx.effect(() => registerNautilusRoutes(ctx, {
    store,
    m2HistoryDays: config.readings.historyDays,
    selfcheckIngest: config.selfcheck.ingest,
    collectorDiagnostics: () => collector?.diagnostics() ?? null,
  }), 'nautilus: routes')

  // M2：官方会话事件采集（会话读数数据层；官方 session/event 直采，与团队底座零耦合）
  // type-only 豁免：避免为类型引入 dsh-session 依赖；事件结构按官方契约 duck-type（turns.ts）。
  ctx.effect(() => {
    if (!config.readings.enabled) return () => undefined
    const active = new TurnsCollector(store)
    collector = active
    const onSessionEvent = (ctx.on as unknown as SessionEventOn).bind(ctx)
    const off = onSessionEvent(SESSION_EVENT, (session, event) => {
      try {
        const s = session as { id?: unknown; header?: { cwd?: unknown } }
        const sid = String(s?.id ?? '')
        if (sid !== '') {
          // M4-L：会话发起时的 workspace（cwd）——读数归属判定依据（与 vault 无关）
          const cwd = typeof s?.header?.cwd === 'string' ? s.header.cwd : undefined
          active.handle(sid, event as TurnEventLike, cwd)
        }
      } catch (e) {
        // store 写失败已在 TurnsCollector 内计数（PS.0fix C：诊断面可见），这里只兜非 store 异常（解析/类型 bug）
        console.error('[nautilus] turn collect failed', String(e))
      }
    })
    // 卸载即摘掉诊断读数（路由还在响应，但不再指向已死的采集器）
    return () => { collector = null; off() }
  }, 'nautilus: session events (M2)')

  // M3-F.1：A 腿二自评工具（agent 每轮即时自评三行；手写 def 零运行时依赖）
  ctx.effect(() => {
    const toolCtx = ctx as unknown as { tools: { register(def: unknown): void } }
    registerSelfCheckTool(toolCtx, store)
    return () => undefined
  }, 'nautilus: selfcheck tool (M3-F.1)')

  // Phase 1：OS/GPU 层作为子插件挂载（单 Loader 条目内多能力；见 cordis.patch.yml 顶部契约）。
  // 子插件自带 inject=['webServer'] 与 ctx.effect 清理，卸载随父 fiber 一起收敛。
  // 共享数据目录必须**两库同址**：pulse 与 nautilus 是同库不同表。显式 dataDir 时把库文件路径下传，
  // 否则主库共享了、metric_sample/alert_event 仍落在各自 home（面板半空）。pulse 自己的 dbFile 显式配了就听它的。
  const pulseConfig = dataDir !== '' && config.pulse.dbFile === ''
    ? { ...config.pulse, dbFile: data.dbFile }
    : config.pulse
  ctx.effect(() => {
    const fiber = (ctx as unknown as {
      plugin(plugin: unknown, config: unknown): { dispose?: () => void }
    }).plugin(pulse, pulseConfig)
    return () => { fiber?.dispose?.() }
  }, 'nautilus: pulse sub-plugin (Phase 1)')
  console.log('[nautilus] Pulse OS/GPU 层' + (pulseConfig.enabled ? '已挂载（子插件）' : '已禁用（config.pulse.enabled=false）'))

  console.log('[nautilus] 会话读数采集启动（官方 session/event 直采' + (config.readings.enabled ? '' : ' · readings 已禁用') + '）')
  console.log('[nautilus] M3-F 就绪（自评工具 / B 方案原文 / 白盒分析）')
}
