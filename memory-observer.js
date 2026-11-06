'use strict'
// Passive, bounded reads of already-loaded blocks. Never requests chunks or moves.
const { createHash } = require('node:crypto')
const { Vec3 } = require('vec3')
const normalizedLevel = (v) => typeof v === 'string' && /^[a-z0-9_.-]+(?::[a-z0-9_./-]+)?$/.test(v) ? (v.includes(':') ? v : 'minecraft:' + v) : null
function worldKey({ host, port, worldId }) {
  if (typeof worldId !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(worldId)) return null
  return createHash('sha256').update(JSON.stringify([String(host || '127.0.0.1').trim().toLowerCase(), Number(port) || 25565, worldId])).digest('hex')
}
function packetLevel(packet) {
  const p = packet?.worldState || packet
  return normalizedLevel(p?.name || p?.worldName || (typeof p?.dimension === 'string' ? p.dimension : null))
}
const PORTALS = new Set(['nether_portal', 'end_portal', 'end_gateway'])
const FACILITIES = new Set(['chest', 'barrel', 'furnace', 'crafting_table', 'enchanting_table', 'anvil', 'brewing_stand', 'beacon'])
const STRUCTURES = [
  ['stronghold', ['end_portal_frame']],
  ['ancient_city', ['reinforced_deepslate', 'sculk']],
  ['trial_chambers', ['trial_spawner', 'vault']],
  ['nether_fortress', ['nether_bricks', 'nether_brick_fence']],
  ['bastion_remnant', ['gilded_blackstone', 'polished_blackstone_bricks']],
  ['end_city', ['purpur_block', 'end_stone_bricks']],
  ['ocean_monument', ['dark_prismarine', 'sea_lantern']],
]
const FEATURES = new Set(STRUCTURES.flatMap(([, names]) => names))
const point = (p) => p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const equalContext = (a, b) => a?.worldKey === b?.worldKey && a?.dimension === b?.dimension && a?.epoch === b?.epoch
const key = (p) => `${p.x},${p.y},${p.z}`
function createMemoryObserver({ bot, memory, getContext, now = Date.now, budget = 256, radius = 8, tickMs = 1000, onError = () => {} }) {
  budget = Math.max(1, Math.min(512, Math.floor(budget) || 256)); radius = Math.max(1, Math.min(12, Math.floor(radius) || 8))
  const offsets = []
  for (let x = -radius; x <= radius; x++) for (let y = -radius; y <= radius; y++) for (let z = -radius; z <= radius; z++) if (Math.hypot(x, y, z) <= radius) offsets.push({ x, y, z })
  offsets.sort((a, b) => Math.hypot(a.x, a.y, a.z) - Math.hypot(b.x, b.y, b.z))
  const features = new Map(), knownPortals = new Map(), updates = new Map()
  let cursor = 0, lastTick = -Infinity, previous = null, ticket = null, pending = null, suppressedUntil = 0, closed = false, reads = 0, lastBodyKey = null
  const context = () => { const c = getContext(); return { ...c, dimension: normalizedLevel(c.dimension) } }
  const put = (map, k, v, max = 2048) => { map.delete(k); map.set(k, v); while (map.size > max) map.delete(map.keys().next().value) }
  function observe(block, captured) {
    const p = point(block?.position)
    if (!p || !equalContext(captured, context())) return
    const name = block.name, evidence = [{ block: name, position: p, detail: 'loaded-block snapshot; not a natural-generation or line-of-sight assertion' }]
    let kind = PORTALS.has(name) ? 'portal' : FACILITIES.has(name) ? 'facility' : /(?:_ore$|^ancient_debris$)/.test(name) ? 'resource' : name === 'lava' ? 'hazard' : null
    if (kind) {
      const record = memory.observe({ kind, type: name, dimension: captured.dimension, position: p, evidence, source: 'block' })
      if (kind === 'portal' && record?.id) put(knownPortals, key(p), { id: record.id, position: p, type: name, context: captured })
    }
    if (!FEATURES.has(name)) return
    put(features, key(p), { name, position: p, at: now(), context: captured })
    const nearby = [...features.values()].filter((v) => equalContext(v.context, captured) && now() - v.at < 60_000 && dist(v.position, p) <= 24)
    for (const [type, names] of STRUCTURES) {
      const anchors = names.map((n) => nearby.find((v) => v.name === n))
      if (anchors.some((v) => !v) || !equalContext(captured, context())) continue
      memory.observe({ kind: 'structure', type, dimension: captured.dimension, position: anchors[0].position, source: 'inference', evidence: anchors.map((v) => ({ block: v.name, position: v.position, detail: 'feature combination only; may be player-built' })) })
    }
  }
  function read(p, captured) {
    reads++
    const b = bot.blockAt?.(new Vec3(p.x, p.y, p.z), false)
    if (!equalContext(captured, context())) return null
    if (b) observe(b, captured)
    return b
  }
  function sync(captured, center) {
    if (previous && !equalContext(previous.context, captured)) {
      features.clear(); knownPortals.clear(); updates.clear(); cursor = 0; lastBodyKey = null; pending = null
      if (previous.context.dimension !== captured.dimension && ticket && ticket.fromContext.worldKey === captured.worldKey && now() - ticket.at <= 15_000 && now() >= suppressedUntil) pending = { ...ticket, toContext: captured, after: now() + 1000, ready: false, stableSamples: 0 }
      ticket = null
    } else if (previous && dist(previous.position, center) > 24 && ticket && now() - ticket.at <= 15_000 && now() >= suppressedUntil) {
      pending = { ...ticket, toContext: captured, after: now() + 1000, ready: false, stableSamples: 0 }; ticket = null
    }
    previous = { context: captured, position: center }
  }
  function stability(captured, center, positionEvent = false) {
    if (!pending || !equalContext(pending.toContext, captured)) return
    if (positionEvent) pending.ready = true
    if (!pending.ready) return
    if (!pending.sample || dist(pending.sample.position, center) > 0.25) { pending.sample = { position: center, at: now() }; pending.stableSamples = 1 }
    else if (now() - pending.sample.at >= 500) { pending.sample = { position: center, at: now() }; pending.stableSamples++ }
  }
  // Tiny contact path runs on actual movement before a one-tick End portal can
  // disappear from the old block cache. No broad scan is performed here.
  function contact() {
    if (closed || !memory.status().enabled) return
    const captured = context(), center = point(bot.entity?.position), physical = bot.entity?.position
    if (!captured.worldKey || !captured.dimension || !center) return
    sync(captured, center); stability(captured, center, true)
    if (now() < suppressedUntil) return
    const cells = []
    for (const x of new Set([Math.floor(physical.x - 0.3), Math.floor(physical.x + 0.3)])) for (const z of new Set([Math.floor(physical.z - 0.3), Math.floor(physical.z + 0.3)])) for (const y of [center.y, center.y + 1]) cells.push({ x, y, z })
    const bodyKey = `${captured.epoch}|${captured.dimension}|${cells.map(key).join(';')}`
    if (bodyKey === lastBodyKey && ticket && now() - ticket.at < 500) return
    lastBodyKey = bodyKey
    for (const p of cells.slice(0, 8)) {
      const b = read(p, captured)
      if (b && PORTALS.has(b.name)) { const entry = knownPortals.get(key(p)); if (entry) ticket = { fromId: entry.id, fromDimension: captured.dimension, fromContext: captured, at: now(), portalType: b.name } }
    }
  }
  function suppress(ms = 15_000) { ticket = null; pending = null; lastBodyKey = null; suppressedUntil = now() + ms }

  function tick({ force = false } = {}) {
    if (closed || (!force && now() - lastTick < tickMs)) return { reads: 0 }
    lastTick = now(); reads = 0
    const captured = context(), center = point(bot.entity?.position)
    if (!captured.worldKey || !captured.dimension || !center || memory.status().enabled === false) { ticket = null; pending = null; previous = null; return { reads } }
    sync(captured, center); stability(captured, center)
    // Seed revalidation from persisted anchors, including after process restart.
    for (const r of memory.list({ kind: 'portal', dimension: captured.dimension, limit: 256 })) {
      if (r.status === 'invalidated' || dist(r.position, center) > radius + 2) continue
      const anchors = r.evidence.filter((e) => e.position && PORTALS.has(e.block)).map((e) => e.position)
      for (const p of anchors.length ? anchors : [r.position]) put(knownPortals, key(p), { id: r.id, position: p, type: r.type, context: captured })
    }
    // Capture a ticket only while the actual body overlaps an already-loaded active portal.
    if (now() >= suppressedUntil) for (const y of [center.y, center.y + 1]) {
      if (reads >= budget) break
      const p = { ...center, y }, b = read(p, captured)
      if (b && PORTALS.has(b.name)) { const entry = knownPortals.get(key(p)); if (entry) ticket = { fromId: entry.id, fromDimension: captured.dimension, fromContext: captured, at: now(), portalType: b.name } }
    }
    const started = performance.now()
    for (const [k, p] of updates) {
      if (reads >= budget || performance.now() - started > 5) break
      updates.delete(k); if (dist(p, center) <= radius) read(p, captured)
    }
    while (reads < Math.max(2, budget - 32) && reads < budget && performance.now() - started <= 5) {
      const d = offsets[cursor++ % offsets.length]
      read({ x: center.x + d.x, y: center.y + d.y, z: center.z + d.z }, captured)
    }
    if (pending && now() - pending.at > 15_000) pending = null
    if (pending && equalContext(pending.toContext, captured) && pending.ready && pending.stableSamples >= 2 && now() >= pending.after) {
      let exit = null
      for (const possible of [...knownPortals.values()].filter((p) => equalContext(p.context, captured) && dist(p.position, center) < 5 && memory.get(p.id)?.status === 'active').sort((a, b) => dist(a.position, center) - dist(b.position, center))) {
        if (reads >= budget) break
        const actual = read(possible.position, captured)
        if (actual && actual.name === possible.type && PORTALS.has(actual.name)) { exit = knownPortals.get(key(possible.position)); break }
      }
      if (exit && exit.id !== pending.fromId) { memory.recordTransition({ fromId: pending.fromId, toId: exit.id, fromDimension: pending.fromDimension, toDimension: captured.dimension, source: 'proximity_transition' }); pending = null }
      else if (now() - pending.at > 4000) {
        const arrival = memory.observe({ kind: 'place', type: 'portal_arrival', dimension: captured.dimension, position: center, source: 'inference', name: '未确认门户抵达点（可能动态变化）', evidence: [{ position: center, detail: `nearby ${pending.portalType} contact then unattributed transition; dynamic destination, no return edge` }] })
        if (arrival?.id) memory.recordTransition({ fromId: pending.fromId, toId: arrival.id, fromDimension: pending.fromDimension, toDimension: captured.dimension, source: 'proximity_transition' })
        pending = null
      }
    }
    // Missing is only evidence when all known anchors of this entrance are loaded and gone.
    const grouped = new Map()
    for (const v of knownPortals.values()) if (equalContext(v.context, captured)) { const a = grouped.get(v.id) || []; a.push(v); grouped.set(v.id, a) }
    for (const [id, anchors] of grouped) {
      if (reads + anchors.length > budget || performance.now() - started > 5) break
      const bs = anchors.map((v) => { reads++; return bot.blockAt?.(new Vec3(v.position.x, v.position.y, v.position.z), false) })
      if (bs.length && bs.every((b) => b && !PORTALS.has(b.name)) && equalContext(captured, context())) memory.markMissing?.(id, { evidence: bs.slice(0, 8).map((b) => ({ block: b.name, position: point(b.position) })) })
    }
    previous = { context: captured, position: center }
    return { reads }
  }
  const update = (_old, block) => { const p = point(block?.position); if (p) put(updates, key(p), p, 512) }
  const died = () => suppress(30_000), ended = () => suppress(30_000)
  const moved = () => { try { contact() } catch (e) { onError(e) } }
  bot.on?.('move', moved); bot.on?.('physicsTick', moved); bot.on?.('forcedMove', moved)
  bot.on?.('blockUpdate', update); bot.on?.('death', died); bot.on?.('end', ended)
  return { tick: (options) => { try { return tick(options) } catch (e) { onError(e); return { reads, error: e.message } } }, suppress,
    close() { closed = true; bot.removeListener?.('move', moved); bot.removeListener?.('physicsTick', moved); bot.removeListener?.('forcedMove', moved); bot.removeListener?.('blockUpdate', update); bot.removeListener?.('death', died); bot.removeListener?.('end', ended); try { return memory.flush() } catch (error) { onError(error); return false } },
    status: () => ({ reads, queued: updates.size, features: features.size, portals: knownPortals.size, pending: !!pending }) }
}
module.exports = { createMemoryObserver, worldKey, packetLevel, normalizedLevel, PORTALS, STRUCTURES }
