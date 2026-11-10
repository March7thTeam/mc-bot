'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { createFlight } = require('../flight')
const guidance = require('../flight-guidance')
const { createRuntime } = require('../runtime')

const registry = require('minecraft-data')('26.1')
const Item = require('prismarine-item')('26.1')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const air = p => ({ name: 'air', boundingBox: 'empty', shapes: [], position: p })
const solid = (p, name = 'grass_block') => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p })
function rocket(count = 6, data = { flightDuration: 1, explosions: [] }) {
  return Item.fromNotch({ itemId: registry.itemsByName.firework_rocket.id, itemCount: count,
    components: data === null ? [] : [{ type: 'fireworks', data }], removeComponents: [] })
}

function harness(input = {}) {
  let time = 0, cancelled = false, tick = 0
  const bot = new EventEmitter()
  bot.version = input.version || '26.1'
  bot.game = { dimension: 'overworld', gameMode: 'survival', minY: -64 }
  bot.health = 20
  bot.food = 20
  bot.entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0),
    onGround: true, elytraFlying: false, yaw: -Math.PI / 2, pitch: 0 }
  const wings = new Item(registry.itemsByName.elytra.id, 1)
  bot.inventory = { slots: Array(46).fill(null), items: () => bot.inventory.slots.filter(Boolean) }
  bot.inventory.slots[6] = wings
  bot.inventory.slots[10] = rocket(input.rockets ?? 16)
  bot.getEquipmentDestSlot = () => 6
  bot.blockAt = p => input.blockAt ? input.blockAt(p, bot) : p.y < 64 ? solid(p) : air(p)
  bot.controls = {}
  const calls = []
  bot.setControlState = (key, value) => { calls.push(['control', key, value]); bot.controls[key] = value }
  bot.look = async (yaw, pitch) => {
    calls.push(['look', yaw, pitch])
    if (input.look) await input.look(yaw, pitch, h)
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
  }
  bot.equip = async item => {
    calls.push(['equip'])
    if (input.equip) await input.equip(item, h)
    bot.heldItem = input.heldItem === undefined ? item : input.heldItem
  }
  bot.elytraFly = async () => {
    calls.push(['glide'])
    if (input.glide) await input.glide(h)
    if (input.confirm !== false) bot.entity.elytraFlying = true
  }
  bot.activateItem = offhand => {
    calls.push(['rocket', offhand])
    input.activate?.(h)
    if (input.ack !== false) {
      bot.heldItem.count--
      if (input.eventAck !== false) bot.emit('usedFirework', 100)
    }
  }
  const advance = async (ms, safety) => {
    if (input.delay) await input.delay(ms, safety, h)
    await new Promise(setImmediate)
    time += ms
    tick++
    if (input.step) await input.step(h, safety)
    else {
      if (bot.controls.jump && bot.entity.onGround) {
        bot.entity.onGround = false
        bot.entity.position.y = 65
        bot.entity.velocity.y = -0.1
      } else if (flight.status().phase === 'CLIMB' || flight.status().phase === 'CRUISE') {
        bot.entity.position.x += 3
        bot.entity.position.y = Math.min(76, bot.entity.position.y + 0.5)
        bot.entity.velocity.set(0.7, 0, 0)
      } else if (safety && !bot.entity.onGround) {
        // External server observations during final approach. Unit tests do not
        // claim this kinematic fixture validates Minecraft flight aerodynamics.
        bot.entity.position.x = Math.min(80.5, bot.entity.position.x + 3)
        if (bot.entity.position.x >= 80.5) {
          bot.entity.position.y = 64
          bot.entity.velocity.set(0, 0, 0)
          bot.entity.onGround = true
          bot.entity.elytraFlying = false
        }
      }
    }
  }
  const ctx = {
    now: () => time,
    assertActive: () => { if (cancelled) { const error = new Error('cancelled'); error.name = 'CancelledError'; throw error } },
    delay: ms => advance(ms, false), safetyDelay: ms => advance(ms, true),
    safetyLook: async (yaw, pitch) => {
      calls.push(['safetyLook', yaw, pitch])
      assert.equal(flight.status().phase, 'LANDING')
      if (input.safetyLook) await input.safetyLook(yaw, pitch, h)
      bot.entity.yaw = yaw
      bot.entity.pitch = pitch
    },
    safetyGlide: async () => {
      calls.push(['safetyGlide'])
      assert.equal(flight.status().phase, 'LANDING')
      bot.entity.elytraFlying = true
    },
    flightOptions: { takeoffMs: 300, confirmMs: 200, rocketAckMs: 200, maxLandingMs: 3000, ...input.options },
  }
  const flight = createFlight(bot, ctx)
  const h = { bot, flight, ctx, calls, get tick() { return tick }, get time() { return time },
    cancel(reason = 'stop_requested') { flight.requestLand(reason); cancelled = true; bot.controls.jump = false },
    ground(x = bot.entity.position.x) {
      bot.entity.position.set(x, 64, 0.5)
      bot.entity.velocity.set(0, 0, 0)
      bot.entity.onGround = true
      bot.entity.elytraFlying = false
    },
  }
  return h
}

