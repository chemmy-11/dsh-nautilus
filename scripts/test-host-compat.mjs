/**
 * @dsh-external/dsh-nautilus — 宿主兼容门回归（AL.7 桌面宿主 0.2.0-rc.1 适配）。
 *
 * **为什么需要这条用例（本次事故的根因）**：宿主 `@deepseek-ai/dsh-app-boot` 在加载任何 profile
 * 之前会跑 `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`——对 manifest 里
 * **每一个** `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer 做
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；只要有**一个**不满足，
 * 该 bundle 就**整层跳过**（日志 `dsh: skipping profile bundle "..."`）或该行被置 `disabled: true`。
 *
 * 2026-09-28 桌面宿主升到 `0.2.0-rc.1` 时，本包 peer 只写到 `^0.1.7-rc.1` → **整个插件被拒装**：
 *   · `/api/nautilus/*` 的 exact 路由根本没注册 → 请求落到 `dsh-client-connection` 的 `/api` 前缀兜底 → 裸文本 401；
 *   · 自评工具未注册、`turn_read` 采集停摆，同因。
 * 事后审计发现：**当时的六件套没有任何一条能发现「声明的宿主范围覆盖不到实际宿主运行时」**——
 * `check:deps` 的 R3 只比对「peer 覆盖 devDep pin 的版本线」，而当时 devDep 还停在 `0.1.7-rc.1`，
 * 它**根本不知道 0.2.0 的存在**。本文件补上这唯一缺口：**拿真实宿主运行时版本去校验 peer 范围**。
 *
 * **设计约束（刻意为之）**：
 *  · 宿主版本**不硬编码**——按能力探测依次取：显式参数/环境变量 → 宿主目录 → 可解析的
 *    `@deepseek-ai/dsh-app-boot` → devDep pin（构建目标基线）→ 桌面 asar（按偏移读，不解压）。
 *    任何一个来源解析到即纳入断言；一个都解析不到则**响亮失败**（绝不允许「静默变绿」）。
 *  · 判据与宿主**逐字同款**：同名 semver 选项 `{ includePrerelease: true }`（裸 `^0.1.0` 会静默排除 rc 线）。
 *  · 带**负向对照**用例：把 peer 收窄回事故时的旧范围必须判 `false`——门若不会失败，它就毫无价值。
 *  · 宿主运行时**未解析到时只报告不判绿**；本门可在 0.1.7 与 0.2.0 上同样运行（范围内即通过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_PATH = join(HERE, '..', 'package.json')
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))

/** 宿主 app-boot 的兼容门只认这两个名字形态（`@deepseek-ai/cordis`、`schemastery` 不在其列）。 */
const isHostPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

/** semver 为 devDependency（宿主自身也用它）；缺失即响亮失败，不做自造实现以免语义漂移。 */
function loadSemver() {
  try {
    return require('semver')
  } catch (error) {
    assert.fail('无法解析 semver（宿主兼容门的判据实现）——请先 npm install：' + String(error))
  }
}

/**
 * 按 app-boot 的读取方式取版本：它读的是 **app-boot 自己 package.json 的 version**
 * （`getDshRuntimeVersion()`），即 dsh 运行时版本，preserving exact spelling。
 * @param {string} dir - 含 @deepseek-ai/dsh-app-boot 的目录（node_modules 或其父层）。
 */
function versionFromDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return null
  const candidates = [
    join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    join(dir, '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    join(dir, 'package.json'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    } catch { /* 不可读即跳过，继续探测下一个来源 */ }
  }
  return null
}

/**
 * 桌面宿主：`app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json`。
 * 按 asar 规范只读偏移（头部 16 字节 → `readUInt32LE(12)` = JSON 树长度 → 数据区 = 16+len），
 * **不解压整个包**（asar 可达数百 MB）。找不到就返回 null，绝不当成失败。
 * @param {string} asarPath - app.asar 绝对路径。
 */
function versionFromAsar(asarPath) {
  if (typeof asarPath !== 'string' || asarPath === '' || !existsSync(asarPath)) return null
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const treeBuffer = Buffer.alloc(jsonLength)
    readSync(fd, treeBuffer, 0, jsonLength, 16)
    const tree = JSON.parse(treeBuffer.toString('utf8'))
    const node = tree.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-app-boot'].files['package.json']
    if (node === undefined) return null
    const dataStart = 16 + jsonLength
    const size = Number(node.size)
    // asar 的 size 字段在本机实测**短报 2 字节**（末两字节 '\n}' 缺失，直接把 size 喂给 JSON.parse 会抛
    // 「Expected ',' or '}'」）。故多读一段余量并按首 '{' / 末 '}' 收紧——不依赖该字段精确。
    const buffer = Buffer.alloc(size + 64)
    const got = readSync(fd, buffer, 0, buffer.length, dataStart + Number(node.offset))
    const text = buffer.subarray(0, got).toString('utf8')
    const manifest = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    // 读不动 asar 只是「这个来源不可用」，不让它变成测试失败（失败只由「不兼容」触发）
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 采集所有可得的宿主运行时版本（去重，带来源标签供报告）。
 * @returns {Array<{ version: string, source: string }>}
 */
function resolveHostRuntimes() {
  const found = []
  const push = (version, source) => {
    if (typeof version !== 'string' || version.trim() === '') return
    if (found.some((entry) => entry.version === version && entry.source === source)) return
    found.push({ version: version.trim(), source })
  }

  // ① 显式注入（CI/探针实例最稳的来源）：DSH_RUNTIME_VERSION 或 --runtime=<v>
  const fromArgv = process.argv.find((a) => a.startsWith('--runtime='))
  if (fromArgv !== undefined) push(fromArgv.slice('--runtime='.length), 'argv --runtime=')
  push(process.env.DSH_RUNTIME_VERSION ?? '', 'env DSH_RUNTIME_VERSION')

  // ② 宿主目录（探针实例 / 本地安装）：DSH_RUNTIME_DIR、DSH_HOST_DIR
  for (const key of ['DSH_RUNTIME_DIR', 'DSH_HOST_DIR']) {
    const version = versionFromDir(process.env[key])
    if (version !== null) push(version, 'env ' + key)
  }

  // ③ 运行环境里可解析的 app-boot（被宿主装配时最自然）
  try {
    push(require('@deepseek-ai/dsh-app-boot/package.json').version, 'resolved @deepseek-ai/dsh-app-boot')
  } catch { /* 未装配即跳过 */ }

  // ④ devDep pin：**构建目标基线**。它与宿主族同版本号推进，故是「本包编译对准的宿主」。
  //    注意这条**不能**替代真实宿主：事故当时它停在旧版，正是它漏报了 0.2.0。
  push(pkg.devDependencies?.['@deepseek-ai/dsh-host-webserver'] ?? '', 'devDep pin @deepseek-ai/dsh-host-webserver')

  // ⑤ 桌面宿主 asar（本机装了 dsh-desktop 时；路径可覆盖）
  const asar = process.env.DSH_DESKTOP_ASAR ?? (process.platform === 'win32' ? 'D:/dsh/resources/app.asar' : '')
  const asarVersion = versionFromAsar(asar)
  if (asarVersion !== null) push(asarVersion, 'desktop asar ' + asar)

  return found
}

const HOST_PEERS = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => isHostPeer(name))
const RUNTIMES = resolveHostRuntimes()
const semver = loadSemver()

