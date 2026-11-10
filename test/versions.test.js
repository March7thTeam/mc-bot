const test = require('node:test')
const assert = require('node:assert/strict')
const mcData = require('minecraft-data')
const { versionFacts, describeVersion, installLegacyAliases, flightVerified, releaseOf, compareRelease, LEGACY_ALIASES } = require('../versions')

for (const version of ['1.8.8', '1.12.2', '1.16.5', '1.17.1', '1.18.2', '1.20.4', '1.20.5', '1.21.4', '26.1']) {
  test(`${version} 的事实与本地注册表机制一致`, () => {
    const registry = mcData(version), facts = versionFacts({ version, registry, supportFeature: registry.supportFeature })
    for (const [field, feature] of [['flattening', 'theFlattening'], ['tallWorld', 'tallWorld'], ['attackCooldown', 'hasAttackCooldown'], ['components', 'itemsWithComponents'], ['elytra', 'hasElytraFlying']]) {
      assert.equal(facts[field], registry.supportFeature(feature))
    }
    assert.equal(facts.offhand, !registry.supportFeature('doesntHaveOffHandSlot'))
    assert.deepEqual([facts.minY, facts.maxY], facts.tallWorld ? [-64, 319] : [0, 255])
    assert.ok(registry.itemsByName[facts.rocketItem])
    for (const entry of Object.values(facts.content)) {
      assert.equal(entry.exists, !!(registry.itemsByName[entry.name] || registry.blocksByName[entry.name] || registry.entitiesByName[entry.name]), entry.name)
      assert.ok(entry.label)
    }
    assert.ok(describeVersion(facts).length <= 400)
  })
}

test('版本比较补齐补丁，26.x 大于 1.x，按数字而不是字符串排序', () => {
  assert.deepEqual(releaseOf('26.1'), [26, 1, 0])
  assert.deepEqual(releaseOf('1.8.8'), [1, 8, 8])
  assert.ok(compareRelease('26.1', '1.21.11') > 0)
  assert.ok(compareRelease('1.20.10', '1.20.5') > 0)
  assert.equal(compareRelease('1.18', '1.18.0'), 0)
})

test('世界上下界优先用服务器维度信息，缺失时才回退', () => {
  const bot = { version: '26.1', registry: mcData('26.1'), game: { minY: 0, height: 256 } }
  assert.deepEqual([versionFacts(bot).minY, versionFacts(bot).maxY], [0, 255])
  bot.game = { minY: -128, height: 512 }
  assert.deepEqual([versionFacts(bot).minY, versionFacts(bot).maxY], [-128, 383])
  bot.game = { minY: NaN, height: 0 }
  assert.deepEqual([versionFacts(bot).minY, versionFacts(bot).maxY], [-64, 319])
})

test('内容只看注册表，has 覆盖物品、方块、实体且不接受原型键', () => {
  const facts = versionFacts({ version: '1.8.8', supportFeature: (name) => name === 'doesntHaveOffHandSlot',
    registry: { itemsByName: { mace: {} }, blocksByName: { trial_spawner: {} }, entitiesByName: { happy_ghast: {} } } })
  assert.ok(facts.content.mace.exists && facts.content.trialSpawner.exists && facts.content.happyGhast.exists)
  assert.equal(facts.has('toString'), false)
  assert.equal(facts.has('missing'), false)
  const summary = describeVersion(facts)
  assert.match(summary, /没有副手.*没有攻击冷却.*连点/)
  assert.match(summary, /log、planks、wool、fireworks/)
  assert.match(summary, /亮度≤7.*旧矿石分布.*0~255/)
  assert.match(summary, /NBT/)
  assert.doesNotMatch(summary, /重锤|试炼刷怪笼|快乐恶魂/)
})

for (const version of ['1.8.8', '1.12.2']) {
  test(`${version} 每条别名的旧名都存在，引用原条目并且幂等`, () => {
    const data = mcData(version), registry = { itemsByName: { ...data.itemsByName }, blocksByName: { ...data.blocksByName } }
    for (const legacy of Object.values(LEGACY_ALIASES)) assert.ok(data.itemsByName[legacy] || data.blocksByName[legacy], legacy)
    const tools = registry.itemsByName.wooden_shovel
    const count = installLegacyAliases(registry, { flattening: false })
    assert.ok(count > 0)
    for (const key of ['itemsByName', 'blocksByName']) {
      for (const [modern, legacy] of Object.entries(LEGACY_ALIASES)) if (data[key][legacy]) assert.equal(registry[key][modern], data[key][modern] || data[key][legacy], `${key}.${modern}`)
    }
    assert.equal(registry.itemsByName.wooden_shovel, tools)
    assert.equal(installLegacyAliases(registry, { flattening: false }), 0)
  })
}

test('别名不覆盖现有键，现代注册表不加别名，缺失旧名不伪造', () => {
  const modern = {}, legacy = {}, registry = { itemsByName: { oak_log: modern, log: legacy }, blocksByName: { log: legacy } }
  assert.equal(installLegacyAliases(registry, { flattening: true }), 0)
  assert.equal(registry.blocksByName.oak_log, undefined)
  assert.equal(installLegacyAliases(registry, { flattening: false }), 1)
  assert.equal(registry.itemsByName.oak_log, modern)
  assert.equal(registry.itemsByName.oak_boat, undefined)
})

