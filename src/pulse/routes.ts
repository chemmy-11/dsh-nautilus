/**
 * @dsh-external/dsh-nautilus — pulse 路由（host 半区）。
 *
 * 用途：本层自检 + UI 层取数口 + **运行时心跳档位控制**。
 *   GET  /api/nautilus/pulse/state                        采集状态 + 每指标最新值
 *   GET  /api/nautilus/pulse/series?metric=&windowMs=&maxPoints=   单指标时间序列（桶均值）
 *   POST /api/nautilus/pulse/control                      心跳档位：{ intervalMs } 定时档 | { mode:'manual' } 手动档 | { sample:true } 立即采一次
 *
 * 与 nautilus 路由同一守卫口径（同源标记）。**control 只改采集节律，不写业务读数**——
 * 它决定「多久采一次」，采样本身仍走同一条 tick 路径（同库同表）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PulseStore } from './store.js'
import type { PulseCollectorStatus } from './index.js'

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

export interface PulseRouteDeps {
  store: PulseStore
  status: () => PulseCollectorStatus
  control: PulseControl
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

  disposers.push(ctx.webServer.register(state))
  disposers.push(ctx.webServer.register(series))
  disposers.push(ctx.webServer.register(control))
  return () => { for (const d of disposers.reverse()) { try { d() } catch { /* 幂等清理 */ } } }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
