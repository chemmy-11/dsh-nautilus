/**
 * @dsh-external/dsh-nautilus — client entry（只剩工作台：全局面板 + 侧栏图标）。
 *
 * 沿革：2026-09-27 vault 观测腿下线（Vault 观测 tab 删除）；同日 L 场读数能力**搬进工作台**
 * （视图两态 / 指向切换 / 累计输入 / 轮次轴 / 自评覆盖，见 workbench.ts），故逐会话的
 * 「L 场读数」tab 一并删除——客户端半区只保留工作台这一个入口面。
 *
 * dsh 客户端入口契约：
 *  - 客户端插件就是普通 Cordis 插件（Context 来自 @deepseek-ai/cordis）；
 *  - UI 注册表 ctx.slots 由 @deepseek-ai/dsh-client-ui-renderer 提供；
 *  - 只允许 type-only 跨插件导入；运行时只 require 基线 react；
 *  - 产物由 scripts/build-client.mjs 打成 lazy-CJS factory（window.__ModuleLoader__.load）。
 */
import { createElement, type ReactNode } from 'react'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client' // 主区面板 id 的 branded 类型（main keyed）
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client' // 拉 sidebar.panellist SlotMap 类型
// 工作台（全局面板）：五视图 + 抽屉 + era 条，规格见 docs/2-dev/nautilus-dev-02-ui-workbench.md
import { Workbench, WorkbenchIcon, WORKBENCH_ID, WORKBENCH_LABEL } from './workbench'
// 令牌层（U2：--nt-* 亮暗双主题跟随 DSH）——在 apply() 就注入：侧栏图标在 .nt-wb 之外也要吃到令牌
import { ensureNautilusTheme } from './theme'
// 流内契合打分件（T 系列 D-T5）：conversation.chat.turnTail 链槽，契约见 dev-05 §3
import { registerTurnFit } from './turn-annotate'

/** 路径末段（会话名解析用；不含尾部分隔符）。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== '')
  return parts.length === 0 ? p : parts[parts.length - 1]
}

// layout 是**必需**服务（主区面板的返回会话要走 ctx.layout.selectPanel(null)）；
// 它同时是 sidebar.panellist 两个槽位之一的声明方，缺席时本插件本就无法工作。
export const inject = ['slots', 'layout']

export function apply(ctx: {
  effect(callback: () => unknown, name: string): unknown
  get?(name: string): unknown
  slots: {
    inject(key: string, callback: () => unknown): unknown
    register(def: Record<string, unknown>, component: unknown): unknown
  }
  layout: { selectPanel(id: unknown): void }
}): void {
  ensureNautilusTheme()
  // 会话名解析（dsh 工作区名）：sessions 为可选服务（dsh-api-session-controller），按 AGENTS.md 用 ctx.get。
  // 读取面（0.1.5-rc.2 实证，task-board 同款）：sessions.list.getSnapshot() → SessionListState
  //   { ids, byId: Record<sessionId, SessionSummary>, current, phase }；
  // SessionSummary { id, cwd?, displayTitle, title? }——名称取 cwd 末段（工作区目录名），回退 displayTitle/title/短 id。
  const sessionNameOf = (id: string): { name: string; title: string } | null => {
    const svc = ctx.get?.('sessions') as { list?: { getSnapshot?: () => unknown } } | undefined
    const getSnap = svc?.list?.getSnapshot
    if (typeof getSnap !== 'function') return null
    const state = getSnap.call(svc?.list) as { byId?: Record<string, { cwd?: unknown; displayTitle?: unknown; title?: unknown }> } | null
    const row = state?.byId?.[id]
    if (row === undefined || row === null) return null
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    const display = typeof row.displayTitle === 'string' ? row.displayTitle : ''
    const title = typeof row.title === 'string' && row.title !== '' ? row.title : display
    const ws = cwd === '' ? '' : baseName(cwd)
    return { name: ws === '' ? (title === '' ? id.slice(0, 8) : title) : ws, title }
  }

  // 工作台入口（§3.0 实测契约）：sidebar.panellist 的 list id 与 main 的 key 同值——同一条记录既提供侧栏图标行，
  // 又提供主区面板；侧栏壳自己渲染按钮并调 layout.selectPanel(id)，故此处不注册任何点击逻辑。
  // WorkbenchIcon 收 { size, active }（SidebarPanelIconOwnerProps）；Workbench 收全局标准 props 并忽略之。
  const panelId = WORKBENCH_ID as unknown as MainPanelId
  ctx.effect(
    () => ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({
        name: 'sidebar.panellist',
        id: panelId,
        order: 50,
        label: () => WORKBENCH_LABEL,
      }, WorkbenchIcon),
    ),
    '@dsh-external/dsh-nautilus: workbench icon',
  )
  ctx.effect(
    () => ctx.slots.inject('main', () =>
      // 主区槽位是 keyed 槽（DSH contract: { kind: 'keyed', scope: 'root' }），
      // 必须给 options.key；给 id 会抛 "keyed slot main requires options.key"
      // 并让整个浏览器半区插件集挂载失败。key 与 sidebar.panellist 的 id 同值。
      // 注入「返回会话」：主区一旦选中全局面板，会话列就不再可见，必须有回到 Conversation 的入口
      // （layout 契约：selectPanel(null) = 显示当前会话）。
      ctx.slots.register({ name: 'main', key: panelId }, (): ReactNode =>
        createElement(Workbench, {
          onExitToConversation: () => { ctx.layout.selectPanel(null) },
          sessionNameOf,
        })),
    ),
    '@dsh-external/dsh-nautilus: workbench panel',
  )
  // 流内契合打分件（D-T5）：会话轮末打分，标注走同源 POST /m2/turn-annotations（守谷人专用）
  registerTurnFit(ctx)
}
