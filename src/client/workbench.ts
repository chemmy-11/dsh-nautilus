/**
 * @dsh-external/dsh-nautilus — Nautilus 工作台（全局面板，S4「瑞士制图」）。
 *
 * 规格：docs/2-dev/nautilus-dev-02-ui-workbench.md（§2 令牌 / §3 五视图+抽屉+era 条 / §4 组件 / §5 人工标注 / §6 数据契约）
 * 入口：sidebar.panellist 图标（root）+ main keyed 面板（root），两者 id 同值 = MainPanelId（§3.0 实测契约）。
 *
 * 数据口径（只读；唯一写操作是预言标注 POST /m2/annotations）：
 *   · NEXUS 层：/api/nautilus/m2/state（逐轮读数/曲线/自评覆盖）· /api/nautilus/m2/analysis（白盒）
 *   · PULSE 层：/api/nautilus/pulse/state（每指标最新值 + 采集器健康度）
 *   · INFER 层：Phase 2a 才落库（TTFT/provider）——当前所有视图显示缺席态，不编造、不写 0 假读数
 * 空数据是正常态（本阶段允许）。
 */
import { Component, createElement, useEffect, useRef, useState, type ReactNode } from 'react'
// OS 层心跳档位控件（1s / 5s / 手动）——独立文件，避免与并行 UI 改动冲突
import { PulseHeartbeat } from './pulse-controls'
// 图表原语（Grafana/Netdata/Datadog 语法借鉴，零依赖自绘；全部无 hooks，可直调）
import { BarGauge, MiniChart, Sparkline, StackedBars, StateBand, TopList } from './charts'
// A 系列：OS 层红线告警视图 + 图标徽标（活跃即闪红）；独立文件，避免与本文件的长历史并写冲突
import { AlertsView, ensureAlertStyle, useAlertBadge, type AlertsState } from './alerts'

export const WORKBENCH_ID = 'nautilus-workbench'

// ── 样式（--nt-* 令牌由 index.ts 注入；此处只补工作台专属类）───────────────────

let styleDone = false
const CSS_LINES = [
  '.nt-wb{position:relative;display:flex;flex-direction:column;height:100%;min-width:0;background:var(--nt-bg,#f2f2f0);color:var(--nt-text,#101010);font-family:var(--nt-font,Helvetica,Arial,sans-serif)}',
  '.nt-wb-top{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:2px solid var(--nt-text,#101010);background:var(--nt-panel,#fff);flex-wrap:wrap}',
  '.nt-wb-brand{font-size:15px;font-weight:700;letter-spacing:2.5px}',
  '.nt-wb-brand small{display:block;font-size:9px;letter-spacing:1.5px;font-weight:400;color:var(--nt-faint,#9a9a95);text-transform:uppercase}',
  '.nt-wb-seg{display:flex;border:1px solid var(--nt-border,#d9d9d5)}',
  '.nt-wb-seg button{border:0;background:transparent;color:var(--nt-dim,#5f5f5c);font-size:11px;letter-spacing:1.5px;padding:5px 11px;cursor:pointer;text-transform:uppercase}',
  '.nt-wb-seg button.on{background:var(--nt-text,#101010);color:var(--nt-panel,#fff)}',
  '.nt-wb-right{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:1.5px;color:var(--nt-faint,#9a9a95);text-transform:uppercase}',
  '.nt-hb{display:flex;align-items:center;gap:4px}',
  '.nt-hb-lab{font-size:9px;letter-spacing:2px;color:var(--nt-faint,#9a9a95)}',
  '.nt-hb-now{font-size:9px;letter-spacing:1px;color:var(--nt-dim,#5f5f5c);min-width:56px}',
  '.nt-era{display:flex;align-items:center;gap:10px;padding:6px 16px;border-bottom:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel2,#f7f7f5);font-size:10px;letter-spacing:1.2px;color:var(--nt-dim,#5f5f5c);flex-wrap:wrap}',
  '.nt-era .badge{border:1px solid var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e);padding:1px 6px;letter-spacing:2px}',
  '.nt-wb-body{flex:1;overflow:auto;padding:14px 16px}',
  '.nt-wb-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
  '@media (max-width:1080px){.nt-wb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '.nt-stat{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);padding:9px 11px;position:relative;border-radius:2px}',
  '.nt-stat .layer{position:absolute;top:7px;right:9px;font-size:8.5px;letter-spacing:1.5px;color:var(--nt-faint,#9a9a95)}',
  '.nt-stat .lab{font-size:9px;letter-spacing:2px;color:var(--nt-dim,#5f5f5c);text-transform:uppercase}',
  '.nt-stat .val{font-size:25px;font-weight:300;line-height:1.15;font-variant-numeric:tabular-nums}',
  '.nt-stat .val.warn{color:var(--nt-accent,#e6321e)}',
  '.nt-stat .note{font-size:10px;color:var(--nt-faint,#9a9a95)}',
  '.nt-panel{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);border-radius:2px;margin-top:12px}',
  '.nt-panel > h4{margin:0;padding:8px 11px;border-bottom:1px solid var(--nt-border,#d9d9d5);font-size:10px;letter-spacing:2px;text-transform:uppercase;display:flex;gap:8px;align-items:center}',
  '.nt-panel > h4 em{font-style:normal;color:var(--nt-faint,#9a9a95);letter-spacing:1.5px}',
  '.nt-panel .body{padding:10px 11px}',
  '.nt-note{margin:8px 0 0;padding:6px 9px;border-left:2px solid var(--nt-border2,#c8c8c3);font-size:10.5px;color:var(--nt-dim,#5f5f5c);line-height:1.55}',
  '.nt-tbl{width:100%;border-collapse:collapse;font-size:11px}',
  '.nt-tbl th{text-align:left;font-size:9px;letter-spacing:1.5px;color:var(--nt-faint,#9a9a95);text-transform:uppercase;border-bottom:1px solid var(--nt-border,#d9d9d5);padding:4px 6px;font-weight:500}',
  '.nt-tbl td{border-bottom:1px solid var(--nt-border,#d9d9d5);padding:4px 6px;font-variant-numeric:tabular-nums}',
  '.nt-tbl tr.clickable{cursor:pointer}',
  '.nt-tbl tr.clickable:hover td{background:var(--nt-panel2,#f7f7f5)}',
  '.nt-tag{font-size:9px;letter-spacing:1px;border:1px solid var(--nt-border2,#c8c8c3);padding:0 4px;color:var(--nt-dim,#5f5f5c)}',
  '.nt-tag.red{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-empty{padding:14px;text-align:center;color:var(--nt-faint,#9a9a95);font-size:11px;letter-spacing:1px}',
  '.nt-drawer{position:fixed;top:0;right:0;width:400px;max-width:92vw;height:100vh;background:var(--nt-panel,#fff);border-left:1px solid var(--nt-border,#d9d9d5);z-index:40;display:flex;flex-direction:column}',
  '.nt-drawer .dh{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--nt-border,#d9d9d5);font-size:11px;letter-spacing:1.5px;text-transform:uppercase}',
  '.nt-drawer .dh button{margin-left:auto}',
  '.nt-drawer .db{flex:1;overflow:auto;padding:12px 14px}',
  '.nt-drawer h5{font-size:9.5px;letter-spacing:2px;color:var(--nt-faint,#9a9a95);margin:14px 0 5px;text-transform:uppercase}',
  '.nt-scrim{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:39}',
  '.nt-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--nt-text,#101010);color:var(--nt-panel,#fff);font-size:11px;letter-spacing:1px;padding:7px 14px;border-radius:2px;z-index:60}',
  '.nt-card{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);border-radius:2px;padding:10px 12px;margin-top:10px}',
  '.nt-card .hd{display:flex;gap:8px;align-items:center;font-size:12px}',
  '.nt-card .hd b{letter-spacing:1px}',
  '.nt-card .st{font-size:9px;letter-spacing:1.5px;border:1px solid var(--nt-border2,#c8c8c3);padding:0 5px;color:var(--nt-dim,#5f5f5c)}',
  '.nt-card .st.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-card p{margin:7px 0 0;font-size:11.5px;line-height:1.6;color:var(--nt-dim,#5f5f5c)}',
  '.nt-report{max-width:820px;margin:0 auto}',
  '.nt-report .meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:11px;border:1px solid var(--nt-border,#d9d9d5);padding:10px 12px;background:var(--nt-panel2,#f7f7f5)}',
  '.nt-report .meta b{font-weight:500;color:var(--nt-faint,#9a9a95);letter-spacing:1px;text-transform:uppercase;font-size:9.5px}',
  '.nt-report .prose{font-family:Georgia,serif;font-size:13px;line-height:1.95;margin-top:12px}',
  '.nt-report .gate{margin-top:14px;border:1px solid var(--nt-accent,#e6321e);padding:10px 12px;font-size:11px;display:flex;gap:10px;align-items:center}',
  '.nt-btn{border:1px solid var(--nt-border2,#c8c8c3);background:transparent;color:var(--nt-text,#101010);font-size:11px;padding:3px 9px;cursor:pointer;border-radius:2px}',
  '.nt-btn:hover{border-color:var(--nt-text,#101010)}',
  '.nt-btn.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e)}',
  '.nt-select,.nt-input{border:1px solid var(--nt-border2,#c8c8c3);background:var(--nt-panel,#fff);color:var(--nt-text,#101010);font-size:11px;padding:3px 6px;border-radius:2px}',
  '.nt-wb-pickwrap{position:relative;display:inline-block}',
  '.nt-wb-picker{position:absolute;top:calc(100% + 6px);left:0;width:380px;max-width:88vw;max-height:360px;overflow:auto;background:var(--nt-panel,#fff);border:1px solid var(--nt-border2,#c8c8c3);box-shadow:0 8px 26px rgba(0,0,0,.16);z-index:30}',
  '.nt-wb-picker .row{padding:7px 10px;border-bottom:1px solid var(--nt-border,#d9d9d5);cursor:pointer;border-left:2px solid transparent}',
  '.nt-wb-picker .row:hover{background:var(--nt-panel2,#f7f7f5)}',
  '.nt-wb-picker .row.on{border-left-color:var(--nt-accent,#e6321e)}',
  '.nt-wb-picker .row .nm{font-weight:700;letter-spacing:.5px;font-size:11.5px}',
  '.nt-wb-picker .row.on .nm{color:var(--nt-accent,#e6321e)}',
  '.nt-wb-picker .row .mt{color:var(--nt-faint,#9a9a95);font-size:10px;font-variant-numeric:tabular-nums}',
  '.nt-wb-scrim2{position:fixed;inset:0;z-index:29}',
  '.nt-chart{position:relative;cursor:crosshair}',
  '.nt-tip{position:absolute;z-index:35;background:var(--nt-panel,#fff);border:1px solid var(--nt-border2,#c8c8c3);box-shadow:0 4px 16px rgba(0,0,0,.16);padding:7px 9px;font-size:10.5px;color:var(--nt-text,#101010);pointer-events:none;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.6}',
  '.nt-tip .dim{color:var(--nt-faint,#9a9a95)}',
  // ── 图表语法升级（2026-09-20 方案 A）：gauge / 小图网格 / 状态带 / 排行 / 图例 ──
  '.nt-gauges{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0 2px}',
  '@media (max-width:1080px){.nt-gauges{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '.nt-gauge .lr{display:flex;justify-content:space-between;align-items:baseline;font-size:9.5px;letter-spacing:1.2px;color:var(--nt-dim,#5f5f5c);margin-bottom:3px;text-transform:uppercase}',
  '.nt-gauge .vl{font-variant-numeric:tabular-nums;letter-spacing:0;color:var(--nt-text,#101010);font-size:10.5px}',
  '.nt-gauge .vl.warn{color:var(--nt-accent,#e6321e)}',
  '.nt-gauge .tr{position:relative;height:10px;border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel2,#f7f7f5)}',
  '.nt-gauge .fl{position:absolute;top:0;bottom:0;left:0;background:var(--nt-ink,#101010)}',
  '.nt-gauge .fl.warn{background:var(--nt-accent,#e6321e)}',
  '.nt-gauge .th{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--nt-accent,#e6321e);opacity:.75}',
  '.nt-famhd{display:flex;align-items:center;gap:8px;font-size:9px;letter-spacing:2px;color:var(--nt-faint,#9a9a95);text-transform:uppercase;margin:12px 0 6px}',
  '.nt-famhd::after{content:"";flex:1;height:1px;background:var(--nt-border,#d9d9d5)}',
  '.nt-mini{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
  '@media (max-width:1080px){.nt-mini{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '.nt-mini .cell{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);padding:6px 8px 4px}',
  '.nt-mini .cl{display:flex;justify-content:space-between;align-items:baseline;font-size:9px;letter-spacing:1.2px;color:var(--nt-dim,#5f5f5c);text-transform:uppercase;margin-bottom:3px}',
  '.nt-mini .cl .cv{font-size:11px;letter-spacing:0;font-variant-numeric:tabular-nums;color:var(--nt-text,#101010);text-transform:none}',
  '.nt-mini-empty{text-align:center;color:var(--nt-faint,#9a9a95);font-size:10px;padding:10px 4px;border:1px dashed var(--nt-border,#d9d9d5)}',
  '.nt-readout{font-size:10.5px;color:var(--nt-dim,#5f5f5c);font-variant-numeric:tabular-nums;min-height:15px}',
  '.nt-band .ln{display:flex;align-items:center;gap:8px;margin:3px 0}',
  '.nt-band .lb{flex:0 0 160px;font-size:10px;color:var(--nt-dim,#5f5f5c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.nt-band .tk{position:relative;flex:1;height:12px;background:var(--nt-panel2,#f7f7f5);border:1px solid var(--nt-border,#d9d9d5)}',
  '.nt-band .tk i{position:absolute;top:0;bottom:0;background:var(--nt-ink,#101010);opacity:.5}',
  '.nt-band .ax{display:flex;justify-content:space-between;font-size:9px;color:var(--nt-faint,#9a9a95);margin-top:4px;font-variant-numeric:tabular-nums}',
  '.nt-top .rw{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px}',
  '.nt-top .ix{flex:0 0 18px;font-size:9px;color:var(--nt-faint,#9a9a95);font-variant-numeric:tabular-nums}',
  '.nt-top .lb{flex:0 0 220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.nt-top .tk{position:relative;flex:1;height:12px;background:var(--nt-panel2,#f7f7f5);border:1px solid var(--nt-border,#d9d9d5)}',
  '.nt-top .tk i{position:absolute;top:0;bottom:0;left:0;background:var(--nt-ink,#101010);opacity:.8}',
  '.nt-top .vl{flex:0 0 110px;text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--nt-dim,#5f5f5c)}',
  '.nt-legend{display:flex;align-items:center;gap:12px;font-size:10px;color:var(--nt-dim,#5f5f5c);margin:2px 0 6px;flex-wrap:wrap}',
  '.nt-legend span{display:inline-flex;align-items:center;gap:4px}',
  '.nt-legend i{width:9px;height:9px;display:inline-block}',
  // ── 布局二次修订（2026-09-20 反馈）：主图 2×2 + 原生折叠面板 ──
  '.nt-maingrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}',
  '@media (max-width:1080px){.nt-maingrid{grid-template-columns:repeat(1,minmax(0,1fr))}}',
  '.nt-maincell{border:1px solid var(--nt-border,#d9d9d5);background:var(--nt-panel,#fff);padding:8px 10px;border-radius:2px}',
  '.nt-maincell .mh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:10px;letter-spacing:1.5px;color:var(--nt-dim,#5f5f5c);text-transform:uppercase;margin-bottom:4px}',
  '.nt-maincell .mh .mv{font-size:13px;letter-spacing:0;color:var(--nt-text,#101010);font-variant-numeric:tabular-nums;text-transform:none;white-space:nowrap}',
  '.nt-maincell .mh .hint{font-size:9px;letter-spacing:.5px;color:var(--nt-faint,#9a9a95);text-transform:none;white-space:nowrap}',
  '.nt-collapse > summary{display:flex;gap:8px;align-items:center;margin:0;padding:8px 11px;border-bottom:1px solid var(--nt-border,#d9d9d5);font-size:10px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;list-style:none;user-select:none}',
  '.nt-collapse > summary::-webkit-details-marker{display:none}',
  '.nt-collapse > summary em{font-style:normal;color:var(--nt-faint,#9a9a95);letter-spacing:1.5px}',
  '.nt-collapse > summary::after{content:"▾";margin-left:auto;color:var(--nt-faint,#9a9a95);transition:transform .12s ease}',
  '.nt-collapse[open] > summary::after{transform:rotate(180deg)}',
  '.nt-collapse:not([open]) > summary{border-bottom-color:transparent}',
]

