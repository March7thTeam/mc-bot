// 轻量 Minecraft 机器人：无画面，只走网络协议。
// 用法：MC_HOST=127.0.0.1 MC_PORT=25565 MC_NAME=MinecraftBot node bot.js（MC_VERSION 不填就自动检测服务器版本）
// 原版、Paper/Spigot、Fabric 服都能进；模组支持见 mods/ 和 extensions/（README 的“模组扩展”一节）
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const Move = require('mineflayer-pathfinder/lib/move')
const collectBlock = require('mineflayer-collectblock').plugin
const toolPlugin = require('mineflayer-tool').plugin
const pvp = require('mineflayer-pvp').plugin
const { createAI } = require('./ai')
const agent = require('./agent')
const { setupFabric, MODDED_BLOCK_ID } = require('./fabric')
const { createModes } = require('./modes')
const { createSkills } = require('./skills')
const memory = require('./memory')
const { createExperience } = require('./experience')
const { createContainers } = require('./containers')
const { createCombat } = require('./combat')
const hawkEye = require('minecrafthawkeye').default
const { createRuntime, CancelledError, BusyError, PRIORITIES } = require('./runtime')
const { createFlight } = require('./flight')
const guidance = require('./flight-guidance')
const { createCompanion } = require('./companion')
const { createDirector } = require('./autonomy')
const { installProtocolCompat, fixToolMaterials } = require('./protocol-compat')
const { finishFlightRoute } = require('./flight-route')
const { createAutoTravel } = require('./auto-travel')
const { createGreeter } = require('./greet')
const { createAbilities } = require('./abilities')
const { createExplorer } = require('./explore')
const { createBuilder } = require('./build')
const { createRedstone } = require('./redstone')
const { createParkour } = require('./parkour')
const { relevantTips, modTipFor, useMods, useVersion } = require('./knowledge')
const { versionFacts, describeVersion, installLegacyAliases, flightVerified } = require('./versions')
const { createMods } = require('./mods')
const { loadWorkflows, createRunner } = require('./workflows')
const { createAgentApi, createEventLog } = require('./agent-api')
const { Vec3 } = require('vec3')
const { getCommand, safeChatChunks, normalizeAction, normalizeExtensionArgs, AI_ACTIONS, createRateLimiter, setWorldBounds } = require('./security')
const path = require('path')
const { readJSON, writeJSON } = require('./storage')
console.log(`[startup] mc-bot ${require('./package.json').version}`)
// config.json（可选）：写错了直接退出并说清楚哪里错，别带着半套配置跑
try {
  const applied = require('./config').loadConfig({ env: process.env })
  if (applied.length) console.log(`[config] 从 config.json 读了 ${applied.join(', ')}`)
} catch (err) { console.log(`[config] ${err.message}`); process.exit(78) }
const runtime = createRuntime({
  onTimeout: () => { stopAll('timeout'); say(flight?.active() ? '任务超时，取消航线并尝试降落' : '任务超时，已停止后续动作') },
  onPreempt: () => stopTaskControls('preempted'),
})
let flight = null
let autoTravel = null
let parkour = null

// 留空时 ping 服务器拿版本。内容和机制查注册表，自动飞行另查实测白名单。
const VERSION = process.env.MC_VERSION || false
let facts = null, legacyAliases = 0
const mods = createMods({ enable: process.env.MC_MODS, disable: process.env.MC_MODS_DISABLE })
useMods(mods)
const agentEvents = createEventLog() // 给 Agent API / MCP 的事件流

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_NAME || 'MinecraftBot',
  auth: 'offline',
  version: VERSION,
  // 服务器只同步视距内的玩家位置：tiny(2 区块)只能看到 ~30 格，short(4) 约 60 格，内存多占几十 MB
  viewDistance: process.env.MC_VIEW || 'short',
  checkTimeoutInterval: 60_000,
  hideErrors: true, // 下面的 error 监听已记一行；默认还会再打整段堆栈，服务器关着时每次重启刷十几行
})

let levelName = null
const dimension = () => levelName ?? bot.game?.dimension
// Mineflayer 的 game 事件可能只带维度类型。同类型的自定义世界仍有独立的 level name。
function readLevelName(packet) {
  const name = packet.worldState?.name ?? packet.worldName
  levelName = typeof name === 'string' && name ? name.replace(/^minecraft:/, '') : null
}
bot._client?.prependListener('login', readLevelName)
bot._client?.prependListener('respawn', readLevelName)

// Fabric 服在配置阶段同步注册表：按里面出现的命名空间启用模组扩展，并给模组物品组件登记编码
setupFabric(bot, { version: VERSION || undefined, onRegistries: (namespaces) => { mods.activate(namespaces); return mods.componentCodecs() } })
function updateVersion() {
  facts = versionFacts(bot)
  legacyAliases += installLegacyAliases(bot.registry, facts)
  useVersion(facts)
  setWorldBounds(facts.minY, facts.maxY)
}
bot.on('game', updateVersion)
bot.on('spawn', () => {
  updateVersion()
  console.log(`[version] ${facts.version}：世界 ${facts.minY}~${facts.maxY}，鞘翅自动飞行 ${flightVerified(facts.version) ? '开' : '关'}${legacyAliases ? `，旧名别名 ${legacyAliases} 个` : ''}`)
})
bot.once('login', () => {
  updateVersion()
  mods.activate(null) // 非 Fabric 服没有注册表：只启用 always 和 MC_MODS 点名的
  mods.setupAll({ bot, registerCommand: registerExtensionCommand, ctx: { say, sleepMs } })
  loadAllWorkflows() // 扩展指令注册完再读，工作流里可以用它们
  startAgentApi()
})
bot.setMaxListeners(50) // pathfinder 挖掘时重置路径会临时多挂监听器

// pathfinder 在"准备挖但还没开挖"时每次重置路径都会再挂一遍同一个监听器，
// stopDigging 此时什么都不做，监听器就越堆越多（日志里的 MaxListenersExceededWarning）。同一函数只挂一次。
// mineflayer-pvp 还在监听已弃用的 physicTick，每次启动都打一行弃用警告；两个事件同一 tick 发出，直接改挂新名。
for (const method of ['on', 'addListener']) {
  const original = bot[method].bind(bot)
  bot[method] = (event, fn) => event === 'physicTick' ? original('physicsTick', fn)
    : ((event === 'diggingAborted' || event === 'diggingCompleted') && bot.listeners(event).includes(fn) ? bot : original(event, fn))
}
bot.loadPlugin(runtime.scopePathfinder(pathfinder))
bot.loadPlugin(collectBlock)
bot.loadPlugin(toolPlugin)
bot.loadPlugin(pvp)
bot.loadPlugin(hawkEye) // 弓箭瞄准（只在射击时挂 tick 监听）

let sayLog = null // 执行 AI 指令期间，机器人说过的话会记在这里反馈给 AI
// 原版反刷屏：每条 +20、每 tick -1、超 200 就踢（实测：长任务连说几轮被 disconnect.spam 踢下线）。
// 留足余量：连发 6 条，之后每 1.5 秒一条，多的排队，队列满丢最旧的
const CHAT_BURST = 6, CHAT_REFILL_MS = 1500, CHAT_BACKLOG = 12
let chatTokens = CHAT_BURST, chatStamp = Date.now(), chatTimer = null
const chatBacklog = []
function refillChat() {
  const now = Date.now()
  const gained = Math.floor((now - chatStamp) / CHAT_REFILL_MS)
  if (gained > 0) { chatTokens = Math.min(CHAT_BURST, chatTokens + gained); chatStamp += gained * CHAT_REFILL_MS }
  if (chatTokens >= CHAT_BURST) chatStamp = now
}
function drainChat() {
  chatTimer = null
  refillChat()
  while (chatBacklog.length && chatTokens > 0) { chatTokens--; runtime.unscoped(() => bot.chat(chatBacklog.shift())) }
  if (chatBacklog.length) { chatTimer = setTimeout(drainChat, CHAT_REFILL_MS); chatTimer.unref?.() }
}
function sendChat(chunk) {
  refillChat()
  if (!chatBacklog.length && chatTokens > 0) { chatTokens--; bot.chat(chunk); return }
  chatBacklog.push(chunk)
  if (chatBacklog.length > CHAT_BACKLOG) console.log(`[chat] 说得太快，丢弃: ${chatBacklog.shift().slice(0, 40)}`)
  if (!chatTimer) { chatTimer = setTimeout(drainChat, CHAT_REFILL_MS); chatTimer.unref?.() }
}
// 私聊来的查询（背包、坐标、状态）私聊回，避免在公屏广播玩家信息。
const replyStore = new (require('node:async_hooks').AsyncLocalStorage)()
const say = (msg) => {
  if (!runtime.isActive()) return
  const chunks = safeChatChunks(msg)
  const text = chunks.join(' ')
  sayLog?.push(text)
  agentEvents.push('say', { text: text.slice(0, 600), to: replyStore.getStore() || null })
  const whisperTo = replyStore.getStore()
  for (const chunk of chunks) sendChat(whisperTo ? `/msg ${whisperTo} ${chunk}` : chunk)
}
const fmt = (p) => `${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}`
const sleepMs = runtime.delay

// 两套走路规则：跟随时不破坏地形；干活时允许挖掘和用泥土/圆石垫脚。
let safeMoves, workMoves
bot.once('spawn', () => {
  console.log(`[compat] 修正工具材质 ${fixToolMaterials(bot.registry)} 种方块`)
  installProtocolCompat(bot)
  runtime.guardBot(bot)
  safeMoves = new Movements(bot)
  safeMoves.blocksCantBreak.add(MODDED_BLOCK_ID)
  safeMoves.canDig = false
  safeMoves.allow1by1towers = false
  safeMoves.scafoldingBlocks = []
  safeMoves.exclusionAreasPlace.push(() => Infinity)
  safeMoves.allowParkour = false
  safeMoves.maxDropDown = 2
  safeMoves.infiniteLiquidDropdownDistance = false
  safeMoves.canOpenDoors = true
  tuneMoves(safeMoves)
  workMoves = createWorkMoves()
  // 采集插件默认用自带配置：能从任意高度往水里跳，也不管水下和岩浆（实测：砍崖下的树直接走出平台摔死）。它还会改配置，所以单给一份
  bot.collectBlock.movements = createWorkMoves()
  floatInWater(safeMoves)
  bot.pathfinder.setMovements(safeMoves)
  bot.pathfinder.thinkTimeout = 10_000 // 找不到路就放弃（4 秒太短：关掉寻路跑酷后绕路场景经常算不完）
  console.log(`[spawn] ${bot.username} @ ${fmt(bot.entity.position)}`)
  say('你好，我是 Claude 的机器人。说 "bot help" 看指令。')
})

const DIG_COST = 4
// 寻路库只会开栅栏门，木门上半截被当成要挖的方块（实测：不是砸门就是从地下挖过去）；石笋算能踩的地面，站上去就卡死（实测：卡到任务放弃）
function tuneMoves(moves) {
  const isDoor = (b) => /_door$/.test(b.name || '') && b.name !== 'iron_door'
  for (const b of bot.registry.blocksArray) if (isDoor(b)) moves.blocksCantBreak.add(b.id)
  const getBlock = moves.getBlock.bind(moves)
  moves.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock(pos, dx, dy, dz)
    if (b.name === 'pointed_dripstone') { b.physical = false; b.safe = false }
    return b
  }
  const forward = moves.getMoveForward.bind(moves)
  moves.getMoveForward = (node, dir, neighbors) => {
    const lower = moves.getBlock(node, dir.x, 0, dir.z)
    if (!isDoor(lower) || !isDoor(moves.getBlock(node, dir.x, 1, dir.z))) return forward(node, dir, neighbors)
    const { facing, open } = lower.getProperties()
    // 只能顺门的朝向穿过：侧着走进门格会被门板挡住
    if ((dir.x !== 0) !== (facing === 'east' || facing === 'west') || !moves.getBlock(node, dir.x, -1, dir.z).physical) return
    const { x, y, z } = lower.position
    neighbors.push(new Move(x, y, z, node.remainingBlocks, open ? 1 : 2))
  }
}
// 路径上的门在这里开：寻路库自带的开门流程开完取不到下一个放置点，整个进程崩掉（实测：进屋时退出）
let doorsAhead = [], doorBusy = false
bot.on('path_update', (r) => { doorsAhead = r.path || [] })
bot.on('physicsTick', () => {
  if (doorBusy || !safeMoves || !bot.pathfinder?.isMoving()) return
  const p = bot.entity.position
  for (const node of doorsAhead.slice(0, 3)) {
    if (Math.hypot(node.x + 0.5 - p.x, node.z + 0.5 - p.z) > 3) continue
    const door = bot.blockAt(new Vec3(node.x, node.y, node.z), false)
    if (!door || !/_door$/.test(door.name) || door.name === 'iron_door' || door.getProperties().open) continue
    doorBusy = true
    // 开门后服务器的方块更新要一会儿才回来，等一下再看，免得开了又关
    runtime.unscoped(() => bot.activateBlock(door)).catch((err) => console.log(`[goal] 开门失败: ${err.message}`))
      .finally(() => setTimeout(() => { doorBusy = false }, 500))
    return
  }
})

// 干活用的寻路配置（能挖能搭）
function createWorkMoves() {
  const moves = new Movements(bot)
  // 限制高处落水路径，避免预测落点偏差导致坠落伤害。
  moves.infiniteLiquidDropdownDistance = false
  moves.maxDropDown = 3
  // 寻路自带的跑酷不看沟下面是什么，岩浆上也跳：把沟下危险（岩浆、深坑）的跳法过滤掉
  const parkourMoves = moves.getMoveParkourForward?.bind(moves)
  moves.getMoveParkourForward = (node, dir, neighbors) => {
    const before = neighbors.length
    parkourMoves?.(node, dir, neighbors)
    for (let i = neighbors.length - 1; i >= before; i--) {
      const m = neighbors[i]
      const span = Math.max(Math.abs(m.x - node.x), Math.abs(m.z - node.z))
      let safe = true
      for (let g = 1; g < span && safe; g++) safe = gapIsSafe(node.x + dir.x * g, node.y, node.z + dir.z * g)
      if (!safe) neighbors.splice(i, 1)
    }
  }
  moves.canOpenDoors = true
  tuneMoves(moves)
  moves.digCost = DIG_COST // 默认 1 太便宜：徒手凿 8 格石头算不过绕路（实测：真实地形上在山里挖了近 5 分钟），翻不过去才挖
  moves.blocksCantBreak.add(MODDED_BLOCK_ID) // 别挖别人的模组机器
  moves.scafoldingBlocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']
    .map((n) => bot.registry.itemsByName[n]?.id).filter(Boolean)
  floatInWater(moves)
  return moves
}

// 沟下 4 格内有地或水才算跳得起（掉下去死不了）
function gapIsSafe(x, y, z) {
  for (let d = 1; d <= 5; d++) {
    const b = bot.blockAt(new Vec3(x, y - d, z))
    if (!b || b.name === 'lava' || b.name === 'fire' || b.name === 'magma_block' || b.name === 'cactus') return false
    if (b.name === 'water' || b.boundingBox === 'block') return true
  }
  return false
}

// ---- 水里只能浮着游：寻路库规划的是"站在水底走、在水里挖"，机器人一直浮着，就在原地上下漂（实测：湖面、冰山边卡到任务超时）----
const WATER_PLANTS = ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']
const isWaterCell = (b) => !!b && (b.name === 'water' || WATER_PLANTS.includes(b.name))
function floatInWater(moves) {
  // 水草格子里其实全是水，不算水的话路线会一格格往水底钻
  for (const name of WATER_PLANTS) { const id = bot.registry.blocksByName[name]?.id; if (id != null) moves.liquids.add(id) }
  const neighbors = moves.getNeighbors.bind(moves)
  moves.getNeighbors = (node) => {
    const list = neighbors(node)
    const here = moves.getBlock(node, 0, 0, 0), above = moves.getBlock(node, 0, 1, 0)
    // 已经沉在水下（或被盖住）的起点不限制，不然连出来的路都没有
    if (above.liquid || above.physical) return list
    // 钻到水下或冰层底下没气（实测：贴着冰山绕，淹死了）
    const open = list.filter((m) => {
      const cell = moves.getBlock(m, 0, 0, 0), head = moves.getBlock(m, 0, 1, 0)
      return !(cell.liquid && (head.liquid || head.physical))
    })
    // 水里挖和放都要踩稳，浮着永远等不到（实测：浅水竹子边上下漂到超时）。
    // 脚下是实心地面就算踩稳，允许从狭窄水坑挖掘或垫高脱困。
    return here.liquid && !moves.getBlock(node, 0, -1, 0).physical ? open.filter((m) => !m.toBreak.length && !m.toPlace.length) : open
  }
}
// 路线上的水下节点抬到水面：节点高差超过 1 格算没到，浮着的机器人够不着
function liftPathToSurface(path) {
  for (const n of path) {
    if (n.toBreak.length || n.toPlace.length) break
    const at = new Vec3(Math.floor(n.x), Math.floor(n.y), Math.floor(n.z))
    if (!isWaterCell(bot.blockAt(at)) && !isWaterCell(bot.blockAt(at.offset(0, 1, 0)))) continue
    while (isWaterCell(bot.blockAt(at.offset(0, 1, 0)))) at.y++
    n.y = at.y
  }
}

// 下方 5 格内没地也没水
function isDropAt(cell) {
  for (let d = 0; d <= 5; d++) {
    const b = bot.blockAt(cell.offset(0, -d, 0))
    if (!b || b.boundingBox === 'block' || b.name === 'water') return false
    if (d === 0 && b.boundingBox !== 'empty') return false
  }
  return true
}
// "后退"是相对朝向的，脸朝内站在崖边时一退就下去了（实测：脱困时退出平台摔死）。脱困会连退 0.8 秒，所以看 3 格
function behindIsSafe() {
  const p = bot.entity.position, yaw = bot.entity.yaw
  return [1, 2, 3].every((d) => !isDropAt(p.offset(Math.sin(yaw) * d, 0, Math.cos(yaw) * d).floored()))
}

