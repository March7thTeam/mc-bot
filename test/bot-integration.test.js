// 执行真实 bot.js 的入口与调度代码，所有网络/游戏/存储边界均为替身。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { PRIORITIES } = require('../runtime')
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(setImmediate) }
const cleanup = (t, h, ...waits) => t.after(async () => {
  h.inner('director').stop()
  h.inner('runtime').cancel()
  for (const wait of waits) wait.resolve()
  await flush()
})

function harness({ ask = async () => ({ reply: '', actions: [], done: false }), taskWait, flightWait, routeHook, fastGoalDelays = false, extensions, env = {}, savedGoal, agentApi = false } = {}) {
  const sent = [], marks = [], calls = [], logs = [], movements = []
  const engines = []
  let apiHandlers = null
  const timers = [], intervals = []
  const bot = new EventEmitter()
  const pos = { x: 1, y: 64, z: 2, clone() { return { ...this } } }
  Object.assign(bot, {
    username: 'UnitBot', entity: { position: pos }, entities: {}, players: {}, health: 20, food: 20,
    game: { dimension: 'overworld' },
    registry: { itemsByName: {}, blocksByName: {}, blocksArray: [] }, inventory: { items: () => [] },
    chat: (s) => sent.push(s), loadPlugin() {}, findBlocks: () => [], nearestEntity: () => null,
    pvp: { stop() {}, attack() {} }, hawkEye: { stop() {} }, collectBlock: { cancelTask: async () => {} },
    pathfinder: { setMovements(m) { this.currentMove = m; movements.push(m) }, setGoal(g) { this.goal = g; calls.push(['goal', g]) }, isMoving: () => false, goto: async () => {} },
    stopDigging() {}, clearControlStates() {}, equip: () => calls.push('equip'), quit() {},
    look: async (...args) => calls.push(['look', ...args]), elytraFly: async () => calls.push('glide'),
  })
  class Movements {
    constructor() { this.canDig = true; this.blocksCantBreak = new Set(); this.exclusionAreasPlace = []; this.scafoldingBlocks = []; this.liquids = new Set() }
    getNeighbors() { return [] }
    getBlock() { return {} }
    getMoveForward() {}
  }
  const mods = {
    mineflayer: { createBot: () => bot },
    'mineflayer-pathfinder/lib/move': class {},
    'mineflayer-pathfinder': { pathfinder() {}, Movements, goals: { GoalNear: class {}, GoalFollow: class {} } },
    'mineflayer-collectblock': { plugin() {} }, 'mineflayer-tool': { plugin() {} }, 'mineflayer-pvp': { plugin() {} },
    minecrafthawkeye: { default() {} }, './fabric': { setupFabric() {}, MODDED_BLOCK_ID: 100000 },
    './modes': { createModes: () => ({ list() {}, describe: () => [], set: () => true }) },
    './combat': { createCombat: () => ({ stop() {}, active: () => false, equipWeapon() {} }) },
    './autonomy': { createDirector: (opts) => require('../autonomy').createDirector({ ...opts, log: (line) => logs.push(line) }) },
    './memory': { list: () => [], add() {} },
    './storage': { readJSON: (file, fallback) => savedGoal && file.endsWith('/goal.json') ? savedGoal : fallback, writeJSON() {} }, // 别把测试目标写进真实 data/goal.json
    './ai': { createAI: () => ({ ask: (...args) => { calls.push(['ask', args[0]]); return ask(...args) }, cancel() {}, statistics: () => ({}) }) },
    './skills': { createSkills: (_bot, ctx) => ({
      commands: {
        mark: (u, args) => marks.push([u, ...args]),
        smelt: () => ctx.runTask('test', async () => { await taskWait.promise; bot.equip() }),
        go: (_u, [name], options = {}) => ctx.runTask(`去${name}`, () => ctx.travelTo({ x: 80, y: 64, z: 0 }, { range: 1, ...options })),
      }, places: { 家: { x: 80, y: 64, z: 0, dim: 'overworld' } }, describePlaces: () => '',
    }) },
  }
  if (routeHook) mods['./auto-travel'] = { createAutoTravel: (_bot, ctx) => ({
    travelTo: async (target, options) => { calls.push(['travelTo', target, options]); return routeHook(target, options, ctx) },
    describe: () => '胸槽elytra，烟花16，近路步行/远路核验后飞行', status: () => ({ active: false }),
  }) }
  if (flightWait) mods['./flight'] = { createFlight: (_bot, ctx) => {
    let active = false, phase = 'IDLE'
    const engine = {
      launchSite: () => ({ here: true }),
      async fly(target) { active = true; phase = 'CLIMB'; calls.push(['fly', target, bot.pathfinder.goal]); const result = await flightWait.promise; active = false; phase = 'IDLE'; return result },
      active: () => active, status: () => ({ phase }),
      requestLand() { if (active) phase = 'LANDING' }, dispose() { active = false; phase = 'DISPOSED' },
    }
    engines.push({ engine, ctx })
    return engine
  } }
  const root = path.resolve(__dirname, '..')
  if (agentApi) mods['./agent-api'] = {
    createEventLog: require('../agent-api').createEventLog,
    createAgentApi: ({ handlers }) => { apiHandlers = handlers },
  }
  if (extensions) mods['./mods'] = { createMods: (opts) => require('../mods').createMods({ ...opts, defs: extensions, log: (...a) => logs.push(a.join(' ')) }) }
  const context = vm.createContext({
    require: (name) => mods[name] || (name === 'vec3' || require('node:module').isBuiltin(name) ? require(name) : require(path.resolve(root, name))),
    console: { log: (...args) => logs.push(args.join(' ')) },
    process: { env: { DEEPSEEK_API_KEY: 'unit-test-placeholder', ...(agentApi ? { MC_AGENT_PORT: '25599', MC_AGENT_TOKEN: 'unit-test-token-at-least-24-characters' } : {}), ...env }, on() {}, exit() { throw new Error('unexpected process exit') } },
    setTimeout: (fn, ms) => {
      if (fastGoalDelays && ms === 1000) return setImmediate(fn)
      const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer
    },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true },
    setInterval: (fn, ms) => { const timer = { fn, ms, cancelled: false, unref() {} }; intervals.push(timer); return timer },
    clearInterval: (timer) => { if (timer) timer.cancelled = true }, Date, Promise, Buffer, __dirname: root,
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'bot.js'), 'utf8'), context, { filename: 'bot.js' })
  if (agentApi) vm.runInContext('startAgentApi()', context)
  bot.emit('spawn')
  sent.length = 0
  return { bot, sent, marks, calls, logs, movements, engines, timers, intervals, apiHandlers, readGoal: () => vm.runInContext('goal', context), inner: (name) => vm.runInContext(name, context) }
}

