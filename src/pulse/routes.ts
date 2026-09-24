/**
 * @dsh-external/dsh-nautilus — pulse 路由（host 半区）。
 *
 * 用途：本层自检 + UI 层取数口 + **运行时心跳档位控制**。
 *   GET  /api/nautilus/pulse/state                        采集状态 + 每指标最新值
 *   GET  /api/nautilus/pulse/series?metric=&windowMs=&maxPoints=   单指标时间序列（桶均值）
 *   POST /api/nautilus/pulse/control                      心跳档位：{ intervalMs } 定时档 | { mode:'manual' } 手动档 | { sample:true } 立即采一次
 *   GET  /api/nautilus/pulse/alerts                       OS 层红线告警：规则 + 运行态 + 台账（A 系列 A.1）
 *   POST /api/nautilus/pulse/alerts/verdict               人工裁决 { id, verdict, note? }（A.4；不设审批门）
 *   GET  /api/nautilus/pulse/alerts/report?id=            报告全文（A.4 查看入口；未成文 404）
 *
 * 与 nautilus 路由同一守卫口径（同源标记）。**control 只改采集节律，不写业务读数**——
 * 它决定「多久采一次」，采样本身仍走同一条 tick 路径（同库同表）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PulseStore } from './store.js'
import type { PulseCollectorStatus } from './index.js'
import type { AlertRule, AlertRuntimeState } from './alerts.js'

/** 集中常量：pulse 路由前缀（AGENTS.md §1-4）。 */
export const PULSE_API_PREFIX = '/api/nautilus/pulse'

/** 定时档允许的间隔区间（UI 只暴露 1s / 5s 两档；区间校验在此统一，非法即 400）。 */
export const PULSE_INTERVAL_MIN_MS = 1000
export const PULSE_INTERVAL_MAX_MS = 600000

/** 心跳运行时控制面（由插件半区实现；路由只做校验与转发）。 */
export interface PulseControl {
  /** 切到定时档。 */
  setAuto(intervalMs: number): void
  /** 切到手动档：停定时器，只在 sampleNow 时采样。 */
  setManual(): void
  /** 立即采一次（任何档位都可用；与定时 tick 串行，不重叠）。 */
  sampleNow(): Promise<void>
}

/** 告警视图（A 系列）：规则定义 + 运行态；路由只负责把它们拼成一份快照。 */
export interface PulseAlertsView {
  enabled: boolean
  rules: AlertRule[]
  states: AlertRuntimeState[]
  /** 证据目录现状（A.2 快照；只读诊断，缺席则前端不显示）。 */
  evidence?: { dirs: number; bytes: number; oldestTs: number | null; newestTs: number | null }
  /** 报告目录（A.4 报告查看入口显示路径用）。 */
  reportsDir?: string
}

/** 人工裁决取值（决策 D-A4：不做 ack，只做事后标注）。 */
export const ALERT_VERDICTS = ['true-positive', 'false-positive', 'unknown'] as const
export type AlertVerdict = (typeof ALERT_VERDICTS)[number]

