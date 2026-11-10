'use strict'

// 版本号只用来比较机制；内容是否存在一律看当前注册表。
function releaseOf(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0]
}
function compareRelease(a, b) {
  const left = Array.isArray(a) ? a : releaseOf(a), right = Array.isArray(b) ? b : releaseOf(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}

const CONTENT = {
  netherite: ['netherite_ingot', '下界合金'], copper: ['copper_ingot', '铜'], deepslate: ['deepslate', '深板岩'],
  amethyst: ['amethyst_shard', '紫水晶'], crimson: ['crimson_nylium', '绯红菌岩'], warped: ['warped_nylium', '诡异菌岩'],
  soulSoil: ['soul_soil', '灵魂土'], basalt: ['basalt', '玄武岩'], blackstone: ['blackstone', '黑石'],
  phantom: ['phantom', '幻翼'], mace: ['mace', '重锤'], trialSpawner: ['trial_spawner', '试炼刷怪笼'],
  bundle: ['bundle', '收纳袋'], cherry: ['cherry_log', '樱花'], mangrove: ['mangrove_log', '红树'],
  creaking: ['creaking', '嘎枝（嘎吱）'], happyGhast: ['happy_ghast', '快乐恶魂'], camel: ['camel', '骆驼'],
  crossbow: ['crossbow', '弩'], trident: ['trident', '三叉戟'], shield: ['shield', '盾牌'], elytra: ['elytra', '鞘翅'],
  beehive: ['beehive', '蜂巢'],
}

function versionFacts(bot) {
  const registry = bot.registry || {}
  const feature = (name) => !!(bot.supportFeature ? bot.supportFeature(name) : registry.supportFeature?.(name))
  const has = (name) => [registry.itemsByName, registry.blocksByName, registry.entitiesByName]
    .some((entries) => !!entries && Object.hasOwn(entries, name))
  const tallWorld = feature('tallWorld')
  const minY = Number.isInteger(bot.game?.minY) ? bot.game.minY : tallWorld ? -64 : 0
  const height = Number.isInteger(bot.game?.height) && bot.game.height > 0 ? bot.game.height : tallWorld ? 384 : 256
  return {
    version: bot.version, release: releaseOf(bot.version), flattening: feature('theFlattening'), tallWorld,
    minY, maxY: minY + height - 1, offhand: !feature('doesntHaveOffHandSlot'), attackCooldown: feature('hasAttackCooldown'),
    components: feature('itemsWithComponents'), elytra: feature('hasElytraFlying'),
    rocketItem: ['firework_rocket', 'fireworks'].find((name) => Object.hasOwn(registry.itemsByName || {}, name)) || null,
    has, content: Object.fromEntries(Object.entries(CONTENT).map(([key, [name, label]]) => [key, { name, label, exists: has(name) }])),
  }
}

function describeVersion(facts) {
  if (!facts) return ''
  const notes = [`版本 ${facts.version}，世界高度 ${facts.minY}~${facts.maxY}`]
  const missing = Object.values(facts.content).filter((entry) => !entry.exists).map((entry) => entry.label)
  if (missing.length) notes.push(`没有：${missing.join('、')}`)
  if (!facts.offhand) notes.push('没有副手')
  if (!facts.attackCooldown) notes.push('没有攻击冷却，连点就行')
  if (!facts.flattening) notes.push('物品用旧名（log、planks、wool、fireworks 等）')
  if (!facts.tallWorld) notes.push('1.18 前：普通主世界怪物刷怪亮度≤7，旧矿石分布，原版主世界 0~255')
  if (!facts.components) notes.push('物品用 NBT（1.20.5 前）')
  return notes.join('；').slice(0, 400)
}

const LEGACY_ALIASES = Object.freeze({
  oak_log: 'log', oak_planks: 'planks', oak_sapling: 'sapling', oak_leaves: 'leaves', white_wool: 'wool',
  grass_block: 'grass', firework_rocket: 'fireworks', sugar_cane: 'reeds', oak_slab: 'wooden_slab', oak_door: 'wooden_door',
  oak_fence: 'fence', red_bed: 'bed', oak_boat: 'boat', nether_quartz_ore: 'quartz_ore', cobweb: 'web',
  // 1.8 和 1.12 的工具已经是这些名字；保留原条目，不凭空造 wood_shovel 一类旧名。
  ...Object.fromEntries(['wooden', 'golden', 'stone', 'iron', 'diamond'].flatMap((material) =>
    ['shovel', 'pickaxe', 'axe', 'sword', 'hoe'].map((tool) => [`${material}_${tool}`, `${material}_${tool}`]))),
})
function installLegacyAliases(registry, facts) {
  if (facts.flattening) return 0
  let added = 0
  for (const entries of [registry.itemsByName, registry.blocksByName]) {
    if (!entries) continue
    for (const [modern, legacy] of Object.entries(LEGACY_ALIASES)) {
      if (!Object.hasOwn(entries, modern) && Object.hasOwn(entries, legacy)) { entries[modern] = entries[legacy]; added++ }
    }
  }
  return added
}

const VERIFIED_FLIGHT = new Set(['1.21.4', '26.1', '26.1.1', '26.1.2'])
const flightVerified = (version) => VERIFIED_FLIGHT.has(version)

module.exports = { versionFacts, describeVersion, installLegacyAliases, flightVerified, releaseOf, compareRelease, LEGACY_ALIASES }