async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(setImmediate) }
  assert.fail('expected observation did not arrive')
}
const goal = { x: 80.5, y: 64, z: 0.5 }

test('assess is read-only and shares actual preflight resource formulas and launch validation', async () => {
  const h = harness(), target = { ...goal }, before = {
    status: h.flight.status(), entity: JSON.stringify(h.bot.entity), slots: [...h.bot.inventory.slots], target: { ...target },
  }
  const assessed = h.flight.assess(target)
  assert.equal(assessed.ok, true)
  assert.equal(assessed.code, 'ready')
  assert.equal(assessed.distance, 80)
  assert.equal(assessed.requiredRockets, Math.ceil(80 / 100) + 4)
  assert.equal(assessed.requiredDurability, Math.ceil(80 / 25) + 60 + guidance.DEFAULTS.durabilityReserve)
  assert.equal(assessed.availableRockets, 16)
  assert.equal(assessed.availableDurability, 432)
  assert.equal(assessed.launch.ok, true)
  assert.equal(assessed.launch.code, 'ready')
  assert.ok(Number.isFinite(assessed.launch.yaw))
  assert.deepEqual(h.flight.status(), before.status)
  assert.equal(JSON.stringify(h.bot.entity), before.entity)
  assert.deepEqual(h.bot.inventory.slots, before.slots)
  assert.deepEqual(target, before.target)
  assert.deepEqual(h.calls, [])
  const freeY = { x: 80.5, z: 0.5 }
  assert.equal(h.flight.assess(freeY).ok, true)
  assert.equal(Object.hasOwn(freeY, 'y'), false)
  assert.equal((await h.flight.fly(target)).ok, true)
  assert.equal(h.flight.status().id, 1)
})

test('assessment and actual preflight agree on insufficient resources without counting worn elytra twice', async () => {
  const h = harness({ rockets: 64 })
  h.bot.inventory.slots[12] = rocket(64)
  const target = { x: 9000.5, y: 64, z: 0.5 }
  const assessed = h.flight.assess(target)
  assert.equal(assessed.distance, 9000)
  assert.equal(assessed.requiredRockets, 94)
  assert.equal(assessed.requiredDurability, 450)
  assert.equal(assessed.availableDurability, 432)
  assert.equal(assessed.code, 'durability_insufficient')
  assert.equal(h.flight.assess(target, { candidateElytra: h.bot.inventory.slots[6] }).availableDurability, 432)
  await assert.rejects(h.flight.fly(target), { code: assessed.code })
  assert.deepEqual(h.calls, [])
})

test('candidate assessment does not mutate slots or double-count a carried replacement; initial reserve stays required', () => {
  const h = harness({ rockets: 64 }), worn = h.bot.inventory.slots[6]
  worn.componentMap.set('damage', { type: 'damage', data: 332 })
  const spare = new Item(registry.itemsByName.elytra.id, 1)
  h.bot.inventory.slots[11] = spare
  h.bot.inventory.slots[12] = rocket(64)
  const target = { x: 11_000.5, y: 64, z: 0.5 }
  assert.equal(h.flight.assess(target).code, 'elytra_missing_or_low_durability')
  const candidate = h.flight.assess(target, { candidateElytra: spare })
  assert.equal(candidate.ok, true)
  assert.equal(candidate.availableDurability, 532)
  assert.equal(candidate.requiredDurability, 530)
  assert.equal(h.bot.inventory.slots[6], worn)
  assert.equal(h.bot.inventory.slots[11], spare)
  h.bot.inventory.slots[6] = spare
  h.bot.inventory.slots[11] = worn
  assert.deepEqual(h.flight.assess(target), candidate)
  h.bot.inventory.slots[6] = { name: 'diamond_chestplate' }
  assert.equal(h.flight.assess(target, { candidateElytra: spare }).code, 'torso_occupied')
  assert.deepEqual(h.calls, [])
})

test('assessment reports blocked local launch but does not require a loaded distant destination', () => {
  const h = harness({ blockAt(p) { return p.x > 20 ? null : p.y < 64 ? solid(p) : air(p) } })
  assert.equal(h.flight.assess({ x: 800.5, y: 64, z: 0.5 }).ok, true)
  h.bot.blockAt = p => p.y < 64 || p.y === 68 ? solid(p) : air(p)
  const blocked = h.flight.assess(goal)
  assert.equal(blocked.code, 'launch_blocked')
  assert.deepEqual(blocked.launch, { ok: false, code: 'launch_blocked', yaw: null })
})

