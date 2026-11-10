'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { createAutoTravel, POLICY } = require('../auto-travel')
const { createFlight } = require('../flight')
const { createRuntime, CancelledError } = require('../runtime')
const registry = require('minecraft-data')('26.1')
const Item = require('prismarine-item')('26.1')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const wing = (remaining = 432) => ({ name: 'elytra', maxDurability: 432, durabilityUsed: 432 - remaining, count: 1 })
const near = { x: 20.5, y: 64, z: 0.5 }, mid = { x: 60.5, y: 64, z: 0.5 }, far = { x: 300.5, y: 64, z: 0.5 }
const rocket = count => Item.fromNotch({ itemId: registry.itemsByName.firework_rocket.id, itemCount: count,
  components: [{ type: 'fireworks', data: { flightDuration: 1, explosions: [] } }], removeComponents: [] })
const air = p => ({ name: 'air', boundingBox: 'empty', shapes: [], position: p })
const ground = p => ({ name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p })

function harness(input = {}) {
  let cancelled = false, engine
  const calls = []
  const bot = { version: '26.1.2', health: 20, food: 20,
    game: { dimension: 'overworld', gameMode: 'survival', minY: -64 },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      elytraFlying: false, yaw: -Math.PI / 2, pitch: 0 },
    getEquipmentDestSlot: () => 6,
    blockAt: p => input.blockAt ? input.blockAt(p) : p.y < 64 ? ground(p) : air(p) }
  bot.inventory = { slots: Array(46).fill(null), items: () => bot.inventory.slots.slice(9).filter(Boolean) }
  bot.inventory.slots[6] = input.torso === undefined ? wing() : input.torso
  if ((input.rockets ?? 32) > 0) bot.inventory.slots[10] = rocket(input.rockets ?? 32)
  if (input.spare) bot.inventory.slots[11] = input.spare
  const assertActive = () => { if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'CancelledError' }) }
  const createEngine = () => createFlight(bot, { assertActive, delay: async () => {}, safetyDelay: async () => {},
    safetyLook: async () => {}, safetyGlide: async () => {} })
  engine = createEngine()
  const ctx = { assertActive, delay: async () => {}, getFlight: () => engine,
    ready: () => input.ready ? input.ready(h) : { ok: true },
    say: text => { calls.push(['say', text]); return input.say?.(h) },
    walk: async (target, range) => {
      calls.push(['walk', { ...target }, range])
      if (input.walk) return input.walk(target, h)
      bot.entity.position.set(target.x, target.y, target.z)
    },
    fly: async (target, options) => {
      calls.push(['fly', { ...target }, options])
      if (input.fly) return input.fly(target, h)
      bot.entity.position.set(target.x, target.y, target.z)
      return { ok: true, reached: true, landed: true, reason: 'arrival', rocketsUsed: 2, flightLegs: 1 }
    } }
  bot.equip = async (item, destination) => {
    calls.push(['equip', item, destination])
    if (input.equip) return input.equip(item, h)
    const old = bot.inventory.slots[6], index = bot.inventory.slots.indexOf(item)
    if (index >= 9) bot.inventory.slots[index] = old
    bot.inventory.slots[6] = item
  }
  if (input.arrived) ctx.arrived = (target, range) => input.arrived(target, range, h)
  const travel = createAutoTravel(bot, ctx)
  const h = { bot, ctx, travel, calls, createEngine, get engine() { return engine }, setEngine(next) { engine = next },
    cancel() { cancelled = true }, ground(target) { bot.entity.position.set(target.x, target.y, target.z);
      bot.entity.velocity.set(0, 0, 0); bot.entity.onGround = true; bot.entity.elytraFlying = false } }
  return h
}

