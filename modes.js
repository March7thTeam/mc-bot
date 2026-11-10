// 常驻行为模式（参考 Mindcraft 的 modes）：本地每秒检查一次，不调用 AI。
// 按顺序检查，排在前面的触发了就不再看后面的。
const { goals } = require('mineflayer-pathfinder')

const DESCRIPTIONS = {
  self_preservation: '自救：溺水上浮、离开岩浆和火',
  unstuck: '脱困：走路卡住 15 秒就晃一下重新走',
  item_collecting: '捡物：空闲时捡 8 格内的掉落物（默认关）',
  idle_staring: '看人：空闲时看着附近的玩家',
  elbow_room: '让位：空闲时给贴近的玩家让出小片安全空间（默认关）',
  sleep_with_players: '陪睡：有玩家上床时，空闲的我也找空床睡，帮大家跳过夜晚',
}

function createModes(bot, ctx) {
  const enabled = { self_preservation: true, unstuck: true, item_collecting: false, idle_staring: true, elbow_room: false, sleep_with_players: true }
  const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire'])

  let evasion = null
  const recovering = () => evasion && evasion.generation === ctx.generation() && evasion.activity === ctx.activityId?.()
  function moveAway(dist, reason) {
    if (recovering() && Date.now() - evasion.started < 4000) return
    if (recovering() && bot.pathfinder.goal === evasion.goal && bot.pathfinder.isMoving()) return
    const p = bot.entity.position
    const goal = new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, dist))
    evasion = { goal, started: Date.now(), generation: ctx.generation(), activity: ctx.activityId?.() }
    ctx.log(`[mode] 危险（${reason}），跑开`)
    if (bot.pvp.target) { bot.pvp.stop(); bot.pathfinder.setGoal(null) }
    bot.pathfinder.setGoal(goal)
  }
  function finishEvasion() {
    if (!recovering()) { evasion = null; return }
    const goal = evasion.goal
    evasion = null
    if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
    if (!ctx.busy()) ctx.resume()
  }

  // 这一列往上是连续的水，顶上露天（没被冰、石头盖住）
  const waterOpensAbove = (p) => {
    for (let y = 1; y <= 6; y++) {
      const b = bot.blockAt(p.offset(0, y, 0))
      if (!b) return true
      if (b.name === 'water' || /seagrass|kelp|bubble_column/.test(b.name)) continue
      return b.boundingBox === 'empty'
    }
    return false
  }
  const nearestOpenWater = (p) => {
    let best = null, bestDist = Infinity
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        const d = Math.hypot(dx, dz)
        if (d >= bestDist) continue
        const at = p.offset(dx, 0, dz)
        if (bot.blockAt(at)?.name === 'water' && waterOpensAbove(at)) { best = at; bestDist = d }
      }
    }
    return best
  }
  let escaping = false

  // 下界实测：带着防火效果去找玩家，脚下踩到岩浆块、身上余火都在触发跑开，把赶路的目标顶掉（GoalChanged）后整趟放弃。
  // 有防火时火和岩浆块伤不到人，只躲岩浆本身；赶路途中踩过岩浆块也不打断，走过去就离开了。
  const fireResistant = () => {
    const id = bot.registry.effectsByName?.fire_resistance?.id
    return id !== undefined && !!bot.entity.effects?.[id]
  }
  function hazard(feet, below) {
    const e = bot.entity
    if (e.isInLava || feet?.name === 'lava') return 'lava'
    if (below?.name === 'lava' && !e.onGround && e.velocity?.y < -0.08) {
      const predicted = e.position.plus(e.velocity.scaled(2))
      if (bot.blockAt(predicted.offset(0, -0.2, 0))?.name === 'lava') return 'lava'
    }
    if (fireResistant()) return null
    const hot = [feet, below].find((b) => b?.name !== 'lava' && DANGER.has(b?.name))
    if (hot && !(hot === below && hot.name === 'magma_block' && bot.pathfinder.isMoving())) return hot.name
    return e.onFire && !bot.pathfinder.isMoving() && !recovering() ? '着火' : null
  }

  const modes = {
    self_preservation() {
      const feet = bot.blockAt(bot.entity.position)
      const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
      const danger = hazard(feet, below)
      if (danger) {
        moveAway(5, danger)
        return true
      }
      // 头顶有沙子/砂砾正在掉（参考 Mindcraft self_preservation）
      const p = bot.entity.position
      const falling = bot.nearestEntity((e) => e.name === 'falling_block' && Math.abs(e.position.x - p.x) < 1.2 &&
        Math.abs(e.position.z - p.z) < 1.2 && e.position.y > p.y && e.position.y - p.y < 6)
      if (falling) {
        moveAway(3, '头顶掉方块')
        return true
      }
      const inWater = feet?.name === 'water' || bot.entity.isInWater
      if (recovering() && bot.entity.onGround === false && !inWater) return true
      finishEvasion()
      if (inWater && (bot.oxygenLevel ?? 20) < 15) {
        bot.setControlState('jump', true) // 往上浮
        // 头顶被冰或石头盖住，光上浮出不去：游向最近能露头的水面，没有就挖开头顶
        if (!waterOpensAbove(p)) {
          if (!escaping) { escaping = true; bot.pathfinder.stop(); ctx.log('[mode] 水下头顶被盖住，找地方换气') }
          const gap = nearestOpenWater(p)
          if (gap) {
            bot.lookAt(gap, true)
            bot.setControlState('forward', true)
          } else if (!bot.targetDigBlock) {
            const roof = bot.blockAt(p.offset(0, 2, 0))
            if (roof?.diggable && roof.boundingBox === 'block' && roof.name !== 'modded_block') bot.dig(roof, true).catch(() => {})
          }
        }
        return true
      }
      if (escaping) { escaping = false; bot.setControlState('forward', false) }
      if (bot.getControlState('jump') && !inWater && !bot.pathfinder.isMoving()) bot.setControlState('jump', false)
      return false
    },

    unstuck: (() => {
      let last = null
      let since = 0
      let attempts = 0
      let recoveringUntil = 0
      let owner = null
      // 第一次先回格子中央（实测：水里贴着方块拐角，往回退也退不开），之后换个不会摔的方向试
      const nudge = () => {
        const p = bot.entity.position
        let yaw = Math.atan2(-(Math.floor(p.x) + 0.5 - p.x), -(Math.floor(p.z) + 0.5 - p.z))
        if (attempts > 1) {
          const start = Math.random() * Math.PI * 2
          const open = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => start + i * Math.PI / 4)
            .find((a) => [1, 2, 3].every((d) => !ctx.isDropAt?.(p.offset(-Math.sin(a) * d, 0, -Math.cos(a) * d).floored())))
          if (open === undefined) return
          yaw = open
        }
        bot.look(yaw, 0, true).catch(() => {})
        bot.setControlState('forward', true)
      }
      return () => {
        const currentOwner = `${ctx.generation()}:${ctx.activityId?.() ?? 0}`
        if (owner !== currentOwner) { owner = currentOwner; last = null; since = Date.now(); attempts = 0; recoveringUntil = 0 }
        if (ctx.transientPause?.() || bot.targetDigBlock) { last = null; since = Date.now(); return false }
        if (Date.now() < recoveringUntil) return false
        if (!bot.pathfinder.isMoving() || bot.pvp.target) { last = null; return false }
        const p = bot.entity.position
        if (!last) { last = p.clone(); since = Date.now(); return false }
        if (p.distanceTo(last) > 1.5) { last = p.clone(); since = Date.now(); attempts = 0; return false }
        if (Date.now() - since < 15_000) return false
        if (attempts >= 3) {
          ctx.log('[mode] 连续脱困未取得进展，停止任务')
          ctx.cancelTask?.()
          ctx.say('连续3次脱困仍没进展，已停止，请换路线或靠近后再试')
          attempts = 0; last = null
          return true
        }
        attempts++
        const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => `${bot.blockAt(p.offset(x, 0, z))?.name}/${bot.blockAt(p.offset(x, 1, z))?.name}`).join(' ')
        ctx.log(`[mode] 卡住了，重新走 @ ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} 脚下${bot.blockAt(p.offset(0, -1, 0))?.name} 四周(脚/头) ${around}`)
        since = Date.now()
        recoveringUntil = Date.now() + 1200
        // 停掉当前路径（travel 会把 PathStopped 当作打断自动重试），跳一下换个位置
        bot.pathfinder.stop()
        bot.setControlState('jump', true)
        nudge()
        const generation = ctx.generation()
        const activity = ctx.activityId?.()
        setTimeout(() => {
          if (generation !== ctx.generation() || ctx.paused?.() || activity !== ctx.activityId?.()) return
          bot.setControlState('jump', false)
          bot.setControlState('forward', false)
          if (!ctx.busy()) ctx.resume() // 跟随/站岗不是任务，没人重试，手动恢复
        }, 800)
        return true
      }
    })(),

    elbow_room: (() => {
      let next = 0
      return () => {
        if (ctx.occupied?.() || ctx.busy() || bot.pathfinder.isMoving() || Date.now() < next) return false
        const player = bot.nearestEntity((e) => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 0.8)
        if (!player) return false
        const here = bot.entity.position.floored()
        const clear = (p) => {
          const below = bot.blockAt(p.offset(0, -1, 0)), feet = bot.blockAt(p), head = bot.blockAt(p.offset(0, 1, 0))
          return below?.boundingBox === 'block' && !DANGER.has(below.name) && below.name !== 'modded_block' &&
            ['air', 'cave_air'].includes(feet?.name) && ['air', 'cave_air'].includes(head?.name)
        }
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const near = here.offset(dx, 0, dz), dest = here.offset(dx * 2, 0, dz * 2)
          if (dest.distanceTo(player.position) <= here.distanceTo(player.position) || !clear(near) || !clear(dest)) continue
          next = Date.now() + 10_000
          const ownGoal = new goals.GoalNear(dest.x, dest.y, dest.z, 0.5)
          bot.pathfinder.setGoal(ownGoal)
          const generation = ctx.generation()
          setTimeout(() => {
            if (generation === ctx.generation() && !ctx.occupied?.() && bot.pathfinder.goal === ownGoal) bot.pathfinder.setGoal(null)
          }, 3000)
          return true
        }
        next = Date.now() + 5000
        return false
      }
    })(),

    item_collecting: (() => {
      let seenAt = 0
      let seenId = null
      const ignored = new Map()
      return () => {
        if (ctx.occupied?.() || ctx.transientPause?.() || ctx.busy() || bot.pathfinder.isMoving() || bot.inventory.emptySlotCount() < 2) { seenAt = 0; seenId = null; return false }
        for (const [id, until] of ignored) if (until <= Date.now()) ignored.delete(id)
        const item = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
        if (!item || ignored.has(item.id)) { seenAt = 0; seenId = null; return false }
        if (seenId !== item.id) { seenAt = Date.now(); seenId = item.id; return false }
        if (Date.now() - seenAt < 2000) return false // 等 2 秒，给扔东西的人反应时间
        seenAt = 0
        seenId = null
        const ownGoal = new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5)
        const path = bot.pathfinder.getPathTo?.(bot.pathfinder.movements, ownGoal, 40)
        if (path?.status !== 'success') {
          if (ignored.size >= 64) ignored.delete(ignored.keys().next().value)
          ignored.set(item.id, Date.now() + 30_000)
          return false
        }
        bot.pathfinder.setGoal(ownGoal)
        const generation = ctx.generation(), activity = ctx.activityId?.()
        setTimeout(() => {
          if (generation !== ctx.generation() || activity !== ctx.activityId?.() || ctx.occupied?.() || ctx.transientPause?.()) return
          if (bot.pathfinder.goal === ownGoal) {
            bot.pathfinder.setGoal(null)
            if (ignored.size >= 64) ignored.delete(ignored.keys().next().value)
            ignored.set(item.id, Date.now() + 30_000)
          }
        }, 5000)
        return true
      }
    })(),

    sleep_with_players: (() => {
      let next = 0
      // 实体元数据 pose：2 = 睡觉
      const poseIndex = () => bot.registry.entitiesByName.player?.metadataKeys?.indexOf('pose') ?? 6
      return () => {
        if (Date.now() < next || bot.isSleeping || ctx.busy() || ctx.transientPause?.()) return false
        const time = bot.time?.timeOfDay ?? 0
        if (time < 12_500 && !bot.thunderState) return false
        const i = poseIndex()
        const sleeper = Object.values(bot.players).find((pl) => pl.username !== bot.username && pl.entity?.metadata?.[i] === 2)
        if (!sleeper) return false
        next = Date.now() + 30_000
        ctx.log(`[mode] ${sleeper.username} 睡了，陪睡`)
        ctx.sleepWithPlayers?.()
        return true
      }
    })(),

    idle_staring: (() => {
      let next = 0
      return () => {
        if (ctx.occupied?.() || ctx.busy() || bot.pathfinder.isMoving() || bot.pvp.target || Date.now() < next) return false
        next = Date.now() + 2000 + Math.random() * 4000
        const player = bot.nearestEntity((e) => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 10)
        if (player) bot.lookAt(player.position.offset(0, player.height ?? 1.6, 0)).catch(() => {})
        return false // 纯装饰，不拦后面的模式
      }
    })(),
  }

  setInterval(() => {
    if (!bot.entity || ctx.paused?.()) return
    for (const [name, fn] of Object.entries(modes)) {
      if (!enabled[name]) continue
      try {
        if (fn()) break
      } catch (err) {
        ctx.log(`[mode:${name}] ${err.message}`)
      }
    }
  }, 1000)

  return {
    recovering,
    list: () => Object.keys(modes).map((n) => `${n}:${enabled[n] ? '开' : '关'}`).join(' '),
    describe: () => Object.entries(DESCRIPTIONS).map(([n, d]) => `${n}(${enabled[n] ? '开' : '关'}) ${d}`),
    set(name, on) {
      if (!Object.hasOwn(enabled, name)) return false
      enabled[name] = on
      if (name === 'self_preservation' && !on) finishEvasion()
      return true
    },
  }
}

module.exports = { createModes }
