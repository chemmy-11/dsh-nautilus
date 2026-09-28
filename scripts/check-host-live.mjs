/**
 * @dsh-external/dsh-nautilus — 宿主装配活体回归（AL.7；可在 0.1.7 与 0.2.0 上同样运行）。
 *
 * **本脚本回答的问题**：本插件在**真实宿主组合路径**下到底装上了没有——而不是「HTTP 通不通」。
 * postmortem 0001 的教训是「178 个单测全绿仍线上崩溃」，本次 0.2.0 事故同族：`npm test` 全绿，
 * 但插件被宿主兼容门整层拒装。故判据必须是**外部世界的可观察事实**。
 *
 * ## 关键判据（务请照抄口径，否则会重演误判）
 *
 * 宿主（0.1.7-rc.2 与 0.2.0-rc.1 实测同形）的 `/api` 承载层以 `kind:'prefix', path:'/api'` 占住前缀路由，
 * host-webserver 的 `match()` **先查 exact 表、再查前缀表**，所以：
 *   · 我们注册过的 exact 路由 → **命中我们自己的 handler**（200 + 我们的 JSON 信封）；
 *   · 任何**未注册**的 `/api/*` → 落到承载层前缀 handler → 认证/信任门拒 → **裸文本 `unauthorized`**。
 *   （更正一条流传的说法：`@deepseek-ai/dsh-client-connection` **不是 0.2.0 新增**——0.1.7-rc.2 的 CLI 闭包里
 *    就装着同名同版本线的包，其 `/api` 兜底行为在两版上实测一致。本次事故与它无关。）
 *
 * 由此得出本脚本的硬判据与陷阱：
 *   ✅ **注册面探测必须打「本该已注册」的 exact 路径**（`/api/nautilus/m2/state`）：它 401 → 未装；它 200 → 已装。
 *   ⛔ **未知路径的 401 不具判别力**：`/api/nautilus/nope`、`/api/pet/nope` 在 0.2.0 下**同样** 401
 *      （兜底与插件无关）。2026-09-28 的误判正是把兜底 401 读成了「本插件路由未注册」。
 *   ⛔ **不能只看 200**：宿主前端兜底可能对任意路径回 200/HTML。故必须同时校验
 *      **响应体是我们的 JSON 信封**（含 `revision`），而不是任何 200。
 *
 * ## 用法（受管后台任务起探针实例，勿占用现有 GUI 端口）
 *   DSH_HOME=<隔离 home> node <dsh-0.2.0>/lib/bin.js <探针 profile> --port 3099 --no-open
 *   NAUTILUS_HOST_URL=http://127.0.0.1:3099 NAUTILUS_HOST_TOKEN=<启动打印的 token> \
 *   NAUTILUS_DB=<DSH_HOME>/nautilus/nautilus.db node scripts/check-host-live.mjs
 *
 * ## 退出码（诚实三态）
 *   0 = 全部断言通过（对已连上的宿主验证完成）
 *   1 = 有断言失败（插件未装配 / 组合缺失 / 采集停摆）
 *   2 = 环境未提供或不可达 → **未验证**，绝不冒充通过
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const BASE = (process.env.NAUTILUS_HOST_URL ?? 'http://127.0.0.1:3099').replace(/\/+$/, '')
const TOKEN = process.env.NAUTILUS_HOST_TOKEN ?? ''
const DB_PATH = process.env.NAUTILUS_DB ?? ''
const LIVENESS_MS = Number(process.env.NAUTILUS_LIVENESS_MS ?? '6000')
/** 插件包名（index 注入与模块图里出现的标识）。 */
const PKG = '@dsh-external/dsh-nautilus'
/** 本该已注册的 exact 路由（注册面判定点）。 */
const KNOWN_ROUTES = ['/api/nautilus/m2/state', '/api/nautilus/m2/alignments', '/api/nautilus/m2/sessions']

const failures = []
const notes = []
const skips = []
let checkCount = 0