function injectWorkbenchStyle(): void {
  if (styleDone || typeof document === 'undefined') return
  styleDone = true
  const el = document.createElement('style')
  el.id = 'nt-workbench-style'
  el.textContent = CSS_LINES.join(String.fromCharCode(10))
  document.head.appendChild(el)
}

// ── era 措辞分级（集中常量：避免「对照/归因」裸串漂移）──────────────────────────

export type Era = 'api' | 'local'
/** era → 因果强度措辞：api 时代只能说「对照」（弱因果），local 才能说「归因」。 */
export function eraWord(era: Era): string { return era === 'api' ? '对照' : '归因' }
/** era 判定依据与对照集规则的说明文案。 */
export function eraNote(era: Era): string {
  return era === 'api'
    ? 'era=api：应用层流量命中云端 API，本机资源与云端缓存命中率之间无因果通路——结论只用「对照」措辞，不作归因。'
    : 'era=local：本地推理栈落地后三层强因果闭合，可用「归因」措辞。（本地部署未落地，此处仅演示措辞分级）'
}

// ── 取数（只读轮询；抽屉打开时暂停——沿 M4.2 惯例）─────────────────────────────

export function useJson<T>(url: string, paused: boolean, intervalMs = 120000, nonce = 0): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      if (paused) return
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } })
        if (!r.ok) return
        const j = (await r.json()) as T
        if (alive) setData(j)
      } catch { /* 缺席：保留上一份 */ }
    }
    void load()
    const t = intervalMs > 0 ? setInterval(() => { void load() }, intervalMs) : null
    return () => { alive = false; if (t !== null) clearInterval(t) }
  }, [url, paused, intervalMs, nonce])
  return data
}

/**
 * PULSE 多指标序列（总览主图/小图用）：逐指标并行取 /pulse/series。
 * 刷新与心跳对齐：intervalMs = 心跳间隔（下限 1s）；手动档传 0 → 不轮询，靠 nonce（采样完成）触发重取。
 * 缺席指标 → null；metrics 为空（PULSE 层缺席）时不发请求。抽屉打开（paused）时暂停。
 */
export function usePulseSeriesMap(metrics: string[], paused: boolean, windowMs = 3600000, maxPoints = 240, intervalMs = 60000, nonce = 0): Record<string, PulseSeries | null> {
  const [map, setMap] = useState<Record<string, PulseSeries | null>>({})
  const key = metrics.join(',')
  useEffect(() => {
    if (key === '' || paused) return undefined
    let alive = true
    const names = key.split(',')
    const load = async (): Promise<void> => {
      try {
        const rs = await Promise.all(names.map(async (m) => {
          const r = await fetch('/api/nautilus/pulse/series?metric=' + encodeURIComponent(m) + '&windowMs=' + String(windowMs) + '&maxPoints=' + String(maxPoints), { headers: { accept: 'application/json' } })
          return r.ok ? ((await r.json()) as PulseSeries) : null
        }))
        if (alive) setMap(Object.fromEntries(names.map((m, i) => [m, rs[i] ?? null])))
      } catch { if (alive) setMap({}) }
    }
    void load()
    const t = intervalMs > 0 ? setInterval(() => { void load() }, intervalMs) : null
    return () => { alive = false; if (t !== null) clearInterval(t) }
  }, [key, paused, windowMs, maxPoints, intervalMs, nonce])
  return map
}

/**
 * 曲线刷新间隔与心跳对齐（守谷人 2026-09-20）：auto 档 = max(1s, 心跳间隔)；
 * 手动档 = 0（不轮询，采样完成经 nonce 触发重取）；PULSE 缺席 = 60s 兜底。
 */
export function heartbeatSeriesMs(collector: PulseState['collector'] | null | undefined): number {
  if (collector === null || collector === undefined) return 60000
  return collector.mode === 'manual' ? 0 : Math.max(1000, collector.intervalMs)
}
/** 心跳对齐的刷新说明文案（图注用）。 */
export function heartbeatRefreshLabel(collector: PulseState['collector'] | null | undefined): string {
  if (collector === null || collector === undefined) return 'PULSE 缺席，60 s 兜底'
  return collector.mode === 'manual' ? '手动档：采样完成后刷新' : String(Math.round(collector.intervalMs / 1000)) + ' s/次（随心跳档位）'
}

// ── 数据面类型（只取用到的字段）─────────────────────────────────────────────────

/** 单条最新采样（pulse store latest() 的行形状 + 路由 tags 解码结果）。 */
export type PulsePoint = { metric: string; value: number | null; ts: number; tags: unknown }
/** 单指标序列（pulse store series()：桶均值 + 桶内样本数）。 */
export type PulseSeries = { metric: string; from: number; to: number; windowMs: number; maxPoints: number; bucketMs: number; points: Array<{ ts: number; value: number; n: number }> }

export type PulseState = {
  collector: { ticks: number; lastTickTs: number | null; countersOk: boolean; gpuOk: boolean; shellPath: string | null; execAvailable: boolean; lastError: string | null; mode: 'auto' | 'manual'; intervalMs: number }
  db: { rows: number; oldestTs: number | null; newestTs: number | null; schemaVersion: number }
  latest: PulsePoint[]
}
export type M2Point = { session: string; turn: number; ts: number; tokenIn: number; tokenOut: number; cacheRead: number; durationMs: number | null; tps: number | null; missToken?: number | null; question?: string | null; clarity?: number | null; defense?: string | null; declaration?: number | null }
export type M2State = {
  pointing: string
  totals: { turns: number; tokenIn: number; tokenOut: number; cacheRead: number; missToken: number; hitRate: number | null }
  curve: M2Point[]
  recent: M2Point[]
  selfcheck: { checked: number; total: number; bySession?: Record<string, { checked: number; total: number; missing: number[] }> }
  sessionMeta: Record<string, { startTs: number; turns: number }>
}
export type Annotation = { prophecy: string; status: string; note: string | null; updatedAt: number }
export type AnnotationsState = { annotations: Annotation[] }

export const PROPHECY_SEED: Array<[string, string]> = [
  ['P1', '缓存未命中率随知识库会话推进下降（S 形）'],
  ['P2', '纯粹宣告轮次在自评 declaration 上可辨'],
  ['P3', '防御强度与未命中率同向变化'],
  ['P4', 'τ_e 在知识型会话中显著大于闲聊会话'],
  ['P5', 'TPS 与未命中率负相关（上下文越长解码越慢）'],
  ['P6', '指向工作区的会话未命中率高于非指向工作区'],
  ['P7', '同窗 CPU 尖峰与未命中率上升共存'],
  ['P8', 'GPU 显存占用与本地推理无关（api 时代）'],
  ['P9', '自评覆盖率提升不改变读数分布'],
]
export const STATUS_LABEL: Record<string, string> = { pending: '待标注', doing: '进行中', checked: '已检验' }