test('near destinations walk without an assessment, equipment write or rocket; force walk also covers long routes', async () => {
  const h = harness()
  h.engine.assess = () => { assert.fail('near trip must not assess flight') }
  const result = await h.travel.travelTo(near)
  assert.equal(result.ok, true)
  assert.equal(result.transport, 'walk')
  assert.equal(result.reason, 'near_distance')
  assert.equal(result.rocketsUsed, 0)
  assert.deepEqual(h.calls.map(c => c[0]), ['say', 'walk'])
  h.ground({ x: 0.5, y: 64, z: 0.5 })
  assert.equal((await h.travel.travelTo(far, { mode: 'walk', range: 1 })).reason, 'forced_walk')
})

test('reaching identical XYZ in a different dimension cannot complete travel', async () => {
  const h = harness({ walk(target, h) { h.ground(target); h.bot.game.dimension = 'the_nether' } })
  await assert.rejects(h.travel.travelTo(near), { code: 'dimension_changed' })
  assert.equal(h.travel.status().last, null)
  const result = await h.travel.travelTo(near)
  assert.equal(result.ok, true)
  assert.equal(result.dimension, 'the_nether')
})

test('long trips choose native flight with protected automatic multi-leg options and cumulative receipts', async () => {
  const h = harness({ fly(target, h) {
    h.ground(target)
    return { ok: true, landed: true, reason: 'arrival', rocketsUsed: 8, flightLegs: 3 }
  } })
  const result = await h.travel.travelTo(far)
  assert.equal(result.ok, true)
  assert.equal(result.transport, 'fly')
  assert.equal(result.reason, 'long_distance')
  assert.equal(result.rocketsUsed, 8)
  assert.equal(result.flightLegs, 3)
  assert.deepEqual(h.calls.find(c => c[0] === 'fly')[2], { automatic: true, protectTorso: true, reportFinal: false, maxLegs: 8 })
  assert.equal(h.calls.filter(c => c[0] === 'say').length, 1)
})

test('low rockets, low durability, missing wings and ordinary torso armor all choose walking', async t => {
  for (const [name, input, code] of [
    ['rockets', { rockets: 1 }, 'rockets_insufficient'],
    ['durability', { torso: wing(100) }, 'elytra_missing_or_low_durability'],
    ['missing', { torso: null }, 'elytra_missing_or_low_durability'],
    ['armor with spare', { torso: { name: 'diamond_chestplate' }, spare: wing() }, 'torso_occupied'],
  ]) await t.test(name, async () => {
    const h = harness(input), result = await h.travel.travelTo(far)
    assert.equal(result.transport, 'walk')
    assert.equal(result.ok, true)
    assert.equal(result.fallbackReason, code)
    assert.equal(result.flightAttempts, 0)
    assert.equal(result.reason, 'preflight_walk')
    assert.match(h.calls.find(c => c[0] === 'say')[1], /选择步行/)
    assert.doesNotMatch(h.calls.find(c => c[0] === 'say')[1], /使用鞘翅/)
    assert.equal(h.calls.some(c => ['fly', 'equip'].includes(c[0])), false)
  })
})

test('a zero-leg second preflight failure records an attempt but reports only the walking actually performed', async t => {
  for (const reason of ['rockets_insufficient', 'durability_insufficient', 'elytra_missing_or_low_durability']) {
    await t.test(reason, async () => {
      const h = harness({ fly() { return { ok: false, landed: true, reason, rocketsUsed: 0, flightLegs: 0 } },
        walk(target, h) { h.ground(target); h.bot.entity.velocity.x = 0.2 } })
      const result = await h.travel.travelTo(far)
      assert.equal(result.ok, true)
      assert.equal(result.transport, 'walk')
      assert.equal(result.modeChosen, 'walk')
      assert.equal(result.flightAttempts, 1)
      assert.equal(result.flightLegs, 0)
      assert.equal(result.rocketsUsed, 0)
      assert.equal(result.fallbackReason, reason)
      assert.equal(result.reason, 'preflight_walk')
      assert.equal(h.calls.filter(c => c[0] === 'fly').length, 1)
      assert.equal(h.calls.filter(c => c[0] === 'walk').length, 1)
    })
  }
  await t.test('missing flight counters do not turn a resource rejection into a flown leg', async () => {
    const h = harness({ fly() { return { landed: true, reason: 'rockets_insufficient' } } })
    const result = await h.travel.travelTo(far)
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'walk')
    assert.equal(result.flightLegs, 0)
  })
})