test('protected automatic spare swap lands without overwriting a torso chestplate that changed midflight', async () => {
  const armor = { name: 'diamond_chestplate' }
  let replaced = false
  const h = harness({ step(h, safety) {
    if (safety) h.ground(0.5)
    else if (h.bot.controls.jump) {
      h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1
    } else if (!replaced) { h.bot.inventory.slots[6] = armor; replaced = true }
  } })
  h.bot.inventory.slots[11] = new Item(registry.itemsByName.elytra.id, 1)
  h.bot.equip = async (item, destination) => {
    h.calls.push(['equip', destination])
    if (destination === 'torso') h.bot.inventory.slots[6] = item
    else h.bot.heldItem = item
  }
  const result = await h.flight.fly(goal, { protectTorso: true })
  assert.equal(result.reason, 'torso_changed')
  assert.equal(result.ok, false)
  assert.equal(h.bot.inventory.slots[6], armor)
  assert.equal(h.calls.some(call => call[0] === 'equip' && call[1] === 'torso'), false)
})

test('26.1 actual item components accept only nonexplosive Flight 1 and read component durability', () => {
  assert.equal(guidance.validRocket(rocket(), '26.1'), true)
  for (const data of [{}, { flightDuration: 0, explosions: [] }, { flightDuration: 2, explosions: [] },
    { flightDuration: 3, explosions: [] }, { flightDuration: 1, explosions: [{}] }, { flightDuration: 1 }]) {
    assert.equal(guidance.validRocket(rocket(6, data), '26.1'), false)
  }
  const h = harness()
  const wings = h.bot.inventory.slots[6]
  wings.componentMap.set('damage', { type: 'damage', data: 400 })
  assert.equal(guidance.elytraRemaining(h.bot), 32)
})

test('known 26.1 default component patches accept ordinary rockets; unknown versions never assume defaults', async () => {
  for (const version of ['26.1', '26.1.2']) {
    const ordinary = rocket(32, null)
    assert.deepEqual(ordinary.components, [])
    assert.deepEqual(ordinary.removedComponents, [])
    assert.equal(ordinary.componentMap.size, 0)
    assert.equal(guidance.validRocket(ordinary, version), true)
    const h = harness({ version })
    h.bot.inventory.slots[10] = ordinary
    assert.equal(guidance.rocketCount(h.bot), 32)
    assert.equal((await h.flight.fly(goal)).ok, true)
  }
  for (const version of [undefined, null, '', '26.1.1', '26.1.3', '1.21.11', 'unknown', 775]) {
    assert.equal(guidance.validRocket(rocket(32, null), version), false)
    assert.equal(guidance.validRocket(rocket(), version), false)
  }
})

test('removed, duplicate, mismatched and malformed fireworks patches cannot fall back to defaults', () => {
  for (const data of [null, { flightDuration: 1, explosions: [] }]) {
    for (const removal of [[{ type: 'fireworks' }], [{ type: 'minecraft:fireworks' }], ['fireworks'], [null], [{ type: 69 }]]) {
      const item = rocket(32, data)
      item.removedComponents = removal
      assert.equal(guidance.validRocket(item, '26.1'), false)
    }
  }
  const malformed = []
  const missingMap = rocket(32, null); delete missingMap.componentMap; malformed.push(missingMap)
  const missingRemoved = rocket(32, null); delete missingRemoved.removedComponents; malformed.push(missingRemoved)
  const missingRaw = rocket(32, null); delete missingRaw.components; malformed.push(missingRaw)
  const rawOnly = rocket(); rawOnly.componentMap.clear(); malformed.push(rawOnly)
  const mapOnly = rocket(); mapOnly.components = []; malformed.push(mapOnly)
  const invalidMap = rocket(32, null); invalidMap.componentMap.set('fireworks', undefined); malformed.push(invalidMap)
  const duplicate = rocket(); duplicate.components.push(duplicate.components[0]); malformed.push(duplicate)
  const inconsistent = rocket(); inconsistent.componentMap.set('fireworks', { type: 'fireworks', data: { flightDuration: 1, explosions: [] } }); malformed.push(inconsistent)
  const legacy = rocket(32, null); legacy.nbt = { value: { Fireworks: {} } }; malformed.push(legacy)
  const malformedRaw = rocket(32, null); malformedRaw.components.push({ type: 'fireworks', data: null }); malformed.push(malformedRaw)
  for (const item of malformed) assert.equal(guidance.validRocket(item, '26.1'), false)
})