export interface PulseRouteDeps {
  store: PulseStore
  status: () => PulseCollectorStatus
  control: PulseControl
  /** 告警视图（A.1）。子插件独立挂载时也可缺席 → 路由回 503（能力不在，不编造空表）。 */
  alerts?: () => PulseAlertsView
  /** A.4：人工裁决写入（不设门）。@returns false = 未知 id（404）。 */
  verdict?: (id: string, verdict: AlertVerdict, note: string | null) => boolean
  /** A.4：读报告全文（报告落盘，UI 只做查看；@returns null = 尚未成文）。 */
  readReport?: (id: string) => { path: string; markdown: string } | null
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 与 nautilus 路由同款同源守卫（本地实现，不跨层 import nautilus 模块）。 */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 读 JSON 请求体（限长；解析失败 → null，由调用方回 400）。 */
function readJsonBody(req: IncomingMessage, limit = 1 << 16): Promise<unknown> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk: unknown) => { if (text.length < limit) text += String(chunk) })
    req.on('end', () => {
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export function registerPulseRoutes(ctx: { webServer: { register(route: WebRoute): () => void } }, deps: PulseRouteDeps): () => void {
  const disposers: Array<() => void> = []

  const state: WebRoute = {
    kind: 'exact',
    path: PULSE_API_PREFIX + '/state',
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const st = deps.store.status()
      json(res, 200, {
        revision: Date.now(),
        collector: deps.status(),
        db: { rows: st.rows, oldestTs: st.oldestTs, newestTs: st.newestTs, schemaVersion: st.schemaVersion },
        latest: deps.store.latest().map((r) => ({ metric: r.metric, value: r.value, ts: r.ts, tags: safeJson(r.tags) })),
      })
    },
  }

  const series: WebRoute = {
    kind: 'exact',
    path: PULSE_API_PREFIX + '/series',
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const metric = url.searchParams.get('metric')
      if (metric === null || metric === '') return json(res, 400, { ok: false, error: 'metric-required' })
      const windowMs = intParam(url.searchParams.get('windowMs'), 3600_000, 1000, 30 * 86400_000)
      const maxPoints = intParam(url.searchParams.get('maxPoints'), 600, 2, 5000)
      const to = Date.now()
      const from = to - windowMs
      const points = deps.store.series(metric, from, to, maxPoints)
      json(res, 200, { revision: to, metric, from, to, windowMs, maxPoints, bucketMs: Math.max(1, Math.ceil(windowMs / maxPoints)), points })
    },
  }

  const control: WebRoute = {
    kind: 'exact',
    path: PULSE_API_PREFIX + '/control',
    handler: (req, res): void => {
      void (async (): Promise<void> => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
        const body = (await readJsonBody(req)) as { mode?: unknown; intervalMs?: unknown; sample?: unknown } | null
        if (body === null) return json(res, 400, { ok: false, error: 'invalid-json' })

        if (body.mode !== undefined && body.mode !== 'manual' && body.mode !== 'auto') {
          return json(res, 400, { ok: false, error: 'invalid-mode' })
        }
        let intervalMs: number | undefined
        if (body.intervalMs !== undefined) {
          if (typeof body.intervalMs !== 'number' || !Number.isFinite(body.intervalMs)) {
            return json(res, 400, { ok: false, error: 'invalid-interval' })
          }
          intervalMs = Math.trunc(body.intervalMs)
          if (intervalMs < PULSE_INTERVAL_MIN_MS || intervalMs > PULSE_INTERVAL_MAX_MS) {
            return json(res, 400, { ok: false, error: 'interval-out-of-range' })
          }
        }

        // 顺序：先定档位，再按需立即采一次（手动档下 sample:true 就是「手动采样」）
        if (body.mode === 'manual') deps.control.setManual()
        else if (intervalMs !== undefined) deps.control.setAuto(intervalMs)

        if (body.sample === true) {
          await deps.control.sampleNow()
        }
        json(res, 200, { ok: true, collector: deps.status() })
      })().catch((err: unknown) => {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      })
    },
  }

  // A 系列：告警台账读口（规则 + 运行态 + 台账计数 + 活跃/近期事件）
  const alerts: WebRoute = {
    kind: 'exact',
    path: PULSE_API_PREFIX + '/alerts',
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (deps.alerts === undefined) return json(res, 503, { ok: false, error: 'alerts-unavailable' })
      const view = deps.alerts()
      const byRule = new Map(view.states.map((s) => [s.id, s]))
      const url = new URL(req.url ?? '/', 'http://localhost')
      const limit = intParam(url.searchParams.get('limit'), 50, 1, 500)
      const counts = deps.store.alertCounts()
      json(res, 200, {
        revision: Date.now(),
        enabled: view.enabled,
        counts: { ...counts, rules: view.rules.length, rulesEnabled: view.rules.filter((r) => r.enabled).length },
        rules: view.rules.map((r) => ({
          id: r.id, label: r.label, enabled: r.enabled, metric: r.metric, refMetric: r.refMetric,
          expr: r.refMetric === '' ? r.metric : r.metric + ' / ' + r.refMetric,
          op: r.op, threshold: r.threshold, clear: r.clear, forMs: r.forMs, cooldownMs: r.cooldownMs,
          state: byRule.get(r.id) ?? null,
        })),
        evidence: view.evidence ?? null,
        reportsDir: view.reportsDir ?? null,
        active: deps.store.openAlerts(),
        recent: deps.store.recentAlerts(limit),
      })
    },
  }

  // A.4：人工裁决（不设审批门——只做事后标注，供噪声地板量化）
  const verdict: WebRoute = {
    kind: 'exact',
    path: PULSE_API_PREFIX + '/alerts/verdict',
    handler: (req, res): void => {
      void (async (): Promise<void> => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
        if (deps.verdict === undefined) return json(res, 503, { ok: false, error: 'verdict-unavailable' })
        const body = (await readJsonBody(req)) as { id?: unknown; verdict?: unknown; note?: unknown } | null
        if (body === null) return json(res, 400, { ok: false, error: 'invalid-json' })
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') return json(res, 400, { ok: false, error: 'id-required' })
        const v = body.verdict
        if (typeof v !== 'string' || !(ALERT_VERDICTS as readonly string[]).includes(v)) {
          return json(res, 400, { ok: false, error: 'invalid-verdict' })
        }
        const rawNote = body.note
        if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') return json(res, 400, { ok: false, error: 'invalid-note' })
        const note = typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim().slice(0, 500) : null
        const hit = deps.verdict(id, v as AlertVerdict, note)
        if (!hit) return json(res, 404, { ok: false, error: 'unknown-alert' })
        json(res, 200, { ok: true, id, verdict: v, note, counts: deps.store.alertCounts() })
      })().catch((err: unknown) => {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      })
    },
  }

  // A.4：报告查看入口（报告在磁盘，UI 只查看；未成文如实回 404）
  const report: WebRoute = {
    kind: 'exact',
    path: PULSE_API_PREFIX + '/alerts/report',
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (deps.readReport === undefined) return json(res, 503, { ok: false, error: 'report-unavailable' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      if (id === '') return json(res, 400, { ok: false, error: 'id-required' })
      const got = deps.readReport(id)
      if (got === null) return json(res, 404, { ok: false, error: 'no-report' })
      json(res, 200, { ok: true, id, path: got.path, markdown: got.markdown })
    },
  }

  disposers.push(ctx.webServer.register(state))
  disposers.push(ctx.webServer.register(series))
  disposers.push(ctx.webServer.register(control))
  disposers.push(ctx.webServer.register(alerts))
  disposers.push(ctx.webServer.register(verdict))
  disposers.push(ctx.webServer.register(report))
  return () => { for (const d of disposers.reverse()) { try { d() } catch { /* 幂等清理 */ } } }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
