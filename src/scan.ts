/**
 * @dsh-external/dsh-xuegulin — vault full scan (baseline + periodic calibration).
 * Maintains only vault_meta (edit counting is written solely by the watch channel —
 * semantics: edit = realtime perception, scan = baseline/calibration).
 * Zero writes into the vault; char count: strip whitespace, exclude frontmatter (`---` block).
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { XuegulinStore } from './store.js'

export interface ScanResult {
  scanned: number
  created: number
  updated: number
  removed: number
}

function isExcluded(rel: string, exclude: string[]): boolean {
  if (rel.startsWith('.') || rel === '') return true
  for (const x of exclude) {
    if (x === '') continue
    if (rel === x || rel.startsWith(x + '/') || rel.split('/').includes(x)) return true
  }
  return false
}

/** 字数：去空白字符（含换行/空格）+ 排除 frontmatter（首行 --- 到下一个 --- 行）。 */
export function countChars(text: string): number {
  let body = text
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end !== -1) body = body.slice(end + 4)
  }
  return body.replace(/\s+/g, '').length
}

export async function scanVault(store: XuegulinStore, root: string, exclude: string[]): Promise<ScanResult> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        if (isExcluded(rel + '/', exclude)) continue
        await walk(full)
      } else if (entry.name.toLowerCase().endsWith('.md') && !isExcluded(rel, exclude)) {
        files.push(rel)
      }
    }
  }
  await walk(root)

  const now = Date.now()
  let created = 0
  let updated = 0
  let scanned = 0
  for (const rel of files) {
    const full = join(root, rel)
    const st = await stat(full)
    const mtime = Math.floor(st.mtimeMs)
    // R4：mtime/size 未变 → 沿用旧 chars，跳过全文 readFile（vault 增大后 I/O 不放大）。
    // 仅当不存在/已删除/有变化才重读；复活路径（deleted→重新存在）仍走 upsertMeta 的 updated 分支。
    const prev = store.getMeta(rel)
    if (prev !== undefined && prev.deleted === 0 && prev.mtime === mtime && prev.size === st.size) {
      scanned++
      continue
    }
    const content = await readFile(full, 'utf8')
    const chars = countChars(content)
    const outcome = store.upsertMeta({ path: rel, mtime, size: st.size, chars, ts: now })
    if (outcome === 'created') created++
    else if (outcome === 'updated') updated++
    scanned++
  }

  // 删除校准：meta 中存在但本次未扫到的文件（非 exclude 的）
  const known = store.allPaths()
  let removed = 0
  for (const rel of known) {
    if (!files.includes(rel) && !isExcluded(rel, exclude)) {
      store.markDeleted(rel, now)
      removed++
    }
  }
  return { scanned, created, updated, removed }
}
