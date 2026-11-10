'use strict'

const { Vec3 } = require('vec3')
const { flightVerified, compareRelease } = require('./versions')

// The phase/pitch guidance and angle normalization are adapted from EAFE.
// See THIRD_PARTY_NOTICES.md for the pinned sources and adaptation boundaries.
const DEFAULTS = Object.freeze({
  maxDistance: 60_000_000, maxRockets: 2304, maxFlightMs: 1_800_000, maxLandingMs: 120_000,
  tickMs: 50, takeoffMs: 2000, confirmMs: 1500, rocketAckMs: 1500,
  boostCooldownMs: 3000, minHealth: 16, minFood: 14, durabilityReserve: 30,
  corridorLength: 16, landingRadius: 2, maxGroundDrop: 128,
  stableTicks: 4, stableSpeed: 0.12, arrivalRadius: 6, maxYawStep: 0.09,
  climbHeight: 16, terrainMargin: 20, siteSearchRadius: 48, chunkWaitMs: 45_000, inFlightMinFood: 6,
})

const AIR = new Set(['air', 'cave_air', 'void_air'])
// Deliberately allow ordinary full vanilla ground only. Unknown/modded machines,
// slabs, leaves, ice, honey, fences and interactable blocks are not landing pads.
const GROUND = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'stone', 'granite', 'polished_granite', 'diorite', 'polished_diorite', 'andesite',
  'polished_andesite', 'deepslate', 'cobbled_deepslate', 'polished_deepslate',
  'cobblestone', 'mossy_cobblestone', 'stone_bricks', 'mossy_stone_bricks',
  'bricks', 'mud_bricks', 'packed_mud', 'sandstone', 'smooth_sandstone',
  'cut_sandstone', 'red_sandstone', 'smooth_red_sandstone', 'cut_red_sandstone',
  'sand', 'red_sand', 'gravel', 'clay', 'terracotta', 'snow_block', 'moss_block',
  'calcite', 'tuff', 'polished_tuff', 'tuff_bricks', 'basalt', 'smooth_basalt',
  'obsidian', 'quartz_block', 'smooth_quartz', 'quartz_bricks',
  ...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'pale_oak'].map(n => `${n}_planks`),
  ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].flatMap(n => [`${n}_concrete`, `${n}_terracotta`]),
])

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const copyPosition = p => p ? { x: p.x, y: p.y, z: p.z } : null
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const speed = bot => Math.hypot(bot.entity?.velocity?.x || 0, bot.entity?.velocity?.y || 0, bot.entity?.velocity?.z || 0)
const horizontalSpeed = bot => Math.hypot(bot.entity?.velocity?.x || 0, bot.entity?.velocity?.z || 0)
const yawTo = (p, target) => Math.atan2(-(target.x - p.x), -(target.z - p.z))
function signedAngle(angle) {
  let diff = angle % (2 * Math.PI)
  if (diff < -Math.PI) diff += 2 * Math.PI
  if (diff > Math.PI) diff -= 2 * Math.PI
  return diff
}
const angleDiff = (a, b) => Math.abs(signedAngle(a - b))
const turnToward = (yaw, target, maxStep) => yaw + clamp(signedAngle(target - yaw), -maxStep, maxStep)

function options(input = {}) {
  const value = { ...DEFAULTS, ...input }
  for (const name of Object.keys(DEFAULTS)) {
    if (!Number.isFinite(value[name]) || value[name] <= 0) throw new Error(`无效飞行参数 ${name}`)
  }
  if (!Number.isInteger(value.maxRockets) || value.maxLandingMs > 180_000 || value.boostCooldownMs < 1500 ||
      value.landingRadius < 2 || value.tickMs > 250 || !Number.isInteger(value.stableTicks) ||
      value.maxYawStep > 0.12 || value.corridorLength < 12 || value.climbHeight > 40 ||
      value.minHealth < 16 || value.minFood < 14 || value.durabilityReserve < 20) {
    throw new Error('飞行参数超出安全边界')
  }
  return Object.freeze(value)
}

