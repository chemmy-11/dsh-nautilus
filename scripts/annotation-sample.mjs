#!/usr/bin/env node
/**
 * T 系列抽样队列生成器（会话侧，直连自家库；先例：p-measure.mjs）。
 * 口径：docs/2-dev/nautilus-dev-05-turn-annotation.md §4——
 *   kind=sample  → 池 = 有原文、未标注的轮次
 *   kind=recheck → 池 = 已标注且未复标的轮次（D-T4 噪声地板）
 * 分层 = 周桶 × 形态（analyze 检出，'none' 兜底），桶间轮转 + 桶内 seeded 洗牌（可复现）；
 * per-session 上限防单会话吞样。只写 annotation_sample（INSERT OR IGNORE 幂等），不碰其它表。
 *
 * 可测形态：核心逻辑为导出纯函数（buildPool / selectFromPool / nextBatchId），
 * CLI 只在**直接运行本文件**时执行——测试直接 import，不 spawn 子进程。
 * 用法：node scripts/annotation-sample.mjs --size=50 [--per-session=5] [--seed=7]
 *        [--kind=sample|recheck] [--root=pointed|all] [--db=<file>] [--dry-run]
 */
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { analyze } from '../lib/nexus/analysis.js'

/** 确定性 PRNG（mulberry32）。 */
export function mulberry32(s) {
  let a = s >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function shuffle(arr, rnd) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}

/** 组池：points（turnReadsSince 结果）→ 候选（session/turn/bucket/strata）。store 需 lfield/getTurnText/annotatedTurnKeys。 */
export function buildPool(store, { kind = 'sample', rootMode = 'pointed', points } = {}) {
  const root = rootMode === 'all' ? undefined : (store.lfieldRoot() || undefined)
  const pts = points ?? store.turnReadsSince(0, root)
  const shapes = new Map(analyze(pts).map((r) => [r.session, r.shape ?? 'none']))
  const { annotated, rechecked } = store.annotatedTurnKeys()
  const pool = []
  for (const p of pts) {
    const key = `${p.session}:${p.turn}`
    if (kind === 'sample') {
      if (annotated.has(key)) continue
      const t = store.getTurnText(p.session, p.turn)
      if (t === null || (t.userText === '' && t.assistantText === '')) continue
    } else {
      if (!annotated.has(key) || rechecked.has(key)) continue
    }
    const week = Math.floor(p.ts / (7 * 86400000))
    const shape = shapes.get(p.session) ?? 'none'
    pool.push({ session: p.session, turn: p.turn, bucket: `w=${week};h=${shape}`, strata: `s=${p.session.slice(-4)};w=${week};h=${shape}` })
  }
  return { pool, root }
}

/** 桶间轮转 + per-session 上限 + seeded 洗牌；池长度并入种子（同数据可复现，数据变则样变）。 */
export function selectFromPool(pool, { size = 50, perSession = 5, seed = 7 } = {}) {
  const buckets = new Map()
  for (const c of pool) {
    const q = buckets.get(c.bucket)
    if (q === undefined) buckets.set(c.bucket, [c])
    else q.push(c)
  }
  const rnd = mulberry32(seed + pool.length)
  const queues = [...buckets.keys()].sort().map((k) => shuffle(buckets.get(k), rnd))
  const picks = []
  const perSess = new Map()
  outer: for (let i = 0; ; i++) {
    let any = false
    for (const q of queues) {
      const c = q[i]
      if (c === undefined) continue
      any = true
      const n = perSess.get(c.session) ?? 0
      if (n >= perSession) continue
      perSess.set(c.session, n + 1)
      picks.push(c)
      if (picks.length >= size) break outer
    }
    if (!any) break
  }
  return picks
}

/** batch_id：`T-<UTC日>-<kind>-<序号>`（同库同日同 kind 递增；dbFile 直查，不污染 store API）。 */
export function nextBatchId(dbFile, kind) {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const prefix = `T-${day}-${kind}-`
  const raw = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const existing = raw.prepare('SELECT DISTINCT batch_id FROM annotation_sample WHERE batch_id LIKE ?').all(prefix + '%').length
    return prefix + String(existing + 1).padStart(2, '0')
  } finally { raw.close() }
}

// ── CLI（仅直接运行时执行）────────────────────────────────────────────────────
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { resolveDataDir } = await import('../lib/home.js')
  const { openStore } = await import('../lib/store.js')
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]
  }))
  const size = Number(args.size ?? 50)
  const perSession = Number(args['per-session'] ?? 5)
  const seed = Number(args.seed ?? 7)
  const kind = args.kind ?? 'sample'
  const rootMode = args.root ?? 'pointed'
  const dryRun = args['dry-run'] === true
  if (!Number.isInteger(size) || size < 1) { console.error('--size 必须为正整数'); process.exit(2) }
  if (!['sample', 'recheck'].includes(kind)) { console.error('--kind ∈ sample|recheck'); process.exit(2) }
  const dbFile = args.db || resolveDataDir(process.env.DSH_HOME || join(homedir(), '.dsh')).dbFile
  const store = openStore(dbFile)
  try {
    const { pool } = buildPool(store, { kind, rootMode })
    const picks = selectFromPool(pool, { size, perSession, seed })
    const batchId = nextBatchId(dbFile, kind)
    console.log(`池=${pool.length}（kind=${kind} root=${rootMode}）→ 抽=${picks.length} batch=${batchId} seed=${seed}`)
    for (const c of picks) console.log(`  ${c.session} · turn ${c.turn} · ${c.strata}`)
    if (dryRun) { console.log('（dry-run：未入队）'); process.exitCode = 0 } 
    else {
      const inserted = store.insertSampleBatch(picks.map((c) => ({ batchId, session: c.session, turn: c.turn, kind, strata: c.strata })))
      console.log(`入队 ${inserted} 行（PK 冲突跳过 ${picks.length - inserted}）`)
    }
  } finally {
    store.close()
  }
}