// ---- 防坠落：寻路的“部分路径”可能通向悬崖边，需要防止惯性导致坠落。----
// 只看速度方向前方落点：下方 4 格以上全空且不是水就刹车。跑酷和鞘翅自己负责安全，不管。
let lastBrake = 0
let plannedPath = []
bot.on('path_update', (r) => { plannedPath = r.path || []; liftPathToSurface(plannedPath) })
bot.on('path_reset', () => { plannedPath = [] })
bot.on('physicsTick', () => {
  if (!bot.entity?.onGround || !bot.pathfinder?.isMoving() || parkour?.inJump() || flight?.active() || bot.entity.isInWater) return
  const { x: vx, z: vz } = bot.entity.velocity
  if (vx * vx + vz * vz < 0.0004) return
  const p = bot.entity.position
  const speed = Math.hypot(vx, vz)
  const cliffAt = (look) => {
    const ahead = p.offset(vx / speed * look, 0, vz / speed * look).floored()
    return isDropAt(ahead) ? ahead : null
  }
  const besidePath = (cell, nodes) => nodes.some((n) => Math.hypot(n.x - cell.x - 0.5, n.z - cell.z - 0.5) < 1.6)
  // 紧贴脚前是悬崖，只有路线还要接着走才放行（实测：贴崖斜着走被反复刹停，原地抖到报"找不到路"）；
  // 路线到头了一定刹（实测：路线终点在崖边，惯性带着走出平台摔死）
  // 远一点的只算预警：路线本来就沿着那边走就不刹（实测：贴崖走的 goto 半路被刹断，报"路上被打断"）
  const near = cliffAt(Math.max(0.6, speed * 2.5))
  if (near) {
    if (plannedPath.length >= 2 && besidePath(near, plannedPath.slice(0, 4))) return
  } else {
    const far = cliffAt(speed * 6)
    if (!far || besidePath(far, plannedPath)) return
  }
  if (Date.now() - lastBrake > 3000) console.log(`[ledge] 前方是悬崖，刹车 @ ${fmt(p)}`)
  lastBrake = Date.now()
  runtime.unscoped(() => {
    // 目标留着，只丢掉冲出去的这段路；同一个目标重设不会让 goto 报 GoalChanged
    const goal = bot.pathfinder.goal
    bot.pathfinder.setGoal(goal, bot.pathfinder.goal?.dynamic ?? !!goal?.entity)
    bot.clearControlStates()
    if (behindIsSafe()) {
      bot.setControlState('back', true)
      setTimeout(() => bot.setControlState('back', false), 250)
    }
  })
})

// ---- 任务管理：同一时间只做一件事，bot stop 可随时打断 ----
let task = null
let autonomyStartTimer = null
let defaultPriority = null // 日程调用指令时临时设置，让指令内部的 runTask 继承 routine 优先级
let defaultOrigin = null
async function runTask(name, fn, options = {}) {
  runtime.assertActive()
  // 复用任务的技能只执行函数；任务名、移动配置和收尾始终由最外层持有者管理。
  if (runtime.ownsTask()) return fn()
  const priority = options.priority ?? defaultPriority ?? PRIORITIES.player
  const origin = options.origin ?? defaultOrigin ?? 'player'
  // 任务真正开始的那一代才算自己的：等待抢占期间 epoch 会变
  let generation = runtime.generation()
  const requester = currentRequester
  const startedAt = Date.now()
  try {
    return await runtime.runTask(name, async () => {
      generation = runtime.generation()
      const ownerId = runtime.status().id
      console.log(`[task] start ${name}`)
      agentEvents.push('task', { state: 'start', name })
      task = name
      followTarget = null // 开始干别的就不再跟随/站岗
      post = null
      bot.pathfinder.setGoal(null) // setMovements 本身不会移除旧的动态跟随目标。
      bot.pathfinder.setMovements(options.safe ? safeMoves : workMoves)
      try {
        const result = await fn()
        return result && typeof result.ok === 'boolean' ? result : { ok: true }
      } finally {
        const cancelled = generation !== runtime.generation()
        const preempted = runtime.cancelCode(generation) === 'preempted'
        console.log(`[task] end ${name} cancelled=${cancelled}${preempted ? ' preempted=true' : ''}`)
        agentEvents.push('task', { state: 'end', name, cancelled, ...(preempted ? { preempted: true } : {}) })
        if (!cancelled && requester && Date.now() - startedAt > 40_000) {
          runtime.unscoped(() => say(`${requester}，「${name}」这件事结束了（结果见上面），还有什么要我做的？`))
        }
        // 在 runtime 释放持有者之前清理；旧/嵌套 wrapper 不得改动后继任务。
        if (runtime.status()?.id === ownerId) {
          task = null
          runtime.unscoped(() => bot.pathfinder.setMovements(safeMoves))
        }
      }
    }, { maxMs: options.timeoutMs || (name.startsWith('烧') ? 12 * 60_000 : 180_000), priority, origin })
  } catch (err) {
    // 低优先级顶不掉正在跑的任务：这是"忙"，不是失败
    if (err instanceof BusyError) { say('上一个任务还在执行或收尾，请稍等'); return { ok: false, error: 'busy' } }
    if (err instanceof CancelledError || generation !== runtime.generation()) {
      const preempted = (err.code || runtime.cancelCode(generation)) === 'preempted'
      return preempted ? { ok: false, preempted: true } : { ok: false, stopped: true }
    }
    say(`${name}失败: ${friendlyError(err)}`)
    console.log(`[task:${name}] ${err.name}: ${err.message}`)
    return { ok: false, error: err.message }
  }
}
// 寻路库的英文报错给玩家看不懂
function friendlyError(err) {
  if (err.message.startsWith('绕了很久')) return err.message
  if (err.name === 'Timeout' || err.name === 'NoPath' || /decide path|No path/i.test(err.message)) return '找不到路（可能被围住、太远或要穿过挖不动的方块）'
  if (err.name === 'GoalChanged' || err.name === 'PathStopped') return '路上被打断了（前面可能是悬崖）'
  return err.message
}
let currentRequester = null // 当前这条指令是谁下的（聊天入口设置）
let actionRun = 0 // 每次 stop 加一，正在执行的 AI 指令序列看到变化就停
// 走到目标；途中被自卫打断（GoalChanged/PathStopped）就等打完继续，最多重试 5 次
// 算路超时不等于没路（长路、水上算得慢）：还在往前走就接着算，原地连续两次就先往目标方向走一小段再算，都走不动才放弃
// 一直在动但不靠近目标（实测：水面被冰山挡住，来回漂几分钟，脱困检测看不出来）：45 秒没靠近就报 NoProgress
const NO_PROGRESS_MS = 45_000
const IDLE_MS = 20_000
async function gotoWatched(goal) {
  if (!Number.isFinite(goal.x) || !Number.isFinite(goal.z)) return bot.pathfinder.goto(goal)
  const dist = () => Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z)
  let best = dist(), bestAt = Date.now(), stalled = false, spot = bot.entity.position.clone(), spotAt = Date.now(), giveUp
  const noProgress = () => Object.assign(new Error('绕了很久也没有靠近目标'), { name: 'NoProgress' })
  const abandoned = new Promise((_, reject) => { giveUp = reject })
  const watch = setInterval(() => {
    const p = bot.entity.position
    if (p.distanceTo(spot) > 1) { spot = p.clone(); spotAt = Date.now() }
    if (combat.active() || modes.recovering?.() || eating || bot.targetDigBlock || dist() < best - 3) { best = Math.min(best, dist()); bestAt = Date.now(); spotAt = Date.now() }
    // 寻路算不出更近的点时路径是空的：人不动、不报错，goto 也不会返回。空等 20 秒就够了
    const idle = !bot.pathfinder.isMoving() && Date.now() - spotAt > IDLE_MS
    if (idle || Date.now() - bestAt > NO_PROGRESS_MS) {
      console.log(`[mode] 没靠近目标 @ ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} 还差 ${dist().toFixed(1)} 格 moving=${bot.pathfinder.isMoving()}`)
      clearInterval(watch)
      stalled = true
      bot.pathfinder.stop()
      // 没有路径时 stop 不会让 goto 返回（实测：一直等到任务超时），要自己收尾
      setTimeout(() => { giveUp(noProgress()); if (stalled) bot.pathfinder.setGoal(null) }, 2000)
    }
  }, 1000)
  try {
    return await Promise.race([bot.pathfinder.goto(goal), abandoned])
  } catch (err) {
    if (stalled) throw noProgress()
    throw err
  } finally {
    stalled = false
    clearInterval(watch)
  }
}
// 卡在死路里时先往两侧绕，正对目标走多半又回到原地
async function hopToward(goal, sideFirst = false) {
  const p = bot.entity.position
  const base = Math.atan2(goal.z - p.z, goal.x - p.x)
  const turns = sideFirst ? [Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4] : [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]
  const start = p.clone(), run = actionRun
  let tries = 0
  for (const turn of turns) {
    // 换了两个方向人都没挪窝，再试也只是干等（实测：坑底一声不吭站了 6 分钟）。早点认输，让上层报走不到
    if (tries++ >= 2 && bot.entity.position.distanceTo(start) < 1.5) return false
    const x = Math.round(p.x + Math.cos(base + turn) * 40), z = Math.round(p.z + Math.sin(base + turn) * 40)
    try {
      await gotoWatched(new goals.GoalNearXZ(x, z, 6))
      return true
    } catch (err) {
      // 脱困、自卫也会打断绕路（实测：脱困的 stop 从这里漏出去，整趟赶路直接失败）。只有真的喊停才往外抛
      if (run !== actionRun || !task || !['Timeout', 'NoPath', 'NoProgress', 'PathStopped', 'GoalChanged'].includes(err.name)) throw err
      if (combat.active()) await combat.waitOver()
    }
  }
  return false
}
async function travel(goal) {
  workMoves.digCost = DIG_COST
  const run = actionRun
  let timeouts = 0, hops = 0, lastAt = bot.entity.position.clone()
  for (let attempt = 0; ; attempt++) {
    try {
      return await gotoWatched(goal)
    } catch (err) {
      if (err.name === 'NoProgress') {
        if (run === actionRun && task && hops++ < 8 && await hopToward(goal, true)) { attempt--; lastAt = bot.entity.position.clone(); continue }
        throw Object.assign(new Error('绕了很久也靠近不了目标（可能被水、冰或悬崖隔开）'), { name: 'NoPath' })
      }
      if (err.name === 'Timeout' && run === actionRun && task) {
        timeouts = bot.entity.position.distanceTo(lastAt) > 8 ? 0 : timeouts + 1
        lastAt = bot.entity.position.clone()
        if (timeouts < 2) { attempt--; continue }
        if (Number.isFinite(goal.x) && Number.isFinite(goal.z) && hops++ < 16 && await hopToward(goal)) {
          timeouts = 0; attempt--; lastAt = bot.entity.position.clone()
          continue
        }
      }
      // 远路上算不出整条路（实测：走了 500 多格后山地报 NoPath，整趟作废）：朝目标挪一段再算。离得近才算真走不到
      if (err.name === 'NoPath' && run === actionRun && task && Number.isFinite(goal.x) && Number.isFinite(goal.z) &&
          Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z) > 32) {
        if (hops++ < 16 && await hopToward(goal)) { attempt--; lastAt = bot.entity.position.clone(); continue }
        // 绕也绕不开（实测：挡路的山体）：这一趟放开挖，慢但能过。挖的代价下一趟恢复
        if (workMoves.digCost !== 1 && bot.pathfinder.movements === workMoves) { workMoves.digCost = 1; attempt--; continue }
      }
      const interrupted = ['GoalChanged', 'PathStopped'].includes(err.name)
      if (!interrupted || attempt >= 5 || run !== actionRun || !task) throw err
      const escapeDeadline = Date.now() + 15_000
      while (modes.recovering?.()) {
        if (Date.now() >= escapeDeadline) throw Object.assign(new Error('未脱离危险，自保仍在尝试'), { code: 'hazard_escape_timeout' })
        await sleepMs(150)
      }
      if (combat.active()) await combat.waitOver()
      await sleepMs(300)
    }
  }
}

// 赶路时限按距离算：固定 3 分钟走不完远路（实测：游过 300 格水面一直在前进，还是被超时打断）。真卡住有脱困检测管
const travelTimeout = (x, z) => Math.min(30 * 60_000, Math.max(180_000, Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z) * 2000))

// 走不到时试一次跑酷路线（跳沟不搭方块不挖）。跑酷本身只走摔不死的路线，失败仍报原来的错。
async function reach(goal, point, range = 2) {
  const target = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }
  // 寻路库在算不出路时可能直接"完成"，人还在原地（实测：孤岛上 goto 秒回"到了"）。到没到以坐标为准
  // 判定和寻路目标一致，不额外放宽（实测：放宽到 range+2 时，隔着沟 2.8 格也报"到了"）
  const arrived = () => goal.isEnd(bot.entity.position.floored()) ||
    bot.entity.position.distanceTo(new Vec3(target.x + 0.5, target.y, target.z + 0.5)) <= range + 0.5
  let failure
  try {
    await travel(goal)
    // 走进死胡同（比如挖了一半的隧道）时寻路也可能直接"完成"：退出来换条路再走
    for (let i = 0; i < 6 && !arrived(); i++) {
      if (!await hopToward(goal, true)) break
      await travel(goal)
    }
    if (arrived()) return
    failure = Object.assign(new Error('没走到'), { name: 'NoPath' })
  } catch (err) {
    if (!['Timeout', 'NoPath'].includes(err.name)) throw err
    failure = err
  }
  runtime.assertActive()
  if (!parkour?.checkRoute(target).ok) throw failure
  say('正常走不过去，试试跳过去')
  const r = await parkour.tryRoute(target)
  if (!r.ok) throw failure
}

// 死亡、卡住、超时只打断当前这一步：长期目标保留，下一轮把状况告诉 AI 重新规划
const GOAL_EVENTS = { death: '机器人刚死过一次，已在重生点复活', unstuck_limit: '连续卡住，脱困失败，上一个动作被取消', timeout: '上一个动作超时被取消' }
function stopTaskControls(reason) {
  flight?.requestLand(reason)
  if (runtime.status()?.origin === 'auto' && aiWork) ai?.cancel()
  runtime.unscoped(() => {
    bot.pathfinder.setGoal(null)
    bot.collectBlock.cancelTask().catch(() => {})
    bot.stopDigging()
    bot.clearControlStates()
  })
}
function stopAll(reason = 'stop') {
  if (autonomyStartTimer) clearTimeout(autonomyStartTimer)
  autonomyStartTimer = null
  director?.stop()
  // halt：只停自主，不碰玩家的目标和排队。玩家正在下的活继续做。
  if (reason === 'halt') {
    auto = false
    if (runtime.status()?.origin === 'auto') {
      runtime.cancel('自主已停', 'halt')
      stopTaskControls('halt')
      runtime.unscoped(() => {
        bot.pathfinder.setGoal(null)
        bot.stopDigging()
        bot.clearControlStates()
        if (safeMoves) bot.pathfinder.setMovements(safeMoves)
      })
    }
    return
  }
  flight?.requestLand(reason)
  if (goal && GOAL_EVENTS[reason]) goalEvents.push(GOAL_EVENTS[reason])
  else goal = null
  restoringGoal = null
  followTarget = null
  post = null
  task = null
  if (reason === 'stop') queue.length = 0
  actionRun++
  auto = false
  runtime.cancel('任务已取消', reason)
  ai?.cancel()
  runtime.unscoped(() => {
    bot.pathfinder.setGoal(null)
    combat.stop()
    bot.pvp.stop()
    bot.hawkEye.stop()
    bot.collectBlock.cancelTask().catch(() => {})
    bot.stopDigging()
    bot.clearControlStates()
    if (safeMoves) bot.pathfinder.setMovements(safeMoves)
  })
}

// ---- 方块别名，方便用中文或简称 ----
const ALIASES = {
  铁: 'iron_ore', 煤: 'coal_ore', 铜: 'copper_ore', 金: 'gold_ore', 钻石: 'diamond_ore',
  红石: 'redstone_ore', 青金石: 'lapis_ore', 绿宝石: 'emerald_ore', 石头: 'stone', 泥土: 'dirt', 沙子: 'sand',
  iron: 'iron_ore', coal: 'coal_ore', copper: 'copper_ore', gold: 'gold_ore', diamond: 'diamond_ore',
  redstone: 'redstone_ore', lapis: 'lapis_ore', emerald: 'emerald_ore',
}
// 矿石同时找深板岩版本；石头挖出来是圆石，也一并认
function blockIdsFor(name) {
  const base = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name
  const names = [base]
  if (base.endsWith('_ore')) names.push(`deepslate_${base}`)
  if (base === 'log') return Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_log')).map((b) => b.id)
  return names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined)
}

