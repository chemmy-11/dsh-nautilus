/**
 * @dsh-external/dsh-nautilus — 流内契合打分件（T 系列 UI 半区主入口）。
 *
 * 版面（2026-09-27 守谷人改口）：挂宿主 `conversation.chat.assistant-actions` 列表槽
 * （助手消息 IconActions 行，赞/踩同排；kind list / scope session；owner 仅 { messageId }），
 * 按钮本体**零 Nautilus 背景**——无框文本按钮融入宿主 IconActions 行（--dsw-alias-* 令牌），
 * 选择面板为最小中性浮层。此前 turnTail 链槽方案废弃（端上实测最新轮的 tail 不稳定出现）。
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

/** 锁版量表（决策文档 §1 原文；选项 title 携全锚文，界面只显档位数字）。 */
export const FIT_SCALE: Array<{ fit: number; short: string; anchor: string }> = [
  { fit: 4, short: '4', anchor: '改变了我下一步动作/笔记（被引用、被追问、被改道）——必附引文' },
  { fit: 3, short: '3', anchor: '推进了问题本身（不是答对，是把问题推深一层）' },
  { fit: 2, short: '2', anchor: '在场之内、但组织方式新（重组已有材料）' },
  { fit: 1, short: '1', anchor: '正确但无增量' },
  { fit: 0, short: '0', anchor: '滑过（读即没读）' },
]
const QUOTE_MAX = 200
const NOTE_MAX = 500
const API_URL = '/api/nautilus/m2/turn-annotations'

// ── 标注缓存（全局单例：GET 清单一次喂所有消息的按钮；POST 后换快照更新）────────

export interface FitRow {
  session: string
  turn: number
  fit: number | null
  exempt: 0 | 1
  quote: string | null
  note: string | null
  origin: 'spot' | 'sample'
}
interface FitState {
  loaded: boolean
  loading: boolean
  error: string | null
  byKey: Map<string, FitRow>
}
let state: FitState = { loaded: false, loading: false, error: null, byKey: new Map() }
const listeners = new Set<() => void>()
const notify = (): void => { for (const fn of listeners) { try { fn() } catch { /* 单监听器异常不饿死其余 */ } } }
const keyOf = (session: string, turn: number): string => session + ':' + String(turn)

function applyRows(annotations: Array<Record<string, unknown>>): void {
  const byKey = new Map<string, FitRow>()
  for (const r of annotations) {
    const session = String(r.session ?? '')
    const turn = Number(r.turn)
    if (session === '' || !Number.isFinite(turn)) continue
    byKey.set(keyOf(session, turn), {
      session, turn,
      fit: r.fit === null || r.fit === undefined ? null : Number(r.fit),
      exempt: Number(r.exempt ?? 0) === 1 ? 1 : 0,
      quote: r.quote == null ? null : String(r.quote),
      note: r.note == null ? null : String(r.note),
      origin: r.origin === 'sample' ? 'sample' : 'spot',
    })
  }
  state = { loaded: true, loading: false, error: null, byKey }
  notify()
}

/** 拉一次全量标注清单（行内多按钮共享；失败显式置错，不静默）。 */
export function ensureFitLoaded(): void {
  if (state.loaded || state.loading) return
  state = { ...state, loading: true }
  notify()
  fetch(API_URL, { headers: { accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + String(r.status))
      return (await r.json()) as { annotations?: Array<Record<string, unknown>> }
    })
    .then((j) => applyRows(j.annotations ?? []))
    .catch((e: unknown) => {
      state = { loaded: false, loading: false, error: e instanceof Error ? e.message : String(e), byKey: new Map() }
      notify()
    })
}

/** 提交一条标注；成功后把响应里的 origin 并进缓存（不重拉全量）。 */
export async function postFit(session: string, turn: number, body: { fit?: number; exempt?: 1; quote?: string; note?: string }): Promise<{ ok: boolean; error?: string; origin?: 'spot' | 'sample' }> {
  let res: Response
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ session, turn, ...body }),
    })
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let j: { ok?: boolean; error?: string; origin?: 'spot' | 'sample' } = {}
  try { j = (await res.json()) as typeof j } catch { /* 非 JSON 按 HTTP 码处理 */ }
  if (!res.ok || j.ok !== true) return { ok: false, error: j.error ?? ('HTTP ' + String(res.status)) }
  const fit = body.exempt === 1 ? null : (body.fit ?? null)
  const prev = state.byKey.get(keyOf(session, turn))
  const next = new Map(state.byKey)
  next.set(keyOf(session, turn), {
    session, turn, fit, exempt: body.exempt === 1 ? 1 : 0,
    quote: body.quote ?? null, note: body.note ?? null,
    origin: j.origin ?? prev?.origin ?? 'spot',
  })
  state = { ...state, byKey: next } // 换快照身份，useSyncExternalStore 才会重渲染
  notify()
  return { ok: true, origin: j.origin }
}