test('真实聊天入口拒绝原型名、保护最终片段，之后合法玩家仍可控制', async () => {
  const h = harness()
  h.bot.emit('chat', 'Anyone', 'bot __proto__')
  await flush()
  h.bot.emit('chat', 'Anyone', 'bot say /op Someone')
  await flush()
  h.bot.emit('chat', 'AnotherPlayer', 'bot say ' + 'x'.repeat(180) + '/op Someone')
  await flush()
  h.bot.emit('chat', 'AnotherPlayer', 'bot mark 家')
  await flush()
  assert.ok(h.sent.some((s) => s.includes('/op')))
  assert.ok(h.sent.every((s) => !s.startsWith('/') && !s.includes('\n')))
  assert.deepEqual(h.marks, [['AnotherPlayer', '家']])
  assert.equal(h.calls.length, 0)
})

test('stop 在模型响应前到达时，真实调度器不执行旧回复或旧动作', async () => {
  const wait = deferred()
  const h = harness({ ask: () => wait.promise })
  h.bot.emit('chat', 'Player', 'bot 帮我记地点')
  await flush()
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  wait.resolve({ reply: 'stale-reply', actions: [{ cmd: 'mark', args: ['旧地点'] }], done: false })
  await flush()
  assert.deepEqual(h.marks, [])
  assert.equal(h.sent.includes('stale-reply'), false)
  h.bot.emit('chat', 'NewPlayer', 'bot mark 新地点')
  await flush()
  assert.deepEqual(h.marks, [['NewPlayer', '新地点']])
})

test('模型替身返回畸形动作不会逃逸异常；真实目标保留发起人', async () => {
  let malformed = true
  const h = harness({ ask: async () => malformed ? { reply: 'invalid', actions: [null] } : { reply: '完成', actions: [{ cmd: 'mark', args: ['基地'] }], done: true } })
  h.bot.emit('chat', 'Player', 'bot hello')
  await flush()
  assert.deepEqual(h.marks, [])
  malformed = false
  h.bot.emit('chat', 'Starter', 'bot goal 记下基地')
  await flush()
  assert.deepEqual(h.marks, [['Starter', '基地']])
  assert.ok(h.calls.some((c) => Array.isArray(c) && c[1] === 'Starter'))
})

