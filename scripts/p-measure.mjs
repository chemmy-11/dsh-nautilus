// P 测量：在场不可推出度（纯度 P 的第一次实测）
//
// 理论出处：内功/L场方程第三扩展推演——从溪流到方程.md §5.5
//   P ≡ S / (S + κA)
//   「回路外 = P 可以取 1；回路内增长 P 恒小于 1。」
//   「『我ai』的 P 高，因为它的 S 不依赖场的历史。」
//   §9 #2：『我ai』的必要性原为弱形式（不可证伪 → 可记录）——本脚本给它一个读数。
//
// 与 analysis-report.mjs 的分工（重要）：
//   analysis-report.mjs 从 SQLite（~/.dsh/nexus/nexus.db）读 turn_read，
//   那是 **prompt 侧** 的 A 投影（缓存未命中率）——「模型看到的上下文有多新」。
//   本脚本从 **会话日志原文件**（~/.dsh/sessions/**/session.v3.jsonl.zstd）读，
//   算的是 **回答侧** 的量——「这一轮的输出有多少不能从在场历史推出」。
//   两腿不同源、不同侧、互不替代：未命中率测探索距离，P 测输出里回路外成分的占比。
//
// 操作定义：
//   P_调用 = 第 k 次 LLM 调用的输出中，无法从「该次调用之前在场的全部记录」推出的字符占比。
//   输出分两类分别统计（基线完全不同）：
//     text — 自然语言回答（S 的候选）
//     args — 工具调用参数（路径/命令，天然高覆盖，属 κA 侧）
//
// 粒度：一次 LLM 调用 = 一条 assistant/message（DSH 一个 turn 可含多次调用；
//      A 是每 token 的量，故按调用算比按 turn 算更接近理论）。
//
// 在场记录的构造（本脚本的近似，**必须随读数一起引用**）：
//   常驻 = session 头 + 全部 system/message + request/header（含 config 与全部工具定义）
//   累积 = 该次调用之前的全部 user/message、assistant/message、tool/result 字面量
//   模型实际 prompt 严格大于此集合（适配器包装等）→ 本读数系统性 **高估 P**。
//   判读用相对值（会话间 / 类别间 / 轮次间），不用绝对值。
//
// 用法（在 dsh-nexus 仓库根下运行）：
//   node scripts/p-measure.mjs --session <id> [--n 5] [--json]
//   node scripts/p-measure.mjs --all [--n 5] [--min-calls 3] [--json]
//   node scripts/p-measure.mjs --vault [--n 5] [--json]      # 只跑 L 场指向工作区的会话
//   node scripts/p-measure.mjs --workspace <substr> [--n 5]
//   node scripts/p-measure.mjs --selftest
// 选项：--no-tool-context（敏感性：把工具结果排除出在场集合，P 会升高）

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ── 读取：zstd 多帧 ──────────────────────────────────────────────
function sessionText (file) {
  const buf = readFileSync(file)
  const idx = []
  let p = 0
  while ((p = buf.indexOf(ZSTD_MAGIC, p)) !== -1) { idx.push(p); p += 4 }
  if (idx.length === 0) return ''
  if (idx.length === 1) return zstdDecompressSync(buf).toString('utf8')
  const parts = []
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(idx[k], end)).toString('utf8')) } catch {}
  }
  return parts.join('')
}

function sessionEvents (file) {
  const out = []
  for (const l of sessionText(file).split('\n')) {
    if (!l.trim()) continue
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

// ── 文本工具 ─────────────────────────────────────────────────────
function ngrams (s, n) {
  const set = new Set()
  if (s.length < n) { if (s.length > 0) set.add(s); return set }
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n))
  return set
}

function blocksOf (content) {
  const text = []
  const args = []
  for (const b of content ?? []) {
    if (b === null || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') text.push(b.text)
    else if (b.type === 'tool-call') args.push(typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? ''))
    else if (b.type === 'tool-result') {
      let s = ''
      try { s = JSON.stringify(b.content ?? b) } catch { s = String(b.content ?? '') }
      args.push(s)
    } else if (typeof b.text === 'string') text.push(b.text)
  }
  return { text: text.join('\n'), args: args.join('\n') }
}