/** 测试与外部位用：当前快照（不可变视图）。 */
export function fitSnapshot(): FitState { return state }
export function subscribeFit(fn: () => void): () => void {
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
  // 选择浮层：最小中性面（宿主令牌；无 Nautilus 装饰）
  '.nt-fitpop{position:absolute;top:calc(100% + 6px);right:0;z-index:30;display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px solid var(--nt-border2,#c8c8c3);border-radius:8px;background:var(--dsw-alias-button-floating-fill,var(--nt-panel,#fff));box-shadow:0 6px 22px var(--nt-shadow-color,rgba(0,0,0,.16));min-width:230px;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--nt-text,#101010)}',
  '.nt-fitpop .row{display:flex;gap:4px;flex-wrap:wrap;align-items:center}',
  '.nt-fitpop .opt{min-width:26px;padding:4px 7px;border:1px solid var(--nt-border2,#c8c8c3);border-radius:6px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;font-variant-numeric:tabular-nums}',
  '.nt-fitpop .opt:hover{border-color:var(--nt-faint,#9a9a95)}',
  '.nt-fitpop .opt.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e);font-weight:700}',
  '.nt-fitpop .opt.na{min-width:34px}',
  '.nt-fitpop textarea,.nt-fitpop input[type=text]{width:100%;box-sizing:border-box;border:1px solid var(--nt-border2,#c8c8c3);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 6px;resize:vertical}',
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

/** 行内契合按钮 props（渲染器展开后的形状；本地类型仅作文档）。 */
export interface TurnFitActionProps {
  sessionId: string
  messageId: string
  /** SessionStandardProps（chat 契约）：快照选择 hook，轮序从这里解析。 */
  useChat?: (selector: (snapshot: unknown) => number | null) => number | null
}

export function TurnFitAction(props: TurnFitActionProps): ReactNode {
  injectFitStyle()
  const snap = useSyncExternalStore(subscribeFit, fitSnapshot, fitSnapshot)
  useEffect(() => { ensureFitLoaded() }, [])
  const [open, setOpen] = useState(false)
  const [quote, setQuote] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const turnNo = typeof props.useChat === 'function' ? props.useChat(turnSelectorFor(props.messageId)) : null
  if (turnNo === null || !Number.isFinite(turnNo)) return null // 轮序未解析 → 不渲染（无轮号无法落库）
  const row = snap.byKey.get(keyOf(props.sessionId, turnNo))
  const submit = async (body: { fit?: number; exempt?: 1; quote?: string; note?: string }): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await postFit(props.sessionId, turnNo, body)
    setBusy(false)
    if (!r.ok) { setErr(errText(r.error ?? '未知错误')); return }
    setQuote('')
    setNote('')
    setOpen(false)
  }
  const onOpt = (fit: number | 'na'): void => {
    setErr(null)
    if (fit === 4) return // 4 在浮层内走引文框提交（服务端双门拒裸 4）
    if (fit === 'na') { void submit({ exempt: 1 }); return }
    void submit({ fit, note: note.trim() !== '' ? note.trim().slice(0, NOTE_MAX) : undefined })
  }
  const label = row === undefined
    ? '契合'
    : row.exempt === 1
      ? createElement('span', null, '契合', createElement('span', { className: 'nv' }, 'N/A'))
      : createElement('span', null, '契合', createElement('span', { className: 'nv' }, String(row.fit) + (row.origin === 'sample' ? '样' : '')))
  const pop = open
    ? createElement('div', { className: 'nt-fitpop', role: 'menu' },
      createElement('div', { className: 'row' },
        ...FIT_SCALE.map((s) => createElement('button', {
          key: 'f' + String(s.fit), className: 'opt' + (row !== undefined && row.fit === s.fit ? ' on' : ''),
          title: s.anchor, disabled: busy, onClick: () => onOpt(s.fit),
        }, s.short)),
        createElement('button', {
          className: 'opt na' + (row !== undefined && row.exempt === 1 ? ' on' : ''),
          title: 'N/A = 无判断对象（纯操作性指令轮）→ 豁免，不进分母', disabled: busy, onClick: () => onOpt('na'),
        }, 'N/A'),
        createElement('span', { className: 'hint' }, 't' + String(turnNo)),
      ),
      row !== undefined && row.fit === 4
        ? null
        : createElement('div', { className: 'row' },
          createElement('textarea', {
            maxLength: QUOTE_MAX, rows: 2, placeholder: '选 4 必附引文：我引用/追问/改道于哪句？（≤200 字）',
            value: quote, onChange: (e: { target: { value: string } }) => setQuote(e.target.value),
          })),
      row !== undefined && row.fit === 4
        ? null
        : createElement('div', { className: 'row' },
          createElement('input', {
            type: 'text', maxLength: NOTE_MAX, placeholder: '一句话理由（可空）', value: note,
            onChange: (e: { target: { value: string } }) => setNote(e.target.value),
          }),
          createElement('button', {
            className: 'opt', disabled: busy || quote.trim() === '',
            onClick: () => { void submit({ fit: 4, quote: quote.trim(), note: note.trim() !== '' ? note.trim() : undefined }) },
          }, '提交 4')),
      err !== null ? createElement('div', { className: 'err' }, err) : null,
    )
    : null
  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
    createElement('button', {
      className: 'nt-fitact', 'data-marked': row === undefined ? '0' : '1',
      'data-session': props.sessionId, 'data-turn': String(turnNo),
      title: '契合：守谷人对本轮的人工判读（5 档锚定 · N/A 豁免）',
      onClick: () => { setOpen((v) => !v); setErr(null) },
    }, label),
    pop,
  )
}

/** 服务端错误码 → 人话（口径见 dev-05 §3；不掩盖 400 语义）。 */
function errText(code: string): string {
  if (code === 'HTTP 404') return '标注服务未上线（宿主重启后生效）'
  if (code === 'quote-required') return 'fit=4 必附引文'
  if (code === 'quote-too-long') return '引文超过 200 字'
  if (code === 'no-turn-text') return '该轮原文不在场，不可标（不让人对着摘要打五分制）'
  if (code === 'invalid:fit-xor-exempt') return '档位与豁免必须二选一'
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
