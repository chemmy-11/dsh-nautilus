/**
 * @dsh-external/dsh-nexus — plugin entry (M1: vault metadata + edit stats + observation panel).
 * apply: open store → full scan (startup + periodic calibration) → fs.watch (effect) → REST (effect).
 * All tunables live in Config; zero writes into the vault (data lives in ~/.dsh/nexus/).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver' // 拉声明合并获得 ctx.webServer 类型
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import z from 'schemastery'
import { openStore } from './store.js'
import { scanVault } from './scan.js'
import { startVaultWatch } from './watch.js'
import { registerNexusRoutes } from './routes.js'
import { TurnsCollector, type TurnEventLike } from './turns.js'
import { registerSelfCheckTool } from './selfcheck.js'

// 官方会话事件名（R2：集中常量，避免裸字符串与拼写漂移无编译期保护）。
const SESSION_EVENT = 'session/event'
// M4.3：本插件自有事件——指向切换后由 routes 发射，index.ts 重挂 scan/watch（不跨插件，仅内部通道）。
const VAULT_ROOT_CHANGED = 'nexus/vault-root-changed'

// ctx.on 的事件名 key 不在 cordis 声明里（session/event 为官方事件 duck-type 通道）；
// 此处仅做监听器形状的窄化声明，事件体仍由 TurnsCollector 按官方契约 duck-type 校验。
type SessionEventOn = (event: string, listener: (session: unknown, event: unknown) => void) => () => boolean
type CtxOnAny = (event: string, listener: (...args: unknown[]) => void) => () => boolean

export const name = 'nexus'
export const inject = ['webServer', 'tools']

export interface Config {
  vaultRoot: string
  exclude: string[]
  pollIntervalMs: number
  debounceMs: number
  watchEnabled: boolean
  lField: {
    enabled: boolean
    refreshMs: number
    historyDays: number
  }
}

export const Config = z.object({
  vaultRoot: z.string().default(''),
  exclude: z.array(z.string()).default(['dsh-docs']),
  pollIntervalMs: z.number().min(300000).default(21600000),
  debounceMs: z.number().min(100).default(500),
  watchEnabled: z.boolean().default(true),
  lField: z.object({
    enabled: z.boolean().default(true),
    refreshMs: z.number().min(30000).default(120000),
    historyDays: z.number().min(1).default(30),
  }).default({ enabled: true, refreshMs: 120000, historyDays: 30 }),
})

export function apply(ctx: Context, config: Config): void {
  const vaultRoot = config.vaultRoot
  if (vaultRoot === '') {
    console.warn('[nexus] Config.vaultRoot 未配置——只启动 REST，不扫描/监听（面板显示空数据）')
  }

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // M4-N 改名迁移（一次性，2026-08-31）：旧数据目录 xuegulin/xuegu.db → nexus/nexus.db。
  // 目录整体搬迁（含 wal/shm）；仅在旧存在且新缺失时执行——新库已建则不动，绝不覆盖。
  const legacyDir = join(dshHome, 'xuegulin')
  if (existsSync(legacyDir)) {
    const nexusDir = join(dshHome, 'nexus')
    if (!existsSync(nexusDir)) renameSync(legacyDir, nexusDir)
    const legacyDb = join(nexusDir, 'xuegu.db')
    if (existsSync(legacyDb)) {
      const newDb = join(nexusDir, 'nexus.db')
      if (!existsSync(newDb)) renameSync(legacyDb, newDb)
    }
  }
  // M4.3：initialRoot = config.vaultRoot（仅种子/升级兜底；此后指向由 vault_config 表驱动）
  const store = openStore(join(dshHome, 'nexus', 'nexus.db'), vaultRoot)
  ctx.effect(() => () => store.close())
  const activeRoot = (): string => store.activeRoot()

  let scanning = false
  const runScan = async (): Promise<void> => {
    const root = activeRoot()
    if (root === '' || scanning) return
    scanning = true
    try {
      const result = await scanVault(store, root, config.exclude)
      if (result.scanned > 0 || result.created > 0) {
        console.log(`[nexus] 扫描完成（${root}）：${result.scanned} 文件（+${result.created} 新 / 更新 ${result.updated} / 删除 ${result.removed}）`)
      }
    } catch (e) {
      console.error('[nexus] 扫描失败：', String(e))
    } finally {
      scanning = false
    }
  }
  void runScan()

  // 周期校准（兜底 watcher 漏事件）；effect 卸载清理
  ctx.effect(() => {
    const timer = setInterval(() => { void runScan() }, config.pollIntervalMs)
    return () => clearInterval(timer)
  })

  // 编辑监听（主事件源；M4.3 起跟随当前指向——root 变更事件触发重挂）
  ctx.effect(() => {
    let disposeWatch: (() => void) | null = null
    const mount = (): void => {
      disposeWatch?.()
      disposeWatch = null
      if (!config.watchEnabled) return
      const root = activeRoot()
      if (root === '') return
      disposeWatch = startVaultWatch(store, { root, exclude: config.exclude, debounceMs: config.debounceMs })
    }
    mount()
    const on = (ctx.on as unknown as CtxOnAny).bind(ctx)
    const off = on(VAULT_ROOT_CHANGED, () => { mount(); void runScan() })
    return () => { off(); disposeWatch?.() }
  }, 'nexus: vault watch (root-aware)')

  // REST（面板数据 + rescan 触发；M2 读数/标注；M4.3 vault 指向）
  const emitVaultChanged = (ctx.emit as unknown as (event: string, ...args: unknown[]) => void).bind(ctx)
  ctx.effect(() => registerNexusRoutes(ctx, {
    store,
    onRescan: () => { void runScan() },
    onVaultChanged: () => { emitVaultChanged(VAULT_ROOT_CHANGED) },
    m2HistoryDays: config.lField.historyDays,
  }), 'nexus: routes')

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
          // M4-L：会话发起时的 workspace（cwd）——知识库会话判定依据
          const cwd = typeof s?.header?.cwd === 'string' ? s.header.cwd : undefined
          collector.handle(sid, event as TurnEventLike, cwd)
        }
      } catch (e) {
        console.error('[nexus] turn collect failed', String(e))
      }
    })
  }, 'nexus: session events (M2)')

  // M3-F.1：A 腿二自评工具（agent 每轮即时自评三行；手写 def 零运行时依赖）
  ctx.effect(() => {
    const toolCtx = ctx as unknown as { tools: { register(def: unknown): void } }
    registerSelfCheckTool(toolCtx, store)
    return () => undefined
  }, 'nexus: selfcheck tool (M3-F.1)')

  console.log('[nexus] M1 观测启动（vault=' + (vaultRoot || '<未配置>') + '）')
  console.log('[nexus] M2 turn 采集启动（官方 session/event 直采' + (config.lField.enabled ? '' : ' · lField 已禁用') + '）')
  console.log('[nexus] M3-F 就绪（自评工具 / B 方案原文 / 白盒分析）')
}