async function mine(name, count) {
  const ids = blockIdsFor(name)
  if (!ids.length) return say(`不认识方块 ${name}`)
  const { got, error } = await mineIds(ids, count)
  if (!task) return
  if (error) say(error)
  else say(got >= count ? `挖完了，挖了 ${got} 个 ${name}` : got ? `只挖到 ${got}/${count} 个 ${name}，其余够不着` : `附近 32 格内找不到能走到的 ${name}`)
}
// 挖一组方块中的 count 个（get 规划器也用这个），返回 { got, error }
async function mineIds(ids, count, maxDistance = 32) {
  let got = 0
  let misses = 0
  // 挨着岩浆的方块不挖：挖开会让岩浆流过来（日志里有一次死在岩浆里）
  const lava = bot.registry.blocksByName.lava?.id
  const nearLava = (p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .some(([x, y, z]) => bot.blockAt(p.offset(x, y, z))?.type === lava)
  // 水下挖慢 5 倍、浮着再慢 5 倍，木镐一块石头接近 30 秒，撞上单块超时（出生点水坑实测）：挨着水的放到最后再挖
  const wet = (p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => isWaterCell(bot.blockAt(p.offset(x, y, z))))
  const floating = () => bot.entity.isInWater && !bot.entity.onGround &&
    bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))?.boundingBox !== 'block'
  let swam = false
  const bad = new Set() // 日志：同一个够不着的方块会被反复选中直到 3 次失败，失败过的就跳过换下一个
  // 连锁采集类模组一次掉一堆（实测：chop 4 报 4，背包里 18 个原木）：能按物品名对上的以背包增量为准
  const names = new Set(ids.map((id) => bot.registry.blocks[id]?.name))
  const carried = () => bot.inventory.items().reduce((n, i) => n + (names.has(i.name) ? i.count : 0), 0)
  const before = carried()
  const gained = () => Math.max(got, carried() - before)
  while (runtime.isActive() && task && gained() < count && misses < 5) {
    const candidates = bot.findBlocks({ matching: ids, maxDistance, count: 24 }).filter((p) => !nearLava(p) && !bad.has(p.toString()))
    const pos = candidates.find((p) => !wet(p)) ?? candidates[0]
    if (!pos) break
    // Leave deep water before collecting. The plugin can resolve a no-path attempt without digging.
    if (floating()) {
      if (swam) return { got: gained(), error: '还漂在深水里，没找到能上岸挖掘的位置' }
      swam = true
      await leaveWater(pos)
      continue
    }
    // 没有能采集的工具时 mineflayer-tool 会无限递归去箱子里找，必须提前拦下
    const target = bot.blockAt(pos)
    if (!target.canHarvest(null) && !bot.inventory.items().some((i) => target.canHarvest(i.type))) {
      return { got, error: `挖 ${target.name} 需要更好的镐` }
    }
    try {
      await collectWithin(target)
      runtime.assertActive()
      const after = bot.blockAt(pos)
      if (!after || after.type === target.type) throw Object.assign(new Error(`未挖到 ${target.name}`), { name: 'NoPath' })
      got++
    } catch (err) {
      console.log(`[mine] ${err.name}: ${err.message}`)
      runtime.assertActive()
      // collectblock 背包满了要往箱子倒，没给箱子就抛 NoChests；以前重试 5 次后报"找不到能走到的目标方块"，原因说错了
      if (err.name === 'NoChests') {
        await inventorySettled()
        const n = gained()
        return { got: n, error: `${n ? `挖了 ${n} 个后` : ''}背包满了，先 bot dump 存杂物或 bot drop 丢掉些再挖` }
      }
      // 自卫打架会抢走寻路目标，等打完再继续；其他失败最多忍 5 次，这块够不着就换下一块
      if (combat.active()) await combat.waitOver()
      else {
        misses++; bad.add(pos.toString())
      }
    }
  }
  await inventorySettled()
  got = gained()
  return { got, error: got ? null : `${maxDistance} 格内找不到能走到的目标方块` }
}

// collectBlock 没有超时：够不着的树、掉到缝里等不到的掉落物都会让它一直等（实测：挖 1 个黑曜石卡 80 秒以上）。
// 限时后放弃这一块；走路卡住同样只放弃这一块，不取消整个任务（否则一棵够不着的树会让 get 整体失败）。
let stuckHandler = null
async function collectWithin(target) {
  const held = bot.heldItem?.type
  const digMs = target.digTime ? target.digTime(held ?? null, false, false, false, [], bot.entity.effects) : 5000
  const limit = 30_000 + Math.min(digMs * 2, 60_000)
  let timer
  const giveUp = new Promise((_, reject) => {
    const fail = (why) => {
      stuckHandler = null
      // 放弃时留下现场：只有"N 秒没挖到"看不出是在算路、走不动还是挖得太慢
      const me = bot.entity.position
      console.log(`[collect] 放弃 ${target.name}@${fmt(target.position)} 距离${me.distanceTo(target.position).toFixed(1)} 我在${fmt(me)}${bot.entity.isInWater ? '(水里)' : ''}${bot.entity.onGround ? '' : '(悬空)'} 寻路${bot.pathfinder.isMoving() ? '在走' : bot.pathfinder.isMining?.() ? '在挖' : '停着'} 目标${bot.pathfinder.goal ? '有' : '无'} 在挖${bot.targetDigBlock ? bot.targetDigBlock.name : '无'}`)
      runtime.unscoped(() => { bot.collectBlock.cancelTask().catch(() => {}); bot.pathfinder.setGoal(null); bot.stopDigging() })
      const err = new Error(why)
      err.name = 'CollectGiveUp'
      reject(err)
    }
    timer = setTimeout(() => fail(`${Math.round(limit / 1000)} 秒没挖到 ${target.name}`), limit)
    stuckHandler = () => fail(`走不到 ${target.name}`)
  })
  try {
    await Promise.race([bot.collectBlock.collect(target, { ignoreNoPath: true }), giveUp])
  } finally {
    clearTimeout(timer)
    stuckHandler = null
  }
}

async function pickup() {
  const items = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 24)
  if (!items.length) return say('附近没有掉落物')
  for (const it of items) {
    if (!task) return
    if (!bot.entities[it.id]) continue
    await travel(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.5)).catch(() => {})
    await sleepMs(150)
  }
  say(`捡了附近的 ${items.length} 堆东西`)
}

function inventorySummary() {
  const counts = {}
  for (const it of bot.inventory.items()) {
    const key = it.name || `未知#${it.type}`
    counts[key] = (counts[key] || 0) + it.count
  }
  const list = Object.entries(counts).map(([n, c]) => `${n}x${c}`)
  return list.length ? list.join(', ') : '背包是空的'
}

async function drop(name, count) {
  const item = bot.inventory.items().find((i) => i.name === name)
  if (!item) return say(`背包里没有 ${name}`)
  await bot.toss(item.type, null, Math.min(count || item.count, bot.inventory.count(item.type)))
  say(`丢了 ${name}`)
}

// 合成：缺中间材料（木板、木棍、工作台…）时递归先做出来，最多 3 层
async function craft(name, count) {
  const err = await craftItem(name, count, 0)
  say(err ? `做不了 ${name}：${err}` : `做好了 ${name}`)
}

// 共享背包模组会在合成、挖掘后再同步一遍背包；紧接着下一步会读到过期的格子。等背包 quietMs 内没有变化再继续
function inventorySettled(quietMs = 300, maxMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now()
    let timer
    const done = () => { bot.inventory.removeListener('updateSlot', bump); clearTimeout(timer); resolve() }
    const bump = () => { clearTimeout(timer); timer = setTimeout(done, Date.now() - start > maxMs ? 0 : quietMs) }
    bot.inventory.on('updateSlot', bump)
    bump()
  })
}

// 只用 16 格内、高度差 ≤3 的工作台：埋在地下/山上的旧工作台走过去很容易卡住，不如就地放一个
function findTable() {
  const me = bot.entity.position
  const pos = bot.findBlocks({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 16, count: 8 })
    .find((p) => Math.abs(p.y - me.y) <= 3)
  return pos ? bot.blockAt(pos) : null
}
async function getTable(depth, near = true) {
  const found = near && findTable()
  if (found) return found
  if (!bot.inventory.items().some((i) => i.name === 'crafting_table')) {
    if (depth >= 3 || await craftItem('crafting_table', 1, depth + 1)) return null
  }
  return placeCraftingTable()
}

async function craftItem(name, count, depth) {
  const item = bot.registry.itemsByName[name]
  if (!item) return `不认识物品 ${name}`
  let table = findTable()
  const all = bot.recipesAll(item.id, null, true)
  if (!all.length) return `${name} 没有合成配方`

  // 按"还缺多少材料"排序，依次尝试
  const shortfall = (r) => {
    const times = Math.ceil(count / r.result.count)
    return r.delta.filter((d) => d.count < 0)
      .map((d) => ({ id: d.id, need: -d.count * times - bot.inventory.count(d.id, d.metadata) }))
      .filter((d) => d.need > 0)
  }
  const ranked = all.map((r) => ({ r, miss: shortfall(r) }))
    .sort((a, b) => a.miss.reduce((n, d) => n + d.need, 0) - b.miss.reduce((n, d) => n + d.need, 0))

  // 报第一个（缺得最少、最可能成功的）配方的失败原因：后面的备选配方只会报"缺黑石"之类，掩盖真正原因
  let firstErr = null
  const fail = (msg) => { firstErr ||= msg }
  async function prepareIngredients(missing) {
    if (missing.length && depth >= 3) return false
    for (const d of missing) {
      const sub = bot.registry.items[d.id].name
      if (await craftItem(sub, d.need, depth + 1)) { fail(`缺 ${sub}`); return false }
    }
    return true
  }
  for (const { r, miss } of ranked) {
    if (!await prepareIngredients(miss)) continue
    if (r.requiresTable && !table) {
      table = await getTable(depth)
      if (!table) { fail(bot.inventory.count(bot.registry.itemsByName.crafting_table.id) ? '身边没地方放工作台（换个开阔的地方）' : '没有工作台，也做不出来'); continue }
    }
    if (r.requiresTable) {
      try {
        await travel(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
      } catch (err) {
        runtime.assertActive()
        table = await getTable(depth, false) // 走不过去就在身边放一个新的
        if (!table) { fail('工作台走不过去，也放不了新的'); continue }
      }
      // 临时做的工作台可能吃掉本配方已经准备好的木板。
      if (!await prepareIngredients(shortfall(r))) continue
    }
    // 用 mineflayer 重新取一次配方，确保材料就绪
    await inventorySettled()
    // 共享背包下背包内 2x2 合成不稳定（日志：多次 "updateSlot:0 did not fire"），手边有工作台就一律用工作台
    const reach = (t) => t && t.position.distanceTo(bot.entity.position) < 4
    let station = r.requiresTable ? table : (reach(findTable()) ? findTable() : null)
    let ready = bot.recipesFor(item.id, null, count, station)[0]
    if (!ready) continue
    try {
      await bot.craft(ready, Math.ceil(count / ready.result.count), station)
    } catch (err) {
      runtime.assertActive()
      if (!/did not fire|updateSlot|missing ingredient/.test(err.message)) throw err
      console.log(`[craft] ${name} 背包没同步（${station ? '工作台' : '背包合成'}），清理后用工作台重试`)
      runtime.unscoped(() => bot.closeWindow(bot.inventory)) // 关一次背包界面，服务器会把合成格里残留的材料退回背包
      await inventorySettled(600, 3000)
      station = table || findTable() || (depth < 3 ? await getTable(depth) : null)
      if (station) await travel(new goals.GoalNear(station.position.x, station.position.y, station.position.z, 2)).catch(() => {})
    // 先确认能靠近工作台，避免不可达时仍等待 windowOpen 超时。
      if (station && bot.entity.position.distanceTo(station.position.offset(0.5, 0.5, 0.5)) > 4.5) return `够不着工作台（${fmt(station.position)}），走不过去`
      ready = bot.recipesFor(item.id, null, count, station)[0]
      if (!ready) return '背包同步后材料不够了'
      await bot.craft(ready, Math.ceil(count / ready.result.count), station)
    }
    await inventorySettled()
    return null
  }
  return firstErr || '材料不够'
}

// 在身边找一块"下面实心、本身是空气"的位置，把背包里的物品放下去
// 草、花、雪片这类可被覆盖的格子也能放（日志：站在草丛里放不下熔炉）
const replaceable = (b) => b && (b.name === 'air' || b.name === 'cave_air' ||
  (b.boundingBox === 'empty' && !['water', 'lava', 'fire', 'soul_fire'].includes(b.name) && !b.name.endsWith('_bed') && !b.name.includes('torch')))
// 陡坡和窄崖边四周放不下东西（实测：山顶砍完树"身边没地方放工作台"，重试还在原地）：走到附近一块平地再放
async function stepToOpenGround() {
  const here = bot.entity.position
  const flat = (p) => bot.blockAt(p)?.boundingBox === 'block' && replaceable(bot.blockAt(p.offset(0, 1, 0))) && replaceable(bot.blockAt(p.offset(0, 2, 0)))
  const spots = bot.findBlocks({ matching: (b) => b.boundingBox === 'block', maxDistance: 12, count: 1500 })
    .filter((p) => p.distanceTo(here) > 2 && flat(p) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => flat(p.offset(x, 0, z))))
  for (const spot of spots.slice(0, 5)) {
    try {
      await travel(new goals.GoalBlock(spot.x, spot.y + 1, spot.z))
      return true
    } catch (err) {
      if (!['Timeout', 'NoPath'].includes(err.name)) throw err
    }
  }
  return false
}
async function placeNearby(match, moved = false) {
  const item = bot.inventory.items().find((i) => match(i.name))
  if (!item) return null
  const here = bot.entity.position.floored()
  const tall = item.name.endsWith('_bed') // 只有床要多占地；工作台熔炉一格就够
  const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]]
  for (const [dx, dz] of ring) {
    for (const dy of [0, -1, 1]) { // 坡地上高一格低一格也试
      const spot = here.offset(dx, dy, dz)
      const below = bot.blockAt(spot.offset(0, -1, 0))
      const at = bot.blockAt(spot)
      if (below?.boundingBox !== 'block' || below.name === 'modded_block' || !replaceable(at) || (tall && !replaceable(bot.blockAt(spot.offset(0, 1, 0))))) continue
      if (spot.x === here.x && spot.z === here.z) continue
      await bot.equip(item, 'hand')
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0))
      } catch (err) {
        console.log(`[place] ${item.name}@${spot}: ${err.message}`)
        continue // 床要两格长，这个方向放不下就换一个
      }
      await sleepMs(150)
      if (bot.blockAt(spot)?.name !== at.name) return bot.blockAt(spot)
    }
  }
  // 矿井里四周全是实心方块（实测：15 步合成链最后一步卡在"没地方放工作台"）：往旁边的墙里挖一格再放
  if (!tall) {
    for (const [dx, dz] of ring.slice(0, 4)) {
      const spot = here.offset(dx, 0, dz)
      const wall = bot.blockAt(spot), below = bot.blockAt(spot.offset(0, -1, 0))
      if (below?.boundingBox !== 'block' || !wall?.diggable || wall.boundingBox !== 'block' || wall.name === 'modded_block') continue
      if (!/^(stone|deepslate|dirt|grass_block|podzol|coarse_dirt|rooted_dirt|mycelium|moss_block|andesite|diorite|granite|tuff|netherrack|gravel|sand|cobblestone|cobbled_deepslate)$/.test(wall.name)) continue
      if ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => ['lava', 'water'].includes(bot.blockAt(spot.offset(x, y, z))?.name))) continue
      if (wall.harvestTools && !bot.inventory.items().some((i) => wall.harvestTools[i.type])) continue
      try {
        await bot.tool.equipForBlock(wall, {})
        await bot.dig(wall, true)
        await sleepMs(150)
        await bot.equip(item, 'hand')
        await bot.placeBlock(below, new Vec3(0, 1, 0))
        await sleepMs(150)
        if (bot.blockAt(spot)?.boundingBox === 'block') return bot.blockAt(spot)
      } catch (err) {
        console.log(`[place] 挖墙放置失败: ${err.message}`)
      }
    }
  }
  if (!moved && await stepToOpenGround()) return placeNearby(match, true)
  return null
}
const placeCraftingTable = () => placeNearby((n) => n === 'crafting_table')

// 只找没人睡的床（别人正睡着的床上不去会报错）
const findFreeBed = (maxDistance) => bot.findBlock({
  matching: (b) => b && b.name.endsWith('_bed') && b.getProperties?.().occupied !== true, useExtraInfo: true, maxDistance,
})
async function sleepInBed() {
  let bed = findFreeBed(32)
  if (!bed && await placeNearby((n) => n.endsWith('_bed'))) {
    await sleepMs(500) // 等两半床的方块状态都同步过来
    bed = findFreeBed(8)
  }
  if (!bed) return say('附近 32 格没有床，背包里也没有')
  await travel(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
  await bot.sleep(bed)
  say('晚安')
}

// ---- 自动吃饭 ----
let eating = false
async function autoEat(force = false) {
  if (flight?.active() || parkour?.inJump() || eating || bot.food >= (force ? 20 : 14)) return
  const foods = bot.registry.foodsByName
  const food = bot.inventory.items()
    .filter((i) => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(i.name))
    .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0]
  if (!food) return
  eating = true
  try {
    await bot.equip(food, 'hand')
    // 吃到一半被寻路换手等打断时 consume 可能永远不返回，加超时免得 eating 卡死
    await Promise.race([bot.consume(), sleepMs(5000).then(() => { throw new Error('吃东西超时') })])
  } catch (err) {
    console.log('[eat]', err.message)
  } finally {
    eating = false
  }
}
// 战斗中不吃：换手会放下武器，挨打还会打断进食（实测：吃东西超时，之后拿着牛肉打怪被打死）。血少了战斗循环会先撤退再吃。
// 撤退/逃跑也算战斗，避免被追击时换手进食而中断防御。
bot.on('health', () => { if (!combat.active()) autoEat(bot.health < 14) })

// ---- 自卫（combat.js）：苦力怕、骷髅有专门打法；打完恢复跟随/站岗 ----
let followTarget = null // 正在跟随的玩家，打完架恢复跟随
let followDistance = 2
let post = null // bot stay 设下的站岗位置，打完架走回去
const combat = createCombat(bot, {
  paused: () => !!flight?.active() || !!parkour?.inJump() || !!modes.recovering?.(),
  retreatMoves: () => safeMoves,
  movementOwner: () => `${runtime.generation()}:${runtime.status()?.id ?? 0}`,
  autoEat: (force) => autoEat(force),
  isEating: () => eating,
  log: (...a) => console.log(...a),
  // 原地挂机时被打，记下位置，打完回来
  onCombatStart: () => { if (!task && !followTarget && !post) post = bot.entity.position.clone() },
  // 正在干活的话，travel/挖矿会自己接着走。pvp.stop 的 pathfinder.stop 是延迟生效的，立刻设目标会被它清掉（实测：打完怪留在原地不回来）
  // 延迟长短取决于它当时能不能中断（实测：偶发 500ms 还没生效，机器人留在原地），所以没走起来就再设几次
  onCombatOver: () => {
    let tries = 0
    const retry = setInterval(() => {
      if (task || combat.active() || ++tries > 6 || (!followTarget && !post)) return clearInterval(retry)
      if (bot.pathfinder.isMoving()) return
      if (!followTarget && post.distanceTo(bot.entity.position) <= 2) return clearInterval(retry)
      resumeIdle()
    }, 500)
  },
  // 跟随时也保护对方：盯上他的怪一起打（参考 mineflayer 的 guard 示例）
  // 跟随对象一直保护；血量够时，12 格内的其他玩家被怪贴身也去帮
  protectees: () => Object.values(bot.players)
    .filter((p) => p.username !== bot.username && p.entity && (p.username === followTarget ||
      (bot.health > 10 && p.entity.position.distanceTo(bot.entity.position) < 12)))
    .map((p) => p.entity),
})
const equipWeapon = combat.equipWeapon
function resumeIdle() {
  const target = followTarget && bot.players[followTarget]?.entity
  if (target && !flight?.active()) bot.pathfinder.setGoal(new goals.GoalFollow(target, followDistance), true)
  else if (post) bot.pathfinder.setGoal(new goals.GoalNear(post.x, post.y, post.z, 1))
  else bot.pathfinder.setGoal(null)
}

