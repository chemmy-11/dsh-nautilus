/**
 * @dsh-external/dsh-nautilus — 流内契合打分件（T 系列 UI 半区主入口，决策 D-T5）。
 *
 * 挂宿主公开槽位 `conversation.chat.turnTail`（kind chain / scope session；dsh 0.1.5-rc.2
 * `dsh-client-ui-chat` contract/slots.d.ts 源码核实）：已完成轮动作行上方的紧凑契合条——
 * 判断在热的现场直接标，写路径 = POST /api/nautilus/m2/turn-annotations（同源浏览器门，
 * 与 S1.1 token 通道隔离）。量表锁版 schema_version=1（docs/1-planning/nautilus-turn-annotation.md §1）。
 *
 * 契约要点（renderer client.js 运行时核实）：
 *  - chain 条目 def 带 `select(owner)`：返回 null = 谢绝（换下一个条目），非 null = 接受
 *    且返回值以 `matched` 并入组件 props；全链谢绝 = 不渲染。
 *  - session 槽条目 def 带 `inject: (sessionId) => injected`——会话身份从这里来
 *    （先例：宿主自带 message-feedback 的同型注册）。
 *
 * 纪律：零第三方 import（react 除外）；本地类型（src/client 不进 tsc，类型只是文档）；
 * `nt-` 前缀 + `--nt-*` 令牌（fallback 与令牌默认值同值）；SSR 安全（样式/effect 全部守卫）。
 */