test('empty torso safely equips a verified carried elytra and rechecks actual preflight', async () => {
  const spare = wing(), h = harness({ torso: null, spare })
  const original = h.engine.assess
  const assessed = []
  h.engine.assess = (target, options) => { assessed.push(options?.candidateElytra || null); return original(target, options) }
  const result = await h.travel.travelTo(far)
  assert.equal(result.ok, true)
  assert.equal(result.transport, 'fly')
  assert.equal(h.bot.inventory.slots[6], spare)
  assert.equal(h.calls.filter(c => c[0] === 'equip').length, 1)
  assert.deepEqual(assessed, [null, spare, null])
})

test('medium unknown terrain stays walking; far unknown destinations retain native flight', async () => {
  const unknown = p => p.x >= 20 ? null : p.y < 64 ? ground(p) : air(p)
  const h = harness({ blockAt: unknown })
  assert.equal((await h.travel.travelTo(mid)).transport, 'walk')
  h.ground({ x: 0.5, y: 64, z: 0.5 })
  assert.equal((await h.travel.travelTo(far)).transport, 'fly')
})

test('only confirmed loaded local water and elevation barriers promote medium trips to flight', async t => {
  for (const kind of ['water_barrier', 'elevation_change']) await t.test(kind, async () => {
    let furthest = 0
    const h = harness({ blockAt(p) {
      furthest = Math.max(furthest, Math.hypot(p.x - 0.5, p.z - 0.5))
      if (p.x >= 24 && p.x <= 48) {
        if (kind === 'water_barrier' && p.y === 63) return { name: 'water', boundingBox: 'empty' }
        if (kind === 'elevation_change') return p.y < 71 ? ground(p) : air(p)
      }
      return p.y < 64 ? ground(p) : air(p)
    } })
    const result = await h.travel.travelTo(mid)
    assert.equal(result.transport, 'fly')
    assert.equal(result.reason, kind)
    assert.ok(furthest <= POLICY.terrainRadius + 1)
  })
})

test('a blocked underground launch chooses walking even for a distant destination', async () => {
  const h = harness({ blockAt: p => p.y < 64 || p.y >= 68 ? ground(p) : air(p) })
  const result = await h.travel.travelTo(far)
  assert.equal(result.transport, 'walk')
  assert.equal(result.fallbackReason, 'launch_blocked')
  assert.equal(h.calls.some(c => c[0] === 'fly'), false)
})

test('recoverable stable landing gets exactly one pure walking finish and preserves flight counters', async () => {
  const h = harness({ fly(target, h) {
    h.ground({ ...target, x: target.x - 30 })
    return { ok: false, landed: true, reason: 'corridor_unsafe', rocketsUsed: 3, flightLegs: 2 }
  } })
  const result = await h.travel.travelTo(far)
  assert.equal(result.ok, true)
  assert.equal(result.transport, 'hybrid')
  assert.equal(result.fallbackReason, 'corridor_unsafe')
  assert.equal(result.rocketsUsed, 3)
  assert.equal(result.flightLegs, 2)
  assert.equal(h.calls.filter(c => c[0] === 'walk').length, 1)
})