test('自动飞行白名单只含人工指定的三个版本', () => {
  for (const version of ['26.1', '26.1.1', '26.1.2']) assert.equal(flightVerified(version), true)
  for (const version of ['1.8.8', '1.12.2', '1.20.4', '1.21.4', '26.1.3', undefined, null, 775]) assert.equal(flightVerified(version), false)
})

for (const version of ['1.8.8', '1.12.2']) {
  test(`${version} 的战斗副手装备和举盾受实际机制控制`, async (t) => {
    const { EventEmitter } = require('node:events'), { Vec3 } = require('vec3'), { createCombat } = require('../combat')
    let tick
    t.mock.method(global, 'setInterval', (fn) => { tick = fn; return { unref() {} } })
    const bot = new EventEmitter(), calls = [], skeleton = { id: 7, name: version === '1.8.8' ? 'Skeleton' : 'skeleton', position: new Vec3(6, 64, 0), metadata: [] }
    const shield = { name: 'shield' }, sword = { name: 'iron_sword' }, slots = []; slots[45] = shield
    Object.assign(bot, { version, registry: mcData(version), supportFeature: mcData(version).supportFeature,
      health: 20, entity: { position: new Vec3(0, 64, 0) }, entities: { 7: skeleton },
      inventory: { slots, items: () => [shield, sword] }, pvp: { target: skeleton, stop() {}, attack() {} },
      nearestEntity: (filter) => filter(skeleton) ? skeleton : null,
      equip: async (_item, slot) => { calls.push(slot) }, activateItem: () => calls.push('block'), deactivateItem() {},
    })
    createCombat(bot, { onCombatStart() {}, onCombatOver() {}, log() {} })
    tick(); bot.emit('physicsTick'); await new Promise(setImmediate)
    assert.equal(calls.includes('block'), version !== '1.8.8')
    slots[45] = null; tick(); await new Promise(setImmediate)
    assert.equal(calls.includes('off-hand'), version !== '1.8.8')
  })
}

test('矩阵参数、复制排除项和旧版命令只做离线校验', () => {
  const { parseArgs, includeFile, commandsFor } = require('../scripts/lab/version-matrix')
  assert.equal(parseArgs(['--out', '/tmp/vm', '--port', '25590', '--flight', '1.8.8', '26.1']).flight, true)
  for (const args of [[], ['--out'], ['--out', '/tmp/vm', '--port', '65535', '26.1'], ['--out', '/tmp/vm', '--bad'], ['--out', '/tmp/vm', '../26.1']]) assert.throws(() => parseArgs(args))
  for (const rel of ['data/x', 'logs/x', '.env', '.env.local', 'config.json', 'node_modules/x', '.dual-dev/x', 'workflows/x', 'extensions/x.js', 'extensions/deep/README.md', 'a.log']) {
    assert.equal(includeFile(`/repo/${rel}`, '/repo'), false, rel)
  }
  for (const rel of ['bot.js', 'versions.js', 'extensions/README.md']) assert.equal(includeFile(`/repo/${rel}`, '/repo'), true)
  assert.equal(includeFile('/repo/evidence/x', '/repo', '/repo/evidence'), false)
  assert.match(commandsFor('1.8.8').summon(4, 100, 0, 'VmZombie'), /^summon Zombie /)
  assert.match(commandsFor('1.12.2').summon(4, 100, 0, 'VmZombie'), /^summon zombie /)
  assert.match(commandsFor('1.12.2').rocketGive(), /fireworks 64 0 \{Fireworks:\{Flight:1b\}\}/)
  assert.match(commandsFor('1.20.4').rocketGive(), /firework_rocket\{Fireworks:\{Flight:1b\}\} 64/)
  assert.match(commandsFor('1.21.4').rocketGive(), /firework_rocket\[minecraft:fireworks=\{flight_duration:1,explosions:\[\]\}\] 64/)
})

test('矩阵按旧名解析多行背包并在场地加载后才搭建和读回', async () => {
  const { parseInventoryCount, prepareArena, commandsFor } = require('../scripts/lab/version-matrix')
  const { Vec3 } = require('vec3')
  assert.equal(parseInventoryCount(['logx2, dirtx3', 'crafting_tablex1, fireworksx64'], 'log'), 2)
  assert.equal(parseInventoryCount(['oak_logx2, dark_oak_logx4', 'iron_swordx1'], 'oak_log'), 2)
  assert.throws(() => parseInventoryCount(['<score:VmCount:vm_items>'], 'log'))
  for (const version of ['1.8.8', '26.1.2']) {
    const c = commandsFor(version), commands = []
    let loaded = false, built = false
    const tester = { entity: { position: new Vec3(16, 100, 0) }, blockAt: p => loaded ? { name: built && p.y === 99 ? c.name('grass_block', 'grass') : 'air' } : null }
    await prepareArena(tester, c, async (...batch) => {
      if (batch[0].startsWith('fill')) { assert.equal(loaded, true); built = true }
      commands.push(...batch)
    }, async (predicate, _timeout, description) => {
      if (description.includes('加载')) { assert.equal(predicate(), false); loaded = true }
      assert.equal(predicate(), true)
    })
    assert.equal(commands.some(cmd => cmd.startsWith('forceload')), version === '26.1.2')
  }
})