// ---- 聊天指令 ----
const TOO_FAR = '离太远看不到你（约 60 格外）。发 bot goto 你的坐标，或者走近点'
const HELP = [
  'bot come / follow / stay / stop / halt / goto x y z / pos / hp / look',
  'bot mine <方块> [数量] (铁/煤/钻石/stone...) / chop [数量] / pickup',
  'bot inv / drop <物品> [数量] / craft <物品> [数量] / sleep / eat / guard on|off / auto on|off / say <内容>',
  '其他 "bot 随便说什么" 会交给 AI，比如: bot 帮我做一把石镐；bot workflows 看工作流',
]
const commands = {
  help: () => HELP.forEach((line, i) => setTimeout(() => say(line), i * 300)),
  come: (user, _args, routeOptions = {}) => {
    const target = bot.players[user]?.entity
    if (!target) return say(TOO_FAR)
    const { x, y, z } = target.position
    say('来了')
    return runTask('过去', async () => {
      const result = await autoTravel.travelTo({ x, y, z }, { range: 2, ...routeOptions })
      reportTravel(result)
      return result
    }, { timeoutMs: travelTimeout(x, z) })
  },
  follow: (user, [distance = '2']) => {
    const target = bot.players[user]?.entity
    if (!target) return say(TOO_FAR)
    followTarget = user
    followDistance = Number(distance)
    post = null
    bot.pathfinder.setGoal(new goals.GoalFollow(target, followDistance), true)
    say(`跟着 ${user}，保持${followDistance}格距离`)
  },
  stay: () => {
    stopAll()
    runtime.unscoped(() => {
      post = bot.entity.position.clone()
      say(`我在 ${fmt(post)} 守着，打完怪会回来`)
    })
  },
  goto: (u, args, routeOptions = {}) => {
    if (args.length === 1) return commands.go(u, args, routeOptions) // bot goto 家 = 去记住的地点
    const [x, y, z] = args.map(Number)
    if ([x, y, z].some(Number.isNaN)) return say('用法: bot goto x y z')
    say(`出发去 ${x} ${y} ${z}`)
    return runTask('赶路', async () => {
      const result = await autoTravel.travelTo({ x, y, z }, { range: 1, ...routeOptions })
      reportTravel(result)
      return result
    }, { timeoutMs: travelTimeout(x, z) })
  },
  stop: () => {
    const airborne = flight?.active()
    stopAll()
    runtime.unscoped(() => say(airborne ? '已取消航线，正在降落；落地前不会接新任务' : '停下了'))
    if (!airborne) return
    const landed = setInterval(() => {
      if (flight?.active()) return
      clearInterval(landed)
      if (bot.entity) runtime.unscoped(() => say(`已提前落地 ${fmt(bot.entity.position)}`))
    }, 500)
    landed.unref?.()
  },
  halt: () => {
    const wasAuto = auto || director.enabled() || runtime.status()?.origin === 'auto' || !!autonomyStartTimer
    stopAll('halt')
    runtime.unscoped(() => say(wasAuto ? '自主已停，目标和进度都保留' : '自主本来就是关的，没有要停的自主动作'))
  },
  pos: () => say(`我在 ${fmt(bot.entity.position)}`),
  hp: () => say(`血量 ${bot.health?.toFixed(0)} / 饱食 ${bot.food}`),
  look: () => {
    const nearby = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 16)
      .map((e) => e.username || e.name)
    say(nearby.length ? `附近: ${[...new Set(nearby)].slice(0, 10).join(', ')}` : '附近没东西')
  },
  mine: (_u, [name, n]) => name ? runTask(`挖${name}`, () => mine(name, Number(n) || 1)) : say('用法: bot mine <方块> [数量]'),
  chop: (_u, [n]) => runTask('砍树', () => mine('log', Number(n) || 4)),
  pickup: () => runTask('捡东西', pickup),
  inv: () => {
    const lines = ['']
    for (const part of inventorySummary().split(', ')) {
      if ((lines.at(-1) + part).length > 180) lines.push('')
      lines[lines.length - 1] += (lines.at(-1) ? ', ' : '') + part
    }
    lines.slice(0, 4).forEach((l, i) => setTimeout(() => say(l), i * 300))
  },
  drop: (_u, [name, n]) => name ? runTask('丢东西', () => drop(name, Number(n))) : say('用法: bot drop <物品> [数量]'),
  craft: (_u, [name, n]) => name ? runTask(`做${name}`, () => craft(name, Number(n) || 1)) : say('用法: bot craft <物品> [数量]'),
  sleep: () => runTask('睡觉', sleepInBed),
  eat: () => (bot.food >= 20 ? say('不饿') : runTask('吃东西', () => autoEat(true))),
  guard: (_u, [v]) => { combat.enabled = v !== 'off'; say(combat.enabled ? '自卫已开' : '自卫已关') },
  auto: (user, [v]) => { autoOwner = user; auto = v !== 'off'; lastAuto = 0; say(auto ? '自主模式已开，我会自己找事做' : '自主模式已关') },
  say: (_u, args) => args.length && say(args.join(' ')),
}

// ---- 进阶指令和常驻模式（skills.js / modes.js）----
const ctx = {
  travelTimeout, behindIsSafe, isDropAt,
  dimension,
  travelTo: (...args) => autoTravel.travelTo(...args),
  say, runTask, travel, sleepMs, fmt, craftItem, placeNearby, equipWeapon, resume: resumeIdle,
  alias: (n) => Object.hasOwn(ALIASES, n) ? ALIASES[n] : n,
  busy: () => runtime.busy(),
  stillRunning: () => runtime.isActive() && !!task,
  assertActive: runtime.assertActive,
  generation: runtime.generation,
  activityId: () => runtime.status()?.id || (followTarget ? `follow:${followTarget}:${followDistance}` : 0),
  paused: () => !!flight?.active(),
  occupied: () => !!task || !!followTarget || !!post || combat.active() || eating || !!bot.currentWindow || !!flight?.active(),
  transientPause: () => combat.active() || eating || !!bot.isSleeping || !!bot.currentWindow || !!flight?.active(),
  cancelTask: () => (stuckHandler ? stuckHandler() : stopAll('unstuck_limit')),
  findTable, mineIds, inventorySettled, placeNearby,
  sleepWithPlayers: () => runtime.scope(() => sleepWithPlayers()).catch((err) => console.log('[mode] 陪睡', err.message)),
  log: (...a) => console.log(...a),
}
ctx.containers = createContainers()
const experience = createExperience()
const skills = createSkills(bot, ctx)
Object.assign(commands, skills.commands)
ctx.smelt = skills.smelt
ctx.furnaceNearby = skills.furnaceNearby
Object.assign(commands, createAbilities(bot, ctx).commands)
const explorer = createExplorer(bot, ctx)
Object.assign(commands, explorer.commands)
ctx.combatActive = () => combat.active()
ctx.waitCombat = () => combat.waitOver()
const builder = createBuilder(bot, ctx)
Object.assign(commands, builder.commands)
Object.assign(commands, createRedstone(bot, ctx, builder).commands)
parkour = createParkour(bot, ctx)
Object.assign(commands, parkour.commands)