test('a confirmed stable landing followed by walking can arrive with ordinary walking momentum', async t => {
  await t.test('automatic pure walking finish', async () => {
    const h = harness({ fly(target, h) {
      h.ground({ ...target, x: target.x - 30 })
      return { landed: true, reason: 'corridor_unsafe', rocketsUsed: 2, flightLegs: 1 }
    }, walk(target, h) { h.ground(target); h.bot.entity.velocity.x = 0.2 } })
    const result = await h.travel.travelTo(far)
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'hybrid')
    assert.equal(result.modeChosen, 'fly')
    assert.equal(result.flightAttempts, 1)
    assert.equal(result.flightLegs, 1)
    assert.equal(h.bot.entity.velocity.x, 0.2)
  })
  await t.test('native walking finish receipt', async () => {
    const h = harness({ fly(target, h) {
      h.ground(target); h.bot.entity.velocity.x = 0.2
      return { ok: true, landed: true, reason: 'hybrid_arrival', finalApproach: 'walk', rocketsUsed: 2, flightLegs: 1 }
    } })
    const result = await h.travel.travelTo(far)
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'hybrid')
    assert.equal(h.calls.some(c => c[0] === 'walk'), false)
  })
})

test('hybrid walks wait for the final jump within the existing arrival tolerances', async t => {
  for (const native of [true, false]) await t.test(native ? 'native finish' : 'fallback walk', async t => {
    const jump = (target, h) => {
      h.ground({ ...target, y: target.y + 0.8 })
      h.bot.entity.onGround = false
    }
    const input = { fly(target, h) {
      if (native) jump(target, h)
      else h.ground({ ...target, x: target.x - 30 })
      return { landed: true, reason: native ? 'hybrid_arrival' : 'corridor_unsafe',
        finalApproach: native ? 'walk' : undefined, flightLegs: 1, rocketsUsed: 2 }
    }, walk: jump }
    for (const state of ['target', 'outside', 'airborne']) await t.test(state, async t => {
      const h = harness(input)
      let elapsed = 0
      t.mock.method(Date, 'now', () => 1000 + elapsed)
      h.ctx.delay = async ms => {
        elapsed += ms
        if (elapsed >= 150 && state !== 'airborne') h.ground({ ...far, y: far.y + (state === 'outside' ? 5 : 0) })
      }
      const result = await h.travel.travelTo(far)
      assert.equal(result.ok, state === 'target')
      assert.equal(result.rocketsUsed, 2)
      const expected = state === 'airborne' ? 2000 : native && state === 'outside' ? 200 : 150
      assert.equal(elapsed, expected)
    })
    await t.test('stop', { timeout: 1000 }, async () => {
      const h = harness(input), runtime = createRuntime(), waiting = deferred()
      h.ctx.assertActive = runtime.assertActive
      h.ctx.delay = ms => { waiting.resolve(); return runtime.delay(ms) }
      const pending = runtime.runTask('finish', () => h.travel.travelTo(far))
      await waiting.promise
      runtime.cancel('stop')
      await assert.rejects(pending, CancelledError)
      assert.equal(h.travel.status().last, null)
    })
  })
})

test('walking momentum exemption requires a confirmed landing transition and an inactive grounded flight', async t => {
  await t.test('landing still moving before fallback', async () => {
    const h = harness({ fly(target, h) {
      h.ground(target); h.bot.entity.velocity.x = 0.2
      return { landed: true, reason: 'arrival', flightLegs: 1 }
    } })
    assert.equal((await h.travel.travelTo(far)).ok, false)
    assert.equal(h.calls.some(c => c[0] === 'walk'), false)
  })
  await t.test('unconfirmed native walk receipt', async () => {
    const h = harness({ fly(target, h) {
      h.ground(target); h.bot.entity.velocity.x = 0.2
      return { landed: false, reason: 'hybrid_arrival', finalApproach: 'walk', flightLegs: 1 }
    } })
    assert.equal((await h.travel.travelTo(far)).ok, false)
    assert.equal(h.calls.some(c => c[0] === 'walk'), false)
  })
  for (const state of ['airborne', 'gliding', 'active']) await t.test(`walking finish became ${state}`, async () => {
    const h = harness({ fly() { return { landed: true, reason: 'corridor_unsafe', flightLegs: 1 } }, walk(target, h) {
      h.ground(target); h.bot.entity.velocity.x = 0.2
      if (state === 'airborne') h.bot.entity.onGround = false
      if (state === 'gliding') h.bot.entity.elytraFlying = true
      if (state === 'active') h.engine.active = () => true
    } })
    assert.equal((await h.travel.travelTo(far)).ok, false)
  })
  await t.test('stop at walking completion', async () => {
    const h = harness({ fly() { return { landed: true, reason: 'corridor_unsafe', flightLegs: 1 } }, walk(target, h) {
      h.ground(target); h.bot.entity.velocity.x = 0.2; h.cancel()
    } })
    await assert.rejects(h.travel.travelTo(far), { name: 'CancelledError' })
    assert.equal(h.travel.status().last, null)
  })
})

