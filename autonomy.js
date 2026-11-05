// 本地日程（L1）：不调用模型的"现在该做什么"。
// 只产出已有指令，执行仍走 bot.js 的 runTask，动作合法性最终由 security.normalizeAction 校验。
// 这里保持纯函数，方便在测试里穷举状态，不用起 mineflayer。
const { PRIORITIES } = require('./runtime')

// 能直接吃的（避免把生肉、蜘蛛眼当正餐的复杂判定，P0 只认这些）
const FOOD = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
  'baked_potato', 'apple', 'golden_apple', 'carrot', 'melon_slice', 'sweet_berries', 'cooked_cod', 'cooked_salmon',
])

const idle = (why) => ({ cmd: null, args: [], why, idle: true })
const woodCount = (inventory) => Object.entries(inventory)
  .filter(([name]) => name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_planks'))
  .reduce((sum, [, n]) => sum + n, 0)
const hasFood = (inventory) => Object.keys(inventory).some((name) => FOOD.has(name))
const hasPickaxe = (inventory) => Object.keys(inventory).some((name) => name.endsWith('_pickaxe'))

// state: { hp, food, night, distanceToHome, homeName, inventory, nearHostiles, busy }
function chooseAction(state = {}) {
  const {
    hp = 20, food = 20, night = false, distanceToHome = Infinity,
    homeName = '家', inventory = {}, nearHostiles = 0, busy = false,
  } = state

  if (busy) return idle('正在做别的事')
  // 自保由 modes/combat 负责，日程不要在怪旁边抢控制权
  if (nearHostiles > 0) return idle('附近有敌对生物，交给自卫')
  if (hp <= 6) return idle(`血量 ${hp}/20，先别干活`)
  if (food <= 6 && !hasFood(inventory)) return idle(`饱食 ${food}/20 且没有食物`)
  if (food <= 14 && hasFood(inventory)) return { cmd: 'eat', args: [], why: `饱食 ${food}/20 偏低` }
  if (night && Number.isFinite(distanceToHome) && distanceToHome > 16) {
    return { cmd: 'go', args: [homeName], why: '天黑了，回基地' }
  }

  const wood = woodCount(inventory)
  if (wood < 16) return { cmd: 'chop', args: ['16'], why: `木头 ${wood}<16` }
  // 没有镐直接去挖会秒失败（"需要更好的镐"），先做一把木镐
  if (!hasPickaxe(inventory)) return { cmd: 'craft', args: ['wooden_pickaxe', '1'], why: '没有镐，先做木镐' }
  const stone = (inventory.stone || 0) + (inventory.cobblestone || 0)
  if (stone < 32) return { cmd: 'mine', args: ['stone', '32'], why: `石头 ${stone}<32` }
  return idle('日常目标都够了')
}

// director：只在空闲时按预算跑日程，每次动作留一行审计
function createDirector({ getState, run, tickMs = 5000, maxPerHour = 60, log = console.log, now = Date.now } = {}) {
  if (typeof getState !== 'function' || typeof run !== 'function') throw new TypeError('director 需要 getState 和 run')
  let enabled = false
  let running = false
  let timer = null
  const stamps = []
  const strikes = new Map() // 动作 → 连续失败次数
  const cooldowns = new Map() // 动作 → 解禁时间

  function prune() {
    while (stamps.length && stamps[0] <= now() - 3_600_000) stamps.shift()
  }
  function budget() {
    prune()
    return { used: stamps.length, max: maxPerHour, left: Math.max(0, maxPerHour - stamps.length) }
  }

  async function tick() {
    if (!enabled || running) return null
    const state = getState()
    const next = chooseAction(state)
    if (!next.cmd) return null
    if ((cooldowns.get(next.cmd) || 0) > now()) return null
    if (budget().left <= 0) return null
    running = true
    const started = now()
    let result
    try {
      result = await run(next, { priority: PRIORITIES.routine, origin: 'auto' })
    } catch (err) {
      result = { ok: false, error: err.message }
    } finally {
      running = false
      const interrupted = !!(result?.interrupted || result?.preempted || result?.stopped)
      const ok = !interrupted && result?.ok === true
      if (!interrupted) stamps.push(started)
      if (ok) {
        strikes.delete(next.cmd)
        cooldowns.delete(next.cmd)
      } else if (!interrupted) {
        const n = (strikes.get(next.cmd) || 0) + 1
        strikes.set(next.cmd, n)
        // 失败退避：30s、1m、2m… 最多 15 分钟，避免每 2 秒重试同一条并刷屏
        cooldowns.set(next.cmd, now() + Math.min(15 * 60_000, 30_000 * 2 ** (n - 1)))
      }
      const line = JSON.stringify({
        action: next.cmd, args: next.args, why: next.why,
        result: interrupted ? 'interrupted' : ok ? 'ok' : 'fail', ms: now() - started,
        ...(interrupted ? { reason: result?.preempted ? 'preempted' : 'stopped' }
          : ok ? {} : { error: String(result?.error || '动作未返回成功').slice(0, 120), strikes: strikes.get(next.cmd) || 0 }),
      })
      log(`[auto] ${line}`)
    }
    return result
  }

  return {
    start() {
      if (timer) return
      enabled = true
      timer = setInterval(() => { tick().catch((err) => log(`[auto] tick 失败: ${err.message}`)) }, tickMs)
      timer.unref?.()
    },
    stop() {
      enabled = false
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    enabled: () => enabled,
    busy: () => running,
    budget,
  }
}

module.exports = { chooseAction, createDirector, woodCount, hasFood, FOOD }
