/**
 * @dsh-external/dsh-nautilus — 流内**对齐**打分件（T 系列 UI 半区主入口；AL.4c 换代：旧 0–4 档 → 对齐 1–5）。
 *
 * 版面（2026-09-27 守谷人改口；2026-09-28 AL.4c 微调 B2/B6）：挂宿主 `conversation.chat.assistant-actions` 列表槽
 * （助手消息 IconActions 行，赞/踩同排；kind list / scope session；owner 仅 { messageId }），
 * 按钮本体**零 Nautilus 背景**——无框文本按钮融入宿主 IconActions 行（--dsw-alias-* 令牌），
 * 选择面板为最小中性浮层，**置于按钮上方**（B2：不遮挡会话；贴顶由 max-height + 滚动兜底）。
 * 此前 turnTail 链槽方案废弃（端上实测最新轮的 tail 不稳定出现）。
 *
 * 量表来源（AL.4c）：本文件**不写死锚文**——1–5 锚文取读侧契约 `GET /m2/alignments` 的 `scale.anchors`。
 *
 * 边界（AL.4d，守谷人裁决，**覆盖先前 B 方案**）：打分件**不采集 boundary**——浮层里那一行已撤。
 * 但 POST body **仍恒带 `boundary: 'none'`**：它是服务端「新形判据」的键（`align` 或 `boundary` 键在场即判新形），
 * 删掉会让 N/A 落回 schema_version=1 的代际错行（AL.4c 实测）。后果如实记在边界面板注记：
 * **人工侧 boundary 恒为 none，边界轴当前只有自评侧有信息**。
 *
 * messageId → 轮序映射：`useChat` 快照扫描（SessionStandardProps 文档化 hook）——
 * 找 kind='turn-tail' 且 data.closing.finalNode.messageId === messageId 的节点，
 * 取 location.turn.turn。解析不到就不渲染（无轮号无法落库）。
 *
 * 契约要点（renderer client.js 运行时核实）：
 *  - list 槽 def 用 `id`（keyed 才用 key）；`inject: (sessionId) => injected` 供会话身份。
 *  - 宿主渲染位 = TurnTailNodeView 内（data-actions-reveal：最新轮 always / 旧轮 hover）。
 *
 * 纪律：零第三方 import（react 除外）；本地类型（src/client 不进 tsc）；
 * 颜色只取 --dsw-alias-* / --nt-* 令牌（fallback 同值）；SSR 安全。
 */
