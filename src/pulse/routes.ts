/**
 * @dsh-external/dsh-nexus — pulse 只读校验路由（host 半区）。
 *
 * 用途：本层自检 + 后续 UI 层导入的取数口（UI 层尚未接入，接口先按"可画曲线"设计）。
 *   GET /api/nexus/pulse/state                        采集状态 + 每指标最新值
 *   GET /api/nexus/pulse/series?metric=&windowMs=&maxPoints=   单指标时间序列（桶均值）
 *
 * 与 nexus 路由同一守卫口径（同源标记）；**不写数据**，只读。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PulseStore } from './store.js'
import type { PulseCollectorStatus } from './index.js'

/** 集中常量：pulse 路由前缀（AGENTS.md §1-4）。 */
export const PULSE_API_PREFIX = '/api/nexus/pulse'

export interface PulseRouteDeps {
  store: PulseStore
  status: () => PulseCollectorStatus
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 与 nexus 路由同款同源守卫（本地实现，不跨层 import nexus 模块）。 */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
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

  disposers.push(ctx.webServer.register(state))
  disposers.push(ctx.webServer.register(series))
  return () => { for (const d of disposers.reverse()) { try { d() } catch { /* 幂等清理 */ } } }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
