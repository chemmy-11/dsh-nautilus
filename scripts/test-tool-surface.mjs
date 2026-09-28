/**
 * @dsh-external/dsh-nautilus — 工具注册面契约回归（AL.7；与宿主版本解耦，0.1.7 / 0.2.0 同跑）。
 *
 * **为什么单独一条**：本包的工具定义是**手写 duck-type**（AGENTS §4：零第三方 import，dsh-tools 未装配）。
 * 这种做法的代价是「形状对不上宿主 register() 的运行时硬校验」没有编译期保护。0.2.0 的
 * `@deepseek-ai/dsh-tools` 在 `register(definition)` 里**同步抛错**（不再是静默忽略）：
 *   · `output` 必须是对象，且 `output.render` 必须是**函数**（否则 TypeError: tool "x" must declare output { schema, render, presentationMeta? }）；
 *   · `assertSupportedJsonSchema(output.schema)`；
 *   · 名字不得是保留的 `run_code`；
 *   · `timeoutMs` 若给出必须为正有限数。
 * 而**实际调用**走的是 `await tool.execute(exec.arguments, exec)`——本文件按宿主的**调用签名**打一遍，
 * 覆盖「工具不见了 / execute is not a function」这一类症状（0.2.0 事故的其中一腿即此形态）。
 *
 * 口径（rubric 锚文 / align≥4 引文硬门零写入）的**逐字**断言已在 test-al.mjs；本文件只补
 * **宿主注册面与调用面**，不重复口径断言。
 *
 * 判据来源：`D:/dsh/resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
 * （0.2.0-rc.1，按 asar 偏移只读，未解压）第 2879 `register()` / 第 3311 `tool.execute(...)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openStore } from '../lib/store.js'
import { buildSelfCheckTool, registerSelfCheckTool } from '../lib/nexus/selfcheck.js'

const tmpDir = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })

/** 直读库文件的行数（不经 store 自报——断言外部世界）。 */
function rawCount(file) {
  const db = new DatabaseSync(file)
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM selfcheck_record').get().n) } finally { db.close() }
}

/**
 * 宿主 0.2.0 `Tools.register()` 的**运行时硬校验**复刻（只取与本包相关的判据）。
 * 本函数存在的意义：它**能拒**——负向对照用例会喂一个坏 def 进来证明这一点。
 * @param {any} definition - 待注册的工具定义。
 */
function hostRegisterValidation(definition) {
  const name = definition?.name
  if (typeof name !== 'string' || name === '') throw new TypeError('tool must declare a name')
  const output = definition.output
  if (output === undefined || typeof output !== 'object' || output === null || typeof output.render !== 'function') {
    throw new TypeError('tool "' + name + '" must declare output { schema, render, presentationMeta? }')
  }
  const schema = output.schema
  if (schema === undefined || typeof schema !== 'object' || schema === null) throw new TypeError('tool "' + name + '" output.schema must be an object')
  // 宿主走 assertSupportedJsonSchema：至少必须是可 JSON 往返的纯数据（不得含 function/undefined）
  const roundTrip = JSON.parse(JSON.stringify(schema))
  assert.deepEqual(roundTrip, schema, 'output.schema 必须可 JSON 往返（含函数/undefined 会被宿主拒）')
  if (name === 'run_code') throw new Error('tool name "run_code" is reserved')
  const timeoutMs = definition.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError('tool "' + name + '" timeoutMs must be a positive finite number')
  if (typeof definition.execute !== 'function') throw new TypeError('tool "' + name + '" must declare execute')
  return true
}

test('工具注册面：手写 def 通过宿主 register() 的全部硬校验（output.render / schema 可 JSON 往返 / 非保留名 / timeoutMs）', () => {
  const store = openStore(':memory:')
  try {
    const def = buildSelfCheckTool(store)
    assert.equal(hostRegisterValidation(def), true)
    assert.equal(def.name, 'record_turn_selfcheck', '工具名是 agent 侧的稳定契约（改名即断台账）')
    assert.notEqual(def.name, 'run_code', 'run_code 是宿主保留的 PTC 传输名')
    assert.equal(typeof def.description, 'string')
    assert.ok(def.description.length > 0, 'description 是注入面，不能为空')
    assert.equal(typeof def.execute, 'function', 'execute 必须是函数——否则报 "is not a function"')
    assert.equal(def.timeoutMs, undefined, '本包不设 timeoutMs（长任务走 ctx.jobs 的场合另议）')
  } finally { store.close() }
})