// ── 0. 门自身可用（没有解析到任何宿主运行时 → 本门无意义，必须响亮失败） ──────────

test('宿主兼容门：至少解析出一个宿主运行时版本来源（否则本门静默失效）', () => {
  assert.ok(
    RUNTIMES.length > 0,
    '未解析到任何宿主运行时版本；请设置 DSH_RUNTIME_VERSION / DSH_RUNTIME_DIR，或先 npm install 让 devDep pin 可读',
  )
  console.log('[host-compat] 已解析宿主运行时来源：' + RUNTIMES.map((r) => `${r.version} ← ${r.source}`).join(' | '))
})

// ── 1. 核心门：本包每个宿主 peer 必须覆盖每个已解析的宿主运行时 ──────────────────

test('宿主兼容门：本包 peer 范围覆盖测试机上每个可解析的宿主运行时（includePrerelease 语义同宿主）', () => {
  assert.ok(HOST_PEERS.length > 0, '本包未声明任何 @deepseek-ai/dsh* peer，兼容门无对象可查（预期至少 1 条）')
  for (const { version, source } of RUNTIMES) {
    for (const [name, range] of HOST_PEERS) {
      const suggestion = '^' + semver.major(version) + '.' + semver.minor(version) + '.' + semver.patch(version) + '-' + String(semver.prerelease(version)?.[0] ?? 'rc') + '.1'
      assert.ok(
        semver.satisfies(version, range, { includePrerelease: true }),
        [
          '宿主 ' + version + '（来源：' + source + '）不在 ' + name + ' 的 peer 范围内',
          '  peer:  ' + range,
          '  后果：宿主 app-boot 会给本 bundle 置 disabled / 整层跳过 —— 路由不注册（/api/nautilus/* 落到连接层 /api 兜底 → 裸文本 401），工具与采集同因消失。',
          '  修法：在本 peer 追加覆盖该宿主的显式 prerelease 分支，例如 || ' + suggestion + '（勿写裸 ^major.minor——裸范围静默排除预发布线），并同步 devDep pin。',
        ].join('\n'),
      )
    }
  }
})

// ── 2. 负向对照：门必须能失败（防「判据写松了导致永远绿」） ──────────────────────

test('宿主兼容门：负向对照——事故时的旧范围必须判不兼容（证明本门具备失败能力）', () => {
  const regressionRange = '^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1'
  assert.equal(
    semver.satisfies('0.2.0-rc.1', regressionRange, { includePrerelease: true }),
    false,
    '旧范围竟然覆盖了 0.2.0-rc.1——说明语义已变或对照失效，本门不再可信，请复核判据',
  )
  // 正向对照：补上分支后同一版本必须通过（且不因覆盖 0.2.0 而丢掉 0.1.7 线）
  const fixedRange = regressionRange + ' || ^0.2.0-rc.1'
  assert.equal(semver.satisfies('0.2.0-rc.1', fixedRange, { includePrerelease: true }), true)
  assert.equal(semver.satisfies('0.1.7-rc.1', fixedRange, { includePrerelease: true }), true)
  assert.equal(semver.satisfies('0.1.7-rc.2', fixedRange, { includePrerelease: true }), true)
})

// ── 3. peer 分支形态：每个 `||` 分支都要带预发布标签（裸分支静默排除 alpha 线） ────

test('宿主兼容门：宿主 peer 的每个 || 分支都带预发布标签（裸分支静默排除预发布线）', () => {
  for (const [name, range] of HOST_PEERS) {
    const branches = String(range).split('||').map((s) => s.trim()).filter((s) => s !== '')
    assert.ok(branches.length > 0, name + ' 的 peer 范围为空')
    for (const branch of branches) {
      assert.ok(
        branch.includes('-'),
        name + ' 的分支 ' + JSON.stringify(branch) + ' 缺预发布标签：按 semver 规则裸 ^x.y 会静默排除 x.y 的 alpha/rc 线',
      )
    }
  }
})
