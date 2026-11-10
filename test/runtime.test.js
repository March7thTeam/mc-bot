const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRuntime, CancelledError } = require('../runtime')
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('取消后旧任务不能继续副作用，且收尾前不能启动新任务', async () => {
  const runtime = createRuntime()
  const waiting = deferred()
  let mutations = 0
  const bot = { equip: () => { mutations++ } }
  runtime.guardBot(bot)
  const old = runtime.runTask('old', async () => { await waiting.promise; bot.equip() })
  runtime.cancel()
  assert.equal(runtime.busy(), true)
  await assert.rejects(runtime.runTask('new', async () => {}), /收尾/)
  waiting.resolve()
  await assert.rejects(old, CancelledError)
  assert.equal(mutations, 0)
  await runtime.runTask('new', async () => bot.equip())
  assert.equal(mutations, 1)
})

test('晚到的容器会关闭，已打开容器的后续存取受取消约束', async () => {
  const runtime = createRuntime()
  const waiting = deferred()
  let closed = 0, transferred = 0
  const chest = { close: () => { closed++ }, withdraw: () => { transferred++ } }
  const bot = { openContainer: () => waiting.promise }
  runtime.guardBot(bot)
  const old = runtime.scope(async () => { const c = await bot.openContainer(); c.withdraw() })
  runtime.cancel()
  waiting.resolve(chest)
  await assert.rejects(old, CancelledError)
  assert.equal(closed, 1)
  assert.equal(transferred, 0)
  await runtime.scope(async () => {
    const c = await bot.openContainer()
    c.withdraw()
    runtime.cancel()
    assert.throws(() => c.withdraw(), CancelledError)
    c.close() // 资源释放不被取消检查阻止。
  })
  assert.equal(transferred, 1)
})

test('跨维度后旧容器的迟到打开、关闭和协议包不能碰新窗口', async () => {
  const runtime = createRuntime(), late = deferred(), sent = []
  const old = { close: () => sent.push('old') }, next = { close: () => sent.push('new') }
  const bot = { _client: { write: name => sent.push(name) }, currentWindow: old, openContainer: () => old, openFurnace: () => late.promise }
  runtime.guardBot(bot)
  await runtime.scope(async () => {
    const opened = await bot.openContainer()
    const pending = bot.openFurnace()
    runtime.cancel('dimension changed', 'dimension_changed')
    bot.currentWindow = next
    late.resolve(next)
    await assert.rejects(pending, { code: 'dimension_changed' })
    opened.close()
    bot._client.write('close_window')
    assert.deepEqual(sent, [])
  })
  bot.currentWindow.close()
  assert.deepEqual(sent, ['new'])
})

test('跨维度的晚到控制和朝向不会继续改变新世界物理', async () => {
  const runtime = createRuntime(), controls = []
  const bot = { setControlState: (...args) => controls.push(args), clearControlStates: () => controls.push('clear'), look: async () => controls.push('look') }
  runtime.guardBot(bot)
  await runtime.scope(async () => {
    bot.setControlState('forward', true)
    runtime.cancel('dimension changed', 'dimension_changed')
    await bot.look(0, 0)
    bot.setControlState('jump', true)
    bot.clearControlStates()
  })
  await runtime.scope(() => bot.look(0, 0))
  assert.deepEqual(controls, [['forward', true], 'look'])
})

test('真实 pathfinder 的全局 physicsTick 等待装备时换维度，不挖旧方块，下一次仍正常挖', async () => {
  const { EventEmitter } = require('node:events')
  const { Vec3 } = require('vec3')
  const { pathfinder, goals } = require('mineflayer-pathfinder')
  const registry = require('prismarine-registry')('26.1.2')
  const runtime = createRuntime(), waiting = deferred(), calls = []
  const bot = new EventEmitter()
  const tool = { type: registry.itemsByName.iron_pickaxe.id }
  let destination = new Vec3(1, 64, 0)
  Object.assign(bot, {
    registry, version: '26.1.2', game: { dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), effects: {}, onGround: true },
    inventory: { items: () => [tool] }, entities: {}, clearControlStates() {}, stopDigging() {},
    blockAt: p => ({ position: p, name: 'stone', digTime: () => 200 }),
    equip: () => { calls.push(`equip:${bot.game.dimension}`); return waiting.promise },
    dig: async (block) => calls.push(`dig:${bot.game.dimension}:${block.position.x}`),
  })
  runtime.scopePathfinder(pathfinder)(bot)
  runtime.guardBot(bot)
  bot.pathfinder.getPathTo = () => ({ status: 'success', path: [{ x: 2.5, y: 64, z: 0.5, toBreak: [destination], toPlace: [] }] })
  bot.pathfinder.setGoal(new goals.GoalBlock(2, 64, 0))
  bot.emit('physicsTick') // Unscoped, like a real Mineflayer physics event.
  assert.deepEqual(calls, ['equip:overworld'])
  bot.game.dimension = 'the_nether'
  runtime.cancel('dimension changed', 'dimension_changed')
  bot.pathfinder.setGoal(null)
  waiting.resolve()
  await new Promise(setImmediate)
  assert.deepEqual(calls, ['equip:overworld'])
  destination = new Vec3(2, 64, 0)
  bot.pathfinder.setGoal(new goals.GoalBlock(2, 64, 0))
  bot.emit('physicsTick')
  await new Promise(setImmediate)
  assert.deepEqual(calls, ['equip:overworld', 'equip:the_nether', 'dig:the_nether:2'])
})

