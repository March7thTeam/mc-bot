const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
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
