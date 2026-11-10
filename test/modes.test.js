const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { Vec3 } = require('vec3')

function harness() {
  let time = 1000, tick, paused = false, occupied = false, generation = 1, activity = 1, cancelled = 0, moving = false
  const timers = [], controls = [], goals = [], messages = [], looks = []
  const bot = { entity: { position: new Vec3(0, 64, 0) }, pvp: {}, inventory: { emptySlotCount: () => 10 },
    getControlState: () => false, setControlState: (k, v) => controls.push([k, v]),
    look: async (yaw) => { looks.push(yaw) }, lookAt: async () => {}, nearestEntity: () => null,
    blockAt: (p) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
    pathfinder: { goal: null, movements: {}, isMoving: () => moving, stop() { moving = false },
      setGoal(g) { this.goal = g; goals.push(g) }, getPathTo: () => ({ status: 'success' }) } }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modes.js'), 'utf8'), {
    require, module, Date: { now: () => time }, Math,
    setInterval: (fn) => { tick = fn; return 1 }, setTimeout: (fn, ms) => { timers.push({ fn, at: time + ms }); return timers.length },
  })
  const modes = module.exports.createModes(bot, { busy: () => false, paused: () => paused, occupied: () => occupied,
    transientPause: () => occupied, generation: () => generation, activityId: () => activity,
    say: (s) => messages.push(s), log() {}, resume() {}, cancelTask: () => { cancelled++; generation++ } })
  const advance = (ms) => { time += ms; for (const timer of timers.splice(0)) { if (timer.at <= time) timer.fn(); else timers.push(timer) } }
  return { bot, modes, controls, goals, messages, looks, tick: () => tick(), advance,
    paused: (v) => { paused = v }, occupied: (v) => { occupied = v }, moving: (v) => { moving = v },
    activity: (v) => { activity = v }, cancelled: () => cancelled }
}

test('脱困旧800ms回调不能干扰新飞行，且新任务重新获得独立重试预算', () => {
  const h = harness()
  h.moving(true); h.tick(); h.advance(15_001); h.tick()
  assert.deepEqual(h.controls, [['jump', true], ['forward', true]])
  // 第一次脱困朝格子中央走：站在 (0,0)，中央在 (+0.5,+0.5)
  assert.ok(-Math.sin(h.looks[0]) > 0.5 && -Math.cos(h.looks[0]) > 0.5)
  h.paused(true); h.advance(800)
  assert.deepEqual(h.controls, [['jump', true], ['forward', true]])
  h.paused(false); h.activity(2); h.advance(500); h.moving(true); h.tick()
  for (let i = 0; i < 3; i++) { h.advance(15_001); h.moving(true); h.tick(); h.advance(1300); h.moving(true); h.tick() }
  assert.equal(h.cancelled(), 0)
  h.advance(15_001); h.moving(true); h.tick()
  assert.equal(h.cancelled(), 1)
})

test('吃饭/容器/战斗暂停不是卡住，不触发乱跳和重试', () => {
  const h = harness()
  h.moving(true); h.tick(); h.occupied(true); h.advance(20_000); h.tick()
  assert.deepEqual(h.controls, [])
  h.occupied(false); h.tick(); h.advance(14_000); h.tick()
  assert.deepEqual(h.controls, [])
})

test('可选捡物绑定同一实体等待、检查可达性，并尊重跟随或战斗控制权', () => {
  const h = harness()
  h.modes.set('item_collecting', true)
  let item = { id: 1, name: 'item', position: new Vec3(2, 64, 0) }
  h.bot.nearestEntity = (filter) => filter(item) ? item : null
  h.occupied(true); h.tick(); h.advance(3000); h.tick()
  assert.equal(h.goals.length, 0)
  h.occupied(false); h.tick(); h.advance(1500)
  item = { ...item, id: 2 }; h.tick(); h.advance(600); h.tick()
  assert.equal(h.goals.length, 0)
  h.advance(1500); h.tick()
  assert.equal(h.goals.length, 1)
  h.advance(5001)
  assert.equal(h.bot.pathfinder.goal, null)
  h.tick(); h.advance(3000); h.tick()
  assert.equal(h.goals.length, 2) // 自己的goal与超时清理，冷却中不会再追。
})

test('不可达掉落物不启动寻路，让位默认关闭且不在占用时触发', () => {
  const h = harness()
  const item = { id: 4, name: 'item', position: new Vec3(2, 64, 0) }
  h.bot.nearestEntity = (filter) => filter(item) ? item : null
  h.bot.pathfinder.getPathTo = () => ({ status: 'noPath' })
  h.modes.set('item_collecting', true); h.tick(); h.advance(2100); h.tick()
  assert.equal(h.goals.length, 0)
  const player = { id: 5, type: 'player', position: new Vec3(0.2, 64, 0) }
  h.bot.nearestEntity = (filter) => filter(player) ? player : null
  h.modes.set('idle_staring', false)
  h.tick(); assert.equal(h.goals.length, 0)
  h.modes.set('elbow_room', true); h.occupied(true); h.tick()
  assert.equal(h.goals.length, 0)
  h.occupied(false); h.tick()
  assert.equal(h.goals.length, 1)
})

test('危险反射：有防火只躲岩浆；赶路途中踩过岩浆块不打断；静止踩岩浆块仍跑开', () => {
  const at = (h, under, feet = 'air') => { h.bot.blockAt = (p) => ({ name: p.y < 64 ? under : feet, boundingBox: 'block' }) }
  const escaped = (setup) => { const h = harness(); h.bot.registry = { effectsByName: { fire_resistance: { id: 12 } } }; h.bot.entity.effects = {}; setup(h); h.tick(); return h.goals.length > 0 }
  assert.equal(escaped((h) => at(h, 'magma_block')), true)
  assert.equal(escaped((h) => { at(h, 'magma_block'); h.moving(true) }), false)
  assert.equal(escaped((h) => { at(h, 'stone'); h.bot.entity.onFire = true }), true)
  assert.equal(escaped((h) => { at(h, 'stone'); h.bot.entity.onFire = true; h.bot.entity.effects[12] = { id: 12 } }), false)
  assert.equal(escaped((h) => { at(h, 'magma_block', 'fire'); h.bot.entity.effects[12] = { id: 12 } }), false)
  assert.equal(escaped((h) => { at(h, 'stone', 'lava'); h.bot.entity.effects[12] = { id: 12 } }), true)
})

test('岩浆边缘安全落脚不抢寻路，实际接触接管一次并在脱险后交回', () => {
  const h = harness()
  h.bot.registry = { effectsByName: {} }
  const e = h.bot.entity, goal = { name: 'travel' }
  e.onGround = true
  h.bot.pathfinder.goal = goal
  h.moving(true)
  h.bot.blockAt = (p) => ({ name: p.y < 64 ? 'lava' : 'stone_slab', boundingBox: p.y < 64 ? 'empty' : 'block' })
  h.tick()
  assert.equal(h.bot.pathfinder.goal, goal)
  assert.equal(h.goals.length, 0)
  e.isInLava = true
  h.tick()
  assert.equal(h.modes.recovering(), true)
  const escape = h.bot.pathfinder.goal
  h.advance(1000); h.tick()
  assert.equal(h.bot.pathfinder.goal, escape)
  assert.equal(h.goals.length, 1)
  e.isInLava = false
  h.tick()
  assert.equal(h.bot.pathfinder.goal, null)
  assert.ok(!h.modes.recovering())
})
