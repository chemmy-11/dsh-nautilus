/**
 * @dsh-external/dsh-nautilus — observation REST routes (host half).
 *
 * ⚠️ vault 观测腿（2026-09-27 下线）：原 `/state`（vault 统计）、`/vault`（指向切换）、`/action`（重扫）
 *    三条路由已删除——vault 侧操作改由会话侧 /obsidian 技能承担，本插件不再读写 vault。
 *
 * GET  /api/nautilus/m2/state       → L 场读数（latest / totals / curve points / recent；?root=all → 全局视图）
 * GET  /api/nautilus/m2/annotations → 预言检验表标注
 * POST /api/nautilus/m2/annotations → upsert 标注（prophecy 唯一）
 * GET  /api/nautilus/m2/turn-text   → 单轮完整问答原文（?session=&turn=）
 * GET  /api/nautilus/m2/analysis    → 白盒分析（形态 / 爆发段 / τ_e）
 * GET  /api/nautilus/lfield         → L 场读数独立指向（M4-L；每根会话计数）
 * POST /api/nautilus/lfield         → 切换 L 场读数指向（采集归属；既有会话归属不变）
 * Same-origin marker guard; registered as effect.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { NautilusStore } from './store.js'
import { statSync, accessSync, constants } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { analyze } from './analysis.js'

/** 集中常量：路由前缀（AGENTS.md §1-4）。 */
const API_PREFIX = '/api/nautilus'

export interface RouteDeps {
  store: NautilusStore
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

/** 读取并解析 JSON 请求体（上限 1 MiB；解析失败 → null）。 */
async function readJson(req: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

export function registerNautilusRoutes(ctx: { webServer: { register(route: WebRoute): () => void } }, deps: RouteDeps): () => void {
  const disposers: Array<() => void> = []

  // ── L 场读数（M2；官方 session/event 直采的读数面） ───────────────────────────

  const m2State: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      // M4.11：视图两态——?root=all → 全局（不过滤归属）；默认 = 当前 L 场指向（归属于该工作区的会话）
      const url = new URL(String(req.url ?? ''), 'http://localhost')
      const rv = url.searchParams.get('root')
      const root: string | undefined = rv === 'all' ? undefined : deps.store.lfieldRoot()
      const points = deps.store.turnReadsSince(fromTs, root)
      const latest = points.length > 0 ? points[points.length - 1] : null
      const totals = deps.store.turnTotals(root)
      // 官方口径（llm-deepseek mapUsage 实证）：usage.inputTokens 已扣除缓存命中 = 未命中；
      // 总输入 = inputTokens + cacheReadTokens；命中率 = cacheRead / 总输入；A 投影（未命中率）= inputTokens / 总输入。
      const totalIn = totals.tokenIn + totals.cacheRead
      const hitRate = totalIn > 0 ? totals.cacheRead / totalIn : null
      json(res, 200, {
        revision: Date.now(),
        activeRoot: root ?? null,
        pointing: deps.store.lfieldRoot(),
        sessionMeta: deps.store.sessionMeta(),
        selfcheck: deps.store.selfcheckCoverage(root),
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
      const body = await readJson(req) as {
        prophecy?: unknown; status?: unknown; note?: unknown; session?: unknown; turn?: unknown
      } | null
      if (body === null) return json(res, 400, { ok: false, error: 'bad-json' })
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

  // M3-F.3：白盒探索性分析（S 形/爆发段/τ_e；口径=镜 OQ-M2-1/2 裁决；视图口径同 m2/state）
  const analysis: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/analysis`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      const url = new URL(String(req.url ?? ''), 'http://localhost')
      const rv = url.searchParams.get('root')
      const root: string | undefined = rv === 'all' ? undefined : deps.store.lfieldRoot()
      const rows = deps.store.turnReadsSince(fromTs, root)
      const results = analyze(rows)
      json(res, 200, { revision: Date.now(), results })
    },
  }

  // M4-L：L 场读数独立指向（GET 状态 / POST 切换采集归属）
  // known 现在由「会话归属计数」派生（vault 观测腿下线后不再有 vault_config 的 known 列表）
  const lfield: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/lfield`,
    handler: async (req, res): Promise<void> => {
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const active = deps.store.lfieldRoot()
      const counts = deps.store.sessionRootCounts()
      if (req.method === 'GET') {
        json(res, 200, {
          revision: Date.now(),
          active,
          counts,
          known: Object.keys(counts).filter((r) => r !== '').map((root) => ({
            root, displayName: null, active: root === active ? 1 : 0, confirmedAt: null,
          })),
        })
        return
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      const body = await readJson(req) as { root?: unknown } | null
      if (body === null) return json(res, 400, { ok: false, error: 'bad-json' })
      if (typeof body.root !== 'string' || body.root.trim() === '') {
        return json(res, 400, { ok: false, error: 'invalid-root' })
      }
      if (!isAbsolute(body.root)) return json(res, 400, { ok: false, error: 'must-be-absolute' })
      const norm = resolve(body.root)
      let st
      try { st = statSync(norm) } catch { return json(res, 400, { ok: false, error: 'not-found' }) }
      if (!st.isDirectory()) return json(res, 400, { ok: false, error: 'not-a-directory' })
      try { accessSync(norm, constants.R_OK) } catch { return json(res, 400, { ok: false, error: 'not-readable' }) }
      deps.store.setLfieldRoot(norm)
      console.log(`[nautilus] L 场读数指向切换 → ${norm}（新会话自此归入；既有归属不变）`)
      json(res, 200, { ok: true, active: norm })
    },
  }

  for (const route of [m2State, annotations, turnText, analysis, lfield]) disposers.push(ctx.webServer.register(route))
  return () => { for (const d of disposers.reverse()) { try { d() } catch { /* 幂等清理 */ } } }
}
