'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { EventEmitter } = require('node:events')
const { createLongMemory } = require('../long-memory')
const { createMemoryObserver, worldKey, packetLevel } = require('../memory-observer')
function rig(t, { budget = 128 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-observer-')), bot = new EventEmitter(), blocks = new Map()
  let clock = 1000, calls = 0, c = { worldKey: 'unit-world', dimension: 'minecraft:overworld', epoch: 0 }, hook
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.blockAt = (p) => { calls++; hook?.(); const name = blocks.get(`${p.x},${p.y},${p.z}`); return name === null ? null : { name: name || 'air', position: { x: p.x, y: p.y, z: p.z } } }
  const memory = createLongMemory({ file: path.join(dir, 'memory.json'), worldKey: c.worldKey, now: () => clock })
  const observer = createMemoryObserver({ bot, memory, getContext: () => c, now: () => clock, budget, radius: 2 })
  t.after(() => { observer.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const set = (name, x = 0, y = 64, z = 0) => { blocks.set(`${x},${y},${z}`, name); bot.emit('blockUpdate', null, { name, position: { x, y, z } }) }
  return { bot, memory, observer, set, advance: (n = 2000) => { clock += n }, move: (dimension, x = 0, epoch = c.epoch + 1, emit = true) => { c = { ...c, dimension, epoch }; bot.entity.position.x = x; if (emit) bot.emit('forcedMove') }, reads: () => calls, hook: (fn) => { hook = fn } }
}
test('world identity requires explicit generation ID; actual custom level names survive', () => {
  assert.equal(worldKey({ host: 'a', port: 1 }), null)
  assert.equal(worldKey({ host: 'A', port: 25565, worldId: 'world' }), worldKey({ host: 'a', port: '25565', worldId: 'world' }))
  assert.notEqual(worldKey({ host: 'a', worldId: 'one' }), worldKey({ host: 'a', worldId: 'two' }))
  assert.equal(packetLevel({ worldState: { name: 'example:moon', dimension: 0 } }), 'example:moon')
})
test('loaded feature combinations become structure candidates; ordinary stone is no village', (t) => {
  const h = rig(t); h.set('stone'); h.observer.tick({ force: true }); assert.equal(h.memory.list().length, 0)
  h.set('trial_spawner'); h.set('vault', 1); h.advance(); h.observer.tick({ force: true })
  const structures = h.memory.list({ kind: 'structure' }); assert.equal(structures.length, 1); assert.equal(structures[0].type, 'trial_chambers'); assert.equal(structures[0].confidence, 'candidate')
})
test('hard read budget and bounded update queue; no chunk requests or movement APIs', (t) => {
  const h = rig(t, { budget: 16 }); for (let x = 0; x < 1000; x++) h.set('stone', x)
  const before = h.reads(); h.observer.tick({ force: true }); assert(h.reads() - before <= 16); assert(h.observer.status().queued <= 512)
})
test('context change during block read cannot publish stale observations', (t) => {
  const h = rig(t); h.set('nether_portal'); let once = true; h.hook(() => { if (once) { once = false; h.move('example:new', 0, 1, false) } }); h.observer.tick({ force: true }); assert.equal(h.memory.list().length, 0)
})
test('observed portal alone and administrator dimension jump without contact create no edges', (t) => {
  const h = rig(t); h.set('nether_portal', 1); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'portal' }).length, 1)
  h.move('minecraft:the_nether', 10); h.set('nether_portal', 10); h.advance(); h.observer.tick({ force: true }); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'edge' }).length, 0)
})
test('portal overlap then real context transition yields only a directional candidate edge', (t) => {
  const h = rig(t); h.set('nether_portal'); h.observer.tick({ force: true }); h.move('minecraft:the_nether', 10); h.set('nether_portal', 10); h.advance(); h.observer.tick({ force: true }); h.advance(); h.observer.tick({ force: true })
  const edges = h.memory.list({ kind: 'edge' }); assert.equal(edges.length, 1); assert.equal(edges[0].confidence, 'candidate'); assert.equal(edges[0].fromDimension, 'minecraft:overworld'); assert.equal(edges[0].toDimension, 'minecraft:the_nether')
})
test('same-level End gateway displacement is a candidate; mere runtime epoch change is not travel', (t) => {
  const h = rig(t); h.move('minecraft:the_end'); h.set('end_gateway'); h.observer.tick({ force: true }); h.move('minecraft:the_end', 0); h.advance(); h.observer.tick({ force: true }); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'edge' }).length, 0)
  h.move('minecraft:the_end', 40, 2); h.set('end_gateway', 40); h.advance(); h.observer.tick({ force: true }); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'edge' }).length, 1)
})
for (const reason of ['death', 'known-admin-teleport', 'end']) test(`${reason} suppresses candidate portal attribution`, (t) => {
  const h = rig(t); h.set('nether_portal'); h.observer.tick({ force: true }); reason === 'known-admin-teleport' ? h.observer.suppress() : h.bot.emit(reason)
  h.move('minecraft:the_nether', 10); h.set('nether_portal', 10); h.advance(); h.observer.tick({ force: true }); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'edge' }).length, 0)
})
test('end portal arrival with no exit portal is a candidate dynamic arrival, never a reverse link', (t) => {
  const h = rig(t); h.set('end_portal'); h.observer.tick({ force: true }); h.move('minecraft:the_end', 40); h.advance(); h.observer.tick({ force: true }); h.advance(4000); h.observer.tick({ force: true })
  assert.equal(h.memory.list({ kind: 'edge' }).length, 1); assert.equal(h.memory.list({ kind: 'place' })[0].confidence, 'candidate')
})
test('unloaded portal anchor is not destruction; loaded missing anchor is marked missing', (t) => {
  const h = rig(t); h.set('nether_portal'); h.observer.tick({ force: true }); const id = h.memory.list({ kind: 'portal' })[0].id
  h.set(null); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.get(id).status, 'active')
  h.set('air'); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.get(id).status, 'missing')
})
test('fast contact and raw level transition between broad scans is retained until a stable arrival', (t) => {
  const h = rig(t); h.set('end_portal'); h.bot.emit('move') // no broad tick at source
  h.move('minecraft:the_end', 40); h.advance(); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'edge' }).length, 0)
  h.advance(4000); h.observer.tick({ force: true }); assert.equal(h.memory.list({ kind: 'edge' }).length, 1)
})
test('persisted portal anchors can be marked missing by a fresh observer after a restart', (t) => {
  const h = rig(t); const r = h.memory.observe({ kind: 'portal', type: 'nether_portal', dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 }, source: 'block', evidence: [{ block: 'nether_portal', position: { x: 0, y: 64, z: 0 } }] })
  // Observer has never seen an active portal in this process; the saved anchor is air.
  h.observer.tick({ force: true }); assert.equal(h.memory.get(r.id).status, 'missing')
})
test('a persisted but dismantled destination portal cannot become a candidate exit endpoint', (t) => {
  const h = rig(t), oldExit = h.memory.observe({ kind: 'portal', type: 'nether_portal', dimension: 'minecraft:the_nether', position: { x: 10, y: 64, z: 0 }, source: 'block', evidence: [{ block: 'nether_portal', position: { x: 10, y: 64, z: 0 } }] })
  h.set('nether_portal'); h.bot.emit('move'); h.move('minecraft:the_nether', 10); h.advance(); h.observer.tick({ force: true }); h.advance(4000); h.observer.tick({ force: true })
  const edges = h.memory.list({ kind: 'edge' }); assert.equal(edges.length, 1); assert.notEqual(edges[0].toId, oldExit.id); assert.equal(h.memory.get(edges[0].toId).type, 'portal_arrival')
})
