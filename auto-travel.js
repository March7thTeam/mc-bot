'use strict'

const guidance = require('./flight-guidance')

// One place for automatic transport policy. Native flight owns long routes,
// loaded-chunk waits and spare-elytra relays; there is no short-route ceiling.
const POLICY = Object.freeze({ walkBelow: 32, flyFrom: 96, terrainRadius: 64, terrainStep: 4,
  terrainHeight: 8, elevationBarrier: 6, minHealth: 16, minFood: 14, stableSpeed: 0.12, waterStableSpeed: 0.3 })
const RECOVERABLE = new Set(['arrival', 'hybrid_arrival', 'destination_no_site', 'approach_incomplete',
  'corridor_unsafe', 'boost_corridor_unsafe', 'chunks_not_loading', 'flight_lost',
  'rockets_unavailable', 'rocket_budget_exhausted', 'rockets_insufficient', 'durability_insufficient',
  'elytra_missing_or_low_durability', 'launch_blocked', 'takeoff_failed', 'takeoff_unconfirmed'])
const STOP = /cancel|stop|death|dead|disconnect|disposed|timeout|health_low|food_low|fire|lava|torso_changed/i
const LABELS = { near_distance: '距离很近，直接步行', medium_distance: '中等距离，优先步行',
  long_distance: '路途较远，准备使用鞘翅', water_barrier: '已加载近处航线有水障，准备使用鞘翅',
  elevation_change: '已加载近处航线高差明显，准备使用鞘翅', forced_walk: '按要求步行',
  walk_no_path: '步行路线不通，尝试一次鞘翅', already_arrived: '已在目标范围内' }

const remaining = item => item?.name === 'elytra' && Number.isFinite(item.maxDurability) &&
  Number.isFinite(item.durabilityUsed) && item.durabilityUsed >= 0 && item.durabilityUsed <= item.maxDurability
  ? item.maxDurability - item.durabilityUsed : 0
const torso = bot => bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6] || null
const copy = value => value ? { ...value, target: value.target && { ...value.target }, position: value.position && { ...value.position } } : null

