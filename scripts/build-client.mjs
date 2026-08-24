/**
 * @dsh-external/dsh-xuegulin — client half build (esbuild JS API, ModuleLoader wrapper).
 * Output: lib/client.js (module shim + __ModuleLoader__.load wrapper) + lib/client.js.map.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const PLUGIN_ID = '@dsh-external/dsh-xuegulin'

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
let esbuild
if (checkout) {
  console.log('build-client: esbuild from checkout ' + checkout)
  const pnpmDir = join(checkout, 'node_modules', '.pnpm')
  const esbuildCandidates = readdirSync(pnpmDir).filter((d) => d.startsWith('esbuild@')).sort()
  const esbuildPkg = esbuildCandidates[esbuildCandidates.length - 1]
  if (!esbuildPkg) {
    console.error('build-client: esbuild not found in checkout')
    process.exit(1)
  }
  const mainJs = join(pnpmDir, esbuildPkg, 'node_modules', 'esbuild', 'lib', 'main.js')
  esbuild = require(mainJs)
} else {
  // npm-devDeps 模式：本地 esbuild
  try {
    esbuild = require('esbuild')
  } catch (e) {
    console.error('build-client: local esbuild not found — run `npm install` first')
    process.exit(1)
  }
}

const shim = 'var module = { exports: {} }; var exports = module.exports;'
const banner = `${shim}\nwindow.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`
const footer = 'return module.exports; } });'

await esbuild.build({
  entryPoints: [join(pkgRoot, 'src', 'client', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  outfile: join(pkgRoot, 'lib', 'client.js'),
  sourcemap: true,
  banner: { js: banner },
  footer: { js: footer },
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    'cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-runtime/client',
  ],
})
console.log('build-client: lib/client.js written (esbuild)')
