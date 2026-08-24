/**
 * @dsh-external/dsh-xuegulin — observation REST routes (host half).
 * GET  /api/xuegulin/state   → panel snapshot (totals / today / week / recent edit stream)
 * POST /api/xuegulin/action  → { kind: 'rescan' } triggers a full scan
 * Same-origin marker guard; registered as effect.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { XuegulinStore } from './store.js'

const API_PREFIX = '/api/xuegulin'

export interface RouteDeps {
  store: XuegulinStore
  onRescan: () => void
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

function dayWindow(offsetDays: number): { start: number; end: number } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - offsetDays)
  return { start: start.getTime(), end: start.getTime() + 86400000 }
}

export function registerXuegulinRoutes(ctx: { webServer: { register(route: WebRoute): () => void } }, deps: RouteDeps): () => void {
  const disposers: Array<() => void> = []

  const state: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const today = dayWindow(0)
      const week = dayWindow(6)
      const totals = deps.store.totals()
      json(res, 200, {
        revision: Date.now(),
        totals,
        today: deps.store.summary(today.start, today.end),
        week: deps.store.summary(week.start, Date.now()),
        recent: deps.store.recentEvents(20),
      })
    },
  }

  const action: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      try {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind?: string }
        if (body.kind !== 'rescan') return json(res, 400, { ok: false, error: 'invalid-action' })
        deps.onRescan()
        json(res, 200, { ok: true })
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
      }
    },
  }

  for (const route of [state, action]) disposers.push(ctx.webServer.register(route))
  return () => { for (const d of disposers) d() }
}