test('stop 后旧任务未收尾前拒绝新工作，旧清理不影响后续新任务', async () => {
  const wait = deferred()
  const h = harness({ taskWait: wait })
  h.bot.emit('chat', 'Player', 'bot smelt raw_iron 1')
  await flush()
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  h.bot.emit('chat', 'Player', 'bot mark too_early')
  await flush()
  assert.deepEqual(h.marks, [])
  wait.resolve()
  await flush()
  assert.equal(h.calls.includes('equip'), false)
  h.bot.emit('chat', 'Player', 'bot mark ready')
  await flush()
  assert.deepEqual(h.marks, [['Player', 'ready']])
})

test('嵌套 runTask 只由最外层持有任务名和移动配置', async (t) => {
  const h = harness(), wait = deferred(), run = h.inner('runTask')
  cleanup(t, h, wait)
  const outer = run('outer', async () => { await run('inner', async () => {}); await wait.promise })
  await flush()
  assert.equal(h.inner('task'), 'outer')
  assert.equal(h.inner('runtime').status().name, 'outer')
  assert.equal(h.bot.pathfinder.currentMove.canDig, true)
  assert.equal(h.logs.some((line) => line === '[task] start inner'), false)
  wait.resolve()
  await outer
  assert.equal(h.inner('task'), null)
  assert.equal(h.bot.pathfinder.currentMove.canDig, false)
})

test('自主收尾完成后才开启新玩家任务，旧清理不能切回安全移动', async (t) => {
  const oldWait = deferred(), playerWait = deferred()
  const h = harness({ routeHook: () => playerWait.promise })
  cleanup(t, h, oldWait, playerWait)
  const old = h.inner('runTask')('auto-test', () => oldWait.promise, { priority: PRIORITIES.routine, origin: 'auto' })
  h.bot.emit('chat', 'Player', 'bot goto 10 64 10')
  await flush()
  oldWait.resolve()
  await old
  await flush()
  assert.equal(h.inner('runtime').status().name, '赶路')
  assert.equal(h.inner('task'), '赶路')
  assert.equal(h.bot.pathfinder.currentMove.canDig, true)
  playerWait.resolve({ ok: true, kind: 'travel', transport: 'walk', reached: true, position: { x: 10, y: 64, z: 10 } })
  await flush()
})

for (const command of ['帮我记下位置', 'follow', 'run handoff']) {
  test(`玩家 ${command} 从统一入口抢占自主并真正执行`, async (t) => {
    const wait = deferred()
    const h = harness({ ask: async () => ({ reply: '', actions: [{ cmd: 'mark', args: ['交接'] }], done: true }) })
    cleanup(t, h, wait)
    h.bot.players.Player = { entity: { position: new Vec3(2, 64, 2) } }
    h.inner('workflows').set('handoff', require('../workflows').validate({ id: 'handoff', steps: [{ do: 'mark', args: ['交接'] }] }))
    const old = h.inner('runTask')('auto-test', () => wait.promise, { priority: PRIORITIES.routine, origin: 'auto' })
    h.bot.emit('chat', 'Player', `bot ${command}`)
    await flush()
    assert.deepEqual(h.marks, [])
    wait.resolve()
    await old
    await flush()
    assert.equal(h.sent.some((line) => /上一个任务还在/.test(line)), false)
    if (command === 'follow') {
      assert.equal(h.inner('followTarget'), 'Player')
      assert.equal(h.inner('autonomyState')().busy, true)
    } else assert.deepEqual(h.marks, [['Player', '交接']], JSON.stringify({ sent: h.sent, logs: h.logs, calls: h.calls }))
  })
}

test('并发玩家抢占自主时后到请求入队，stop清队列并取消交接中的所有旧请求', async (t) => {
  const oldWait = deferred(), playerWait = deferred()
  const h = harness({ routeHook: () => playerWait.promise })
  cleanup(t, h, oldWait, playerWait)
  const old = h.inner('runTask')('auto-test', () => oldWait.promise, { priority: PRIORITIES.routine, origin: 'auto' })
  h.bot.emit('chat', 'First', 'bot goto 10 64 10')
  h.bot.emit('chat', 'Second', 'bot mark second')
  await flush()
  assert.equal(h.inner('runtime').generation(), 1)
  oldWait.resolve()
  await old
  await flush()
  assert.equal(h.inner('queue').length, 1)
  assert.deepEqual(h.marks, [])
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  assert.equal(h.inner('queue').length, 0)
  playerWait.resolve({ ok: false, stopped: true })
  await flush()
  assert.deepEqual(h.marks, [])
})

