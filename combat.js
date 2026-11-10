// 战斗：每 250ms 评估一次威胁，按优先级处理；血量不足时优先撤退。
//   1. 血少：跑开，甩掉了再吃
//   2. 苦力怕：膨胀了就跑；有弓远射；没弓就打一下退开（击退能打断引信）
//   3. 骷髅（小白）：会在远处放箭，被射了就主动找它；有盾举盾冲过去，有弓也能对射
//   4. 其他敌对生物：近战（也帮附近被怪贴身的玩家）
//   5. 骑乘怪：同步骑手坐标后按骑手打；拿不到骑手时打坐骑
const { goals } = require('mineflayer-pathfinder')

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'parched', 'spider', 'cave_spider',
  'creeper', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'zombie_villager',
  'silverfish', 'endermite', 'blaze', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'breeze', 'guardian'])
const SKELETONS = new Set(['skeleton', 'stray', 'bogged', 'parched']) // parched：26.1 沙漠里的骷髅变种
const RANGED = new Set([...SKELETONS, 'pillager'])
const UNSAFE_GROUND = /lava|fire|magma_block|cactus|powder_snow|sweet_berry_bush|pointed_dripstone/
// 骑乘怪（僵尸马骑士、骷髅陷阱马、骆驼尸壳骑手…）：服务器不给乘客单独发移动包，
// mineflayer 里骑手的位置一直停在上马那一刻，距离判断和追击都错。坐骑一动就把乘客坐标同步到坐骑上方。
const MOUNTS = new Set(['zombie_horse', 'skeleton_horse', 'camel_husk', 'zombie_nautilus', 'spider', 'chicken', 'horse', 'camel', 'nautilus', 'strider'])
const MATERIAL_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
const LOW_HP = 8
const CREEPER_SWELL = 16 // 实体元数据：苦力怕膨胀状态，1 = 正在点燃（实测 26.1）
const LIVING_HEALTH = 9 // 实体元数据：生物血量

function weaponScore(name) {
  const m = name.match(/^(\w+?)_(sword|axe)$/)
  if (!m) return -1
  return MATERIAL_RANK.indexOf(m[1]) * 2 + (m[2] === 'sword' ? 1 : 0) // 同材质优先剑，攻速快
}