function pass(label, detail) {
  checkCount += 1
  console.log('  ✔ ' + label + (detail === undefined ? '' : ' — ' + detail))
}
function fail(label, detail) {
  checkCount += 1
  failures.push(label + (detail === undefined ? '' : ' — ' + detail))
  console.log('  ✖ ' + label + (detail === undefined ? '' : ' — ' + detail))
}
/** 环境不足导致**未验证**：单独记账并响亮打印，绝不折进「通过」。 */
function skip(label, reason) {
  skips.push(label + ' — ' + reason)
  console.log('  ⚠ 未验证：' + label + ' — ' + reason)
}

/** 带会话 cookie 的取数（0.2.0 起 / 与 /api 都需要浏览器会话）。 */
let cookie = ''
async function get(path) {
  const headers = {}
  if (cookie !== '') headers.cookie = cookie
  const res = await fetch(BASE + path, { headers, redirect: 'manual' })
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  if (cookies.length > 0) cookie = cookies.map((c) => c.split(';')[0]).join('; ')
  const text = await res.text()
  return { status: res.status, type: res.headers.get('content-type') ?? '', text }
}

// ── 0. 环境可用性（不可达 = 未验证，不是通过） ────────────────────────────────

console.log('[check-host-live] 目标宿主 ' + BASE)
try {
  const probe = await fetch(BASE + '/api/nautilus/m2/state', { method: 'GET' })
  await probe.arrayBuffer()
} catch (error) {
  console.error('[check-host-live] 宿主不可达：' + String(error))
  console.error('[check-host-live] 结论：**未验证**（不是通过）。请先按文件头注释起受管探针实例，或用 DSH_RUNTIME_DIR 指到可测宿主。')
  process.exit(2)
}

// ── 1. 组合面：本该已注册的 exact 路由必须命中我们自己的响应 ────────────────────

console.log('1) 组合面（exact 路由是否真的注册了）')
for (const route of KNOWN_ROUTES) {
  const res = await get(route)
  if (res.status !== 200) {
    fail('GET ' + route + ' 未命中本插件 handler', 'status=' + res.status + ' body=' + JSON.stringify(res.text.slice(0, 80)))
    continue
  }
  if (!res.type.includes('application/json')) {
    fail('GET ' + route + ' 不是 JSON（可能是宿主前端兜底的 200）', 'content-type=' + res.type)
    continue
  }
  let parsed
  try {
    parsed = JSON.parse(res.text)
  } catch {
    fail('GET ' + route + ' 响应体不是合法 JSON', res.text.slice(0, 80))
    continue
  }
  if (typeof parsed.revision !== 'number') {
    fail('GET ' + route + ' 缺本插件信封字段 revision（疑似别的 200）', JSON.stringify(parsed).slice(0, 80))
    continue
  }
  pass('GET ' + route, '200 + 本插件 JSON 信封（revision=' + String(parsed.revision) + '）')
}

// ── 2. 兜底对照：未知路径的 401/404 不具判别力（仅记录，不作硬判据） ──────────────

console.log('2) 兜底对照（记录用；**不得**作为注册面判据）')
for (const route of ['/api/nautilus/nope', '/api/pet/nope']) {
  const res = await get(route)
  const isOurEnvelope = res.type.includes('application/json') && res.text.includes('"revision"')
  notes.push('GET ' + route + ' → ' + res.status + ' ' + JSON.stringify(res.text.slice(0, 40)))
  console.log('  · GET ' + route + ' → ' + res.status + ' ' + JSON.stringify(res.text.slice(0, 40)))
  if (isOurEnvelope) fail('未知路径竟返回了本插件信封（路由判据失效，需复核）', route)
}
console.log('  （两个路径都会落到宿主 /api 承载层的兜底门 → 裸文本 401，与本插件是否注册无关）')
console.log('  （实测：0.1.7-rc.2 与 0.2.0-rc.1 同一形态——`@deepseek-ai/dsh-client-connection` 在 0.1.7-rc.2 已存在，');
console.log('   故本判据的解释力不依赖宿主版本）')

// ── 3. 客户端半区组合：index.html 注入 + 模块图边 ──────────────────────────────

