/**
 * CI meta check for a DSH bundle plugin — dependency-free, string-level checks:
 *  - package.json declares dsh.bundle.patch and the patch file exists
 *  - the patch file references the package by name (name: <pkg>) — this is what
 *    makes `dsh plugin ... add` discover it as a bundle
 *  - exports["./client"] + dsh.client metadata present (host+client dual-half)
 * Exit non-zero on any failure so the workflow goes red.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const fail = (msg) => { console.error('meta-check FAIL: ' + msg); process.exit(1) }

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

// dsh.bundle.patch 必须声明且文件存在
if (!pkg.dsh?.bundle?.patch) fail('missing dsh.bundle.patch')
const patchFile = join(pkgRoot, pkg.dsh.bundle.patch)
if (!existsSync(patchFile)) fail(`patch file not found: ${pkg.dsh.bundle.patch}`)

// patch 必须按包名引用（name: <pkgName>）——否则 dsh plugin add 无法识别为 bundle
const patchText = readFileSync(patchFile, 'utf8')
const nameRef = new RegExp(`name:\\s*['"]?${escapeRegExp(pkg.name)}['"]?`, 'i')
if (!nameRef.test(patchText)) fail(`patch must reference the package by name (${pkg.name})`)

// 单入口契约：本包（带客户端半区）在 patch 里只能有 1 个 Loader 条目。
// 双条目会让 client-modules 组合期抛 "resolves from multiple active Loader sources"，
// 后果是 dsh web 启动失败（2026-09-13 实测）。多能力走子插件挂载（ctx.plugin）。
const entryNames = [...patchText.matchAll(/name:\s*['"]?([^'"\s#]+)['"]?/g)].map((m) => m[1])
const ownEntries = entryNames.filter((v) => v === pkg.name || v.startsWith(pkg.name + '/'))
if (ownEntries.length !== 1) {
  fail(`bundle patch 必须为本包插入恰好 1 个 Loader 条目，实得 ${ownEntries.length}（${ownEntries.join(', ')}）——同一包多条目会让 client-modules 组合失败、dsh web 起不来`)
}

// client 双半：exports["./client"] + dsh.client 元数据
if (!pkg.exports?.['./client']) fail('missing exports["./client"]')
if (!pkg.dsh?.client) fail('missing dsh.client metadata')

// files 必须包含 lib 与 patch（可安装性）；patch 值常带 ./ 前缀，归一化比较
const files = pkg.files ?? []
const stripDot = (s) => (s.startsWith('./') ? s.slice(2) : s)
if (!files.includes('lib')) fail('files must include lib')
if (!files.some((f) => stripDot(f) === stripDot(pkg.dsh.bundle.patch))) fail(`files must include ${pkg.dsh.bundle.patch}`)

console.log(`meta-check OK: bundle patch=${pkg.dsh.bundle.patch} references ${pkg.name}（单 Loader 条目）, client dual-half present, files include lib+patch`)

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