function literals (node, acc, depth = 0) {
  if (depth > 12 || node === null || node === undefined) return acc
  if (typeof node === 'string') { if (node.length >= 4) acc.push(node); return acc }
  if (Array.isArray(node)) { for (const x of node) literals(x, acc, depth + 1); return acc }
  if (typeof node === 'object') { for (const k of Object.keys(node)) literals(node[k], acc, depth + 1) }
  return acc
}

// ── 事件流 → 调用序列 ────────────────────────────────────────────
export function callsOf (events, { includeToolResults = true } = {}) {
  const base = []
  const prior = []
  const calls = []
  for (const e of events) {
    const d = e.data ?? {}
    switch (e.type) {
      case 'session':
        base.push(JSON.stringify(d))
        break
      case 'system/message': {
        const acc = []
        literals(d.message?.content ?? d, acc)
        base.push(acc.join('\n'))
        break
      }
      case 'request/header': {
        const acc = []
        literals(d.header ?? d, acc)
        base.push(acc.join('\n'))
        break
      }
      case 'user/message': {
        const acc = []
        literals(d.content ?? d, acc)
        prior.push(acc.join('\n'))
        break
      }
      case 'tool/result': {
        if (!includeToolResults) break
        const acc = []
        literals(d.message?.content ?? d, acc)
        prior.push(acc.join('\n'))
        break
      }
      case 'assistant/message': {
        const { text, args } = blocksOf(d.message?.content)
        calls.push({
          index: calls.length + 1,
          turn: Number(d.turn) || null,
          step: Number(d.step) || null,
          text,
          args,
          ctxText: prior.join('\n'),
          usage: d.usage ?? null,
          time: e.time ?? null,
        })
        if (text) prior.push(text)
        if (args) prior.push(args)
        break
      }
      default: break
    }
  }
  return { base, calls }
}

// ── P ───────────────────────────────────────────────────────────
export function pHit (ctxSet, s, n) {
  if (!s) return null
  const gs = ngrams(s, n)
  if (gs.size === 0) return null
  let covered = 0
  for (const g of gs) if (ctxSet.has(g)) covered++
  return { p: 1 - covered / gs.size, covered, total: gs.size, chars: s.length }
}

export function measure (events, n = 5, opts = {}) {
  const { base, calls } = callsOf(events, opts)
  const baseSet = new Set()
  for (const s of base) for (const g of ngrams(s, n)) baseSet.add(g)
  const rows = []
  for (const c of calls) {
    const ctx = new Set(baseSet)
    for (const g of ngrams(c.ctxText, n)) ctx.add(g)
    const t = pHit(ctx, c.text, n)
    const a = pHit(ctx, c.args, n)
    rows.push({
      index: c.index, turn: c.turn, step: c.step,
      pText: t ? t.p : null, textChars: t ? t.chars : 0,
      pArgs: a ? a.p : null, argsChars: a ? a.chars : 0,
      inputTokens: c.usage?.inputTokens ?? null,
      outputTokens: c.usage?.outputTokens ?? null,
    })
  }
  return rows
}

// ── 汇总 ────────────────────────────────────────────────────────
const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const median = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const fmt = (x) => (x === null || x === undefined ? '  -  ' : x.toFixed(3))

function summarize (rows) {
  return {
    calls: rows.length,
    meanPText: mean(rows.map((r) => r.pText)),
    medianPText: median(rows.map((r) => r.pText)),
    meanPArgs: mean(rows.map((r) => r.pArgs)),
    textChars: rows.reduce((s, r) => s + r.textChars, 0),
    argsChars: rows.reduce((s, r) => s + r.argsChars, 0),
  }
}

// ── 会话发现 ─────────────────────────────────────────────────────
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