import { createElement, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

/** 读侧契约（AL.4b v2）：1–5 锚文的**单点来源**；本件不自造量表。 */
const ALIGNMENTS_URL = '/api/nautilus/m2/alignments'
/** 写路径（POST 双形同门）；**读**只用 ALIGNMENTS_URL——v3 起 human[] 已含豁免行，故不再补读本端点。 */
const TURN_ANNOTATIONS_URL = '/api/nautilus/m2/turn-annotations'
const QUOTE_MAX = 200
const NOTE_MAX = 500
/** 契约锚文（1–5）；未加载时为空数组——选项只显档位数字，不编造锚文。 */
export interface AnchorRow { score: number; text: string }

// ── 判读缓存（全局单例：契约台账拉一次喂所有消息的按钮；POST 后换快照）────────────

export interface AlignRow {
  session: string
  turn: number
  /** 人工判读 1–5；豁免行为 null。 */
  align: number | null
  boundary: string
  exempt: 0 | 1
  quote: string | null
  note: string | null
  origin: 'spot' | 'sample'
}
interface AlignState {
  loaded: boolean
  loading: boolean
  error: string | null
  /** 契约 scale.anchors（1–5）；未加载 = 空数组，选项只显数字不编造锚文。 */
  anchors: AnchorRow[]
  byKey: Map<string, AlignRow>
}
let state: AlignState = { loaded: false, loading: false, error: null, anchors: [], byKey: new Map() }
const listeners = new Set<() => void>()
const notify = (): void => { for (const fn of listeners) { try { fn() } catch { /* 单监听器异常不饿死其余 */ } } }
const keyOf = (session: string, turn: number): string => session + ':' + String(turn)

/**
 * 契约 human[] → 缓存行。**v3 起 human[] 含全部新量表行**（有分 + 豁免；humanTotal == human[].length），
 * 故豁免行（align:null + exempt:1）也在这里进来——不再需要任何补充读。
 */
function fromHuman(rows: Array<Record<string, unknown>>): Map<string, AlignRow> {
  const out = new Map<string, AlignRow>()
  for (const r of rows) {
    const session = String(r.session ?? '')
    const turn = Number(r.turn)
    if (session === '' || !Number.isFinite(turn)) continue
    const hasAlign = typeof r.align === 'number' && Number.isFinite(Number(r.align))
    const exempt = Number(r.exempt ?? 0) === 1
    if (!hasAlign && !exempt) continue // 既无分又不豁免的行不成其为判读（防御，契约下不会出现）
    out.set(keyOf(session, turn), {
      session, turn,
      align: hasAlign ? Number(r.align) : null,
      boundary: r.boundary === null || r.boundary === undefined ? 'none' : String(r.boundary),
      exempt: exempt ? 1 : 0,
      quote: r.quote == null ? null : String(r.quote),
      note: r.note == null ? null : String(r.note),
      origin: r.origin === 'sample' ? 'sample' : 'spot',
    })
  }
  return out
}

/** 拉一次对齐台账（行内多按钮共享；单端点，失败显式置错、不静默）。 */
export function ensureAlignLoaded(): void {
  if (state.loaded || state.loading) return
  state = { ...state, loading: true }
  notify()
  fetch(ALIGNMENTS_URL, { headers: { accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + String(r.status))
      return (await r.json()) as Record<string, unknown>
    })
    .then((al) => {
      const byKey = fromHuman((al.human as Array<Record<string, unknown>> | undefined) ?? [])
      const raw = ((al.scale as { anchors?: Array<Record<string, unknown>> } | undefined)?.anchors) ?? []
      const anchors = raw
        .map((a) => ({ score: Number(a.score), text: String(a.text ?? '') }))
        .filter((a) => Number.isFinite(a.score))
        .sort((a, b) => a.score - b.score)
      state = { loaded: true, loading: false, error: null, anchors, byKey }
      notify()
    })
    .catch((e: unknown) => {
      state = { loaded: false, loading: false, error: e instanceof Error ? e.message : String(e), anchors: [], byKey: new Map() }
      notify()
    })
}

/**
 * 提交一条人工判读（双形同门：带 align → 新量表；仅 exempt → N/A 豁免）。
 * 成功后把响应里的 origin 并进缓存（不重拉全量）。
 *
 * **判据（与路由同源）**：body 里 `align` 键**或** `boundary` 键在场即判新形。
 * 故此处**恒带 boundary**（缺省 'none'）——N/A 走 `align:null + exempt:1 + boundary`，
 * 否则服务端会把它误判成旧形（schema_version=1）→ 既不进 exempted、又混进 legacyFitRows。
 */
export async function postHumanAlign(session: string, turn: number, body: { align?: number; boundary?: string; exempt?: 1; quote?: string; note?: string }): Promise<{ ok: boolean; error?: string; origin?: 'spot' | 'sample' }> {
  let res: Response
  try {
    res = await fetch(TURN_ANNOTATIONS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ session, turn, boundary: body.boundary ?? 'none', ...body }),
    })
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let j: { ok?: boolean; error?: string; origin?: 'spot' | 'sample' } = {}
  try { j = (await res.json()) as typeof j } catch { /* 非 JSON 按 HTTP 码处理 */ }
  if (!res.ok || j.ok !== true) return { ok: false, error: j.error ?? ('HTTP ' + String(res.status)) }
  const prev = state.byKey.get(keyOf(session, turn))
  const next = new Map(state.byKey)
  next.set(keyOf(session, turn), {
    session, turn,
    align: body.exempt === 1 ? null : (body.align ?? null),
    boundary: body.boundary ?? 'none',
    exempt: body.exempt === 1 ? 1 : 0,
    quote: body.quote ?? null,
    note: body.note ?? null,
    origin: j.origin ?? prev?.origin ?? 'spot',
  })
  state = { ...state, byKey: next } // 换快照身份，useSyncExternalStore 才会重渲染
  notify()
  return { ok: true, origin: j.origin }
}