for (const stop of ['stop', 'halt']) {
  test(`交接中 ${stop}：${stop === 'halt' ? '保留' : '取消'}等待玩家，director保持停止`, async (t) => {
    const wait = deferred(), h = harness()
    cleanup(t, h, wait)
    const d = h.inner('director')
    d.start()
    const old = h.inner('runTask')('auto-test', () => wait.promise, { priority: PRIORITIES.routine, origin: 'auto' })
    h.bot.emit('chat', 'Player', 'bot mark handoff')
    await flush()
    h.bot.emit('chat', 'Player', `bot ${stop}`)
    await flush()
    assert.equal(d.enabled(), false)
    wait.resolve()
    await old
    await flush()
    assert.deepEqual(h.marks, stop === 'halt' ? [['Player', 'handoff']] : [])
    assert.equal(h.inner('task'), null)
    assert.equal(h.inner('busyReason')(), null)
  })
}

test('跟随、站岗、进食、睡眠、容器和自卫均阻止日程开工', async () => {
  const h = harness()
  const state = h.inner('autonomyState')
  h.bot.players.Player = { entity: { position: { x: 2, y: 64, z: 2 } } }
  h.bot.emit('chat', 'Player', 'bot follow')
  await flush()
  assert.equal(state().busy, true)
  h.bot.emit('chat', 'Player', 'bot stay')
  await flush()
  assert.equal(state().busy, true)
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  assert.equal(state().busy, false)
  h.inner('eating = true')
  assert.equal(state().busy, true)
  h.inner('eating = false')
  h.bot.currentWindow = {}
  assert.equal(state().busy, true)
  h.bot.currentWindow = null
  h.bot.isSleeping = true
  assert.equal(state().busy, true)
  h.bot.isSleeping = false
  h.inner('combat').active = () => true
  assert.equal(state().busy, true)
})

for (const command of ['stop', 'halt']) {
  test(`启动窗口内 ${command} 会撤销迟到的自主启用定时器`, async () => {
    const h = harness({ env: { MC_AUTONOMY: 'on' } })
    const startup = h.timers.find((timer) => String(timer.fn).includes('director.start()'))
    assert.ok(startup)
    h.bot.emit('chat', 'Player', `bot ${command}`)
    await flush()
    assert.equal(startup.cancelled, true)
    assert.equal(h.inner('director').enabled(), false)
  })
}

test('日程中断写真实审计且不消耗预算，halt后任务名归零', async (t) => {
  const wait = deferred(), h = harness()
  cleanup(t, h, wait)
  h.inner('commands').chop = () => h.inner('runTask')('auto-test', () => wait.promise)
  const d = h.inner('director')
  d.start()
  const action = d.tick()
  await flush()
  h.bot.emit('chat', 'Player', 'bot halt')
  await flush()
  wait.resolve()
  await action
  assert.equal(d.budget().used, 0)
  assert.equal(h.inner('task'), null)
  assert.ok(h.logs.some((line) => /\[auto\].*"result":"interrupted"/.test(line)))
})

test('重启目标恢复窗口优先于日程，stop后旧恢复不会复活', async () => {
  const h = harness({ env: { MC_AUTONOMY: 'on' }, savedGoal: { text: '旧目标', starter: 'Player', startedAt: Date.now() } })
  const d = h.inner('director')
  assert.equal(h.inner('autonomyState')().busy, true)
  d.start()
  assert.equal(await d.tick(), null)
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  h.timers.find((timer) => String(timer.fn).includes('restoringGoal !== g')).fn()
  await flush()
  assert.equal(h.readGoal(), null)
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'ask'), false)
})

test('新的玩家目标会撤销旧的待恢复目标', async (t) => {
  const wait = deferred()
  const h = harness({ ask: () => wait.promise, savedGoal: { text: '旧目标', starter: 'Player', startedAt: Date.now() } })
  cleanup(t, h, wait)
  h.bot.emit('chat', 'Player', 'bot goal 新目标')
  await flush()
  assert.equal(h.inner('restoringGoal'), null)
  h.bot.emit('chat', 'Player', 'bot stop')
  wait.resolve({ reply: '', actions: [], done: true })
  await flush()
})

