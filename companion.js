// 观察字段参考 Voyager status，跟随换绑参考 Mineflayer StateMachine/AltoClef。
// 固定提交与采纳边界记录在 UPSTREAM_REFERENCES.md；不引入另一套代理循环。
function createCompanion(bot, ctx) {
  const now = ctx.now || Date.now
  let tracking = null
  let trackedEntity = null
  let death = null
  const position = (p) => p && ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const dim = () => ctx.dimension?.() || bot.game?.dimension || 'unknown'
  const items = () => bot.inventory?.items?.() || []
  const equipment = () => ['head', 'torso', 'legs', 'feet', 'off-hand'].map((part) => {
    const fallback = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }
    const slot = bot.getEquipmentDestSlot?.(part) ?? fallback[part]
    return `${part}:${bot.inventory?.slots?.[slot]?.name || '空'}`
  }).join(' ')
  const space = () => bot.inventory?.emptySlotCount?.()
  function advice() {
    const list = [], inv = items()
    const count = (fn) => inv.filter(fn).reduce((n, i) => n + (Number.isFinite(i.count) ? i.count : 0), 0)
    const badFood = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'])
    const food = count((i) => Object.hasOwn(bot.registry?.foodsByName || {}, i.name) && !badFood.has(i.name))
    if (bot.health < 12) list.push('血量偏低，先避险和补充食物')
    if (bot.food < 18) list.push('饱食低于自然回血门槛，适合 bot eat')
    if (food < 4) list.push(`安全食物储备少（${food}），先补给`)
    if (Number.isFinite(space()) && space() < 3) list.push('背包快满了，适合 bot deposit 把物品存箱')
    if (!inv.some((i) => /_pickaxe$/.test(i.name))) list.push('缺镐，挖矿前先合成工具')
    const chest = bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6]
    if (!chest) list.push('胸部未装备护甲或鞘翅')
    if (chest?.name === 'elytra' && !inv.some((i) => i.name === 'firework_rocket')) list.push('穿着鞘翅但没有烟花，暂不适合飞行')
    if ((bot.time?.timeOfDay ?? 0) >= 12500) list.push('现在是夜晚，可找床睡觉')
    return list.length ? list.join('；') : '当前补给和状态没有明显缺口'
  }
  function scan() {
    const p = position(bot.entity?.position)
    const follow = ctx.getFollow?.()
    const state = follow ? `${follow.name}，${follow.distance}格${tracking?.waiting ? '，失联等待中' : ''}` : '无'
    return [`位置:${p ? `${p.x} ${p.y} ${p.z}` : '未知'} ${dim()}`,
      `血量:${bot.health}/20 饱食:${bot.food}/20 氧气:${bot.oxygenLevel ?? '?'}`,
      `空位:${space() ?? '?'} 跟随:${state}`, equipment()].join('；')
  }
  function lastDeath() {
    if (!death) return '本次启动后还没有死亡坐标记录'
    return `上次死亡:${death.position.x} ${death.position.y} ${death.position.z} ${death.dimension}，约${Math.floor((now() - death.time) / 60_000)}分钟前`
  }
  function recordDeath() {
    const p = position(bot.entity?.position)
    if (p) death = { position: p, dimension: dim(), time: now() }
  }
  function tick() {
    const follow = ctx.getFollow?.()
    if (!follow) { tracking = null; trackedEntity = null; return }
    if (!bot.entity || !(bot.health > 0) || ctx.paused?.()) return
    if (!tracking || tracking.name !== follow.name) { tracking = { name: follow.name, dimension: dim(), entityId: null, missingSince: null, waiting: false }; trackedEntity = null }
    if (tracking.dimension !== dim()) {
      ctx.clearFollow('维度变化，已停止旧的跟随')
      tracking = null
      trackedEntity = null
      return
    }
    const entity = Object.hasOwn(bot.players || {}, follow.name) && bot.players[follow.name]?.entity
    if (entity && entity.isValid !== false) {
      if (tracking.entityId !== entity.id || trackedEntity !== entity || tracking.waiting) {
        ctx.followEntity(entity, follow.distance)
        if (tracking.waiting) ctx.say(`重新看到 ${follow.name}，继续跟随`)
      }
      tracking.entityId = entity.id
      trackedEntity = entity
      tracking.lastPosition = position(entity.position)
      tracking.missingSince = null
      tracking.waiting = false
      return
    }
    if (!tracking.waiting) {
      tracking.waiting = true
      tracking.missingSince = now()
      ctx.pauseFollow()
      ctx.say(`暂时看不到 ${follow.name}，原地等候，60秒内看到会继续跟随`)
    }
    if (now() - tracking.missingSince >= 60_000) {
      ctx.clearFollow('跟随对象失联超过60秒，已停止；重新靠近后再 bot follow')
      tracking = null
      trackedEntity = null
    }
  }
  bot.on('death', recordDeath)
  const timer = ctx.manualTick ? null : setInterval(() => {
    try { tick() } catch (err) { ctx.log?.(`[companion] ${err.message}`) }
  }, 1000)
  timer?.unref?.()
  return { scan, advice, lastDeath, tick, status: () => tracking && { ...tracking },
    resetFollow() { tracking = null; trackedEntity = null },
    dispose() { if (timer) clearInterval(timer); bot.removeListener('death', recordDeath); tracking = null; trackedEntity = null } }
}

module.exports = { createCompanion }