import { createElement, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'

/** 锁版量表（决策文档 §1 原文；chip title 携全锚文，界面只显档位数字）。 */
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

// ── 标注缓存（全局单例：GET 清单一次喂所有轮的条；POST 后就地更新）────────────

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

/** 拉一次全量标注清单（多条同会话的条共享；失败显式置错，不静默）。 */
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

// ── chain 选择器：已完成轮接受（matched 带轮序），其余谢绝 ─────────────────────

export interface TurnFitMatched { turnNo: number }
export function selectTurnFit(owner: { turn?: { turn?: unknown; status?: unknown } } | null | undefined): TurnFitMatched | null {
  const t = owner?.turn
  const no = t?.turn
  if (t === null || t === undefined || !Number.isFinite(Number(no))) return null
  if (t.status === 'open') return null // 未收口的轮不标（turnTail 本就只在完成轮渲染，双保险）
  return { turnNo: Number(no) }
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

let styleDone = false
const CSS_LINES = [
  '.nt-fitbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 6px;padding:4px 8px;border:1px dashed var(--nt-border,#d9d9d5);border-radius:2px;font-family:var(--nt-font,Helvetica,Arial,sans-serif);font-size:11px;color:var(--nt-dim,#5f5f5c);background:var(--nt-panel2,#f7f7f5)}',
  '.nt-fitbar .lb{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--nt-faint,#9a9a95)}',
  '.nt-fitbar .chip{border:1px solid var(--nt-border2,#c8c8c3);background:var(--nt-panel,#fff);color:var(--nt-text,#101010);font-size:10.5px;line-height:1;padding:3px 7px;cursor:pointer;border-radius:2px;font-variant-numeric:tabular-nums}',
  '.nt-fitbar .chip:hover{border-color:var(--nt-text,#101010)}',
  '.nt-fitbar .chip.on{border-color:var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e);font-weight:700}',
  '.nt-fitbar .chip:disabled{opacity:.45;cursor:default}',
  '.nt-fitbar .done{font-size:10px;color:var(--nt-text,#101010)}',
  '.nt-fitbar .tag{font-size:9px;letter-spacing:1px;border:1px solid var(--nt-accent,#e6321e);color:var(--nt-accent,#e6321e);padding:0 4px}',
  '.nt-fitbar .ext{flex-basis:100%;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}',
  '.nt-fitbar textarea,.nt-fitbar input[type=text]{flex:1 1 260px;border:1px solid var(--nt-border2,#c8c8c3);background:var(--nt-panel,#fff);color:var(--nt-text,#101010);font-size:11px;padding:4px 6px;border-radius:2px;font-family:inherit;resize:vertical}',
  '.nt-fitbar .err{flex-basis:100%;font-size:10px;color:var(--nt-accent,#e6321e)}',
  '.nt-fitbar .hint{font-size:9.5px;color:var(--nt-faint,#9a9a95)}',
]
function injectFitbarStyle(): void {
  if (styleDone || typeof document === 'undefined') return
  styleDone = true
  const el = document.createElement('style')
  el.id = 'nt-fitbar-style'
  el.textContent = CSS_LINES.join(String.fromCharCode(10))
  document.head.appendChild(el)
}

/** 单轮契合条 props（渲染器展开后的形状；本地类型仅作文档）。 */
export interface TurnFitBarProps {
  sessionId: string
  turnNo: number
}

export function TurnFitBar(props: TurnFitBarProps): ReactNode {
  injectFitbarStyle()
  const snap = useSyncExternalStore(subscribeFit, fitSnapshot, fitSnapshot)
  useEffect(() => { ensureFitLoaded() }, [])
  const [pending, setPending] = useState<number | 'na' | null>(null) // 正在补引文/理由的档位
  const [quote, setQuote] = useState('')
  const [note, setNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const row = snap.byKey.get(keyOf(props.sessionId, props.turnNo))
  const submit = async (body: { fit?: number; exempt?: 1; quote?: string; note?: string }): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await postFit(props.sessionId, props.turnNo, body)
    setBusy(false)
    if (!r.ok) { setErr(errText(r.error ?? '未知错误')); return }
    setPending(null)
    setQuote('')
    setNote('')
    setNoteOpen(false)
  }
  const onChip = (fit: number | 'na'): void => {
    setErr(null)
    if (fit === 4) { setPending(4); return } // 最强锚必附引文：先展开引文框再提交（服务端双门拒裸 4）
    if (fit === 'na') { void submit({ exempt: 1 }); return }
    void submit({ fit, note: noteOpen && note.trim() !== '' ? note.trim().slice(0, NOTE_MAX) : undefined })
  }
  const chips = [
    ...FIT_SCALE.map((s) => createElement('button', {
      key: 'f' + String(s.fit), className: 'chip' + (row !== undefined && row.fit === s.fit ? ' on' : ''),
      title: s.anchor, disabled: busy, onClick: () => onChip(s.fit),
    }, s.short)),
    createElement('button', {
      key: 'na', className: 'chip' + (row !== undefined && row.exempt === 1 ? ' on' : ''),
      title: 'N/A = 无判断对象（纯操作性指令轮）→ 豁免，不进分母', disabled: busy, onClick: () => onChip('na'),
    }, 'N/A'),
  ]
  const noteCtl = noteOpen || note !== ''
    ? createElement('input', {
      type: 'text', className: 'nt-input', maxLength: NOTE_MAX, placeholder: '一句话理由（可空）', value: note,
      onChange: (e: { target: { value: string } }) => setNote(e.target.value),
    })
    : createElement('button', { className: 'chip', disabled: busy, onClick: () => setNoteOpen(true), title: '附一句话理由（可空）' }, '+理由')
  const ext = pending === 4
    ? createElement('div', { className: 'ext' },
      createElement('textarea', {
        maxLength: QUOTE_MAX, rows: 2, autoFocus: true,
        placeholder: 'fit=4 必附引文：我引用/追问/改道于哪句？（≤200 字）',
        value: quote, onChange: (e: { target: { value: string } }) => setQuote(e.target.value),
      }),
      noteCtl,
      createElement('button', {
        className: 'chip', disabled: busy || quote.trim() === '',
        onClick: () => { void submit({ fit: 4, quote: quote.trim(), note: noteOpen && note.trim() !== '' ? note.trim() : undefined }) },
      }, '提交 4'),
      createElement('button', { className: 'chip', disabled: busy, onClick: () => { setPending(null); setErr(null) } }, '取消'),
      createElement('span', { className: 'hint' }, String(quote.trim().length) + '/' + String(QUOTE_MAX)),
    )
    : (pending === null ? null : createElement('div', { className: 'ext' }, noteCtl))
  const status = row === undefined
    ? null
    : row.exempt === 1
      ? createElement('span', { className: 'done' }, 'N/A · 已豁免')
      : createElement('span', { className: 'done' }, '已标 ' + String(row.fit) + (row.origin === 'sample' ? ' ' : ''),
        row.origin === 'sample' ? createElement('span', { className: 'tag', title: '抽样队列口径（origin=sample，服务端判定）' }, '样') : null)
  return createElement('div', { className: 'nt-fitbar', 'data-session': props.sessionId, 'data-turn': String(props.turnNo) },
    createElement('span', { className: 'lb' }, '契合'),
    ...chips,
    status,
    snap.error !== null ? createElement('span', { className: 'err' }, snap.error === 'HTTP 404' ? '标注服务未上线（宿主重启后生效）' : '清单加载失败：' + snap.error) : null,
    err !== null ? createElement('span', { className: 'err' }, err) : null,
    ext,
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

/** chain 槽注册：name/id/select/inject 缺一不可（select 缺 = 恒谢绝）。 */
export function registerTurnFit(ctx: {
  effect(callback: () => unknown, name: string): unknown
  slots: {
    inject(key: string, callback: () => unknown): unknown
    register(def: Record<string, unknown>, component: unknown): unknown
  }
}): void {
  ctx.effect(
    () => ctx.slots.inject('conversation.chat.turnTail', () =>
      ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'nautilus-fit',
        order: 20,
        select: selectTurnFit,
        // session 槽 inject 首参 = sessionId（renderer runInject：binding.key）
        inject: (sessionId: string) => ({ sessionId }),
      }, TurnFitBar),
    ),
    '@dsh-external/dsh-nautilus: turn fit bar',
  )
}
