/**
 * @dsh-external/dsh-nautilus — observation REST routes (host half).
 *
 * ⚠️ vault 观测腿（2026-09-27 下线）：原 `/state`（vault 统计）、`/vault`（指向切换）、`/action`（重扫）
 *    三条路由已删除——vault 侧操作改由会话侧 /obsidian 技能承担，本插件不再读写 vault。
 *
 * GET  /api/nautilus/m2/state       → 逐轮读数（latest / totals / curve points / recent；全局口径）
 * GET  /api/nautilus/m2/turn-text   → 单轮完整问答原文（?session=&turn=）
 * GET  /api/nautilus/m2/analysis    → 白盒分析（形态 / 爆发段 / τ_e）
 * POST /api/nautilus/selfcheck      → 外部 harness 自评 ingest（token 门，默认关；S1.1 通道 + AL.3 双形：
 *                                      旧形 clarity/defense/declaration 与新形 align/boundary 同门，硬门与校验在共享 ingest）
 * GET  /api/nautilus/m2/turn-annotations   → T 系列逐轮人工标注清单 + spot/sample 双口径覆盖
 * POST /api/nautilus/m2/turn-annotations   → 标注 upsert **双形**（AL.4，不新开端点）：body 存在 `align` 键（含显式 null）
 *                                            或 `boundary` 键 → 对齐量表 1–5（align≥4 必附引文；align:null + exempt:1 = N/A 豁免）；
 *                                            否则旧 fit 0–4 路**逐字不变**。两形同门：无原文拒 + origin 服务端判定。
 * GET  /api/nautilus/m2/alignments   → AL.4b 对齐读侧：双路台账（人工 align + 自评 align）+ 覆盖 + 一致性（v3：留出集 + human[] 收豁免行；只 GET）
 * Same-origin marker guard; registered as effect.（/selfcheck 例外：调用方非浏览器，以 token 为门。）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { NautilusStore } from './store.js'
import { analyze } from './nexus/analysis.js'
import { ALIGN_ANCHORS } from './nexus/selfcheck.js'
import { ingestSelfCheck, ALIGN_MAX, ALIGN_MIN, BOUNDARIES, QUOTE_MAX, RUBRIC_VERSION, SCHEMA_VERSION_ALIGN } from './nexus/selfcheck-ingest.js'
import type { Boundary } from './nexus/selfcheck-ingest.js'
import { pairAlignments, consistencyOf, MIN_PAIRS } from './nexus/consistency.js'

/** 集中常量：路由前缀（AGENTS.md §1-4）。 */
const API_PREFIX = '/api/nautilus'

/** 集中常量：自评 ingest 的 token 头名（外部 harness 钩子按此投递凭证）。 */
export const SELFCHECK_TOKEN_HEADER = 'x-nautilus-selfcheck-token'

export interface RouteDeps {
  store: NautilusStore
  /** 逐轮读数曲线窗口（天），默认 30。 */
  m2HistoryDays?: number
  /** S1.1 自评 ingest 通道配置（缺省 = 关闭：路由注册但恒 403，禁用状态可判别）。 */
  selfcheckIngest?: { enabled: boolean; token: string; maxBodyBytes?: number }
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

  // ── 逐轮读数（M2；官方 session/event 直采的读数面） ───────────────────────────

