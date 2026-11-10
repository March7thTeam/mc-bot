// 第二批技能（广泛参考同类项目后挑选的、在共享背包下也安全的部分）：
//   get / plan   AltoClef 的 @get：自动规划 挖→烧→合成 拿到任意物品（规划逻辑在 planner.js）
//   farm         Baritone farm / mineflayer farmer 示例：收成熟作物并补种
//   breed / shear / milk   Mindcraft useOn、Odyssey 的畜牧技能
//   fish         Odyssey 钓鱼技能；不用 bot.fish()（26.1 粒子包格式变了），改看浮漂的 biting 元数据
//   tunnel / digdown   Baritone tunnel、Mindcraft digDown：遇到岩浆、水、悬空就停
//   torch        Mindcraft placeHere
//   explore      Voyager exploreUntil：朝一个方向探索直到看见目标方块
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { makePlan, registryInfo, describeSteps, PlanError } = require('./planner')

// 中文/简称 → 物品（get 用；mine 的别名指向矿石方块，这里指向产物）
const GET_ALIASES = {
  铁: 'iron_ingot', 铁锭: 'iron_ingot', 金: 'gold_ingot', 金锭: 'gold_ingot', 铜: 'copper_ingot', 煤: 'coal', 钻石: 'diamond',
  木头: 'log', 原木: 'log', 木板: 'planks', 木棍: 'stick', 圆石: 'cobblestone', 石头: 'stone', 玻璃: 'glass',
  工作台: 'crafting_table', 熔炉: 'furnace', 火把: 'torch', 箱子: 'chest', 桶: 'bucket', 木炭: 'charcoal',
  木镐: 'wooden_pickaxe', 石镐: 'stone_pickaxe', 铁镐: 'iron_pickaxe', 钻石镐: 'diamond_pickaxe',
  木斧: 'wooden_axe', 石斧: 'stone_axe', 铁斧: 'iron_axe', 石剑: 'stone_sword', 铁剑: 'iron_sword', 钻石剑: 'diamond_sword',
  盾牌: 'shield', 剪刀: 'shears', 鱼竿: 'fishing_rod', 弓: 'bow', 箭: 'arrow',
  铁头盔: 'iron_helmet', 铁胸甲: 'iron_chestplate', 铁护腿: 'iron_leggings', 铁靴子: 'iron_boots',
}
const EXCAVATABLE = /^(dirt|coarse_dirt|rooted_dirt|podzol|mycelium|grass_block|dirt_path|mud|sand|red_sand|gravel|clay|snow|snow_block|stone|cobblestone|deepslate|andesite|diorite|granite|tuff|calcite|netherrack|sandstone|red_sandstone|terracotta)$/
const EXCAVATE_ALIASES = { 土: 'dirt', 泥土: 'dirt', 草方块: 'grass_block', 草地: 'grass_block', 沙子: 'sand', 砂砾: 'gravel', 石头: 'stone', 圆石: 'cobblestone', 雪: 'snow' }
// 作物：成熟 age、补种用的种子
const CROPS = {
  wheat: { age: 7, seed: 'wheat_seeds' }, carrots: { age: 7, seed: 'carrot' }, potatoes: { age: 7, seed: 'potato' },
  beetroots: { age: 3, seed: 'beetroot_seeds' }, nether_wart: { age: 3, seed: 'nether_wart' },
}
const BREED_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
}
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const LIQUID = new Set(['lava', 'water'])
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate', 'modded_block', 'spawner'])
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const isDrop = (entity) => /^(item|item_stack)$/i.test(entity.name || '')

// Path nodes use integer feet Y, which can differ from the actual feet on farmland/slabs.
class GoalPickup extends goals.GoalNear {
  isEnd(node) { return node.x === this.x && node.z === this.z && Math.abs(node.y - this.y) <= 1 }
}