test('legacy autoThink 的在途模型回复被 halt 失效，玩家AI仍保留', async (t) => {
  const wait = deferred(), h = harness({ ask: () => wait.promise })
  cleanup(t, h, wait)
  h.inner('auto = true; autoOwner = "Player"')
  const thinking = h.inner('autoThink')('空闲')
  await flush()
  assert.equal(h.inner('runtime').status().origin, 'auto')
  h.bot.emit('chat', 'Player', 'bot halt')
  await flush()
  wait.resolve({ reply: '旧自主回复', actions: [{ cmd: 'mark', args: ['不该执行'] }], done: true })
  await thinking
  await flush()
  assert.deepEqual(h.marks, [])
  assert.equal(h.sent.includes('旧自主回复'), false)
  assert.equal(h.sent.some((line) => /自主本来就是关/.test(line)), false)

  const playerWait = deferred(), player = harness({ ask: () => playerWait.promise })
  cleanup(t, player, playerWait)
  player.bot.emit('chat', 'Player', 'bot 记位置')
  await flush()
  player.bot.emit('chat', 'Player', 'bot halt')
  await flush()
  playerWait.resolve({ reply: '', actions: [{ cmd: 'mark', args: ['玩家目标'] }], done: true })
  await flush()
  assert.deepEqual(player.marks, [['Player', '玩家目标']])
})

test('Agent API 的 halt 可越过忙碌门禁，只取消自主而保留玩家任务', async (t) => {
  const wait = deferred(), h = harness({ agentApi: true })
  cleanup(t, h, wait)
  assert.ok(h.apiHandlers)
  h.inner('director').start()
  const auto = h.inner('runTask')('auto-test', () => wait.promise, { priority: PRIORITIES.routine, origin: 'auto' })
  assert.equal((await h.apiHandlers.command({ cmd: 'halt', args: [], wait: true })).ok, true)
  assert.equal(h.inner('director').enabled(), false)
  wait.resolve()
  assert.equal((await auto).stopped, true)

  const playerWait = deferred()
  cleanup(t, h, playerWait)
  const player = h.inner('runTask')('player-test', () => playerWait.promise)
  const generation = h.inner('runtime').generation()
  assert.equal((await h.apiHandlers.command({ cmd: 'halt', args: [], wait: true })).ok, true)
  assert.equal(h.inner('runtime').generation(), generation)
  playerWait.resolve()
  assert.equal((await player).ok, true)
})

test('聊天交接已收尾但尚未派发的微任务间隙 stop 仍能取消旧请求', async (t) => {
  const wait = deferred(), h = harness(), runtime = h.inner('runtime')
  cleanup(t, h, wait)
  const old = runtime.runTask('auto-test', () => wait.promise, { priority: PRIORITIES.routine, origin: 'auto' })
  const stop = () => h.inner('stopAll')('stop')
  old.then(stop, stop)
  h.bot.emit('chat', 'Player', 'bot mark 不该执行')
  await flush()
  wait.resolve()
  await old.catch(() => {})
  await flush()
  assert.deepEqual(h.marks, [])
})

test('halt 自主飞行后仍持锁降落，玩家交接等确认落地后再执行', async (t) => {
  const wait = deferred(), h = harness({ flightWait: wait })
  cleanup(t, h, wait)
  const auto = h.inner('runTask')('auto-flight', () => h.inner('commands').fly(null, ['家']), { priority: PRIORITIES.routine, origin: 'auto', safe: true })
  await flush()
  h.bot.emit('chat', 'Player', 'bot halt')
  await flush()
  assert.equal(h.engines.at(-1).engine.status().phase, 'LANDING')
  h.bot.emit('chat', 'Player', 'bot mark 落地以后')
  await flush()
  assert.deepEqual(h.marks, [])
  assert.equal(h.inner('runtime').busy(), true)
  wait.resolve({ ok: false, reached: false, landed: true, position: { x: 10, y: 64, z: 0 }, reason: 'halt', rocketsUsed: 1 })
  assert.equal((await auto).stopped, true)
  await flush()
  assert.deepEqual(h.marks, [['Player', '落地以后']])
})

test('legacy 自主 AI 复用同一owner执行任务和工作流时不等待自身空闲', async (t) => {
  const h = harness({
    ask: async () => ({ reply: '', actions: [{ cmd: 'goto', args: ['10', '64', '10'] }, { cmd: 'run', args: ['nested'] }], done: true }),
    routeHook: async (target) => ({ ok: true, kind: 'travel', transport: 'walk', reached: true, position: target }),
  })
  cleanup(t, h)
  h.inner('workflows').set('nested', require('../workflows').validate({ id: 'nested', ai: true, steps: [{ do: 'mark', args: ['完成'] }] }))
  h.inner('auto = true; autoOwner = "Player"')
  const thinking = h.inner('autoThink')('空闲')
  await flush()
  assert.deepEqual(h.marks, [['Player', '完成']])
  assert.equal(h.inner('runtime').busy(), false)
  await thinking
})