  const m2State: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const historyDays = deps.m2HistoryDays ?? 30
      const fromTs = Date.now() - historyDays * 86400000
      // AL.4a：全局口径（原「指向 / 全局」两态已撤除，不再有 ?root= 过滤）
      const points = deps.store.turnReadsSince(fromTs)
      const latest = points.length > 0 ? points[points.length - 1] : null
      const totals = deps.store.turnTotals()
      // 官方口径（llm-deepseek mapUsage 实证）：usage.inputTokens 已扣除缓存命中 = 未命中；
      // 总输入 = inputTokens + cacheReadTokens；命中率 = cacheRead / 总输入；A 投影（未命中率）= inputTokens / 总输入。
      const totalIn = totals.tokenIn + totals.cacheRead
      const hitRate = totalIn > 0 ? totals.cacheRead / totalIn : null
      json(res, 200, {
        revision: Date.now(),
        sessionMeta: deps.store.sessionMeta(),
        selfcheck: deps.store.selfcheckCoverage(),
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

  // M3-F.3：白盒探索性分析（S 形/爆发段/τ_e；口径=镜 OQ-M2-1/2 裁决；全局口径同 m2/state）
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

  // S1.1：外部 harness 自评 ingest（决策 D-SC1 通道 A；口径走共享 ingest，与 DSH 工具同一份校验）。
  // AL.3：同一通道收两代形态（旧三行 / 新 al-v1 对齐量表），分支判据 = 有无 align；路由本身不判维度。
  // 门序（AL.3 未变）：方法 → 启用 → token → 体长 → JSON → 校验。默认 enabled=false：路由在场但恒 403（禁用可判别，不是 404）。
  const selfcheck: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/selfcheck`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      const cfg = deps.selfcheckIngest
      if (cfg === undefined || cfg.enabled !== true) return json(res, 403, { ok: false, error: 'ingest-disabled' })
      const given = req.headers[SELFCHECK_TOKEN_HEADER]
      if (typeof given !== 'string' || given === '' || given !== cfg.token) {
        return json(res, 401, { ok: false, error: 'unauthorized' })
      }
      const limit = typeof cfg.maxBodyBytes === 'number' && cfg.maxBodyBytes > 0 ? cfg.maxBodyBytes : 8192
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const c of req) {
          size += (c as Buffer).length
          if (size > limit) return json(res, 400, { ok: false, error: 'too-large' })
          chunks.push(c as Buffer)
        }
      } catch { return json(res, 400, { ok: false, error: 'bad-json' }) }
      let body: Record<string, unknown> | null = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { body = null }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { ok: false, error: 'bad-json' })
      }
      // 双形兼容（AL.3）：旧形（clarity/defense/declaration）与新形（align/boundary/evidence）同通道，
      // 分支与硬门全在共享 ingest 一处判——本路由只搬字段，不复制口径。
      const outcome = ingestSelfCheck(deps.store, {
        sourceKind: 'http',
        agent: body.agent, extRef: body.ext_ref, turnOrdinal: body.turn_ordinal,
        clarity: body.clarity, defense: body.defense, declaration: body.declaration,
        quote: body.quote, align: body.align, boundary: body.boundary, evidence: body.evidence,
        model: body.model, workspace: body.workspace,
        tsClient: body.ts_client, schemaVersion: body.schema_version,
      })
      if (!outcome.ok) return json(res, 400, { ok: false, error: outcome.error })
      json(res, 200, { ok: true, result: outcome.result, duplicate: outcome.result === 'duplicate' })
    },
  }

  // T 系列：逐轮人工标注（对齐 · 混合入口；决策 D-T3）；AL.4 起双形（align 1–5 与旧 fit 0–4 同门）。
  // 同源门（守谷人 / 工作台专用）。
  // 语义校验在落库前做完——库里 CHECK 只是最后一道墙，不是第一道。
  const NOTE_MAX = 500
  const turnAnnotations: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/turn-annotations`,
    handler: async (req, res): Promise<void> => {
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') {
        json(res, 200, { revision: Date.now(), annotations: deps.store.listTurnAnnotations(), coverage: deps.store.turnAnnotationCoverage() })
        return
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      const body = await readJson(req) as {
        session?: unknown; turn?: unknown; fit?: unknown; exempt?: unknown; quote?: unknown; note?: unknown
        align?: unknown; boundary?: unknown
      } | null
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'bad-json' })
      const session = typeof body.session === 'string' ? body.session.trim() : ''
      const turn = typeof body.turn === 'number' && Number.isInteger(body.turn) && body.turn >= 1 ? body.turn : null
      if (session === '' || session.length > 160 || turn === null) return json(res, 400, { ok: false, error: 'invalid:session_or_turn' })
      // 被标轮次的原文必须在场（锁版口径 §3：不让人对着摘要打五分制）
      if (deps.store.getTurnText(session, turn) === null) return json(res, 400, { ok: false, error: 'no-turn-text' })

      // ── 新形（AL.4：对齐量表 1–5 + 四边界 = 自评侧同一把尺子）──────────────────────
      // 判据 = body 里**存在** `align` 键（含显式 null）**或** `boundary` 键——不是「align 非空」：
      // N/A 豁免由客户端发 `align:null + exempt:1 + boundary`，只认「align 非空」会把它误判成旧形
      // → 落 schema_version=1 行 → 既不进 exempted、又混进 legacyFitRows（代际错判）。
      // 硬门与枚举常量一律取共享 ingest 那几份（红线 4：集中常量，不写第二套字面量）。
      if (Object.prototype.hasOwnProperty.call(body, 'align') || Object.prototype.hasOwnProperty.call(body, 'boundary')) {
        const align = typeof body.align === 'number' && Number.isInteger(body.align)
          && body.align >= ALIGN_MIN && body.align <= ALIGN_MAX ? body.align : null
        if (body.align !== undefined && body.align !== null && align === null) return json(res, 400, { ok: false, error: 'invalid:align' })
        const exempt = body.exempt === 1 || body.exempt === true ? 1 : 0
        // 与 v8 CHECK 同构：有分与豁免恰好二分（align NULL ⟺ exempt=1），谁也不许兼得
        if ((align === null) !== (exempt === 1)) return json(res, 400, { ok: false, error: 'invalid:align-xor-exempt' })
        let boundary: Boundary = 'none'
        if (body.boundary !== undefined && body.boundary !== null) {
          if (typeof body.boundary !== 'string' || !(BOUNDARIES as readonly string[]).includes(body.boundary)) {
            return json(res, 400, { ok: false, error: 'invalid:boundary' })
          }
          boundary = body.boundary as Boundary
        }
        let quote: string | null = null
        if (body.quote !== undefined && body.quote !== null) {
          if (typeof body.quote !== 'string') return json(res, 400, { ok: false, error: 'invalid:quote' })
          const q = body.quote.trim()
          if (q !== '') {
            if (q.length > QUOTE_MAX) return json(res, 400, { ok: false, error: 'quote-too-long' })
            quote = q
          }
        }
        // 签-2 硬门（与自评 ingest 同码同义）：align≥4 无引文即拒、**零写入**；引文只在 4/5 有语义
        if (align !== null && align >= 4 && quote === null) return json(res, 400, { ok: false, error: 'align-quote-required' })
        if (align === null || align < 4) quote = null
        let note: string | null = null
        if (body.note !== undefined && body.note !== null) {
          if (typeof body.note !== 'string') return json(res, 400, { ok: false, error: 'invalid:note' })
          const t = body.note.trim()
          if (t !== '') note = t.length > NOTE_MAX ? t.slice(0, NOTE_MAX) : t
        }
        // origin 服务端判定（同一口径、同一次队列回填）：未完成队列命中 = sample，否则 spot
        const origin = deps.store.resolveAnnotationOrigin(session, turn)
        const result = deps.store.upsertTurnAlignment({ session, turn, align, exempt, boundary, quote, note, origin })
        json(res, 200, { ok: true, origin, result, overwritten: result === 'overwritten' })
        return
      }

      // ── 旧形（fit 0–4）：改造前行为**逐字保留**（老调用方不断线）────────────────────
      const exempt = body.exempt === 1 || body.exempt === true ? 1 : 0
      const fit = typeof body.fit === 'number' && Number.isInteger(body.fit) && body.fit >= 0 && body.fit <= 4 ? body.fit : null
      if ((fit === null) !== (exempt === 1)) return json(res, 400, { ok: false, error: 'invalid:fit-xor-exempt' })
      let quote: string | null = null
      if (body.quote !== undefined && body.quote !== null) {
        if (typeof body.quote !== 'string') return json(res, 400, { ok: false, error: 'invalid:quote' })
        const q = body.quote.trim()
        if (q !== '') {
          if (q.length > QUOTE_MAX) return json(res, 400, { ok: false, error: 'quote-too-long' })
          quote = q
        }
      }
      if (fit === 4 && quote === null) return json(res, 400, { ok: false, error: 'quote-required' })
      if (fit !== 4) quote = null
      let note: string | null = null
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') return json(res, 400, { ok: false, error: 'invalid:note' })
        const t = body.note.trim()
        if (t !== '') note = t.length > NOTE_MAX ? t.slice(0, NOTE_MAX) : t
      }
      // origin 服务端判定（申报制污染口径，杜绝）：在未完成队列中 = sample，否则 spot
      const origin = deps.store.resolveAnnotationOrigin(session, turn)
      const result = deps.store.upsertTurnAnnotation({ session, turn, fit, exempt, quote, note, origin, schemaVersion: 1 })
      json(res, 200, { ok: true, origin, result, overwritten: result === 'overwritten' })
    },
  }

  // AL.4b：对齐读侧（双路台账 = 人工 turn_annotation.align + 自评 selfcheck_record.align）。
  // 契约 v3（**只加不改**——v1/v2 的字段名 / 类型 / 单位一字不动，UI 线已按它们写好视图）：
  //   v2 增量 = scale.{rubricVersion,anchors,min} + coverage 三字段 + consistency.holdout；
  //   v3 增量 = human[] **收豁免行**（`align:null, exempt:1`，其余字段照旧；见下文「口径纪律」第二条）。
  //   { revision, scale:{schemaVersion,rubricVersion,anchors[{score,text}],min},
  //     coverage:{humanTotal,humanAligned,exempted,legacyFitRows,byAlign{1..5},byBoundary{5 枚举},
  //               selfTotal,selfAligned,selfRatio,selfByAlign{1..5},legacySelfRows},
  //     human:[{session,turn,align,boundary,exempt,quote,note,origin,schemaVersion,annotatedAt,updatedAt}],
  //     self:[{extRef,turnOrdinal,align,boundary,declaration,quote,evidence,rubricVersion,tsMs,agent}],
  //     consistency:{pairs,exact,near,kappa,holdout:{pairs,exact,near,kappa}} | null }
  // 口径纪律：
  //   · human 出**全部新量表行**（有分 + 豁免，`schemaVersion ≥ 2`）；v3 起豁免行（`align:null, exempt:1`）
  //     也在数组里——只给有分行会让已标 N/A 的轮次在 UI 上退回「未标注」，那是**静默丢状态**（UI 线实测）；
  //     self 只出 align 非空 ∧ source_kind=dsh_tool ∧ rubric_version=al-v1 的行
  //     （旧代际 align NULL 与早于 al-v1 的对齐行都不出场，§9.3）；
  //   · humanTotal = **新量表**人工行数（有分 + 豁免；v8 CHECK 保证二者恰好二分）= aligned + exempted
  //     = `human[].length`（v3 起两者同集合）；humanAligned 仍只数 align NOT NULL 的行、exempted 语义不变；
  //     旧代际对齐行（`schema_version=1` 的 0–4 旧尺）不进它、也不进 byAlign/byBoundary/humanAligned，
  //     只由 legacyFitRows 单列（分层不混算，§9.3）——
  //     与 UI 线已落地的 AlignmentsView fixture 读法一致（humanTotal 7 = humanAligned 6 + exempted 1，旧行 3 另计）；
  //   · v2 新增：selfTotal = turn_read 的全局轮数（与 /m2/state 的 totals.turns 同式——同源、不加 root），
  //     作自评覆盖率的分母；selfRatio = selfAligned / selfTotal，**selfTotal=0 → null**（0/0 报 0 是假读数）；
  //     legacySelfRows = selfcheck_record 里 align IS NULL 或 rubric_version ≠ al-v1 的行数——
  //     与 human 侧 legacyFitRows **对称但各自独立计数**（两张表两个判据，不混算也不互相推算）；
  //   · exact/near 是 **0–1 的率**（非百分数）；kappa = 二次加权 κ（K=5）；
  //   · consistency 用**全部配对**；pairs < 2 → null（一对样本恒「完全一致」，报出来是假读数）；
  //     holdout 用与脚本同一份确定性切分（hash(session:turn)%N===0，默认 N=5）——同一批行、同一份 splitHoldout，
  //     同库必同数（留出集只用于采纳判定，不进提示词、不改 rubric）；
  //   · scale.min = MIN_PAIRS(50)：样本不足阈值的**单点来源**（UI 读它，不再写本地常量）；
  //   · 口径单点：三指标、配对与留出集切分走 src/nexus/consistency.ts（与 AL.5 脚本**同一份**，禁止第二套实现）。
  const alignments: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/m2/alignments`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const cov = deps.store.turnAlignmentCoverage()
      // v3：human[] = **全部新量表行**（有分 + 豁免）——旧代际（schema_version=1）不出场，只由 legacyFitRows 计数。
      const human = deps.store.listTurnAlignments().filter((a) => a.schemaVersion >= 2 && (a.align !== null || a.exempt === 1))
      // v2 过滤三件套一次到位：通道(dsh_tool) + align 非空 + 当期 rubric 版本——代际行只进 legacySelfRows 计数
      const self = deps.store.listSelfAlignments('dsh_tool', RUBRIC_VERSION)
      const selfByAlign: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
      for (const s of self) selfByAlign[String(s.align)] = (selfByAlign[String(s.align)] ?? 0) + 1
      // 豁免行（align null）在 pairAlignments 内部即被跳过——v3 放宽 human[] 不动配对与三指标
      const consistency = consistencyOf(pairAlignments(human, self))
      // 自评覆盖率的分母：turn_read 全局轮数（/m2/state 的 totals.turns 同式，无 root 过滤）
      const selfTotal = deps.store.turnTotals().turns
      json(res, 200, {
        revision: Date.now(),
        scale: { schemaVersion: SCHEMA_VERSION_ALIGN, rubricVersion: RUBRIC_VERSION, anchors: ALIGN_ANCHORS, min: MIN_PAIRS },
        coverage: {
          humanTotal: cov.total - cov.legacyFitRows,
          humanAligned: cov.aligned,
          exempted: cov.exempted,
          legacyFitRows: cov.legacyFitRows,
          byAlign: cov.byAlign,
          byBoundary: cov.byBoundary,
          selfTotal,
          selfAligned: self.length,
          selfRatio: selfTotal === 0 ? null : self.length / selfTotal,
          selfByAlign,
          legacySelfRows: deps.store.selfcheckLegacyRows(RUBRIC_VERSION),
        },
        human: human.map((a) => ({
          session: a.session, turn: a.turn, align: a.align, boundary: a.boundary, exempt: a.exempt,
          quote: a.quote, note: a.note, origin: a.origin, schemaVersion: a.schemaVersion,
          annotatedAt: a.annotatedAt, updatedAt: a.updatedAt,
        })),
        self,
        consistency,
      })
    },
  }

  for (const route of [m2State, turnText, analysis, selfcheck, turnAnnotations, alignments]) disposers.push(ctx.webServer.register(route))
  return () => { for (const d of disposers.reverse()) { try { d() } catch { /* 幂等清理 */ } } }
}
