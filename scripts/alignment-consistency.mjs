#!/usr/bin/env node
/**
 * @dsh-external/dsh-nautilus — AL.5 一致性读数（只读；决策 §5 进化闭环的「判据口」）。
 *
 * 三指标：完全一致率 · 相邻档一致率(|Δ|≤1) · 二次加权 κ（人工 vs 自评，对齐 1–5）。
 * 留出集：确定性切分 hash(session:turn) % N === 0（默认 N=5 → 20%），**只用于采纳/回滚判定**，
 *          绝不进提示词、绝不参与 rubric 修订——否则自我进化退化成自我确认（决策 §5 边界）。
 * 样本不足（默认 <50 对）时**只打印数字、不给结论**。
 *
 * 加入键约定（重要）：turn_annotation 以 (session, turn) 为键；selfcheck_record 以 (ext_ref, turn_ordinal) 为键。
 * 本脚本按 ext_ref === session、turn_ordinal === turn 连接。若两侧都有行而配对数 = 0，
 * 会大声提示去核对 ext_ref 语义（不静默给 0 分）。
 *
 * 用法：node scripts/alignment-consistency.mjs [--db <path>] [--holdout 5] [--min 50] [--json]
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function parseArgs(argv) {
  const out = { db: '', holdout: 5, min: 50, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i] || ''
    else if (a === '--holdout') out.holdout = Number(argv[++i] || '5')
    else if (a === '--min') out.min = Number(argv[++i] || '50')
    else if (a === '--json') out.json = true
    else { console.error('未知参数：' + a); process.exit(2) }
  }
  if (!Number.isInteger(out.holdout) || out.holdout < 2) { console.error('--holdout 必须是 >=2 的整数'); process.exit(2) }
  if (!Number.isFinite(out.min) || out.min < 1) { console.error('--min 必须是正数'); process.exit(2) }
  return out
}

/** 确定性分桶（FNV-1a 32 位；同 key 永远同桶——留出集可复现，不靠随机）。 */
function bucketOf(key) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}

function metrics(pairs) {
  const n = pairs.length
  if (n === 0) return { n: 0, exact: null, near: null, kappa: null, confusion: {} }
  let exact = 0, near = 0
  const confusion = {}
  for (const p of pairs) {
    if (p.human === p.self) exact += 1
    if (Math.abs(p.human - p.self) <= 1) near += 1
    const k = p.human + '->' + p.self
    confusion[k] = (confusion[k] || 0) + 1
  }
  // 二次加权 κ（K=5 档）
  const K = 5
  const obs = [], exp = []
  for (let i = 1; i <= K; i++) { obs.push([0,0,0,0,0]); exp.push([0,0,0,0,0]) }
  const hc = [0,0,0,0,0], sc = [0,0,0,0,0]
  for (const p of pairs) { obs[p.human-1][p.self-1] += 1; hc[p.human-1] += 1; sc[p.self-1] += 1 }
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) exp[i][j] = (hc[i] * sc[j]) / n
  let num = 0, den = 0
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
    const w = Math.pow(i - j, 2) / Math.pow(K - 1, 2)
    num += w * obs[i][j]; den += w * exp[i][j]
  }
  const kappa = den === 0 ? null : 1 - num / den
  return { n, exact: exact / n, near: near / n, kappa, confusion }
}

function fmt(x) { return x === null ? '—' : (x * 100).toFixed(1) + '%' }

function main() {
  const args = parseArgs(process.argv.slice(2))
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const dbFile = args.db !== '' ? args.db : join(home, 'nautilus', 'nautilus.db')
  if (!existsSync(dbFile)) { console.error('库不存在：' + dbFile); process.exit(2) }
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const human = db.prepare('SELECT session, turn, align FROM turn_annotation WHERE align IS NOT NULL AND schema_version >= 2').all()
  const self = db.prepare("SELECT ext_ref, turn_ordinal AS turn, align, rubric_version FROM selfcheck_record WHERE align IS NOT NULL AND source_kind = 'dsh_tool'").all()
  const selfMap = new Map()
  for (const s of self) selfMap.set(String(s.ext_ref) + ':' + String(s.turn), s)
  const pairs = [], holdout = [], evolution = [], legacySelf = []
  for (const s of self) if (s.rubric_version !== 'al-v1') legacySelf.push(s)
  for (const h of human) {
    const key = String(h.session) + ':' + String(h.turn)
    const s = selfMap.get(key)
    if (s === undefined) continue
    const p = { key, session: String(h.session), turn: Number(h.turn), human: Number(h.align), self: Number(s.align) }
    pairs.push(p)
    if (bucketOf(key) % args.holdout === 0) holdout.push(p); else evolution.push(p)
  }
  db.close()
  const all = metrics(pairs), ev = metrics(evolution), ho = metrics(holdout)
  const result = { db: dbFile, humanRows: human.length, selfRows: self.length, pairs: all.n, evolution: ev, holdout: ho, holdoutEvery: args.holdout, min: args.min }
  if (args.json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('# AL.5 对齐一致性读数（只读）')
  console.log('库：' + dbFile)
  console.log('人工行（align，schema_version>=2）：' + human.length + ' · 自评行（align, agent 通道）：' + self.length)
  if (all.n === 0 && human.length > 0 && self.length > 0) {
    console.log('')
    console.log('**配对数 = 0，但两侧都有行**：多半是加入键不一致——本脚本按 ext_ref === session 连接，')
    console.log('请核对 selfcheck_record.ext_ref 的实际语义（由调用方传入）。不给 0 分结论，先修键。')
  }
  console.log('')
  console.log('| 口径 | 对数 | 完全一致 | 相邻档一致 | 加权 κ |')
  console.log('|---|---|---|---|---|')
  console.log('| 全部配对 | ' + all.n + ' | ' + fmt(all.exact) + ' | ' + fmt(all.near) + ' | ' + (all.kappa === null ? '—' : all.kappa.toFixed(3)) + ' |')
  console.log('| 进化集 | ' + ev.n + ' | ' + fmt(ev.exact) + ' | ' + fmt(ev.near) + ' | ' + (ev.kappa === null ? '—' : ev.kappa.toFixed(3)) + ' |')
  console.log('| **留出集**（只用于采纳判定） | ' + ho.n + ' | ' + fmt(ho.exact) + ' | ' + fmt(ho.near) + ' | ' + (ho.kappa === null ? '—' : ho.kappa.toFixed(3)) + ' |')
  console.log('')
  console.log('留出集切分：hash(session:turn) % ' + args.holdout + ' === 0（确定性，可复现）')
  if (all.n < args.min) console.log('样本不足（' + all.n + ' < ' + args.min + '）：**只作观察，不得据此调整 rubric**。')
  if (legacySelf.length > 0) console.log('另有 ' + legacySelf.length + ' 条自评行 rubric_version ≠ al-v1（多为旧三行代际）——按 §9.3 代际不混算，已排除。')
  console.log('')
  console.log('结论纪律：rubric 修订候选只有**留出集**提升才可采纳，否则回滚；修订记录写 docs/2-dev/alignment-correction.md（只添不改）。')
}
main()