// 有玩家上床时跟着睡（多人服要够比例的人睡着才跳过夜晚）；睡醒后恢复跟随/站岗
async function sleepWithPlayers() {
  const bed = findFreeBed(24)
  if (!bed || runtime.busy()) return
  const keep = { followTarget, followDistance, post }
  const result = await runTask('陪睡', async () => {
    await travel(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
    await bot.sleep(bed)
    say('有人睡了，我也睡，晚安')
  }, { safe: true, timeoutMs: 60_000 })
  if (result?.stopped) return
  ;({ followTarget, followDistance, post } = keep)
  if (!bot.isSleeping) resumeIdle()
}
bot.on('wake', () => { if (!task) resumeIdle() })
function makeFlight() {
  let engine
  const landingAuthorized = () => flight === engine && engine.active() && engine.status()?.phase === 'LANDING'
  engine = createFlight(bot, {
    assertActive: runtime.assertActive, delay: runtime.delay,
    log: (...args) => console.log(...args),
    progress: (text) => say(text),
    safetyDelay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    safetyLook: (yaw, pitch) => {
      if (!landingAuthorized()) return
      return runtime.unscoped(() => bot.look(yaw, pitch, true))
    },
    safetyGlide: () => {
      if (!landingAuthorized()) return
      return runtime.unscoped(() => bot.elytraFly())
    },
  })
  return engine
}
flight = makeFlight()
let lastDimension
function handleDimension() {
  const next = dimension()
  if (!next || next === lastDimension) return
  const previous = lastDimension
  lastDimension = next
  if (!previous || !safeMoves) return
  console.log(`[world] ${previous} → ${next}，取消旧维度任务`)
  runtime.cancel('维度变化，旧任务已取消', 'dimension_changed')
  actionRun++
  ai?.cancel()
  if (goal || restoringGoal) saveGoal(null)
  goal = restoringGoal = null
  followTarget = post = task = null
  queue.length = 0
  companion.resetFollow()
  flight.dispose('dimension_changed')
  flight = makeFlight()
  stopTaskControls('dimension_changed')
  runtime.unscoped(() => {
    const oldWindow = bot.currentWindow
    if (oldWindow) {
      // A protocol close from the old level could use the new level's window id.
      bot.currentWindow = null
      oldWindow.emit?.('close')
      bot.emit('windowClose', oldWindow)
    }
    combat.stop()
    bot.pathfinder.setMovements(safeMoves)
  })
}
bot.on('game', handleDimension)
bot.on('respawn', handleDimension)
bot.on('spawn', () => { handleDimension(); flight.dispose('respawn'); flight = makeFlight() })
commands.fly = (_user, args) => {
  if (eating || combat.active() || bot.currentWindow) return say('先等吃饭、战斗或容器操作结束再起飞')
  let target
  if (args.length === 1) {
    const name = args[0]
    const place = skills.places && Object.hasOwn(skills.places, name) && skills.places[name]
    if (!place) return say('没有这个地点，先 bot mark 记录；步行仍可用 bot goto')
    if (place.dim && place.dim !== dimension()) return say('地点不在当前维度')
    target = { x: place.x, y: place.y, z: place.z }
  } else if (args.length === 2) {
    const [x, z] = args.map(Number) // 不给高度：落在那里的地面上
    target = { x, y: null, z }
  } else {
    const [x, y, z] = args.map(Number)
    target = { x, y, z }
  }
  const freeY = target.y == null
  const remaining = bot.entity ? Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) : 0
  // 超时只是兜底：按最慢 8 格/秒估，至少 3 分钟
  return runTask('鞘翅赶路', () => flyLegs(target, freeY), { safe: true, timeoutMs: Math.max(600_000, remaining / 8 * 1000) })
}
// 中途被迫降落（撞山、区块不来、耐久见底换备用）后接着飞，最多 8 段。人为取消、血量饥饿这类不重试
const FLY_AGAIN = new Set(['corridor_unsafe', 'chunks_not_loading', 'flight_lost', 'elytra_missing_or_low_durability', 'boost_corridor_unsafe'])
// 飞行前后的短途步行：走不到不算失败。寻路报 NoPath 后还会沿半截路径继续走，要停下，否则起飞预检总说没停稳
const walkLeg = async (goal, why) => {
  const attempt = async (label) => {
    try { await travel(goal) } catch (err) {
      runtime.assertActive()
      console.log(`[fly] ${label}: ${err.name}`)
    }
    bot.pathfinder.setGoal(null)
    return goal.isEnd(bot.entity.position.floored())
  }
  if (await attempt(why)) return
  // 寻路算不出路时可能直接“完成”，人还在原地（实测：自己挖的竖井底下）。到没到以坐标为准；飞行任务的配置不挖不搭，换干活配置再试
  bot.pathfinder.setMovements(workMoves)
  await attempt(`${why}（可挖）`)
  bot.pathfinder.setMovements(safeMoves)
}
// 寻路没有“往上游”这一步，沉在水下直接报走不通（实测：落水后反复起飞失败）。先自己浮上来
async function surfaceFromWater() {
  try {
    for (let i = 0; i < 200 && bot.entity.isInWater; i++) {
      runtime.assertActive()
      const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0), false)
      if (head && !bot.pathfinder.movements?.liquids?.has(head.type) && head.name !== 'water') return
      bot.setControlState('jump', true)
      await sleepMs(100)
    }
  } finally { bot.setControlState('jump', false) }
}
const standable = (x, y, z) => {
  const floor = bot.blockAt(new Vec3(x, y - 1, z), false), feet = bot.blockAt(new Vec3(x, y, z), false), head = bot.blockAt(new Vec3(x, y + 1, z), false)
  return !!floor && !!feet && !!head && floor.boundingBox === 'block' && !/leaves|water|lava|magma|ice$/.test(floor.name) &&
    feet.boundingBox === 'empty' && head.boundingBox === 'empty' && !/water|lava/.test(feet.name + head.name)
}
function nearestShore(tried) {
  const p = bot.entity.position.floored()
  for (let r = 2; r <= 96; r += 2) {
    const samples = Math.ceil(2 * Math.PI * r / 2)
    for (let i = 0; i < samples; i++) {
      const x = Math.round(p.x + Math.cos(i / samples * 2 * Math.PI) * r), z = Math.round(p.z + Math.sin(i / samples * 2 * Math.PI) * r)
      if (tried.some((t) => Math.hypot(t.x - x, t.z - z) < 8)) continue
      for (let y = p.y + 4; y >= p.y - 1; y--) if (standable(x, y, z)) return { x, y, z }
    }
  }
  return null
}
// 水里开不了鞘翅，也不能起飞：游到最近的岸。直接朝岸游，水面上不靠寻路；看不到岸就朝目标游一段再找
async function leaveWater(target) {
  await surfaceFromWater()
  const tried = []
  // 水面上一沉一浮，isInWater 会瞬间变假（实测：刚游一格就以为上岸了）。站到地上才算
  const wet = () => bot.entity.isInWater || !bot.entity.onGround
  try {
    for (let round = 0; round < 12 && wet(); round++) {
      const shore = nearestShore(tried)
      const p = bot.entity.position
      const d = Math.hypot(target.x - p.x, target.z - p.z) || 1
      const aim = shore || { x: p.x + (target.x - p.x) / d * 48, z: p.z + (target.z - p.z) / d * 48 }
      if (shore) { tried.push(shore); say(`落水了，先游到岸上 ${fmt(shore)}`) }
      let best = Infinity, lastGain = Date.now()
      while (wet() && Date.now() - lastGain < 5000) {
        runtime.assertActive()
        const now = bot.entity.position, left = Math.hypot(aim.x + 0.5 - now.x, aim.z + 0.5 - now.z)
        if (left < best - 0.5) { best = left; lastGain = Date.now() }
        if (!shore && left < 2) break
        await bot.look(Math.atan2(now.x - aim.x - 0.5, now.z - aim.z - 0.5), 0, true)
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
        await sleepMs(100)
      }
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
  for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleepMs(100)
  if (bot.entity.isInWater) console.log('[fly] 没游到岸')
}
async function flyLegs(target, freeY, options = {}) {
  let rockets = 0, result, completedLegs = 0, noProgress = 0
  let previousDistance = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
  let launchWalks = 0, launchWalkDistance = 0
  const maxLegs = Math.min(8, options.maxLegs || 8)
  for (let leg = 1; leg <= maxLegs; leg++) {
    runtime.assertActive()
    if (bot.entity.isInWater) await leaveWater(target)
    const torso = bot.inventory.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6]
    if (options.automatic && torso && torso.name !== 'elytra') {
      result = { ok: false, reached: false, landed: !!(bot.entity.onGround || bot.entity.isInWater), reason: 'torso_changed', position: { ...bot.entity.position } }
      break
    }
    if (guidance.elytraRemaining(bot) < 150) {
      const spare = guidance.spareElytras(bot).sort((a, b) => a.durabilityUsed - b.durabilityUsed)[0]
      if (spare && spare.maxDurability - spare.durabilityUsed > guidance.elytraRemaining(bot)) {
        runtime.assertActive()
        const slot = bot.inventory.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6]
        if (options.automatic && slot && slot.name !== 'elytra') break
        await bot.equip(spare, 'torso')
        runtime.assertActive()
        if (options.automatic && guidance.elytraRemaining(bot) < 120) throw new Error('自动赶路时鞘翅装备发生变化')
        say('换上备用鞘翅')
      }
    }
    // 树林、屋里起飞不了：先走到附近开阔地；附近没有就朝目标走一段再找
    let launch = flight.launchSite(target, 64)
    for (let walk = 0; !launch.here && !launch.site && walk < 8; walk++) {
      if (options.automatic && launchWalks >= 2) break
      const p = bot.entity.position, d = Math.hypot(target.x - p.x, target.z - p.z)
      if (d < 16) break
      const x = Math.round(p.x + (target.x - p.x) / d * Math.min(64, d)), z = Math.round(p.z + (target.z - p.z) / d * Math.min(64, d))
      const launchStep = Math.hypot(x - p.x, z - p.z)
      if (options.automatic && launchWalkDistance + launchStep > 64) break
      launchWalkDistance += launchStep
      launchWalks++
      say('附近没有能起飞的开阔地，往目标方向走一段')
      await walkLeg(new goals.GoalNearXZ(x, z, 6), '找起飞点')
      launch = flight.launchSite(target, 64)
    }
    if (launch.site) {
      const launchStep = Math.hypot(launch.site.x - bot.entity.position.x, launch.site.z - bot.entity.position.z)
      if (options.automatic && (launchWalks >= 2 || launchWalkDistance + launchStep > 64)) break
      launchWalkDistance += launchStep
      launchWalks++
      say(`这里起飞不了，先走到 ${fmt(launch.site)}`)
      await walkLeg(new goals.GoalBlock(launch.site.x, launch.site.y, launch.site.z), '去起飞点')
      // 到了再验一次：差一格也可能过不了预检（实测），不行就换地方
      for (let again = 0; again < 3 && !options.automatic; again++) {
        for (let i = 0; i < 30 && guidance.speed(bot) > 0.12; i++) await sleepMs(100)
        launch = flight.launchSite(target, 64)
        if (launch.here || !launch.site) break
        say(`这里起飞不了，先走到 ${fmt(launch.site)}`)
        await walkLeg(new goals.GoalBlock(launch.site.x, launch.site.y, launch.site.z), '去起飞点')
      }
    }
    runtime.assertActive()
    if (options.automatic) {
      const recheck = flight.assess(target)
      if (!recheck.ok) {
        result = { ok: false, reached: false, landed: !!(bot.entity.onGround || bot.entity.isInWater), reason: recheck.code, position: { ...bot.entity.position } }
        break
      }
    }
    if (result && Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) < 12) break // 这段路上已经够近了
    for (let i = 0; i < 30 && guidance.speed(bot) > 0.12; i++) await sleepMs(100) // 预检要求停稳
    try { result = await flight.fly(leg === 1 ? target : { ...target, y: freeY ? null : target.y }, { protectTorso: !!options.automatic }) } catch (err) {
      err.rocketsUsed = rockets
      err.flightLegs = completedLegs
      const near = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
      // 已经飞到附近，只是最后一小段过不去：如实报差多少，别把整趟说成失败
      if (result && !options.automatic && near < 64 && runtime.isActive() && !flight.active()) {
        say(`已飞到 ${fmt(bot.entity.position)}，离目标还差 ${Math.round(near)} 格，这段走不过去也飞不起来，用了 ${rockets} 枚烟花`)
        return result
      }
      if (runtime.isActive() && !flight.active()) err.message += `${rockets ? `（已用 ${rockets} 枚烟花）` : ''}；步行仍可用 bot goto`
      throw err
    }
    runtime.assertActive()
    completedLegs++
    rockets += result.rocketsUsed
    if (options.automatic) {
      const left = Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z)
      noProgress = left < previousDistance - 8 ? 0 : noProgress + 1
      previousDistance = left
      if (noProgress >= 2) { result = { ...result, ok: false, reached: false, reason: 'flight_no_progress' }; break }
      if (result.landed && ['health_low', 'food_low', 'water_fire_or_lava', 'torso_changed', 'landing_timeout'].includes(result.reason)) break
    }
    if (result.landed && FLY_AGAIN.has(result.reason)) {
      say(`第 ${leg} 段降落（${result.reason}），接着飞`)
      await sleepMs(1500)
      continue
    }
    const approach = async (p) => { await surfaceFromWater(); return walkLeg(freeY ? new goals.GoalNearXZ(p.x, p.z, 1) : new goals.GoalNear(p.x, p.y, p.z, 1), '步行对接') }
    result = await finishFlightRoute(bot, target, result, { assertActive: runtime.assertActive, say, freeY, walk: approach })
    let left = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
    // 飞行任务的寻路不挖不搭，落在树冠上就下不来（实测：差 13 格报走不通）。近处换干活配置，比再飞一段省
    if (result.reason === 'approach_incomplete' && left < 64) {
      bot.pathfinder.setMovements(workMoves)
      await approach(target)
      bot.pathfinder.setMovements(safeMoves)
      bot.pathfinder.setGoal(null)
      const p = bot.entity.position
      left = Math.hypot(p.x - target.x, p.z - target.z)
      const reached = left <= 2 && (freeY || Math.abs(p.y - target.y) <= 2)
      result = { ...result, ok: reached, reached, position: { x: p.x, y: p.y, z: p.z }, reason: reached ? 'hybrid_arrival' : 'approach_incomplete' }
    }
    // 还是过不去（墙、河）：还够远就再飞一段越过去
    if (result.reason !== 'approach_incomplete' || left < 12 || leg === maxLegs) break
    say(`走不过去，还差 ${Math.round(left)} 格，再飞一段`)
    await sleepMs(1000)
  }
  result ||= { ok: false, reached: false, landed: !!(bot.entity.onGround || bot.entity.isInWater), reason: 'launch_unavailable', position: { ...bot.entity.position } }
  if (options.reportFinal !== false) {
    if (result.reached && result.landed) say(`${result.finalApproach === 'walk' ? '已飞行并步行对接到' : '已飞抵并落地'} ${fmt(result.position)}，使用${rockets}枚烟花`)
    else if (result.landed) say(`已提前落地 ${fmt(result.position)}，未到目标：${result.reason}`)
    else say('飞行结束，但未确认安全落地：' + result.reason)
  }
  return { ...result, rocketsUsed: rockets, flightLegs: completedLegs }
}
function reportTravel(result) {
  runtime.assertActive()
  if (result.ok) say(`到了 ${fmt(result.position)}，${result.transport === 'walk' ? '步行' : '使用鞘翅' + (result.transport === 'hybrid' ? '并步行对接' : '')}，消耗${result.rocketsUsed || 0}枚烟花`)
  else say(`未到目标，停在 ${result.position ? fmt(result.position) : '未知位置'}：${TRAVEL_REASON[result.reason] || result.reason}`)
}
const TRAVEL_REASON = {
  torso_occupied: '穿着普通胸甲，保留现有装备', torso_changed: '装备被改变',
  rockets_insufficient: '普通烟花不足', elytra_missing_or_low_durability: '没有可用鞘翅或耐久不足',
  durability_insufficient: '鞘翅和备用耐久不足', launch_blocked: '附近起飞净空不够',
  not_on_ground: '尚未回到地面', not_stationary: '尚未停稳', health_low: '血量偏低', food_low: '食物不足',
  overworld_survival_required: '当前维度或游戏模式不适合飞行', unsafe_body_block: '当前位置有危险',
  water_fire_or_lava: '当前在水、火或岩浆中', eating: '正在进食', combat: '正在战斗', container_open: '容器尚未关闭',
  hazard_escape_timeout: '未脱离危险，自保仍在尝试',
}
autoTravel = createAutoTravel(bot, {
  assertActive: runtime.assertActive, delay: runtime.delay,
  dimension,
  getFlight: () => flight,
  ready: () => ({ ok: !eating && !combat.active() && !bot.currentWindow && !bot.isSleeping,
    reason: eating ? 'eating' : combat.active() ? 'combat' : bot.currentWindow ? 'container_open' : bot.isSleeping ? 'sleeping' : null }),
  walk: async (target, range) => {
    runtime.assertActive()
    bot.pathfinder.setMovements(workMoves)
    return reach(new goals.GoalNear(target.x, target.y, target.z, range), target, range)
  },
  arrived: (target, range) => {
    const goal = new goals.GoalNear(target.x, target.y, target.z, range)
    const p = bot.entity.position, cx = Math.floor(target.x) + 0.5, cz = Math.floor(target.z) + 0.5
    // 玩家给的 y 常差一格（站在水面、半砖、草径上）：水平到了、高差 1.5 格内也算到。
    return goal.isEnd(p.floored()) || p.distanceTo(new Vec3(cx, Math.floor(target.y), cz)) <= range + 0.5 ||
      (Math.hypot(p.x - cx, p.z - cz) <= range + 0.5 && Math.abs(p.y - Math.floor(target.y)) <= 1.5)
  },
  fly: async (target, options) => {
    runtime.assertActive()
    bot.pathfinder.setMovements(safeMoves)
    return flyLegs(target, false, options)
  },
  say: (text) => say(text.replace(/（([a-z_]+)）/g, (full, reason) => TRAVEL_REASON[reason] ? `（${TRAVEL_REASON[reason]}）` : full)),
  log: (...args) => console.log(...args),
})
commands.walk = (_user, args) => {
  let target
  if (args.length === 1) {
    const place = Object.hasOwn(skills.places, args[0]) && skills.places[args[0]]
    if (!place) { say('没有这个地点'); return { ok: false, error: '没有这个地点' } }
    if (place.dim && place.dim !== dimension()) { say('地点不在当前维度'); return { ok: false, error: '地点不在当前维度' } }
    target = { x: place.x, y: place.y, z: place.z }
  } else {
    const [x, y, z] = args.map(Number)
    target = { x, y, z }
  }
  return runTask('步行赶路', async () => {
    const result = await autoTravel.travelTo(target, { mode: 'walk', range: 1 })
    reportTravel(result)
    return result
  }, { timeoutMs: travelTimeout(target.x, target.z) })
}
const companion = createCompanion(bot, {
  say, dimension, log: (...args) => console.log(...args),
  getFollow: () => followTarget && ({ name: followTarget, distance: followDistance }),
  paused: () => runtime.busy() || combat.active() || eating || !!flight?.active() || !!modes.recovering?.(),
  followEntity: (entity, distance) => { bot.pathfinder.setMovements(safeMoves); bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true) },
  pauseFollow: () => bot.pathfinder.setGoal(null),
  clearFollow: (reason) => { followTarget = null; bot.pathfinder.setGoal(null); say(reason) },
})
commands.scan = () => say(companion.scan())
commands.advice = () => say(companion.advice())
commands.lastdeath = () => say(companion.lastDeath())
const modes = createModes(bot, ctx)
createGreeter(bot, { log: (...a) => console.log(...a), chat: (m) => runtime.unscoped(() => bot.chat(m)) })
commands.mode = (_u, [name, v]) => {
  if (!name) return modes.describe().forEach((l, i) => setTimeout(() => say(l), i * 300))
  say(modes.set(name, v !== 'off') ? `${name} 已${v === 'off' ? '关' : '开'}` : `没有这个模式，可选: ${modes.list()}`)
}
commands.lessons = (_u, [sub]) => {
  if (sub === 'clear') { experience.clear(); return say('经验清空了') }
  say(experience.recent().join(' / ').slice(0, 380) || '还没有经验')
}
commands.note = (_u, args) => { if (args.length) { memory.add(args.join(' ')); say('记下了') } else say(memory.list().join(' / ') || '还没有笔记') }
HELP.push('bot fly x z / fly x y z / fly <地点>（主世界任意距离；穿好鞘翅、带够普通烟花）；bot follow [2-8格]')
HELP.push('bot smelt/chest/chests [物品]/chestscan [半径]/fetch <物品> [数量]/lessons [clear]/deposit/withdraw/find/hunt/surface/equip/mark/unmark/places/go <地点> / mode / note / goal <目标> / status / scan / advice / lastdeath')
HELP.push('建筑: bot build <tower/wall/floor/stairs/pyramid> [m=材料] [at=x,y,z] [f=朝向] [clear=1] / fill / bridge [长] [方向] / pillar [高] / copy / paste <蓝图> / undo / materials / blueprints')
HELP.push('红石: bot circuit <lamp/not/or/and/memory/gate/autodoor/clock/fastclock/nightlight/dropbox> / wire / use [x y z] / door open|close / repeater / rs / rstrace / rsdiag；跑酷: bot parkour x y z / parkour check x y z')
HELP.push('bot get <物品> [数量]（自动挖/烧/合成）/ plan <物品> / farm [半径] / breed <动物> / shear / milk / fish [次数] / tunnel [长度] [东南西北] / digdown [深度] / excavate 方块[,方块] [r=半径] [above=y] [below=y] [max=数量] / torch / explore <方块> / dump')

// ---- AI：不是固定指令的 "bot ..." 就交给 AI 理解（AI_PROVIDER 选后端；external = 交给外部 agent）----
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'deepseek').toLowerCase()
const EXTERNAL_AGENT = AI_PROVIDER === 'external'
function makeAI() {
  if (AI_PROVIDER === 'off' || EXTERNAL_AGENT) return null
  const key = process.env.AI_API_KEY || { deepseek: process.env.DEEPSEEK_API_KEY, openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY }[AI_PROVIDER]
  const baseUrl = process.env.AI_BASE_URL || undefined
  if (!key && !(AI_PROVIDER === 'openai' && baseUrl)) return null
  try {
    const made = createAI({
      provider: AI_PROVIDER, apiKey: key, baseUrl,
      model: process.env.AI_MODEL || (AI_PROVIDER === 'deepseek' ? process.env.DEEPSEEK_MODEL : undefined) || undefined,
      jsonMode: process.env.AI_JSON_MODE !== 'off', fallbacks: process.env.AI_FALLBACKS !== 'off',
      thinking: (process.env.AI_THINKING || process.env.DEEPSEEK_THINKING) !== 'off',
      limits: { perMinute: process.env.AI_RPM, perHour: process.env.AI_RPH },
      getName: () => bot.username, getServerNotes: () => [describeVersion(facts), mods.promptNotes(), workflowPromptNotes()].filter(Boolean).join('\n'),
    })
    console.log(`[ai] 后端 ${AI_PROVIDER}${process.env.AI_MODEL ? ` / ${process.env.AI_MODEL}` : ''}`)
    return made
  } catch (err) { console.log(`[ai] AI 配置不对，只认固定指令: ${err.message}`); return null }
}
const ai = makeAI()
// 外部 agent 模式：自然语言请求变成事件，由连着 Agent API / MCP 的程序处理
function handOff(user, text) {
  agentEvents.push('request', { user: user ?? null, text: String(text).slice(0, 500) })
  if (user) say(`${user}，收到，交给外部 agent 处理`)
  return { error: true, code: 'EXTERNAL' }
}
commands.status = () => {
  const current = runtime.status()
  const stats = ai?.statistics()
  const traffic = autoTravel.status()
  const transport = traffic.active ? ({ SELECTING: '评估路线', WALKING: '步行', FLIGHT_REQUESTED: '鞘翅准备/飞行' }[traffic.phase] || '赶路中')
    : ({ walk: '步行', fly: '鞘翅', hybrid: '鞘翅和步行' }[traffic.last?.transport] || '无')
  say(`任务: ${current ? `${current.name}${current.cancelling ? '（收尾中）' : ''}` : '空闲'}；交通:${transport}；飞行:${flight?.status()?.phase || 'IDLE'}；自主:${director.enabled() ? `开(本小时剩${director.budget().left}/${director.budget().max})` : '关'}；AI额度: ${ai ? `本分钟剩${stats.minute.remaining}/${stats.minute.limit}，本小时剩${stats.hour.remaining}/${stats.hour.limit}` : '未配置'}；目标: ${goal?.label || goal?.text || '无'}`)
}

// 玩家的“这里”“这个”：给 AI 说话人的坐标和他正看着的方块
function speakerContext(user) {
  const e = user && bot.players?.[user]?.entity
  if (!e) return user ? `说话的玩家 ${user} 不在视野内（约60格外），不知道他的坐标` : ''
  let looking = ''
  try {
    const dir = new Vec3(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch))
    const hit = bot.world.raycast(e.position.offset(0, 1.62, 0), dir, 32)
    if (hit) looking = `，正看着 ${hit.name}@${hit.position.x},${hit.position.y},${hit.position.z}`
  } catch {}
  return `说话的玩家 ${user} 在 ${fmt(e.position)}${looking}`
}
function biomeName() {
  try { return bot.blockAt(bot.entity.position.floored())?.biome?.name || '' } catch { return '' }
}
const recentChat = []
const recentActions = []
const remember = (list, line, max) => { list.push(String(line).slice(0, 200)); if (list.length > max) list.shift() }
function describeState(user = currentRequester, query = '') {
  const lessons = query ? experience.recall(goal?.text || query).join('；').slice(0, 500) : ''
  const stored = bot.entity ? ctx.containers.describe(dimension() || 'unknown', bot.entity.position, `${goal?.text || ''} ${query}`).slice(0, 500) : ''
  const p = bot.entity?.position
  const time = bot.time?.timeOfDay
  return [
    p && `位置 ${fmt(p)}`,
    `血量 ${bot.health?.toFixed(0)}/20 饱食 ${bot.food}/20`,
    time != null && (time < 12500 ? '白天' : '夜晚'),
    biomeName() && `生物群系 ${biomeName()}`,
    bot.isRaining && '在下雨',
    speakerContext(user),
    task && `正在${task}`,
    recentChat.length && `最近聊天: ${recentChat.join(' / ').slice(0, 700)}`,
    recentActions.length && `最近执行: ${recentActions.join(' / ').slice(0, 700)}`,
    autoTravel && `交通选择: ${autoTravel.describe()}`,
    `生存观察: ${companion.scan()}`,
    underCover() && '头顶有方块挡着（在地下、坑里或屋里）：要去别处先 surface 或走出去',
    goal && `长期目标: ${goal.text}`,
    lessons && `过往经验: ${lessons}`,
    stored && `箱子记忆: ${stored}`,
    `附近方块: ${nearbyBlocks() || '没什么特别的'}`,
    `附近生物: ${nearbyEntities() || '无'}`,
    nearbyPlayers() && `附近玩家: ${nearbyPlayers()}`,
    itemKnowledge() && `物品知识: ${itemKnowledge()}`,
    skills.describePlaces() && `记住的地点: ${skills.describePlaces()}`,
    `背包: ${inventorySummary()}`,
  ].filter(Boolean).join('；').slice(0, 5800).toWellFormed()
}
function underCover() {
  const p = bot.entity?.position
  if (!p) return false
  for (let y = 2; y < 32; y++) if (bot.blockAt?.(new Vec3(Math.floor(p.x), Math.floor(p.y) + y, Math.floor(p.z)), false)?.boundingBox === 'block') return true
  return false
}
// 16 格内值得关注的方块（资源、工作站），按种类计数
const NOTABLE = /(_log|_ore|^crafting_table|^furnace|^chest|^barrel|_bed|^water|^lava|^modded_block)$/
function nearbyBlocks() {
  const counts = {}
  const positions = bot.findBlocks({ matching: (b) => b && NOTABLE.test(b.name), maxDistance: 16, count: 200 })
  for (const p of positions) {
    const name = bot.blockAt(p)?.name
    if (name) counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts).map(([n, c]) => `${n}x${c}`).join(', ')
}
// 玩家在哪个方向、多远、手里拿什么：方便 AI 配合（"你去挖矿我来砍树"）
function nearbyPlayers() {
  const me = bot.entity.position
  const dir = (dx, dz) => (Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? '东' : '西') : (dz > 0 ? '南' : '北'))
  return Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity)
    .map((p) => {
      const e = p.entity, d = e.position.distanceTo(me)
      const held = e.heldItem?.name
      return `${p.username}(${dir(e.position.x - me.x, e.position.z - me.z)}${d.toFixed(0)}格${held ? `，拿着${held}` : ''})`
    }).slice(0, 6).join(' ')
}
// 背包里模组物品的知识和试用笔记
function itemKnowledge() {
  const names = [...new Set(bot.inventory.items().map((i) => i.name).filter(Boolean))]
  const learned = explorer.notesFor(names)
  const modTips = [...new Set(names.filter((n) => n.includes(':')).map((n) => modTipFor(n)).filter(Boolean))].slice(0, 2)
  const unknown = names.filter((n) => n.includes(':') && !modTipFor(n) && !learned.some((l) => l.startsWith(n))).slice(0, 4)
  return [...learned, ...modTips, unknown.length && `没研究过的模组物品(可 inspect/try): ${unknown.join(',')}`].filter(Boolean).join('；').slice(0, 800)
}
function nearbyEntities() {
  const counts = {}
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || e.position.distanceTo(bot.entity.position) > 16) continue
    const name = e.username || e.name
    if (name && name !== 'item' && name !== 'experience_orb') counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts).map(([n, c]) => (c > 1 ? `${n}x${c}` : n)).join(', ')
}