// 只在这个隔离模块里放开版本门，验证将来人工加白名单后的格式分支；生产白名单不变。
function probeGuidance() {
  const fs = require('node:fs'), vm = require('node:vm'), filename = require.resolve('../flight-guidance')
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Map, require: (name) => name === './versions'
    ? { ...require('../versions'), flightVerified: () => true } : require(name) }, { filename })
  return module.exports
}
function nbtRocket(version, flight = 1, explosions) {
  return { name: version === '1.12.2' || version === '1.8.8' ? 'fireworks' : 'firework_rocket', count: 2,
    nbt: { type: 'compound', ...(version === '1.12.2' ? { name: '' } : {}), value: { Fireworks: { type: 'compound', value: {
      Flight: { type: 'byte', value: flight }, ...(explosions === undefined ? {} : { Explosions: explosions }),
    } } } } }
}

for (const version of ['1.8.8', '1.12.2']) {
  test(`${version} 实测形状的 NBT 只认时长 1 和无爆炸，生产版本门保持关闭`, () => {
    const probe = probeGuidance(), ordinary = nbtRocket(version), empty = { type: 'list', value: { type: 'compound', value: [] } }
    assert.equal(probe.validRocket(ordinary, version), true)
    assert.equal(probe.validRocket(nbtRocket(version, 1, empty), version), true)
    assert.equal(probe.validRocket(nbtRocket(version, 1, { type: 'list', value: { type: 'end', value: [] } }), version), true)
    assert.equal(guidance.validRocket(ordinary, version), false)
    assert.equal(guidance.rocketCount({ version, inventory: { items: () => [ordinary] } }), 0)
    for (const flight of [0, 2, 3, '1', null, NaN]) assert.equal(probe.validRocket(nbtRocket(version, flight), version), false)
    for (const explosions of [null, {}, [], { type: 'list', value: [] }, { type: 'list', value: { type: 'compound', value: [{}] } },
      { type: 'list', value: { type: 'compound', value: [{ Type: { type: 'byte', value: 0 } }] } }]) {
      assert.equal(probe.validRocket(nbtRocket(version, 1, explosions), version), false)
    }
    for (const nbt of [null, 1, [], {}, { value: null }, { type: 'compound', value: { Fireworks: null } },
      { type: 'compound', value: { Fireworks: { type: 'compound', value: { Flight: { type: 'string', value: 1 } } } } }]) {
      assert.equal(probe.validRocket({ ...ordinary, nbt }, version), false)
    }
    assert.equal(probe.validRocket({ ...ordinary, name: ordinary.name === 'fireworks' ? 'firework_rocket' : 'fireworks' }, version), false)
    for (const count of [0, -1, 65, 1.5, '2', NaN]) assert.equal(probe.validRocket({ ...ordinary, count }, version), false)
  })
}

for (const version of ['1.16.5', '1.20.4']) {
  test(`${version} 的真实 NBT Slot 只认显式时长 1 和无爆炸`, () => {
    const data = require('minecraft-data')(version), VersionItem = require('prismarine-item')(version)
    const makeRocket = nbtData => VersionItem.fromNotch({ present: true, itemId: data.itemsByName.firework_rocket.id, itemCount: 2, nbtData })
    const valid = makeRocket(nbtRocket(version).nbt)
    assert.equal(guidance.validRocket(valid, version), true)
    assert.equal(guidance.rocketCount({ version, inventory: { items: () => [valid] } }), 2)
    assert.equal(guidance.validRocket(makeRocket(null), version), false)
    assert.equal(guidance.validRocket(makeRocket(nbtRocket(version, 2).nbt), version), false)
    const explosive = { type: 'list', value: { type: 'compound', value: [{}] } }
    assert.equal(guidance.validRocket(makeRocket(nbtRocket(version, 1, explosive).nbt), version), false)
  })
}

test('1.21.4 原版组件空补丁和显式时长 1 可以使用，其余时长或爆炸拒绝', () => {
  const version = '1.21.4', data = require('minecraft-data')(version), VersionItem = require('prismarine-item')(version)
  const makeRocket = (fireworks) => VersionItem.fromNotch({ itemId: data.itemsByName.firework_rocket.id, itemCount: 2,
    components: fireworks ? [{ type: 'fireworks', data: fireworks }] : [], removeComponents: [] })
  assert.equal(guidance.validRocket(makeRocket(), version), true)
  assert.equal(guidance.validRocket(makeRocket({ flightDuration: 1, explosions: [] }), version), true)
  assert.equal(guidance.validRocket(makeRocket({ flightDuration: 3, explosions: [] }), version), false)
  assert.equal(guidance.validRocket(makeRocket({ flightDuration: 1, explosions: [{}] }), version), false)
  assert.equal(guidance.validRocket(nbtRocket('1.20.4'), '26.1'), false)
})

