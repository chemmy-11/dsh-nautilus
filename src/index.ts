/**
 * @dsh-external/dsh-xuegulin — plugin entry (M1: vault metadata + edit stats + observation panel).
 * apply: open store → full scan (startup + periodic calibration) → fs.watch (effect) → REST (effect).
 * All tunables live in Config; zero writes into the vault (data lives in ~/.dsh/xuegulin/).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver' // 拉声明合并获得 ctx.webServer 类型
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { openStore } from './store.js'
import { scanVault } from './scan.js'
import { startVaultWatch } from './watch.js'
import { registerXuegulinRoutes } from './routes.js'

export const name = 'xuegulin'
export const inject = ['webServer']

export interface Config {
  vaultRoot: string
  exclude: string[]
  pollIntervalMs: number
  debounceMs: number
  watchEnabled: boolean
}

export const Config = z.object({
  vaultRoot: z.string().default(''),
  exclude: z.array(z.string()).default(['dsh-docs']),
  pollIntervalMs: z.number().min(300000).default(21600000),
  debounceMs: z.number().min(100).default(500),
  watchEnabled: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const vaultRoot = config.vaultRoot
  if (vaultRoot === '') {
    console.warn('[xuegulin] Config.vaultRoot 未配置——只启动 REST，不扫描/监听（面板显示空数据）')
  }

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const store = openStore(join(dshHome, 'xuegulin', 'xuegu.db'))
  ctx.effect(() => () => store.close())

  let scanning = false
  const runScan = async (): Promise<void> => {
    if (vaultRoot === '' || scanning) return
    scanning = true
    try {
      const result = await scanVault(store, vaultRoot, config.exclude)
      if (result.scanned > 0 || result.created > 0) {
        console.log(`[xuegulin] 扫描完成：${result.scanned} 文件（+${result.created} 新 / 更新 ${result.updated} / 删除 ${result.removed}）`)
      }
    } catch (e) {
      console.error('[xuegulin] 扫描失败：', String(e))
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

  // 编辑监听（主事件源）
  ctx.effect(() => {
    if (!config.watchEnabled || vaultRoot === '') return () => undefined
    return startVaultWatch(store, {
      root: vaultRoot,
      exclude: config.exclude,
      debounceMs: config.debounceMs,
    })
  }, 'xuegulin: vault watch')

  // REST（面板数据 + rescan 触发）
  ctx.effect(() => registerXuegulinRoutes(ctx, { store, onRescan: () => { void runScan() } }), 'xuegulin: routes')

  console.log('[xuegulin] M1 观测启动（vault=' + (vaultRoot || '<未配置>') + '）')
}