for (const autonomous of [true, false]) {
  test(`${autonomous ? '自主' : '玩家'}工作流执行任务时，玩家新指令${autonomous ? '抢占' : '排队'}`, async (t) => {
    const wait = deferred()
    const h = harness({ taskWait: wait, ask: async () => ({ reply: '', actions: [{ cmd: 'run', args: ['yielding'] }], done: true }) })
    cleanup(t, h, wait)
    h.inner('workflows').set('yielding', require('../workflows').validate({ id: 'yielding', ai: true, steps: [{ do: 'smelt', args: ['raw_iron', '1'] }] }))
    let thinking
    if (autonomous) {
      h.inner('auto = true; autoOwner = "Player"')
      thinking = h.inner('autoThink')('空闲')
    } else h.bot.emit('chat', 'Player', 'bot run yielding')
    await flush()
    assert.equal(h.inner('workflowActive'), 'yielding')
    assert.equal(h.inner('runtime').status().origin, autonomous ? 'auto' : 'player')
    h.bot.emit('chat', 'Player', 'bot mark 玩家请求')
    await flush()
    assert.equal(h.inner('runtime').generation(), autonomous ? 1 : 0)
    assert.equal(h.inner('queue').length, autonomous ? 0 : 1)
    wait.resolve()
    if (thinking) await thinking
    await flush()
    if (!autonomous) {
      h.intervals.find((timer) => String(timer.fn).includes('queue.shift()')).fn()
      await flush()
    }
    assert.deepEqual(h.marks, [['Player', '玩家请求']])
    assert.equal(h.calls.includes('equip'), !autonomous)
  })
}

for (const autonomous of [true, false]) {
  test(`${autonomous ? '自主' : '玩家'} AI 等待模型时，玩家新指令${autonomous ? '抢占且废弃旧响应' : '排队保留原响应'}`, async (t) => {
    const wait = deferred(), h = harness({ ask: () => wait.promise })
    cleanup(t, h, wait)
    let thinking
    if (autonomous) {
      h.inner('auto = true; autoOwner = "Player"')
      thinking = h.inner('autoThink')('空闲')
    } else h.bot.emit('chat', 'Player', 'bot 帮我记位置')
    await flush()
    assert.equal(h.inner('aiWork'), true)
    h.bot.emit('chat', 'Player', 'bot mark 新玩家请求')
    await flush()
    assert.equal(h.inner('runtime').generation(), autonomous ? 1 : 0)
    assert.equal(h.inner('queue').length, autonomous ? 0 : 1)
    wait.resolve({ reply: '', actions: [{ cmd: 'mark', args: ['原响应'] }], done: true })
    if (thinking) await thinking
    await flush()
    if (!autonomous) {
      h.intervals.find((timer) => String(timer.fn).includes('queue.shift()')).fn()
      await flush()
    }
    assert.deepEqual(h.marks, autonomous ? [['Player', '新玩家请求']] : [['Player', '原响应'], ['Player', '新玩家请求']])
  })
}

test('真实fly入口清除旧跟随目标，停止后持锁降落，旧实例不能借新降落权限', async () => {
  const wait = deferred(), h = harness({ flightWait: wait })
  h.bot.pathfinder.goal = { staleFollow: true }
  h.bot.emit('chat', 'Player', 'bot fly 家')
  await flush()
  const call = h.calls.find((c) => Array.isArray(c) && c[0] === 'fly')
  assert.deepEqual(JSON.parse(JSON.stringify(call[1])), { x: 80, y: 64, z: 0 })
  assert.equal(call[2], null)
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  h.bot.emit('chat', 'Player', 'bot mark premature')
  await flush()
  assert.deepEqual(h.marks, [])
  await h.engines[0].ctx.safetyLook(1, 1)
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'look').length, 0)
  await h.engines.at(-1).ctx.safetyLook(1, 1)
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'look').length, 1)
  wait.resolve({ ok: false, reached: false, landed: true, position: { x: 10, y: 64, z: 0 }, reason: 'stop', rocketsUsed: 1 })
  await flush()
  assert.ok(h.sent.some((s) => /落地前/.test(s)))
  assert.equal(h.sent.some((s) => /已飞抵/.test(s)), false)
  h.bot.emit('chat', 'Player', 'bot mark after_landing')
  await flush()
  assert.deepEqual(h.marks, [['Player', 'after_landing']])
})