test('native flight performs confirmed takeoff, awaits equip, uses hand rocket and resolves only after stable landing', async () => {
  const h = harness()
  const outcome = await h.flight.fly(goal)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reached, true)
  assert.equal(outcome.landed, true)
  assert.equal(outcome.reason, 'arrival')
  assert.ok(outcome.rocketsUsed >= 1 && outcome.rocketsUsed <= 6)
  assert.ok(outcome.durationMs > 0)
  assert.equal(h.flight.active(), false)
  const order = h.calls.map(c => c[0])
  assert.ok(order.indexOf('glide') < order.indexOf('equip'))
  assert.ok(order.indexOf('equip') < order.indexOf('rocket'))
  assert.ok(h.calls.filter(c => c[0] === 'rocket').every(c => c[1] === false))
  assert.equal(h.bot.listenerCount('usedFirework'), 0)
  // A completed instance is reusable; no interval or old event listener remains.
  h.ground(0.5)
  const again = await h.flight.fly(goal)
  assert.equal(again.ok, true)
  assert.equal(h.flight.status().id, 2)
})

test('preflight fails closed when no launch direction is clear or the air above is blocked', async t => {
  for (const kind of ['unknown_launch', 'roof', 'wing_obstacle']) {
    await t.test(kind, async () => {
      const h = harness({ blockAt(p) {
        if (kind === 'unknown_launch' && p.y >= 64 && Math.hypot(p.x, p.z) >= 5) return null
        if (kind === 'roof' && p.y === 68 && Math.abs(p.x) <= 2) return solid(p)
        if (kind === 'wing_obstacle' && p.x === 2 && p.z === 2 && p.y === 67) return solid(p)
        return p.y < 64 ? solid(p) : air(p)
      } })
      await assert.rejects(h.flight.fly(goal), /预检|走廊/)
      assert.equal(h.flight.active(), false)
      assert.equal(h.calls.length, 0)
    })
  }
})

test('takeoff does not depend on a verified runway under the bot: rough landing covers it', async () => {
  const h = harness({ blockAt(p) { return p.y === 63 ? solid(p, 'oak_leaves') : p.y < 64 ? solid(p) : air(p) } })
  const pending = h.flight.fly(goal)
  await until(() => h.flight.status().phase !== 'PREFLIGHT')
  h.cancel('test_complete')
  h.ground()
  assert.equal((await pending).reached, false)
})

test('grass does not block a corridor; water and hazards still do', () => {
  const grass = harness({ blockAt(p) { return p.y === 64 ? { name: 'short_grass', boundingBox: 'empty', position: p } : p.y < 64 ? solid(p) : air(p) } })
  assert.equal(guidance.scanCorridor(grass.bot, new Vec3(0.5, 64, 0.5), -Math.PI / 2, 0, guidance.DEFAULTS, 8).clear, true)
  assert.ok(guidance.landingSite(grass.bot, new Vec3(0.5, 66, 0.5), -Math.PI / 2, guidance.DEFAULTS))
  const water = harness({ blockAt(p) { return p.y === 64 ? { name: 'water', boundingBox: 'empty', position: p } : p.y < 64 ? solid(p) : air(p) } })
  assert.equal(guidance.scanCorridor(water.bot, new Vec3(0.5, 64, 0.5), -Math.PI / 2, 0, guidance.DEFAULTS, 8).clear, false)
})

test('preflight requires overworld survival, health/food, worn durable elytra and enough verified rockets', async t => {
  const cases = [
    ['dimension', h => { h.bot.game.dimension = 'the_nether' }],
    ['mode', h => { h.bot.game.gameMode = 'creative' }],
    ['health', h => { h.bot.health = 15 }],
    ['food', h => { h.bot.food = 13 }],
    ['water', h => { h.bot.entity.isInWater = true }],
    ['fire', h => { h.bot.entity.isOnFire = true }],
    ['chestplate', h => { h.bot.inventory.slots[6] = { name: 'diamond_chestplate' } }],
    ['durability', h => { h.bot.inventory.slots[6].componentMap.set('damage', { type: 'damage', data: 420 }) }],
    ['unknown durability', h => { h.bot.inventory.slots[6] = { name: 'elytra', maxDurability: 432 } }],
    ['rockets', h => { h.bot.inventory.slots[10] = rocket(1) }],
    ['malformed rockets', h => { h.bot.inventory.slots[10] = rocket(6, {}) }],
    ['unknown version', h => { h.bot.version = 'unknown' }],
  ]
  for (const [name, change] of cases) await t.test(name, async () => {
    const h = harness(); change(h)
    await assert.rejects(h.flight.fly(goal))
    assert.equal(h.calls.length, 0)
  })
})

