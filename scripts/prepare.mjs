/**
 * @dsh-external/dsh-nexus — Node 构建入口（prepack/build 共用）。
 * 挂在 npm prepack 而非 prepare：npm ci/install 不再隐式整包构建
 * （曾致 tsc 错误在 install 步爆出、误导归因），npm pack 发布前仍自动构建兜底。
 * 纯 Node 实现（不依赖 bash 环境）。
 * 两种构建模式：
 *  A) DSH checkout 模式（本地开发）：DSH_CHECKOUT / ~/dsh-harness 存在 →
 *     junction 链接 cordis/schemastery/dsh-host-webserver + 用 checkout 的 tsc/esbuild；
 *  B) npm-devDeps 模式（CI / 无 checkout）：node_modules 已按 devDependencies
 *     装好 @deepseek-ai/cordis、@deepseek-ai/dsh-host-webserver、schemastery、
 *     typescript、esbuild → 直接用本地依赖构建，不链接 checkout。
 */
import { rmSync, mkdirSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
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
const npmMode = checkout === ''
  && existsSync(join(pkgRoot, 'node_modules', '@deepseek-ai', 'cordis'))
  && existsSync(join(pkgRoot, 'node_modules', 'schemastery'))

if (!checkout && !npmMode) {
  console.error('build: no dsh checkout (set DSH_CHECKOUT or $HOME/dsh-harness) and no local npm devDeps — run `npm install` first')
  process.exit(1)
}

if (checkout) {
  console.log('=== Linking build dependencies (checkout: ' + checkout + ') ===')
  function linkPkg(name, target) {
    const link = join(pkgRoot, 'node_modules', name)
    const t = resolve(checkout, target)
    if (!existsSync(t)) {
      console.error(`build: dependency target missing: ${t}`)
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
  // checkout 模式：用 checkout 的 tsc
  const tscJs = join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')
  const tsc = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'inherit' })
  if (tsc.status !== 0) process.exit(tsc.status ?? 1)
} else {
  // npm-devDeps 模式：直接用本地 tsc（无 junction 链接）
  console.log('=== npm-devDeps mode: no checkout, building with local node_modules ===')
  const tscJs = join(pkgRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tscJs)) {
    console.error('build: local typescript not found — run `npm install` first')
    process.exit(1)
  }
  const tsc = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'inherit' })
  if (tsc.status !== 0) process.exit(tsc.status ?? 1)
}

// ── client 编译（esbuild） ────────────────────────────────────────────────
console.log('=== Building client (esbuild) ===')
const client = spawnSync(process.execPath, ['scripts/build-client.mjs'], { cwd: pkgRoot, stdio: 'inherit' })
if (client.status !== 0) {
  console.warn('build: client build failed (host build still valid)')
}

console.log('=== Build complete ===')