function createAutoTravel(bot, ctx) {
  for (const key of ['assertActive', 'delay', 'getFlight', 'walk', 'fly', 'ready']) {
    if (typeof ctx?.[key] !== 'function') throw new Error(`自动交通缺少 ${key}`)
  }
  let current = null, last = null
  // Recheck cancellation even when an awaited operation rejects. No inventory,
  // movement, success receipt or fallback may run after the old task ends.
  async function activeAwait(promise) {
    try { return await promise } finally { ctx.assertActive() }
  }
  function arrived(target, range) {
    if (ctx.arrived) return !!ctx.arrived(target, range)
    const p = bot.entity?.position
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return false
    const x = Math.floor(target.x), y = Math.floor(target.y), z = Math.floor(target.z)
    return Math.hypot(Math.floor(p.x) - x, Math.floor(p.y) - y, Math.floor(p.z) - z) <= range ||
      Math.hypot(p.x - (x + 0.5), p.y - y, p.z - (z + 0.5)) <= range + 0.5
  }
  function ready() {
    ctx.assertActive()
    const value = ctx.ready()
    return value?.ok === true ? value : { ok: false, reason: value?.reason || 'controls_busy' }
  }
  function stationary() {
    const e = bot.entity
    return !!e?.position && !!e.velocity && !e.elytraFlying && !!(e.onGround || e.isInWater) &&
      guidance.speed(bot) <= (e.isInWater ? POLICY.waterStableSpeed : POLICY.stableSpeed)
  }
  function groundedWithIdleFlight() {
    const e = bot.entity, engine = ctx.getFlight()
    return !!e?.position && !e.elytraFlying && !!(e.onGround || e.isInWater) && !!engine && !engine.active()
  }
  async function waitForWalkLanding() {
    const deadline = Date.now() + 2000
    for (let tick = 0; tick < 40 && !groundedWithIdleFlight(); tick++) {
      const wait = Math.min(50, deadline - Date.now())
      if (wait <= 0) break
      await activeAwait(ctx.delay(wait))
    }
  }
  function safeFallback(reason, landed) {
    ctx.assertActive()
    const e = bot.entity, engine = ctx.getFlight()
    return landed && !STOP.test(reason) && RECOVERABLE.has(reason) && stationary() &&
      !!engine && !engine.active() && ready().ok && Number.isFinite(bot.health) && bot.health >= POLICY.minHealth &&
      Number.isFinite(bot.food) && bot.food >= POLICY.minFood && !e.isInLava && !e.isOnFire && !e.onFire
  }
  // Only inspect the loaded direct line, at four-block intervals and within
  // sixty-four blocks. Unknown columns never prove either an obstacle or safety.
  function terrain(target) {
    const p = bot.entity?.position
    if (!p) return null
    const distance = guidance.horizontalDistance(p, target)
    let waterRun = 0
    for (let d = POLICY.terrainStep; d <= Math.min(distance, POLICY.terrainRadius); d += POLICY.terrainStep) {
      const x = p.x + (target.x - p.x) * d / distance, z = p.z + (target.z - p.z) * d / distance
      const feet = guidance.blockAt(bot, x, p.y, z), below = guidance.blockAt(bot, x, p.y - 1, z)
      if (!feet || !below) { waterRun = 0; continue }
      if (feet.name === 'water' || below.name === 'water') {
        if (++waterRun >= 2) return 'water_barrier'
        continue
      }
      waterRun = 0
      let known = true, surface = null
      for (let dy = POLICY.terrainHeight; dy >= -POLICY.terrainHeight; dy--) {
        const ground = guidance.blockAt(bot, x, p.y + dy - 1, z)
        const above = guidance.blockAt(bot, x, p.y + dy, z)
        const head = guidance.blockAt(bot, x, p.y + dy + 1, z)
        if (!ground || !above || !head) { known = false; break }
        if (ground.boundingBox === 'block' && above.boundingBox === 'empty' && head.boundingBox === 'empty' &&
            !/water|lava|fire|web|powder_snow/.test(`${ground.name} ${above.name} ${head.name}`)) {
          surface = p.y + dy
          break
        }
      }
      if (known && surface !== null && Math.abs(surface - p.y) >= POLICY.elevationBarrier) return 'elevation_change'
    }
    return null
  }
  function assess(target) {
    ctx.assertActive()
    const allowed = ready()
    if (!allowed.ok) return { ok: false, code: allowed.reason }
    const engine = ctx.getFlight()
    if (!engine || typeof engine.assess !== 'function' || engine.active()) return { ok: false, code: 'flight_unavailable' }
    const worn = torso(bot)
    if (worn && worn.name !== 'elytra') return { ok: false, code: 'torso_occupied' }
    const spare = guidance.inventoryItems(bot).filter(item => item !== worn && remaining(item) > remaining(worn))
      .sort((a, b) => remaining(b) - remaining(a))[0]
    // Keep the current wings whenever they already pass; selecting spares must
    // not cause unnecessary torso writes on every trip.
    let assessment = engine.assess(target), candidate = null
    if (!assessment.ok && spare && ['elytra_missing_or_low_durability', 'durability_insufficient'].includes(assessment.code)) {
      assessment = engine.assess(target, { candidateElytra: spare })
      candidate = spare
    }
    return { ...assessment, engine, candidate }
  }
  async function prepare(target, plan) {
    ctx.assertActive()
    if (!plan.ok) return plan
    if (ctx.getFlight() !== plan.engine || plan.engine.active()) return { ok: false, code: 'flight_changed' }
    if (!ready().ok) return { ok: false, code: 'controls_busy' }
    if (plan.candidate) {
      const worn = torso(bot), candidate = plan.candidate, expected = remaining(candidate)
      if (worn && worn.name !== 'elytra') return { ok: false, code: 'torso_occupied' }
      if (!guidance.inventoryItems(bot).includes(candidate)) return { ok: false, code: 'candidate_unavailable' }
      // Read the chest slot immediately before the only automatic equip.
      ctx.assertActive()
      if (torso(bot) !== worn) return { ok: false, code: 'torso_changed' }
      await activeAwait(bot.equip(candidate, 'torso'))
      if (ctx.getFlight() !== plan.engine) return { ok: false, code: 'flight_changed' }
      const actual = torso(bot)
      if (actual?.name !== 'elytra' || remaining(actual) !== expected) return { ok: false, code: 'torso_changed' }
    }
    if (!ready().ok) return { ok: false, code: 'controls_busy' }
    // Re-read the real slot/resources/launch corridor after equip. Actual fly()
    // performs this preflight once again immediately before taking off.
    return ctx.getFlight().assess(target)
  }
  function account(value) {
    if (Number.isFinite(value?.rocketsUsed) && value.rocketsUsed >= 0) current.rocketsUsed += value.rocketsUsed
    const legs = Array.isArray(value?.flightLegs) ? value.flightLegs.length : value?.flightLegs
    const hasLegs = Number.isInteger(legs) && legs >= 0
    // Calling flyLegs is an attempt, not proof of takeoff: its second preflight
    // can return zero legs. Explicit receipts take precedence over inference.
    const flew = hasLegs ? legs > 0 : value?.launched === true || value?.flew === true || value?.rocketsUsed > 0
    current.flightLegs += hasLegs ? legs : flew ? 1 : 0
    current.flew ||= flew
    if (value?.finalApproach === 'walk' || value?.transport === 'hybrid') current.walked = true
  }
  function outcome(reason, fallbackReason) {
    ctx.assertActive()
    const reached = !STOP.test(reason) && arrived(current.target, current.range) &&
      (!current.flightAttempts || (current.flightConfirmed && groundedWithIdleFlight() &&
        (current.walkAfterLanding || stationary())))
    const value = { kind: 'travel', ok: reached, reached, target: { ...current.target },
      position: guidance.copyPosition(bot.entity?.position), modeRequested: current.modeRequested,
      modeChosen: current.flew ? 'fly' : 'walk', transport: current.flew ? (current.walked ? 'hybrid' : 'fly') : 'walk',
      reason: reached ? current.selectionReason : reason, rocketsUsed: current.rocketsUsed,
      flightLegs: current.flightLegs, flightAttempts: current.flightAttempts }
    if (STOP.test(reason)) value.stopped = true
    if (fallbackReason) value.fallbackReason = fallbackReason
    last = value
    return copy(value)
  }
  async function walk(target, range) {
    ctx.assertActive()
    const allowed = ready()
    if (!allowed.ok) throw Object.assign(new Error(allowed.reason), { code: allowed.reason })
    current.phase = 'WALKING'
    current.walked = true
    await activeAwait(ctx.walk(target, range))
  }
  const failureCode = error => String(error?.code || error?.reason ||
    (error?.name && error.name !== 'Error' ? error.name : error?.message) || 'travel_failed')
  async function fly(target, range, plan, allowWalkFallback) {
    let prepared
    try { prepared = await activeAwait(prepare(target, plan)) } catch (error) {
      ctx.assertActive()
      prepared = { ok: false, code: failureCode(error) }
    }
    if (!prepared.ok) {
      current.fallbackReason = prepared.code
      current.selectionReason = 'preflight_walk'
      if (!allowWalkFallback) return outcome(prepared.code, prepared.code)
      // Before takeoff there is no airborne recovery. A failed equipment check
      // can safely choose walking, but still respects the current task guard.
      try { await activeAwait(walk(target, range)); return outcome('walk_incomplete', prepared.code) }
      catch (error) { ctx.assertActive(); return outcome(failureCode(error), prepared.code) }
    }
    current.phase = 'FLIGHT_REQUESTED'
    current.flightAttempts++
    let result, thrown = false
    try {
      result = await activeAwait(ctx.fly(target, { automatic: true, protectTorso: true, reportFinal: false, maxLegs: 8 }))
      account(result)
    } catch (error) {
      ctx.assertActive()
      account(error)
      thrown = true
      result = { reason: failureCode(error), landed: stationary() }
    }
    const reason = String(result?.reason || (result?.ok ? 'arrival' : 'flight_incomplete'))
    const walkedAfterLanding = result?.finalApproach === 'walk' || result?.transport === 'hybrid'
    // A native final walking receipt follows its confirmed landing. Normal
    // walking momentum need not satisfy the stationary takeoff/landing gate.
    if (result?.landed === true && walkedAfterLanding && !STOP.test(reason)) await waitForWalkLanding()
    current.walkAfterLanding = result?.landed === true && walkedAfterLanding && groundedWithIdleFlight()
    current.flightConfirmed = result?.landed === true && groundedWithIdleFlight() &&
      (current.walkAfterLanding || stationary()) &&
      (!thrown || RECOVERABLE.has(reason))
    // Never trust flight.ok: its landing tolerance is wider than goto/come.
    if (!STOP.test(reason) && arrived(target, range) && current.flightConfirmed) return outcome(reason)
    if (allowWalkFallback && safeFallback(reason, result?.landed === true)) {
      current.fallbackReason = reason
      current.walkAfterLanding = true // The stable landing gate passed above.
      if (!current.flew) current.selectionReason = 'preflight_walk'
      try {
        await activeAwait(walk(target, range))
        await waitForWalkLanding()
        return outcome('approach_incomplete', reason)
      }
      catch (error) { ctx.assertActive(); return outcome(failureCode(error), reason) }
    }
    // A thrown flight must be inactive and stably grounded before any fallback;
    // the gate above applies identically to returned and thrown outcomes.
    return outcome(thrown ? reason : reason === 'arrival' ? 'approach_incomplete' : reason, current.fallbackReason)
  }
  async function travelTo(target, { mode = 'auto', range = 2 } = {}) {
    ctx.assertActive()
    if (current) throw new Error('自动交通仍在执行')
    if (!['auto', 'walk'].includes(mode) || ![1, 2].includes(range) ||
        !target || ![target.x, target.y, target.z].every(Number.isFinite)) throw new Error('自动交通参数无效')
    if (!bot.entity?.position) throw new Error('玩家位置不可用')
    current = { target: { x: target.x, y: target.y, z: target.z }, range, modeRequested: mode,
      phase: 'SELECTING', selectionReason: 'forced_walk', rocketsUsed: 0, flightLegs: 0, flightAttempts: 0,
      flew: false, walked: false, walkAfterLanding: false }
    try {
      if (arrived(target, range)) { current.selectionReason = 'already_arrived'; return outcome('already_arrived') }
      const distance = guidance.horizontalDistance(bot.entity.position, target)
      const selection = mode === 'walk' ? 'forced_walk' : distance < POLICY.walkBelow ? 'near_distance' :
        distance >= POLICY.flyFrom ? 'long_distance' : terrain(target) || 'medium_distance'
      current.selectionReason = selection
      const wantsFly = ['long_distance', 'water_barrier', 'elevation_change'].includes(selection)
      const plan = wantsFly ? assess(target) : null
      if (plan && !plan.ok) { current.fallbackReason = plan.code; current.selectionReason = 'preflight_walk' }
      const opening = plan && !plan.ok ? `起飞条件不足（${plan.code}），选择步行` : LABELS[selection]
      if (ctx.say) await activeAwait(ctx.say(opening))
      if (plan?.ok) return await activeAwait(fly(target, range, plan, true))
      try {
        await activeAwait(walk(target, range))
        return outcome('walk_incomplete', current.fallbackReason)
      } catch (error) {
        ctx.assertActive()
        // NoPath is the only walking failure that justifies a single alternative
        // transport attempt. Timeout, cancellation and control contention do not.
        if (mode === 'auto' && distance >= POLICY.walkBelow && error?.name === 'NoPath') {
          const retry = assess(target)
          if (retry.ok) { current.selectionReason = 'walk_no_path'; return await activeAwait(fly(target, range, retry, false)) }
        }
        return outcome(failureCode(error), current.fallbackReason)
      }
    } finally { current = null }
  }
  function describe() {
    const worn = torso(bot), seen = new Set()
    const wings = [worn, ...guidance.inventoryItems(bot)].filter(item => item && !seen.has(item) && seen.add(item))
    const available = wings.reduce((sum, item) => sum + remaining(item), 0)
    return `交通：胸槽=${worn?.name || '空'}；可用鞘翅耐久=${available}；有效烟花=${guidance.rocketCount(bot)}；` +
      `最近=${last ? `${last.transport}/${last.ok ? '已到达' : '未到达'}/${last.reason}${last.fallbackReason ? `/${last.fallbackReason}` : ''}` : '无'}`
  }
  function status() { return current ? { active: true, phase: current.phase, target: { ...current.target },
    modeRequested: current.modeRequested, rocketsUsed: current.rocketsUsed, flightLegs: current.flightLegs,
    flightAttempts: current.flightAttempts } : { active: false, last: copy(last) } }
  return { travelTo, describe, status }
}

module.exports = { createAutoTravel, POLICY }