console.log('3) 客户端半区组合（index 注入 + client.js 模块图）')
{
  if (TOKEN !== '') {
    // 交换启动令牌 → 绑定 authority 的签名 cookie（GET / 之外的路径不接受 query token）
    await get('/?token=' + encodeURIComponent(TOKEN))
  }
  const res = await get('/')
  if (res.status === 401 && TOKEN === '') {
    // 无令牌 → 取不到认证页：**未验证**（响亮标注，绝不冒充通过）
    skip('index 注入与模块图未验证', 'GET / → 401，且未提供 NAUTILUS_HOST_TOKEN（0.2.0 起 index 需要启动令牌换 cookie）')
  } else if (res.status !== 200) {
    fail('GET / 未取到 index', 'status=' + res.status + ' body=' + JSON.stringify(res.text.slice(0, 80)))
  } else {
    if (res.text.includes(PKG)) pass('index 注入含本包标识 ' + PKG)
    else fail('index 注入不含本包标识（browser 半区未组合）', PKG)
    const revEdge = /nautilus\/client\.js(?:&|&amp;)rev=[0-9a-f]+/.test(res.text)
    if (revEdge) pass('模块图含 nautilus/client.js&rev=<hash>（client 半区已进组合图）')
    else fail('模块图缺 nautilus/client.js&rev=<hash>', 'client 半区未进组合图')
  }
}

// ── 4. 采集活性：max(ts) 前移（**不看行数**） ────────────────────────────────

console.log('4) 采集活性（max(ts) 是否前移）')
if (DB_PATH === '' || !existsSync(DB_PATH)) {
  if (DB_PATH === '') skip('采集活性未验证', '未提供 NAUTILUS_DB（库路径）')
  else fail('NAUTILUS_DB 指向的库不存在', DB_PATH)
} else {
  const readMax = (table, column) => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const row = db.prepare('SELECT MAX(' + column + ') AS mx, COUNT(*) AS c FROM ' + table).get()
      return { max: Number(row.mx ?? 0), count: Number(row.c ?? 0) }
    } finally {
      db.close()
    }
  }
  const before = { turnRead: readMax('turn_read', 'ts'), metric: readMax('metric_sample', 'ts') }
  await new Promise((resolve) => setTimeout(resolve, LIVENESS_MS))
  const after = { turnRead: readMax('turn_read', 'ts'), metric: readMax('metric_sample', 'ts') }
  const turnAdvanced = after.turnRead.max >= before.turnRead.max
  const metricAdvanced = after.metric.max > before.metric.max
  pass('metric_sample 活性（pulse 子插件在写）',
    'max(ts) ' + String(before.metric.max) + ' → ' + String(after.metric.max) + '，行数 ' + String(before.metric.count) + ' → ' + String(after.metric.count))
  if (after.metric.max <= before.metric.max) {
    fail('metric_sample max(ts) 未前移（pulse 采集停摆）', '间隔 ' + String(LIVENESS_MS) + 'ms 无新样本')
  }
  // turn_read 只在新轮次落库时前移；无新轮次不算失败，但必须如实标注「本轮未观测到前移」
  console.log('  · turn_read max(ts) ' + String(before.turnRead.max) + ' → ' + String(after.turnRead.max)
    + '（行数 ' + String(before.turnRead.count) + ' → ' + String(after.turnRead.count) + '）；'
    + (turnAdvanced && after.turnRead.max > before.turnRead.max ? '观察到前移' : '窗口内无新轮次（不作为失败判据）'))
  if (before.turnRead.count === 0 && after.turnRead.count === 0) {
    notes.push('turn_read 为空：本实例尚未有会话轮次，逐轮采集无法在此环境验证')
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

console.log('')
if (notes.length > 0) console.log('记录（不参与判定）：\n  ' + notes.join('\n  '))
if (skips.length > 0) {
  console.log('未验证（环境不足，**不折进通过**）：\n  ' + skips.join('\n  '))
}
if (failures.length > 0) {
  console.error('[check-host-live] 失败 ' + String(failures.length) + '/' + String(checkCount) + '：')
  for (const item of failures) console.error('  - ' + item)
  process.exit(1)
}
console.log('[check-host-live] 通过 ' + String(checkCount) + ' 项断言，未验证 ' + String(skips.length) + ' 项（目标宿主 ' + BASE + '）')
