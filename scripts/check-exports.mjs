/**
 * @dsh-external/dsh-nexus — 导出形态守卫（postmortem 0001 / AGENTS.md §2）。
 *
 * 规则：**命名空间插件**（同文件里有 `export const inject` 或 `export function apply`
 * 这类命名导出）**不得再写 `export default`**——Cordis Loader 的 `unwrapExports`
 * 优先取 `.default`，会把同级的 inject / name / Config 一起丢掉，症状是插件加载即抛
 * `cannot get property "X" without inject`（官方 178 个单测全绿仍线上崩溃）。
 *
 * 对象形态 / 类形态插件（只写 `export default { name, inject, apply }`，无同级命名导出）
 * **合法**，不判违规——故命名导出的判据只取 inject / apply，不含 Config（对象形态常伴
 * `export interface Config`）。
 *
 * 零依赖（node:fs），纯函数 `checkExports(root)` 可单测；CLI 违规即 exit 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** 命名空间插件的标志：命名导出的 inject / apply。 */
const NAMESPACE_EXPORT = /^\s*export\s+(?:const|function|class)\s+(?:inject|apply)\b/m
/** 默认导出（含 `export default apply` 这种把命名导出再默认一遍的写法）。 */
const DEFAULT_EXPORT = /^\s*export\s+default\b/m

function walk (dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

/** 返回违规描述数组（空数组 = 通过）。 */
export function checkExports (root = SRC) {
  const violations = []
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    if (DEFAULT_EXPORT.test(text) && NAMESPACE_EXPORT.test(text)) {
      violations.push(relative(root, file) + ': 命名空间插件不得同时写 export default（Loader 会丢 inject —— postmortem 0001）')
    }
  }
  return violations
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = checkExports()
  if (violations.length > 0) {
    console.error('check-exports: 违规\n' + violations.map((v) => '  - ' + v).join('\n'))
    process.exit(1)
  }
  console.log('check-exports: OK（命名空间插件无 default 导出混用）')
}