test('工具注册面：负向对照——缺 output.render / 保留名 / 非法 timeoutMs 必须被同一校验拒（证明校验有牙）', () => {
  const store = openStore(':memory:')
  try {
    const good = buildSelfCheckTool(store)
    // ① 缺 render（0.2.0 起此处同步抛 TypeError，而不是静默放过）
    assert.throws(() => hostRegisterValidation({ ...good, output: { schema: good.output.schema } }), /must declare output/)
    // ② 保留名
    assert.throws(() => hostRegisterValidation({ ...good, name: 'run_code' }), /reserved/)
    // ③ timeoutMs 非法
    assert.throws(() => hostRegisterValidation({ ...good, timeoutMs: 0 }), /timeoutMs/)
    // ④ schema 含 undefined（不可 JSON 往返）——宿主 assertSupportedJsonSchema 的前置
    assert.throws(() => hostRegisterValidation({ ...good, output: { schema: { type: 'string', description: undefined }, render: good.output.render } }))
    // ⑤ 缺 execute
    const { execute: _drop, ...noExecute } = good
    assert.throws(() => hostRegisterValidation(noExecute), /must declare execute/)
  } finally { store.close() }
})

test('工具调用面：按宿主签名 await tool.execute(args, exec) —— 正路落库、render 产出规范文本', async () => {
  const tmp = tmpDir('nautilus-tool-surface-')
  try {
    const file = join(tmp, 'n.db')
    const store = openStore(file)
    assert.equal(rawCount(file), 0, '前置：空库')
    const def = buildSelfCheckTool(store)
    // 宿主：const returned = await tool.execute(exec.arguments, exec) —— 第二个参数本包不使用，按命名用不上的形状传
    const executed = await def.execute({ align: 3, session: 's-1', turn: 1 }, { signal: undefined, name: def.name })
    assert.equal(typeof executed, 'string', 'execute 必须返回字符串（output.schema 声明的规范 JSON 值）')
    assert.ok(!executed.startsWith('自评被拒'), '正路不应被拒：' + executed)
    assert.equal(rawCount(file), 1, '正路必须落一行')
    // render 是纯函数：args + result → 文本块数组（宿主 createSuccessResult 的消费形状）
    const rendered = def.output.render({ align: 3 }, executed)
    assert.ok(Array.isArray(rendered) && rendered.length > 0)
    assert.deepEqual(rendered[0], { type: 'text', text: String(executed) })
    store.close()
  } finally { cleanup(tmp) }
})

test('工具调用面：align≥4 无引文走宿主签名 → 拒绝且零写入（硬门在真实调用路径上仍然生效）', async () => {
  const tmp = tmpDir('nautilus-tool-gate-')
  try {
    const file = join(tmp, 'n.db')
    const store = openStore(file)
    const def = buildSelfCheckTool(store)
    for (const args of [{ align: 4, session: 's-1', turn: 1 }, { align: 5, session: 's-1', turn: 1 }, { align: 3, declaration: 1, session: 's-1', turn: 1 }]) {
      const message = await def.execute(args, { name: def.name })
      assert.ok(message.startsWith('自评被拒'), '硬门必须显式拒：' + JSON.stringify(args))
      assert.equal(rawCount(file), 0, '拒绝即零写入（不是先写后拒）：' + JSON.stringify(args))
    }
    store.close()
  } finally { cleanup(tmp) }
})

test('工具装配面：registerSelfCheckTool 恰好注册一次、且注册的就是同一份 def', () => {
  const store = openStore(':memory:')
  try {
    const seen = []
    registerSelfCheckTool({ tools: { register: (def) => { seen.push(def) } } }, store)
    assert.equal(seen.length, 1, 'redundant/duplicate 注册会让宿主 resolveExecution 语义变味')
    assert.equal(seen[0].name, 'record_turn_selfcheck')
    assert.equal(hostRegisterValidation(seen[0]), true)
  } finally { store.close() }
})