test('unloaded destination is permissible only while the known forward corridor and runway reserve remain safe', async () => {
  const h = harness({ blockAt(p) { return p.x > 40 ? null : p.y < 64 ? solid(p) : air(p) } })
  const pending = h.flight.fly(goal)
  await until(() => h.flight.status().phase === 'LANDING')
  assert.match(h.flight.status().reason, /corridor_unsafe|chunks_not_loading|unsafe_body_block/)
  h.ground(15.5)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reached, false)
})

test('partly loaded runway remains unknown even when its center is loaded; a known hazard is still unsafe', () => {
  let hazard = false
  const h = harness({ blockAt(p) {
    if (p.x === 305 && p.y === 63) return null
    if (hazard && p.x === 295 && p.y === 63) return { name: 'lava', boundingBox: 'empty' }
    return p.y < 64 ? solid(p) : air(p)
  } })
  const target = { x: 300.5, y: 64, z: 0.5 }
  assert.ok(h.bot.blockAt(new Vec3(300, 64, 0)))
  const unknown = guidance.landingSurvey(h.bot, target, -Math.PI / 2, guidance.DEFAULTS)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.site, null)
  assert.equal(guidance.landingSite(h.bot, target, -Math.PI / 2, guidance.DEFAULTS), null)
  hazard = true
  assert.equal(guidance.landingSurvey(h.bot, target, -Math.PI / 2, guidance.DEFAULTS).status, 'unsafe')
})

test('a distant center-loaded destination does not falsely abort or become verified before its entire runway loads', async () => {
  let fullyLoaded = false
  const h = harness({ blockAt(p) {
    if (!fullyLoaded && p.x >= 240 && p.y === 63) return null
    return p.y < 64 ? solid(p) : air(p)
  }, step(h, safety) {
    if (safety) h.ground(108.5)
    else if (h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    else { h.bot.entity.position.set(108.5, 84.1, 0.5); h.bot.entity.velocity.set(1.57, -0.15, 0) }
  } })
  const pending = h.flight.fly({ x: 300.5, y: 64, z: 0.5 })
  await until(() => h.flight.status().phase === 'CRUISE')
  const tick = h.tick
  await until(() => h.tick >= tick + 4)
  assert.equal(h.flight.status().phase, 'CRUISE')
  assert.equal(h.flight.status().destinationState, 'unknown')
  assert.equal(h.flight.status().reason, null)
  fullyLoaded = true
  await until(() => h.flight.status().destinationState === 'safe')
  h.cancel('test_complete')
  assert.equal((await pending).reached, false)
})

test('a runway still unverified at approach distance causes fallback landing and never arrival success', async () => {
  const h = harness({ blockAt(p) {
    if (p.x === 305 && p.y === 63) return null
    return p.y < 64 ? solid(p) : air(p)
  }, step(h, safety) {
    if (safety) h.ground(250.5)
    else if (h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    else { h.bot.entity.position.set(250.5, 76.1, 0.5); h.bot.entity.velocity.set(1.57, -0.15, 0) }
  } })
  const result = await h.flight.fly({ x: 300.5, y: 64, z: 0.5 })
  // 目标跑道缺一列时会就近换一块验证过的；落在备降点上（离目标 50 格）也不算到达
  assert.equal(result.reached, false)
  assert.equal(result.ok, false)
  assert.equal(result.landed, true)
})

test('sustained high-speed descent receives altitude feedback and a cooled-down recovery boost', async () => {
  const boosts = [], cruisePitches = []
  // Observed 26.1.2 regression trajectory: x108/y72.1, vx1.57/vy-0.15.
  // Reproduce its still-high horizontal speed beyond the 3s cooldown, so a
  // speed-only boost gate cannot satisfy this regression.
  const h = harness({ activate(h) { boosts.push({ at: h.time, speed: guidance.speed(h.bot) }) },
    look(_yaw, pitch, h) { if (h.flight.status().phase === 'CRUISE') cruisePitches.push(pitch) },
    step(h, safety) {
      if (safety) h.ground()
      else if (h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
      else if (h.flight.status().phase === 'CLIMB') {
        h.bot.entity.position.set(108.5, 84.1, 0.5)
        h.bot.entity.velocity.set(1.57, -0.15, 0)
      } else {
        h.bot.entity.position.x += 0.5
        h.bot.entity.position.y = 72.1
        h.bot.entity.velocity.set(1.57, -0.15, 0)
      }
    },
  })
  const pending = h.flight.fly({ x: 300.5, y: 64, z: 0.5 })
  await until(() => boosts.length >= 2)
  assert.equal(h.flight.status().phase, 'CRUISE')
  assert.ok(cruisePitches.some(pitch => pitch >= 0.20))
  assert.ok(boosts[1].speed > 0.8)
  const cooldown = h.ctx.flightOptions.boostCooldownMs ?? guidance.DEFAULTS.boostCooldownMs
  assert.ok(boosts[1].at - boosts[0].at >= cooldown)
  assert.equal(boosts.length, 2)
  h.cancel('altitude_regression_complete')
  const result = await pending
  assert.equal(result.rocketsUsed, 2)
  assert.equal(result.reached, false)
})

test('no gliding confirmation means no rocket, and landing far from target cannot count as success', async () => {
  const h = harness({ confirm: false, step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    if (safety) h.ground(0.5)
  } })
  const result = await h.flight.fly(goal)
  assert.equal(result.reason, 'takeoff_unconfirmed')
  assert.deepEqual(h.calls.filter(c => c[0] === 'rocket'), [])
  assert.equal(result.ok, false)
  assert.equal(result.reached, false)
  assert.equal(result.landed, true)
})

test('missing rocket acknowledgement aborts after a single bounded attempt, without click retries', async () => {
  const h = harness({ ack: false, step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    if (safety) h.ground(0.5)
  } })
  const result = await h.flight.fly(goal)
  assert.equal(result.reason, 'rocket_unconfirmed')
  assert.equal(result.rocketsUsed, 1)
  assert.equal(h.calls.filter(c => c[0] === 'rocket').length, 1)
  assert.equal(h.bot.listenerCount('usedFirework'), 0)
})

test('inventory count acknowledgement works when no usedFirework entity event arrives', async () => {
  const h = harness({ eventAck: false })
  assert.equal((await h.flight.fly(goal)).ok, true)
})

test('the actually equipped hand component is checked after equip, even if a valid stack was selected', async () => {
  const h = harness({ heldItem: rocket(6, { flightDuration: 3, explosions: [] }), step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    if (safety) h.ground(0.5)
  } })
  const result = await h.flight.fly(goal)
  assert.equal(result.reason, 'held_rocket_unverified')
  assert.equal(result.rocketsUsed, 0)
})