test('walk and flight claimed success cannot hide incorrect altitude or unconfirmed landing', async t => {
  await t.test('wrong altitude after both legs', async () => {
    const h = harness({ fly(target, h) { h.ground({ ...target, y: 100 }); return { ok: true, landed: true, reason: 'arrival' } },
      walk() {} })
    const result = await h.travel.travelTo(far)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'approach_incomplete')
    assert.equal(result.position.y, 100)
  })
  await t.test('false walk completion', async () => {
    const h = harness({ walk() {} })
    assert.equal((await h.travel.travelTo(near)).ok, false)
  })
  await t.test('landed flag missing despite colocated entity', async () => {
    const h = harness({ fly(target, h) { h.ground(target); return { ok: true, landed: false, reason: 'arrival' } } })
    assert.equal((await h.travel.travelTo(far)).ok, false)
    assert.equal(h.calls.some(c => c[0] === 'walk'), false)
  })
})

test('timeout, low health/food, fire, active flight and unconfirmed touchdown cannot trigger a walking fallback', async t => {
  for (const reason of ['flight_timeout', 'health_low', 'food_low', 'cancelled', 'disconnected', 'death', 'torso_changed', 'unknown_failure']) {
    await t.test(reason, async () => {
      const h = harness({ fly(_target, h) { h.ground({ x: 30.5, y: 64, z: 0.5 }); return { landed: true, reason } } })
      const result = await h.travel.travelTo(far)
      assert.equal(result.ok, false)
      assert.equal(h.calls.some(c => c[0] === 'walk'), false)
    })
  }
  for (const state of ['fire', 'health', 'food', 'airborne', 'active']) await t.test(state, async () => {
    const h = harness({ fly(_target, h) {
      if (state === 'fire') h.bot.entity.isOnFire = true
      if (state === 'health') h.bot.health = 10
      if (state === 'food') h.bot.food = 8
      if (state === 'airborne') h.bot.entity.onGround = false
      if (state === 'active') h.engine.active = () => true
      return { landed: true, reason: 'chunks_not_loading' }
    } })
    assert.equal((await h.travel.travelTo(far)).ok, false)
    assert.equal(h.calls.some(c => c[0] === 'walk'), false)
  })
})

test('a recoverable thrown flight uses its receipts only after confirming inactive stable ground', async () => {
  const h = harness({ fly(_target, h) {
    h.ground({ x: 30.5, y: 64, z: 0.5 })
    throw Object.assign(new Error('chunks_not_loading'), { rocketsUsed: 4, flightLegs: 2 })
  } })
  const result = await h.travel.travelTo(far)
  assert.equal(result.transport, 'hybrid')
  assert.equal(result.rocketsUsed, 4)
  assert.equal(result.flightLegs, 2)
  assert.equal(result.ok, true)
})

test('NoPath on a medium walk can try flight once without entering recursive retries', async () => {
  const h = harness({ walk() { throw Object.assign(new Error('blocked'), { name: 'NoPath' }) }, fly() {
    return { landed: true, reason: 'corridor_unsafe', rocketsUsed: 1 }
  } })
  const result = await h.travel.travelTo(mid)
  assert.equal(result.ok, false)
  assert.equal(result.transport, 'hybrid')
  assert.equal(h.calls.filter(c => c[0] === 'walk').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'fly').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'say').length, 1)
})