function blockAt(bot, x, y, z) {
  try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))) } catch { return null }
}
const isAir = block => !!block && AIR.has(block.name)
// 没有碰撞又没危险的（草、花）穿过去没事。当障碍的话，自然地形上几乎找不到起飞点和落点（实测：平原走 350 格都起飞不了）
const HAZARD = /water|lava|fire|web|powder_snow|berry|wither_rose|bubble/
const passable = block => !!block && (AIR.has(block.name) || (block.boundingBox === 'empty' && !HAZARD.test(block.name)))
function safeGround(block) {
  if (!block || !GROUND.has(block.name) || block.boundingBox !== 'block') return false
  // A claimed block bounding box alone is insufficient for partial collision.
  return !Array.isArray(block.shapes) || block.shapes.some(s => s.length === 6 && s.every((n, i) => n === (i < 3 ? 0 : 1)))
}
function groundSurvey(bot, x, z, fromY, maxDrop) {
  const minY = Math.max(Number.isFinite(bot.game?.minY) ? bot.game.minY : -64, Math.floor(fromY) - maxDrop)
  for (let y = Math.floor(fromY); y >= minY; y--) {
    const block = blockAt(bot, x, y, z)
    if (!block) return { status: 'unknown' }
    if (!passable(block)) return safeGround(block) ? { status: 'safe', y } : { status: 'unsafe' }
  }
  return { status: 'unsafe' }
}

function patchSurvey(bot, x, y, z, radius) {
  let unknown = false
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const ground = blockAt(bot, x + dx, y - 1, z + dz)
      if (!ground) unknown = true
      else if (!safeGround(ground)) return { status: 'unsafe' }
      for (let up = 0; up < 4; up++) {
        const block = blockAt(bot, x + dx, y + up, z + dz)
        if (!block) unknown = true
        else if (!passable(block)) return { status: 'unsafe' }
      }
    }
  }
  return { status: unknown ? 'unknown' : 'safe' }
}

// A 5-wide, 13-long flat runway: the stall approach needs little roll-out, and
// a 21-long one barely exists in natural terrain (tested: no site near target). Every cell must be loaded and supported, including the wing width.
// Unknown cells are not proof of either a safe runway or an actual obstacle.
function landingSurvey(bot, point, yaw, config) {
  const x = Math.floor(point.x) + 0.5, z = Math.floor(point.z) + 0.5
  const ground = groundSurvey(bot, x, z, point.y + 2, config.maxGroundDrop)
  if (ground.status !== 'safe') return { status: ground.status, site: null }
  const y = ground.y + 1
  let unknown = false
  for (const offset of [-4, 0, 4]) {
    const patch = patchSurvey(bot, x - Math.sin(yaw) * offset, y, z - Math.cos(yaw) * offset, config.landingRadius)
    if (patch.status === 'unsafe') return { status: 'unsafe', site: null }
    if (patch.status === 'unknown') unknown = true
  }
  return unknown ? { status: 'unknown', site: null } : { status: 'safe', site: { x, y, z } }
}
const landingSite = (bot, point, yaw, config) => landingSurvey(bot, point, yaw, config).site

// 目标点不能落（树、水、坡）就由近到远在附近找一块，落下后再走过去。
// 只要圈内还有未加载的格子就报 unknown，等它加载；全加载了也没有才算 none。
function findLandingNear(bot, point, yaw, config, radius = config.siteSearchRadius, accept = () => true) {
  let unknown = false
  const from = { x: point.x, y: point.y + 24, z: point.z }
  for (let r = 0; r <= radius; r += 4) {
    const samples = r === 0 ? 1 : Math.ceil(2 * Math.PI * r / 4)
    for (let i = 0; i < samples; i++) {
      const a = i / samples * 2 * Math.PI
      const survey = landingSurvey(bot, { x: from.x + Math.cos(a) * r, y: from.y, z: from.z + Math.sin(a) * r }, yaw, config)
      if (survey.status === 'unknown') unknown = true
      else if (survey.site && accept(survey.site)) return { status: 'safe', site: survey.site }
    }
  }
  return { status: unknown ? 'unknown' : 'none', site: null }
}

