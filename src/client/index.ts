/**
 * @dsh-external/dsh-xuegulin — client observation panel (conversation.view tab, official contract).
 * Reference ui-trajectory: ctx.slots.inject('conversation.view', () => ctx.slots.register(def, ReactComponent)).
 * Data channel: same-origin REST GET /api/xuegulin/state (host routes.ts), 30s polling.
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client' // 拉 conversation.view SlotMap 类型

type XuegulinState = {
  revision: number
  totals: { totalFiles: number; totalChars: number }
  today: { edits: number; modifiedFiles: number; createdFiles: number; topActive: Array<{ path: string; edits: number }> }
  week: { edits: number; modifiedFiles: number; createdFiles: number; topActive: Array<{ path: string; edits: number }> }
  recent: Array<{ ts: number; path: string; kind: string }>
}

export const inject = ['slots']

function XuegulinView(): ReactNode {
  const [state, setState] = useState<XuegulinState | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      fetch('/api/xuegulin/state', { headers: { 'sec-fetch-site': 'same-origin' } })
        .then((r) => (r.ok ? (r.json() as Promise<XuegulinState>) : Promise.resolve(null)))
        .then((s) => { if (alive) { setState(s); setFailed(s === null) } })
        .catch(() => { if (alive) { setState(null); setFailed(true) } })
    }
    load()
    const timer = setInterval(load, 30000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const style = { padding: '12px', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' as const }
  if (failed && state === null) {
    return createElement('div', { style }, 'Vault 观测数据不可用（/api/xuegulin/state）')
  }
  if (state === null) return createElement('div', { style }, 'Vault 观测加载中...')

  const lines: string[] = []
  lines.push(`文件总数：${state.totals.totalFiles}   总字数：${state.totals.totalChars}`)
  lines.push(`今日：${state.today.edits} 次编辑 / ${state.today.modifiedFiles} 个修改文件 / +${state.today.createdFiles} 新增`)
  lines.push(`本周：${state.week.edits} 次编辑 / ${state.week.modifiedFiles} 个修改文件 / +${state.week.createdFiles} 新增`)
  if (state.today.topActive.length > 0) {
    lines.push('今日活跃 Top：')
    for (const t of state.today.topActive) lines.push(`  ${t.edits} 次  ${t.path}`)
  }
  lines.push('最近编辑：')
  for (const ev of state.recent.slice(0, 10)) {
    const d = new Date(ev.ts)
    lines.push(`  [${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}] ${ev.kind} ${ev.path}`)
  }
  return createElement('div', { style }, createElement('pre', undefined, lines.join('\n')))
}

export function apply(ctx: { slots: { inject(key: string, callback: () => unknown): unknown } }): void {
  ctx.effect(
    () => ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: '@dsh-external/dsh-xuegulin-panel',
        order: 30,
        label: () => 'Vault 观测',
      }, XuegulinView),
    ),
    '@dsh-external/dsh-xuegulin: panel',
  )
}
