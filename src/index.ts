/**
 * @dsh-external/dsh-nautilus — plugin entry（L 场读数 + 自评工具 + pulse 子插件）。
 *
 * **vault 观测腿已于 2026-09-27 下线**：不再扫描/监听 vault、不再持有 vault 指向；vault 侧操作
 * 交给会话侧 /obsidian 技能（AGENTS §9 裁决）。本文件只做三件事：
 *   1) 打开库（`~/.dsh/nautilus/nautilus.db`，含 xuegulin → nexus → nautilus 的改名迁移）；
 *   2) 采官方 `session/event` → 逐轮读数（TurnsCollector）；
 *   3) 挂 REST（m2 / lfield）+ 自评工具 + pulse 子插件。
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
  lField: {
    enabled: boolean
    /** L 场读数曲线窗口（天）。 */
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
  lField: z.object({
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
  // 数据目录 + 改名迁移（xuegulin → nexus → nautilus）：只在新目录缺失时搬，旧实例占用则回落旧路径，绝不覆盖数据
  const data = resolveDataDir(dshHome)
  const store = openStore(data.dbFile)
  ctx.effect(() => () => store.close())

  // REST：L 场读数（m2/*）+ L 场指向（lfield）+ 自评 ingest（selfcheck）。vault 三条路由已随观测腿下线。
  ctx.effect(() => registerNautilusRoutes(ctx, {
    store,
    m2HistoryDays: config.lField.historyDays,
    selfcheckIngest: config.selfcheck.ingest,
  }), 'nautilus: routes')

  // M2：官方会话事件采集（L 场读数数据层；官方 session/event 直采，与团队底座零耦合）
  // type-only 豁免：避免为类型引入 dsh-session 依赖；事件结构按官方契约 duck-type（turns.ts）。
  ctx.effect(() => {
    if (!config.lField.enabled) return () => undefined
    const collector = new TurnsCollector(store)
    const onSessionEvent = (ctx.on as unknown as SessionEventOn).bind(ctx)
    return onSessionEvent(SESSION_EVENT, (session, event) => {
      try {
        const s = session as { id?: unknown; header?: { cwd?: unknown } }
        const sid = String(s?.id ?? '')
        if (sid !== '') {
          // M4-L：会话发起时的 workspace（cwd）——L 场归属判定依据（与 vault 无关）
          const cwd = typeof s?.header?.cwd === 'string' ? s.header.cwd : undefined
          collector.handle(sid, event as TurnEventLike, cwd)
        }
      } catch (e) {
        console.error('[nautilus] turn collect failed', String(e))
      }
    })
  }, 'nautilus: session events (M2)')

  // M3-F.1：A 腿二自评工具（agent 每轮即时自评三行；手写 def 零运行时依赖）
  ctx.effect(() => {
    const toolCtx = ctx as unknown as { tools: { register(def: unknown): void } }
    registerSelfCheckTool(toolCtx, store)
    return () => undefined
  }, 'nautilus: selfcheck tool (M3-F.1)')

  // Phase 1：OS/GPU 层作为子插件挂载（单 Loader 条目内多能力；见 cordis.patch.yml 顶部契约）。
  // 子插件自带 inject=['webServer'] 与 ctx.effect 清理，卸载随父 fiber 一起收敛。
  ctx.effect(() => {
    const fiber = (ctx as unknown as {
      plugin(plugin: unknown, config: unknown): { dispose?: () => void }
    }).plugin(pulse, config.pulse)
    return () => { fiber?.dispose?.() }
  }, 'nautilus: pulse sub-plugin (Phase 1)')
  console.log('[nautilus] Pulse OS/GPU 层' + (config.pulse.enabled ? '已挂载（子插件）' : '已禁用（config.pulse.enabled=false）'))

  console.log('[nautilus] L 场读数采集启动（官方 session/event 直采' + (config.lField.enabled ? '' : ' · lField 已禁用') + '）')
  console.log('[nautilus] M3-F 就绪（自评工具 / B 方案原文 / 白盒分析）')
}
