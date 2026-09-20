/**
 * @dsh-external/dsh-nautilus — OS 层心跳档位控件（1s / 5s / 手动）。
 *
 * 放在独立文件：工作台主文件由守谷人并行优化，控件以组件形式插入，避免互相改同一段代码。
 * 契约：POST /api/nautilus/pulse/control
 *   { intervalMs: 1000 | 5000 }  → 定时档
 *   { mode: 'manual' }           → 手动档（停定时器）
 *   { sample: true }             → 立即采一次（任何档位可用）
 * 只改采集节律；读数本身仍由同一条 tick 路径写入（同库同表），不产生第二套口径。
 */
import { createElement, useState, type ReactNode } from 'react'

export type PulseMode = 'auto' | 'manual'

/** 可选档位（UI 暴露的固定档；接口本身接受 1000–600000ms）。 */
export const PULSE_TIERS: Array<{ ms: number; label: string }> = [
  { ms: 1000, label: '1 s' },
  { ms: 5000, label: '5 s' },
]

export interface PulseHeartbeatProps {
  mode: PulseMode
  intervalMs: number
  /** 抽屉打开等暂停期间禁用（与取数轮询同一口径）。 */
  paused?: boolean
  /** 结果回执（toast）。 */
  onDone: (msg: string) => void
  /** 控制成功后立刻重取一次读数，不必等下一个轮询周期。 */
  reload: () => void
}

async function postControl(body: Record<string, unknown>): Promise<{ ok: boolean; msg: string }> {
  try {
    const r = await fetch('/api/nautilus/pulse/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    })
    const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; collector?: { mode?: string; intervalMs?: number; ticks?: number } } | null
    if (!r.ok || j === null || j.ok !== true) return { ok: false, msg: '心跳设置失败：HTTP ' + String(r.status) + (j?.error === undefined ? '' : ' · ' + j.error) }
    const mode = j.collector?.mode ?? '?'
    const ms = j.collector?.intervalMs ?? 0
    return { ok: true, msg: '心跳 → ' + (mode === 'manual' ? '手动' : String(ms / 1000) + ' s') + '（tick ' + String(j.collector?.ticks ?? 0) + '）' }
  } catch (e) {
    return { ok: false, msg: '心跳设置失败：' + String(e) }
  }
}

/** 心跳档位控件：1s / 5s / 手动（+ 手动档下的「采一次」）。 */
export function PulseHeartbeat(props: PulseHeartbeatProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const manual = props.mode === 'manual'
  const run = (body: Record<string, unknown>): void => {
    if (props.paused === true || busy) return
    setBusy(true)
    void postControl(body).then((res) => {
      props.onDone(res.msg)
      if (res.ok) props.reload()
    }).finally(() => setBusy(false))
  }
  return createElement('div', { className: 'nt-hb' },
    createElement('span', { className: 'nt-hb-lab' }, '心跳'),
    ...PULSE_TIERS.map((t) => createElement('button', {
      key: String(t.ms),
      className: 'nt-btn' + (!manual && props.intervalMs === t.ms ? ' on' : ''),
      disabled: busy || props.paused === true,
      onClick: () => run({ intervalMs: t.ms }),
    }, t.label)),
    createElement('button', {
      className: 'nt-btn' + (manual ? ' on' : ''),
      disabled: busy || props.paused === true,
      onClick: () => run({ mode: 'manual' }),
    }, '手动'),
    manual
      ? createElement('button', {
        className: 'nt-btn',
        disabled: busy || props.paused === true,
        onClick: () => run({ mode: 'manual', sample: true }),
      }, busy ? '采样中…' : '采一次')
      : null,
    createElement('span', { className: 'nt-hb-now' }, manual ? '手动档' : '自动 ' + String(Math.round(props.intervalMs / 1000)) + ' s'),
  )
}
