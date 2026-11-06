'use strict'
// Program observations are separate from model claims and command acknowledgements.
const clean = (v, n = 160) => String(v ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').toWellFormed().slice(0, n)
const sameContext = (a, b) => !!a && !!b && a.worldKey === b.worldKey && a.dimension === b.dimension && a.epoch === b.epoch
const position = (p) => p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null
const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity
const REJECTED = /失败|找不到|没记过|不在这个维度|地点不在当前维度|没有这个地点|未完成|被取消|停下原因/
function snapshot(bot, context) {
  const inventory = {}
  for (const i of bot.inventory?.items?.() || []) if (typeof i.name === 'string' && Number.isFinite(i.count)) inventory[i.name] = (inventory[i.name] || 0) + i.count
  return { ...context, position: position(bot.entity?.position), inventory }
}
function assessAction({ cmd, args = [], outcome, said = [], before, after, target }) {
  if (!sameContext(before, after)) return { ok: false, verification: 'unknown', reason: 'world_or_epoch_changed', stopped: true }
  if (outcome?.stopped) return { ok: false, verification: 'unknown', reason: 'cancelled', stopped: true }
  if (outcome?.ok === false || (outcome?.kind !== 'travel' && said.some((s) => REJECTED.test(s)))) return { ok: false, verification: 'failed', reason: clean(outcome?.error || said.join('；') || 'explicit_failure') }
  if (outcome?.kind === 'travel' && (!outcome.ok || !outcome.reached)) return { ok: false, verification: 'failed', reason: clean(outcome.reason || 'travel_not_reached') }
  const expected = target || (['goto', 'walk', 'fly'].includes(cmd) && args.length === 3 && args.every((v) => Number.isFinite(Number(v))) ? { x: +args[0], y: +args[1], z: +args[2], dimension: before.dimension } : null)
  if (expected?.dimension && expected.dimension !== after.dimension) return { ok: false, verification: 'failed', reason: 'target_in_other_level' }
  if (outcome?.kind === 'travel' && outcome.position && outcome.target) {
    const matchesTarget = !expected || distance(outcome.target, expected) < 0.01
    if (!matchesTarget || distance(after.position, outcome.position) > 0.75) return { ok: false, verification: 'failed', reason: 'travel_receipt_disagrees_with_observation' }
    return { ok: true, verification: 'passed', reason: 'executor_postcondition_and_live_position_agree', causality: 'condition_only' }
  }
  if (cmd === 'fly' && outcome?.ok && outcome.reached && outcome.landed && outcome.position) {
    if (distance(after.position, outcome.position) > 0.75) return { ok: false, verification: 'failed', reason: 'flight_receipt_disagrees_with_observation' }
    // Flight validates terrain/landing internally; target Y is a landing hint.
    return { ok: true, verification: 'passed', reason: 'flight_landing_contract_and_position_agree', causality: 'condition_only' }
  }
  if (cmd === 'fly') return { ok: outcome?.ok !== false, verification: 'unknown', reason: 'flight_without_complete_landing_evidence' }
  if (expected) {
    if (expected.dimension && expected.dimension !== after.dimension) return { ok: false, verification: 'failed', reason: 'target_in_other_level' }
    const reached = distance(after.position, expected) <= 4
    return { ok: reached, verification: reached ? 'passed' : 'failed', reason: reached ? 'position_condition_satisfied' : 'not_at_target', causality: 'condition_only' }
  }
  const changed = Object.keys({ ...before.inventory, ...after.inventory }).some((k) => before.inventory[k] !== after.inventory[k]) || distance(before.position, after.position) > 1
  return { ok: true, verification: 'unknown', reason: changed ? 'state_changed_without_complete_postcondition' : 'command_acknowledged_without_postcondition', causality: 'unattributed' }
}
function createAgentCycle({ bot, memory, getContext, now = Date.now, onError = () => {} }) {
  return {
    capture: () => snapshot(bot, getContext()),
    recall(text) {
      const c = getContext()
      return memory.retrieve({ text, dimension: c.dimension, position: position(bot.entity?.position), limit: 6, maxChars: 1600, includeCandidates: true })
    },
    finish({ cmd, args, outcome, said, before, target, record = true }) {
      const after = snapshot(bot, getContext()), result = assessAction({ cmd, args, outcome, said, before, after, target })
      // Cancelled/stale responses cannot publish any old-world memory.
      if (record && !result.stopped && sameContext(before, after) && after.worldKey && after.position) try { memory.observe({
        kind: 'episode', type: `${result.verification}_${clean(cmd, 24)}`, dimension: after.dimension, position: after.position,
        source: 'runtime', name: clean(`${result.verification === 'passed' ? '条件核验通过（非因果证明）' : result.verification === 'failed' ? '失败' : '未核验尝试'}: ${cmd} ${(args || []).join(' ')}`, 80),
        evidence: [{ detail: clean(`${result.verification}: ${result.reason}; ${result.causality || 'program outcome'}; ${now()}`, 200) }],
      }) } catch (error) { onError(error) }
      return { ...result, after }
    },
  }
}
// Tri-state task predicates. Unknown/partially-loaded terrain cannot prove success.
function verifyCondition(v, { bot, dimension, expectedDimension = dimension }) {
  if (!v || typeof v !== 'object' || dimension !== expectedDimension) return { state: 'unknown', reason: 'missing_or_stale_condition' }
  if (v.item) {
    if (!bot.registry?.itemsByName?.[v.item]) return { state: 'unknown', reason: 'unknown_item' }
    const n = (bot.inventory?.items?.() || []).filter((i) => i.name === v.item).reduce((s, i) => s + i.count, 0)
    return { state: n >= v.count ? 'passed' : 'failed', reason: `inventory_condition:${n}/${v.count}`, causality: 'condition_only' }
  }
  if (v.near) {
    const p = position(bot.entity?.position), target = { x: v.near[0], y: v.near[1], z: v.near[2] }
    if (!p) return { state: 'unknown', reason: 'position_unavailable' }
    return { state: distance(p, target) <= v.r ? 'passed' : 'failed', reason: 'three_dimensional_position_condition', causality: 'condition_only' }
  }
  const { Vec3 } = require('vec3')
  if (v.placed) {
    if (!bot.registry?.blocksByName?.[v.placed]) return { state: 'unknown', reason: 'unknown_block' }
    const b = bot.blockAt?.(new Vec3(...v.at), false)
    if (!b) return { state: 'unknown', reason: 'block_unloaded' }
    return { state: b.name === v.placed ? 'passed' : 'failed', reason: 'current_block_condition', causality: 'condition_only' }
  }
  if (v.cleared) {
    if (v.cleared.some((n) => !bot.registry?.blocksByName?.[n])) return { state: 'unknown', reason: 'unknown_block' }
    // Checking an entire sphere could monopolize the event loop. Large predicates
    // remain unknown until a bounded explicit verification can be requested.
    if (v.r > 4) return { state: 'unknown', reason: 'cleared_area_requires_explicit_loaded_verification' }
    const p = v.center || (bot.entity?.position && Object.values(position(bot.entity.position)))
    if (!p) return { state: 'unknown', reason: 'position_unavailable' }
    let n = 0
    for (let x = -v.r; x <= v.r; x++) for (let y = -v.r; y <= v.r; y++) for (let z = -v.r; z <= v.r; z++) {
      if (Math.hypot(x, y, z) > v.r) continue
      const at = new Vec3(Math.floor(p[0]) + x, Math.floor(p[1]) + y, Math.floor(p[2]) + z)
      if ((v.above !== undefined && at.y <= v.above) || (v.below !== undefined && at.y >= v.below)) continue
      const b = bot.blockAt?.(at, false); if (!b) return { state: 'unknown', reason: 'area_partially_unloaded' }
      if (v.cleared.includes(b.name)) n++
    }
    return { state: n <= v.left ? 'passed' : 'failed', reason: `blocks_remaining:${n}/${v.left}`, causality: 'condition_only' }
  }
  return { state: 'unknown', reason: 'unsupported_condition' }
}
module.exports = { createAgentCycle, assessAction, verifyCondition, sameContext, snapshot }
