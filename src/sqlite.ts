/**
 * @dsh-external/dsh-nautilus — SQLite 连接级 PRAGMA 的**单一定义处**（nautilus store 与 pulse store 共用）。
 *
 * 为什么需要（PS.0fix / 多端共享数据目录）：dsh-web 与 desktop 会把 `config.dataDir` 指向**同一个目录**
 * （各自 home 仍隔离）——于是**同一台机器上会有多个宿主进程同时写同一个库文件**。
 *   · `busy_timeout`：SQLite 默认 0——第二个写者**不等待**，直接抛 `SQLITE_BUSY`。上层若把这次异常
 *     收进日志（采集热路径正是如此），表现就是**静默丢写**（「丢了一轮」与「这轮没读数」在界面上无法区分）。
 *     给一个等待窗口，写者排队；遥测写入是毫秒级事务，几秒的窗口足够跨过对方的提交。
 *   · `journal_mode = WAL`：默认 delete 模式下写事务阻塞读者，跨进程并发度也差；WAL 下读不阻塞写、
 *     写不阻塞读，是多进程共享同一库文件的前提。
 *
 * 作用域提醒：`journal_mode` 是**写进库头的持久属性**（设一次，后续连接继承），`busy_timeout` 是
 * **连接级**（每条新连接都要设）——所以两者都收在这里，由两个 store 的构造处各调一次。
 *
 * 两个库**同文件不同表**（nautilus 表 + pulse 的 metric_sample/alert_event）：本模块被两侧共用，
 * 避免「一处改了、另一处忘了」的 PRAGMA 漂移（AGENTS §1-4 集中常量）。
 */

/** 写锁等待窗口（ms）。集中常量：两个库、所有连接共用同一个值。 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000

/** 施加 PRAGMA 所需的最小连接形态（node:sqlite 的 DatabaseSync 满足；测试替身也可满足）。 */
export interface PragmaCapable {
  exec(sql: string): void
}

/**
 * 对刚打开的连接施加统一 PRAGMA（幂等；重复调用无副作用）。
 * 只做 PRAGMA，不做建表/迁移——那些是各 store 自己的事。
 */
export function applySqlitePragmas(db: PragmaCapable): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = ' + SQLITE_BUSY_TIMEOUT_MS)
}