test('stop while equipping or after landing rejects before flying, fallback walking or an arrival result', async t => {
  await t.test('equip await', async () => {
    const entered = deferred(), gate = deferred()
    const h = harness({ torso: null, spare: wing(), equip: async () => { entered.resolve(); await gate.promise } })
    const pending = h.travel.travelTo(far)
    await entered.promise
    h.cancel(); gate.resolve()
    await assert.rejects(pending, { name: 'CancelledError' })
    assert.equal(h.calls.some(c => ['fly', 'walk'].includes(c[0])), false)
    assert.equal(h.travel.status().active, false)
    assert.equal(h.travel.status().last, null)
  })
  await t.test('landed await', async () => {
    const h = harness({ fly(target, h) {
      h.ground(target); h.cancel()
      return { landed: true, reason: 'arrival', ok: true }
    } })
    await assert.rejects(h.travel.travelTo(far), { name: 'CancelledError' })
    assert.equal(h.calls.some(c => c[0] === 'walk'), false)
    assert.equal(h.travel.status().last, null)
  })
})

test('torso changes before or during equip preserve armor and choose walking', async t => {
  await t.test('before equip', async () => {
    const armor = { name: 'diamond_chestplate' }
    const h = harness({ torso: null, spare: wing(), say(h) { h.bot.inventory.slots[6] = armor } })
    const result = await h.travel.travelTo(far)
    assert.equal(result.transport, 'walk')
    assert.equal(h.bot.inventory.slots[6], armor)
    assert.equal(h.calls.some(c => c[0] === 'equip'), false)
  })
  await t.test('during equip', async () => {
    const armor = { name: 'diamond_chestplate' }
    const h = harness({ torso: null, spare: wing(), equip(_item, h) { h.bot.inventory.slots[6] = armor } })
    const result = await h.travel.travelTo(far)
    assert.equal(result.transport, 'walk')
    assert.equal(result.fallbackReason, 'torso_changed')
    assert.equal(h.bot.inventory.slots[6], armor)
    assert.equal(h.calls.filter(c => c[0] === 'equip').length, 1)
    assert.equal(h.calls.some(c => c[0] === 'fly'), false)
  })
})

test('new journeys resolve the current engine after dispose; changing engine during equip prevents stale flight', async t => {
  await t.test('between journeys', async () => {
    const h = harness(), first = h.engine
    first.dispose('death')
    h.setEngine(h.createEngine())
    assert.equal((await h.travel.travelTo(far)).transport, 'fly')
  })
  await t.test('equip await boundary', async () => {
    const h = harness({ torso: null, spare: wing(), equip(item, h) {
      h.bot.inventory.slots[6] = item; h.engine.dispose('replaced'); h.setEngine(h.createEngine())
    } })
    const result = await h.travel.travelTo(far)
    assert.equal(result.transport, 'walk')
    assert.equal(result.fallbackReason, 'flight_changed')
    assert.equal(h.calls.some(c => c[0] === 'fly'), false)
  })
})

test('readiness prevents inventory or movement takeover; describe does no terrain work', async () => {
  const h = harness({ torso: null, spare: wing(), ready: () => ({ ok: false, reason: 'eating' }) })
  const result = await h.travel.travelTo(far)
  assert.equal(result.ok, false)
  assert.equal(result.fallbackReason, 'eating')
  assert.equal(h.calls.some(c => ['walk', 'fly', 'equip'].includes(c[0])), false)
  h.bot.blockAt = () => assert.fail('describe must not scan terrain')
  assert.match(h.travel.describe(), /胸槽=空.*耐久=432.*有效烟花=32.*最近=walk\/未到达/)
})

test('arrival uses the injected reach predicate or matching floored/center default semantics', async () => {
  const h = harness({ arrived: () => true })
  assert.equal((await h.travel.travelTo(far, { range: 1 })).ok, true)
  assert.deepEqual(h.calls, [])
  const local = harness()
  local.bot.entity.position.set(1.99, 64, 0.5)
  assert.equal((await local.travel.travelTo({ x: 0, y: 64, z: 0 }, { range: 1 })).ok, true)
})
