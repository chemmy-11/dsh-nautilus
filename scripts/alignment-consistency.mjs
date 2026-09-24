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
 * **口径单点（AL.4b 起）**：三指标、留出集分桶与样本不足阈值只在 `src/nexus/consistency.ts` 实现一份，
 * 本脚本 import 构建产物 `lib/nexus/consistency.js`——路由 `GET /api/nautilus/m2/alignments` 用的是同一份
 * （v2 起路由也出 `holdout`：同一批行 + 同一份 `splitHoldout`，同库必同数）。
 * 本文件只留「读库 + 取哪几行 + 怎么印」；禁止在此再写一套指标（同一样本两个 κ = 两套口径，本仓库明令禁止）。
 *
 * 取行口径（v2）与路由 self[] 逐字对齐：`source_kind='dsh_tool'` ∧ `align IS NOT NULL` ∧ `rubric_version = RUBRIC_VERSION`；
 * 非当期代际行只计数（与路由 coverage.legacySelfRows 同判据），不参与配对。
 *
 * 用法：node scripts/alignment-consistency.mjs [--db <path>] [--holdout N=5] [--min N=50] [--json]
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { metrics, pairAlignments, splitHoldout, HOLDOUT_EVERY, MIN_PAIRS } from '../lib/nexus/consistency.js'
import { RUBRIC_VERSION } from '../lib/nexus/selfcheck-ingest.js'

function parseArgs(argv) {
  // 默认值取自共享模块（阈值与切分除数都只有一份——UI/脚本/路由不许各写常量）
  const out = { db: '', holdout: HOLDOUT_EVERY, min: MIN_PAIRS, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i] || ''
    else if (a === '--holdout') out.holdout = Number(argv[++i] || String(HOLDOUT_EVERY))
    else if (a === '--min') out.min = Number(argv[++i] || String(MIN_PAIRS))
    else if (a === '--json') out.json = true
    else { console.error('未知参数：' + a); process.exit(2) }
  }
  if (!Number.isInteger(out.holdout) || out.holdout < 2) { console.error('--holdout 必须是 >=2 的整数'); process.exit(2) }
  if (!Number.isFinite(out.min) || out.min < 1) { console.error('--min 必须是正数'); process.exit(2) }
  return out
}

function fmt(x) { return x === null ? '—' : (x * 100).toFixed(1) + '%' }

function main() {
  const args = parseArgs(process.argv.slice(2))
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const dbFile = args.db !== '' ? args.db : join(home, 'nautilus', 'nautilus.db')
  if (!existsSync(dbFile)) { console.error('库不存在：' + dbFile); process.exit(2) }
  const db = new DatabaseSync(dbFile, { readOnly: true })
  // 读库（SQL 列是 snake_case）→ 共享模块的领域形状（camelCase）：**这层映射必须显式写**，
  // 否则 pairAlignments 收到 ext_ref/turn_ordinal 取不到值、静默配出 0 对（实测踩到：两侧各 4 行却配对 0）。
  const human = db.prepare('SELECT session, turn, align FROM turn_annotation WHERE align IS NOT NULL AND schema_version >= 2').all()
  // 与路由 self[] 同一批行（含 rubric_version 过滤）——否则同一库上脚本与路由会拿不同的行去配对
  const self = db.prepare("SELECT ext_ref, turn_ordinal, align, rubric_version FROM selfcheck_record WHERE align IS NOT NULL AND source_kind = 'dsh_tool' AND rubric_version = ?").all(RUBRIC_VERSION)
    .map((r) => ({ extRef: String(r.ext_ref), turnOrdinal: Number(r.turn_ordinal), align: r.align === null ? null : Number(r.align), rubricVersion: r.rubric_version === null ? null : String(r.rubric_version) }))
  // 非当期代际行数（判据与路由 coverage.legacySelfRows 逐字相同）：只计数、不配对
  const legacySelfRows = Number(db.prepare(
    'SELECT COUNT(*) AS n FROM selfcheck_record WHERE align IS NULL OR rubric_version IS NULL OR rubric_version <> ?',
  ).get(RUBRIC_VERSION).n)
  // 配对键 = (session, turn) ↔ (ext_ref, turn_ordinal)；切分确定性（同 key 永远同侧）——口径都在共享模块里
  const pairs = pairAlignments(human, self)
  const { holdout, evolution } = splitHoldout(pairs, args.holdout)
  db.close()
  const all = metrics(pairs), ev = metrics(evolution), ho = metrics(holdout)
  const result = { db: dbFile, humanRows: human.length, selfRows: self.length, legacySelfRows, pairs: all.n, evolution: ev, holdout: ho, holdoutEvery: args.holdout, min: args.min }
  if (args.json) { console.log(JSON.stringify(result, null, 2)); return }
  console.log('# AL.5 对齐一致性读数（只读）')
  console.log('库：' + dbFile)
  console.log('人工行（align，schema_version>=2）：' + human.length + ' · 自评行（align, agent 通道, rubric ' + RUBRIC_VERSION + '）：' + self.length)
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
  if (legacySelfRows > 0) console.log('另有 ' + legacySelfRows + ' 条自评行非当期代际（align 为空或 rubric_version ≠ ' + RUBRIC_VERSION + '，多为旧三行）——按 §9.3 代际不混算，已排除。')
  console.log('')
  console.log('结论纪律：rubric 修订候选只有**留出集**提升才可采纳，否则回滚；修订记录写 docs/2-dev/alignment-correction.md（只添不改）。')
}
main()