export const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1 }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
}
export const fmtTime = (ts: number | null | undefined): string => ts === null || ts === undefined ? '—' : new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
/** 月-日 时:分（会话看板/曲线 x 轴用）。 */
export const fmtDayTime = (ts: number | null | undefined): string => {
  if (ts === null || ts === undefined) return '—'
  const d = new Date(ts)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
export const fmtNum = (n: number | null | undefined, d = 2): string => n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d)
/** 令牌数 → k/M 缩写（累计输入/排行条的紧凑刻度）。 */
export const fmtK = (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

/** 指标名 → 中文标签（未知指标原样返回，不猜语义）。 */
export function metricLabel(metric: string): string {
  const table: Record<string, string> = {
    'cpu.utilization': 'CPU 利用率',
    'cpu.ctx_switches': '上下文切换',
    'mem.used': '内存占用',
    'mem.total': '内存总量',
    'mem.swap.used': '交换区占用',
    'disk.io_rate': '磁盘吞吐',
    'disk.queue': '磁盘队列',
    'net.io_rate': '网络吞吐',
    'proc.dsh.rss': '宿主进程 RSS',
    'proc.dsh.cpu': '宿主进程 CPU',
    'gpu.util': 'GPU 利用率',
    'gpu.mem.used': '显存占用',
    'gpu.mem.total': '显存总量',
    'gpu.temp': 'GPU 温度',
    'gpu.power': 'GPU 功耗',
  }
  const m = metric.replace(/^pulse[.]/, '')
  return table[m] ?? m
}

/** 指标名 → 分组（用于分组呈现与排序）。 */
export function metricGroup(metric: string): string {
  const m = metric.replace(/^pulse[.]/, '')
  const head = m.slice(0, m.indexOf('.'))
  const groups: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网络', proc: '进程', gpu: 'GPU' }
  return groups[head] ?? '其他'
}

/** 值 → 带量纲字符串。量纲逐个取自 src/pulse/collect.ts 与 src/pulse/counters.ts 的构造点；未知指标不猜，原样加标注。 */
export function fmtMetricValue(metric: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const m = metric.replace(/^pulse[.]/, '')
  if (m === 'gpu.util') return v.toFixed(0) + '%'
  if (m === 'cpu.utilization' || m === 'proc.dsh.cpu') return (v * 100).toFixed(1) + '%'
  if (m === 'gpu.mem.used' || m === 'gpu.mem.total') return v.toFixed(0) + ' MiB'
  if (m === 'gpu.temp') return v.toFixed(0) + ' °C'
  if (m === 'gpu.power') return v.toFixed(1) + ' W'
  if (m === 'cpu.ctx_switches') return v.toFixed(0) + ' /s'
  if (m === 'disk.queue') return v.toFixed(0)
  if (m === 'disk.io_rate' || m === 'net.io_rate') return fmtBytes(v) + '/s'
  if (m === 'mem.used' || m === 'mem.total' || m === 'mem.swap.used' || m === 'proc.dsh.rss') return fmtBytes(v)
  return String(v) + '（量纲未知）'
}

// ── 公共组件（§4）──────────────────────────────────────────────────────────

export function Stat(props: { layer: string; label: string; value: string; note?: string; warn?: boolean; spark?: Array<number | null> }): ReactNode {
  const sparkOk = props.spark !== undefined && props.spark.filter((v) => v !== null && Number.isFinite(v)).length >= 2
  return createElement('div', { className: 'nt-stat' },
    createElement('span', { className: 'layer' }, props.layer),
    createElement('div', { className: 'lab' }, props.label),
    createElement('div', { className: 'val' + (props.warn === true ? ' warn' : '') }, props.value),
    props.note !== undefined ? createElement('div', { className: 'note' }, props.note) : null,
    sparkOk ? createElement('div', { style: { marginTop: 6 } }, Sparkline({ values: props.spark, label: props.label })) : null,
  )
}

export function Panel(props: { title: string; fig?: string; note?: string; children?: ReactNode; collapsible?: boolean; defaultCollapsed?: boolean }): ReactNode {
  const head = [
    props.fig !== undefined ? createElement('em', { key: 'f' }, props.fig) : null,
    props.title,
  ]
  // 折叠用原生 <details>（无 hooks、SSR 友好）：次要看板默认收起，标题行仍可见
  if (props.collapsible === true) {
    return createElement('details', { className: 'nt-panel nt-collapse', open: props.defaultCollapsed !== true },
      createElement('summary', null, ...head),
      createElement('div', { className: 'body' }, props.children),
      props.note !== undefined ? createElement('p', { className: 'nt-note' }, props.note) : null,
    )
  }
  return createElement('div', { className: 'nt-panel' },
    createElement('h4', null, ...head),
    createElement('div', { className: 'body' }, props.children),
    props.note !== undefined ? createElement('p', { className: 'nt-note' }, props.note) : null,
  )
}

export function Empty(props: { text: string }): ReactNode { return createElement('div', { className: 'nt-empty' }, props.text) }

/**
 * 视图错误隔离：单个视图渲染抛错时只替换该视图，其余视图与 era 条照常可用。
 * 教训（2026-09-13 端上实测）：视图组件若被当普通函数调用，hooks 会算进父组件，
 * 切视图时 hooks 数量变化 → React 抛错 → **整页白屏**，症状是「按钮点了没反应」。
 */
export class ViewBoundary extends Component<{ label?: string; children?: ReactNode }, { error: string | null }> {
  constructor(props: { label?: string; children?: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(err: unknown): { error: string } { return { error: String(err) } }
  render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('div', { className: 'nt-panel' },
        createElement('h4', null, '视图渲染失败 · ' + String(this.props.label ?? '')),
        createElement('div', { className: 'body' },
          createElement('p', { className: 'nt-note' }, '该视图渲染时抛错，已隔离——其它视图与数据不受影响。错误原文：' + this.state.error),
          createElement('button', { className: 'nt-btn', onClick: () => this.setState({ error: null }) }, '重试渲染'),
        ),
      )
    }
    return this.props.children
  }
}

/** 单层曲线（SVG 自绘；S4 定稿视觉：发丝网格 + 墨线 + 朱红阈值/关键点 + τ_e 注记；点数不足 2 → 空态）。 */
export function Spark(props: {
  points: Array<{ x: number; y: number | null }>
  h?: number
  threshold?: number
  thresholdLabel?: string
  yFmt?: (v: number) => string
  anno?: { from: number; to: number; txt: string }
  label?: string
}): ReactNode {
  const pts = props.points.filter((p) => p.y !== null && Number.isFinite(p.y))
  if (pts.length < 2) return Empty({ text: '暂无数据' })
  const h = props.h ?? 150
  const w = 960
  const padL = 46
  const padR = 14
  const padT = 24
  const padB = 24
  const ys = pts.map((p) => p.y as number)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  const n = pts.length
  const sx = (i: number): number => padL + (i / Math.max(1, n - 1)) * (w - padL - padR)
  const sy = (v: number): number => h - padB - ((v - min) / span) * (h - padT - padB)
  const yf = props.yFmt ?? ((v: number): string => v.toFixed(1))
  const kids: ReactNode[] = []
  // 发丝网格 + y 刻度（4 档，定稿：左端小字）
  for (const r of [0, 1 / 3, 2 / 3, 1]) {
    const v = min + span * r
    const y = sy(v)
    kids.push(createElement('line', { key: 'g' + String(r), x1: padL, x2: w - padR, y1: y, y2: y, stroke: 'var(--nt-border,#d9d9d5)', strokeWidth: 1, opacity: 0.7 }))
    kids.push(createElement('text', { key: 't' + String(r), x: padL - 6, y: y + 3, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)', textAnchor: 'end' }, yf(v)))
  }
  // x 刻度（首/中/末）：显式 xTick 优先（轮次轴）；否则 x 为 epoch ms 时走时间格式（跨度 <36h 只显时分）
  if (n >= 3 && (props.xTick !== undefined || pts[0].x > 1e12)) {
    const spanMs = pts[n - 1].x - pts[0].x
    const short = spanMs < 36 * 3600000
    const xt = props.xTick ?? ((x: number): string => {
      const d = new Date(x)
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return short ? hm : String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm
    })
    for (const k of [0, Math.floor((n - 1) / 2), n - 1]) {
      const x = sx(k)
      kids.push(createElement('line', { key: 'x' + String(k), x1: x, x2: x, y1: h - padB, y2: h - padB + 3, stroke: 'var(--nt-border,#d9d9d5)' }))
      kids.push(createElement('text', { key: 'xl' + String(k), x, y: h - 7, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)', textAnchor: 'middle' }, xt(pts[k].x)))
    }
  }
  // 阈值线（朱红虚线 + 右上标签——定稿元素）
  if (props.threshold !== undefined && props.threshold >= min && props.threshold <= max) {
    const y = sy(props.threshold)
    kids.push(createElement('line', { key: 'th', x1: padL, x2: w - padR, y1: y, y2: y, stroke: 'var(--nt-accent,#e6321e)', strokeWidth: 1, strokeDasharray: '2 4', opacity: 0.8 }))
    kids.push(createElement('text', { key: 'tht', x: w - padR, y: y - 4, fontSize: 9, fill: 'var(--nt-accent,#e6321e)', textAnchor: 'end', letterSpacing: 1 }, props.thresholdLabel ?? '阈值'))
  }
  // τ_e 注记（虚线段 + 顶部文字——定稿元素；from/to 为点序号）
  if (props.anno !== undefined && n >= 4) {
    const a = props.anno
    const x1 = sx(Math.max(0, Math.min(n - 1, a.from)))
    const x2 = sx(Math.max(0, Math.min(n - 1, a.to)))
    kids.push(createElement('line', { key: 'an', x1, x2, y1: 14, y2: 14, stroke: 'var(--nt-dim,#5f5f5c)', strokeWidth: 1, strokeDasharray: '3 3' }))
    kids.push(createElement('text', { key: 'ant', x: (x1 + x2) / 2, y: 9, fontSize: 9, fill: 'var(--nt-dim,#5f5f5c)', textAnchor: 'middle', letterSpacing: 1 }, a.txt))
  }
  // 墨线（主线）
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + sx(i).toFixed(1) + ' ' + sy(p.y as number).toFixed(1)).join(' ')
  kids.push(createElement('path', { key: 'line', d, fill: 'none', stroke: 'var(--nt-ink,#101010)', strokeWidth: 1.6 }))
  // 关键点：越过阈值的轮 → 朱红实心（定稿：朱红＝关键点）
  if (props.threshold !== undefined) {
    const th = props.threshold
    pts.forEach((p, i) => {
      if ((p.y as number) >= th) kids.push(createElement('circle', { key: 'm' + String(i), cx: sx(i), cy: sy(p.y as number), r: 2.8, fill: 'var(--nt-accent,#e6321e)' }))
    })
  }
  return createElement('svg', { viewBox: '0 0 ' + String(w) + ' ' + String(h), width: '100%', height: h, role: 'img', 'aria-label': props.label ?? 'series' }, ...kids)
}

/**
 * 交互曲线（NEXUS 轮次专用；OS 层不用此组件——PULSE 是等间隔连续采样，无采样点语义）。
 * S4 定稿视觉 + 原 dsh-nautilus 交互回归：
 *   · 滚轮放缩（以指针为锚点，min 4 点，双击复位）——wheel 需非 passive 监听才能 preventDefault；
 *   · 左键按住拖动 = 平移时间窗（位移 <4px 松开＝点击下钻；2026-09-20 自右键改来——右键与浏览器手势冲突）；
 *   · 悬停采样点 → 竖参考线 + 简略看板（该轮读数摘要；上缘/右缘自动翻面）；
 *   · 点击采样点 → onOpenTurn 下钻完整问答（抽屉由根组件持有）。
 * 数据精准：y 域随窗口重算；看板数值取原始读数（不取插值）。
 * 缩放呈等比（preserveAspectRatio meet）：设计坐标系固定 1120×340，容器更大时整体等比放到最大、
 * 不足处留边（不拉伸不变形，线宽随整体等比放大）；指针/滚轮/拖动换算含比例与留白修正，点位零偏差。
 */
export function CurveChart(props: {
  points: Array<{ x: number; y: number | null; meta: M2Point }>
  threshold?: number
  thresholdLabel?: string
  yFmt?: (v: number) => string
  anno?: { from: number; to: number; txt: string }
  /** 自定义 x 刻度格式（轮次轴用；缺省走 epoch 时间轴自动格式） */
  xTick?: (x: number) => string
  h?: number
  fill?: boolean
  resetKey?: string | number
  onOpenTurn?: (session: string, turn: number) => void
  tipOf?: (meta: M2Point) => { head: string; lines: string[] }
  /** 人工层标记（T 系列契合，dev-02 §5）：与 points 平行；非空项 = 描边环 + 档位数字。只改点样貌，不动读数线。 */
  marks?: Array<string | null>
  label?: string
}): ReactNode {
  const base = props.points.filter((p) => p.y !== null && Number.isFinite(p.y))
  // marks 与 points 对齐 → 过滤出与 base 同序的标记序列（flatMap 保序保对齐）
  const marksBase: Array<string | null> | null = props.marks === undefined
    ? null
    : props.points.flatMap((p, i) => (p.y !== null && Number.isFinite(p.y) ? [props.marks?.[i] ?? null] : []))
  const n = base.length
  const fill = props.fill === true
  const DW = 1120
  const DH = 340
  const padL = 52
  const padR = 16
  const padT = 26
  const padB = 26
  const yf = props.yFmt ?? ((v: number): string => v.toFixed(1))
  const [win, setWin] = useState<[number, number]>([0, Math.max(0, n - 1)])
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState(false)
  const dragRef = useRef<{ x: number; a: number; b: number; scale: number; moved: boolean } | null>(null)
  const hoverRef = useRef<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewRef = useRef<{ scale: number; offX: number; offY: number; rectW: number; rectH: number } | null>(null)
  /** 屏幕 → 设计坐标（含 meet 等比缩放与居中留白修正）。 */
  const viewOf = (e: { clientX: number; clientY: number }, el: SVGSVGElement): { vx: number; scale: number; offX: number; offY: number; rectW: number; rectH: number } => {
    const rect = el.getBoundingClientRect()
    const scale = Math.min(rect.width / DW, rect.height / DH)
    const offX = (rect.width - DW * scale) / 2
    const offY = (rect.height - DH * scale) / 2
    return { vx: (e.clientX - rect.left - offX) / scale, scale, offX, offY, rectW: rect.width, rectH: rect.height }
  }
  useEffect(() => { setWin([0, Math.max(0, n - 1)]); hoverRef.current = null; setHover(null) }, [n, props.resetKey])
  // 滚轮放缩：以指针为锚点缩放窗口（min 4 点）；svg 就绪后再挂非 passive 监听
  const ready = n >= 2
  useEffect(() => {
    const el = svgRef.current
    if (el === null || !ready) return undefined
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { vx } = viewOf(e, el)
      const f = Math.max(0, Math.min(1, (vx - padL) / (DW - padL - padR)))
      const factor = e.deltaY < 0 ? 0.78 : 1.28
      setWin(([a, b]) => {
        const span = b - a
        const ns = Math.max(4, Math.min(n - 1, Math.round(span * factor)))
        const c = a + span * f
        let na = Math.round(c - ns * f)
        na = Math.max(0, Math.min(n - 1 - ns, na))
        return na === a && ns === span ? [a, b] : [na, na + ns]
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [n, ready])
  // 左键按住拖动 = 平移时间窗（按下记录起点，window 级 move/up 保证拖出画布也持续；位移 <4px 松开＝点击）
  useEffect(() => {
    if (!drag) return undefined
    const move = (e: MouseEvent): void => {
      const d = dragRef.current
      if (d === null) return
      if (!d.moved && Math.abs(e.clientX - d.x) < 4) return
      d.moved = true
      hoverRef.current = null
      setHover(null)
      // 抓点跟随（灵敏度同鼠标）：像素位移 ÷ 缩放 × (窗口跨度 / 绘图区宽) = 索引位移——
      // 按下时指针下的数据点在整个拖动过程中保持在指针下（取整误差 ≤0.5 索引）
      const di = ((e.clientX - d.x) / d.scale) * ((d.b - d.a) / (DW - padL - padR))
      const span = d.b - d.a
      let na = Math.round(d.a - di)
      na = Math.max(0, Math.min(n - 1 - span, na))
      setWin([na, na + span])
    }
    const up = (): void => {
      const d = dragRef.current
      dragRef.current = null
      setDrag(false)
      // 未拖动（<4px）＝点击：命中采样点则下钻（自 svg onClick 迁移至此，避免与拖动冲突）
      if (d !== null && !d.moved && hoverRef.current !== null && props.onOpenTurn !== undefined) {
        const pt = base[hoverRef.current]
        if (pt !== undefined) { const m = pt.meta; props.onOpenTurn(m.session, m.turn) }
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [drag, n])
  if (n < 2) return Empty({ text: '暂无数据' })
  const W = DW
  const h = DH
  // 渲染期钳制窗口：切档/数据刷新后点数骤减时，effect 复位前的这一帧里旧 win 会越界（base[b] undefined 崩溃）
  const a = Math.max(0, Math.min(win[0], n - 2))
  const b = Math.max(a + 1, Math.min(win[1], n - 1))
  const hv = hover !== null && hover >= a && hover <= b ? hover : null
  const plotW = W - padL - padR
  const sx = (gi: number): number => padL + ((gi - a) / Math.max(1, b - a)) * plotW
  const vis: Array<{ p: (typeof base)[number]; gi: number }> = []
  for (let i = a; i <= b && i < n; i++) vis.push({ p: base[i], gi: i })
  const ys = vis.map((v) => v.p.y as number)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  const sy = (v: number): number => h - padB - ((v - min) / span) * (h - padT - padB)
  const kids: ReactNode[] = []
  for (const r of [0, 1 / 3, 2 / 3, 1]) {
    const v = min + span * r
    const y = sy(v)
    kids.push(createElement('line', { key: 'g' + String(r), x1: padL, x2: W - padR, y1: y, y2: y, stroke: 'var(--nt-border,#d9d9d5)', strokeWidth: 1, opacity: 0.7 }))
    kids.push(createElement('text', { key: 't' + String(r), x: padL - 6, y: y + 3, fontSize: 9.5, fill: 'var(--nt-faint,#9a9a95)', textAnchor: 'end' }, yf(v)))
  }
  {
    const spanMs = base[b].x - base[a].x
    const short = spanMs < 36 * 3600000
    const xt = (x: number): string => {
      const d = new Date(x)
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return short ? hm : String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm
    }
    for (const k of [a, Math.floor((a + b) / 2), b]) {
      const x = sx(k)
      kids.push(createElement('line', { key: 'x' + String(k), x1: x, x2: x, y1: h - padB, y2: h - padB + 3, stroke: 'var(--nt-border,#d9d9d5)' }))
      kids.push(createElement('text', { key: 'xl' + String(k), x, y: h - 8, fontSize: 9.5, fill: 'var(--nt-faint,#9a9a95)', textAnchor: 'middle' }, xt(base[k].x)))
    }
  }
  if (props.threshold !== undefined && props.threshold >= min && props.threshold <= max) {
    const y = sy(props.threshold)
    kids.push(createElement('line', { key: 'th', x1: padL, x2: W - padR, y1: y, y2: y, stroke: 'var(--nt-accent,#e6321e)', strokeWidth: 1, strokeDasharray: '2 4', opacity: 0.8 }))
    kids.push(createElement('text', { key: 'tht', x: W - padR, y: y - 4, fontSize: 9.5, fill: 'var(--nt-accent,#e6321e)', textAnchor: 'end', letterSpacing: 1 }, props.thresholdLabel ?? '阈值'))
  }
  if (props.anno !== undefined && b - a >= 3) {
    const f0 = Math.max(props.anno.from, a)
    const f1 = Math.min(props.anno.to, b)
    if (f1 > f0) {
      const x1 = sx(f0)
      const x2 = sx(f1)
      kids.push(createElement('line', { key: 'an', x1, x2, y1: 16, y2: 16, stroke: 'var(--nt-dim,#5f5f5c)', strokeWidth: 1, strokeDasharray: '3 3' }))
      kids.push(createElement('text', { key: 'ant', x: (x1 + x2) / 2, y: 11, fontSize: 9.5, fill: 'var(--nt-dim,#5f5f5c)', textAnchor: 'middle', letterSpacing: 1 }, props.anno.txt))
    }
  }
  const d = vis.map((v, i) => (i === 0 ? 'M' : 'L') + sx(v.gi).toFixed(1) + ' ' + sy(v.p.y as number).toFixed(1)).join(' ')
  kids.push(createElement('path', { key: 'line', d, fill: 'none', stroke: 'var(--nt-ink,#101010)', strokeWidth: 1.7 }))
  for (const v of vis) {
    const y = v.p.y as number
    const exceed = props.threshold !== undefined && y >= props.threshold
    const isHv = hv === v.gi
    kids.push(createElement('circle', { key: 'm' + String(v.gi), cx: sx(v.gi), cy: sy(y), r: isHv ? 4.2 : 2.2, fill: exceed || isHv ? 'var(--nt-accent,#e6321e)' : 'var(--nt-ink,#101010)', opacity: isHv ? 1 : 0.85 }))
    if (isHv) kids.push(createElement('circle', { key: 'mr' + String(v.gi), cx: sx(v.gi), cy: sy(y), r: 7.5, fill: 'none', stroke: 'var(--nt-accent,#e6321e)', strokeWidth: 1.1 }))
    const mk = marksBase !== null ? marksBase[v.gi] : null
    if (mk !== null && mk !== undefined && !isHv) {
      kids.push(createElement('circle', { key: 'fkr' + String(v.gi), cx: sx(v.gi), cy: sy(y), r: 6.8, fill: 'none', stroke: 'var(--nt-accent,#e6321e)', strokeWidth: 1.1, opacity: 0.9 }))
      kids.push(createElement('text', { key: 'fkt' + String(v.gi), x: sx(v.gi), y: sy(y) - 9.5, fontSize: 8, fill: 'var(--nt-accent,#e6321e)', textAnchor: 'middle', fontWeight: 700 }, mk))
    }
  }
  if (hv !== null) {
    kids.push(createElement('line', { key: 'xh', x1: sx(hv), x2: sx(hv), y1: padT - 4, y2: h - padB, stroke: 'var(--nt-faint,#9a9a95)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.6 }))
  }
  const onMove = (e: { clientX: number; clientY: number; currentTarget: SVGSVGElement }): void => {
    if (dragRef.current !== null) { hoverRef.current = null; setHover(null); return }
    const v = viewOf(e, e.currentTarget)
    viewRef.current = v
    const vx = v.vx
    if (vx < padL - 8 || vx > DW - padR + 8) { hoverRef.current = null; setHover(null); return }
    let gi = a + Math.round(((vx - padL) / plotW) * (b - a))
    gi = Math.max(a, Math.min(b, gi))
    const next = Math.abs(sx(gi) - vx) <= 18 ? gi : null
    hoverRef.current = next
    setHover(next)
  }
  const tip = hv !== null && props.tipOf !== undefined ? props.tipOf(base[hv].meta) : null
  // 看板定位（px，含 meet 留白修正）：由最近一次 onMove 写入的实测视图参数推导
  let tipStyle: { left: string; top: string; transform: string } | null = null
  if (tip !== null && hv !== null && viewRef.current !== null) {
    const vr = viewRef.current
    const left = vr.offX + sx(hv) * vr.scale
    const top = vr.offY + sy(base[hv].y as number) * vr.scale
    const flipX = left > vr.rectW * 0.62
    const flipY = top < vr.rectH * 0.3
    tipStyle = { left: String(left) + 'px', top: String(top) + 'px', transform: (flipX ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)') + ' ' + (flipY ? 'translateY(12px)' : 'translateY(calc(-100% - 10px))') }
  }
  return createElement('div', { className: 'nt-chart', style: { height: fill ? '100%' : String(h) + 'px', cursor: drag ? 'grabbing' : undefined, userSelect: drag ? 'none' : undefined } },
    createElement('svg', {
      ref: svgRef,
      viewBox: '0 0 ' + String(W) + ' ' + String(h), width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', style: { display: 'block' }, role: 'img', 'aria-label': props.label ?? 'curve',
      onMouseMove: onMove,
      onMouseLeave: () => { if (dragRef.current === null) { hoverRef.current = null; setHover(null) } },
      onMouseDown: (e: { button: number; preventDefault(): void; clientX: number; currentTarget: SVGSVGElement }) => {
        if (e.button !== 0) return
        e.preventDefault()
        dragRef.current = { x: e.clientX, a, b, scale: viewOf(e, e.currentTarget).scale, moved: false }
        setDrag(true)
      },
      onDoubleClick: () => setWin([0, n - 1]),
    }, ...kids),
    tip !== null && hv !== null && tipStyle !== null
      ? createElement('div', { className: 'nt-tip', style: tipStyle },
        createElement('div', null, createElement('b', null, tip.head)),
        ...tip.lines.map((ln, i) => createElement('div', { key: String(i) }, ln)),
        createElement('div', { className: 'dim' }, '左键按住拖动平移 · 点击采样点 → 完整问答 · 双击复位缩放'),
      )
      : null,
  )
}

/**
 * PULSE 主图（FIG.01 四主图，2×2 大图）：等间隔采样序列的交互图——滚轮放缩（指针为锚，min 8 点）、
 * 左键按住拖动平移（位移 <4px 不触发）、双击复位；悬停读数显示在图头（该时刻原始读数，不取插值）。
 * 与 CurveChart（NEXUS 轮次）分离：采样均匀、无逐点问答、无阈值语义，交互口径与其一致。
 * 视口等比（meet）：设计坐标 1000×h，容器更宽时居中留边不变形；线宽/圆点为屏幕像素。
 */
export function PulseChart(props: { metric: string; points: Array<{ ts: number; value: number }>; h?: number; label?: string }): ReactNode {
  const pts = props.points.filter((p) => Number.isFinite(p.value))
  const n = pts.length
  const h = props.h ?? 170
  const DW = 1000
  const [win, setWin] = useState<[number, number]>([0, Math.max(0, n - 1)])
  const [hover, setHover] = useState<number | null>(null)
  const [drag, setDrag] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; a: number; b: number; scale: number; moved: boolean } | null>(null)
  useEffect(() => { setWin([0, Math.max(0, n - 1)]); setHover(null) }, [n, props.metric])
  const viewOf = (clientX: number): { vx: number; scale: number } | null => {
    const el = wrapRef.current
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const scale = Math.min(rect.width / DW, rect.height / h)
    const offX = (rect.width - DW * scale) / 2
    return { vx: (clientX - rect.left - offX) / scale, scale }
  }
  // 滚轮放缩：以指针为锚点（min 8 点）；容器就绪后挂非 passive 监听才能 preventDefault
  useEffect(() => {
    const el = wrapRef.current
    if (el === null || n < 2) return undefined
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const v = viewOf(e.clientX)
      if (v === null) return
      const f = Math.max(0, Math.min(1, v.vx / DW))
      const factor = e.deltaY < 0 ? 0.78 : 1.28
      setWin(([a, b]) => {
        const span = b - a
        const ns = Math.max(8, Math.min(n - 1, Math.round(span * factor)))
        const c = a + span * f
        let na = Math.round(c - ns * f)
        na = Math.max(0, Math.min(n - 1 - ns, na))
        return na === a && ns === span ? [a, b] : [na, na + ns]
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [n])
  // 左键按住拖动 = 平移时间窗（window 级 move/up 保证拖出画布也持续；位移 <4px 视为点击不触发）
  useEffect(() => {
    if (!drag) return undefined
    const move = (e: MouseEvent): void => {
      const d = dragRef.current
      if (d === null) return
      if (!d.moved && Math.abs(e.clientX - d.x) < 4) return
      d.moved = true
      setHover(null)
      // 抓点跟随（灵敏度同鼠标）：像素位移 ÷ 缩放 × (窗口跨度 / 绘图区宽) = 索引位移
      const di = ((e.clientX - d.x) / d.scale) * ((d.b - d.a) / DW)
      const span = d.b - d.a
      let na = Math.round(d.a - di)
      na = Math.max(0, Math.min(n - 1 - span, na))
      setWin([na, na + span])
    }
    const up = (): void => { dragRef.current = null; setDrag(false) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [drag, n])
  const hv = hover !== null && hover >= 0 && hover <= n - 1 ? hover : null
  const headVal = n === 0
    ? '—'
    : hv !== null
      ? fmtMetricValue(props.metric, pts[hv].value) + ' · ' + fmtTime(pts[hv].ts)
      : '最新 ' + fmtMetricValue(props.metric, pts[n - 1].value) + ' · ' + fmtTime(pts[n - 1].ts)
  const head = createElement('div', { className: 'mh' },
    createElement('span', null, props.label ?? metricLabel(props.metric)),
    createElement('span', { className: 'mv' }, headVal),
    createElement('span', { className: 'hint' }, '滚轮放缩 · 左键按住拖动 · 双击复位'),
  )
  if (n < 2) {
    return createElement('div', { className: 'nt-maincell' }, head, Empty({ text: '序列未就绪（需 ≥2 个采样）' }))
  }
  const a = Math.max(0, Math.min(win[0], n - 2))
  const b = Math.max(a + 1, Math.min(win[1], n - 1))
  const hvi = hv !== null && hv >= a && hv <= b ? hv : null
  const plotW = DW
  const vis: number[] = []
  for (let i = a; i <= b && i < n; i++) vis.push(i)
  const ys = vis.map((i) => pts[i].value)
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  const span = max - min || 1
  const padT = 14
  const padB = 22
  const sy = (v: number): number => h - padB - ((v - min) / span) * (h - padT - padB)
  const sx = (i: number): number => ((i - a) / Math.max(1, b - a)) * plotW
  const kids: ReactNode[] = []
  for (const r of [0, 0.5, 1]) {
    const v = min + span * r
    const y = sy(v)
    kids.push(createElement('line', { key: 'g' + String(r), x1: 0, x2: DW, y1: y, y2: y, stroke: 'var(--nt-border,#d9d9d5)', strokeWidth: 1, opacity: 0.7, vectorEffect: 'non-scaling-stroke' }))
    kids.push(createElement('text', { key: 't' + String(r), x: 4, y: y - 3, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)' }, fmtMetricValue(props.metric, v)))
  }
  {
    const spanMs = pts[b].ts - pts[a].ts
    const short = spanMs < 36 * 3600000
    const xt = (ts: number): string => {
      const d = new Date(ts)
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return short ? hm : String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm
    }
    for (const k of [a, Math.floor((a + b) / 2), b]) {
      const x = sx(k)
      kids.push(createElement('text', { key: 'x' + String(k), x: Math.min(DW - 4, Math.max(4, x)), y: h - 6, fontSize: 9, fill: 'var(--nt-faint,#9a9a95)', textAnchor: x < 30 || x > DW - 30 ? (x < 30 ? 'start' : 'end') : 'middle' }, xt(pts[k].ts)))
    }
  }
  const d = vis.map((i, k) => (k === 0 ? 'M' : 'L') + sx(i).toFixed(1) + ' ' + sy(pts[i].value).toFixed(1)).join(' ')
  kids.push(createElement('path', { key: 'area', d: d + ' L' + sx(b).toFixed(1) + ' ' + String(h - padB) + ' L' + sx(a).toFixed(1) + ' ' + String(h - padB) + ' Z', fill: 'var(--nt-ink,#101010)', opacity: 0.06 }))
  kids.push(createElement('path', { key: 'line', d, fill: 'none', stroke: 'var(--nt-ink,#101010)', strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' }))
  if (hvi !== null) {
    kids.push(createElement('line', { key: 'xh', x1: sx(hvi), x2: sx(hvi), y1: padT - 6, y2: h - padB, stroke: 'var(--nt-faint,#9a9a95)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.6, vectorEffect: 'non-scaling-stroke' }))
    kids.push(createElement('circle', { key: 'hd', cx: sx(hvi), cy: sy(pts[hvi].value), r: 3.4, fill: 'var(--nt-accent,#e6321e)' }))
  }
  return createElement('div', { className: 'nt-maincell' },
    head,
    createElement('div', {
      ref: wrapRef, className: 'nt-chart', style: { cursor: drag ? 'grabbing' : 'crosshair', userSelect: drag ? 'none' : undefined },
      onMouseMove: (e: { clientX: number }): void => {
        if (dragRef.current !== null) return
        const v = viewOf(e.clientX)
        if (v === null) { setHover(null); return }
        const gi = a + Math.round((v.vx / plotW) * (b - a))
        setHover(gi >= a && gi <= b ? gi : null)
      },
      onMouseLeave: () => { if (dragRef.current === null) setHover(null) },
      onMouseDown: (e: { button: number; preventDefault(): void; clientX: number }) => {
        if (e.button !== 0) return
        e.preventDefault()
        const v = viewOf(e.clientX)
        dragRef.current = { x: e.clientX, a, b, scale: v === null ? 1 : v.scale, moved: false }
        setDrag(true)
      },
      onDoubleClick: () => setWin([0, n - 1]),
    },
      createElement('svg', { viewBox: '0 0 ' + String(DW) + ' ' + String(h), width: '100%', height: h, preserveAspectRatio: 'xMidYMid meet', style: { display: 'block' }, role: 'img', 'aria-label': props.label ?? metricLabel(props.metric) }, ...kids),
    ),
  )
}

// ── 视图 1：总览 ──────────────────────────────────────────────────────────────

export function OverviewView(props: { m2: M2State | null; pulse: PulseState | null; lfield: LfieldInfo | null; viewMode: 'pointed' | 'all'; onViewMode: (m: 'pointed' | 'all') => void; newRoot: string; onNewRoot: (v: string) => void; switching: boolean; onSwitchLfield: (root: string) => void; onOpenTurn: (s: string, t: number) => void; paused?: boolean; sessionNameOf?: (id: string) => { name: string; title: string } | null; nonce?: number }): ReactNode {
  const { m2, pulse } = props
  const n = m2?.totals
  const hr = n?.hitRate
  const last = pulse?.collector.lastTickTs ?? null
  const lagMs = last === null ? null : Date.now() - last
  const stale = lagMs !== null && lagMs > 180000
  const recent = m2?.recent ?? []
  const latest = pulse?.latest ?? []
  // 图表语法升级（2026-09-20 方案 A）：PULSE 近 1h 序列驱动主图/小图/采集健康带；刷新频率与心跳对齐，抽屉打开暂停
  const seriesMap = usePulseSeriesMap(latest.map((l) => l.metric), props.paused === true, 3600000, 240, heartbeatSeriesMs(pulse?.collector ?? null), props.nonce ?? 0)
  const [hoverTs, setHoverTs] = useState<number | null>(null)
  const ptsOf = (metric: string): Array<{ ts: number; value: number }> => (seriesMap[metric]?.points ?? []).map((p) => ({ ts: p.ts, value: p.value }))
  const latestOf = (name: string): PulsePoint | undefined => latest.find((l) => l.metric === name)
  // NEXUS stat 走势：命中率卡 = 逐轮未命中率序列；读数规模卡 = 累计输入令牌（命中+未命中）
  let accTok = 0
  const cumTok: number[] = []
  const missPct: Array<number | null> = []
  for (const p of m2?.curve ?? []) {
    accTok += p.tokenIn + p.cacheRead
    cumTok.push(accTok)
    const mr = curveValue(p, 'miss')
    missPct.push(mr === null ? null : mr * 100)
  }
  const rows: Array<{ layer: string; label: string; value: string; note?: string; warn?: boolean; spark?: Array<number | null> }> = [
    { layer: 'PULSE', label: '采集器心跳', value: last === null ? '未采样' : fmtTime(last), note: pulse === null ? 'pulse 未装配' : 'tick ' + String(pulse.collector.ticks) + ' · 库内 ' + String(pulse.db.rows) + ' 行 · shell=' + String(pulse.collector.shellPath === null ? '无' : pulse.collector.shellPath), warn: stale },
    { layer: 'NEXUS', label: '读数规模', value: n === undefined ? '—' : String(n.turns) + ' 轮', note: '窗口内落库读数 · 归属由 L 场指向决定（vault 观测腿已下线）', spark: cumTok },
    { layer: 'NEXUS', label: '窗口缓存命中率', value: hr === null || hr === undefined ? '—' : (hr * 100).toFixed(1) + '%', note: n === undefined ? '—' : '读 ' + String(n.cacheRead) + ' / 未命中 ' + String(n.missToken) + ' 令牌 · ' + String(n.turns) + ' 轮', warn: hr !== null && hr !== undefined && hr < 0.5, spark: missPct },
    { layer: 'INFER', label: '推理时延 TTFT', value: '—', note: 'Phase 2a 采集（provider 侧未接入）', warn: false },
    { layer: 'INFER', label: '层间对齐度', value: '—', note: '需 INFER 落地后方可计算 τ_e', warn: false },
    { layer: 'M5', label: '预言命中', value: '—', note: 'call_p 未落库（迁移至 schema v5）', warn: false },
    { layer: 'SELF', label: '自评覆盖率', value: m2 === null ? '—' : String(m2.selfcheck.checked) + ' / ' + String(m2.selfcheck.total), note: '每轮 record_turn_selfcheck 落盘比例' },
  ]
  const HEADLINE = ['pulse.cpu.utilization', 'pulse.mem.used', 'pulse.gpu.util', 'pulse.proc.dsh.rss']
  const headline = HEADLINE.map((name) => latest.find((l) => l.metric === name)).filter((x): x is PulsePoint => x !== undefined)
  // 小图只列主图之外的次要指标（守谷人 2026-09-20 二次反馈：小图不与主图重复）
  const minor = latest.filter((m) => !HEADLINE.includes(m.metric))
  // 占比 gauge（Grafana Bar Gauge 借鉴）：CPU/GPU 利用率、内存/显存占比；朱红刻度＝预警阈值（越过转朱红）
  const gauges: Array<{ label: string; display: string; ratio: number; threshold?: number; warn?: boolean }> = []
  const cpu = latestOf('pulse.cpu.utilization')
  if (cpu !== undefined && cpu.value !== null) gauges.push({ label: 'CPU 利用率', display: fmtMetricValue(cpu.metric, cpu.value), ratio: cpu.value, threshold: 0.85, warn: cpu.value >= 0.85 })
  const gpu = latestOf('pulse.gpu.util')
  if (gpu !== undefined && gpu.value !== null) gauges.push({ label: 'GPU 利用率', display: fmtMetricValue(gpu.metric, gpu.value), ratio: gpu.value / 100, threshold: 0.9, warn: gpu.value >= 90 })
  const mu = latestOf('pulse.mem.used')
  const mt = latestOf('pulse.mem.total')
  if (mu !== undefined && mt !== undefined && mu.value !== null && mt.value !== null && mt.value > 0) gauges.push({ label: '内存占比', display: fmtBytes(mu.value) + ' / ' + fmtBytes(mt.value), ratio: mu.value / mt.value, threshold: 0.9, warn: mu.value / mt.value >= 0.9 })
  const gu = latestOf('pulse.gpu.mem.used')
  const gt = latestOf('pulse.gpu.mem.total')
  if (gu !== undefined && gt !== undefined && gu.value !== null && gt.value !== null && gt.value > 0) gauges.push({ label: '显存占比', display: fmtMetricValue(gu.metric, gu.value) + ' / ' + fmtMetricValue(gt.metric, gt.value), ratio: gu.value / gt.value, threshold: 0.9, warn: gu.value / gt.value >= 0.9 })
  // USE 资源族分区（利用率/饱和/错误的组织原则）+ Netdata 式每指标一图：跨图共享同一 hoverTs = 同步十字线
  const FAMILIES = ['CPU', '内存', 'GPU', '进程', '磁盘', '网络', '其他']
  const fams = FAMILIES.map((f) => ({ f, ms: minor.filter((m) => metricGroup(m.metric) === f) })).filter((x) => x.ms.length > 0)
  const hoverReadout = (() => {
    if (hoverTs === null) return null
    for (const m of latest) {
      const hit = (seriesMap[m.metric]?.points ?? []).find((p) => p.ts === hoverTs)
      if (hit !== undefined) return metricLabel(m.metric) + ' = ' + fmtMetricValue(m.metric, hit.value) + ' · ' + fmtTime(hoverTs)
    }
    return null
  })()
  // 采集健康带：近 1h 每桶样本在场（n>0）为墨色片段；空白＝该桶无样本（中断/缺席）
  const bandSeries = seriesMap['pulse.cpu.utilization'] ?? seriesMap['pulse.gpu.util'] ?? seriesMap['pulse.proc.dsh.rss'] ?? null
  const presenceLane = (label: string, key: string): { label: string; spans: Array<{ from: number; to: number }> } => {
    const s = seriesMap[key]
    const bucket = s?.bucketMs ?? 5000
    const spans: Array<{ from: number; to: number }> = []
    let cur: { from: number; to: number } | null = null
    for (const p of s?.points ?? []) {
      if (p.n > 0) {
        if (cur === null) cur = { from: p.ts, to: p.ts + bucket }
        else cur.to = p.ts + bucket
      } else if (cur !== null) { spans.push(cur); cur = null }
    }
    if (cur !== null) spans.push(cur)
    return { label, spans }
  }
  // 会话排行 / 活跃带（Datadog Top List + Grafana State Timeline 借鉴）：按输入令牌（命中+未命中）合计
  const bySess = new Map<string, { tokens: number; turns: number; from: number; to: number }>()
  for (const p of m2?.curve ?? []) {
    const e = bySess.get(p.session) ?? { tokens: 0, turns: 0, from: p.ts, to: p.ts }
    e.tokens += p.tokenIn + p.cacheRead
    e.turns += 1
    e.from = Math.min(e.from, p.ts)
    e.to = Math.max(e.to, p.ts)
    bySess.set(p.session, e)
  }
  const ranked = Array.from(bySess.entries()).sort((a, b) => b[1].tokens - a[1].tokens)
  const nameOf = (sid: string): string => {
    const info = props.sessionNameOf?.(sid) ?? null
    const nm = info?.name ?? ''
    const ti = info?.title ?? ''
    if (nm === '') return ti === '' ? shortSession(sid) : ti
    if (ti === '') return nm
    return nm + ' · ' + (ti.length > 18 ? ti.slice(0, 18) + '…' : ti)
  }
  const sessionDomain: [number, number] | null = ranked.length === 0 ? null : [Math.min(...ranked.map(([, e]) => e.from)), Math.max(...ranked.map(([, e]) => e.to))]
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '读数为观测所得，非评价：本面板只呈现「发生了什么」。三层齐备前（INFER 缺席），任何跨层结论都只能用「对照」措辞。'),
    createElement('div', { className: 'nt-wb-grid' }, ...rows.map((r) => Stat({ layer: r.layer, label: r.label, value: r.value, note: r.note, warn: r.warn }))),
    Panel({
      title: '系统层读数（PULSE · 本机）', fig: 'FIG.01',
      note: '主图四项（CPU 利用率 / 内存占用 / GPU 利用率 / 宿主 RSS，2×2，近 1 小时）：滚轮放缩（指针为锚，min 8 点）、左键按住拖动平移、双击复位，悬停读该时刻原始值（图头显示，不取插值）。小图只列主图之外的次要指标（与主图不重复），跨图共享十字线——悬停任一小图，全部小图同一时刻画线；占比量走横条 gauge，朱红刻度为预警阈值。量纲取自 src/pulse/{collect,counters}.ts 的构造点：utilization / proc.cpu 是「占单核比」已换算为百分比，io_rate 为字节/秒，gpu.mem 为 MiB，temp/power 为 °C/W。本机读数与云端缓存之间在 era=api 下没有因果通路——此处只作对照，不作归因。曲线刷新与心跳对齐：' + heartbeatRefreshLabel(pulse?.collector ?? null) + '。',
      children: latest.length === 0
        ? Empty({ text: pulse === null ? 'PULSE 层缺席：宿主内子插件未挂载或接口不可达' : '尚无采样——等待采集器首个 tick' })
        : createElement('div', null,
          createElement('div', { className: 'nt-maingrid' }, ...headline.map((m) =>
            createElement(PulseChart, { key: m.metric, metric: m.metric, points: ptsOf(m.metric), h: 170, label: metricLabel(m.metric) }))),
          gauges.length > 0 ? createElement('div', { className: 'nt-gauges' }, ...gauges.map((g) => BarGauge(g))) : null,
          minor.length > 0 ? createElement('div', { className: 'nt-readout', style: { marginTop: 12 } }, hoverReadout ?? '悬停任一小图 → 全网格同步十字线与该时刻读数') : null,
          ...fams.map(({ f, ms }) => createElement('div', { key: f },
            createElement('div', { className: 'nt-famhd' }, f),
            createElement('div', { className: 'nt-mini' }, ...ms.map((m) =>
              createElement('div', { key: m.metric, className: 'cell' },
                createElement('div', { className: 'cl' },
                  createElement('span', null, metricLabel(m.metric)),
                  createElement('span', { className: 'cv' }, fmtMetricValue(m.metric, m.value)),
                ),
                MiniChart({ points: ptsOf(m.metric), hoverTs, onHover: setHoverTs, label: metricLabel(m.metric) }),
              ))))),
          createElement('div', { className: 'nt-famhd' }, '采集健康带 · 近 1 小时'),
          bandSeries !== null
            ? StateBand({ domain: [bandSeries.from, bandSeries.to], lanes: [presenceLane('CPU 采样', 'pulse.cpu.utilization'), presenceLane('GPU 采样', 'pulse.gpu.util'), presenceLane('进程采样', 'pulse.proc.dsh.rss')], xTick: fmtDayTime })
            : createElement('div', { className: 'nt-mini-empty' }, '序列未就绪：等待首个采样窗（约 1 分钟）'),
          createElement('p', { className: 'nt-note' },
            '采集健康：tick ' + String(pulse?.collector.ticks ?? 0) + ' · 库内 ' + String(pulse?.db.rows ?? 0) + ' 行 ' + String(latest.length) + ' 指标 · shell=' + String(pulse?.collector.shellPath ?? '无') + ' · 计数器 ' + (pulse?.collector.countersOk === true ? '正常' : '不可用') + ' · GPU ' + (pulse?.collector.gpuOk === true ? '正常' : '不可用') + ' · 助手重启 ' + String(pulse?.collector.countersRestarts ?? 0) + ' 次' + (pulse?.collector.lastError === null || pulse?.collector.lastError === undefined ? '' : ' · 最近错误：' + pulse.collector.lastError)),
        ),
    }),
    Panel({
      title: '最近轮次读数', fig: 'FIG.02', collapsible: true, defaultCollapsed: true,
      note: '读数为原始记录；轮次内的问题/回答属解释层，不写回读数（见抽屉）。',
      children: recent.length === 0
        ? Empty({ text: m2 === null ? 'M2 读数接口读取中或不可用' : '窗口内暂无轮次记录' })
        : createElement('table', { className: 'nt-tbl' },
          createElement('thead', null, createElement('tr', null,
            ...['时间', '会话', '轮', '输入(未命中)', '缓存读', '未命中率', '时长', 'TPS'].map((h) => createElement('th', { key: h }, h)))),
          createElement('tbody', null, ...recent.slice(0, 12).map((p) => createElement('tr', { key: p.session + '#' + String(p.turn), className: 'clickable', onClick: () => props.onOpenTurn(p.session, p.turn) },
            createElement('td', null, fmtTime(p.ts)),
            createElement('td', null, p.session.slice(0, 12)),
            createElement('td', null, String(p.turn)),
            createElement('td', null, String(p.tokenIn)),
            createElement('td', null, String(p.cacheRead)),
            createElement('td', null, (() => { const mr = curveValue(p, 'miss'); return mr === null ? '—' : (mr * 100).toFixed(1) + '%' })()),
            createElement('td', null, p.durationMs === null ? '—' : String(Math.round(p.durationMs)) + ' ms'),
            createElement('td', null, fmtNum(p.tps, 1)),
          )))),
    }),
    Panel({
      title: '会话活跃与排行', fig: 'FIG.10',
      note: '排行按输入令牌合计（命中+未命中）降序（Datadog Top List 式）；活跃带 = 会话首末轮之间的跨度（离散轮次的包络，Grafana State Timeline 式），不代表全程活跃。会话名 = 工作区目录名 · 会话标题（与曲线视图同源，cwd 缺失回退标题/短 id）。',
      children: ranked.length === 0
        ? Empty({ text: m2 === null ? 'M2 读数接口读取中或不可用' : '窗口内暂无会话读数' })
        : createElement('div', null,
          createElement('div', { className: 'nt-famhd' }, '输入令牌排行 · Top ' + String(Math.min(8, ranked.length))),
          TopList({ rows: ranked.slice(0, 8).map(([sid, e]) => ({ label: nameOf(sid), sub: sid + ' · ' + String(e.turns) + ' 轮 · ' + fmtDayTime(e.from) + ' → ' + fmtDayTime(e.to), value: e.tokens, display: fmtK(e.tokens) + ' · ' + String(e.turns) + ' 轮' })) }),
          createElement('div', { className: 'nt-famhd' }, '会话活跃带' + (sessionDomain === null ? '' : ' · ' + fmtDayTime(sessionDomain[0]) + ' → ' + fmtDayTime(sessionDomain[1]))),
          sessionDomain === null
            ? null
            : StateBand({ domain: sessionDomain, lanes: ranked.slice(0, 6).map(([sid, e]) => ({ label: nameOf(sid), spans: [{ from: e.from, to: e.to }] })), xTick: fmtDayTime }),
        ),
    }),
    Panel({
      title: 'L 场读数（独立指向）', fig: 'FIG.08', collapsible: true, defaultCollapsed: true,
      note: 'M4-L：L 场读数按会话发起时的工作区（cwd）归属，每根计数独立（跨根不混算）。「视图」切换决定取数口径（全局 = 全部工作区；指向 = 当前指向工作区）；切换指向只影响**新会话**的归属，既有归属不变。',
      children: props.lfield === null
        ? Empty({ text: 'L 场接口不可用（/api/nautilus/lfield）' })
        : createElement('div', null,
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
            createElement('span', { style: { fontSize: 10, letterSpacing: 2, color: 'var(--nt-faint,#9a9a95)' } }, '视图'),
            createElement('div', { className: 'nt-wb-seg' },
              ...([['pointed', '指向'], ['all', '全局']] as Array<['pointed' | 'all', string]>).map(([m, lab]) =>
                createElement('button', { key: m, className: props.viewMode === m ? 'on' : '', onClick: () => props.onViewMode(m) }, lab)),
            ),
            createElement('span', { style: { fontSize: 10, color: 'var(--nt-faint,#9a9a95)' } }, '取数口径随视图切换（曲线/假设/报告同步）'),
          ),
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
            createElement('span', { style: { fontSize: 10, letterSpacing: 2, color: 'var(--nt-faint,#9a9a95)' } }, '切换指向'),
            createElement('input', {
              className: 'nt-input', style: { flex: '1 1 260px', minWidth: 200 },
              placeholder: '工作区绝对路径（如 L:\\L_workspace\\...）',
              value: props.newRoot, onChange: (e: { target: { value: string } }) => props.onNewRoot(e.target.value),
            }),
            createElement('button', { className: 'nt-btn', disabled: props.switching || props.newRoot.trim() === '', onClick: () => props.onSwitchLfield(props.newRoot) }, props.switching ? '切换中…' : '确认切换'),
          ),
          createElement('table', { className: 'nt-tbl' },
            createElement('thead', null, createElement('tr', null, ...['归属根', '读数条数'].map((h) => createElement('th', { key: h }, h)))),
            createElement('tbody', null, ...Object.entries(props.lfield.counts).map(([root, n]) => createElement('tr', { key: root === '' ? '(未归属)' : root },
              createElement('td', null, root === '' ? '（未归属：会话无 workspace）' : (props.lfield === null ? root : (props.lfield.known.find((k) => k.root === root)?.displayName ?? shortRoot(root)))),
              createElement('td', null, String(n)),
            )))),
          createElement('p', { className: 'nt-note' }, '当前 L 场指向：' + (props.lfield.known.find((k) => k.root === (props.lfield === null ? '' : props.lfield.active))?.displayName ?? shortRoot(props.lfield.active)) + ' · 已知根 ' + String(props.lfield.known.length) + ' 个'),
        ),
    }),
  )
}

// ── 视图 2：曲线 ──────────────────────────────────────────────────────────────

export type CurveKey = 'miss' | 'stack' | 'ms' | 'tps' | 'cum'
export function curveValue(p: M2Point, key: CurveKey): number | null {
  // cum（累计输入）/ stack（输入构成）需要沿序列派生，不是逐点函数——在 CurveView 里按序处理（此处显式返回 null）
  if (key === 'cum' || key === 'stack') return null
  if (key === 'ms') return p.durationMs
  if (key === 'tps') return p.tps
  const read = p.cacheRead
  const miss = p.missToken ?? p.tokenIn
  const den = read + miss
  return den <= 0 ? null : miss / den
}
export function curveUnit(key: CurveKey): string { return key === 'miss' ? '%' : key === 'ms' ? 'ms' : key === 'stack' || key === 'cum' ? 'tok' : 'tok/s' }
export function curveLabel(key: CurveKey): string { return key === 'miss' ? '未命中率' : key === 'stack' ? '输入构成' : key === 'ms' ? '每轮时长' : key === 'cum' ? '累计输入' : '解码速度' }

/** /m2/analysis 的逐会话行（只取注记所需字段）。 */
export type AnalysisRow = { session: string; shape: string; tauE: number | null; burst: { fromTurn: number; toTurn: number; direction: string } | null }
export const SHAPE_LABEL: Record<string, string> = { sigmoid: 'S 形', 'inverse-sigmoid': '反 S 形', rising: '上升', falling: '下降', unknown: '形态未定' }

/** M4-L L 场读数指向与计数（GET /api/nautilus/lfield）。 */
export type LfieldInfo = {
  revision: number
  active: string
  counts: Record<string, number>
  known: Array<{ root: string; displayName: string | null; active: number; confirmedAt: number | null }>
}
/** 路径末段（指向短名的兜底；displayName 优先）。 */
export function shortRoot(root: string): string {
  const parts = root.split(/[\\/]/).filter((s) => s !== '')
  return parts.length === 0 ? '未指向' : parts[parts.length - 1]
}
/** 会话 id → 可读短名（不改动任何读数，仅呈现层截断）。 */
export function shortSession(id: string): string {
  return id.startsWith('session-') ? id.slice(8, 16) : id.slice(0, 8)
}

const CURVE_YFMT: Record<CurveKey, (v: number) => string> = {
  miss: (v) => String(Math.round(v)) + '%',
  stack: (v) => fmtK(v),
  ms: (v) => String(Math.round(v)),
  tps: (v) => v.toFixed(0),
  cum: (v) => fmtK(v),
}

export function CurveView(props: {
  m2: M2State | null
  era: Era
  pulse: PulseState | null
  paused?: boolean
  analysis?: AnalysisRow[] | null
  sessionNameOf?: (id: string) => { name: string; title: string } | null
  onOpenTurn?: (session: string, turn: number) => void
  nonce?: number
}): ReactNode {
  const [key, setKey] = useState<CurveKey>('miss')
  const [scope, setScope] = useState<string>('all')
  const [pickOpen, setPickOpen] = useState(false)
  // 构成柱悬停行号（原始 rows 下标；悬停读数与高亮由本视图持有，StackedBars 无 hooks）
  const [stackHover, setStackHover] = useState<number | null>(null)
  // 时间档位（1 周 / 1 月）；全屏：绝对定位占满工作台面板（fixed 会被宿主布局的 transform 基改名空间劫持）、Esc 退出
  const [range, setRange] = useState<7 | 30>(7)
  const [full, setFull] = useState(false)
  // 轴口径（轮次轴 / 日期轴）与尾窗裁剪——沿旧 L 场 tab 的两态（axis），便于跨会话对齐轮序
  const [axis, setAxis] = useState<'date' | 'turn'>('date')
  // 数据源：NEXUS 轮次（事件驱动，非等间隔）/ PULSE 采样（等间隔，斜率可读）
  const [source, setSource] = useState<'nautilus' | 'pulse'>('nautilus')
  const metrics = (props.pulse?.latest ?? []).map((l) => l.metric)
  const [picked, setPicked] = useState<string>('')
  const metric = picked !== '' && metrics.includes(picked) ? picked : (metrics[0] ?? '')
  // PULSE 采样曲线：刷新与心跳对齐（auto 档=心跳间隔；手动档不轮询、采样完成经 nonce 重取）
  const series = useJson<PulseSeries>('/api/nautilus/pulse/series?metric=' + encodeURIComponent(metric) + '&windowMs=3600000&maxPoints=240', metric === '' || source !== 'pulse' || props.paused === true, heartbeatSeriesMs(props.pulse?.collector ?? null), props.nonce ?? 0)
  // T 系列人工层（D-T5）：已标轮清单取一次不轮询（nonce 触发重取）→ 曲线/构成柱徽标。只改点样貌不动读数线。
  const fits = useJson<{ annotations: Array<{ session: string; turn: number; fit: number | null; exempt: number }> }>('/api/nautilus/m2/turn-annotations', props.paused === true, 0, props.nonce ?? 0)
  const fitMark = new Map<string, string>()
  for (const a of fits?.annotations ?? []) fitMark.set(String(a.session) + ':' + String(a.turn), Number(a.exempt) === 1 ? 'N' : String(a.fit ?? 'N'))
  const markOf = (s: string, t: number): string | null => fitMark.get(String(s) + ':' + String(t)) ?? null
  // 全屏：Esc 退出（图表高度由 CurveChart 自测容器，无需宿主侧实测）
  useEffect(() => {
    if (!full) return undefined
    const onK = (e: { key: string }): void => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onK)
    return () => { window.removeEventListener('keydown', onK) }
  }, [full])
  // 时间档位过滤（1 周 / 1 月）
  const rangeFrom = Date.now() - range * 86400000
  const curve = (props.m2?.curve ?? []).filter((p) => p.ts >= rangeFrom)
  const sessions = Array.from(new Set(curve.map((p) => p.session)))
  const scoped = scope === 'all' ? curve : curve.filter((p) => p.session === scope)
  // 输入构成堆叠柱（方案 A，借鉴 Grafana 构成行）：每轮一根，缓存读（墨）+ 未命中输入（朱红）；输出令牌是另一维度不入图
  const stackRows = scoped.map((p) => ({
    x: axis === 'date' ? p.ts : p.turn,
    session: p.session,
    turn: p.turn,
    segs: [
      { key: 'read', v: p.cacheRead, fill: 'var(--nt-ink,#101010)', name: '缓存读' },
      { key: 'miss', v: p.tokenIn, fill: 'var(--nt-accent,#e6321e)', name: '未命中输入' },
    ],
  }))
  // cum = 累计输入（Σ(命中+未命中) 按轮序，弱代理；中段加速平台 = S 形候选，正式判据仍看未命中率曲线）
  let cumAcc = 0
  const pts = scoped.map((p) => {
    const x = axis === 'date' ? p.ts : p.turn
    if (key === 'cum') { cumAcc += p.tokenIn + p.cacheRead; return { x, y: cumAcc, meta: p } }
    const v = curveValue(p, key)
    return { x, y: v === null ? null : (key === 'miss' ? v * 100 : v), meta: p }
  })
  const threshold = key === 'miss' ? 50 : undefined
  // τ_e 注记（定稿元素）：仅单会话聚焦且 analysis 检出时绘制——多点叠加轴上 τ_e 无意义
  let anno: { from: number; to: number; txt: string } | undefined
  if (key === 'miss' && scope !== 'all' && pts.length >= 4) {
    const hit = (props.analysis ?? []).find((a) => a.session === scope)
    if (hit !== undefined && hit.tauE !== null && Number.isFinite(hit.tauE)) {
      const from = Math.floor(pts.length * 0.3)
      anno = { from, to: Math.min(pts.length - 1, from + Math.round(hit.tauE)), txt: 'τ_e ≈ ' + String(hit.tauE) + ' turn（' + (SHAPE_LABEL[hit.shape] ?? hit.shape) + '）' }
    }
  }
  const pulsePts = (series?.points ?? []).map((p) => ({ x: p.ts, y: p.value }))
  // 会话看板：名称 = dsh 工作区目录名（宿主 sessions 服务 cwd 末段），回退 displayTitle/短 id；按起始时间倒序
  const sortedSessions = sessions.slice().sort((x, y) => {
    const mx = props.m2?.sessionMeta[x]?.startTs ?? 0
    const my = props.m2?.sessionMeta[y]?.startTs ?? 0
    return my - mx
  })
  // 会话显示名 =「工作区目录名 · 会话标题」——两者都有才拼接，缺一回退（cwd 缺 → 标题/短 id）
  const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)
  const sessionDisplay = (sid: string): { ws: string; title: string } => {
    const info = props.sessionNameOf?.(sid) ?? null
    const title = info?.title ?? ''
    if (info === null || info.name === '') return { ws: title === '' ? sid.slice(0, 10) : '', title: title === '' ? '' : title }
    return { ws: info.name, title }
  }
  const displayName = (sid: string): string => {
    const d = sessionDisplay(sid)
    if (d.ws === '') return d.title
    return d.title === '' ? d.ws : d.ws + ' · ' + trunc(d.title, 28)
  }
  const scopeLabel = (sid: string): string => {
    const meta = props.m2?.sessionMeta[sid]
    return displayName(sid) + '（' + fmtDayTime(meta?.startTs) + '）'
  }
  const tipOf = (m: M2Point): { head: string; lines: string[] } => {
    const mr = curveValue(m, 'miss')
    return {
      head: fmtDayTime(m.ts) + ' · turn ' + String(m.turn) + ' · ' + displayName(m.session),
      lines: [
        '输入(未命中) ' + String(m.tokenIn) + ' · 缓存读 ' + String(m.cacheRead) + ' · 输出 ' + String(m.tokenOut),
        '未命中率 ' + (mr === null ? '—' : (mr * 100).toFixed(1) + '%') + ' · TPS ' + fmtNum(m.tps, 1) + ' · 时长 ' + (m.durationMs === null ? '—' : String(Math.round(m.durationMs)) + ' ms'),
      ],
    }
  }
  const metricSeg = createElement('div', { className: 'nt-wb-seg' },
    ...(['miss', 'stack', 'cum', 'tps', 'ms'] as CurveKey[]).map((k) => createElement('button', { key: k, className: k === key ? 'on' : '', onClick: () => setKey(k) }, curveLabel(k))),
    createElement('span', { style: { width: 12 } }),
    ...([7, 30] as Array<7 | 30>).map((r) => createElement('button', { key: r, className: range === r ? 'on' : '', onClick: () => setRange(r) }, r === 7 ? '1 周' : '1 月')),
    createElement('span', { style: { width: 12 } }),
    ...(['date', 'turn'] as Array<'date' | 'turn'>).map((a) => createElement('button', { key: a, className: axis === a ? 'on' : '', onClick: () => setAxis(a) }, a === 'date' ? '日期轴' : '轮次轴')),
  )
  // M4-B：自评覆盖（当前视图口径；选中会话时带缺口轮号）——原 L 场 tab 的这条信息搬进工作台
  const sc = props.m2?.selfcheck
  const scSel = scope === 'all' ? undefined : sc?.bySession?.[scope]
  const coverageLine = createElement('span', { className: 'nt-label' },
    sc === undefined || sc.total === 0
      ? '自评覆盖：本视图暂无轮次'
      : '自评覆盖 ' + ((sc.checked / sc.total) * 100).toFixed(0) + '%（' + String(sc.checked) + '/' + String(sc.total) + ' 轮）'
        + (scSel === undefined
          ? ''
          : ' · 本会话 ' + String(scSel.checked) + '/' + String(scSel.total) + ' 轮'
            + (scSel.missing.length > 0 ? ' · 缺 ' + scSel.missing.map((n) => 't' + String(n)).join(' ') : ' · 无缺口')))
  const pickerBox = createElement('div', { className: 'nt-wb-pickwrap' },
    createElement('button', { className: 'nt-btn' + (scope !== 'all' ? ' on' : ''), onClick: () => setPickOpen((v) => !v) },
      '会话 · ' + (scope === 'all' ? '全部（' + String(sessions.length) + '）' : scopeLabel(scope)) + ' ▾'),
    pickOpen ? createElement('div', { className: 'nt-wb-scrim2', onClick: () => setPickOpen(false) }) : null,
    pickOpen
      ? createElement('div', { className: 'nt-wb-picker' },
        createElement('div', { className: 'row' + (scope === 'all' ? ' on' : ''), onClick: () => { setScope('all'); setPickOpen(false) } },
          createElement('div', { className: 'nm' }, '全部会话'),
          createElement('div', { className: 'mt' }, String(sessions.length) + ' 个会话 · ' + String(curve.length) + ' 轮')),
                ...sortedSessions.map((s) => {
                  const meta = props.m2?.sessionMeta[s]
                  return createElement('div', { key: s, className: 'row' + (scope === s ? ' on' : ''), onClick: () => { setScope(s); setPickOpen(false) } },
                    createElement('div', { className: 'nm' }, displayName(s)),
                    createElement('div', { className: 'mt' }, fmtDayTime(meta?.startTs) + ' · ' + String(meta?.turns ?? '—') + ' 轮 · ' + s.slice(0, 10)),
                  )
                }),
      )
      : null,
  )
  const stackTip = stackHover !== null && stackRows[stackHover] !== undefined
    ? (() => {
      const r = stackRows[stackHover]
      const tot = r.segs.reduce((a, s) => a + s.v, 0)
      return (axis === 'date' ? fmtDayTime(r.x) : 't' + String(r.turn)) + ' · 缓存读 ' + fmtK(r.segs[0].v) + ' · 未命中 ' + fmtK(r.segs[1].v) + ' · 合计 ' + fmtK(tot) + ' tok · 点击下钻'
    })()
    : '悬停柱看该轮构成 · 点击下钻'
  const stackLegend = createElement('div', { className: 'nt-legend' },
    ...([['缓存读（被复用输入）', 'var(--nt-ink,#101010)'], ['未命中输入（需注意）', 'var(--nt-accent,#e6321e)']] as Array<[string, string]>).map(([nm, c]) =>
      createElement('span', { key: nm }, createElement('i', { style: { background: c } }), nm)),
    createElement('span', { className: 'nt-readout', style: { marginLeft: 'auto' } }, stackTip),
  )
  const stackBars = (hh: number): ReactNode => StackedBars({
    rows: stackRows, h: hh, hoverIndex: stackHover, onHover: setStackHover,
    marks: stackRows.map((r) => markOf(r.session, r.turn)),
    onOpenRow: (i) => { const r = stackRows[i]; if (r !== undefined && props.onOpenTurn !== undefined) props.onOpenTurn(r.session, r.turn) },
    xTick: axis === 'turn' ? (v: number): string => 't' + String(Math.round(v)) : (v: number): string => fmtDayTime(v),
    yFmt: (v: number): string => fmtK(v), label: '输入构成',
  })
  const chartPanel = (hh: number): ReactNode => key === 'stack'
    ? Panel({
      title: curveLabel(key) + ' 时序图' + (full ? '（全屏）' : ''), fig: 'FIG.02',
      note: '输入构成堆叠柱（Grafana 构成行式，每轮一根）：墨色段＝缓存读（被复用的输入），朱红段＝未命中输入（tokenIn 口径）；输出令牌是另一维度，不入此图。柱高＝该轮输入总量；轮次为离散事件、非均匀时间采样，柱距不代表等时距。悬停看该轮构成，点击柱下钻完整问答。',
      children: createElement('div', null, stackLegend, stackBars(hh)),
    })
    : Panel({
      title: curveLabel(key) + ' 时序曲线' + (full ? '（全屏）' : ''), fig: 'FIG.02',
      note: '时间轴为记录时间戳（非等间隔）：轮次并非均匀采样，曲线的斜率不代表速率；朱红虚线为阈值参考（' + (threshold === undefined ? '本指标不设阈值' : String(threshold) + curveUnit(key)) + '），朱红实心点＝越过阈值的轮；τ_e 注记取自 /m2/analysis 检出值（单会话聚焦时显示）。时间档位 ' + (range === 7 ? '1 周' : '1 月') + '。',
      children: CurveChart({ points: pts, threshold, thresholdLabel: 'S 形阈值参考（P1）', yFmt: CURVE_YFMT[key], anno, marks: pts.map((p) => markOf(p.meta.session, p.meta.turn)), xTick: axis === 'turn' ? (v: number): string => 't' + String(Math.round(v)) : undefined, h: hh, label: curveLabel(key), tipOf, onOpenTurn: props.onOpenTurn, resetKey: String(range) + '/' + String(key) + '/' + String(scope) }),
    })
  if (full) {
    return createElement('div', { style: { position: 'absolute', inset: 0, zIndex: 55, background: 'var(--nt-bg,#f2f2f0)', display: 'flex', flexDirection: 'column', padding: '12px 18px', overflow: 'hidden' } },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
        createElement('span', { style: { fontWeight: 700, letterSpacing: 2, fontSize: 13 } }, 'NAUTILUS · ' + curveLabel(key)),
        metricSeg,
        pickerBox,
        createElement('span', { style: { flex: 1 } }),
        createElement('button', { className: 'nt-btn', onClick: () => setFull(false) }, '✕ 退出全屏（Esc）'),
      ),
      createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        createElement('div', { className: 'nt-note', style: { margin: '0 0 8px', flex: 'none' } },
          '时间档位 ' + (range === 7 ? '1 周' : '1 月') + ' · 滚轮放缩（指针为锚，双击复位）· 左键按住拖动平移 · 悬停采样点看简略读数，点击下钻完整问答。'),
        createElement('div', { style: { flex: 1, minHeight: 0 } },
          key === 'stack'
            ? createElement('div', null, stackLegend, stackBars(360))
            : CurveChart({ points: pts, threshold, thresholdLabel: 'S 形阈值参考（P1）', yFmt: CURVE_YFMT[key], anno, marks: pts.map((p) => markOf(p.meta.session, p.meta.turn)), fill: true, label: curveLabel(key), tipOf, onOpenTurn: props.onOpenTurn, resetKey: String(range) + '/' + String(key) + '/' + String(scope) }),
        ),
      ),
    )
  }
  return createElement('div', null,
    createElement('div', { className: 'nt-wb-seg', style: { marginBottom: 10 } },
      createElement('button', { className: source === 'nautilus' ? 'on' : '', onClick: () => setSource('nautilus') }, 'NEXUS 轮次'),
      createElement('button', { className: source === 'pulse' ? 'on' : '', onClick: () => setSource('pulse') }, 'PULSE 采样'),
    ),
    source === 'nautilus'
      ? createElement('div', null,
        createElement('div', { style: { marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          metricSeg,
          pickerBox,
          createElement('span', { className: 'nt-note', style: { marginTop: 0, flex: '1 1 260px' } },
            '会话名 = dsh 工作区目录名（取自宿主会话列表 cwd）。滚轮放缩（指针为锚，双击复位）；左键按住拖动平移；悬停采样点看该轮简略读数，点击下钻完整问答。'),
          createElement('span', { style: { flex: 1 } }),
          coverageLine,
          createElement('button', { className: 'nt-btn', onClick: () => setFull(true) }, '⛶ 全屏'),
        ),
        chartPanel(340),
      )
      : createElement('div', null,
        createElement('div', { className: 'nt-wb-seg', style: { marginBottom: 10 } },
          createElement('select', { className: 'nt-select', value: metric, onChange: (e: { target: { value: string } }) => setPicked(e.target.value) },
            ...metrics.map((m) => createElement('option', { key: m, value: m }, metricLabel(m) + '（' + metricGroup(m) + '）'))),
        ),
        Panel({
          title: '本机采样曲线 · ' + (metric === '' ? '无指标' : metricLabel(metric)), fig: 'FIG.02',
          note: 'PULSE 是等间隔采样（默认 5 s 一采，桶均值聚合到最多 240 点）：与 NEXUS 轮次曲线不同，这里的时间轴均匀，斜率可读。窗口 1 小时；刷新与心跳对齐：' + heartbeatRefreshLabel(props.pulse?.collector ?? null) + '。',
          children: metrics.length === 0
            ? Empty({ text: 'PULSE 层缺席：无指标可选（宿主内子插件未挂载）' })
            : Spark({ points: pulsePts, h: 180, label: metricLabel(metric) }),
        }),
      ),
    Panel({
      title: '三层同窗对齐', fig: 'FIG.03',
      note: 'PULSE 采样间隔与 NEXUS 轮次不同步，当前只能做「邻近对照」，不能做同窗归因——跨越这条线的任何结论都必须降级为对照措辞。',
      children: Empty({ text: 'INFER 层缺席：同窗对齐需 TTFT/provider 读数（Phase 2a）' }),
    }),
    Panel({
      title: 'era 对照集', fig: 'FIG.04',
      note: eraNote(props.era),
      children: createElement('div', { style: { fontSize: 11, color: 'var(--nt-dim,#5f5f5c)' } },
        '当前 era=' + props.era + '，措辞档位：' + eraWord(props.era) + '。窗口内轮次 ' + String(curve.length) + ' 条，会话 ' + String(sessions.length) + ' 个。'),
    }),
  )
}

// ── 视图 3：假设 ──────────────────────────────────────────────────────────────

export function HypothesesView(props: { m2: M2State | null; ann: AnnotationsState | null; analysis: AnalysisRow[] | null; onProphecy: (id: string) => void }): ReactNode {
  const status = (id: string): string => {
    const hit = props.ann?.annotations.find((a) => a.prophecy === id)
    return hit === undefined ? 'pending' : hit.status
  }
  const n = props.m2?.totals
  // M3-F.3 白盒分析的产出直接当证据位：形态分布 / τ_e 可算性 / 爆发段——不再写「需 Phase 2a」这类过期占位
  const rows = props.analysis ?? []
  const shapeCount = rows.reduce((acc: Record<string, number>, r) => { acc[r.shape] = (acc[r.shape] ?? 0) + 1; return acc }, {})
  const shapeText = Object.entries(shapeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => (SHAPE_LABEL[k] ?? k) + ' ' + String(v)).join(' · ')
  const taus = rows.map((r) => r.tauE).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b)
  const tauMedian = taus.length === 0 ? null : taus[Math.floor(taus.length / 2)]
  const evidence: Record<string, string> = {
    P1: n === undefined ? '待窗口读数' : '窗口命中率 ' + (n.hitRate === null ? '—' : (n.hitRate * 100).toFixed(1) + '%') + '（' + String(n.turns) + ' 轮）· 白盒形态 ' + (shapeText === '' ? '未检出' : shapeText),
    P2: props.m2 === null ? '待自评落盘' : '自评 ' + String(props.m2.selfcheck.checked) + '/' + String(props.m2.selfcheck.total),
    P3: '需逐轮自评与未命中率同轮对齐（自评覆盖 ' + String(props.m2 === null ? 0 : props.m2.selfcheck.checked) + ' 轮）',
    P4: tauMedian === null ? 'τ_e 暂不可算（需 ≥4 轮且检出形态）' : 'τ_e 可算 ' + String(taus.length) + '/' + String(rows.length) + ' 会话 · 中位 ' + String(tauMedian) + ' turn',
    P5: n === undefined || n.turns === 0 ? '待读数' : 'TPS 与未命中率的相关性待逐轮配对（当前 ' + String(n.turns) + ' 轮）',
    P6: '需跨工作区对照（L 场指向可切换；会话按启动工作区归属，两边读数不混算）',
    P7: '需 PULSE 同窗采样（间隔不同步，只能邻近对照）',
    P8: 'era=api 下显存与推理无因果通路',
    P9: '需自评覆盖率提升前后两窗口',
  }
  const analysed = rows.slice().sort((a, b) => (b.tauE ?? -1) - (a.tauE ?? -1)).slice(0, 12)
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '假设是待检验命题，不是结论。每条假设的状态由人工标注（预言视图）决定；读数只提供证据位，不自动判定。'),
    ...PROPHECY_SEED.map(([id, text]) => {
      const st = status(id)
      return createElement('div', { key: id, className: 'nt-card', onClick: () => props.onProphecy(id), style: { cursor: 'pointer' } },
        createElement('div', { className: 'hd' },
          createElement('b', null, id),
          createElement('span', { className: 'st' + (st === 'checked' ? ' on' : '') }, STATUS_LABEL[st] ?? st),
        ),
        createElement('p', null, text),
        createElement('p', { style: { color: 'var(--nt-faint,#9a9a95)', fontSize: 10.5 } }, '证据位：' + (evidence[id] ?? '—')),
      )
    }),
    Panel({
      title: '白盒分析（/m2/analysis）', fig: 'FIG.09',
      note: 'M3-F.3 白盒：形态由未命中率序列的拐点与单调性**检出**，τ_e 是探索段长度（turn）。检出不是判定——假设成立与否仍由人工标注决定（见预言视图）。',
      children: rows.length === 0
        ? Empty({ text: '分析接口无结果（窗口内会话不足 4 轮，或接口不可达）' })
        : createElement('div', null,
          createElement('table', { className: 'nt-tbl' },
            createElement('thead', null, createElement('tr', null, ...['会话', '形态', '爆发段', 'τ_e'].map((h) => createElement('th', { key: h }, h)))),
            createElement('tbody', null, ...analysed.map((r) => createElement('tr', { key: r.session },
              createElement('td', null, shortSession(r.session)),
              createElement('td', null, SHAPE_LABEL[r.shape] ?? r.shape),
              createElement('td', null, r.burst === null ? '—' : 't' + String(r.burst.fromTurn) + '→' + String(r.burst.toTurn) + '（' + (r.burst.direction === 'down' ? '降' : '升') + '）'),
              createElement('td', null, r.tauE === null ? '—' : String(r.tauE) + ' turn'),
            )))),
          createElement('p', { className: 'nt-note' }, '检出会话 ' + String(rows.length) + ' 个 · 形态分布 ' + (shapeText === '' ? '—' : shapeText) + ' · τ_e 中位 ' + (tauMedian === null ? '—' : String(tauMedian) + ' turn')),
        ),
    }),
  )
}

// ── 视图 4：预言 ──────────────────────────────────────────────────────────────

export function ProphecyView(props: { ann: AnnotationsState | null; m2: M2State | null; toast: (m: string) => void; reload: () => void }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string>('')
  const [cur, setCur] = useState<string>('P1')
  const mine = props.ann?.annotations.find((a) => a.prophecy === cur)
  const save = async (status: string): Promise<void> => {
    setBusy(cur)
    try {
      const r = await fetch('/api/nautilus/m2/annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prophecy: cur, status, note: note === '' ? (mine?.note ?? null) : note }),
      })
      if (!r.ok) { props.toast('标注失败：HTTP ' + String(r.status)); return }
      props.toast(cur + ' → ' + (STATUS_LABEL[status] ?? status))
      props.reload()
    } catch (e) { props.toast('标注失败：' + String(e)) } finally { setBusy(null) }
  }
  return createElement('div', null,
    createElement('div', { className: 'nt-note', style: { marginTop: 0 } },
      '标注是解释层：它记录人对读数的解读，永不写回读数本身（读数不可变）。标注表与 pulse 表同库，POST 是唯一写路径。'),
    Panel({
      title: '预言标注', fig: 'FIG.05',
      note: 'P1–P9 为登记在案的预言清单；状态与备注存于 annotation。',
      children: createElement('div', null,
        createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          createElement('select', { className: 'nt-select', value: cur, onChange: (e: { target: { value: string } }) => { setCur(e.target.value); setNote('') } },
            ...PROPHECY_SEED.map(([id, text]) => createElement('option', { key: id, value: id }, id + ' · ' + text.slice(0, 22)))),
          createElement('span', { className: 'st', style: { fontSize: 10 } }, STATUS_LABEL[mine?.status ?? 'pending'] ?? '待标注'),
          ...['pending', 'doing', 'checked'].map((s) => createElement('button', { key: s, className: 'nt-btn', disabled: busy !== null, onClick: () => { void save(s) } }, STATUS_LABEL[s] ?? s)),
        ),
        createElement('div', { style: { marginTop: 8 } },
          createElement('textarea', {
            className: 'nt-input', style: { width: '100%', minHeight: 56, fontFamily: 'inherit' },
            placeholder: mine?.note ?? '备注（证据、反例、边界条件）',
            value: note, onChange: (e: { target: { value: string } }) => setNote(e.target.value),
          })),
        createElement('p', { className: 'nt-note' }, mine === undefined ? '当前预言尚无标注记录。' : '最近更新 ' + fmtTime(mine.updatedAt) + '：' + (mine.note ?? '（无备注）')),
      ),
    }),
    Panel({
      title: '自评证据', fig: 'FIG.06',
      note: 'record_turn_selfcheck 是每轮推理态自评（clarity/defense/declaration）；覆盖率低时 P2/P3 不可检验——此时结论只能停在「样本不足」。',
      children: props.m2 === null
        ? Empty({ text: 'M2 读数接口读取中或不可用' })
        : createElement('div', { style: { fontSize: 11.5, lineHeight: 1.7 } },
          '自评覆盖率 ' + String(props.m2.selfcheck.checked) + ' / ' + String(props.m2.selfcheck.total) + ' 轮（' +
          (props.m2.selfcheck.total === 0 ? '0' : ((props.m2.selfcheck.checked / props.m2.selfcheck.total) * 100).toFixed(0)) + '%）——' +
          (props.m2.selfcheck.total === 0 ? '窗口内无轮次，无从检验。' : props.m2.selfcheck.checked === 0 ? '尚未落盘任何自评，P2/P3 停在样本不足。' : '已可做初步配对，样本量仍小。')),
    }),
  )
}
// ── 视图 5：报告 ──────────────────────────────────────────────────────────────

export function ReportView(props: { m2: M2State | null; pulse: PulseState | null; era: Era; ann: AnnotationsState | null; analysis: AnalysisRow[] | null }): ReactNode {
  const { m2, pulse, era } = props
  const n = m2?.totals
  const curve = m2?.curve ?? []
  const from = curve.length === 0 ? null : curve[0].ts
  const to = curve.length === 0 ? null : curve[curve.length - 1].ts
  const win = from === null || to === null ? '窗口内无轮次' : new Date(from).toLocaleString('zh-CN', { hour12: false }) + ' → ' + new Date(to).toLocaleString('zh-CN', { hour12: false })
  const marked = props.ann === null ? 0 : props.ann.annotations.filter((a) => a.status === 'checked').length
  const rows = props.analysis ?? []
  const shapeCount = rows.reduce((acc: Record<string, number>, r) => { acc[r.shape] = (acc[r.shape] ?? 0) + 1; return acc }, {})
  const shapeText = Object.entries(shapeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => (SHAPE_LABEL[k] ?? k) + ' ' + String(v)).join(' · ')
  const taus = rows.map((r) => r.tauE).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b)
  const tauMedian = taus.length === 0 ? null : taus[Math.floor(taus.length / 2)]
  const save = (name: string, text: string, mime: string): void => {
    if (typeof document === 'undefined') return
    const url = URL.createObjectURL(new Blob([text], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    // Firefox 要求锚点在文档里才触发 click 下载
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const snapshot = { generatedAt: new Date().toISOString(), era, claiming: eraWord(era), m2, pulse, annotations: props.ann, analysis: props.analysis }
  const md = [
    '# Nautilus 观测报告（中间报告）',
    '',
    '- 生成时间：' + new Date().toISOString(),
    '- era：' + era + '（措辞档位：' + eraWord(era) + '）',
    '- 观测窗口：' + win,
    '- 读数样本：' + String(curve.length) + ' 轮 / ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 会话',
    '- 层在场：NEXUS ' + (m2 === null ? '缺席' : '在场') + ' · PULSE ' + (pulse === null ? '缺席' : '在场') + ' · INFER 缺席（Phase 2a）',
    '',
    '## 一并附带的诚实边界',
    '',
    '1. 命中率绝对值受会话口径影响，偏高；它衡量的是「同窗口内被缓存复用的输入占比」，不是「知识利用率」。',
    '2. NEXUS 与 PULSE 采样不同步（轮次事件 vs 定时采样），跨层陈述只能取邻近对照，不构成同窗归因。',
    '3. 本报告的 τ_e 是白盒轮次级探索段长度（/m2/analysis 检出）；端到端时延与探索率的耦合仍需 INFER 层，故报告不含任何时延结论。',
    '4. 人工标注 ' + String(marked) + ' 条已检验；未标注项一律视为未检验，不并入结论。',
    '',
  ].join(String.fromCharCode(10))
  const gateOk = m2 !== null && pulse !== null
  return createElement('div', { className: 'nt-report' },
    createElement('div', { className: 'meta' },
      ...([
        ['生成时间', new Date().toLocaleString('zh-CN', { hour12: false })],
        ['era', era + ' · ' + eraWord(era)],
        ['观测窗口', win],
        ['读数样本', String(curve.length) + ' 轮 / ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 会话'],
        ['层在场', 'NEXUS ' + (m2 === null ? '缺席' : '在场') + ' · PULSE ' + (pulse === null ? '缺席' : '在场') + ' · INFER 缺席'],
        ['人工标注', String(marked) + ' 条已检验'],
        ['白盒分析', rows.length === 0 ? '无检出' : String(rows.length) + ' 会话 · ' + (shapeText === '' ? '形态未定' : shapeText) + ' · τ_e 中位 ' + (tauMedian === null ? '—' : String(tauMedian) + ' turn')],
      ] as Array<[string, string]>).flatMap(([k, v]) => [createElement('b', { key: k }, k), createElement('span', { key: k + ':v' }, v)])),
    createElement('div', { className: 'prose' },
      createElement('p', null, '一、样本与窗口。本报告覆盖 ' + String(curve.length) + ' 轮读数，来自 ' + String(props.m2 === null ? 0 : Object.keys(props.m2.sessionMeta).length) + ' 个会话；窗口自 ' + win + '。窗口由落库轮次决定，不是人工划定的实验区间——因此任何「前后对比」都要先确认两侧样本量是否可比。'),
      createElement('p', null, '二、缓存结构。窗口内缓存命中率 ' + (n === undefined || n.hitRate === null ? '暂无读数' : (n.hitRate * 100).toFixed(1) + '%') + '（读 ' + String(n?.cacheRead ?? 0) + ' / 未命中 ' + String(n?.missToken ?? 0) + ' 令牌）。这一列最能说明「上下文是否被复用」，但它同时受长上下文与话题切换混杂；把它当作探索率的投影，而不是结论。'),
      createElement('p', null, '三、本机侧。PULSE 采集器 tick ' + String(pulse?.collector.ticks ?? 0) + ' 次，库内 ' + String(pulse?.db.rows ?? 0) + ' 行 ' + String(pulse === null ? 0 : pulse.latest.length) + ' 指标；shell=' + String(pulse?.collector.shellPath ?? '无') + '，GPU 通道 ' + (pulse?.collector.gpuOk === true ? '可用' : '不可用') + '。本机读数与云端缓存之间在 era=' + era + ' 下' + (era === 'api' ? '没有因果通路' : '存在因果通路') + '，故报告中二者只作对照。'),
      createElement('p', null, '四、白盒分析。M3-F.3 在本窗口检出 ' + String(rows.length) + ' 个会话的形态（' + (shapeText === '' ? '无' : shapeText) + '）；探索段长度 τ_e 可算 ' + String(taus.length) + ' 个，中位 ' + (tauMedian === null ? '—' : String(tauMedian) + ' turn') + '。形态与 τ_e 是**检出**，不是判定：它们只说明「曲线长这样」，是否支持某条假设仍由人工标注决定。'),
      createElement('p', null, '五、缺席与上限。读数按会话启动工作区归属，跨根不混算；vault 观测腿已于 2026-09-27 下线，报告不含 vault 维度。INFER 层（TTFT/provider）尚未接入，**端到端时延与探索率的耦合**无法计算；本报告的 τ_e 是白盒的轮次级探索段长度，与 INFER 条件下的时延耦合不是同一个量。据此最高结论强度为「' + eraWord(era) + '」，且限于单层内部。'),
    ),
    createElement('div', { className: 'gate' },
      createElement('span', { className: 'nt-tag' + (gateOk ? '' : ' red') }, gateOk ? '读数层齐备' : '读数层缺口'),
      createElement('span', null, '交付门：' + (gateOk ? 'NEXUS 与 PULSE 均在场，报告可作为中间报告交付；升级为正式报告需补 INFER 层与人工检验标注。' : 'NEXUS 或 PULSE 缺席，本报告仅为现场快照，不可作为阶段交付。')),
    ),
    createElement('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
      createElement('button', { className: 'nt-btn', onClick: () => save('nautilus-report.json', JSON.stringify(snapshot, null, 2), 'application/json') }, '导出 JSON 快照'),
      createElement('button', { className: 'nt-btn', onClick: () => save('nautilus-report.md', md, 'text/markdown') }, '导出 Markdown'),
      createElement('span', { style: { fontSize: 10, color: 'var(--nt-faint,#9a9a95)', alignSelf: 'center' } }, '导出为本地文件，不写回任何观测数据'),
    ),
  )
}

// ── 抽屉：单轮钻取（读数 vs 解读分层）──────────────────────────────────────────

export type DrawerTarget = { session: string; turn: number }
export type TurnText = { found: boolean; session?: string; turn?: number; userText?: string; assistantText?: string }

export function Drawer(props: { target: DrawerTarget; point: M2Point | null; onClose: () => void }): ReactNode {
  const [text, setText] = useState<TurnText | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setText(null)
    const url = '/api/nautilus/m2/turn-text?session=' + encodeURIComponent(props.target.session) + '&turn=' + String(props.target.turn)
    fetch(url, { headers: { 'sec-fetch-site': 'same-origin' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setText(j as TurnText) })
      .catch(() => { if (alive) setText(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [props.target.session, props.target.turn])
  const p = props.point
  const miss = p === null ? null : curveValue(p, 'miss')
  const rows: Array<[string, string]> = p === null ? [] : [
    ['输入（未命中）', String(p.tokenIn)],
    ['缓存读', String(p.cacheRead)],
    ['输出', String(p.tokenOut)],
    ['未命中率', miss === null ? '—' : (miss * 100).toFixed(1) + '%'],
    ['时长', p.durationMs === null ? '—' : String(Math.round(p.durationMs)) + ' ms'],
    ['TPS', fmtNum(p.tps, 1)],
  ]
  const selfRows: Array<[string, string]> = p === null ? [] : [
    ['clarity', p.clarity === null || p.clarity === undefined ? '未落盘' : String(p.clarity)],
    ['defense', p.defense === null || p.defense === undefined ? '未落盘' : String(p.defense)],
    ['declaration', p.declaration === null || p.declaration === undefined ? '未落盘' : String(p.declaration)],
  ]
  return createElement('div', null,
    createElement('div', { className: 'nt-scrim', onClick: props.onClose }),
    createElement('div', { className: 'nt-drawer' },
      createElement('div', { className: 'dh' },
        createElement('span', null, '单轮钻取 · t' + String(props.target.turn)),
        createElement('span', { className: 'nt-tag' }, props.target.session.slice(0, 10)),
        createElement('button', { className: 'nt-btn', onClick: props.onClose }, '关闭'),
      ),
      createElement('div', { className: 'db' },
        createElement('p', { className: 'nt-note', style: { marginTop: 0 } }, '本抽屉分两层：上半是读数（客观、不可变），下半是原文与自评（解释层）。原文只读，永不写回读数。'),
        createElement('h5', null, '读数（turn_read）'),
        p === null
          ? Empty({ text: '本窗口内无该轮读数（可能已被裁剪策略清除）' })
          : createElement('table', { className: 'nt-tbl' }, createElement('tbody', null, ...rows.map(([k, v]) => createElement('tr', { key: k }, createElement('td', { style: { width: '42%', color: 'var(--nt-faint,#9a9a95)' } }, k), createElement('td', null, v))))),
        createElement('h5', null, '推理态自评（record_turn_selfcheck）'),
        selfRows.every(([, v]) => v === '未落盘')
          ? Empty({ text: '该轮未落盘自评 → P2/P3 在此轮不可检验' })
          : createElement('table', { className: 'nt-tbl' }, createElement('tbody', null, ...selfRows.map(([k, v]) => createElement('tr', { key: k }, createElement('td', { style: { width: '42%', color: 'var(--nt-faint,#9a9a95)' } }, k), createElement('td', null, v))))),
        createElement('h5', null, '完整问答（turn_text）'),
        loading
          ? Empty({ text: '读取中' })
          : text === null
            ? Empty({ text: '原文接口不可用' })
            : text.found === false
              ? Empty({ text: '该轮原文未采集（B 方案自 M3-F.2 起前向积累；此轮早于部署）' })
              : createElement('div', null,
                createElement('div', { style: { fontSize: 11, color: 'var(--nt-faint,#9a9a95)' } }, '问'),
                createElement('p', { style: { fontSize: 12, lineHeight: 1.7, margin: '2px 0 10px' } }, text.userText === undefined || text.userText === '' ? '（空）' : text.userText),
                createElement('div', { style: { fontSize: 11, color: 'var(--nt-faint,#9a9a95)' } }, '答'),
                createElement('p', { style: { fontSize: 12, lineHeight: 1.7, margin: '2px 0 0', whiteSpace: 'pre-wrap' } }, text.assistantText === undefined || text.assistantText === '' ? '（空）' : text.assistantText.slice(0, 6000)),
              ),
      ),
    ),
  )
}

// ── 根组件 ────────────────────────────────────────────────────────────────────

export type ViewKey = 'overview' | 'alerts' | 'curve' | 'hypotheses' | 'prophecy' | 'report'
export const VIEW_LABEL: Record<ViewKey, string> = { overview: '总览', alerts: '告警', curve: '曲线', hypotheses: '假设', prophecy: '预言', report: '报告' }
export const WORKBENCH_LABEL = 'Nautilus 工作台'

/** 工作台根组件。onExitToConversation 由宿主半区注入（ctx.layout.selectPanel(null)），用于回到会话。 */
export function Workbench(props: { onExitToConversation?: () => void; sessionNameOf?: (id: string) => { name: string; title: string } | null } = {}): ReactNode {
  injectWorkbenchStyle()
  const [view, setView] = useState<ViewKey>('overview')
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null)
  const [era, setEra] = useState<Era>('api')
  const [toast, setToast] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const paused = drawer !== null
  // L 场视图两态（原 L 场 tab 的全局/指向）：默认全局（?root=all），可切到当前 L 场指向
  const [viewMode, setViewMode] = useState<'pointed' | 'all'>('all')
  const [newRoot, setNewRoot] = useState('')
  const [switching, setSwitching] = useState(false)
  const m2 = useJson<M2State>('/api/nautilus/m2/state' + (viewMode === 'all' ? '?root=all' : ''), paused, 120000, nonce)
  // 实时读数：OS 层每 1s 重取最新值（/pulse/state 只查 15 行 latest，代价可忽略）；
  // 手动档下值不会变，但重取同样廉价，故不额外分支。
  const pulse = useJson<PulseState>('/api/nautilus/pulse/state', paused, 1000, nonce)
  // A 系列：告警台账（5s 一取——确认/解除是分钟级事件，不必跟 1s 心跳）
  const alerts = useJson<AlertsState>('/api/nautilus/pulse/alerts?limit=50', paused, 5000, nonce)
  const ann = useJson<AnnotationsState>('/api/nautilus/m2/annotations', paused, 120000, nonce)
  // L 场接入（M4-L / M3-F.3）：每根会话计数 + 白盒分析（vault 观测腿 2026-09-27 下线，不再有 vault 取数）
  const lfield = useJson<LfieldInfo>('/api/nautilus/lfield', paused, 120000, nonce)
  const analysisRaw = useJson<{ results?: AnalysisRow[] } | AnalysisRow[]>('/api/nautilus/m2/analysis' + (viewMode === 'all' ? '?root=all' : ''), paused, 600000, nonce)
  // L 场指向切换（原 L 场 tab 的能力）：切换只改「新会话」的归属，既有归属不变
  const switchLfield = (root: string): void => {
    if (root.trim() === '' || switching) return
    setSwitching(true)
    fetch('/api/nautilus/lfield', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ root: root.trim() }),
    })
      .then((r) => { setToast(r.ok ? 'L 场指向已切换（新会话自此归入）' : '切换失败：HTTP ' + String(r.status)); if (r.ok) { setNewRoot(''); setNonce((v) => v + 1) } })
      .catch((e) => setToast('切换失败：' + String(e)))
      .finally(() => setSwitching(false))
  }
  // /m2/analysis 返回 { revision, results }（routes.ts）——归一化为数组，兼容直接数组形态；
  // 未归一化时 rows.reduce 对对象调用会抛错（假设/报告视图渲染失败的根因）
  const analysis = Array.isArray(analysisRaw) ? analysisRaw : (analysisRaw?.results ?? null)
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])
  const point = drawer === null || m2 === null ? null : (m2.curve.concat(m2.recent).find((p) => p.session === drawer.session && p.turn === drawer.turn) ?? null)
  const ok = (v: unknown): string => (v === null ? '缺席' : '在场')
  // 用 createElement 渲染视图组件（**不可**写成 OverviewView({...}) 直接调用）：
  // 直接调用会把子组件的 hooks 算进父组件，切换视图时 hooks 数量变化 → React 抛错、整页渲染失败。
  const body = view === 'overview' ? createElement(OverviewView, { m2, pulse, lfield, viewMode, onViewMode: setViewMode, newRoot, onNewRoot: setNewRoot, switching, onSwitchLfield: switchLfield, onOpenTurn: (s: string, t: number) => setDrawer({ session: s, turn: t }), paused, sessionNameOf: props.sessionNameOf, nonce })
    : view === 'curve' ? createElement(CurveView, { m2, era, pulse, paused, analysis, sessionNameOf: props.sessionNameOf, onOpenTurn: (s: string, t: number) => setDrawer({ session: s, turn: t }), nonce })
    : view === 'hypotheses' ? createElement(HypothesesView, { m2, ann, analysis, onProphecy: (id: string) => { setView('prophecy'); setToast('已跳到预言标注：' + id) } })
    : view === 'alerts' ? createElement(AlertsView, { state: alerts, toast: setToast, reload: () => setNonce((v) => v + 1) })
    : view === 'prophecy' ? createElement(ProphecyView, { ann, m2, toast: setToast, reload: () => setNonce((v) => v + 1) })
    : createElement(ReportView, { m2, pulse, era, ann, analysis })
  return createElement('div', { className: 'nt-wb' },
    createElement('div', { className: 'nt-wb-top' },
      props.onExitToConversation !== undefined
        ? createElement('button', { className: 'nt-btn', style: { marginRight: 2 }, onClick: () => { if (props.onExitToConversation !== undefined) props.onExitToConversation() } }, '← 返回会话')
        : null,
      createElement('div', { className: 'nt-wb-brand' }, 'NAUTILUS', createElement('small', null, 'Observation Workbench')),
      createElement('div', { className: 'nt-wb-seg' }, ...(['overview', 'alerts', 'curve', 'hypotheses', 'prophecy', 'report'] as ViewKey[]).map((k) => createElement('button', { key: k, className: k === view ? 'on' : '', onClick: () => setView(k) }, VIEW_LABEL[k]))),
      createElement('div', { className: 'nt-wb-right' },
        createElement('span', null, 'NEXUS ' + ok(m2) + ' · PULSE ' + ok(pulse)),
        createElement('button', {
          className: 'nt-btn' + ((alerts?.counts.open ?? 0) > 0 ? ' on' : ''),
          title: 'OS 层红线告警',
          onClick: () => setView('alerts'),
        }, '告警 ' + String(alerts?.counts.open ?? 0) + ((alerts?.counts.last24h ?? 0) > 0 ? ' · 24h ' + String(alerts?.counts.last24h ?? 0) : '')),
        createElement('span', null, '刷新 ' + (pulse === null ? '—' : fmtTime(pulse.collector.lastTickTs))),
        createElement(PulseHeartbeat, {
          mode: pulse === null ? 'auto' : pulse.collector.mode,
          intervalMs: pulse === null ? 5000 : pulse.collector.intervalMs,
          paused,
          onDone: (m: string) => setToast(m),
          reload: () => setNonce((v) => v + 1),
        }),
        createElement('button', { className: 'nt-btn', onClick: () => setNonce((v) => v + 1) }, '立即取数'),
      ),
    ),
    createElement('div', { className: 'nt-era' },
      createElement('span', { className: 'badge' }, 'ERA · ' + era.toUpperCase()),
      createElement('span', null, '措辞档位：' + eraWord(era) + '（' + (era === 'api' ? '弱因果' : '强因果') + '）'),
      createElement('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
        createElement('button', { className: 'nt-btn' + (era === 'api' ? ' on' : ''), onClick: () => setEra('api') }, 'api 对照'),
        createElement('button', { className: 'nt-btn' + (era === 'local' ? ' on' : ''), onClick: () => setEra('local') }, 'local 归因'),
      ),
    ),
    createElement('div', { className: 'nt-wb-body' }, createElement(ViewBoundary, { key: view, label: VIEW_LABEL[view] }, body)),
    drawer !== null ? createElement(Drawer, { target: drawer, point, onClose: () => setDrawer(null) }) : null,
    toast !== null ? createElement('div', { className: 'nt-toast' }, toast) : null,
  )
}

/** 侧栏面板图标（sidebar.panellist）：size/active 由壳提供，图标自绘。 */
export function WorkbenchIcon(props: { size?: number; active?: boolean }): ReactNode {
  const s = props.size ?? 18
  const on = props.active === true
  const stroke = on ? 'var(--nt-accent,#e6321e)' : 'currentColor'
  // A 系列（D-A4 裁决后）：**活跃即闪红**（不做 ack）+ 未裁决数徽标；5s 轮询一次轻量台账读口
  ensureAlertStyle()
  const badge = useAlertBadge()
  const alerting = badge.active > 0
  const badgeNode = alerting || badge.unjudged > 0
    ? createElement('g', { className: alerting ? 'nt-icon-alert' : undefined },
      createElement('circle', { cx: 20, cy: 4.6, r: 3.1, fill: 'var(--nt-accent,#e6321e)', fillOpacity: alerting ? 1 : 0.5 }),
      badge.unjudged > 0
        ? createElement('text', { x: 20, y: 6.7, textAnchor: 'middle', fontSize: 5.6, fill: 'var(--nt-panel,#fff)' }, String(Math.min(9, badge.unjudged)))
        : null)
    : null
  return createElement('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', role: 'img', 'aria-label': WORKBENCH_LABEL + (alerting ? '（有活跃告警）' : '') },
    createElement('circle', { cx: 12, cy: 12, r: 8.5, stroke, strokeWidth: 1.4, fill: on ? 'var(--nt-accent,#e6321e)' : 'none', fillOpacity: on ? 0.12 : 0 }),
    createElement('path', { d: 'M3.5 12h17M12 3.5c3 2.6 3 14.4 0 17M12 3.5c-3 2.6-3 14.4 0 17', stroke, strokeWidth: 1.1 }),
    createElement('path', { d: 'M12 12l6.5-4.2', stroke, strokeWidth: 1.4 }),
    createElement('circle', { cx: 18.5, cy: 7.8, r: 1.7, fill: 'var(--nt-accent,#e6321e)' }),
    badgeNode,
  )
}
