/**
 * @dsh-external/dsh-nautilus — M2 官方会话事件采集（L 场读数数据层）。
 * 纯逻辑（零 cordis 依赖，可单测）：订阅 session/event 的
 *   turn/start（轮次指针）→ user/message（问答摘要）→ step/start（计时）
 *   → assistant/message（usage: inputTokens/outputTokens/cacheReadTokens + turn/step）
 * 按 (session, turn) 幂等聚合为 turn_read。与团队底座零耦合（官方事件直采）。
 */
import type { NautilusStore } from '../store.js'

/** 最小事件形态（官方 SessionEvent 的 duck-type 子集；避免新增 dsh-session 依赖）。 */
export interface TurnEventLike {
  type: string
  time?: number
  seq?: number
  data: Record<string, unknown>
}

interface UsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
}

const QUESTION_LEN = 80

/** 写失败日志的限流档：**首 N 次全打**，其后**每 M 次打一次**（丢写要可见，但不能自己淹掉日志）。 */
const FAILURE_LOG_FIRST = 5
const FAILURE_LOG_EVERY = 100
/** `lastError` 摘要截断长度：诊断面是给人/UI 看的一行，不是错误日志全文（避免把 SQL/路径整段搬上面板）。 */
const LAST_ERROR_MAX = 200

/**
 * 采集写失败的可见化读数（PS.0fix 任务 C）。
 * 进程内累计、不落库：它的用途是回答「刚才是不是丢了轮次」，而不是长期统计。
 */
export interface CollectorDiagnostics {
  /** 累计写入失败次数（本进程）。 */
  writeFailures: number
  /** 最近一次失败摘要 `<op>: <message>`（截断至 LAST_ERROR_MAX；null = 从未失败）。 */
  lastError: string | null
  /** 最近一次失败时刻（ms；null = 从未失败）——诊断面据此判断「还在失败吗」。 */
  lastErrorAt: number | null
}

/** 写护栏的返回值：ok=false 表示这次 store 调用抛了（已计数），调用方应短路本次事件的余下写步骤。 */
type WriteResult<T> = { ok: true; value: T } | { ok: false }