test('熔炉续操作、寻路及攻击同样受取消约束', async () => {
  const runtime = createRuntime()
  let mutations = 0
  const furnace = { putInput: () => { mutations++ }, takeOutput: () => { mutations++ }, close() {} }
  const bot = { openFurnace: async () => furnace, pvp: { attack: () => { mutations++ } }, pathfinder: { setGoal: () => { mutations++ } } }
  runtime.guardBot(bot)
  await runtime.scope(async () => {
    const f = await bot.openFurnace()
    f.putInput()
    runtime.cancel()
    for (const fn of [() => f.takeOutput(), () => bot.pvp.attack(), () => bot.pathfinder.setGoal()]) assert.throws(fn, CancelledError)
  })
  assert.equal(mutations, 1)
})

test('超时取消可中断等待并释放本任务锁', async () => {
  let timedOut = 0
  const runtime = createRuntime({ timeoutMs: 15, onTimeout: () => { timedOut++ } })
  await assert.rejects(runtime.runTask('timeout', () => runtime.delay(10_000)), CancelledError)
  assert.equal(timedOut, 1)
  assert.equal(runtime.busy(), false)
  await runtime.runTask('valid', async () => {})
})

test('库内闭包绕过公开方法时，取消上下文仍阻止后续操作包并允许关闭窗口', async () => {
  const runtime = createRuntime()
  const waiting = deferred()
  const sent = []
  const client = { write: (name) => sent.push(name) }
  // 模拟 inventory.js 内部闭包 transfer/clickWindow，不调用 bot.clickWindow。
  const internalClick = () => client.write('window_click')
  const chest = {
    async withdraw() { internalClick(); await waiting.promise; internalClick() },
    close: () => client.write('close_window'),
  }
  const bot = { _client: client, openContainer: async () => chest }
  runtime.guardBot(bot)
  const pending = runtime.runTask('transfer', async () => {
    const c = await bot.openContainer()
    try { await c.withdraw() } finally { c.close() }
  })
  await new Promise(setImmediate)
  runtime.cancel()
  waiting.resolve()
  await assert.rejects(pending, CancelledError)
  assert.deepEqual(sent, ['window_click', 'close_window'])
  await runtime.runTask('legitimate', async () => internalClick())
  assert.deepEqual(sent, ['window_click', 'close_window', 'window_click'])
})

test('真实openBlock形态的fire-and-forget激活在停止后不发包也不产生未处理拒绝', async () => {
  const runtime = createRuntime()
  const turning = deferred()
  const sent = []
  const client = { write: (name) => sent.push(name) }
  let activation
  const bot = {
    _client: client,
    async openContainer() {
      activation = (async () => { await turning.promise; client.write('block_place'); client.write('arm_animation') })()
      // 模拟库自有的窗口等待超时；activateBlock 未被调用方 await。
      await new Promise((_, reject) => setTimeout(() => reject(new Error('window timeout')), 10))
    },
  }
  runtime.guardBot(bot)
  const operation = runtime.runTask('open', () => bot.openContainer())
  runtime.cancel()
  turning.resolve()
  await activation // 若协议门抛异常，这个真实形态的替身会直接失败。
  await assert.rejects(operation, /window timeout/)
  assert.deepEqual(sent, [])
  await runtime.runTask('normal', async () => client.write('block_place'))
  assert.deepEqual(sent, ['block_place'])
})
