'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { Vec3 } = require('vec3')
const { createSkills, loadPlaces } = require('../skills'), { createRuntime, CancelledError } = require('../runtime'), { normalizeAction } = require('../security')
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
test('new marks bind actual custom level and world identity, persist it, and refuse another same-type level', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-scoped-place-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let current = { worldKey: 'a'.repeat(64), dimension: 'example:first', epoch: 0 }; const messages = [], bot = { entity: { position: new Vec3(1, 64, 2) }, game: { dimension: 'overworld' } }
  const file = path.join(dir, 'places.json'), ctx = { placesFile: file, memoryContext: () => current, say: (s) => messages.push(s), fmt: () => '', runTask: (_n, fn) => fn(), travelTo: async () => { throw Error('must not travel') } }
  const s = createSkills(bot, ctx); s.commands.mark('Player', ['家'])
  const saved = loadPlaces(file).家; assert.equal(saved.dim, 'example:first'); assert.equal(saved.worldKey, current.worldKey)
  current = { ...current, dimension: 'example:second' }; const result = await s.commands.go('Player', ['家']); assert.equal(result.ok, false)
})
for (const crossLevel of [true, false]) test(`container cancellation closes only its own same-level window (crossLevel=${crossLevel})`, async () => {
  const wait = deferred(), opened = deferred(), updates = []; let closed = 0, generation = 0
  let current = { worldKey: 'a'.repeat(64), dimension: 'example:first', epoch: 0 }
  const chest = { id: 1, inventoryStart: 27, containerItems: () => [{ name: 'diamond', count: 1 }], close() { closed++ }, withdraw: async () => { opened.resolve(); await wait.promise } }
  const bot = { entity: { position: new Vec3(1, 64, 2) }, game: { dimension: 'overworld' }, registry: { itemsByName: { diamond: { id: 1 } } }, inventory: { items: () => [] }, currentWindow: chest,
    findBlock: () => ({ name: 'chest', position: new Vec3(2, 64, 2) }), openContainer: async () => chest }
  const runtime = createRuntime(); runtime.guardBot(bot, { getContext: () => current })
  const ctx = { memoryContext: () => current, say() {}, fmt() {}, log() {}, runTask: (n, fn) => runtime.runTask(n, fn), travel: async () => {}, assertActive: runtime.assertActive, generation: () => generation, containers: { update: (...args) => updates.push(args) } }
  const s = createSkills(bot, ctx), running = s.commands.withdraw('Player', ['diamond', '1']); await opened.promise
  generation++; current = { ...current, epoch: 1, ...(crossLevel ? { dimension: 'example:second' } : {}) }; if (crossLevel) bot.currentWindow = { id: 1, close: () => { throw Error('new window must not close') } }
  runtime.cancel('test', crossLevel ? 'dimension_changed' : 'stop'); wait.resolve(); await assert.rejects(running, CancelledError)
  assert.equal(updates.length, 1); assert.equal(updates[0][1], 'example:first'); assert.equal(closed, crossLevel ? 0 : 1)
})
test('model may retrieve memories but cannot manage, confirm, or inject confidence', () => {
  assert.deepEqual(normalizeAction('memories', ['要塞'], { ai: true }).args, ['要塞'])
  for (const args of [['confirm', 'e_123'], ['remember', 'structure', 'village'], ['off']]) assert.throws(() => normalizeAction('memory', args, { ai: true }))
  assert.throws(() => normalizeAction('memory', ['remember', 'verified', 'village']))
})