let aiWork = false
// 返回 { done, log, failed, plan, check } / { error, code, waitMs } / { stopped }
async function talkToAI(user, message, rounds = 3, { effort = 'high', intent = message } = {}) {
  if (!ai) { if (EXTERNAL_AGENT) return handOff(user, message); say('没配置 AI，只认固定指令，试试 bot help'); return { error: true } }
  if (aiWork || (runtime.busy() && !runtime.ownsTask()) || flight?.active()) { say('上一个任务还在执行或收尾，请稍等'); return { error: true } }
  aiWork = true
  const requestedRun = actionRun
  try {
    const forceWalk = /(?:只(?:能)?|仅|全程)(?:步行|走路)|(?:不要|别|不许)(?:用)?(?:鞘翅|飞行|飞)|\b(?:walk only|do not fly|don't fly|no elytra)\b/i.test(intent)
    const forceFly = !forceWalk && /飞(?:回|到|去|过去)|用鞘翅|\bfly to\b/i.test(intent)
    return await runtime.scope(() => talkRound(user, message, rounds, { forceWalk, forceFly, effort }))
  } catch (err) {
    if (err instanceof CancelledError || requestedRun !== actionRun || !runtime.isActive()) return { stopped: true }
    console.log(`[ai] ${err.name}: ${err.message}`)
    if (err.code === 'AI_RATE_LIMIT') {
      const stats = ai.statistics()
      const waitMs = Math.max(stats.minute.remaining ? 0 : stats.minute.resetInMs, stats.hour.remaining ? 0 : stats.hour.resetInMs)
      // 长期目标（rounds=1）有自己的等待提示；玩家直接说的话不能没有回音（实测：额度用完时一声不吭）
      if (user && rounds > 1) say(`${user}，AI 额度暂时用完了，${Math.ceil(waitMs / 1000)} 秒后再说；固定指令不受影响（bot help）`)
      return { error: true, code: err.code, waitMs }
    }
    if (user) say('这次请求没能完成：' + err.message)
    return { error: true, code: err.code }
  } finally {
    aiWork = false
  }
}

// 背包快照与变化（Voyager critic 的本地版：动作做完看背包到底变了什么，反馈给 AI）
function invCounts() {
  const counts = {}
  for (const it of bot.inventory.items()) if (it.name) counts[it.name] = (counts[it.name] || 0) + it.count
  return counts
}
function invDelta(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].map((n) => [n, (after[n] || 0) - (before[n] || 0)]).filter(([, d]) => d)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10).map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`).join(' ')
}
// 失败关键词要具体：曾因"还需要什么？"里的"需要"把成功误判成失败
const FAILURE = /失败|没开工|没盖完|盖不了|贴不了|搭不了|拉不了|做不了|需要(更好|特殊| ?\d)|找不到|没有(足够|能|熔炉|工作台|剪刀|空桶|鱼竿|火把)|背包里没有|不认识|看不到|未知|拿不到|没拿到|挖不动|停下原因|不到 2 只|没地方|没找到/

async function talkRound(user, message, rounds, { forceWalk = false, forceFly = false, effort = 'high' } = {}) {
  const run = actionRun // 必须在请求前固定，stop 后旧响应不可重新获得授权。
  runtime.assertActive()
  const knowledge = relevantTips(`${message} ${goal?.text || ''} ${task || ''}`, 4).join('；')
  const options = { signal: runtime.signal(), knowledge, effort }
  let result
  // 思考可能要十几秒：玩家当面说的话别让他干等
  const thinkingNote = user && rounds > 1 && !message.startsWith('[系统]') ? setTimeout(() => { try { say(`${user}，我想一下…`) } catch {} }, 5000) : null
  try {
    result = await ai.ask(user, message, describeState(user, message), memory.list(), options)
  } catch (err) {
    if (err.code !== 'AI_INVALID_RESULT' || !err.detail) throw err
    // 模型偶尔写超长、多给字段或用错参数，整轮作废太可惜：把原因告诉它，重写一次（实测：日志里只有一句“格式不正确”，指令就丢了）
    console.log(`[ai] 输出没通过校验，重试: ${err.detail}`)
    runtime.assertActive()
    result = await ai.ask(user, `${message.slice(0, 1500)}\n[系统] 你上一次的输出没通过校验（${err.detail}）。改掉这一点，重新输出完整 JSON。`, describeState(user, message), memory.list(), { ...options, retry: true })
  } finally {
    clearTimeout(thinkingNote)
  }
  if (result?.understanding) console.log(`[ai] 理解: ${result.understanding}`)
  runtime.assertActive()
  if (run !== actionRun) return { stopped: true }
  if (!result || !Array.isArray(result.actions)) throw new Error('模型结果格式错误')
  // 整批预验证，避免前半批已执行后才发现后半批非法。
  const actions = result.actions.map((a) => {
    if (!a || !AI_ACTIONS.has(a.cmd)) throw new Error('模型返回不支持的动作')
    return normalizeAction(a.cmd, a.args, { ai: true })
  })
  if (result.reply) say(result.reply)
  const log = []
  const before = invCounts()
  const startPos = bot.entity?.position && { x: bot.entity.position.x, z: bot.entity.position.z }
  let failed = false
  // 每个动作单独记结果；一个失败就不再执行后面的（后面的往往依赖它），交给 AI 重新规划
  for (const [i, { cmd, args }] of actions.entries()) {
    runtime.assertActive()
    if (run !== actionRun) return { stopped: true }
    const label = `${cmd}${args.length ? ' ' + args.join(' ') : ''}`
    if (['come', 'follow'].includes(cmd) && !user) { log.push(`${label}: 没有明确跟随对象`); failed = true; break }
    if (task && !runtime.ownsTask() && cmd !== 'stop') await waitIdle()
    runtime.assertActive()
    // 玩家明确说了要飞：不让交通选择改成走路（实测：“飞回去”走了路，玩家只好手动 fly）。烟花由玩家这句话授权
    // AI 只能跑开放给它的工作流（ai: true）
    const fn = cmd === 'run' ? (u, a) => runWorkflow(a[0], u, { byAI: true }) : getCommand(commands, forceFly && ['goto', 'go'].includes(cmd) ? 'fly' : cmd)
    if (!fn) throw new Error('动作未注册')
    const said = []
    sayLog = said
    let outcome
    try {
      const worn = bot.inventory.slots?.[bot.getEquipmentDestSlot?.('torso') ?? 6]
      if (cmd === 'equip' && args[0] === 'elytra' && worn && worn.name !== 'elytra') {
        say('保留现有胸甲，不会为了自动赶路换掉它；仍可直接赶路，由程序选择步行')
        outcome = { ok: false, error: 'armor_protected' }
      } else outcome = await fn(user, args, forceWalk && ['goto', 'go', 'come'].includes(cmd) ? { mode: 'walk' } : undefined)
    } finally {
      sayLog = null
    }
    if (outcome?.stopped) return { stopped: true }
    const structuredTravel = outcome?.kind === 'travel'
    const bad = structuredTravel ? !outcome.ok : outcome?.ok === false || said.some((l) => FAILURE.test(l))
    log.push(structuredTravel ? `${label}: ${JSON.stringify({ ok: outcome.ok, reached: outcome.reached, transport: outcome.transport, reason: outcome.reason, fallbackReason: outcome.fallbackReason, rocketsUsed: outcome.rocketsUsed, position: outcome.position })}${bad ? '（失败）' : ''}` : `${label}: ${said.join('；').slice(0, 160) || '完成'}${bad ? '（失败）' : ''}`)
    if (bad) {
      failed = true
      if (i < actions.length - 1) log.push(`未执行: ${actions.slice(i + 1).map((a) => a.cmd).join(', ')}`)
      break
    }
  }
  const delta = invDelta(before, invCounts())
  if (delta) log.push(`背包变化: ${delta}`)
  for (const line of log) remember(recentActions, line, 6)
  const moved = startPos && bot.entity?.position ? Math.hypot(bot.entity.position.x - startPos.x, bot.entity.position.z - startPos.z) > 3 : false
  if (failed && rounds > 1 && run === actionRun) {
    return talkRound(user, `[系统] 执行结果（有失败，请换方法重新规划）: ${log.join(' / ').slice(0, 900)}`, rounds - 1, { forceWalk, forceFly, effort: 'high' })
  }
  return { done: result.done, log, failed, plan: result.plan, check: result.check, tasks: result.tasks, labels: actions.map((a) => `${a.cmd} ${a.args.join(' ')}`.trim()), changed: Boolean(delta) || moved }
}

// ---- 长期目标（参考 Mindcraft 的 !goal + Voyager 的自检 + Reflexion 的失败记忆）----
// AI 先给计划，每轮执行一两步，程序把执行结果、背包变化、反复失败的动作、状况变化（死亡/卡住/超时）
// 一起反馈回去，AI 据此更新计划；说完成时按 check 本地核对背包。目标存盘，重启后继续。
const GOAL_FILE = path.join(__dirname, 'data', 'goal.json')
const GOAL_ROUNDS = 60
const GOAL_TIME = 120 * 60_000
let goal = null
let restoringGoal = null // 重启后的目标恢复窗口也属于玩家工作，日程不得抢先占用。
const goalEvents = [] // 状况变化，下一轮告诉 AI
function saveGoal(g) {
  try {
    writeJSON(GOAL_FILE, g ? { text: g.text, label: g.label, starter: g.starter, plan: g.plan, rounds: g.rounds, history: g.history, failures: g.failures, startedAt: g.startedAt, maxRounds: g.maxRounds, tasks: g.tasks, steps: g.steps } : {})
  } catch (err) { console.log('[goal] 保存失败', err.message) }
}
function goalPrompt(g, events) {
  const failures = Object.entries(g.failures).filter(([, n]) => n >= 2).map(([k, n]) => `${k}(${n}次)`).slice(0, 6)
  const tasks = g.tasks || []
  return [
    `[系统] 长期目标: ${g.text.slice(0, 500)}（发起人 ${g.starter}，第 ${g.rounds}/${g.maxRounds || GOAL_ROUNDS} 轮）`,
    events.length ? `状况变化（优先处理，据此调整清单）: ${events.join('；').slice(0, 500)}` : '',
    tasks.length ? `任务清单（程序记账）: ${agent.describeTasks(tasks)}` : '还没有任务清单：先给出 tasks，再做第一步。',
    g.history.length ? `最近进展: ${g.history.slice(-4).join(' | ')}` : '',
    failures.length ? `反复失败（别再原样重试）: ${failures.join('、')}` : '',
    '只做下一两步，更新变了状态的任务；全部完成才 done=true。',
  ].filter(Boolean).join('\n').slice(0, 1750)
}
// 程序验收：null 表示通过，字符串是没通过的原因
function verifyFailure(v) {
  if (!v) return null
  if (v.item) {
    const have = bot.inventory.items().filter((i) => i.name === v.item).reduce((n, i) => n + i.count, 0)
    return have >= v.count ? null : `背包 ${v.item} 只有 ${have}/${v.count}`
  }
  const me = bot.entity.position
  if (v.near) {
    const d = Math.hypot(me.x - v.near[0], me.z - v.near[2])
    return d <= v.r ? null : `离 ${v.near.join(',')} 还差 ${d.toFixed(0)} 格`
  }
  if (v.placed) {
    const name = bot.blockAt(new Vec3(...v.at))?.name
    return name === v.placed ? null : `${v.at.join(',')} 是 ${name || '未加载'}，不是 ${v.placed}`
  }
  if (v.cleared) {
    const ids = v.cleared.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined)
    const point = v.center ? new Vec3(...v.center) : me
    const left = bot.findBlocks({ point, matching: ids, maxDistance: v.r, count: 2048 })
      .filter((p) => (v.above === undefined || p.y > v.above) && (v.below === undefined || p.y < v.below)).length
    return left <= v.left ? null : `范围内还剩 ${left} 个 ${v.cleared.join('/')}`
  }
  return null
}
// 把模型这轮的清单并进账本并验收；返回要告诉模型的问题
function absorbTasks(g, res) {
  const notes = []
  if (res.tasks) g.tasks = agent.mergeTasks(g.tasks || [], res.tasks)
  else if (res.plan?.length) g.tasks = agent.tasksFromPlan(res.plan)
  if (res.plan?.length) g.plan = res.plan
  g.tasks ||= []
  g.plan = g.tasks.map((t) => t.text)
  for (const t of g.tasks) {
    if (t.status !== 'done' || t.verified || !t.verify) continue
    const why = verifyFailure(t.verify)
    if (!why) { t.verified = true; continue }
    t.fails = (t.fails || 0) + 1
    t.status = t.fails >= 3 ? 'failed' : 'doing'
    t.why = why.slice(0, 60)
    notes.push(`任务#${t.id}「${t.text}」验收没过: ${why}`)
  }
  return notes
}
const plainDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// label：对玩家说话时用的短名字（重新规划的目标原文很长，别整段念出来）
async function runGoal(text, starter, resumed = null, maxRounds = GOAL_ROUNDS, label = text, firstEvents = []) {
  const g = resumed || { text, starter, plan: [], tasks: [], rounds: 0, history: [], failures: {}, steps: [], startedAt: Date.now(), maxRounds, label: label.slice(0, 60) }
  g.label ||= g.text.slice(0, 60)
  g.steps ||= []
  let finished = false
  let succeeded = false
  const limit = g.maxRounds || GOAL_ROUNDS
  const startInv = invCounts() // 核对时排除"本来就有"的情况（实测：AI 拿已有的 1 个羊毛当剪完了的证据）
  goal = g
  goalEvents.length = 0
  goalEvents.push(...firstEvents)
  saveGoal(g)
  let idle = 0
  let checkFails = 0
  let errors = 0
  let doneBlocked = 0
  const stalled = agent.stallTracker()
  try {
    while (goal === g && g.rounds < limit && Date.now() - g.startedAt < GOAL_TIME) {
      g.rounds++
      const events = goalEvents.splice(0)
      // 每轮在全新的取消作用域里跑：死亡/卡住/超时取消了上一轮，不影响下一轮
      // 顺利时低思考省钱；有状况或刚开始时认真想
      const effort = events.length || g.rounds <= 1 || g.history.at(-1)?.includes('（失败）') ? 'high' : 'low'
      const res = await runtime.unscoped(() => talkToAI(g.starter, goalPrompt(g, events), 1, { effort, intent: g.text }))
      if (goal !== g) break
      if (res?.code === 'AI_RATE_LIMIT') { // 额度用完就等，不放弃目标
        g.rounds--
        say(`AI 额度暂时用完，${Math.ceil((res.waitMs || 30_000) / 1000)} 秒后继续目标`)
        await plainDelay(Math.min(Math.max(res.waitMs || 30_000, 5000), 10 * 60_000))
        continue
      }
      if (res?.stopped) { if (goal === g) { await plainDelay(3000); continue } break } // 被状况打断：等一下带着事件重新规划
      if (!res || res.error) {
        // 一次超时或输出坏掉不该毁掉长任务（实测：一轮格式错目标就没了下文）
        g.rounds--
        if (++errors >= 4) { say(`「${g.label}」连续出错，先停下；${agent.summarize(g.tasks || [])}`); finished = true; break }
        await plainDelay(5000 * errors)
        continue
      }
      errors = 0
      for (const note of absorbTasks(g, res)) goalEvents.push(note)
      for (const l of res.labels || []) if (l !== g.steps.at(-1) && g.steps.length < 10) g.steps.push(String(l))
      const summary = res.log.join(' / ').slice(0, 220) || '没有执行指令'
      g.history = [...g.history, `R${g.rounds}: ${summary}`].slice(-8)
      for (const line of res.log) {
        if (!line.endsWith('（失败）')) continue
        const key = line.split(':')[0].slice(0, 40)
        g.failures[key] = (g.failures[key] || 0) + 1
      }
      const repeats = stalled(res.labels || [], res.changed)
      if (repeats >= 3) { say(`「${g.label}」同样的动作做了几轮都没变化，先停下；${agent.summarize(g.tasks)}`); finished = true; break }
      if (repeats) goalEvents.push(`上一轮的 ${res.labels.join('、')} 执行了但位置和背包都没变化，这个做法没有推进目标，换一个`)
      const open = agent.pending(g.tasks)
      if (res.done && !res.failed && open.length && goal === g) {
        if (++doneBlocked >= 3) { say(`${g.starter}，「${g.label}」AI 坚持结束；${agent.summarize(g.tasks)}`); finished = true; break }
        goalEvents.push(`你说完成了，但这些任务还没做完: ${open.map((t) => `#${t.id}${t.text}`).join('、')}。接着做，做不了就标 failed 并说明`)
      } else if (res.done && !res.failed && goalEvents.some((e) => e.includes('验收没过')) && goal === g) {
        // 验收没过的已退回 doing，上面的分支会接住；failed 的继续往下收尾
      } else if (res.done && !res.failed && goal === g) {
        const c = res.check
        const have = c && bot.inventory.items().filter((i) => i.name === c.item).reduce((n, i) => n + i.count, 0)
        if (c && have >= c.count && (startInv[c.item] || 0) >= c.count) {
          say(`${g.starter}，AI 说「${g.label}」完成了，但 ${c.item} 开始前就有 ${startInv[c.item]} 个，请自己核对一下`)
          finished = true
          break
        }
        if (c && have < c.count) {
          checkFails++
          goalEvents.push(`核对失败：要 ${c.count} 个 ${c.item}，背包里只有 ${have} 个`)
          if (checkFails >= 3) { say(`「${g.label}」核对 3 次都没通过，先停下`); finished = true; break }
        } else {
          const verified = g.tasks.filter((t) => t.verified).length
          say(c ? `${g.starter}，「${g.label}」完成了（核对 ${c.item} x${have}）`
            : g.tasks.length ? `${g.starter}，「${g.label}」完成了：${agent.summarize(g.tasks)}${verified ? `，其中 ${verified} 项已核对` : ''}`
              : `${g.starter}，「${g.label}」AI 已结束处理（没有可核对的物品，结果见上面的说明）`)
          succeeded = !!(c || g.tasks.length)
          finished = true
          break
        }
      }
      idle = res.log.length ? 0 : idle + 1
      if (idle >= 3) { say(`「${g.label}」连续 3 轮没有动作，先停下`); finished = true; break }
      saveGoal(g)
      await plainDelay(1000)
    }
    if (goal === g && !finished && g.rounds >= limit) say(`「${g.label}」用完 ${limit} 轮还没完成，先停下；${agent.summarize(g.tasks || [])}`)
  } catch (err) {
    if (!(err instanceof CancelledError)) console.log(`[goal] ${err.message}`)
  } finally {
    if (goal === g) {
      // 玩家取消的（goal 已被换掉）不算经验；走到这里的才是真结果
      if (finished || g.rounds >= limit) {
        const failed = (g.tasks || []).filter((t) => t.status === 'failed').map((t) => t.text)
        const clean = succeeded && !failed.length && !agent.pending(g.tasks || []).length
        if (clean || g.rounds > 1) experience.record({ goal: g.label, outcome: clean ? 'done' : 'failed', rounds: g.rounds, steps: g.steps, why: [...failed, ...Object.entries(g.failures).sort((a, b) => b[1] - a[1]).map(([k]) => k)] })
      }
      goal = null; saveGoal(null)
    }
  }
}
commands.goal = (user, args) => {
  if (!args.length) return say(goal ? `当前目标: ${goal.label || goal.text}（第 ${goal.rounds} 轮）${goal.plan.length ? ' 计划: ' + goal.plan.join(' → ') : ''}` : '没有目标。用法: bot goal <目标> / bot goal stop')
  if (args[0] === 'stop') { stopAll(); return runtime.unscoped(() => say('目标取消')) }
  if (!ai) return say('没配置 AI，用不了长期目标')
  if (goal) return say(`已经有目标: ${goal.label || goal.text}，先 bot goal stop`)
  restoringGoal = null
  say(`收到目标: ${args.join(' ')}`)
  runGoal(args.join(' '), user).catch((err) => console.log('[goal]', err.message)) // 不阻塞聊天处理
}
// 重启后接着做上次没完成的目标（2 小时内的）
bot.once('spawn', () => {
  const saved = readJSON(GOAL_FILE, {})
  if (!ai || typeof saved?.text !== 'string' || !saved.text || typeof saved.starter !== 'string' || !(Date.now() - saved.startedAt < 2 * 3600_000)) return
  const g = {
    text: saved.text.slice(0, 1000), starter: saved.starter.slice(0, 32),
    label: typeof saved.label === 'string' ? saved.label.slice(0, 60) : saved.text.slice(0, 60),
    plan: Array.isArray(saved.plan) ? saved.plan.filter((p) => typeof p === 'string').slice(0, 8) : [],
    rounds: Number.isSafeInteger(saved.rounds) ? saved.rounds : 0,
    history: Array.isArray(saved.history) ? saved.history.filter((h) => typeof h === 'string').slice(-8) : [],
    failures: saved.failures && typeof saved.failures === 'object' ? Object.fromEntries(Object.entries(saved.failures).filter(([, n]) => Number.isSafeInteger(n)).slice(0, 20)) : {},
    startedAt: saved.startedAt,
    maxRounds: Number.isSafeInteger(saved.maxRounds) && saved.maxRounds > 0 && saved.maxRounds <= GOAL_ROUNDS ? saved.maxRounds : GOAL_ROUNDS,
    tasks: agent.restoreTasks(saved.tasks),
    steps: Array.isArray(saved.steps) ? saved.steps.filter((s) => typeof s === 'string').slice(0, 10) : [],
  }
  restoringGoal = g
  setTimeout(() => {
    if (restoringGoal !== g) return
    restoringGoal = null
    if (goal || runtime.busy()) return
    say(`继续重启前的目标: ${g.text}`)
    goalEvents.push('机器人刚重启过，背包和位置可能已经变化')
    runGoal(g.text, g.starter, g).catch((err) => console.log('[goal]', err.message))
  }, 10_000)
})

// 玩家的一句话可能是一长串事：AI 说没做完（done=false）就接成小目标继续，不用玩家一句句催。
// 实测：第一轮成功后就没下文了，“先…再…然后…”只做了第一步
const INSTRUCTION_ROUNDS = 30
let firstRound = null // 第一轮还没变成目标时玩家追加的话，别丢进队列等它做完
async function instruct(user, text) {
  const early = firstRound = []
  const res = await talkToAI(user, text).finally(() => { firstRound = null })
  if (!res || res.error || res.stopped || goal) return res
  const g = { text: text.slice(0, 1000), starter: user, plan: [], tasks: [], rounds: 1, history: [], failures: {}, steps: (res.labels || []).map(String).slice(0, 10), startedAt: Date.now(),
    maxRounds: INSTRUCTION_ROUNDS, label: text.slice(0, 60) }
  const notes = [...absorbTasks(g, res), ...early]
  const open = agent.pending(g.tasks)
  if (res.done !== false && !open.length && !notes.length) return res
  if (!g.tasks.length && !res.log?.length && !early.length) return res // 闲聊、反问：等玩家回话
  if (g.tasks.length > 1) say(`计划: ${g.plan.join(' → ')}`.slice(0, 180))
  g.history = [`R1: ${res.log.join(' / ').slice(0, 220) || '没有执行指令'}`]
  runtime.unscoped(() => runGoal(g.text, user, g, INSTRUCTION_ROUNDS, g.label, notes)).catch((err) => console.log('[goal]', err.message))
  return res
}

// 忙的时候也要听懂人话：问进度当场答，喊停就停，新要求交给正在跑的目标
function whileBusy(user, text) {
  if (agent.CANCEL.test(text)) {
    stopAll()
    runtime.unscoped(() => say(`${user}，好，停下了`))
    return true
  }
  if (agent.STATUS_QUESTION.test(text)) {
    const tasks = goal?.tasks || []
    const now = tasks.find((t) => t.status === 'doing') || agent.pending(tasks)[0]
    say(`${user}，${goal ? `在做「${goal.label || goal.text}」，${tasks.length ? agent.summarize(tasks) : `第 ${goal.rounds} 轮`}` : '手上有事'}${task ? `；当前: ${task}` : now ? `；当前: ${now.text}` : ''}`.slice(0, 240))
    return true
  }
  if (goal || firstRound) {
    (goal ? goalEvents : firstRound).push(`玩家新要求（${user}）: ${text.slice(0, 200)}`)
    say(`${user}，收到，这步做完就按你说的调整`)
    return true
  }
  return false
}

// ---- 指令失败时把现状交给 AI 重新规划（bot replan off 可关）----
let replan = true
let lastReplan = 0
async function replanAfterFailure(user, line, said) {
  if (!ai || !replan || goal || aiWork || Date.now() - lastReplan < 60_000) return
  lastReplan = Date.now()
  console.log('[replan]', line.slice(0, 60))
  say('这条没做成，我让 AI 看看现状换个办法接着做')
  // 当成一个小的长期目标交给 AI：多轮规划-执行-检查，直到完成或判断做不到（最多 8 轮）
  const text = `帮 ${user} 完成玩家指令「bot ${line}」。刚才直接执行失败: ${said.join('；').slice(0, 300)}。换方法完成；确实做不到就说明原因并 done=true`
  runGoal(text.slice(0, 600), user, null, 8, `bot ${line}`).catch((err) => console.log('[replan]', err.message))
}
commands.replan = (_u, [v]) => { replan = v !== 'off'; say(replan ? '失败后自动让 AI 重新规划：开' : '失败后自动重新规划：关') }

// ---- 自主模式：空闲、天黑、血少时让 flash 决定下一步。默认关闭，省 token ----
let auto = false
let autoOwner = null
let lastAuto = 0
let wasNight = false
async function autoThink(reason) {
  if (!auto || !ai || autonomyState().busy || bot.pathfinder.isMoving() || Date.now() - lastAuto < 60_000) return
  lastAuto = Date.now()
  console.log('[auto]', reason)
  return runTask('自主规划', () => talkToAI(autoOwner, `[系统] 自主模式: ${reason}`, 2), { priority: PRIORITIES.routine, origin: 'auto', safe: true })
}
setInterval(() => {
  if (!bot.entity) return
  const night = (bot.time?.timeOfDay ?? 0) >= 12500
  if (night && !wasNight) autoThink('天黑了')
  else if (bot.health < 8) autoThink(`血量只剩 ${bot.health.toFixed(0)}`)
  else if (!task && !bot.pathfinder.isMoving() && Date.now() - lastAuto > 180_000) autoThink('空闲 3 分钟了')
  wasNight = night
}, 5000)
async function waitIdle() {
  const deadline = Date.now() + 30_000
  while (runtime.busy()) {
    runtime.assertActive()
    if (Date.now() > deadline) throw new Error('等待任务超时')
    await sleepMs(100)
  }
}

const inputLimit = createRateLimiter({ limit: 8, windowMs: 10_000 })
const globalInputLimit = createRateLimiter({ limit: 80, windowMs: 60_000 })
const limitNotice = createRateLimiter({ limit: 1, windowMs: 10_000 })
const REPLANNABLE = new Set([...AI_ACTIONS].filter((c) => !['run', 'walk', 'plan', 'note', 'guard', 'stop', 'stay', 'follow', 'mark', 'inspect', 'tip', 'try', 'rs', 'rstrace', 'rsdiag', 'materials', 'blueprints'].includes(c)))
const readCommands = new Set(['workflows', 'help', 'status', 'pos', 'hp', 'look', 'inv', 'places', 'scan', 'advice', 'lastdeath', 'plan', 'inspect', 'tip', 'rs', 'rstrace', 'rsdiag', 'materials', 'blueprints'])
// .js 模组扩展注册的指令：只能玩家直接下（AI 调不到），不能和已有指令重名；干活类走 runTask，bot stop 能停、有超时
const extensionCommands = new Map()
function registerExtensionCommand(name, spec) {
  if (getCommand(commands, name) || extensionCommands.has(name)) throw new Error(`指令 ${name} 已经存在`)
  extensionCommands.set(name, spec)
  commands[name] = spec.read
    ? (user, args) => spec.run(user, args)
    : (user, args) => runTask(`${name}（${spec.id}）`, () => spec.run(user, args))
  if (spec.help && HELP.length < 10) HELP.push(`bot ${name}: ${spec.help}（扩展 ${spec.id}）`) // help 一行一条，别刷屏
  console.log(`[mods:${spec.id}] 注册指令 bot ${name}`)
}
// 唤醒词：bot 一直有效，MC_PREFIX 可以再加最多 4 个（比如 cb,小助手）
const PREFIXES = ['bot', ...String(process.env.MC_PREFIX || '').split(',').map((p) => p.trim()).filter((p) => {
  if (!p || p.toLowerCase() === 'bot') return false
  if (/^[A-Za-z\p{Script=Han}][\w\p{Script=Han}]{0,11}$/u.test(p)) return true
  console.log(`[config] 忽略不合法的唤醒词 ${p.slice(0, 16)}`)
  return false
}).slice(0, 4)]
const PREFIX_RE = new RegExp(`^(?:${PREFIXES.join('|')})\\s+`, 'iu') // 唤醒词只含字母数字汉字下划线，不用转义
function systemFeedback(user, message) {
  return /^(?:rcon|server|@)$/i.test(String(user).trim()) || /^\[[^\[\]\r\n:：]+[:：][\s\S]*\]$/.test(message.trim())
}
function handleChat(user, message, { whisper = false } = {}) {
  Promise.resolve().then(async () => {
    if (user === bot.username || typeof message !== 'string') return
    const head = PREFIX_RE.exec(message.trim())
    const body = head ? message.trim().slice(head[0].length) : ''
    const m = head && body.match(/^(\S+)\s*(.*)$/s)
    if (!m) return mentioned(user, message)
    if (message.length > 1000) return say('指令太长了')
    const name = m[1].toLowerCase()
    const args = m[2] ? m[2].split(/\s+/) : []
    const stopping = name === 'stop' || name === 'halt' || (name === 'goal' && args.length === 1 && args[0] === 'stop')
    if (!stopping && (!inputLimit.take(user) || !globalInputLimit.take())) {
      // 限流时别一声不吭（实测：玩家会以为机器人死机了）；提示本身也限频
      if (limitNotice.take(user)) say(`${user}，指令发太快了，等几秒再发`)
      return
    }
    if (!safeMoves || !bot.entity) return say('还没准备好，请等进服后再试')
    console.log(`[command] user=${String(user).slice(0, 32)} cmd=${name.slice(0, 32)}`)
    const reading = readCommands.has(name) || !!extensionCommands.get(name)?.read || (['mode', 'note', 'goal', 'lessons'].includes(name) && !args.length)
    // 先统一等待自主任务收尾，覆盖自然语言、跟随和工作流等不直接调用 runTask 的入口。
    const preemptable = runtime.status()?.origin === 'auto' && !goal
    if (!stopping && !reading && preemptable) {
      try {
        const revision = await runtime.preempt(PRIORITIES.player)
        runtime.assertRequestActive(revision)
      } catch (err) { if (!(err instanceof BusyError)) throw err }
    }
    if (!stopping && !reading && (runtime.busy() || aiWork || goal || flight?.active() || workflowActive)) {
      // 不是固定指令的自然语言才走这里：固定指令照旧排队
      if (!getCommand(commands, name) && whileBusy(user, body)) return
      // 忙的时候不拒绝，排队（最多 3 条），手上的做完就接着做
      if (queue.length >= 3) return say('排队的指令已经有 3 条了，等等或 bot stop 清空')
      queue.push({ user, message, whisper })
      return say(`${user}，收到，排第 ${queue.length} 个，等「${goal ? goal.label || goal.text : task || '当前的事'}」做完就做（bot stop 会清空队列）`)
    }
    const fn = getCommand(commands, name)
    currentRequester = String(user).slice(0, 32)
    if (fn && !reading) remember(recentActions, `${currentRequester} 下令 ${name} ${args.join(' ')}`, 6)
    if (fn) {
      let checked
      try {
        checked = extensionCommands.has(name) ? { cmd: name, args: normalizeExtensionArgs(args) } : normalizeAction(name, args)
      } catch (err) {
        // "bot come here"、"bot come 到我这" 这类口语带了多余参数：交给 AI 理解，别直接报错
        if (err.code !== 'INVALID_ACTION' || !ai || stopping) throw err
        return runtime.scope(() => instruct(user, body))
      }
      if (stopping) return runtime.unscoped(() => fn(user, checked.args))
      if (reading && whisper && /^[A-Za-z0-9_]{1,16}$/.test(user)) return replyStore.run(user, () => runtime.scope(() => fn(user, checked.args)))
      if (reading || !REPLANNABLE.has(name)) return runtime.scope(() => fn(user, checked.args))
      // 干活类指令：记下它说了什么，失败就把现状交给 AI 重新规划
      const said = []
      sayLog = said
      return Promise.resolve(runtime.scope(() => fn(user, checked.args))).finally(() => { if (sayLog === said) sayLog = null }).then((outcome) => {
        if (outcome?.stopped || outcome?.replan === false || !(outcome?.kind === 'travel' ? !outcome.ok : outcome?.ok === false || said.some((l) => FAILURE.test(l)))) return
        return replanAfterFailure(user, `${name} ${checked.args.join(' ')}`.trim(), said)
      })
    }
    if (['__proto__', 'constructor', 'prototype', 'tostring', 'valueof'].includes(name)) return say('不支持这个指令')
    return runtime.scope(() => instruct(user, body))
  }).catch((err) => {
    if (err instanceof CancelledError) return
    console.log(`[command] ${err.name}: ${err.message}`)
    runtime.unscoped(() => say('指令未执行：' + err.message))
  })
}
bot.on('chat', (user, message) => {
  if (typeof message !== 'string' || systemFeedback(user, message)) return
  remember(recentChat, `${user === bot.username ? '我' : user}: ${message.slice(0, 80)}`, 8)
  if (user === bot.username) return
  agentEvents.push('chat', { user: String(user).slice(0, 32), text: message.slice(0, 300) })
  handleChat(user, message)
})
// 私聊不用加 bot 前缀
bot.on('whisper', (user, message) => {
  if (user === bot.username || typeof message !== 'string' || systemFeedback(user, message)) return
  handleChat(user, PREFIX_RE.test(message.trim()) ? message : `bot ${message}`, { whisper: true })
})

// ---- 排队：忙时收到的指令，空闲后按顺序执行 ----
const queue = []
setInterval(() => {
  if (!queue.length || runtime.busy() || aiWork || goal || flight?.active() || workflowActive || !bot.entity) return
  const next = queue.shift()
  handleChat(next.user, next.message, { whisper: next.whisper })
}, 1000)

// ---- 没加 bot 前缀但叫到了我：当成聊天回应（参考 Mindcraft 的对话），忙时先简单回一句 ----
const mentionLimit = createRateLimiter({ limit: 2, windowMs: 30_000 })
function mentioned(user, message) {
  const text = message.trim()
  const me = bot.username.toLowerCase()
  if (text.length > 200 || !(text.toLowerCase().includes(me) || /机器人|claude|小c/i.test(text))) return
  if (!mentionLimit.take(user) || !globalInputLimit.take()) return
  console.log(`[mention] user=${String(user).slice(0, 32)}`)
  if (runtime.busy() || aiWork || goal || flight?.active()) {
    if (whileBusy(user, text.replace(new RegExp(bot.username, 'ig'), '').trim())) return
    return say(`${user}，我在${task ? `「${task}」` : goal ? `做目标「${goal.label || goal.text}」` : '忙'}，要我做事就说 bot 加指令，会排队；急事 bot stop`)
  }
  if (!ai) return EXTERNAL_AGENT ? handOff(user, text) : say(`${user}，在呢！说 bot help 看我能做什么`)
  currentRequester = String(user).slice(0, 32)
  return runtime.scope(() => instruct(user, `[玩家在聊天里叫到你，没加 bot 前缀] ${text}`))
}

bot.on('death', () => agentEvents.push('death', { position: bot.entity?.position && fmt(bot.entity.position) }))
bot.on('death', () => { flight?.dispose('death'); stopAll('death'); say('我挂了…可用 bot lastdeath 查看坐标') })
bot.on('messagestr', (msg) => { if (msg.startsWith(bot.username + ' ')) console.log('[server]', msg) })
bot.on('kicked', (reason) => console.log('[kicked]', JSON.stringify(reason)))
bot.on('error', (err) => {
  console.log('[error]', err.message)
  // 服务器版本比 mineflayer 支持的新/旧：说清楚，别让人以为是网络问题
  if (/unsupported protocol version|not supported|version .* is not supported/i.test(err.message)) {
    const { latestSupportedVersion: newest, oldestSupportedVersion: oldest } = require('mineflayer/lib/version')
    console.log(`[startup] 服务器版本不在支持范围（${oldest} ~ ${newest}）。更新 mineflayer（npm update mineflayer minecraft-data），或让服务器装 ViaVersion 兼容旧客户端，再用 MC_VERSION=${newest}`)
  }
})
bot.on('end', (reason) => { flight?.dispose('disconnect'); companion.dispose(); console.log('[end]', reason); exitForRetry(0) })
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  stopAll('shutdown')
  const until = Date.now() + 30_000
  while (flight?.active() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
  if (flight?.active()) console.log('[shutdown] 未确认落地，断开前停止控制')
  flight?.dispose('shutdown')
  bot.quit()
}
process.on('SIGINT', () => { shutdown().catch((err) => console.log('[shutdown]', err.message)) })
process.on('SIGTERM', () => { shutdown().catch((err) => console.log('[shutdown]', err.message)) })
// 连不上或 60 秒内没进服就退出，外部进程管理器可负责重启。
// 没进过服时按连续失败次数退避后再退出（最多 5 分钟），避免频繁重试。
const RETRY_FILE = path.join(__dirname, 'data', 'reconnect.json')
let spawned = false
const saveFailures = (failures) => { try { writeJSON(RETRY_FILE, { failures }) } catch (err) { console.log('[reconnect]', err.message) } }
let exiting = false
// ---- 自定义工作流（workflows/*.json）----
let workflows = new Map()
let workflowActive = null
const workflowRuns = new Map() // id → 上次开始的时间（冷却）
function loadAllWorkflows() {
  workflows = loadWorkflows(process.env.MC_WORKFLOWS_DIR || path.join(__dirname, 'workflows'), { extensionCommands })
  if (workflows.size) console.log(`[workflow] 载入 ${[...workflows.keys()].join(', ')}`)
}
function workflowPromptNotes() {
  const open = [...workflows.values()].filter((w) => w.ai)
  return open.length ? `可用工作流（run 名字 调用，一次做完一串事）：${open.map((w) => `${w.id}${w.description ? `（${w.description}）` : ''}`).join('；')}`.slice(0, 600) : ''
}
function inventoryCount(name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
}
const isNight = () => { const t = bot.time?.timeOfDay ?? 0; return t >= 13000 && t < 23000 }
// ---- 本地日程：不调用模型的自主（MC_AUTONOMY=on 才启用），bot halt 可以停 ----
const AUTONOMY = /^(1|on|true|yes)$/i.test(String(process.env.MC_AUTONOMY || ''))
const AUTONOMY_TICK = Math.min(60_000, Math.max(1000, Number(process.env.MC_AUTONOMY_TICK) || 5000))
const AUTONOMY_MAX = Math.min(240, Math.max(1, Number(process.env.MC_AUTONOMY_MAX) || 60))
const hostileNear = (radius = 12) => {
  if (!bot.entity) return 0
  return Object.values(bot.entities).filter((e) => e !== bot.entity && e.kind === 'Hostile mobs' &&
    e.position.distanceTo(bot.entity.position) < radius).length
}
function autonomyState() {
  if (!bot.entity) return { busy: true }
  const inventory = {}
  for (const item of bot.inventory.items()) inventory[item.name] = (inventory[item.name] || 0) + item.count
  const home = skills.places && Object.hasOwn(skills.places, '家') ? skills.places['家'] : null
  const p = bot.entity.position
  return {
    hp: bot.health ?? 20,
    food: bot.food ?? 20,
    night: isNight(),
    distanceToHome: home ? Math.hypot(home.x - p.x, home.z - p.z) : Infinity,
    homeName: '家',
    inventory,
    nearHostiles: hostileNear(),
    busy: runtime.busy() || !!task || !!aiWork || !!goal || !!restoringGoal || flight?.active() ||
      !!workflowActive || queue.length > 0 || !!followTarget || !!post || eating || !!bot.currentWindow || !!bot.isSleeping || combat.active(),
  }
}
// 日程只调已有指令；优先级/来源放在模块级临时值上，让指令内部的 runTask 继承。
// 指令失败往往只是 say("...需要更好的镐")，所以按 handleChat 同一套 FAILURE 规则判成 fail。
async function runAutonomyStep(next) {
  const fn = getCommand(commands, next.cmd)
  if (!fn) return { ok: false, error: `没有指令 ${next.cmd}` }
  const prevPriority = defaultPriority
  const prevOrigin = defaultOrigin
  const outer = sayLog
  const said = []
  defaultPriority = PRIORITIES.routine
  defaultOrigin = 'auto'
  sayLog = said
  let outcome
  let promise
  try {
    try {
      // 指令通常同步进入 runTask，靠这一瞬间的默认值继承 routine/auto；
      // 取到 promise 就恢复，否则玩家指令在自主任务运行期间也会被当成 routine。
      promise = fn(null, next.args)
    } finally {
      defaultPriority = prevPriority
      defaultOrigin = prevOrigin
    }
    outcome = await promise
  } finally {
    if (sayLog === said) sayLog = outer
    outer?.push(...said)
  }
  // 被玩家抢占不是失败：不记账、不退避
  if (outcome?.preempted || outcome?.stopped) return { ok: false, interrupted: true, preempted: !!outcome.preempted, stopped: !!outcome.stopped }
  const bad = outcome?.ok === false || said.some((l) => FAILURE.test(l))
  const why = said.find((l) => FAILURE.test(l)) || outcome?.error || '动作没有完成'
  return bad ? { ok: false, error: String(why).slice(0, 160) } : { ok: true }
}
const director = createDirector({
  getState: autonomyState,
  run: runAutonomyStep,
  tickMs: AUTONOMY_TICK,
  maxPerHour: AUTONOMY_MAX,
})
if (AUTONOMY) {
  console.log(`[auto] 本地日程启用：每 ${AUTONOMY_TICK / 1000} 秒检查一次，每小时最多 ${AUTONOMY_MAX} 个动作`)
  autonomyStartTimer = setTimeout(() => { autonomyStartTimer = null; director.start() }, 5000)
  autonomyStartTimer.unref?.()
}
// 执行一条指令并判断成败（和 AI 动作同一套判断）
async function execStep(user, cmd, args) {
  if (task && !runtime.ownsTask()) await waitIdle()
  const fn = getCommand(commands, cmd)
  if (!fn) return { ok: false, error: `没有指令 ${cmd}` }
  const said = []
  const outer = sayLog // AI 调用工作流时外层也在记录，做完要还回去
  sayLog = said
  let outcome
  try { outcome = await fn(user, args) } finally { if (sayLog === said) sayLog = outer; outer?.push(...said) }
  if (outcome?.stopped) return { ok: false, stopped: true, said }
  const bad = outcome?.kind === 'travel' ? !outcome.ok : outcome?.ok === false || said.some((l) => FAILURE.test(l))
  return { ok: !bad, error: bad ? String(outcome?.error || said.join('；')).slice(0, 160) : undefined, said }
}
async function runWorkflow(id, user = null, { byAI = false } = {}) {
  const wf = workflows.get(id)
  if (!wf) { say(`没有工作流 ${id}，bot workflows 看有哪些`); return { ok: false, error: `没有工作流 ${id}` } }
  if (byAI && !wf.ai) return { ok: false, error: `工作流 ${id} 没开放给 AI（文件里写 "ai": true 才行）` }
  if (workflowActive) { say(`工作流「${workflowActive}」还在跑`); return { ok: false, error: 'busy' } }
  workflowActive = id
  workflowRuns.set(id, Date.now())
  const run = actionRun
  agentEvents.push('workflow', { id, state: 'start', user })
  console.log(`[workflow] start ${id}`)
  say(`开始工作流「${wf.name}」`)
  const runner = createRunner({
    exec: (cmd, args) => execStep(user, cmd, args),
    ask: async (text) => {
      if (!ai) return { ok: false, error: '没配置 AI' }
      const res = await talkToAI(user, text)
      return { ok: !!res && !res.error && !res.stopped && !res.failed, stopped: !!res?.stopped }
    },
    say, sleep: sleepMs, inventoryCount, isNight, health: () => bot.health, food: () => bot.food,
    isCancelled: () => run !== actionRun || !runtime.isActive(),
  })
  try {
    const result = await runtime.scope(() => runner(wf))
    if (!result.stopped) say(`工作流「${wf.name}」${result.ok ? '做完了' : `没做完：${result.failures.join('；') || result.error}`}`.slice(0, 240))
    return result
  } catch (err) {
    if (err instanceof CancelledError || run !== actionRun) return { ok: false, stopped: true }
    say(`工作流「${wf.name}」出错：${err.message}`)
    return { ok: false, error: err.message }
  } finally {
    console.log(`[workflow] end ${id}`)
    agentEvents.push('workflow', { id, state: 'end' })
    if (workflowActive === id) workflowActive = null
  }
}
commands.run = (user, [id]) => runWorkflow(id, user)
commands.workflows = () => {
  if (!workflows.size) return say('还没有工作流：在 workflows/ 放 .json，写法见 README')
  say([...workflows.values()].map((w) => `${w.id}${w.trigger.on === 'manual' ? '' : `[${w.trigger.on}]`}${w.ai ? '[AI]' : ''}: ${w.description || w.name}`).join('；'))
}
// 自动触发：只在完全空闲时，每种触发看冷却
let lastBusyAt = Date.now()
let workflowWasNight = null
function triggerWorkflows(kind) {
  if (process.env.MC_WORKFLOWS_AUTO === 'off' || workflowActive || !bot.entity) return
  if (runtime.busy() || aiWork || goal || flight?.active() || task || followTarget || post || queue.length) return
  const now = Date.now()
  for (const wf of workflows.values()) {
    if (wf.trigger.on !== kind) continue
    const gap = (kind === 'interval' ? wf.trigger.every : wf.trigger.cooldown) * 1000
    if (now - (workflowRuns.get(wf.id) ?? -Infinity) < gap) continue
    console.log(`[workflow] 自动触发 ${wf.id}（${kind}）`)
    runtime.unscoped(() => runWorkflow(wf.id, null)).catch((err) => console.log('[workflow]', err.message))
    return
  }
}
bot.on('spawn', () => {
  for (const wf of workflows.values()) if (wf.trigger.on === 'interval' && !workflowRuns.has(wf.id)) workflowRuns.set(wf.id, Date.now())
  setTimeout(() => triggerWorkflows('spawn'), 10_000)
})
bot.on('playerJoined', (p) => { if (p?.username !== bot.username) setTimeout(() => triggerWorkflows('playerJoined'), 8000) })
setInterval(() => {
  if (!bot.entity) return
  if (runtime.busy() || aiWork || goal || task || workflowActive) lastBusyAt = Date.now()
  const night = isNight()
  if (workflowWasNight !== null && night !== workflowWasNight) triggerWorkflows(night ? 'night' : 'day')
  workflowWasNight = night
  if (Date.now() - lastBusyAt > 60_000) triggerWorkflows('idle')
  triggerWorkflows('interval')
}, 15_000).unref?.()

// ---- 本机 Agent API（MC_AGENT_PORT + MC_AGENT_TOKEN）----
const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/
const busyReason = () => workflowActive ? `工作流 ${workflowActive}` : goal ? `目标 ${goal.label || goal.text}` : task || (aiWork ? 'AI 思考中' : flight?.active() ? '飞行中' : null)
let agentApi = null
function startAgentApi() {
  if (agentApi || !process.env.MC_AGENT_PORT) return
  try {
    agentApi = createAgentApi({
      port: Number(process.env.MC_AGENT_PORT), host: process.env.MC_AGENT_HOST || '127.0.0.1', token: process.env.MC_AGENT_TOKEN, events: agentEvents,
      handlers: {
        state: () => ({
          username: bot.username, version: bot.version, brand: bot.game?.serverBrand || null, dimension: dimension(),
          position: bot.entity && { x: +bot.entity.position.x.toFixed(1), y: +bot.entity.position.y.toFixed(1), z: +bot.entity.position.z.toFixed(1) },
          health: bot.health, food: bot.food, night: isNight(), busy: busyReason(), queue: queue.length,
          inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
          players: Object.values(bot.players).filter((p) => p.username !== bot.username).map((p) => ({ name: p.username, distance: p.entity ? +p.entity.position.distanceTo(bot.entity.position).toFixed(1) : null })),
          ai: ai ? AI_PROVIDER : EXTERNAL_AGENT ? 'external' : null, mods: mods.active().map((d) => d.id), workflows: [...workflows.keys()],
        }),
        commands: () => ({ ai: [...AI_ACTIONS].sort(), help: HELP, extensions: [...extensionCommands].map(([name, x]) => ({ name, help: x.help, read: x.read, extension: x.id })) }),
        command: async ({ cmd, args, wait, as }) => {
          cmd = String(cmd).toLowerCase()
          if (as !== undefined && (!USERNAME_RE.test(String(as)) || !bot.players[as])) throw Object.assign(new Error('as 必须是在线玩家名'), { status: 400 })
          const user = as || null
          const fn = getCommand(commands, cmd)
          if (!fn) throw Object.assign(new Error(`没有指令 ${cmd.slice(0, 32)}`), { status: 404 })
          const checked = extensionCommands.has(cmd) ? { args: normalizeExtensionArgs(args) } : normalizeAction(cmd, args)
          if (cmd === 'stop' || cmd === 'halt') { runtime.unscoped(() => fn(user, [])); return { ok: true } }
          const reading = readCommands.has(cmd) || !!extensionCommands.get(cmd)?.read
          if (!reading && busyReason()) throw Object.assign(new Error(`机器人正忙（${busyReason()}），先 stop 或等它做完`), { status: 409 })
          currentRequester = user || 'agent'
          console.log(`[agent] cmd=${cmd}`)
          const pending = runtime.scope(() => execStep(user, cmd, checked.args))
          if (!wait) { pending.catch(() => {}); return { accepted: true } }
          return pending
        },
        say: (text) => { runtime.unscoped(() => say(text)); return { ok: true } },
        ask: async (text) => {
          if (!ai) throw Object.assign(new Error(EXTERNAL_AGENT ? '外部 agent 模式没有内置 AI，你就是那个 agent' : '没配置内置 AI'), { status: 400 })
          if (busyReason()) throw Object.assign(new Error(`机器人正忙（${busyReason()}）`), { status: 409 })
          const said = []
          sayLog = said
          let res
          try { res = await runtime.scope(() => instruct(null, text)) } finally { if (sayLog === said) sayLog = null }
          return { ok: !!res && !res.error && !res.stopped, said, log: res?.log || [], goal: goal ? goal.label || goal.text : null }
        },
        stop: () => { runtime.unscoped(() => commands.stop(null, [])); return { ok: true } },
        workflows: () => [...workflows.values()].map(({ id, name, description, ai: open, trigger, size }) => ({ id, name, description, ai: open, trigger, steps: size })),
        runWorkflow: async (id) => {
          if (!workflows.has(id)) throw Object.assign(new Error(`没有工作流 ${id}`), { status: 404 })
          if (busyReason()) throw Object.assign(new Error(`机器人正忙（${busyReason()}）`), { status: 409 })
          return runWorkflow(id, null)
        },
      },
    })
  } catch (err) { console.log(`[agent] ${err.message}`) }
}

function exitForRetry(code) {
  if (exiting) return
  exiting = true
  if (shuttingDown) return process.exit(code)
  if (spawned) { saveFailures(0); return process.exit(code) }
  const failures = (Number(readJSON(RETRY_FILE, {}).failures) || 0) + 1
  saveFailures(failures)
  const wait = Math.min(2 ** (failures - 1) * 15, 300)
  console.log(`[reconnect] 连续第 ${failures} 次没进服，${wait} 秒后退出重试`)
  setTimeout(() => process.exit(code), wait * 1000)
}
const spawnTimer = setTimeout(() => { console.log('[exit] 60 秒未进服'); exitForRetry(1) }, 60_000)
bot.once('spawn', () => { spawned = true; clearTimeout(spawnTimer); saveFailures(0) })