// 沿航线看前方地形最高点，巡航高度跟着抬（只看已加载的；未加载的由 scanCorridor 报告）
function terrainCeiling(bot, point, yaw, length = 128) {
  const top = Math.min(319, Math.floor(point.y) + 96), bottom = Math.max(-64, Math.floor(point.y) - 64)
  const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw)
  let highest = -Infinity
  for (let distance = 0; distance <= length; distance += 8) {
    for (const side of [-8, 0, 8]) {
      const x = point.x - Math.sin(yaw) * distance + rightX * side
      const z = point.z - Math.cos(yaw) * distance + rightZ * side
      for (let y = top; y >= bottom && y > highest; y--) {
        const block = blockAt(bot, x, y, z)
        if (!block) break
        if (!isAir(block)) { highest = y; break }
      }
    }
  }
  return highest
}

// 脚下第一个非空气方块离多高（水、树也算），没有可降落点时用来决定什么时候拉起减速
function heightAboveAnything(bot, point, depth = 256) {
  const bottom = Math.max(-64, Math.floor(point.y) - depth)
  for (let y = Math.floor(point.y); y >= bottom; y--) {
    const block = blockAt(bot, point.x, y, point.z)
    if (!block) return Infinity
    if (!isAir(block)) return point.y - (y + 1)
  }
  return Infinity
}

// Read the body/wing corridor at half-block intervals to avoid skipping a
// diagonal one-block obstacle. Unknown, water and other hazards also block.
function scanCorridor(bot, point, yaw, pitch, config,
  length = Math.max(config.corridorLength, horizontalSpeed(bot) * 20 * 2 + 12), floorY = -Infinity) {
  const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw)
  for (let distance = 0; distance <= length; distance += 0.5) {
    const x = point.x - Math.sin(yaw) * distance
    const z = point.z - Math.cos(yaw) * distance
    // The verified final runway is a desired contact surface. Scan at feet
    // height instead of treating the intended ground contact as an obstacle.
    const y = Math.max(floorY, point.y + Math.tan(pitch) * distance)
    if (y >= 320) break // 建筑上限以上全是空气，读回来却是 null，别当成未知
    for (const side of [-1.5, -0.75, 0, 0.75, 1.5]) {
      for (const up of [0.1, 0.7, 1.4, 2]) {
        const block = blockAt(bot, x + rightX * side, y + up, z + rightZ * side)
        if (!passable(block)) return { clear: false, unknown: !block, distance, block: block?.name || null }
      }
    }
  }
  return { clear: true }
}

function openLaunch(bot, point, yaw, config) {
  return launchYaw(bot, point, yaw, config) !== null
}
// 头顶要空；起飞方向优先朝目标，挡着（紧贴墙、山）就换个方向，飞起来再转回去
function launchYaw(bot, point, yaw, config) {
  for (let up = 2; up <= config.climbHeight + 4; up++) {
    for (const dx of [-2, -1, 0, 1, 2]) for (const dz of [-2, -1, 0, 1, 2]) { // 翼宽：只看 ±1 会起飞时挂到树枝上（实测）
      if (!passable(blockAt(bot, point.x + dx, point.y + up, point.z + dz))) return null
    }
  }
  for (const turn of [0, 1, -1, 2, -2, 3, -3, 4]) {
    const candidate = yaw + turn * Math.PI / 4
    if (scanCorridor(bot, { ...point, y: point.y + 0.5 }, candidate, 0.45, config).clear) return candidate
  }
  return null
}

