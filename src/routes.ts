/**
 * @dsh-external/dsh-xuegulin — observation REST routes (host half).
 * GET  /api/xuegulin/state          → panel snapshot (totals / today / week / recent edit stream)
 * POST /api/xuegulin/action         → { kind: 'rescan' } triggers a full scan
 * GET  /api/xuegulin/m2/state       → L 场读数（latest / totals / curve points / recent）
 * GET  /api/xuegulin/m2/annotations → 预言检验表标注
 * POST /api/xuegulin/m2/annotations → upsert 标注（prophecy 唯一）
 * Same-origin marker guard; registered as effect.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { XuegulinStore } from './store.js'
import { analyze } from './analysis.js'

const API_PREFIX = '/api/xuegulin'

export interface RouteDeps {
  store: XuegulinStore
  onRescan: () => void
  /** L 场读数曲线窗口（天），默认 30。 */
  m2HistoryDays?: number
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

  // ── M2：L 场读数 ────────────────────────────────────────────────────────────

  const m2State: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      const points = deps.store.turnReadsSince(fromTs)
      const latest = points.length > 0 ? points[points.length - 1] : null
      const totals = deps.store.turnTotals()
      // 官方口径（llm-deepseek mapUsage 实证）：usage.inputTokens 已扣除缓存命中 = 未命中；
      // 总输入 = inputTokens + cacheReadTokens；命中率 = cacheRead / 总输入；A 投影（未命中率）= inputTokens / 总输入。
      const totalIn = totals.tokenIn + totals.cacheRead
      const hitRate = totalIn > 0 ? totals.cacheRead / totalIn : null
      json(res, 200, {
        revision: Date.now(),
        latest,
        totals: {
          turns: totals.turns,
          tokenIn: totals.tokenIn,
          tokenOut: totals.tokenOut,
          cacheRead: totals.cacheRead,
          missToken: totals.tokenIn,
          totalIn,
          hitRate,
        },
        curve: points,
        recent: points.slice(-20).reverse(),
      })
    },
  }

  // 标注读写合并为单路由（webserver 按 path 判重，不支持同 path 多方法注册）
  const annotations: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/annotations`,
    handler: async (req, res): Promise<void> => {
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') {
        json(res, 200, { revision: Date.now(), annotations: deps.store.listAnnotations() })
        return
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      try {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          prophecy?: unknown; status?: unknown; note?: unknown; session?: unknown; turn?: unknown
        }
        const prophecy = typeof body.prophecy === 'string' && body.prophecy !== '' ? body.prophecy : null
        const status = typeof body.status === 'string' && body.status !== '' ? body.status : 'pending'
        if (prophecy === null || !/^P\d+$/.test(prophecy)) return json(res, 400, { ok: false, error: 'invalid-prophecy' })
        if (!['pending', 'investigating', 'observed'].includes(status)) return json(res, 400, { ok: false, error: 'invalid-status' })
        deps.store.upsertAnnotation({
          prophecy,
          status,
          note: body.note === null || body.note === undefined ? null : String(body.note),
          session: body.session === null || body.session === undefined ? null : String(body.session),
          turn: typeof body.turn === 'number' ? body.turn : null,
        })
        json(res, 200, { ok: true })
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' })
      }
    },
  }

  // M3-F.2：完整问答原文（B 方案；同源守卫；?session=&turn=）
  const turnText: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/turn-text`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const url = new URL(String(req.url ?? ''), 'http://localhost')
      const session = url.searchParams.get('session') ?? ''
      const turn = Number(url.searchParams.get('turn') ?? '')
      if (session === '' || !Number.isInteger(turn)) {
        return json(res, 400, { ok: false, error: 'invalid-params' })
      }
      const text = deps.store.getTurnText(session, turn)
      if (text === null) return json(res, 200, { found: false })
      json(res, 200, { found: true, session, turn, ...text })
    },
  }

  // M3-F.3：白盒探索性分析（S 形/爆发段/τ_e；口径=镜 OQ-M2-1/2 裁决）
  const analysis: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/analysis`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      const rows = deps.store.turnReadsSince(fromTs)
      const results = analyze(rows)
      json(res, 200, { revision: Date.now(), results })
    },
  }

  for (const route of [m2State, annotations, turnText, analysis]) disposers.push(ctx.webServer.register(route))
  return () => { for (const d of disposers) d() }
}