test('AI goto与命名go/come共用自动交通，walk明确保留步行偏好', async () => {
  const hook = async (target, options) => ({ kind: 'travel', ok: true, reached: true, target, position: target,
    transport: options.mode === 'walk' ? 'walk' : 'fly', modeChosen: 'fly', reason: 'test', rocketsUsed: 1 })
  const h = harness({ ask: async () => ({ reply: '去目的地', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }], done: true }), routeHook: hook })
  h.bot.emit('chat', 'Player', 'bot 带我去远处')
  await flush()
  const first = h.calls.find((c) => Array.isArray(c) && c[0] === 'travelTo')
  assert.deepEqual(JSON.parse(JSON.stringify(first.slice(1))), [{ x: 300, y: 64, z: 0 }, { range: 1 }])
  h.bot.emit('chat', 'Player', 'bot go 家'); await flush()
  h.bot.players.Player = { entity: { position: { x: 180, y: 64, z: 0 } } }
  h.bot.emit('chat', 'Player', 'bot come'); await flush()
  const all = h.calls.filter((c) => Array.isArray(c) && c[0] === 'travelTo')
  assert.equal(all[1][1].x, 80)
  assert.equal(all[2][2].range, 2)
  h.bot.emit('chat', 'Player', 'bot walk 家'); await flush()
  const walking = h.calls.filter((c) => Array.isArray(c) && c[0] === 'travelTo').at(-1)
  assert.equal(walking[2].mode, 'walk')
})

test('交通已经降级步行成功时，不因聊天包含失败字样重规划或阻断后续AI动作', async () => {
  const h = harness({ ask: async () => ({ reply: '过去看看', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }, { cmd: 'mark', args: ['已到'] }], done: true }),
    routeHook: async (target, _options, ctx) => {
      ctx.say('起飞预检失败，已用步行到达')
      return { kind: 'travel', ok: true, reached: true, target, position: target, transport: 'walk', reason: 'long_distance', fallbackReason: 'launch_blocked', rocketsUsed: 0 }
    } })
  h.bot.emit('chat', 'Player', 'bot 去远处并记下位置')
  await flush()
  assert.deepEqual(h.marks, [['Player', '已到']])
  assert.equal(h.calls.filter((c) => Array.isArray(c) && c[0] === 'ask').length, 1)
})

test('AI不能先equip鞘翅绕过自动赶路胸甲保护，玩家显式装备仍可使用', async () => {
  const h = harness({ ask: async () => ({ reply: '过去', actions: [{ cmd: 'equip', args: ['elytra'] }, { cmd: 'goto', args: ['300', '64', '0'] }], done: false }),
    routeHook: async () => { throw new Error('不能越过装备保护') } })
  h.bot.inventory.slots = []
  h.bot.inventory.slots[6] = { name: 'iron_chestplate' }
  h.bot.emit('chat', 'Player', 'bot 去远处')
  await flush()
  assert.equal(h.calls.includes('equip'), false)
  assert.equal(h.calls.some((c) => Array.isArray(c) && c[0] === 'travelTo'), false)
  assert.equal(h.bot.inventory.slots[6].name, 'iron_chestplate')
})

test('长期目标连续两轮交通失败被计入失败记忆', async () => {
  const waiting = deferred()
  let requests = 0
  const h = harness({ fastGoalDelays: true, ask: async () => ++requests > 2 ? waiting.promise : { reply: '', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }], done: false },
    routeHook: async (target) => ({ kind: 'travel', ok: false, reached: false, target, position: { x: 1, y: 64, z: 2 }, transport: 'walk', reason: 'NoPath', rocketsUsed: 0 }) })
  h.bot.emit('chat', 'Player', 'bot goal 去远处坐标')
  const deadline = Date.now() + 5000
  while (requests < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.readGoal()?.failures['goto 300 64 0'], 2)
  h.bot.emit('chat', 'Player', 'bot stop')
  waiting.resolve({ reply: '', actions: [], done: false })
  await flush()
})

test('显式walk失败不自动交给AI改成飞行', async () => {
  const h = harness({ ask: async () => { throw new Error('不该改成AI交通') },
    routeHook: async (target) => ({ kind: 'travel', ok: false, reached: false, target, position: target, transport: 'walk', reason: 'NoPath', rocketsUsed: 0 }) })
  h.bot.emit('chat', 'Player', 'bot walk 300 64 0')
  await flush()
  assert.equal(h.calls.some((c) => Array.isArray(c) && c[0] === 'ask'), false)
})

