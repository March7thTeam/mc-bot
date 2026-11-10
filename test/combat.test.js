const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { Vec3 } = require('vec3')

function harness({ reachable = true, cover = true } = {}) {
  const bot = new EventEmitter(), module = { exports: {} }, goals = [], used = [], logs = []
  let tick, eaten = 0
  const safe = {}, work = {}, origin = new Vec3(0.5, 64, 0.5)
  const archer = { id: 1, name: 'skeleton', position: new Vec3(-4, 64, 0) }
  const pillager = { id: 2, name: 'pillager', position: new Vec3(-4, 64, 2) }
  Object.assign(bot, {
    entity: { position: origin.clone(), yaw: Math.PI / 2 }, health: 11, entities: { 1: archer, 2: pillager },
    inventory: { items: () => [], slots: { 45: { name: 'shield' } } },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
    world: { raycast: (from, direction, length) => cover && from.x + direction.x * length > 3 ? {} : null },
    pathfinder: { movements: work, setMovements(moves) { this.movements = moves }, setGoal(goal) { this.goal = goal; goals.push(goal) },
      * getPathFromTo(moves) { assert.equal(moves, safe); yield { result: { status: reachable ? 'success' : 'noPath', path: [{}] } } } },
    pvp: { stop() {} }, hawkEye: { stop() {} }, activateItem: (offhand) => used.push(offhand), deactivateItem: () => used.push(false),
  })
  const file = require.resolve('../combat')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: createRequire(file), setInterval: fn => { tick = fn } })
  const combat = module.exports.createCombat(bot, { log: text => logs.push(text), retreatMoves: () => safe,
    onCombatStart() {}, onCombatOver() {}, autoEat: () => eaten++ })
  return { bot, combat, tick: () => tick(), goals, used, logs, safe, work, eaten: () => eaten }
}

test('远程多敌撤退时选择安全可达掩体、稳定保持目标，到掩体后清理并进食', () => {
  const h = harness()
  h.tick()
  const goal = h.bot.pathfinder.goal
  assert.ok(goal.x >= 4)
  assert.equal(h.bot.pathfinder.movements, h.safe)
  assert.ok(h.logs[0].includes('掩体'))
  h.tick()
  assert.deepEqual(h.goals, [goal])
  h.bot.entity.position.set(goal.x + 0.5, goal.y, goal.z + 0.5)
  h.tick()
  assert.equal(h.bot.pathfinder.goal, null)
  assert.equal(h.bot.pathfinder.movements, h.work)
  assert.equal(h.eaten(), 1)
})

test('掩体不可达时退离远程怪，盾仅在面向远程怪时举起', () => {
  const h = harness({ reachable: false })
  h.tick()
  assert.ok(h.logs[0].includes('躲开'))
  assert.equal(h.bot.pathfinder.goal.goal.rangeSq, 24 * 24)
  h.bot.emit('physicsTick')
  h.bot.entity.yaw = -Math.PI / 2
  h.bot.emit('physicsTick')
  assert.deepEqual(h.used, [true, false])
  h.combat.stop()
  assert.equal(h.bot.pathfinder.goal, null)
})