test('a default rocket selected from inventory cannot authorize a removed component in the actual hand', async () => {
  const removed = rocket(32, null)
  removed.removedComponents = [{ type: 'fireworks' }]
  const h = harness({ heldItem: removed, step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    if (safety) h.ground(0.5)
  } })
  h.bot.inventory.slots[10] = rocket(32, null)
  const result = await h.flight.fly(goal)
  assert.equal(result.reason, 'held_rocket_unverified')
  assert.equal(result.rocketsUsed, 0)
  assert.equal(h.calls.some(c => c[0] === 'rocket'), false)
})

test('stop during equip or look await blocks every subsequent rocket and repeated stop preserves first reason', async t => {
  for (const stage of ['equip', 'look']) await t.test(stage, async () => {
    const gate = deferred(), entered = deferred()
    const h = harness({ [stage]: async () => { entered.resolve(); await gate.promise }, step(h, safety) {
      if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
      if (safety) h.ground(0.5)
    } })
    const pending = h.flight.fly(goal)
    await entered.promise
    h.cancel('first_stop')
    h.flight.requestLand('second_stop')
    assert.equal(h.flight.active(), true)
    await assert.rejects(h.flight.fly(goal), /等待确认落地/)
    gate.resolve()
    const result = await pending
    assert.equal(result.reason, 'first_stop')
    assert.equal(result.rocketsUsed, 0)
    assert.equal(result.ok, false)
  })
})

test('stop during takeoff delay aborts before glide and before boost', async () => {
  let stopped = false
  const h = harness({ delay(_ms, safety, h) {
    if (!safety && !stopped) { stopped = true; h.cancel('stop_takeoff') }
  }, step(h, safety) { if (safety) h.ground(0.5) } })
  const result = await h.flight.fly(goal)
  assert.equal(result.reason, 'stop_takeoff')
  assert.equal(h.calls.some(c => c[0] === 'glide' || c[0] === 'rocket'), false)
})

test('stop during server rocket acknowledgement never fires again and removes the old receipt listener', async () => {
  const h = harness({ ack: false, delay(_ms, safety, h) {
    if (!safety && h.calls.some(c => c[0] === 'rocket')) h.cancel('stop_ack')
  }, step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    if (safety) h.ground(0.5)
  } })
  const result = await h.flight.fly(goal)
  assert.equal(result.reason, 'stop_ack')
  assert.equal(result.rocketsUsed, 1)
  assert.equal(h.calls.filter(c => c[0] === 'rocket').length, 1)
  h.bot.emit('usedFirework', 999)
  assert.equal(h.bot.listenerCount('usedFirework'), 0)
})