/** 从 message content 块提取文本（text 块拼接，截 len）。 */
function textOf(content: unknown, len: number): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
    }
  }
  return out.slice(0, len)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export class TurnsCollector {
  /** step 计时：`session:turn:step` → step/start 时刻（assistant/message 时算生成耗时）。 */
  private readonly pendingSteps = new Map<string, number>()
  /** 当前轮问答摘要：session → 80 字（turn/start 时清空，user/message 时写入）。 */
  private readonly latestQuestion = new Map<string, string | null>()
  /** 当前轮指针：session → turn（user/message 无 turn 字段——按事件序归属，同 E-1 精神）。 */
  private readonly latestTurn = new Map<string, number>()
  /** M4-L：已打标会话（进程内去重；DB INSERT OR IGNORE 兜底重载/重启/多实例）。 */
  private readonly stamped = new Set<string>()
  /** PS.0fix C：累计写失败次数（诊断面读数）。 */
  private writeFailures = 0
  /** PS.0fix C：最近一次失败摘要（截断）。 */
  private lastError: string | null = null
  /** PS.0fix C：最近一次失败时刻（ms）。 */
  private lastErrorAt: number | null = null

  constructor(private readonly store: NautilusStore) {}

  /** 诊断读数（`/m2/state` 的 diagnostics.collector；只读快照）。 */
  diagnostics(): CollectorDiagnostics {
    return { writeFailures: this.writeFailures, lastError: this.lastError, lastErrorAt: this.lastErrorAt }
  }

  /**
   * 写路径统一护栏（PS.0fix 任务 C）：单个 store 调用失败**不再无声蒸发**——
   * 计数 + 留摘要 + 限流日志，并让调用方短路本次事件余下的写步骤（库坏了就别再连环抛）。
   *
   * 为什么必须可见：数据目录可被多个宿主进程（dsh-web / desktop）共享，SQLITE_BUSY / 只读 / 句柄失效
   * 都不会自己消失；没有计数时，「这里丢了一轮」与「这一轮本来就没有读数」在面板上完全一样。
   * 事件是**一次性**的（官方 session/event 不重放），所以丢写的唯一补救就是让它被看见。
   */
  private write<T>(op: string, fn: () => T): WriteResult<T> {
    try {
      return { ok: true, value: fn() }
    } catch (err) {
      this.noteFailure(op, err)
      return { ok: false }
    }
  }

  /** 记一次写失败：计数 → 摘要（截断）→ 限流日志（首 FAILURE_LOG_FIRST 次全打，其后每 FAILURE_LOG_EVERY 次一次）。 */
  private noteFailure(op: string, err: unknown): void {
    this.writeFailures += 1
    const detail = err instanceof Error ? err.message : String(err)
    this.lastError = (op + ': ' + detail).slice(0, LAST_ERROR_MAX)
    this.lastErrorAt = Date.now()
    const n = this.writeFailures
    if (n <= FAILURE_LOG_FIRST || n % FAILURE_LOG_EVERY === 0) {
      console.error('[nautilus] turn collect write failed #' + n + '（' + this.lastError + '）'
        + (n <= FAILURE_LOG_FIRST ? '' : ' · 其后每 ' + FAILURE_LOG_EVERY + ' 次记一条'))
    }
  }

  handle(sessionId: string, ev: TurnEventLike, cwd?: string): void {
    // M4-L：会话首次落点 → 分类归属（cwd 在指向根下 = vault 会话；否则 '' = 不属于任何指向，只在全局视图出现）
    if (!this.stamped.has(sessionId)) {
      // 失败也照样记 stamped：一次写失败不该让后续每个事件都重试打标（计数已把这次失败暴露出来）
      this.stamped.add(sessionId)
      this.write('classifySessionRoot', () => this.store.classifySessionRoot(sessionId, cwd, typeof ev.time === 'number' ? ev.time : Date.now()))
    }
    const time = typeof ev.time === 'number' ? ev.time : Date.now()
    switch (ev.type) {
      case 'turn/start': {
        const turn = num((ev.data as { turn?: unknown }).turn)
        if (turn !== undefined) this.latestTurn.set(sessionId, turn)
        // 新轮开始：重置问答摘要（无 user/message 时不残留上一轮）
        this.latestQuestion.set(sessionId, null)
        break
      }

      case 'user/message': {
        const content = (ev.data as { content?: unknown }).content
        const full = textOf(content, Infinity)
        const q = full.slice(0, QUESTION_LEN)
        if (q !== '') this.latestQuestion.set(sessionId, q)
        // M3-F.2（B 方案）：完整问题原文入 turn_text（按 turn 指针归属）
        const turn = this.latestTurn.get(sessionId)
        if (full !== '' && turn !== undefined) this.write('upsertUserText', () => this.store.upsertUserText(sessionId, turn, full))
        break
      }

      case 'step/start': {
        const turn = num((ev.data as { turn?: unknown }).turn)
        const step = num((ev.data as { step?: unknown }).step)
        if (turn !== undefined && step !== undefined) {
          this.pendingSteps.set(`${sessionId}:${turn}:${step}`, time)
        }
        break
      }

      case 'assistant/message': {
        const d = ev.data as { turn?: unknown; step?: unknown; usage?: UsageLike; message?: { content?: unknown } }
        const turn = num(d.turn)
        const step = num(d.step)
        const usage = d.usage
        if (turn === undefined || step === undefined || usage === undefined) return
        const stepKey = `${sessionId}:${turn}:${step}`
        const startTs = this.pendingSteps.get(stepKey)
        if (startTs !== undefined) this.pendingSteps.delete(stepKey)
        const durationMs = startTs !== undefined ? Math.max(0, time - startTs) : null

        // 幂等：同一 step 事件只聚合一次（重启/重载/重复 emit 不重复计数）。
        // 失败（计数已记）按「已见」处理并短路本次事件：宁可少这一轮，也不冒 assistant 全文重复累加的风险。
        const seen = this.write('marksStepSeen', () => this.store.marksStepSeen(sessionId, turn, step))
        if (!seen.ok || !seen.value) return

        // M3-F.2（B 方案）：assistant 全文累加（多 step 拼接；幂等由 step_seen 保证）
        const assistantFull = textOf((d.message as { content?: unknown } | undefined)?.content, Infinity)
        if (assistantFull !== '') this.write('appendAssistantText', () => this.store.appendAssistantText(sessionId, turn, assistantFull))

        this.write('upsertTurnRead', () => this.store.upsertTurnRead({
          session: sessionId,
          turn,
          ts: time,
          question: this.latestQuestion.get(sessionId) ?? null,
          tokenIn: num(usage.inputTokens) ?? 0,
          tokenOut: num(usage.outputTokens) ?? 0,
          cacheRead: num(usage.cacheReadTokens) ?? 0,
          durationMs,
        }))
        break
      }

      default:
        break // turn/end、step/end、tool/*、todo/write、request/*：M2 不消费
    }
  }
}