function createAbilities(bot, ctx) {
  const { say, runTask, travel, sleepMs, fmt } = ctx
  const reg = () => bot.registry
  const itemCount = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  const findItem = (names) => bot.inventory.items().find((i) => names.includes(i.name))
  const goNear = (pos, range = 2) => travel(new goals.GoalNear(pos.x, pos.y, pos.z, range))
  const dist = (e) => e.position.distanceTo(bot.entity.position)
  // 按名字读实体元数据（下标随版本变，从 minecraft-data 的 metadataKeys 查）
  const meta = (e, key) => {
    const keys = reg().entitiesByName[e.name]?.metadataKeys
    const i = keys ? keys.indexOf(key) : -1
    return i >= 0 ? e.metadata?.[i] : undefined
  }
  const isBaby = (e) => meta(e, 'baby') === true

  let info = null

  // ---- get / plan ----
  // 附近（水平 64 格、上下 64 格）有哪些方块：直接读区段调色板，一次扫完。
  // 逐种 findBlock 在模组服很慢（方块种类多的区段用全局调色板，只能逐块扫），规划时会卡住主线程好几秒。
  function scanPresence(radius = 64) {
    const states = new Map() // stateId → 最近距离（区段中心或抽样点）
    const p = bot.entity.position
    const minY = bot.game.minY ?? -64
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16), r = Math.ceil(radius / 16)
    const sy = Math.floor((p.y - minY) / 16)
    const cursor = new Vec3(0, 0, 0)
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const col = bot.world.getColumn(cx + dx, cz + dz)
        if (!col?.sections) continue
        col.sections.forEach((sec, i) => {
          if (!sec || Math.abs(i - sy) > 4) return
          const center = new Vec3((cx + dx) * 16 + 8, minY + i * 16 + 8, (cz + dz) * 16 + 8).distanceTo(p)
          if (center > radius + 8) return // 和挖矿的球形搜索范围保持一致（区段中心离得太远就不算）
          const note = (st, d) => { if (!(states.get(st) <= d)) states.set(st, d) }
          if (sec.palette) { for (const st of sec.palette) note(st, center); return }
          for (cursor.x = 0; cursor.x < 16; cursor.x += 2) { // 全局调色板：隔一格抽样
            for (cursor.y = minY + i * 16; cursor.y < minY + i * 16 + 16; cursor.y += 2) {
              for (cursor.z = 0; cursor.z < 16; cursor.z += 2) note(col.getBlockStateId(cursor), center)
            }
          }
        })
      }
    }
    const names = new Map()
    for (const [st, d] of states) {
      const n = reg().blocksByStateId[st]?.name
      if (n && !(names.get(n) <= d)) names.set(n, d)
    }
    return names
  }

  function planEnv(exclude = new Set()) {
    info ||= registryInfo(reg())
    const present = scanPresence()
    for (const n of exclude) present.delete(n) // 上一轮实际走不到的方块
    const log = bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name))?.name ||
      [...present].find((n) => /_log$/.test(n)) || [...present].find((n) => /_stem$/.test(n)) || null
    return {
      info,
      have: itemCount,
      nearby: (names) => names.some((n) => present.has(n)),
      distance: (names) => Math.min(...names.map((n) => present.get(n) ?? Infinity)),
      logName: () => log,
      woodItems: () => bot.inventory.items().map((i) => i.name),
      tableNearby: !!ctx.findTable(),
      furnaceNearby: ctx.furnaceNearby(),
    }
  }
  function resolveTarget(name) {
    const target = Object.hasOwn(GET_ALIASES, name) ? GET_ALIASES[name] : name
    if (target === 'log' || target === 'planks' || reg().itemsByName[target]) return target
    return null
  }
  function planFor(name, count, exclude) {
    const target = resolveTarget(name)
    if (!target) return { error: `不认识物品 ${name}` }
    const env = planEnv(exclude)
    try {
      return { target, steps: makePlan(target, count, env) }
    } catch (err) {
      if (!(err instanceof PlanError)) throw err
      // 某种木头找不到，多半是附近根本没树
      return { error: !env.logName() && /_(log|stem|planks)/.test(err.message) ? '64 格内没有树，也没有原木' : err.message }
    }
  }

  function plan(name, count) {
    const { steps, error } = planFor(name, count)
    if (error) return say(`拿不到 ${name}：${error}`)
    say(steps.length ? `${name} x${count} 共 ${steps.length} 步：${describeSteps(steps)}` : `背包里已经有 ${count} 个 ${name}`)
  }

  async function get(name, count) {
    // 实际执行常和推演有出入（少挖到一块木头、别人从共享背包拿走东西）：某步失败就按当前背包重新规划，最多 3 轮
    const exclude = new Set()
    let lastPlan = null
    let lastFailure = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { target, steps, error } = planFor(name, count, exclude)
      if (error) {
        // 共享背包：缺的东西别人放进来我就能用，直接开口求助
        const ask = /找不到|没有树|缺|不知道/.test(error) ? '。谁有的话放进背包，或者告诉我哪里有' : ''
        say(`拿不到 ${name}：${error}${ask}`)
        return { ok: false }
      }
      if (!steps.length) { say(attempt === 1 ? `背包里已经有 ${count} 个 ${name}` : `拿到了 ${count} 个 ${name}`); return { ok: true } }
      const planText = describeSteps(steps)
      if (planText === lastPlan) { say(`重新规划还是同样的方案，换不出别的办法：${lastFailure}`); return { ok: false } } // 别把同一个失败方案反复试
      lastPlan = planText
      say(`${attempt === 1 ? '开始' : '按现在的背包重新规划'}，共 ${steps.length} 步：${describeSteps(steps)}`)
      const failure = await runSteps(steps, exclude)
      lastFailure = failure
      if (!failure) {
        const resolved = target === 'log' || target === 'planks' ? null : target
        const got = resolved ? itemCount(resolved) : count
        if (got >= count) { say(`拿到了 ${count} 个 ${name}`); return { ok: true } }
        ctx.log(`[get] 步骤做完但只有 ${got}/${count}`)
      } else {
        ctx.log(`[get] 第 ${attempt} 轮失败: ${failure}`)
        if (attempt === 3 || /需要更好的镐/.test(failure)) { say(failure); return { ok: false } }
      }
    }
    say(`试了 3 轮还是没拿全 ${name}`)
    return { ok: false }
  }

  // 依次执行规划步骤；返回失败原因或 null
  async function runSteps(steps, exclude) {
    let lastReport = Date.now()
    for (const [i, step] of steps.entries()) {
      ctx.assertActive()
      const label = `第 ${i + 1}/${steps.length} 步`
      if (Date.now() - lastReport > 45_000) { say(`进度 ${label}：${describeSteps([step])}`); lastReport = Date.now() } // 长任务定时汇报
      const before = itemCount(step.item)
      if (step.op === 'mine') {
        // 挖够数量为止（掉落物没捡到、挖到一半被打断都会少）
        const ids = step.blocks.map((n) => reg().blocksByName[n]?.id).filter((id) => id !== undefined)
        for (let tries = 0; tries < 3 && itemCount(step.item) < before + step.count; tries++) {
          const res = await ctx.mineIds(ids, before + step.count - itemCount(step.item), 72)
          if (/背包满了/.test(res.error || '')) return `${label}挖 ${step.item} 停下：${res.error}` // 换原料也装不下
          if (res.error && !res.got) {
            if (!/需要更好的镐/.test(res.error)) step.blocks.forEach((b) => exclude.add(b)) // 下一轮换别的原料
            return `${label}挖 ${step.item} 失败：${res.error}`
          }
        }
      } else if (step.op === 'smelt') {
        const res = await ctx.smelt(step.input, step.count)
        if (res?.ok === false) return `${label}烧 ${step.item} 失败：${res.error}`
      } else {
        const err = await ctx.craftItem(step.item, step.count, 0)
        if (err) return `${label}做 ${step.item} 失败：${err}`
      }
      await ctx.inventorySettled?.()
      if (itemCount(step.item) <= before) return `${label}没拿到 ${step.item}`
    }
    return null
  }

  // ---- 掉落物：走过去捡（种田、剪羊毛之后用）----
  async function collectDrops(items, limit = 24) {
    for (const it of items.filter((e) => bot.entities[e.id] === e).sort((a, b) => dist(a) - dist(b)).slice(0, limit)) {
      ctx.assertActive()
      if (bot.entities[it.id] !== it) continue
      const { x, y, z } = it.position
      try { await travel(new GoalPickup(x, y, z, 0.5)) } catch { ctx.assertActive() }
      if (bot.entities[it.id] === it && dist(it) < 2) await sleepMs(300)
    }
  }
  const nearbyDrops = (center, radius) => Object.values(bot.entities).filter((e) => isDrop(e) && e.position.distanceTo(center) < radius)

  // ---- 种田 ----
  async function farm(radius) {
    const mature = (b) => b && CROPS[b.name] && b.getProperties?.().age >= CROPS[b.name].age
    const center = bot.entity.position.clone()
    let harvested = 0
    let planted = 0
    let remainingDrops = 0
    // 别踩耕地：跳上去会把耕地踩回泥土、作物掉落（实测 9 株只收到 3 株）。寻路时踩耕地/作物代价很高
    const moves = bot.pathfinder.movements
    // 寻路查的是脚所在那格：收割后那格是空气，耕地在脚下，也要避开（实测：踩上刚收完的田跳了一下，踩坏 1 块）
    const onFarmland = (b) => b?.position && bot.blockAt(b.position.offset(0, -1, 0))?.name === 'farmland'
    let collecting = false
    const avoidFarmland = (b) => (b && (b.name === 'farmland' || CROPS[b.name] || onFarmland(b)) ? (collecting ? 2 : Infinity) : 0)
    moves?.exclusionAreasStep.push(avoidFarmland)
    try {
    for (let n = 0; n < 64 && ctx.stillRunning(); n++) {
      const pos = bot.findBlocks({ matching: mature, useExtraInfo: true, maxDistance: radius, count: 1, point: bot.entity.position })[0]
      if (!pos || pos.distanceTo(center) > radius + 4) break
      const block = bot.blockAt(pos)
      const crop = CROPS[block.name]
      await goNear(pos, 3.5) // 站在田边就够得着（手长 4.5 格）
      await bot.dig(block, true)
      harvested++
      await sleepMs(250)
      if (await plant(pos, crop.seed)) planted++
    }
    // 先收掉落再补种。耕地可平走，禁止跳上或落到田里，也不挖路、搭方块或冲刺。
    const items = nearbyDrops(center, radius + 2)
    const saved = moves && { getNeighbors: moves.getNeighbors, canDig: moves.canDig,
      allowParkour: moves.allowParkour, allowSprinting: moves.allowSprinting, scafoldingBlocks: moves.scafoldingBlocks }
    collecting = true
    if (moves) Object.assign(moves, { canDig: false, allowParkour: false, allowSprinting: false, scafoldingBlocks: [],
      getNeighbors(node) {
        return saved.getNeighbors.call(this, node).filter((next) => {
          const dest = this.getBlock(next, 0, -1, 0)
          if (dest.name !== 'farmland') return true
          const floor = this.getBlock(node, 0, -1, 0)
          return next.y === node.y && floor.physical && Math.abs(floor.height - dest.height) <= 0.25 &&
            Math.max(Math.abs(next.x - node.x), Math.abs(next.z - node.z)) === 1
        })
      },
    })
    try {
      await collectDrops(items, 48)
      remainingDrops = items.filter((e) => bot.entities[e.id] === e).length
    } finally {
      if (moves) Object.assign(moves, saved)
      collecting = false
    }
    // 空着的耕地也种上（有什么种子种什么）
    const farmland = reg().blocksByName.farmland.id
    const empty = bot.findBlocks({ matching: farmland, maxDistance: radius, count: 64 })
      .filter((p) => bot.blockAt(p.offset(0, 1, 0))?.name === 'air')
    for (const p of empty.slice(0, 32)) {
      if (!ctx.stillRunning()) break
      const seed = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'].find((s) => itemCount(s) > 0)
      if (!seed) break
      await goNear(p, 3.5).catch(() => {})
      if (await plant(p.offset(0, 1, 0), seed)) planted++
    }
    } finally {
      const i = moves?.exclusionAreasStep.indexOf(avoidFarmland)
      if (i >= 0) moves.exclusionAreasStep.splice(i, 1)
    }
    say(harvested || planted ? `收了 ${harvested} 株作物，种下 ${planted} 处${remainingDrops ? `，附近还有 ${remainingDrops} 堆掉落物` : ''}` : `${radius} 格内没有成熟的作物或空耕地`)
  }
  async function plant(cropPos, seed) {
    const soil = bot.blockAt(cropPos.offset(0, -1, 0))
    const item = findItem([seed])
    if (!item || !['farmland', 'soul_sand'].includes(soil?.name) || bot.blockAt(cropPos)?.name !== 'air') return false
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(soil, new Vec3(0, 1, 0))
      return true
    } catch (err) {
      ctx.log(`[farm] 补种失败: ${err.message}`)
      return false
    }
  }

  // ---- 畜牧 ----
  async function useOnEntity(entity, itemNames) {
    const item = findItem(itemNames)
    if (!item) return false
    await goNear(entity.position, 2)
    if (!bot.entities[entity.id]) return false
    await bot.equip(item, 'hand')
    await bot.lookAt(entity.position.offset(0, (entity.height ?? 1) * 0.6, 0), true)
    await bot.activateEntity(entity)
    await sleepMs(300)
    return true
  }

  async function breed(animal) {
    const foods = BREED_FOOD[animal]
    if (!foods.some((f) => itemCount(f) >= 2)) return say(`喂 ${animal} 需要 2 个 ${foods.join('/')}`)
    const adults = Object.values(bot.entities)
      .filter((e) => e.name === animal && !isBaby(e) && dist(e) < 16)
      .sort((a, b) => dist(a) - dist(b)).slice(0, 2)
    if (adults.length < 2) return say(`16 格内成年的 ${animal} 不到 2 只`)
    let fed = 0
    for (const e of adults) if (ctx.stillRunning() && await useOnEntity(e, foods)) fed++
    say(fed === 2 ? `喂了两只 ${animal}，等一会儿就有小宝宝（5 分钟内同一只不能再喂）` : `只喂到 ${fed} 只`)
  }

  async function shear() {
    if (!itemCount('shears')) return say('没有剪刀（2 个铁锭能做：bot get shears）')
    const woolly = (e) => e.name === 'sheep' && !isBaby(e) && dist(e) < 16 && !((meta(e, 'wool') ?? 0) & 0x10)
    const center = bot.entity.position.clone()
    let done = 0
    for (let i = 0; i < 8 && ctx.stillRunning(); i++) {
      const sheep = bot.nearestEntity(woolly)
      if (!sheep) break
      if (await useOnEntity(sheep, ['shears'])) done++
      await sleepMs(300)
    }
    await collectDrops(nearbyDrops(center, 18))
    say(done ? `剪了 ${done} 只羊` : '16 格内没有能剪的羊')
  }

  async function milk() {
    if (!itemCount('bucket')) return say('没有空桶（3 个铁锭能做：bot get bucket）')
    const cow = bot.nearestEntity((e) => ['cow', 'mooshroom'].includes(e.name) && !isBaby(e) && dist(e) < 16)
    if (!cow) return say('16 格内没有成年的牛')
    const before = itemCount('milk_bucket')
    await useOnEntity(cow, ['bucket'])
    say(itemCount('milk_bucket') > before ? '挤到一桶牛奶' : '没挤到牛奶')
  }

  // ---- 钓鱼：抛竿后看浮漂的 biting 标记，咬钩就收 ----
  async function fish(times) {
    if (!itemCount('fishing_rod')) return say('没有鱼竿（bot get fishing_rod，要 3 根木棍 2 根线）')
    const water = bot.findBlock({
      matching: reg().blocksByName.water.id, maxDistance: 16, count: 1,
      useExtraInfo: (b) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air',
    })
    if (!water) return say('16 格内没有露天的水')
    await travel(new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 3))
    let caught = 0, collected = 0
    for (let i = 0; i < times && ctx.stillRunning(); i++) {
      await bot.equip(findItem(['fishing_rod']), 'hand')
      await bot.lookAt(water.position.offset(0.5, 0.8, 0.5), true)
      bot.activateItem() // 抛竿
      await sleepMs(1500)
      const bobber = bot.nearestEntity((e) => e.name === 'fishing_bobber' && dist(e) < 24)
      if (!bobber) { say('浮漂没落到水里，换个角度'); continue }
      const deadline = Date.now() + 45_000
      while (Date.now() < deadline && ctx.stillRunning() && bot.entities[bobber.id] && meta(bobber, 'biting') !== true) await sleepMs(100)
      const bit = meta(bobber, 'biting') === true
      if (!bit) { bot.activateItem(); await sleepMs(800); continue }
      caught++
      const existing = new Set(Object.values(bot.entities)), drops = new Set()
      const hook = bobber.position.clone()
      const track = (entity) => {
        if (isDrop(entity) && !existing.has(entity) && entity.position.distanceTo(hook) <= 3) drops.add(entity)
      }
      let picked = false
      const onCollect = (player, item) => { if (player === bot.entity && drops.has(item)) picked = true }
      bot.on('entitySpawn', track)
      bot.on('playerCollect', onCollect)
      try {
        bot.activateItem() // 收竿
        await sleepMs(900)
        if (!picked) await collectDrops([...drops], 6)
        if (picked) collected++
      } finally {
        bot.removeListener('entitySpawn', track)
        bot.removeListener('playerCollect', onCollect)
      }
    }
    say(caught ? `钓到 ${caught} 次，确认收进背包 ${collected} 次` : '一条都没钓到')
    return { ok: caught > 0 && caught === collected }
  }

  // ---- 挖掘 ----
  const passable = (b) => b && b.boundingBox === 'empty' && !LIQUID.has(b.name)
  const touchesLiquid = (p) => SIX.some(([x, y, z]) => LIQUID.has(bot.blockAt(p.offset(x, y, z))?.name))
  async function digBlock(p) {
    for (let tries = 0; tries < 8; tries++) { // 沙子、砂砾会掉下来补位，多挖几次
      const b = bot.blockAt(p)
      if (!b) return '区块没加载'
      if (passable(b)) return null
      if (LIQUID.has(b.name)) return `碰到${b.name === 'lava' ? '岩浆' : '水'}`
      if (UNBREAKABLE.has(b.name) || b.diggable === false) return `${b.name} 挖不动`
      if (b.harvestTools && !bot.inventory.items().some((i) => b.harvestTools[i.type])) return `挖 ${b.name} 需要更好的镐`
      await bot.tool.equipForBlock(b, {})
      await bot.dig(b, true)
      await sleepMs(150)
    }
    return '上面一直往下掉东西'
  }

  async function tunnel(length, dirName) {
    let dir = DIRS[dirName]
    if (!dir) { // 没给方向就朝自己面对的方向
      const yaw = bot.entity.yaw
      const x = -Math.sin(yaw), z = -Math.cos(yaw)
      dir = Math.abs(x) > Math.abs(z) ? [Math.sign(x), 0] : [0, Math.sign(z)]
    }
    const start = bot.entity.position.floored()
    let dug = 0
    let reason = null
    for (let i = 1; i <= length && ctx.stillRunning(); i++) {
      const feet = start.offset(dir[0] * i, 0, dir[1] * i)
      const head = feet.offset(0, 1, 0)
      if (touchesLiquid(feet) || touchesLiquid(head)) { reason = '前面挨着岩浆或水'; break }
      const floor = bot.blockAt(feet.offset(0, -1, 0))
      if (!floor || floor.boundingBox !== 'block') { reason = '前面脚下是空的'; break }
      reason = await digBlock(head) || await digBlock(feet)
      if (reason) break
      await travel(new goals.GoalBlock(feet.x, feet.y, feet.z))
      dug = i
      if (i % 8 === 0 && itemCount('torch')) { // 每 8 格在身后插火把
        const back = feet.offset(-dir[0], 0, -dir[1])
        const below = bot.blockAt(back.offset(0, -1, 0))
        if (below?.boundingBox === 'block' && passable(bot.blockAt(back))) {
          await bot.equip(findItem(['torch']), 'hand').then(() => bot.placeBlock(below, new Vec3(0, 1, 0))).catch(() => {})
        }
      }
    }
    say(`挖了 ${dug} 格隧道，到 ${fmt(bot.entity.position)}${reason ? `，停下原因：${reason}` : ''}`)
  }

  // 按条件批量挖（“把附近高于 76 格的土和草全挖掉”）。只收天然方块，别人的机器、箱子、门挖不到；先报数量，bot stop 随时停
  async function excavate(spec, options) {
    const r = options.r ?? 16, max = options.max ?? 128
    const names = spec.split(',').map((name) => EXCAVATE_ALIASES[name] || name)
    const bad = names.find((name) => !EXCAVATABLE.test(name) || !reg().blocksByName[name])
    if (bad) return say(`excavate 只挖土、石、沙这类天然方块，${bad} 不行`)
    const ids = names.map((name) => reg().blocksByName[name].id)
    const origin = bot.entity.position.floored()
    const fits = (p) => (options.above === undefined || p.y > options.above) && (options.below === undefined || p.y < options.below) &&
      Math.hypot(p.x - origin.x, p.z - origin.z) <= r
    const scan = () => bot.findBlocks({ matching: ids, maxDistance: r * 2, count: 4096 }).filter(fits)
    const skipped = new Set()
    let targets = scan(), dug = 0
    if (!targets.length) return say(`${r} 格内没有符合条件的 ${names.join('/')}`)
    say(`${r} 格内有 ${targets.length}${targets.length >= 4096 ? '+' : ''} 格符合条件，开始挖${targets.length > max ? `（这次最多 ${max} 格）` : ''}，bot stop 可停`)
    while (dug < max && ctx.stillRunning()) {
      targets = targets.filter((p) => !skipped.has(p.toString()) && ids.includes(bot.blockAt(p)?.type))
      if (!targets.length) { targets = scan().filter((p) => !skipped.has(p.toString())); if (!targets.length) break }
      // 从上往下一层层挖，同层挑最近的：先挖脚下会把自己摔下去，也够不着上面的
      const top = Math.max(...targets.map((p) => p.y))
      const here = bot.entity.position
      const next = targets.filter((p) => p.y === top).sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0]
      if (touchesLiquid(next)) { skipped.add(next.toString()); continue }
      try {
        if (next.distanceTo(here) > 4) await goNear(next, 3)
      } catch (err) {
        if (!['NoPath', 'Timeout', 'NoProgress'].includes(err.name)) throw err
        skipped.add(next.toString())
        continue
      }
      if (await digBlock(next)) { skipped.add(next.toString()); continue }
      dug++
      if (dug % 32 === 0) say(`已经挖了 ${dug} 格`)
    }
    const left = scan().filter((p) => !skipped.has(p.toString())).length
    say(`挖了 ${dug} 格${left ? `，还剩 ${left} 格符合条件（再说一次接着挖）` : '，范围内都挖完了'}${skipped.size ? `；${skipped.size} 格够不着或挨着水/岩浆，跳过了` : ''}`)
  }

  async function digDown(depth) {
    let dug = 0
    let reason = null
    for (let i = 0; i < depth && ctx.stillRunning(); i++) {
      const p = bot.entity.position.floored()
      const below = p.offset(0, -1, 0)
      if (below.y <= bot.game.minY + 5) { reason = '快到基岩了'; break }
      if (touchesLiquid(below)) { reason = '下面挨着岩浆或水'; break }
      const under = bot.blockAt(below.offset(0, -1, 0))
      if (!under || under.boundingBox !== 'block') { reason = '下面是空洞，跳下去会摔'; break }
      reason = await digBlock(below)
      if (reason) break
      const deadline = Date.now() + 2000
      while (bot.entity.position.y > below.y + 0.1 && Date.now() < deadline) await sleepMs(100)
      dug++
    }
    say(`往下挖了 ${dug} 格，到 ${fmt(bot.entity.position)}${reason ? `，停下原因：${reason}` : ''}`)
  }

  async function torch() {
    if (!itemCount('torch')) return say('没有火把（bot get torch 4）')
    const placed = await ctx.placeNearby((n) => n === 'torch')
    say(placed ? `火把插在 ${fmt(placed.position)}` : '旁边没地方插火把')
  }

  // ---- 探索：朝一个大方向走，每 40 格看一眼，最多 8 段 ----
  async function explore(name) {
    const base = ctx.alias(name)
    const names = [base, ...(base.endsWith('_ore') ? [`deepslate_${base}`] : [])]
    const ids = names.map((n) => reg().blocksByName[n]?.id).filter((id) => id !== undefined)
    const mob = !ids.length && reg().entitiesByName[base] ? base : null // 也能找生物（AI 曾用 explore sheep 找羊）
    if (!ids.length && !mob) return say(`不认识方块或生物 ${name}`)
    const look = () => mob
      ? bot.nearestEntity((e) => e.name === mob && dist(e) < 48)
      : bot.findBlock({ matching: ids, maxDistance: 48 })
    let heading = Math.random() * Math.PI * 2
    for (let hop = 0; hop < 8 && ctx.stillRunning(); hop++) {
      const found = look()
      if (found) {
        const at = found.position.clone()
        say(`找到 ${name} 了，在 ${fmt(at)}`)
        await goNear(at, mob ? 3 : 2).catch(() => {})
        return
      }
      const p = bot.entity.position
      const goal = new goals.GoalXZ(Math.round(p.x + Math.cos(heading) * 40), Math.round(p.z + Math.sin(heading) * 40))
      try { await travel(goal) } catch (err) {
        ctx.assertActive()
        heading += Math.PI / 2 // 走不通就转个方向
      }
      heading += (Math.random() - 0.5) * 0.8
    }
    say(`走了一大圈也没找到 ${name}，现在在 ${fmt(bot.entity.position)}`)
  }

  const n = (v, d) => Number(v) || d
  const long = { timeoutMs: 10 * 60_000 }
  return {
    commands: {
      get: (_u, [name, c]) => name ? runTask(`拿${name}`, () => get(name, n(c, 1)), long) : say('用法: bot get <物品> [数量]'),
      plan: (_u, [name, c]) => name ? plan(name, n(c, 1)) : say('用法: bot plan <物品> [数量]'),
      farm: (_u, [r]) => runTask('种田', () => farm(n(r, 16)), long),
      breed: (_u, [animal]) => runTask(`喂${animal}`, () => breed(animal)),
      shear: () => runTask('剪羊毛', shear),
      milk: () => runTask('挤奶', milk),
      fish: (_u, [c]) => runTask('钓鱼', () => fish(n(c, 3)), long),
      tunnel: (_u, [len, dir]) => runTask('挖隧道', () => tunnel(n(len, 16), dir), long),
      digdown: (_u, [d]) => runTask('往下挖', () => digDown(n(d, 8))),
      excavate: (_u, [spec, ...rest]) => spec ? runTask(`批量挖${spec}`, () => excavate(spec, Object.fromEntries(rest.map((o) => { const [k, v] = o.split('='); return [k, Number(v)] }))), long) : say('用法: bot excavate 方块[,方块] [r=半径] [above=y] [below=y] [max=数量]'),
      torch: () => runTask('插火把', torch),
      explore: (_u, [name]) => name ? runTask(`探索${name}`, () => explore(name), { timeoutMs: 5 * 60_000 }) : say('用法: bot explore <方块>'),
    },
  }
}

module.exports = { createAbilities, GET_ALIASES, CROPS, BREED_FOOD }