test('midflight health/equipment changes trigger landing and never add a rocket', async t => {
  for (const changed of ['health', 'elytra']) await t.test(changed, async () => {
    let replaced = false
    const h = harness({ step(h, safety) {
      if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
      else if (!safety && !replaced) {
        if (changed === 'health') h.bot.health = 12
        else h.bot.inventory.slots[6] = { name: 'diamond_chestplate' }
        replaced = true
      }
      if (safety) h.ground(0.5)
    } })
    const result = await h.flight.fly(goal)
    assert.match(result.reason, /health|elytra/)
    assert.ok(result.rocketsUsed <= 1)
    assert.equal(result.reached, false)
  })
})

test('landing timeout becomes passive and keeps active/Promise pending until low-speed stable ground', async () => {
  const h = harness({ options: { maxLandingMs: 150 }, step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
    else if (!safety) h.cancel('stop_airborne')
  } })
  let settled = false
  const pending = h.flight.fly(goal).then(r => { settled = true; return r })
  await until(() => h.flight.status().phase === 'UNCONFIRMED_AIRBORNE')
  const controls = h.calls.length
  await until(() => h.tick > 20)
  assert.equal(h.calls.length, controls)
  assert.equal(h.flight.active(), true)
  assert.equal(settled, false)
  h.bot.entity.onGround = true
  h.bot.entity.velocity.set(0.5, 0, 0)
  await until(() => h.tick > 30)
  assert.equal(settled, false)
  h.ground(8.5)
  const result = await pending
  assert.equal(result.reason, 'landing_timeout')
  assert.equal(result.ok, false)
  assert.equal(h.flight.active(), false)
})

test('dispose invalidates pending waits/old callbacks permanently and does not revive after death', async () => {
  const gate = deferred(), entered = deferred()
  const h = harness({ equip: async () => { entered.resolve(); await gate.promise } })
  const pending = h.flight.fly(goal)
  await entered.promise
  h.flight.dispose('death')
  assert.equal(h.flight.active(), false)
  assert.equal(h.flight.status().phase, 'DISPOSED')
  gate.resolve()
  const result = await pending
  assert.equal(result.reason, 'death')
  assert.equal(result.landed, false)
  assert.equal(result.rocketsUsed, 0)
  h.bot.emit('usedFirework', 999)
  await assert.rejects(h.flight.fly(goal), /已销毁/)
  assert.equal(h.calls.some(c => c[0] === 'rocket' || c[0] === 'safetyLook'), false)
})

test('runtime task lock survives cancellation while landing safety uses the constrained path', async () => {
  const runtime = createRuntime()
  const h = harness({ step(h, safety) {
    if (!safety && h.bot.controls.jump) { h.bot.entity.onGround = false; h.bot.entity.position.y = 65; h.bot.entity.velocity.y = -0.1 }
  } })
  let flight
  flight = createFlight(h.bot, {
    ...h.ctx, assertActive: runtime.assertActive,
    delay: async ms => { runtime.assertActive(); await h.ctx.delay(ms); runtime.assertActive() },
    safetyLook: async () => { assert.equal(flight.status().phase, 'LANDING') },
    safetyGlide: async () => { assert.equal(flight.status().phase, 'LANDING') },
  })
  runtime.guardBot(h.bot)
  const pending = runtime.runTask('fly', () => flight.fly(goal))
  await until(() => h.calls.some(c => c[0] === 'rocket'))
  flight.requestLand('stop_runtime')
  runtime.cancel()
  await until(() => flight.status().phase === 'LANDING')
  assert.equal(runtime.busy(), true)
  assert.equal(flight.active(), true)
  await assert.rejects(runtime.runTask('other', async () => {}), /收尾/)
  h.ground(3.5)
  await assert.rejects(pending, /取消/)
  assert.equal(runtime.busy(), false)
  assert.equal(flight.active(), false)
})

test('geometry uses Minecraft yaw and bounded angular steering without touching physics state', () => {
  assert.equal(guidance.yawTo({ x: 0, z: 0 }, { x: 10, z: 0 }), -Math.PI / 2)
  assert.equal(Math.abs(guidance.yawTo({ x: 0, z: 0 }, { x: 0, z: 10 })), Math.PI)
  assert.ok(guidance.angleDiff(-Math.PI + 0.01, Math.PI - 0.01) < 0.021)
  const h = harness()
  h.bot.entity.position.y = 75
  h.bot.entity.velocity.set(1, -0.2, 0)
  const before = { position: h.bot.entity.position.clone(), velocity: h.bot.entity.velocity.clone() }
  const guide = guidance.landingGuidance(h.bot, { x: 10, y: 64, z: 10 }, guidance.DEFAULTS)
  assert.ok(guidance.angleDiff(guide.yaw, h.bot.entity.yaw) <= guidance.DEFAULTS.maxYawStep + 1e-12)
  assert.deepEqual(h.bot.entity.position, before.position)
  assert.deepEqual(h.bot.entity.velocity, before.velocity)
})