/** 测试与外部位用：当前快照（不可变视图）。 */
export function alignSnapshot(): AlignState { return state }
export function subscribeAlign(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// ── messageId → 轮序（useChat 快照扫描；文档化 hook，不碰宿主 DOM 契约）────────

/** 构造 useChat 选择器：定位 closing.finalNode.messageId === messageId 的 turn-tail 节点。 */
export function turnSelectorFor(messageId: string): (snapshot: unknown) => number | null {
  return (snapshot) => {
    const nodes = (snapshot as { nodes?: Map<string, unknown> } | null | undefined)?.nodes
    if (nodes === undefined || nodes === null || typeof nodes.values !== 'function') return null
    for (const node of nodes.values() as IterableIterator<Record<string, unknown>>) {
      const n = node as { kind?: unknown; location?: { turn?: { turn?: unknown } }; data?: { closing?: { finalNode?: { messageId?: unknown } } | null; turn?: unknown } }
      if (n.kind !== 'turn-tail') continue
      const mid = n.data?.closing?.finalNode?.messageId
      if (mid !== messageId) continue
      const t = n.location?.turn?.turn ?? n.data?.turn
      const no = Number(t)
      return Number.isFinite(no) ? no : null
    }
    return null
  }
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

let styleDone = false
const CSS_LINES = [
  // 行内按钮：融入 IconActions（无框、透明底、secondary 标签色；hover 提级）
  // 取色一律走 --nt-*（body 级令牌，绑宿主 --dsw-alias-*）：本件在工作台 .nt-wb 之外，
  // 属宿主色谱面，永远跟随宿主、不受工作台手动档影响。
  // 修（2026-10-02）：原先引用的 --dsw-alias-{fill-hover,border-secondary,border-accent,surface-primary}
  // 四个名字在 dsh 0.1.7-rc.1 的别名表里**不存在** → 一直吃硬编码浅色兜底，暗色下浮层是白盒。
  '.nt-fitact{position:relative;display:inline-flex;align-items:center;height:24px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:var(--nt-dim,#5f5f5c);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1;cursor:pointer;user-select:none;white-space:nowrap}',
  '.nt-fitact:hover{color:var(--nt-text,#101010);background:var(--nt-hover,rgba(20,20,18,.05))}',
  '.nt-fitact[data-marked="1"]{color:var(--nt-text,#101010);font-weight:600}',
  '.nt-fitact .nv{font-variant-numeric:tabular-nums;margin-left:3px}',
  // 选择浮层：最小中性面（宿主令牌；无 Nautilus 装饰）。
  // B2：置于按钮**上方**（bottom:100%+6px，去掉 top）——不遮挡会话正文；贴顶由 max-height + 滚动兜底（不翻转，
  //     翻转会让同一控件在视口不同位置弹向两侧，用户更难预期）。
  // AL.4e（守谷人裁决，覆盖 AL.4d 的「右上角 + 36px 净空」）：提交键回到**分值排内右端**，与 1–5 / N/A 同排同高。
  //     min-width 仍由**加总**得出——分值排 = 5 档 × 28 + N/A 40 + 提交 ≈44 + 间距 6×4 = 248；
  //     浮层内容宽 272（min-width 落内容盒）→ 余 24px，一排不拥挤，故无需加宽（实测见交付说明）。
  //     不再有顶部净空：padding 回到常规 8px 9px。
  '.nt-fitpop{position:absolute;bottom:calc(100% + 6px);right:0;z-index:30;display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px solid var(--nt-border2,#c8c8c3);border-radius:8px;background:var(--dsw-alias-button-floating-fill,var(--nt-panel,#fff));box-shadow:0 6px 22px var(--nt-shadow-color,rgba(0,0,0,.16));min-width:272px;max-height:min(70vh,420px);overflow-y:auto;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--nt-text,#101010)}',
  '.nt-fitpop .row{display:flex;gap:4px;flex-wrap:wrap;align-items:center;width:100%}',
  // AL.4e：档位 + N/A + 提交同排；同高靠本行的 align-items:center（提交不再是独立元素）
  '.nt-fitpop .row.nowrap{flex-wrap:nowrap}',
  '.nt-fitpop .opt{box-sizing:border-box;min-width:28px;padding:4px 6px;border:1px solid var(--nt-border2,#c8c8c3);border-radius:6px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;font-variant-numeric:tabular-nums}',
  '.nt-fitpop .opt:hover{border-color:var(--nt-faint,#9a9a95)}',
  '.nt-fitpop .opt.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e);font-weight:700}',
  '.nt-fitpop .opt.na{min-width:40px}',
  // AL.4e：提交键与 .opt 同规格、同排同高（不绝对定位）——只收窄最小宽度，避免右端多余留白
  // AL.4f：右端贴齐输入框右端——margin-left:auto 把它推到该排右端；前提是该排满宽（见 .row 的 width:100%），
  //        而 .inp 是 width:100% 且浮层 padding 左右对称（8px 9px），故两者内容盒右边线重合。
  '.nt-fitpop .opt.sub{min-width:0;margin-left:auto;padding:4px 9px}',
  // AL.4d：输入框高度翻倍（改前单行 input ≈27px → 改后 56px）——多行以便引文可读，仍只此一个输入控件
  '.nt-fitpop .inp{width:100%;box-sizing:border-box;min-height:56px;line-height:1.45;resize:vertical;border:1px solid var(--nt-border2,#c8c8c3);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 6px}',
  '.nt-fitpop .err{color:var(--nt-accent,#e6321e);font-size:11px}',
  '.nt-fitpop .hint{color:var(--nt-faint,#9a9a95);font-size:10.5px}',
]
function injectFitStyle(): void {
  if (styleDone || typeof document === 'undefined') return
  styleDone = true
  const el = document.createElement('style')
  el.id = 'nt-fitact-style'
  el.textContent = CSS_LINES.join(String.fromCharCode(10))
  document.head.appendChild(el)
}

/** 行内对齐按钮 props（渲染器展开后的形状；本地类型仅作文档）。 */
export interface TurnFitActionProps {
  sessionId: string
  messageId: string
  /** SessionStandardProps（chat 契约）：快照选择 hook，轮序从这里解析。 */
  useChat?: (selector: (snapshot: unknown) => number | null) => number | null
  /**
   * 初始展开浮层（**仅供 SSR 断言**：renderToStaticMarkup 无法点击，浮层内容否则不可验）。
   * 线上不传 → 默认收起，行为不变。
   */
  defaultOpen?: boolean
  /**
   * 打分**成功落库后**回调（供外层只刷新「该会话详情 + 该行计数」；不传 = 无操作）。
   * 只在服务端 200 后触发——失败不回调，免得刷出「没写进去」的假象。
   */
  onScored?: () => void
}

export function TurnFitAction(props: TurnFitActionProps): ReactNode {
  injectFitStyle()
  const snap = useSyncExternalStore(subscribeAlign, alignSnapshot, alignSnapshot)
  useEffect(() => { ensureAlignLoaded() }, [])
  const [open, setOpen] = useState(props.defaultOpen === true)
  const [score, setScore] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const turnNo = typeof props.useChat === 'function' ? props.useChat(turnSelectorFor(props.messageId)) : null
  if (turnNo === null || !Number.isFinite(turnNo)) return null // 轮序未解析 → 不渲染（无轮号无法落库）
  const row = snap.byKey.get(keyOf(props.sessionId, turnNo))
  const anchorOf = (n: number): string => {
    const hit = snap.anchors.find((a) => a.score === n)
    return hit === undefined ? String(n) : String(n) + ' · ' + hit.text
  }
  const quoteRequired = score !== null && score >= 4 // 4/5 必附引文（服务端硬门，客户端先挡一次）
  const canSubmit = !busy && score !== null && (!quoteRequired || text.trim() !== '')
  const submit = async (body: { align?: number; boundary?: string; exempt?: 1; quote?: string; note?: string }): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await postHumanAlign(props.sessionId, turnNo, body)
    setBusy(false)
    if (!r.ok) { setErr(errText(r.error ?? '未知错误')); return }
    setText('')
    setScore(null)
    setOpen(false)
    if (props.onScored !== undefined) props.onScored()
  }
  const submitScore = (): void => {
    if (!canSubmit || score === null) return
    const t = text.trim()
    // AL.4d：UI 不采集 boundary——不在 body 里传它，交给 postHumanAlign 恒填 'none'
    //（服务端「新形判据」靠这个键，不能连它一起删）。
    void submit({
      align: score,
      quote: quoteRequired ? t.slice(0, QUOTE_MAX) : undefined,
      note: quoteRequired || t === '' ? undefined : t.slice(0, NOTE_MAX),
    })
  }
  const onExempt = (): void => { setErr(null); void submit({ exempt: 1 }) }
  const label = row === undefined
    ? '对齐'
    : row.exempt === 1
      ? createElement('span', null, '对齐', createElement('span', { className: 'nv' }, 'N/A'))
      : createElement('span', null, '对齐', createElement('span', { className: 'nv' }, String(row.align) + (row.origin === 'sample' ? '样' : '')))
  const pop = open
    ? createElement('div', { className: 'nt-fitpop', role: 'menu' },
      // 第一排（AL.4e）：1–5 档 + N/A + 提交**同排同高**（提交在排的右端，不再是浮在排上方的独立元素）；
      // 同高由 .row 的 align-items:center 保证；N/A 仍是「一点即豁免」
      createElement('div', { className: 'row nowrap' },
        ...[1, 2, 3, 4, 5].map((n) => createElement('button', {
          key: 'a' + String(n), className: 'opt' + (score === n ? ' on' : ''),
          title: anchorOf(n), disabled: busy, onClick: () => { setErr(null); setScore(n) },
        }, String(n))),
        createElement('button', {
          className: 'opt na' + (row !== undefined && row.exempt === 1 ? ' on' : ''),
          title: 'N/A = 无判断对象（纯操作性指令轮）→ 豁免，不进分母', disabled: busy, onClick: onExempt,
        }, 'N/A'),
        createElement('button', {
          className: 'opt sub', disabled: !canSubmit,
          title: quoteRequired ? '4/5 档必附引文后才能提交' : '提交本轮判读',
          onClick: submitScore,
        }, '提交'),
      ),
      // 第二排（B3/AL.4d）：**单一输入控件**，高度翻倍（min-height 56px ≈ 改前 27px 的 2 倍）；
      // 4/5 走引文、1–3 走一句话理由，提交时映射到服务端两列
      createElement('div', { className: 'row' },
        createElement('textarea', {
          className: 'inp', rows: 2, maxLength: quoteRequired ? QUOTE_MAX : NOTE_MAX,
          placeholder: quoteRequired ? '4/5 必附引文：我引用 / 追问 / 改道于哪句？（≤200 字）' : '一句话理由（可空）',
          value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value),
        })),
      err !== null ? createElement('div', { className: 'err' }, err) : null,
    )
    : null
  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
    createElement('button', {
      className: 'nt-fitact', 'data-marked': row === undefined ? '0' : '1',
      'data-session': props.sessionId, 'data-turn': String(turnNo),
      title: '对齐：守谷人对本轮的人工判读（1–5 档锚定 · N/A 豁免）',
      onClick: () => { setOpen((v) => !v); setErr(null) },
    }, label),
    pop,
  )
}