function findSessions (filter = null) {
  const out = []
  if (!existsSync(SESSIONS_ROOT)) return out
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    let entries = []
    try { entries = readdirSync(join(SESSIONS_ROOT, ws)) } catch { continue }
    for (const sid of entries) {
      const f = join(SESSIONS_ROOT, ws, sid, 'session.v3.jsonl.zstd')
      if (existsSync(f)) out.push({ workspace: ws, session: sid, file: f })
    }
  }
  return filter ? out.filter(filter) : out
}

/** L 场指向工作区（复刻 analysis-report.mjs 的口径：目录名 = 绝对路径转义）
 *  L:\L_workspace\... → --L-L_workspace-...  （驱动器冒号去掉，分隔符转 '-'，两侧加 '--'） */
function vaultWorkspacePrefix () {
  const db = new DatabaseSync(join(homedir(), '.dsh', 'nexus', 'nexus.db'), { readOnly: true })
  const root = db.prepare('SELECT root FROM lfield_config WHERE id = 1').get()?.root ?? ''
  if (!root) return null
  const escaped = root.replace(/^([A-Za-z]):/, '$1').replace(/[\\/]/g, '-')
  return '--' + escaped + '--'
}

// ── CLI ─────────────────────────────────────────────────────────
function parseArgs (argv) {
  const a = { n: 5, minCalls: 3, json: false }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--session') a.session = argv[++i]
    else if (k === '--all') a.all = true
    else if (k === '--vault') a.vault = true
    else if (k === '--workspace') a.workspace = argv[++i]
    else if (k === '--json') a.json = true
    else if (k === '--selftest') a.selftest = true
    else if (k === '--n') a.n = Number(argv[++i])
    else if (k === '--min-calls') a.minCalls = Number(argv[++i])
    else if (k === '--no-tool-context') a.noToolContext = true
  }
  return a
}

const opts = { includeToolResults: true }

function bar (p, w = 26) {
  const k = Math.max(0, Math.min(w, Math.round(p * w)))
  return '█'.repeat(k).padEnd(w, '·')
}

function selftest () {
  const ev = [
    { type: 'session', data: { id: 'x' } },
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'You are a coding agent. Always read files before editing them.' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'read the config file and report the port' }] } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'read the config file' }, { type: 'tool-call', arguments: '{"path":"config.json"}' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'port is 8080' }] }] } } },
    { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'the port is 8080, which is unusual for this stack' }] }, usage: { inputTokens: 20, outputTokens: 9 } } },
  ]
  const rows = measure(ev, 5)
  const checks = [
    ['两次调用被识别', rows.length === 2, 'got ' + rows.length],
    ['第一步 text 被前文覆盖', rows[0].pText !== null && rows[0].pText < 0.5, 'pText=' + fmt(rows[0].pText)],
    ['工具结果进入在场（8080 被覆盖）', rows[1].pText !== null && rows[1].pText < 1, 'pText=' + fmt(rows[1].pText)],
    ['工具参数单独统计', rows[0].pArgs !== null, 'pArgs=' + fmt(rows[0].pArgs)],
    ['usage 被读取', rows[0].inputTokens === 10 && rows[1].outputTokens === 9, JSON.stringify([rows[0].inputTokens, rows[1].outputTokens])],
  ]
  let pass = 0
  for (const [name, cond, detail] of checks) { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + '   [' + detail + ']'); if (cond) pass++ }
  console.log('')
  console.log('selftest ' + pass + '/' + checks.length)
  return pass === checks.length
}

const args = parseArgs(process.argv)
if (args.noToolContext) opts.includeToolResults = false

