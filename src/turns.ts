/**
 * @dsh-external/dsh-xuegulin — M2 官方会话事件采集（L 场读数数据层）。
 * 纯逻辑（零 cordis 依赖，可单测）：订阅 session/event 的
 *   turn/start（轮次指针）→ user/message（问答摘要）→ step/start（计时）
 *   → assistant/message（usage: inputTokens/outputTokens/cacheReadTokens + turn/step）
 * 按 (session, turn) 幂等聚合为 turn_read。与团队底座零耦合（官方事件直采）。
 */
import type { XuegulinStore } from './store.js'

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

  constructor(private readonly store: XuegulinStore) {}

  handle(sessionId: string, ev: TurnEventLike): void {
    const time = typeof ev.time === 'number' ? ev.time : Date.now()
    switch (ev.type) {
      case 'turn/start':
        // 新轮开始：重置问答摘要（无 user/message 时不残留上一轮）
        this.latestQuestion.set(sessionId, null)
        break

      case 'user/message': {
        const q = textOf((ev.data as { content?: unknown }).content, QUESTION_LEN)
        if (q !== '') this.latestQuestion.set(sessionId, q)
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
        const d = ev.data as { turn?: unknown; step?: unknown; usage?: UsageLike }
        const turn = num(d.turn)
        const step = num(d.step)
        const usage = d.usage
        if (turn === undefined || step === undefined || usage === undefined) return
        const stepKey = `${sessionId}:${turn}:${step}`
        const startTs = this.pendingSteps.get(stepKey)
        if (startTs !== undefined) this.pendingSteps.delete(stepKey)
        const durationMs = startTs !== undefined ? Math.max(0, time - startTs) : null

        // 幂等：同一 step 事件只聚合一次（重启/重载/重复 emit 不重复计数）
        if (!this.store.marksStepSeen(sessionId, turn, step)) return

        this.store.upsertTurnRead({
          session: sessionId,
          turn,
          ts: time,
          question: this.latestQuestion.get(sessionId) ?? null,
          tokenIn: num(usage.inputTokens) ?? 0,
          tokenOut: num(usage.outputTokens) ?? 0,
          cacheRead: num(usage.cacheReadTokens) ?? 0,
          durationMs,
        })
        break
      }

      default:
        break // turn/end、step/end、tool/*、todo/write、request/*：M2 不消费
    }
  }
}