/** 服务端错误码 → 人话（口径见 dev-05 §3；不掩盖 400 语义）。 */
function errText(code: string): string {
  if (code === 'HTTP 404') return '标注服务未上线（宿主重启后生效）'
  if (code === 'align-quote-required') return '4/5 档必附引文'
  if (code === 'quote-required') return '4/5 档必附引文（旧形码）'
  if (code === 'quote-too-long') return '引文超过 200 字'
  if (code === 'no-turn-text') return '该轮原文不在场，不可标（不让人对着摘要打分）'
  if (code === 'invalid:align') return '对齐分必须是 1–5'
  if (code === 'invalid:align-xor-exempt') return '档位与豁免必须二选一'
  if (code === 'invalid:boundary') return '边界取值不在枚举内'
  // 旧形码：本件从不发 fit，故只可能是服务端仍在跑改造前路由——不该再看到
  if (code === 'invalid:fit-xor-exempt') return '档位与豁免必须二选一（客户端不应出现，出现即 bug）'
  if (code.startsWith('HTTP 40')) return '请求被拒（' + code + '）'
  return '提交失败：' + code
}

// ── 注册（index.ts apply() 调用）───────────────────────────────────────────────

/** list 槽注册：name/id/inject（list 用 id；无 select——渲染时机与消息身份全由宿主给）。 */
export function registerTurnFit(ctx: {
  effect(callback: () => unknown, name: string): unknown
  slots: {
    inject(key: string, callback: () => unknown): unknown
    register(def: Record<string, unknown>, component: unknown): unknown
  }
}): void {
  ctx.effect(
    () => ctx.slots.inject('conversation.chat.assistant-actions', () =>
      ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'nautilus-fit',
        order: 30,
        // session 槽 inject 首参 = sessionId（renderer runInject：binding.key）
        inject: (sessionId: string) => ({ sessionId }),
      }, TurnFitAction),
    ),
    '@dsh-external/dsh-nautilus: turn fit action',
  )
}
