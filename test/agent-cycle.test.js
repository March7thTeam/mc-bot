'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { assessAction, verifyCondition, createAgentCycle } = require('../agent-cycle')
const c = { worldKey: 'w', dimension: 'minecraft:overworld', epoch: 1, position: { x: 0, y: 64, z: 0 }, inventory: {} }
const travel = { kind: 'travel', ok: true, reached: true }
test('arrival requires physical 3D location and the original level/epoch, not receipt text', () => {
  const args = { cmd: 'walk', args: ['10', '64', '0'], before: c, outcome: travel }
  assert.equal(assessAction({ ...args, after: c }).ok, false)
  const after = { ...c, position: { x: 10, y: 64, z: 0 } }
  assert.equal(assessAction({ ...args, after }).verification, 'passed')
  assert.equal(assessAction({ ...args, after: { ...after, dimension: 'minecraft:the_nether' } }).stopped, true)
  assert.equal(assessAction({ ...args, after: { ...after, epoch: 2 } }).stopped, true)
  assert.equal(assessAction({ ...args, after: { ...after, position: { x: 10, y: 80, z: 0 } } }).ok, false)
})
test('structured successful fallback is not failed by an earlier chat warning', () => {
  const after = { ...c, position: { x: 10, y: 64, z: 0 } }
  assert.equal(assessAction({ cmd: 'walk', args: ['10', '64', '0'], before: c, after, outcome: travel, said: ['起飞失败，步行到达'] }).ok, true)
})
test('acknowledgements/model completion without a postcondition remain unknown', () => {
  assert.equal(assessAction({ cmd: 'craft', before: c, after: c, outcome: { ok: true, done: true }, said: ['完成'] }).verification, 'unknown')
  assert.equal(assessAction({ cmd: 'go', before: c, after: c, outcome: { ok: true }, said: ['地点不在当前维度'] }).ok, false)
})
test('task predicates distinguish unknown/unloaded/level mismatch, and 3D conditions', () => {
  const bot = { entity: { position: c.position }, inventory: { items: () => [{ name: 'diamond', count: 2 }] }, registry: { itemsByName: { diamond: {} }, blocksByName: { stone: {}, chest: {} } }, blockAt: () => null }
  const ctx = { bot, dimension: c.dimension }
  assert.equal(verifyCondition({ near: [0, 80, 0], r: 4 }, ctx).state, 'failed')
  assert.equal(verifyCondition({ near: [0, 64, 0], r: 4 }, { ...ctx, expectedDimension: 'example:moon' }).state, 'unknown')
  assert.equal(verifyCondition({ placed: 'chest', at: [0, 64, 0] }, ctx).state, 'unknown')
  assert.equal(verifyCondition({ cleared: ['missing'], r: 1, left: 0 }, ctx).state, 'unknown')
  assert.equal(verifyCondition({ cleared: ['stone'], r: 1, left: 0 }, ctx).state, 'unknown')
  assert.equal(verifyCondition({ item: 'diamond', count: 2 }, ctx).causality, 'condition_only')
})
test('stale action cannot commit memory; storage failure cannot turn a successful action into failure', () => {
  const events = [], bot = { entity: { position: c.position }, inventory: { items: () => [] } }; let context = { ...c }
  const cycle = createAgentCycle({ bot, memory: { observe: (e) => { events.push(e); throw Error('disk failed') }, retrieve: () => '' }, getContext: () => context })
  const before = cycle.capture(); context = { ...context, epoch: 2 }; assert.equal(cycle.finish({ cmd: 'go', before, args: [], outcome: travel }).stopped, true); assert.equal(events.length, 0)
  const next = cycle.capture(); bot.entity.position = { x: 10, y: 64, z: 0 }; const r = cycle.finish({ cmd: 'walk', args: ['10', '64', '0'], before: next, outcome: travel }); assert.equal(r.ok, true); assert.equal(events.length, 1)
})
test('executor landing/arrival contracts survive verification without repeated flights; explicit reached=false wins', () => {
  const target = { x: 10, y: 100, z: 0 }, actual = { x: 5, y: 65, z: 0 }, after = { ...c, position: actual }
  const landed = { ok: true, reached: true, landed: true, position: actual }
  assert.equal(assessAction({ cmd: 'fly', target, before: c, after, outcome: landed }).verification, 'passed')
  assert.equal(assessAction({ cmd: 'goto', target, before: c, after, outcome: { ...landed, kind: 'travel', target } }).verification, 'passed')
  assert.equal(assessAction({ cmd: 'walk', args: ['0', '64', '0'], before: c, after: c, outcome: { ...travel, reached: false } }).ok, false)
})
test('a read-only memory query does not create an episode or dirty the store', () => {
  let writes = 0
  const bot = { entity: { position: c.position }, inventory: { items: () => [] } }, cycle = createAgentCycle({ bot, memory: { observe: () => { writes++ }, retrieve: () => '' }, getContext: () => c })
  cycle.finish({ cmd: 'memories', args: [], before: cycle.capture(), record: false }); assert.equal(writes, 0)
})
