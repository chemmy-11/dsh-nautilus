/**
 * @dsh-external/dsh-nautilus — 迁移账本（AL.2；决策 §3.1，D-N1 方案 B 的落点）。
 *
 * 现状问题：`user_version` 是全库共享序列，但迁移散在各腿（nautilus 持 v2/v3/v5/v6/v7，
 * pulse 持 v4）。各自 `if (v < N)` 门控 → 「谁先写版本号谁说了算」，拆包时必然冲突。
 *
 * 账本把这件事变成**注册 + 顺序执行**：每条迁移声明 `{version, owner, name, apply}`，
 * 由本模块统一排序、跳过未注册号、逐条应用并**回读校验**（apply 必须把 user_version 推到它声明的值，
 * 否则响亮失败——静默不推进会让后续迁移被永久跳过，那是最难查的一类事故）。
 *
 * 行为不变：本模块只改写「谁来决定顺序」，不改任何迁移体。
 * 现状保留：`v1`（vault 观测腿，已删除）与 `v4`（pulse 的 metric_sample）在 nautilus 侧是**跳号**，
 * 账本把它们记进 `skipped` 并输出说明——不假装连续。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  /** 目标 `user_version`（须唯一、严格递增）。 */
  version: number
  /** 归属腿：nautilus / pulse / …（拆包后各腿注册自己的迁移）。 */
  owner: string
  /** 人读名（日志与诊断用）。 */
  name: string
  /** 应用迁移：自带事务、自己推 `PRAGMA user_version`；失败必须抛出。 */
  apply(): void
}

export interface AppliedMigration { version: number; owner: string; name: string }

export interface MigrationRunResult {
  from: number
  to: number
  applied: AppliedMigration[]
  /** 区间内没有注册迁移的版本号（由他腿负责 / 历史删除）。 */
  skipped: number[]
}

export interface RunMigrationsOptions {
  db: DatabaseSync
  list: readonly Migration[]
  /** 进度与跳号说明的输出口（默认 console.info，测试可注入收集）。 */
  log?: (msg: string) => void
}

/** 读 `PRAGMA user_version`。 */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  return Number(row?.user_version ?? 0)
}

/**
 * 顺序执行账本。**只应用 version > current 的已注册迁移**；区间内的未注册号记入 `skipped`。
 * 每条应用后回读校验：`user_version` 必须等于该条声明的版本，否则抛错（宁可挡住启动，也不静默跳步）。
 */
export function runMigrations(opts: RunMigrationsOptions): MigrationRunResult {
  const log = opts.log ?? ((m: string) => console.info(m))
  const from = readUserVersion(opts.db)
  const list = [...opts.list].sort((a, b) => a.version - b.version)

  // 重复版本号是装配错误：两条迁移争同一个槽位，后一条永远不会被应用
  const seen = new Set<number>()
  for (const m of list) {
    if (seen.has(m.version)) throw new Error('[migrations] 重复的迁移版本号 v' + m.version + '（' + m.owner + '/' + m.name + '）')
    seen.add(m.version)
  }

  const applied: AppliedMigration[] = []
  const skipped: number[] = []
  for (const m of list) {
    if (m.version <= from) continue
    for (let v = (applied.length === 0 ? from : applied[applied.length - 1].version) + 1; v < m.version; v++) {
      if (!seen.has(v) && !skipped.includes(v)) skipped.push(v)
    }
    m.apply()
    const now = readUserVersion(opts.db)
    if (now !== m.version) {
      throw new Error('[migrations] v' + m.version + '（' + m.owner + '/' + m.name + '）应用后 user_version = ' + now + '，与声明不符——迁移体必须自己推进版本号')
    }
    applied.push({ version: m.version, owner: m.owner, name: m.name })
    log('[migrations] v' + m.version + ' 应用：' + m.owner + ' · ' + m.name)
  }
  if (skipped.length > 0) {
    log('[migrations] 跳号 v' + skipped.join(', v') + '（未注册：由他腿负责或历史删除）')
  }
  const to = readUserVersion(opts.db)
  if (to !== from) log('[migrations] schema v' + from + ' → v' + to + '（应用 ' + applied.length + ' 条）')
  return { from, to, applied, skipped }
}