// 组件是相对原版默认值的补丁，空补丁代表时长 1；旧 NBT 为空却是时长 0。
function validRocket(item, version) {
  if (!flightVerified(version) || !item || !Number.isInteger(item.count) || item.count < 1 || item.count > 64) return false
  if (compareRelease(version, '1.20.5') < 0) {
    if (item.name !== (compareRelease(version, '1.13') < 0 ? 'fireworks' : 'firework_rocket')) return false
    const nbt = item.nbt, fireworks = nbt?.value?.Fireworks, flight = fireworks?.value?.Flight
    if (nbt?.type !== 'compound' || fireworks?.type !== 'compound' || flight?.type !== 'byte' || flight.value !== 1) return false
    const explosions = fireworks.value.Explosions
    return explosions === undefined || (explosions?.type === 'list' && ['compound', 'end'].includes(explosions.value?.type) &&
      Array.isArray(explosions.value.value) && explosions.value.value.length === 0)
  }
  if (item.name !== 'firework_rocket') return false
  if (!(item.componentMap instanceof Map) || !Array.isArray(item.components) || !Array.isArray(item.removedComponents)) return false
  for (const removed of item.removedComponents) {
    if (!removed || typeof removed.type !== 'string' || removed.type === 'fireworks' || removed.type === 'minecraft:fireworks') return false
  }
  const overrides = []
  for (const component of item.components) {
    if (!component || typeof component.type !== 'string' || component.type === 'minecraft:fireworks') return false
    if (component.type === 'fireworks') overrides.push(component)
  }
  if (item.componentMap.has('minecraft:fireworks') || overrides.length > 1) return false
  if (!item.componentMap.has('fireworks')) {
    // A missing or malformed raw override must never be reinterpreted as a
    // default. Legacy NBT is not a verified component patch representation.
    return overrides.length === 0 && item.nbt == null
  }
  const component = item.componentMap.get('fireworks')
  if (overrides.length !== 1 || component !== overrides[0] || component?.type !== 'fireworks') return false
  const data = component.data
  return !!data && data.flightDuration === 1 && Array.isArray(data.explosions) && data.explosions.length === 0
}
const inventoryItems = bot => bot.inventory?.items?.() || []
const rocketCount = bot => inventoryItems(bot).filter(item => validRocket(item, bot.version)).reduce((n, item) => n + item.count, 0)
function elytra(bot) {
  const slot = bot.getEquipmentDestSlot?.('torso') ?? 6
  return bot.inventory?.slots?.[slot]
}
function elytraRemaining(bot) {
  const item = elytra(bot)
  if (item?.name !== 'elytra' || !Number.isFinite(item.maxDurability) || !Number.isFinite(item.durabilityUsed) || item.durabilityUsed < 0) return -1
  return item.maxDurability - item.durabilityUsed
}
const spareElytras = bot => inventoryItems(bot).filter(item => item.name === 'elytra' && Number.isFinite(item.maxDurability))
const totalElytra = bot => Math.max(0, elytraRemaining(bot)) + spareElytras(bot).reduce((n, item) => n + item.maxDurability - (item.durabilityUsed || 0), 0)
function environmentFailure(bot, config, reserve = config.durabilityReserve, inFlight = false) {
  if (!bot.entity?.position || !bot.entity?.velocity) return 'entity_unavailable'
  if (bot.game?.dimension?.replace?.('minecraft:', '') !== 'overworld' || bot.game?.gameMode !== 'survival') return 'overworld_survival_required'
  if (!Number.isFinite(bot.health) || bot.health < config.minHealth) return 'health_low'
  // 飞行中不能吃东西：长途会慢慢饿，只在真的影响行动时才降落
  if (!Number.isFinite(bot.food) || bot.food < (inFlight ? config.inFlightMinFood : config.minFood)) return 'food_low'
  if (bot.entity.isInWater || bot.entity.isInLava || bot.entity.isOnFire || bot.entity.onFire) return 'water_fire_or_lava'
  const feet = blockAt(bot, bot.entity.position.x, bot.entity.position.y, bot.entity.position.z)
  if (!feet || /water|lava|fire|magma|powder_snow|cactus|sweet_berry|wither_rose|cobweb/.test(feet.name)) return 'unsafe_body_block'
  if (elytraRemaining(bot) < reserve) return 'elytra_missing_or_low_durability'
  return null
}

