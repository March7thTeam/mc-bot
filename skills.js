// 进阶指令（参考 Mindcraft 的 actions）：烧炉、箱子、地点记忆、搜索、打猎、回地面、装备。
// 每个指令都接收 (user, args)，需要较长时间的通过 ctx.runTask 执行，可被 bot stop 打断。
const path = require('path')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { readJSON, writeJSON } = require('./storage')

const DATA_DIR = path.join(__dirname, 'data')
const PLACES_FILE = path.join(DATA_DIR, 'places.json')

const FUEL = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100 } // 每个燃料能烧几个
const PLANK_FUEL = 1.5
const CONTAINERS = ['chest', 'trapped_chest', 'barrel']
// 狩猎只打这些（食物来源），不碰宠物和村民
const HUNTABLE = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat', 'cod', 'salmon', 'slime'])

const MAX_PLACES = 64
const validName = (name) => typeof name === 'string' && /^[\p{L}\p{N}_-]{1,32}$/u.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name)
function loadPlaces(file = PLACES_FILE) {
  const data = readJSON(file, {})
  const out = Object.create(null)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [name, p] of Object.entries(data).slice(0, MAX_PLACES)) {
    if (!validName(name) || !p || typeof p !== 'object') continue
    if (![p.x, p.y, p.z].every(Number.isFinite) || Math.abs(p.x) > 29_999_984 || Math.abs(p.z) > 29_999_984 || p.y < -64 || p.y > 319) continue
    if (p.dim !== undefined && (typeof p.dim !== 'string' || p.dim.length > 100)) continue
    if (p.worldKey !== undefined && (typeof p.worldKey !== 'string' || !/^[a-f0-9]{64}$/.test(p.worldKey))) continue
    out[name] = { x: p.x, y: p.y, z: p.z, ...(p.dim ? { dim: p.dim } : {}), ...(p.worldKey ? { worldKey: p.worldKey } : {}) }
  }
  return out
}
function createSkills(bot, ctx) {
  const { say, runTask, travel, sleepMs, fmt } = ctx
  const places = ctx.placesFile ? loadPlaces(ctx.placesFile) : loadPlaces()
  const persistPlaces = (next) => writeJSON(ctx.placesFile || PLACES_FILE, next)
  const itemCount = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  const nearBlock = (names, dist) => bot.findBlock({ matching: (b) => b && names.includes(b.name), maxDistance: dist })
  const goNear = (pos, range = 2) => travel(new goals.GoalNear(pos.x, pos.y, pos.z, range))

  // ---- 烧炉 ----
  // 只用 16 格内、高度差 ≤3 的熔炉，远处/地下的旧熔炉走过去容易卡住
  async function getFurnace(near = true) {
    const me = bot.entity.position
    const pos = near && bot.findBlocks({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 16, count: 8 })
      .find((p) => Math.abs(p.y - me.y) <= 3)
    if (pos) return bot.blockAt(pos)
    if (!itemCount('furnace') && await ctx.craftItem('furnace', 1, 1)) return null
    return ctx.placeNearby((n) => n === 'furnace')
  }

  function pickFuel(count) {
    for (const [name, per] of Object.entries(FUEL)) {
      const need = Math.ceil(count / per)
      if (itemCount(name) >= need) return { name, need }
    }
    // 木板/原木按同名总数算（日志：只看第一组，几组加起来够也报"没有足够的燃料"）
    const need = Math.ceil(count / PLANK_FUEL)
    const wood = [...new Set(bot.inventory.items().map((i) => i.name))]
      .filter((n) => /_(planks|log|stem)$/.test(n)).sort((a, b) => (a.endsWith('_planks') ? -1 : 1) - (b.endsWith('_planks') ? -1 : 1))
      .find((n) => itemCount(n) >= need)
    return wood ? { name: wood, need } : null
  }

  async function smelt(name, count) {
    const fail = (msg) => { say(msg); return { ok: false, error: msg } }
    const input = bot.registry.itemsByName[name]
    if (!input) return fail(`不认识物品 ${name}`)
    count = Math.min(count, itemCount(name))
    if (!count) return fail(`背包里没有 ${name}`)
    const fuel = pickFuel(count)
    if (!fuel) return fail('没有足够的燃料（煤、木炭、木板或原木）')
    let block = await getFurnace()
    if (!block) return fail(itemCount('furnace') ? '有熔炉但身边找不到能放的平地，换个开阔的地方再试' : '没有熔炉，也做不出来（要 8 个圆石）')
    try {
      await goNear(block.position)
    } catch {
      ctx.assertActive()
      block = await getFurnace(false) // 走不过去就在身边放一个
      if (!block) return fail('熔炉走不过去，也放不了新的')
    }
    const furnace = await bot.openFurnace(block)
    try {
      if (furnace.outputItem()) await furnace.takeOutput()
      await furnace.putFuel(bot.registry.itemsByName[fuel.name].id, null, fuel.need)
      await furnace.putInput(input.id, null, count)
      say(`开始烧 ${count} 个 ${name}，大约 ${Math.ceil(count * 10 / 60)} 分钟`)
      let got = 0
      const deadline = Date.now() + count * 11_000 + 15_000
      while (got < count && Date.now() < deadline && ctx.stillRunning()) {
        await sleepMs(2000)
        const out = furnace.outputItem()
        if (out) {
          got += out.count
          await furnace.takeOutput()
        }
      }
      say(got ? `烧好了 ${got} 个` : '没烧出东西')
    } finally {
      furnace.close()
    }
  }

  // ---- 箱子 ----
  async function openNearestChest() {
    const block = nearBlock(CONTAINERS, 16)
    if (!block) { say('16 格内没有原版箱子或木桶（模组箱子打不开）'); return null }
    await goNear(block.position)
    return openRemembered(block)
  }
  // 开箱、关箱时各记一次内容；记忆出错不能影响取放
  const dimension = () => ctx.memoryContext?.()?.worldKey ? ctx.memoryContext().dimension : bot.game?.dimension || 'unknown'
  function rememberChest(block, chest) {
    try { ctx.containers?.update(block.position, dimension(), chest.containerItems(), { double: chest.inventoryStart >= 54 }) } catch (err) { ctx.log(`[containers] ${err.message}`) }
  }
  async function openRemembered(block) {
    const openedDimension = dimension(), openedContext = ctx.memoryContext?.(), openedGeneration = ctx.generation?.()
    const chest = await bot.openContainer(block)
    const rememberOpened = () => {
      try { ctx.containers?.update(block.position, openedDimension, chest.containerItems(), { double: chest.inventoryStart >= 54 }) } catch (err) { ctx.log(`[containers] ${err.message}`) }
    }
    ctx.assertActive?.()
    const stillHere = () => { const current = ctx.memoryContext?.(); return openedContext ? current?.epoch === openedContext.epoch && current?.dimension === openedContext.dimension : dimension() === openedDimension }
    if (!stillHere()) throw new Error('维度变化，旧容器操作已取消')
    rememberOpened()
    const close = chest.close.bind(chest)
    chest.close = () => {
      // Never let a late old-window callback read/write/close the new window.
      const current = ctx.memoryContext?.()
      const sameLevel = openedContext ? current?.worldKey === openedContext.worldKey && current?.dimension === openedContext.dimension : dimension() === openedDimension
      if (!sameLevel || ('currentWindow' in bot && bot.currentWindow !== chest)) return
      if (stillHere() && (openedGeneration === undefined || ctx.generation?.() === openedGeneration)) rememberOpened()
      close()
    }
    return chest
  }

  async function viewChest() {
    const chest = await openNearestChest()
    if (!chest) return
    const counts = {}
    for (const it of chest.containerItems()) counts[it.name] = (counts[it.name] || 0) + it.count
    chest.close()
    const list = Object.entries(counts).map(([n, c]) => `${n}x${c}`).join(', ')
    say(list ? `箱子里: ${list}`.slice(0, 380) : '箱子是空的')
  }

  async function deposit(name, count) {
    const item = bot.registry.itemsByName[name]
    if (!item || !itemCount(name)) return say(`背包里没有 ${name}`)
    const chest = await openNearestChest()
    if (!chest) return
    const n = Math.min(count || itemCount(name), itemCount(name))
    try {
      await chest.deposit(item.id, null, n)
      say(`放进去 ${n} 个 ${name}`)
    } finally {
      chest.close()
    }
  }

  async function withdraw(name, count) {
    const item = bot.registry.itemsByName[name]
    if (!item) return say(`不认识物品 ${name}`)
    const chest = await openNearestChest()
    if (!chest) return
    try {
      const have = chest.containerItems().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
      if (!have) return say(`箱子里没有 ${name}`)
      const n = Math.min(count || have, have)
      await chest.withdraw(item.id, null, n)
      say(`拿出来 ${n} 个 ${name}`)
    } finally {
      chest.close()
    }
  }

  // 去记得的箱子里拿：记忆可能过期，到了以当场看到的为准
  const FETCH_RANGE = 128
  async function fetchItem(name, count) {
    const item = bot.registry.itemsByName[name]
    if (!item) return say(`不认识物品 ${name}`)
    const from = bot.entity.position
    const known = ctx.containers.find(name, dimension(), from)
    if (!known.length) return say(`找不到存着 ${name} 的箱子（只记得开过的箱子，可以先 bot chestscan）`)
    const close = known.filter((c) => Math.hypot(c.x - from.x, c.z - from.z) <= FETCH_RANGE)
    if (!close.length) return say(`找不到 ${FETCH_RANGE} 格内存着 ${name} 的箱子，最近的在 ${known[0].x} ${known[0].y} ${known[0].z}，先过去再拿`)
    let got = 0
    const want = count || Infinity
    for (const c of close.slice(0, 3)) {
      if (got >= want) break
      ctx.assertActive()
      const pos = new Vec3(c.x, c.y, c.z)
      try {
        await goNear(pos)
      } catch (err) {
        ctx.assertActive()
        ctx.log(`[fetch] 走不到 ${c.x},${c.y},${c.z}: ${err.message}`)
        continue
      }
      const block = bot.blockAt(pos)
      if (!block || !CONTAINERS.includes(block.name)) { ctx.containers.drop(pos, dimension()); continue }
      const chest = await openRemembered(block)
      try {
        const have = chest.containerItems().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
        const n = Math.min(want - got, have)
        if (n > 0) { await chest.withdraw(item.id, null, n); got += n }
      } finally {
        chest.close()
      }
    }
    if (!got) return say(`找不到 ${name} 了：记得的箱子里已经没有`)
    say(got < want && count ? `从箱子拿到 ${got} 个 ${name}，还差 ${count - got} 个` : `从箱子拿到 ${got} 个 ${name}`)
  }
  // 走一遍附近的箱子，记下里面有什么（只看不拿）
  async function scanChests(radius) {
    const ids = CONTAINERS.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined)
    const spots = bot.findBlocks({ matching: ids, maxDistance: radius, count: 12 })
    if (!spots.length) return say(`${radius} 格内没有原版箱子或木桶`)
    let seen = 0
    for (const pos of spots) {
      ctx.assertActive()
      try {
        await goNear(pos)
        const block = bot.blockAt(pos)
        if (!block || !CONTAINERS.includes(block.name)) continue
        const chest = await openRemembered(block)
        chest.close()
        seen++
        await sleepMs(300)
      } catch (err) {
        ctx.assertActive()
        ctx.log(`[chestscan] ${pos}: ${err.message}`)
      }
    }
    say(seen ? `看了 ${seen} 个箱子，记住了。里面有: ${ctx.containers.describe(dimension(), bot.entity.position, '', 8) || '都是空的'}`.slice(0, 380) : '一个箱子都没打开')
  }

  // 杂物：挖隧道、挖矿攒下的石头类方块，一键存箱（不碰工具、矿物和稀有物）
  const JUNK = ['cobblestone', 'cobbled_deepslate', 'dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'deepslate', 'calcite', 'cobweb', 'rotten_flesh', 'poisonous_potato']
  async function dump() {
    const present = JUNK.filter((name) => itemCount(name) > 0)
    if (!present.length) return say('背包里没有杂物')
    const chest = await openNearestChest()
    if (!chest) return
    const stored = []
    try {
      for (const name of present) {
        const n = itemCount(name)
        try {
          await chest.deposit(bot.registry.itemsByName[name].id, null, n)
          stored.push(`${name}x${n}`)
        } catch (err) {
          ctx.log(`[dump] ${name}: ${err.message}`)
          break // 箱子满了
        }
      }
    } finally {
      chest.close()
    }
    say(stored.length ? `存了杂物: ${stored.join(', ')}` : '箱子满了，一样都没存进去')
  }

  // ---- 搜索、打猎、回地面 ----
  async function find(name) {
    const target = bot.registry.blocksByName[ctx.alias(name)]
    if (!target) return say(`不认识方块 ${name}`)
    const block = bot.findBlock({ matching: target.id, maxDistance: 64 })
    if (!block) return say(`64 格内没找到 ${name}`)
    say(`${name} 在 ${fmt(block.position)}，过去`)
    await goNear(block.position, 2)
    say('到了')
  }

  async function hunt(name, count) {
    let killed = 0
    while (killed < count && ctx.stillRunning()) {
      const prey = bot.nearestEntity((e) => e.name === name && e.position.distanceTo(bot.entity.position) < 32)
      if (!prey) break
      await ctx.equipWeapon()
      bot.pvp.attack(prey)
      await new Promise((r) => {
        const done = () => { clearTimeout(t); bot.removeListener('stoppedAttacking', done); r() }
        const t = setTimeout(done, 30_000)
        bot.once('stoppedAttacking', done)
      })
      if (!bot.entities[prey.id]) killed++
    }
    if (ctx.stillRunning()) say(killed ? `打了 ${killed} 只 ${name}` : `32 格内没有 ${name}`)
  }

  async function surface() {
    const p = bot.entity.position.floored()
    let top = null
    for (let y = Math.min(p.y + 80, 319); y > p.y; y--) {
      const b = bot.blockAt(p.offset(0, y - p.y, 0))
      if (b && b.boundingBox === 'block') { top = y; break }
    }
    if (top === null) return say('头顶已经是天空了')
    await travel(new goals.GoalNear(p.x, top + 1, p.z, 2))
    say(`到地面了 ${fmt(bot.entity.position)}`)
  }

  // ---- 地点记忆 ----
  function mark(name) {
    if (!validName(name)) return say('地点名需为 1~32 个中文、字母、数字、下划线或短横线')
    if (!Object.hasOwn(places, name) && Object.keys(places).length >= MAX_PLACES) return say('地点已达 64 个，用 bot unmark <地点名> 删除后再记')
    const p = bot.entity.position
    const value = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dim: dimension(), ...(ctx.memoryContext?.()?.worldKey ? { worldKey: ctx.memoryContext().worldKey } : {}) }
    const next = { ...places, [name]: value }
    persistPlaces(next)
    places[name] = value
    say(`记住了 ${name}: ${fmt(p)}`)
  }

  function unmark(name) {
    if (!validName(name) || !Object.hasOwn(places, name)) return say('没有这个地点')
    const next = { ...places }
    delete next[name]
    persistPlaces(next)
    delete places[name]
    say(`已删除地点 ${name}`)
  }

  async function gotoPlace(name, routeOptions = {}) {
    const p = Object.hasOwn(places, name) && places[name]
    if (!p) { say(`没记过 ${name}，已有: ${Object.keys(places).join('、') || '无'}`); return { ok: false, error: 'unknown_place' } }
    if ((p.worldKey && p.worldKey !== ctx.memoryContext?.()?.worldKey) || (p.dim && p.dim !== dimension())) { say(`${name} 不在这个维度`); return { ok: false, error: 'different_dimension' } }
    say(`去 ${name} (${p.x} ${p.y} ${p.z})`)
    if (ctx.travelTo) {
      const result = await ctx.travelTo({ x: p.x, y: p.y, z: p.z }, { range: 1, ...routeOptions })
      say(result.ok ? `到 ${name} 了（${result.transport === 'walk' ? '步行' : '鞘翅/步行接驳'}，${result.rocketsUsed || 0}枚烟花）` : `还没到 ${name}：${result.reason}`)
      return result
    }
    await travel(new goals.GoalNear(p.x, p.y, p.z, 1))
    say(`到 ${name} 了`)
  }

  // ---- 装备 ----
  async function equip(name) {
    const item = bot.inventory.items().find((i) => i.name === name)
    if (!item) return say(`背包里没有 ${name}`)
    const dest = /_helmet$/.test(name) ? 'head' : /_chestplate$|^elytra$/.test(name) ? 'torso'
      : /_leggings$/.test(name) ? 'legs' : /_boots$/.test(name) ? 'feet' : name === 'shield' ? 'off-hand' : 'hand'
    await bot.equip(item, dest)
    say(`装上了 ${name}`)
  }

  const n = (v, d) => Number(v) || d
  return {
    commands: {
      smelt: (_u, [name, c]) => name ? runTask(`烧${name}`, () => smelt(name, n(c, 64))) : say('用法: bot smelt <物品> [数量]'),
      chest: () => runTask('看箱子', viewChest),
      deposit: (_u, [name, c]) => name ? runTask('存箱子', () => deposit(name, n(c, 0))) : say('用法: bot deposit <物品> [数量]'),
      withdraw: (_u, [name, c]) => name ? runTask('取箱子', () => withdraw(name, n(c, 0))) : say('用法: bot withdraw <物品> [数量]'),
      fetch: (_u, [name, c]) => name ? runTask(`取${name}`, () => fetchItem(name, n(c, 0))) : say('用法: bot fetch <物品> [数量]'),
      chestscan: (_u, [r]) => runTask('看附近箱子', () => scanChests(Math.min(n(r, 16), 32)), { timeoutMs: 5 * 60_000 }),
      chests: (_u, [name]) => {
        if (!name) return say(ctx.containers.describe(dimension(), bot.entity.position, '', 10).slice(0, 380) || '还没记过箱子，先 bot chestscan')
        const hits = ctx.containers.find(name, dimension(), bot.entity.position)
        say(hits.length ? `${name} 上次看到在: ${hits.slice(0, 5).map((c) => `${c.x} ${c.y} ${c.z}(x${c.count})`).join('、')}`.slice(0, 380) : `记得的箱子里没有 ${name}`)
      },
      find: (_u, [name]) => name ? runTask(`找${name}`, () => find(name)) : say('用法: bot find <方块>'),
      hunt: (_u, [name, c]) => {
        if (!HUNTABLE.has(name)) return say(`只打这些: ${[...HUNTABLE].join(', ')}`)
        return runTask(`打${name}`, () => hunt(name, n(c, 1)))
      },
      surface: () => runTask('回地面', surface),
      mark: (_u, [name]) => mark(name),
      unmark: (_u, [name]) => unmark(name),
      places: () => say(Object.entries(places).map(([k, p]) => `${k}(${p.x} ${p.y} ${p.z})`).join('、') || '还没记过地点'),
      go: (_u, [name], routeOptions = {}) => name ? runTask(`去${name}`, () => gotoPlace(name, routeOptions), { timeoutMs: Object.hasOwn(places, name) ? ctx.travelTimeout?.(places[name].x, places[name].z) : undefined }) : say('用法: bot go <地点名>'),
      equip: (_u, [name]) => name ? runTask('换装备', () => equip(name)) : say('用法: bot equip <物品>'),
      dump: () => runTask('存杂物', dump),
    },
    // 给 get 规划器在任务内部直接调用（不再套一层 runTask）
    smelt,
    furnaceNearby: () => {
      const me = bot.entity.position
      return bot.findBlocks({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 16, count: 8 }).some((p) => Math.abs(p.y - me.y) <= 3)
    },
    places,
    describePlaces: () => Object.entries(places).slice(0, 16).map(([k, p]) => `${k}(${p.x},${p.y},${p.z})`).join(' ').slice(0, 1200),
  }
}

module.exports = { createSkills, loadPlaces, MAX_PLACES }