test('玩家明确不要飞时，AI误给goto也保持步行偏好', async () => {
  const h = harness({ ask: async () => ({ reply: '过去', actions: [{ cmd: 'goto', args: ['300', '64', '0'] }], done: true }),
    routeHook: async (target, options) => ({ kind: 'travel', ok: true, reached: true, target, position: target, transport: options.mode, reason: 'forced_walk', rocketsUsed: 0 }) })
  h.bot.emit('chat', 'Player', 'bot 全程步行去远处，不要飞')
  await flush()
  const route = h.calls.find((c) => Array.isArray(c) && c[0] === 'travelTo')
  assert.equal(route[2].mode, 'walk')
})

test('私聊来的查询指令私聊回，公屏来的仍回公屏；私聊不能借回复发别的命令', async () => {
  const h = harness()
  h.bot.emit('whisper', 'Asker', 'pos')
  await flush()
  assert.ok(h.sent.length > 0 && h.sent.every((s) => s.startsWith('/msg Asker 我在')), h.sent.join(' | '))
  h.sent.length = 0
  h.bot.emit('chat', 'Asker', 'bot pos')
  await flush()
  assert.ok(h.sent.length > 0 && h.sent.every((s) => s.startsWith('我在')), h.sent.join(' | '))
  h.sent.length = 0
  h.bot.emit('whisper', 'Asker', 'say /op Asker')
  await flush()
  assert.ok(h.sent.every((s) => !s.startsWith('/')), h.sent.join(' | '))
})

test('水里：站在坑底可以挖出去，浮在深水里仍不许挖放', () => {
  const h = harness()
  const floatInWater = h.inner('floatInWater')
  const water = { liquid: true, physical: false }, air = { liquid: false, physical: false }, dirt = { liquid: false, physical: true }
  const make = (below) => {
    const moves = { liquids: new Set(), getNeighbors: () => [{ x: 1, y: 63, z: 0, toBreak: [{}], toPlace: [] }, { x: 1, y: 62, z: 0, toBreak: [], toPlace: [] }],
      getBlock: (_n, _dx, dy) => (dy === -1 ? below : dy === 0 ? water : air) }
    floatInWater(moves)
    return moves.getNeighbors({ x: 0, y: 62, z: 0 }).length
  }
  assert.equal(make(dirt), 2) // 1x1 水坑：出路要挖
  assert.equal(make(water), 1) // 深水浮着：只留不用挖放的
})

test('模组扩展指令：玩家能用、AI 用不了、不能抢已有指令名、参数有边界', async () => {
  const { validate } = require('../mods')
  const runs = []
  const ext = validate({
    id: 'demo', activate: 'always', prompt: '本服有演示扩展',
    setup(api) {
      api.command('hello', { help: '打个招呼', read: true, run: (user, args) => { runs.push(['hello', user, ...args]); api.say(`你好 ${user}`) } })
      api.command('ping', { run: async (user) => { runs.push(['ping', user]) } })
      api.command('stop', { run: () => runs.push(['evil-stop']) })
    },
  }, { code: true })
  const h = harness({ extensions: [ext] })
  h.bot.emit('login')
  await flush()
  assert.ok(h.logs.some((l) => /setup 出错: 指令 stop 已经存在/.test(l)))
  h.bot.emit('chat', 'Player', 'bot hello 世界')
  await flush()
  assert.deepEqual(runs.shift(), ['hello', 'Player', '世界'])
  assert.ok(h.sent.some((s) => s.includes('你好 Player')))
  h.bot.emit('chat', 'Player', 'bot ping')
  await flush()
  assert.deepEqual(runs.shift(), ['ping', 'Player'])
  assert.ok(h.logs.some((l) => /\[task\] start ping（demo）/.test(l)), '干活类扩展指令走 runTask')
  h.sent.length = 0
  h.bot.emit('chat', 'Player', 'bot hello ' + 'x'.repeat(65))
  await flush()
  assert.equal(runs.length, 0, '超长参数不交给扩展')
  h.bot.emit('chat', 'Player', 'bot stop')
  await flush()
  assert.equal(runs.length, 0, 'stop 仍是内置指令')
  assert.ok(!require('../security').AI_ACTIONS.has('hello'))
  assert.equal(h.inner('mods').promptNotes(), '本服有演示扩展')
})
