/**
 * @dsh-external/dsh-nautilus — AL.5s 往期会话读侧：会话名 / label 派生（**服务端单点**）。
 *
 * 需求（守谷人）：工作台要能对**往期会话**的轮次打分、轮次名称用「工作区 + 会话名」、点开看详细会话信息。
 * 三件事共用一条「列出往期会话与其轮次」的读接口（`/api/nautilus/m2/sessions`，见 src/routes.ts）。
 *
 * 为什么派生规则放在这里：UI 线按冻结契约写视图，label 由服务端拼一次就够；同一规则若在客户端
 * 再拼一遍，两处必然漂移（口径单点纪律，与 AL.4b 的 scale/consistency 同款）。本模块**纯函数、
 * 零 import、可单测**——routes.ts 只做「取原料 → 调这里 → 出 JSON」。
 *
 * 派生规则（守谷人冻结契约，逐字实现）：
 *   label = workspaceName + ' · ' + sessionName
 *   · workspaceName = session_root 里该会话工作区路径的 basename；无记录 → 「未知工作区」
 *   · sessionName   = 该会话**第一条不以 '<' 开头且去空白非空**的 question 的**首行前 24 字**；
 *                     无 → session id 短形（末 8 位）。**不存在的真会话名不要编**。
 *
 * 尖括号那一条不是洁癖：真库（2026-09-27 字节快照副本）65 条 turn_read 里 8 条 question 以
 * `<system-reminder>` 块开头——直接取首行会得到「<system-reminder>」这种伪会话名，故跳过取后面那条
 * 真问题；整会话都如此（如单轮 skill 会话）→ 回落短形，宁可用 id 也不编名字。
 *
 * 24 字按**码点**截断（不劈开代理对）；跨平台路径 basename（Windows 反斜杠 / POSIX 斜杠都认）。
 */

/** 无工作区记录时的显示名（守谷人冻结文案，UI 直接读，不再自己判空）。 */
export const UNKNOWN_WORKSPACE = '未知工作区'

/** label 分隔符（冻结：全角间隔点两侧各一空格）。 */
export const LABEL_SEPARATOR = ' · '

/** 会话名上限（首行前 24 字）。 */
export const SESSION_NAME_MAX = 24

/** session id 短形长度（末 8 位，回落名用）。 */
export const SESSION_ID_SHORT_LEN = 8

/** 详情接口里 question 的截断上限（原文不返回全文，见 routes.ts 负载控制）。 */
export const QUESTION_PREVIEW_MAX = 200

/** 按**码点**截断（不劈开代理对；emoji 不会产生半个字符）。 */
export function truncateChars(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

/** 工作区路径 basename（Windows/POSIX 分隔符都认；尾部斜杠忽略）；空/无 → 「未知工作区」。 */
export function workspaceNameOf(workspace: string): string {
  const trimmed = workspace.trim().replace(/[\\/]+$/, '')
  if (trimmed === '') return UNKNOWN_WORKSPACE
  const segments = trimmed.split(/[\\/]/)
  const last = segments[segments.length - 1] ?? ''
  return last === '' ? UNKNOWN_WORKSPACE : last
}

/**
 * 该 question 是否**够格当会话名**（冻结规则的那半句：去空白非空 ∧ 不以 '<' 开头）。
 * 兼作类型守卫：通过即保证是 string——派生与调用方（routes.ts 选第一条合规候选）共用这一处判据。
 */
export function acceptsAsNameQuestion(question: string | null | undefined): question is string {
  if (typeof question !== 'string') return false
  const text = question.trim()
  return text !== '' && !text.startsWith('<')
}

/** session id 短形（末 8 位；id 本身短于 8 位即整体）——**不是**会话名，只是回落显示用的标识。 */
export function sessionShortId(session: string): string {
  return session.length <= SESSION_ID_SHORT_LEN ? session : session.slice(-SESSION_ID_SHORT_LEN)
}

/**
 * 会话名派生：候选 question（该会话第一条合规问题；无 → null）+ 会话 id → 短名。
 * 多行取**首行**、再截 24 字；首行去空白后为空（理论上被 acceptsAsNameQuestion 挡住）同样回落。
 */
export function deriveSessionName(nameQuestion: string | null | undefined, session: string): string {
  if (acceptsAsNameQuestion(nameQuestion)) {
    const firstLine = nameQuestion.trim().split(/\r?\n/, 1)[0].trim()
    if (firstLine !== '') return truncateChars(firstLine, SESSION_NAME_MAX)
  }
  return sessionShortId(session)
}

/** label 三件套一次算齐（workspaceName / sessionName / label）——调用方不自己拼字符串。 */
export function composeLabel(
  workspace: string,
  nameQuestion: string | null | undefined,
  session: string,
): { workspaceName: string; sessionName: string; label: string } {
  const workspaceName = workspaceNameOf(workspace)
  const sessionName = deriveSessionName(nameQuestion, session)
  return { workspaceName, sessionName, label: workspaceName + LABEL_SEPARATOR + sessionName }
}
