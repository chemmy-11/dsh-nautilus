/**
 * @dsh-external/dsh-xuegu-observation — Node 构建入口（prepare/build 共用）。
 * 纯 Node 实现（不依赖 bash 环境）：DSH_CHECKOUT 探测 + junction 依赖链接 + tsc + esbuild client。
 * 依赖清单按 M1 实际 import 裁剪（cordis / schemastery / dsh-host-webserver）。
 */
import { rmSync, mkdirSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) // scripts/
const pkgRoot = dirname(root)

function detectCheckout() {
  const env = process.env.DSH_CHECKOUT
  if (env && existsSync(join(env, 'packages'))) return env
  const home = homedir()
  for (const c of ['dsh-harness', 'dsh', join('.dsh', 'dsh-harness')]) {
    const p = join(home, c)
    if (existsSync(join(p, 'packages'))) return p
  }
  return ''
}

const checkout = detectCheckout()
if (!checkout) {
  console.error('prepare: cannot locate the dsh checkout (set DSH_CHECKOUT or $HOME/dsh-harness)')
  process.exit(1)
}
console.log('=== Linking build dependencies (checkout: ' + checkout + ') ===')

function linkPkg(name, target) {
  const link = join(pkgRoot, 'node_modules', name)
  const t = resolve(checkout, target)
  if (!existsSync(t)) {
    console.error(`prepare: dependency target missing: ${t}`)
    process.exit(1)
  }
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(t, link, platform() === 'win32' ? 'junction' : 'dir')
}

mkdirSync(join(pkgRoot, 'node_modules', '@deepseek-ai'), { recursive: true })
const LINKS = [
  ['cordis', 'vendor/cordis'],
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['schemastery', 'vendor/schemastery'],
  ['@deepseek-ai/dsh-host-webserver', 'packages/host/webserver'],
  ['@types/node', 'node_modules/@types/node'],
]
for (const [name, target] of LINKS) linkPkg(name, target)

// @standard-schema（schemastery 的 std 桥接）
rmSync(join(pkgRoot, 'node_modules', '@standard-schema'), { recursive: true, force: true })
const pnpmDir = join(checkout, 'node_modules', '.pnpm')
const std = readdirSync(pnpmDir).find((d) => d.startsWith('@standard-schema+spec@'))
if (std) {
  linkPkg('@standard-schema/spec', join('node_modules', '.pnpm', std, 'node_modules', '@standard-schema', 'spec'))
}

// ── host 编译 ────────────────────────────────────────────────────────────────
console.log('=== Compiling src → lib ===')
const tscJs = join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')
const tsc = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

// ── client 编译（esbuild：checkout 的 tsdown/rolldown 在本环境解析异常） ──────
console.log('=== Building client (esbuild) ===')
const client = spawnSync(process.execPath, ['scripts/build-client.mjs'], { cwd: pkgRoot, stdio: 'inherit' })
if (client.status !== 0) {
  console.warn('prepare: client build failed (host build still valid)')
}

console.log('=== Build complete ===')
