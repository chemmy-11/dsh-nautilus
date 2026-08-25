/**
 * @dsh-external/dsh-xuegulin — fs.watch edit listener (main event source) + debounce merge.
 * Same-file 500ms window merges into one event (session_key = `path|windowStart` idempotent).
 * kind: path missing → deleted; not in meta → created; else modified.
 * Windows note: recursive watch events are lazy — periodic scan backstops (scan.ts).
 */
import { watch, type FSWatcher } from 'node:fs'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { XuegulinStore } from './store.js'
import { countChars } from './scan.js'

export interface WatchOptions {
  root: string
  exclude: string[]
  debounceMs: number
}

function isExcluded(rel: string, exclude: string[]): boolean {
  if (rel.startsWith('.') || rel === '') return true
  for (const x of exclude) {
    if (x === '') continue
    if (rel === x || rel.startsWith(x + '/') || rel.split('/').includes(x)) return true
  }
  return false
}

export function startVaultWatch(store: XuegulinStore, opts: WatchOptions): () => void {
  const { root, exclude, debounceMs } = opts
  const buckets = new Map<string, { timer: ReturnType<typeof setTimeout>; key: string }>()

  const settle = async (rel: string, windowKey: string): Promise<void> => {
    try {
      if (isExcluded(rel, exclude)) return
      if (!rel.toLowerCase().endsWith('.md')) return // 口径统一：仅 md 文件
      const full = join(root, rel)
      let kind: 'created' | 'modified' | 'deleted'
      let statInfo: Awaited<ReturnType<typeof stat>>
      try {
        statInfo = await stat(full)
        const meta = store.getMeta(rel)
        if (meta === undefined || meta.deleted === 1) {
          kind = 'created'
        } else if (Math.floor(statInfo.mtimeMs) !== meta.mtime) {
          kind = 'modified'
        } else {
          // mtime 未变化：忽略（过滤 watcher 启动脉冲/重扫噪声）
          return
        }
      } catch {
        kind = 'deleted'
      }
      const now = Date.now()
      const inserted = store.insertEdit({ ts: now, path: rel, kind, sessionKey: windowKey })
      if (inserted) {
        if (kind === 'created' || kind === 'modified') {
          try {
            const st2 = await stat(full)
            const content = await readFile(full, 'utf8')
            store.upsertMeta({ path: rel, mtime: Math.floor(st2.mtimeMs), size: st2.size, chars: countChars(content), ts: now })
          } catch { /* 竞争删除，忽略 */ }
        } else {
          store.markDeleted(rel, now)
        }
      }
    } catch (e) {
      console.error('[xuegulin] watch settle failed', rel, String(e))
    }
  }

  const watcher: FSWatcher = watch(root, { recursive: true }, (eventType, filename) => {
    if (filename === null || Buffer.isBuffer(filename)) return
    const rel = filename.toString().replaceAll('\\', '/')
    if (isExcluded(rel, exclude)) return
    if (!rel.toLowerCase().endsWith('.md')) return // 口径统一：仅 md 文件（与 scan/meta 一致）
    const existing = buckets.get(rel)
    if (existing !== undefined) clearTimeout(existing.timer)
    // R3：窗口键 = 该 burst 首个事件的时间戳（毫秒）——与「500ms 合并」注释语义一致；
    // 旧实现按秒取整：同一 wall-clock 秒内两个独立 burst 会撞 session_key，
    // 第二个编辑被 edit_event 幂等（UNIQUE）丢弃 → 丢数据。
    const key = existing?.key ?? `${rel}|${Date.now()}`
    const timer = setTimeout(() => {
      buckets.delete(rel)
      void settle(rel, key)
    }, debounceMs)
    buckets.set(rel, { timer, key })
  })

  watcher.on('error', (err) => {
    console.warn('[xuegulin] vault watch error (fallback to scan-only):', String(err))
  })

  return () => {
    for (const b of buckets.values()) clearTimeout(b.timer)
    buckets.clear()
    watcher.close()
  }
}
