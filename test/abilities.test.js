const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { EventEmitter } = require('node:events')
const { createAbilities } = require('../abilities')
const { createRuntime, CancelledError } = require('../runtime')
const registry = require('minecraft-data')('26.1')

function harness(inventory = {}, mine = async () => ({ got: 0 })) {
  const said = []
  const runtime = createRuntime()
  const bot = {
    registry, entity: { position: new Vec3(0, 64, 0) }, game: { minY: -64 },
    inventory: { items: () => Object.entries(inventory).filter(([, count]) => count).map(([name, count]) => ({ name, count })) },
    world: { getColumn: () => ({ sections: Array.from({ length: 9 }, (_, i) => i === 8 ? { palette: [registry.blocksByName.diamond_ore.defaultState] } : null) }) },
  }
  const { commands } = createAbilities(bot, {
    say: (line) => said.push(line), runTask: (name, fn) => runtime.runTask(name, fn),
    assertActive: runtime.assertActive, findTable: () => null, furnaceNearby: () => false,
    mineIds: mine, log() {},
  })
  return { commands, said, runtime }
}

test('get 重下相同目标时仍要求背包总数，不因中间增加库存而提前成功', async () => {
  const inv = {}, h = harness(inv)
  assert.equal((await h.commands.get(null, ['bread', '10'])).ok, false)
  inv.bread = 6
  assert.equal((await h.commands.get(null, ['bread', '10'])).ok, false)
  assert.equal(inv.bread, 6)
  assert.equal(h.said.some((line) => /背包里已经有 4 个/.test(line)), false)
  inv.bread = 10
  assert.equal((await h.commands.get(null, ['bread', '10'])).ok, true)
})

test('get 中断后按真实背包补足原总目标，物品被拿走后再次补足', async () => {
  const inv = { iron_pickaxe: 1 }
  const counts = []
  let interrupted = false
  const h = harness(inv, async (_ids, count) => {
    counts.push(count)
    if (!interrupted) {
      interrupted = true
      inv.diamond = 6
      h.runtime.cancel('玩家停止', 'stop')
      h.runtime.assertActive()
    }
    inv.diamond = (inv.diamond || 0) + count
    return { got: count }
  })
  await assert.rejects(h.commands.get(null, ['钻石', '10']), CancelledError)
  assert.equal((await h.commands.get(null, ['钻石', '10'])).ok, true)
  assert.equal(inv.diamond, 10)
  inv.diamond = 3
  assert.equal((await h.commands.get(null, ['diamond', '10'])).ok, true)
  assert.equal(inv.diamond, 10)
  assert.deepEqual(counts, [10, 4, 7])
})

test('钓鱼只尝试拾取收竿产生的掉落，并区分收到拾取事件和鱼留在地上', async t => {
  for (const picked of [true, false]) await t.test(picked ? 'collected' : 'still on ground', async () => {
    const bot = new EventEmitter(), p = new Vec3(0, 64, 0), said = [], visited = []
    const bobber = { id: 1, name: 'fishing_bobber', position: p.offset(3, 0, 0), metadata: [] }
    bobber.metadata[registry.entitiesByName.fishing_bobber.metadataKeys.indexOf('biting')] = true
    const unrelated = { id: 2, name: 'item', position: bobber.position.clone() }
    const catchDrop = { id: 3, name: 'item', position: bobber.position.clone() }
    let casts = 0
    Object.assign(bot, {
      entity: { position: p }, registry, entities: { 2: unrelated },
      inventory: { items: () => [{ name: 'fishing_rod', count: 1 }] },
      findBlock: () => ({ position: p.offset(3, -1, 0) }),
      nearestEntity: (fn) => Object.values(bot.entities).find(fn),
      equip: async () => {}, lookAt: async () => {}, activateItem() {
        if (++casts === 1) bot.entities[1] = bobber
        else { delete bot.entities[1]; bot.entities[3] = catchDrop; bot.emit('entitySpawn', catchDrop) }
      },
    })
    const { commands } = createAbilities(bot, {
      say: (line) => said.push(line), runTask: (_name, fn) => fn(), assertActive() {}, stillRunning: () => true,
      sleepMs: async () => {}, travel: async (goal) => {
        if (casts !== 2) return
        visited.push(goal)
        if (picked) { bot.emit('playerCollect', bot.entity, catchDrop); delete bot.entities[3] }
      },
    })
    assert.equal((await commands.fish(null, ['1'])).ok, picked)
    assert.deepEqual(said, [`钓到 1 次，确认收进背包 ${Number(picked)} 次`])
    assert.equal(visited.length, 1)
    assert.equal(bot.entities[2], unrelated)
    assert.equal(bot.listenerCount('playerCollect'), 0)
  })
})