function createCombat(bot, ctx) {
  let enabled = true
  let mode = null // 'retreat' | 'flee' | 'shoot' | 'melee' | 'watch'
  let shooting = false
  let blocking = false
  let equippingShield = false
  let retreatArchers = []
  let retreatMovement = null
  let lastHit = 0
  let lastHurt = 0
  let generation = 0
  // 追了 12 秒还没打到（隔墙、在坑里、够不着）就拉黑 60 秒，免得一直卡在"战斗中"拖住别的事
  const ignored = new Map() // entity id -> 解禁时间
  let engaged = null // { id, since }
  const isIgnored = (e) => (ignored.get(e.id) ?? 0) > Date.now()
  function checkEngaged(mob, limit = 12_000) {
    const hp = mob.metadata?.[LIVING_HEALTH]
    if (engaged?.id !== mob.id) engaged = { id: mob.id, since: Date.now(), hp }
    if (hp !== undefined && hp !== engaged.hp) { engaged.since = Date.now(); engaged.hp = hp } // 打到了就重新计时
    if (Date.now() - engaged.since < limit) return true
    ctx.log(`[combat] ${mob.name} 够不着，先不管它`)
    ignored.set(mob.id, Date.now() + 60_000)
    engaged = null
    return false
  }

  const dist = (e) => e.position.distanceTo(bot.entity.position)
  const count = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  const hasBow = () => count('bow') > 0 && count('arrow') > 0
  const nearest = (filter, range) => bot.nearestEntity((e) => filter(e) && dist(e) < range && !isIgnored(e))
  const offHand = () => bot.inventory.slots[45]

  bot.on('entityMoved', (vehicle) => {
    if (!vehicle.passengers?.length || !MOUNTS.has(vehicle.name)) return
    for (const rider of vehicle.passengers) {
      if (rider === bot.entity || !bot.entities[rider.id]) continue
      rider.position = vehicle.position.offset(0, (vehicle.height ?? 1.4) * 0.75, 0)
    }
  })
  // 骑手被打死/下马后，坐骑本身：无人骑的僵尸马不主动攻击，不追
  const mountedThreat = (e) => MOUNTS.has(e.name) && e.passengers?.some((r) => HOSTILE.has(r.name))

  bot.on('auto_shot_stopped', () => { shooting = false })
  bot.on('entityHurt', (e) => { if (e === bot.entity) lastHurt = Date.now() })

  async function equipWeapon() {
    if (ctx.paused?.()) return
    const best = bot.inventory.items().filter((i) => weaponScore(i.name) >= 0)
      .sort((a, b) => weaponScore(b.name) - weaponScore(a.name))[0]
    if (best && bot.heldItem?.name !== best.name) await bot.equip(best, 'hand').catch(() => {})
  }
  async function equipShield() {
    if (equippingShield || offHand()?.name === 'shield') return
    const shield = bot.inventory.items().find((i) => i.name === 'shield')
    if (!shield) return
    equippingShield = true
    try { await bot.equip(shield, 'off-hand') } catch {} finally { equippingShield = false }
  }

  function stopShooting() {
    if (shooting) bot.hawkEye.stop()
    shooting = false
  }
  function begin(next) {
    if (!mode) ctx.onCombatStart()
    mode = next
  }
  // 和怪保持距离：GoalInvert(GoalFollow) 会一直往远离它的方向走
  // 每 250ms 评估一次，已经在躲同一只就别换目标：每次 setGoal 都丢掉路径重算，人走走停停（实测只有 1.6 格/秒，被追上炸）
  let flight = null // { goal, id, range }
  function stopMelee() {
    if (!bot.pvp.target) return
    bot.pvp.stop()
    // Consume the plugin's pending path stop before assigning the retreat goal.
    bot.pathfinder.setGoal(null)
  }
  function fleeFrom(mob, range, why) {
    stopMelee()
    stopShooting()
    if (mode !== why) ctx.log(`[combat] ${why}: 躲开 ${mob.name}`)
    begin(why)
    if (flight?.id === mob.id && flight.range === range && bot.pathfinder.goal === flight.goal) return
    flight = { id: mob.id, range, goal: new goals.GoalInvert(new goals.GoalFollow(mob, range)) }
    bot.pathfinder.setGoal(flight.goal, true)
  }

  function visibleFrom(mob, position) {
    if (!bot.world?.raycast) return true
    const eye = mob.position.offset(0, mob.eyeHeight ?? (mob.height ?? 1.8) * 0.85, 0)
    // A lip that hides the feet alone won't block an arrow at the torso or head.
    return [0.8, 1.6].some((height) => {
      const delta = position.offset(0, height, 0).minus(eye), range = delta.norm()
      return range < 0.2 || !bot.world.raycast(eye, delta.scaled(1 / range), range - 0.1)
    })
  }

  function findCover(archers, threats, moves) {
    if (!archers.length || !moves || !bot.pathfinder.getPathFromTo) return null
    const origin = bot.entity.position, base = origin.floored(), options = []
    for (const radius of [6, 10]) for (let step = 0; step < 8; step++) {
      const angle = step * Math.PI / 4, dx = Math.round(radius * Math.cos(angle)), dz = Math.round(radius * Math.sin(angle))
      for (const dy of [0, 1, -1]) {
        const cell = base.offset(dx, dy, dz)
        const floor = bot.blockAt(cell.offset(0, -1, 0)), feet = bot.blockAt(cell), head = bot.blockAt(cell.offset(0, 1, 0))
        if (floor?.boundingBox !== 'block' || feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty' ||
            [floor, feet, head].some(b => UNSAFE_GROUND.test(b.name) || b.name === 'water')) continue
        const point = cell.offset(0.5, 0, 0.5)
        const clearance = Math.min(...threats.map(mob => mob.position.distanceTo(point)))
        if (clearance < 5 || threats.some(mob => mob.position.distanceTo(point) < Math.min(6, dist(mob)))) continue
        const exposed = archers.filter(mob => visibleFrom(mob, point)).length
        if (exposed < archers.length) options.push({ cell, point, exposed, clearance, distance: origin.distanceTo(point) })
      }
    }
    options.sort((a, b) => a.exposed - b.exposed || a.distance - b.distance || b.clearance - a.clearance)
    for (const candidate of options.slice(0, 4)) {
      const { x, y, z } = candidate.cell, goal = new goals.GoalBlock(x, y, z)
      const path = bot.pathfinder.getPathFromTo(moves, origin, goal, { timeout: 30, tickTimeout: 12, searchRadius: 20 }).next().value?.result
      if (path?.status === 'success' && path.path.length > 0) return { goal, point: candidate.point }
    }
    return null
  }

  function retreat(threats, archers) {
    const exposed = archers.filter(mob => visibleFrom(mob, bot.entity.position))
    const near = threats.find(mob => !RANGED.has(mob.name) || exposed.includes(mob))
    retreatArchers = exposed
    if (!near) {
      if (mode) end()
      return ctx.autoEat(true)
    }
    if (mode !== 'retreat') generation++ // Cancel pending weapon-equip/attack continuations.
    if (exposed.length) equipShield()
    stopMelee()
    stopShooting()
    const moves = ctx.retreatMoves?.(), owner = ctx.movementOwner?.()
    if (moves && bot.pathfinder.movements !== moves) {
      retreatMovement = { moves, previous: bot.pathfinder.movements, owner }
      bot.pathfinder.setMovements(moves)
    }
    if (flight?.cover && bot.pathfinder.goal === flight.goal && Date.now() - flight.started < 4000 &&
        !threats.some(mob => mob.position.distanceTo(flight.cover) < 4)) return
    if (flight?.id === near.id && bot.pathfinder.goal === flight.goal && Date.now() - flight.started < 1500) return
    const cover = findCover(exposed, threats, moves)
    if (!cover) {
      fleeFrom(near, RANGED.has(near.name) ? 24 : 16, 'retreat')
      flight.started = Date.now()
      return
    }
    begin('retreat')
    flight = { goal: cover.goal, cover: cover.point, started: Date.now() }
    ctx.log(`[combat] retreat: 转移到掩体 ${cover.point.floored()}`)
    bot.pathfinder.setGoal(cover.goal)
  }
  function shoot(mob) {
    begin('shoot')
    if (shooting) return
    bot.pvp.stop()
    bot.pathfinder.setGoal(null)
    shooting = true
    ctx.log(`[combat] 射 ${mob.name}`)
    bot.hawkEye.oneShot(mob, 'bow')
  }
  function melee(mob) {
    if (!checkEngaged(mob)) return end()
    begin('melee')
    if (bot.pvp.target === mob) {
      if (!ctx.isEating?.()) equipWeapon() // 吃完东西或盖房换手后，手里可能已经不是武器
      return
    }
    stopShooting()
    const run = generation
    equipWeapon().then(() => {
      if (run === generation && enabled && !ctx.paused?.() && bot.entities[mob.id]) bot.pvp.attack(mob)
    }).catch((err) => ctx.log(`[combat] ${err.message}`))
  }

  let fuse = null // { id, since }
  function hitCreeper(c) {
    begin('melee')
    lastHit = Date.now()
    const run = generation
    equipWeapon().then(() => {
      if (run !== generation || !enabled || ctx.paused?.() || !bot.entities[c.id]) return
      bot.attack(c)
      fleeFrom(c, 8, 'flee')
    }).catch((err) => ctx.log(`[combat] ${err.message}`))
  }
  function handleCreeper(c) {
    const d = dist(c)
    const fusing = c.metadata[CREEPER_SWELL] === 1
    if (!fusing) fuse = null
    else if (fuse?.id !== c.id) fuse = { id: c.id, since: Date.now() }
    // 只跑不打会被逼到角落炸（实测）：引信 1.5 秒，前 0.7 秒够得着就先砍一刀（击退也拉开距离），再跑
    if (fusing && d <= 3.3 && !hasBow() && Date.now() - fuse.since < 700 && Date.now() - lastHit > 600) return hitCreeper(c)
    if (fusing && d < 7) return fleeFrom(c, 8, 'flee') // 跑出 7 格引信就会中断
    if (hasBow() && d >= 4) return shoot(c)
    if (hasBow()) return fleeFrom(c, 6, 'flee') // 有弓就拉开距离再射
    // 没弓：贴近时打一下立刻退开，击退 + 后撤让它点不着
    if (d <= 3.3 && Date.now() - lastHit > 600) return hitCreeper(c)
    if (d < 2.5) return fleeFrom(c, 5, 'flee')
    // 3~8 格：原地等它靠近，别迎上去（等太久说明它过不来）
    if (!checkEngaged(c, 30_000)) return end() // 边打边退耗时长：12 秒就不管的话，它追上来就在身边炸了
    begin('watch')
    bot.pvp.stop()
    bot.pathfinder.setGoal(null)
    bot.lookAt(c.position.offset(0, 1.2, 0)).catch(() => {})
  }

  setInterval(() => {
    if (!enabled || !bot.entity || ctx.paused?.()) return

    if (bot.health <= 12) {
      const threats = Object.values(bot.entities).filter((mob) => mob.isValid !== false && HOSTILE.has(mob.name) &&
        dist(mob) < (RANGED.has(mob.name) ? 24 : 10)).sort((a, b) => dist(a) - dist(b))
      const archers = threats.filter(mob => RANGED.has(mob.name))
      if (bot.health <= LOW_HP || mode === 'retreat' || archers.length >= 2 || (archers.length && threats.length >= 3)) return retreat(threats, archers)
    }
    if (mode === 'retreat') end()

    const creeper = nearest((e) => e.name === 'creeper', 10)
    if (creeper) return handleCreeper(creeper)

    // 骷髅射程远：血够就 14 格内主动处理；刚被射中就扩大到 24 格找它
    const hurtRecently = Date.now() - lastHurt < 3000
    const skelRange = bot.health > 12 ? (hurtRecently ? 24 : 14) : 6
    // 要保护的玩家：跟随对象 + 附近的队友（血量够时）。怪贴近他们也算威胁
    const guardees = ctx.protectees?.() || []
    const nearGuardee = (e, r) => dist(e) < 20 && guardees.some((g) => e.position.distanceTo(g.position) < r)
    const skel = nearest((e) => SKELETONS.has(e.name) && (dist(e) < skelRange || nearGuardee(e, 10)), 24)
    if (skel) {
      equipShield()
      if (hasBow() && dist(skel) > 8) return shoot(skel)
      return melee(skel)
    }

    // 幻翼在天上飞，追不到（日志里一直"够不着"）：只在它俯冲到身边时砍一下，不移动
    const phantom = nearest((e) => e.name === 'phantom', 3.5)
    if (phantom && Date.now() - lastHit > 600) {
      begin('melee')
      const run = generation
      equipWeapon().then(() => {
        if (run !== generation || !enabled || ctx.paused?.() || !bot.entities[phantom.id]) return
        bot.attack(phantom)
        lastHit = Date.now()
      }).catch((err) => ctx.log(`[combat] ${err.message}`))
      return
    }
    const mob = nearest((e) => HOSTILE.has(e.name) && !SKELETONS.has(e.name) && e.name !== 'creeper' && e.name !== 'phantom' &&
      (dist(e) < 6 || nearGuardee(e, 8)), 20)
    if (mob) return melee(mob)
    // 骑手位置拿不到（还没同步）时，至少把冲过来的坐骑当威胁处理：打马会把骑手摔下来
    const mount = nearest((e) => mountedThreat(e) && (dist(e) < 5 || nearGuardee(e, 6)), 20)
    if (mount) return melee(mount)

    if (mode && !shooting) end()
  }, 250)

  // 举盾：追骷髅的路上举着，贴脸了放下来砍
  bot.on('physicsTick', () => {
    if (ctx.paused?.()) return
    const t = bot.pvp.target
    // 盾只能挡前方。背向弓手时收盾，以全速拉开距离。
    const archerAhead = mode === 'retreat' && retreatArchers.some((mob) => {
      const p = bot.entity.position, yaw = bot.entity.yaw
      const dx = mob.position.x - p.x, dz = mob.position.z - p.z
      return -Math.sin(yaw) * dx - Math.cos(yaw) * dz > 0.25 * Math.hypot(dx, dz)
    })
    // 吃东西时不举盾：举盾/放下会打断进食（日志：撤退中连续"吃东西超时"后被射死）
    const want = !ctx.isEating?.() && offHand()?.name === 'shield' && ((!!t && SKELETONS.has(t.name) && dist(t) > 3.5) || archerAhead)
    if (want && !blocking) { bot.activateItem(true); blocking = true }
    if (!want && blocking) { bot.deactivateItem(); blocking = false }
  })

  function end() {
    generation++
    engaged = null
    mode = null
    bot.pvp.stop()
    stopShooting()
    if (flight && bot.pathfinder.goal === flight.goal) bot.pathfinder.setGoal(null)
    flight = null
    if (retreatMovement?.previous && retreatMovement.owner === ctx.movementOwner?.() && bot.pathfinder.movements === retreatMovement.moves) {
      bot.pathfinder.setMovements(retreatMovement.previous)
    }
    retreatMovement = null
    retreatArchers = []
    if (blocking) { bot.deactivateItem(); blocking = false }
    ctx.onCombatOver()
  }

  return {
    HOSTILE,
    equipWeapon,
    active: () => !!mode || !!bot.pvp.target || shooting,
    meleeing: () => mode === 'melee',
    // 等这场仗打完（最多 30 秒），给 travel / 挖矿用
    waitOver: () => new Promise((resolve) => {
      const started = Date.now()
      const t = setInterval(() => {
        if ((!mode && !bot.pvp.target && !shooting) || Date.now() - started > 30_000) { clearInterval(t); resolve() }
      }, 300)
    }),
    get enabled() { return enabled },
    set enabled(v) { enabled = v; if (!v && mode) end() },
    stop: () => { generation++; if (mode) end() },
  }
}

module.exports = { createCombat }
