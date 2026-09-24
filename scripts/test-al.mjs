/**
 * @dsh-external/dsh-nautilus — AL 系列（对齐体系重构）回归测试 + 结构守卫。
 *
 * 当前内容：**nexus 模块边界守卫**（AL.6 第一步：目录解耦之后把边界钉住，防回退）。
 * 纪律来源：docs/1-planning/nautilus-alignment.md §7.2——`src/nexus/**` 自包含，
 * 不 import pulse/告警/client 的值；两腿互不依赖（pulse 也不得反向 import nexus）。
 *
 * 已知例外（记在案，不是漏网）：`../store.js` 允许——数据核心（表与迁移）仍是共享的，
 * 真正抽离它属 OQ-AL4（正式拆包时再裁）。
 *
 * 后续 AL.2（v8 迁移）/ AL.3（自评换维度）的用例也落本文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')
const NEXUS_MODULES = ['analysis.ts', 'selfcheck-ingest.ts', 'selfcheck.ts', 'turns.ts']

test('AL.6 边界守卫：nexus 模块自包含、只在 src/nexus 下、两腿互不 import', () => {
  const nexusDir = join(SRC, 'nexus')
  assert.equal(existsSync(nexusDir), true, 'src/nexus/ 必须存在（AL.6 解耦落点）')
  assert.deepEqual(readdirSync(nexusDir).filter((f) => f.endsWith('.ts')).sort(), NEXUS_MODULES, 'nexus 模块集合')

  // 防回退：顶层不得再出现这些模块（否则边界形同虚设）
  for (const n of NEXUS_MODULES) {
    assert.equal(existsSync(join(SRC, n)), false, 'src/' + n + ' 不该再存在（已移入 src/nexus/）')
  }

  // 边界：nexus 只允许 node:* / 同目录相对 / ../store.js
  for (const n of NEXUS_MODULES) {
    const text = readFileSync(join(nexusDir, n), 'utf8')
    const specs = [...text.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((m) => m[1])
    for (const spec of specs) {
      const allowed = spec.startsWith('node:') || spec.startsWith('./') || spec === '../store.js'
      assert.ok(allowed, 'src/nexus/' + n + ' 的 import 越界：' + spec + '（只允许 node:* / 同目录 / ../store.js）')
    }
    for (const bad of [/from '[^']*\/pulse\//, /from '[^']*\/client\//, /alerts\.js'/, /from '[^']*\/routes\.js'/, /from '[^']*\/index\.js'/]) {
      assert.ok(!bad.test(text), 'src/nexus/' + n + ' 命中禁止项：' + String(bad))
    }
  }

  // 反向：pulse 腿不得 import nexus（两腿互不依赖——观测面互不叠加的模块化落点）
  const pulseDir = join(SRC, 'pulse')
  for (const f of readdirSync(pulseDir).filter((x) => x.endsWith('.ts'))) {
    const text = readFileSync(join(pulseDir, f), 'utf8')
    assert.ok(!/from '[^']*nexus\//.test(text), 'src/pulse/' + f + ' 不得 import nexus')
  }
})