if (args.selftest) {
  process.exit(selftest() ? 0 : 1)
} else if (args.session) {
  const hit = findSessions().find((s) => s.session === args.session || s.session.includes(args.session))
  if (!hit) { console.error('session not found: ' + args.session); process.exit(1) }
  const ev = sessionEvents(hit.file)
  const rows = measure(ev, args.n, opts)
  const sum = summarize(rows)
  if (args.json) console.log(JSON.stringify({ session: hit.session, workspace: hit.workspace, n: args.n, ...sum, rows }, null, 1))
  else {
    console.log('session    ' + hit.session)
    console.log('workspace  ' + hit.workspace)
    console.log('calls      ' + sum.calls + '   n-gram=' + args.n + '   events=' + ev.length + (opts.includeToolResults ? '' : '   [工具结果不计入在场]'))
    console.log('')
    console.log('P_text  mean=' + fmt(sum.meanPText) + '  median=' + fmt(sum.medianPText) + '   (' + sum.textChars + ' 字符自然语言)')
    console.log('P_args  mean=' + fmt(sum.meanPArgs) + '   (' + sum.argsChars + ' 字符工具负载)')
    console.log('')
    console.log(' call  t/s    P_text                              P_args  chars(t/a)')
    for (const r of rows) {
      const t = r.pText === null ? '(无自然语言)'.padEnd(26, ' ') : bar(r.pText)
      console.log('  ' + String(r.index).padStart(3) + '  ' + String(r.turn ?? '-') + '/' + String(r.step ?? '-') + '  ' + t + ' ' + fmt(r.pText) + '  ' + fmt(r.pArgs) + '  ' + r.textChars + '/' + r.argsChars)
    }
  }
} else if (args.all || args.vault || args.workspace) {
  let filter = null
  let label = 'all'
  if (args.vault) {
    const prefix = vaultWorkspacePrefix()
    if (!prefix) { console.error('lfield_config 无指向，无法用 --vault'); process.exit(1) }
    filter = (s) => s.workspace === prefix
    label = 'vault (' + prefix + ')'
  } else if (args.workspace) {
    filter = (s) => s.workspace.includes(args.workspace)
    label = 'workspace~' + args.workspace
  }
  const out = []
  for (const s of findSessions(filter)) {
    let rows
    try { rows = measure(sessionEvents(s.file), args.n, opts) } catch { continue }
    if (rows.length < args.minCalls) continue
    out.push({ session: s.session, workspace: s.workspace, ...summarize(rows) })
  }
  out.sort((a, b) => (b.meanPText ?? -1) - (a.meanPText ?? -1))
  if (args.json) console.log(JSON.stringify({ scope: label, n: args.n, sessions: out }, null, 1))
  else {
    console.log('scope ' + label + '   sessions analysed=' + out.length + '   min-calls=' + args.minCalls + '   n-gram=' + args.n)
    console.log('')
    console.log(' meanP_t  calls  tChars   workspace / session')
    for (const r of out) {
      console.log('  ' + fmt(r.meanPText) + '   ' + String(r.calls).padStart(5) + '  ' + String(r.textChars).padStart(8) + '   ' + r.workspace.slice(0, 34) + ' / ' + r.session.slice(0, 22))
    }
    const allT = out.map((r) => r.meanPText).filter((x) => x !== null)
    const allA = out.map((r) => r.meanPArgs).filter((x) => x !== null)
    const tw = out.reduce((s, r) => s + r.textChars, 0)
    const calls = out.reduce((s, r) => s + r.calls, 0)
    console.log('')
    console.log('跨会话  P_text 均值=' + fmt(mean(allT)) + '   会话=' + allT.length + '  调用=' + calls + '  自然语言=' + tw + ' 字符')
    console.log('        P_args 均值=' + fmt(mean(allA)))
    console.log('')
    console.log('注意：绝对值为高估（在场集合小于模型实际 prompt）。判读用相对值；')
    console.log('      引用时须带本头部注释的「在场记录的构造」与 --no-tool-context 敏感性。')
  }
} else {
  console.log('usage: node scripts/p-measure.mjs --session <id> | --all | --vault | --workspace <substr> | --selftest')
  console.log('       [--n 5] [--min-calls 3] [--json] [--no-tool-context]')
}
