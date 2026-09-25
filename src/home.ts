/**
 * @dsh-external/dsh-nautilus — 数据目录解析 + 改名迁移。
 *
 * 目录沿革：`xuegulin/xuegu.db`（原名）→ `nexus/nexus.db`（2026-08-31）→ **`nautilus/nautilus.db`**（2026-09-20 统一命名）。
 * 纪律（AGENTS.md 红线 3）：改名类迁移**只在新目录缺失时**执行，绝不覆盖既有数据；
 * 搬迁失败（旧实例仍持有句柄 → Windows EBUSY/EPERM）时**回落到旧路径继续用**，下次重启再迁——
 * 宁可暂时用旧目录，也不能让库打不开或数据分叉。
 *
 * **显式数据目录（`config.dataDir`；PS.0fix）**：多端（同机 dsh-web 与 desktop）各有各的 home，
 * 共享数据只共享**数据目录**、保留 home 隔离——两端把 `dataDir` 指向同一个目录即可（正式修复，
 * 取代「文件系统联接」那种旁路做法）。该分支**不跑**下面的历史改名迁移，理由写在 resolveDataDir 内。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface ResolvedDataDir {
  /** 数据目录（已确保迁移尝试完毕）。 */
  dir: string
  /** 库文件绝对路径。 */
  dbFile: string
  /** 是否因旧目录被占用而回落旧路径（UI/日志据此提示「重启后自动迁移」）。 */
  fellBack: boolean
}

/** 搬迁目录/文件；被占用或权限不足 → false（由调用方回落，不抛）。 */
function tryMove(from: string, to: string): boolean {
  try { renameSync(from, to); return true } catch { return false }
}

/**
 * 解析数据目录并尝试一次性改名迁移。**有副作用**（可能 rename 目录），但幂等且不覆盖。
 * @param dshHome - DSH 主目录（`$DSH_HOME` 或 `~/.dsh`）。
 * @param warn - 迁移回落时的告警出口（测试可注入）。
 * @param override - 显式数据目录（`config.dataDir`；`''` = 默认 `$DSH_HOME/nautilus`，行为不变）。
 */
export function resolveDataDir(dshHome: string, warn: (msg: string) => void = console.warn, override = ''): ResolvedDataDir {
  // 显式目录优先（PS.0fix 任务 A）：**不跑** xuegulin/nexus → nautilus 的历史迁移探测。
  // 为什么：那两步是**默认路径专属**的自动补救（回答「我原来的数据去哪了」），只在 home 下的默认位置
  // 才有意义。显式给的目录是它自己的真源——它不是从旧世代目录名搬来的，去那里探测旧名既没有语义，
  // 又可能在两端共享的目录里 rename 掉别人的东西（默认分支那套 rename 是破坏性的，绝不能外溢）。
  // 目录不存在就地建出（recursive）：配置里写了路径就不该再要求用户先手动 mkdir。
  if (override !== '') {
    mkdirSync(override, { recursive: true })
    return { dir: override, dbFile: join(override, 'nautilus.db'), fellBack: false }
  }

  const fresh = join(dshHome, 'nautilus')
  const freshDb = join(fresh, 'nautilus.db')
  if (existsSync(fresh)) return { dir: fresh, dbFile: freshDb, fellBack: false }

  // 上一代目录名：nexus（2026-08-31 起）——整体搬迁 + 库文件改名（都只在新缺失时）
  const prev = join(dshHome, 'nexus')
  if (existsSync(prev)) {
    if (tryMove(prev, fresh)) {
      const oldDb = join(fresh, 'nexus.db')
      if (existsSync(oldDb) && !existsSync(freshDb)) tryMove(oldDb, freshDb)
      return { dir: fresh, dbFile: freshDb, fellBack: false }
    }
    warn('[nautilus] 数据目录迁移被占用（还有旧实例在跑？）——本次沿用 ' + join(prev, 'nexus.db') + '；停掉其它实例后重启即自动迁移')
    return { dir: prev, dbFile: join(prev, 'nexus.db'), fellBack: true }
  }

  // 更早一代：xuegulin/xuegu.db——直接迁到新目录
  const legacy = join(dshHome, 'xuegulin')
  if (existsSync(legacy)) {
    if (tryMove(legacy, fresh)) {
      const oldDb = join(fresh, 'xuegu.db')
      if (existsSync(oldDb) && !existsSync(freshDb)) tryMove(oldDb, freshDb)
      return { dir: fresh, dbFile: freshDb, fellBack: false }
    }
    return { dir: legacy, dbFile: join(legacy, 'xuegu.db'), fellBack: true }
  }

  // 全新安装：目录由 openStore/openPulseStore 的 mkdirSync 创建
  return { dir: fresh, dbFile: freshDb, fellBack: false }
}
