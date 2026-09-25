/**
 * @dsh-external/dsh-nautilus — observation REST routes (host half).
 *
 * ⚠️ vault 观测腿（2026-09-27 下线）：原 `/state`（vault 统计）、`/vault`（指向切换）、`/action`（重扫）
 *    三条路由已删除——vault 侧操作改由会话侧 /obsidian 技能承担，本插件不再读写 vault。
 *
 * GET  /api/nautilus/m2/state       → 逐轮读数（latest / totals / curve points / recent；全局口径）
 *                                      + diagnostics.collector（PS.0fix C：采集写失败计数 / 最近错误摘要；
 *                                        null = 采集未挂载，readings.enabled=false）
 * GET  /api/nautilus/m2/turn-text   → 单轮完整问答原文（?session=&turn=）
 * GET  /api/nautilus/m2/analysis    → 白盒分析（形态 / 爆发段 / τ_e）
 * POST /api/nautilus/selfcheck      → 外部 harness 自评 ingest（token 门，默认关；S1.1 通道 + AL.3 双形：
 *                                      旧形 clarity/defense/declaration 与新形 align/boundary 同门，硬门与校验在共享 ingest）
 * GET  /api/nautilus/m2/turn-annotations   → T 系列逐轮人工标注清单 + spot/sample 双口径覆盖
 * POST /api/nautilus/m2/turn-annotations   → 标注 upsert **双形**（AL.4，不新开端点）：body 存在 `align` 键（含显式 null）
 *                                            或 `boundary` 键 → 对齐量表 1–5（align≥4 必附引文；align:null + exempt:1 = N/A 豁免）；
 *                                            否则旧 fit 0–4 路**逐字不变**。两形同门：无原文拒 + origin 服务端判定。
 *                                            旧形压到已是 schema_version≥2 的 align 行 → **409 `generational-conflict`**
 *                                            （零写入；不做 align→align_prev 的跨代际降级——那是静默销毁新量表标注）。
 *                                            错误码（本路由）：forbidden(403) / bad-json·invalid:*·no-turn-text·
 *                                            quote-required·align-quote-required·quote-too-long(400) /
 *                                            **generational-conflict(409)**。
 * GET  /api/nautilus/m2/alignments   → AL.4b 对齐读侧：双路台账（人工 align + 自评 align）+ 覆盖 + 一致性（v3：留出集 + human[] 收豁免行；只 GET）
 * GET  /api/nautilus/m2/sessions[?limit=50&offset=0] → AL.5s 往期会话清单（label/总量/标注计数；**不带轮次**）
 * GET  /api/nautilus/m2/sessions/<sessionId>        → AL.5s 单会话详情（全部轮次 + hasText + 双路标注；未知 id → 404）
 * Same-origin marker guard; registered as effect.（/selfcheck 例外：调用方非浏览器，以 token 为门。）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { NautilusStore, SessionAggregateRow } from './store.js'
import { analyze } from './nexus/analysis.js'
import { ALIGN_ANCHORS } from './nexus/selfcheck.js'
import { ingestSelfCheck, ALIGN_MAX, ALIGN_MIN, BOUNDARIES, QUOTE_MAX, RUBRIC_VERSION, SCHEMA_VERSION_ALIGN } from './nexus/selfcheck-ingest.js'
import type { Boundary } from './nexus/selfcheck-ingest.js'
import { pairAlignments, consistencyOf, MIN_PAIRS } from './nexus/consistency.js'
// PS.0fix C：采集写失败读数（丢写可见化）——诊断面只读快照，由 index.ts 注入取值器
import type { CollectorDiagnostics } from './nexus/turns.js'
// AL.5s：label / 会话名派生（服务端单点；UI 不自己拼——契约冻结「工作区 · 会话名」）
import { acceptsAsNameQuestion, composeLabel, truncateChars, QUESTION_PREVIEW_MAX } from './nexus/sessions.js'

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
  /**
   * PS.0fix C：采集写失败读数取值器（`null` = 采集未挂载，例如 readings.enabled=false）。
   * 取值器而非实例：collector 在 apply() 的事件 effect 里创建，路由注册更早——注册期还拿不到实例。
   */
  collectorDiagnostics?: () => CollectorDiagnostics | null
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
        // PS.0fix C：丢写不再无声——采集写失败累计次数与最近错误摘要（无采集器时显式 null，不编造 0）
        diagnostics: {
          collector: deps.collectorDiagnostics?.() ?? null,
        },
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
  // 代际门（AL.4 收口）：旧形落到 schema_version≥2 的 align 行 → 409 `generational-conflict`，零写入
  // （含不碰 annotation_sample 队列）；不降级、不搬移 align。
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
      // 被标轮次的原文必须在场（锁版口径 §3：不让人对着摘要打五分制）。
      // AL.5s：判据改走 store.hasTurnText——与 /m2/sessions 详情的 `hasText` 是**同一个谓词**。
      // 往期会话能不能打分，答案只能有一处：UI 拿到的 hasText=true ⟺ 这里不拒（反之 400 no-turn-text，
      // 零写入）。UI 据此禁用打分入口并说明「该轮原文未采集」。
      if (!deps.store.hasTurnText(session, turn)) return json(res, 400, { ok: false, error: 'no-turn-text' })

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
      // ── 代际冲突硬门（AL.4 收口，错误码 `generational-conflict`，登记于 dev-05 §3）──────────────
      // 根因（上一轮实测复现）：旧形 upsert 只回填 fit、不清 align —— 压到已是**对齐量表行**的轮次上时
      // 撞 v8 三态 CHECK（align 行不得携带 fit）→ SQLite 抛错冒到路由 → 客户端拿不到任何响应
      // （状态码停在 0；库本身未被改坏）。触发面 = curl 脚本 / 陈旧缓存的旧 UI 半区；新打分件只发
      // align/boundary，天然不走这条路。
      //
      // 裁决：**路由层显式拒绝，不做跨代际回退**。不把 align 挪进 align_prev 再清空降级为 v1 行——
      // 那等于允许陈旧客户端**静默销毁新量表标注**，与「不静默降级」「代际不混算」两条纪律冲突。
      //
      // 门序纪律：本门排在**语义校验之后**（400 语义错误仍优先报出）、**origin 判定之前**。
      // 后者不是洁癖：resolveAnnotationOrigin 会回填 annotation_sample.annotated_at（实测在崩溃前已写入），
      // 排在它后面就等于「拒了还改了队列」。零写入 = 本行拒绝 + 队列不动。
      const existing = deps.store.turnAlignmentSchemaVersion(session, turn)
      if (existing !== null && existing >= SCHEMA_VERSION_ALIGN) {
        return json(res, 409, {
          ok: false, error: 'generational-conflict',
          message: '该轮已是对齐量表行（schema_version≥2）：旧契合写不能覆盖新量表数据；请改用 align 1–5 重新标注。',
        })
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

  // ── AL.5s 往期会话读侧（列表 + 详情；工作台「往期打分」的数据面）──────────────────────
  //
  // 契约（守谷人冻结；UI 线按它写视图，**只加不改**）：
  //   GET /api/nautilus/m2/sessions?limit=50&offset=0 →
  //     { revision,
  //       sessions: [{ session, label, workspace, workspaceName, sessionName,
  //                    turns, firstTs, lastTs,
  //                    totals: { tokenIn, tokenOut, cacheRead, durationMs, tpsAvg },
  //                    annotated: { human, self, legacyFit } }] }
  //   GET /api/nautilus/m2/sessions/<sessionId> →
  //     { revision, session: { ...同上单条... },
  //       turns: [{ turn, ts, question, tokenIn, tokenOut, cacheRead, durationMs, tps,
  //                 hasText,                                   // 有原文才可打分（服务端「无原文即拒」的门）
  //                 self:  { align, boundary, declaration, quote, evidence, rubricVersion } | null,
  //                 human: { align, boundary, exempt, quote, note, origin, schemaVersion, annotatedAt } | null }] }
  //
  // 口径（写在这里 = 唯一口径，UI 不再自己算）：
  //  · 主干是 **turn_read**（轮次读数）；turn_text 只用于 `hasText` 在场判定，**不返回原文**
  //    （question 截断 200 字；user_text/assistant_text 一律不出现在响应里——负载控制）。
  //  · label = workspaceName + ' · ' + sessionName，派生规则在 **src/nexus/sessions.ts 单点**：
  //    workspaceName = session_root 里工作区路径的 basename（无记录/未归属 → 「未知工作区」）；
  //    sessionName = 该会话第一条「不以 '<' 开头且去空白非空」的 question 的首行前 24 字，
  //    无 → session id 短形（末 8 位）。真会话名不编（真库大量 question 以 <system-reminder> 块开头）。
  //  · 代际分层照旧（决策 §9.3）：human 只出 schema_version≥2 的行（有分 + 豁免，v8 CHECK 恰好二分）；
  //    旧尺行（schema_version=1，0–4 旧契合）**不出场**、只进 annotated.legacyFit 计数——不混算、不降级；
  //    self 只认 source_kind=dsh_tool ∧ align 非空 ∧ rubric_version=al-v1（与 /m2/alignments 同一把尺子）。
  //    计数只数**已附着到该会话轮次**的标注行（= 详情逐轮渲染的同一集合，summary 与详情不许各说一套）。
  //  · 分页严格（不夹取、不猜默认）：limit ∈ [1,200] 缺省 50；offset ≥ 0 缺省 0；
  //    在场但非法 → 400 `invalid:limit` / `invalid:offset`（静默夹取会让 UI 以为拿到了全部会话）。
  //  · 错误码（本组路由）：forbidden(403) / method-not-allowed(405) / invalid:limit·invalid:offset(400) /
  //    **not-found(404)**——未知/空/多段/解码失败的 sessionId 一律 404，**不 500**（路径安全：id 只当键查，
  //    不参与任何文件系统或拼接操作）。
  //  · `hasText` 与 POST /m2/turn-annotations 的拒写门同谓词（store.hasTurnText）：无原文的轮次
  //    **如实拒（400 no-turn-text，零写入）**——门不放宽（那是守谷人的裁决面），UI 据 hasText 禁用打分。
  const SESSIONS_PATH = `${API_PREFIX}/m2/sessions`
  const SESSION_LIMIT_DEFAULT = 50
  /** 页大小上限（写进契约：超限**拒**而不是静默截断——静默截断 = UI 以为自己拿到了全部会话）。 */
  const SESSION_LIMIT_MAX = 200

  /** 解析请求 URL（畸形 → null；本组路由绝不因畸形 url 抛异常 = 不 500）。 */
  function requestUrl(req: IncomingMessage): URL | null {
    try { return new URL(String(req.url ?? ''), 'http://localhost') } catch { return null }
  }

  /** 分页参数（严格：在场但非法即 400，不夹取、不猜默认）。 */
  function readPage(url: URL): { limit: number; offset: number } | { error: string } {
    let limit = SESSION_LIMIT_DEFAULT
    const rawLimit = url.searchParams.get('limit')
    if (rawLimit !== null) {
      const n = Number(rawLimit)
      if (!Number.isInteger(n) || n < 1 || n > SESSION_LIMIT_MAX) return { error: 'invalid:limit' }
      limit = n
    }
    let offset = 0
    const rawOffset = url.searchParams.get('offset')
    if (rawOffset !== null) {
      const n = Number(rawOffset)
      if (!Number.isInteger(n) || n < 0) return { error: 'invalid:offset' }
      offset = n
    }
    return { limit, offset }
  }

  /**
   * 详情路径 → 会话 id：只接受**恰好一段**（`<prefix>/<id>`）。空段 / 多段 / 解码失败 → null
   * （调用方 404）。id 只当 SQL 绑定参数用——不拼路径、不拼 SQL，故路径穿越类输入只是「查不到的键」。
   */
  function sessionIdFromPath(pathname: string): string | null {
    if (!pathname.startsWith(SESSIONS_PATH + '/')) return null
    const raw = pathname.slice(SESSIONS_PATH.length + 1)
    if (raw === '' || raw.includes('/')) return null
    try {
      const id = decodeURIComponent(raw)
      return id === '' ? null : id
    } catch { return null }
  }

  /** 会话行 → 冻结契约的单条形状（label 三件套走 nexus 单点派生，这里只做装配）。 */
  function sessionJson(agg: SessionAggregateRow): Record<string, unknown> {
    // 会话名候选可能不止一条（见 store.decorateSessions）：取**第一条**够格当会话名的（权威判据在 nexus）
    const nameQuestion = agg.nameQuestions.find((q) => acceptsAsNameQuestion(q)) ?? null
    const { workspaceName, sessionName, label } = composeLabel(agg.workspace, nameQuestion, agg.session)
    return {
      session: agg.session,
      label,
      // workspace 给 session_root 的**原始冻结值**（'' = 未归属/无记录）；显示名走 workspaceName
      workspace: agg.workspace,
      workspaceName,
      sessionName,
      turns: agg.turns,
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      totals: {
        tokenIn: agg.tokenIn,
        tokenOut: agg.tokenOut,
        cacheRead: agg.cacheRead,
        durationMs: agg.durationMs,
        // 与 turn_read 的行内 tps 同式（总输出 / 总时长）——不是逐轮 tps 的算术平均
        // （后者被极短轮放大）；全库无已知时长 → null（0 是假读数）
        tpsAvg: agg.durationMs > 0 ? (agg.tokenOut * 1000) / agg.durationMs : null,
      },
      annotated: {
        human: agg.humanAnnotationCount,
        self: agg.selfAlignmentCount,
        legacyFit: agg.legacyFitCount,
      },
    }
  }

  // 列表：默认不带 turns（列表页要的是「往期会话 + 数字 + 计数」，轮次走详情——负载控制）。
  const sessionsList: WebRoute = {
    kind: 'exact',
    path: SESSIONS_PATH,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const url = requestUrl(req)
      if (url === null) return json(res, 400, { ok: false, error: 'invalid:url' })
      const page = readPage(url)
      if ('error' in page) return json(res, 400, { ok: false, error: page.error })
      const sessions = deps.store.listSessionAggregates(page.limit, page.offset, RUBRIC_VERSION).map(sessionJson)
      json(res, 200, { revision: Date.now(), sessions })
    },
  }

  // 详情：该会话**全部轮次**（question 截断 200 字；原文不返回）+ 双路标注 + hasText 门读数。
  const sessionDetail: WebRoute = {
    kind: 'prefix',
    path: SESSIONS_PATH,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!browserSameOriginMarker(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const url = requestUrl(req)
      const session = url === null ? null : sessionIdFromPath(url.pathname)
      if (session === null) return json(res, 404, { ok: false, error: 'not-found' })
      const agg = deps.store.sessionAggregate(session, RUBRIC_VERSION)
      // 没有读数的 id 不假装存在（「往期会话」的判据就是有 turn_read 行）
      if (agg === null) return json(res, 404, { ok: false, error: 'not-found' })

      // 人工：新量表行（有分 + 豁免）逐轮出场；旧代际行不出场（只进 summary 的 legacyFit 计数，分层不混算）
      const humanByTurn = new Map<number, Record<string, unknown>>()
      for (const a of deps.store.sessionTurnAlignments(session)) {
        if (a.schemaVersion >= 2 && (a.align !== null || a.exempt === 1)) {
          humanByTurn.set(a.turn, {
            align: a.align, boundary: a.boundary, exempt: a.exempt, quote: a.quote, note: a.note,
            origin: a.origin, schemaVersion: a.schemaVersion, annotatedAt: a.annotatedAt,
          })
        }
      }
      // 自评：与 /m2/alignments 同一过滤（dsh_tool × align 非空 × al-v1），按 ext_ref 收窄到本会话
      const selfByTurn = new Map<number, Record<string, unknown>>()
      for (const s of deps.store.listSelfAlignments('dsh_tool', RUBRIC_VERSION, session)) {
        selfByTurn.set(s.turnOrdinal, {
          align: s.align, boundary: s.boundary, declaration: s.declaration, quote: s.quote,
          evidence: s.evidence, rubricVersion: s.rubricVersion,
        })
      }

      const turns = deps.store.sessionTurns(session).map((t) => ({
        turn: t.turn,
        ts: t.ts,
        question: t.question === null ? null : truncateChars(t.question, QUESTION_PREVIEW_MAX),
        tokenIn: t.tokenIn,
        tokenOut: t.tokenOut,
        cacheRead: t.cacheRead,
        durationMs: t.durationMs,
        tps: t.tps,
        // 可打分判据：与 POST 的 no-turn-text 门同谓词（false → UI 禁用打分并说明原文未采集）
        hasText: t.hasText,
        self: selfByTurn.get(t.turn) ?? null,
        human: humanByTurn.get(t.turn) ?? null,
      }))
      json(res, 200, { revision: Date.now(), session: sessionJson(agg), turns })
    },
  }

  for (const route of [m2State, turnText, analysis, selfcheck, turnAnnotations, alignments, sessionsList, sessionDetail]) disposers.push(ctx.webServer.register(route))
  return () => { for (const d of disposers.reverse()) { try { d() } catch { /* 幂等清理 */ } } }
}
