/**
 * @dsh-external/dsh-nautilus — 依赖合规 lint（CI/本地同款，2026-08 事故教训）。
 * 规则：
 *  R1 单实例合约：dependencies 禁止 in-box 包（@deepseek-ai/* 与 cordis/cosmokit/schemastery）；
 *  R2 预发布分支：@deepseek-ai/dsh* 宿主族包的 peerDependencies 范围必须含显式 '-rc' 下限
 *     （裸 `^0.1.0` 会静默排除 rc 构建 → 用户 ERESOLVE/双实例；官方包自身用 `^0.1.1-rc.2` 形）。
 *     仅约束带 prerelease 线的宿主族；稳定版 in-box 包（@deepseek-ai/cordis、schemastery）不适用。
 *  R3 peer/devDep 同步：@deepseek-ai/dsh-host-webserver 的 devDependency 必须精确 pin，
 *     且其版本线（major.minor.patch-tag）落在 peer 范围内——升级 devDep 忘改 peer
 *     会让「构建对准的宿主」与「声明支持的宿主」脱节（2026-09-10 0.1.5-rc.1 适配教训）。
 *  R4 每个宿主 peer 分支都要带预发布标签：按 semver 预发布规则，`0.1.6-alpha.2` 只能被
 *     「同元组且带预发布」的比较器匹配——写裸 `^0.1.6` 会**静默排除 alpha 线**（R2 拦不住，
 *     它只查整个范围串里出现过 '-rc'）。带 tag 的分支同时覆盖 alpha 与日后转正的 stable
 *     （`^0.1.6-alpha.1` ⊇ 0.1.6），故「只写带 tag 的分支」是唯一安全形态（2026-09-13 0.1.6-alpha.2 适配教训）。
 * 违规即 exit 1。
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const IN_BOX = (n) => n.startsWith('@deepseek-ai/') || ['cordis', 'cosmokit', 'schemastery'].includes(n)
const violations = []

for (const [name] of Object.entries(pkg.dependencies ?? {})) {
  if (IN_BOX(name)) violations.push(`R1: in-box 包出现在 dependencies: ${name}（应 peerDependencies 或不声明）`)
}
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (/^@deepseek-ai\/dsh(-|$)/.test(name) && !String(range).includes('-rc')) {
    violations.push(`R2: peer 范围缺显式 prerelease 分支: ${name}: ${range}`)
  }
}

// R4：宿主 peer 的每个 || 分支都必须自带预发布标签（裸分支会静默排除 alpha 线）
const hostPeerRange = pkg.peerDependencies?.['@deepseek-ai/dsh-host-webserver']
if (typeof hostPeerRange === 'string') {
  for (const branch of hostPeerRange.split('||').map((s) => s.trim()).filter((s) => s !== '')) {
    if (!branch.includes('-')) violations.push(`R4: 宿主 peer 分支缺预发布标签（裸分支静默排除 alpha 线）: ${branch}`)
  }
}

// R3：peer 必须覆盖 devDep pin 的宿主版本线（升级 devDep 忘改 peer 的护栏）
const HOST_PKG = '@deepseek-ai/dsh-host-webserver'
/** 解析出版本线 major.minor.patch[-tag]，tag 取 prerelease 首段（rc/alpha/beta…）。 */
const versionLine = (value) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+))?/.exec(String(value).replace(/[\^~>=<*\s]/g, ''))
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}${m[4] === undefined ? '' : `-${m[4]}`}`
}
const pinnedHost = pkg.devDependencies?.[HOST_PKG]
const peerHost = pkg.peerDependencies?.[HOST_PKG]
if (typeof pinnedHost === 'string' && typeof peerHost === 'string') {
  if (/[\^~><=*]/.test(pinnedHost)) {
    violations.push(`R3: ${HOST_PKG} 的 devDependency 必须精确 pin（当前 ${pinnedHost}）`)
  }
  const line = versionLine(pinnedHost)
  const peerLines = String(peerHost).split('||').map(versionLine).filter((l) => l !== null)
  if (line === null) violations.push(`R3: 无法解析 devDependency 版本: ${HOST_PKG}: ${pinnedHost}`)
  else if (!peerLines.includes(line)) violations.push(`R3: peer 范围未覆盖 devDep pin 的宿主版本线（${pinnedHost} → 需含 ^${line}.x 分支）: ${HOST_PKG}: ${peerHost}`)
}

if (violations.length > 0) {
  console.error('check-deps: 违规\n' + violations.map((v) => `  - ${v}`).join('\n'))
  process.exit(1)
}
console.log('check-deps: OK（单实例合约 + 预发布分支 + peer/devDep 同步合规）')