// EAFE's cruise pitch is the baseline, not an open-loop instruction to keep
// descending for the whole route. Native pitch-up converts horizontal energy
// into lift; a measured/predicted altitude deficit can also need a rocket even
// while horizontal speed remains well above the ordinary low-speed gate.
function cruiseGuidance(bot, cruiseY, timeSinceBoost, climbing) {
  const heightError = cruiseY - bot.entity.position.y
  const verticalSpeed = bot.entity.velocity.y
  const predictedError = heightError - verticalSpeed * 20 * 1.5
  const needsAltitudeBoost = (heightError >= 2 && verticalSpeed <= 0.05) || (heightError >= -0.5 && predictedError >= 4)
  let pitch
  if (climbing) pitch = timeSinceBoost < 1000 ? 0.45 : 0.65
  else {
    const base = timeSinceBoost < 1000 ? 0.15 : -0.04
    pitch = clamp(base + heightError * 0.055 - verticalSpeed * 0.65, -0.12, 0.45)
    if (heightError > 1.5) pitch = Math.max(0.20, pitch)
  }
  return { pitch, needsAltitudeBoost }
}

// EAFE's altitude-sensitive gravity descent and low-altitude pitch-up braking,
// with a bounded turn rate and a larger physical turn radius instead of a 1.2m
// synthetic spiral. No velocity, position, physics or flight flag is assigned.
function landingGuidance(bot, site, config) {
  const p = bot.entity.position
  const height = p.y - site.y
  const distance = horizontalDistance(p, site)
  const spd = horizontalSpeed(bot)
  let yaw = yawTo(p, site)
  let pitch = height > 60 ? -0.3 : height > 30 ? -0.15 : height > 15 ? -0.08 : height > 5 ? -0.03 : 0
  // 撞地伤害看速度（1.5 格/刻约 12 点）：提前按速度拉起失速，别等贴地才减
  if (height < 8 && (bot.entity.velocity.y < -0.15 || spd > 0.65)) pitch = 0.40
  else if (spd > 0.65 && height < 10 + spd * 20 && distance < spd * 60) pitch = 0.60
  else if (height <= 5 && distance > 2) pitch = clamp(Math.atan2(-height, distance) * 0.5, -0.12, 0.15)
  if (distance < Math.max(6, spd / config.maxYawStep) && height > 4) yaw += Math.PI / 2
  return { yaw: turnToward(bot.entity.yaw || 0, yaw, config.maxYawStep), pitch }
}

// 从现在的位置直线下滑到落点，路上有没有挡着的（只认已加载的方块）
function descentClear(bot, p, site, config) {
  const distance = horizontalDistance(p, site)
  if (distance < 1) return true
  return scanCorridor(bot, p, yawTo(p, site), Math.atan2(site.y - p.y, distance), config, distance, site.y).clear
}

// 下面没有能落的地（海、林）：飞回目标上空盘旋着降，别保持航向滑出几百格（实测偏了 380 格）；
// 快到障碍或贴近时先拉起失速，让撞上去的速度够小
function roughLanding(bot, target, config) {
  const p = bot.entity.position, spd = horizontalSpeed(bot), height = heightAboveAnything(bot, p)
  const distance = horizontalDistance(p, target)
  const yaw = turnToward(bot.entity.yaw || 0, distance < Math.max(24, spd / config.maxYawStep) ? (bot.entity.yaw || 0) + config.maxYawStep : yawTo(p, target), config.maxYawStep)
  const pitch = spd > 0.6 && height < 12 + spd * 25 ? 0.6 : height < 10 ? 0.3 : height < 30 ? -0.03 : -0.15
  return { yaw, pitch, height }
}

module.exports = { DEFAULTS, roughLanding, descentClear, options, copyPosition, horizontalDistance, speed, horizontalSpeed,
  yawTo, angleDiff, turnToward, blockAt, isAir, safeGround, landingSite, landingSurvey, findLandingNear, terrainCeiling,
  heightAboveAnything, scanCorridor, openLaunch, launchYaw, validRocket, inventoryItems, rocketCount, elytraRemaining, spareElytras, totalElytra,
  environmentFailure, cruiseGuidance, landingGuidance }
