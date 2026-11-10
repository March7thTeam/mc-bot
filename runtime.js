// 取消只阻止后续副作用；已经发给服务器的操作无法撤回。
const { AsyncLocalStorage } = require('node:async_hooks')

class CancelledError extends Error {
  constructor(message = '任务已取消', code = 'cancelled') { super(message); this.name = 'CancelledError'; this.code = code }
}

// 低优先级任务顶不掉高优先级：调用方拿到这个错误就知道是"忙"，不是"失败"
class BusyError extends Error {
  constructor(name, priority) {
    super(`正在收尾或执行 ${name}，请稍等`)
    this.name = 'BusyError'
    this.code = 'BUSY'
    this.priority = priority
  }
}

// 数字越大越优先。日程 10 / 项目 20 / 自保 30 / 玩家 40
const PRIORITIES = Object.freeze({ idle: 0, routine: 10, project: 20, survival: 30, player: 40 })

function createRuntime({ timeoutMs = 180_000, onTimeout = () => {}, onPreempt = () => {} } = {}) {
  const storage = new AsyncLocalStorage()
  let epoch = 0
  let worldEpoch = 0
  let controller = new AbortController()
  let pending = null
  let serial = 0
  let cancelRevision = 0
  let lastCancelCode = 'cancelled'
  // 取消原因按代际记：调用方拿自己开始时的 epoch 来问，才知道是"被抢占"还是"被停止"
  const cancelCodes = new Map()
  const isActive = () => {
    const s = storage.getStore()
    return !s || (s.epoch === epoch && !s.signal.aborted)
  }
  const assertActive = () => {
    if (!isActive()) throw storage.getStore()?.signal.reason || new CancelledError()
  }
  const unscoped = (fn) => storage.run(undefined, fn)
  const scope = (fn) => storage.run(storage.getStore() || { epoch, worldEpoch, signal: controller.signal }, fn)
  const cancel = (reason = '任务已取消', code = 'cancelled') => {
    if (code === 'dimension_changed') worldEpoch++
    // halt 只撤销自主动作，不撤销已收到的玩家交接请求。
    if (code !== 'preempted' && code !== 'halt') { cancelRevision++; lastCancelCode = code }
    cancelCodes.set(epoch, code)
    if (cancelCodes.size > 64) cancelCodes.delete(Math.min(...cancelCodes.keys()))
    controller.abort(new CancelledError(reason, code))
    epoch++
    controller = new AbortController()
  }
  const delay = (ms) => {
    assertActive()
    const signal = storage.getStore()?.signal
    return new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(done, ms)
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason || new CancelledError()) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  const assertRequestActive = (revision) => {
    if (revision !== cancelRevision) throw new CancelledError('任务已取消', lastCancelCode)
  }
  // 所有玩家入口先等自主任务收尾；停止/超时是独立屏障，不能被先前的抢占代际掩盖。
  async function preempt(priority) {
    assertActive()
    const revision = cancelRevision
    while (pending) {
      assertRequestActive(revision)
      if (priority <= pending.priority || pending.cancelRevision !== cancelRevision) throw new BusyError(pending.name, pending.priority)
      const victim = pending
      // 多位玩家等待同一任务时只取消一次，不能让后来的等待者再污染新代际。
      if (!victim.preempted && victim.epoch === epoch) {
        victim.preempted = true
        cancel('被更高优先级任务抢占', 'preempted')
        unscoped(() => onPreempt(victim))
      }
      await victim.settled
    }
    assertRequestActive(revision)
    return revision
  }
  async function runTask(name, fn, options = {}) {
    const { maxMs = timeoutMs, priority = PRIORITIES.routine, origin = null } =
      typeof options === 'number' ? { maxMs: options } : options
    assertActive()
    // 同一任务内部再调 runTask（指令互相复用）不该当成新任务抢自己
    const store = storage.getStore()
    if (pending && store?.owner === pending) return await fn()
    if (pending) {
      const revision = await preempt(priority)
      assertRequestActive(revision) // await 返回的微任务间隙也可能收到 stop。
    }
    // 多个抢占者同时醒来时仍要互斥；不能覆盖先醒来的玩家任务。
    if (pending) throw new BusyError(pending.name, pending.priority)
    const token = { id: ++serial, name, priority, origin, epoch, cancelRevision, startedAt: Date.now(), preempted: false }
    token.settled = new Promise((resolve) => { token.settle = resolve })
    pending = token
    const timer = setTimeout(() => unscoped(() => {
      if (pending !== token) return
      cancel('任务超时', 'timeout')
      onTimeout(token)
    }), maxMs)
    try {
      const signal = controller.signal
      return await storage.run({ epoch: token.epoch, worldEpoch, signal, owner: token }, async () => { const result = await fn(); assertActive(); return result })
    } finally {
      clearTimeout(timer)
      if (pending === token) pending = null
      token.settle()
    }
  }
  function guard(target, names) {
    for (const name of names) {
      if (typeof target?.[name] !== 'function') continue
      const original = target[name]
      target[name] = function (...args) { assertActive(); return original.apply(this, args) }
    }
  }
  function scopePathfinder(inject) {
    return function (bot, options) {
      const on = bot.on
      // The plugin plans from an unscoped physics tick and may equip before it digs or places.
      bot.on = function (event, listener) {
        if (event !== 'physicsTick') return on.call(this, event, listener)
        return on.call(this, event, function (...args) {
          return storage.run({ epoch, worldEpoch, signal: controller.signal, pathfinderTick: true }, () => listener.apply(this, args))
        })
      }
      try { return inject(bot, options) } finally { bot.on = on }
    }
  }
  function guardResource(bot, result, openedWorld) {
    // A late open can resolve with the next level's window. Do not touch it.
    if (openedWorld !== worldEpoch) throw new CancelledError('维度变化，旧容器操作已取消', 'dimension_changed')
    const close = result?.close
    if (typeof close === 'function') result.close = function (...args) {
      if (openedWorld === worldEpoch && (!('currentWindow' in bot) || bot.currentWindow === result)) return close.apply(this, args)
    }
    if (!isActive()) { result?.close?.(); assertActive() }
    guard(result, ['putFuel', 'putInput', 'takeOutput', 'takeInput', 'takeFuel', 'deposit', 'withdraw'])
    return result
  }
  function guardBot(bot) {
    // Mineflayer 的容器/合成实现会直接调用内部闭包，再写协议包；
    // 只拦 bot.clickWindow 等公开方法无法覆盖这些 await 后的续操作。
    if (typeof bot._client?.write === 'function') {
      const original = bot._client.write
      const cleanup = new Set(['close_window', 'keep_alive', 'pong', 'teleport_confirm'])
      bot._client.write = function (name, ...args) {
        // 某些库调用 fire-and-forget activateBlock；这里抛错会成为未处理拒绝。
        // 丢弃旧上下文的包，外层任务通过取消检查/库的有界等待收尾。
        const scope = storage.getStore()
        if (name === 'close_window' && scope && scope.worldEpoch !== worldEpoch) return
        if (!cleanup.has(name) && !isActive()) return
        return original.call(this, name, ...args)
      }
    }
    guard(bot, ['craft', 'toss', 'tossStack', 'consume', 'sleep',
      'attack', 'activateItem', 'elytraFly', 'clickWindow', 'transfer', 'moveSlotItem'])
    for (const name of ['equip', 'placeBlock', 'dig', 'activateBlock']) {
      const original = bot[name]
      if (typeof original !== 'function') continue
      bot[name] = function (...args) {
        // Let the plugin clear its in-flight bookkeeping without touching the world.
        if (storage.getStore()?.pathfinderTick && !isActive()) return Promise.resolve()
        // Other library call sites can fire-and-forget activateBlock; the packet guard handles them.
        if (name !== 'activateBlock') assertActive()
        return original.apply(this, args)
      }
    }
    // Local movement flags can outlive the old promise and drive the new world's physics.
    for (const name of ['setControlState', 'clearControlStates', 'look', 'lookAt', 'stopDigging']) {
      const original = bot[name]
      if (typeof original !== 'function') continue
      bot[name] = function (...args) {
        const scope = storage.getStore()
        if (!scope || (scope.worldEpoch === worldEpoch && (!scope.pathfinderTick || isActive()))) return original.apply(this, args)
        if (name === 'look' || name === 'lookAt') return Promise.resolve()
      }
    }
    guard(bot.pathfinder, ['goto', 'setGoal', 'setMovements'])
    guard(bot.collectBlock, ['collect'])
    guard(bot.pvp, ['attack'])
    guard(bot.hawkEye, ['oneShot', 'autoAttack'])
    if (typeof bot.closeWindow === 'function') {
      const close = bot.closeWindow
      bot.closeWindow = function (...args) {
        const scope = storage.getStore()
        if (!scope || scope.worldEpoch === worldEpoch) return close.apply(this, args)
      }
    }
    for (const name of ['openContainer', 'openFurnace']) {
      const original = bot[name]
      if (!original) continue
      bot[name] = function (...args) {
        assertActive()
        const openedWorld = worldEpoch
        return Promise.resolve(original.apply(this, args)).then((result) => guardResource(bot, result, openedWorld))
      }
    }
  }
  return { scope, unscoped, assertActive, isActive, cancel, delay, runTask, preempt, assertRequestActive, guardBot, scopePathfinder,
    ownsTask: () => !!pending && storage.getStore()?.owner === pending,
    busy: () => !!pending, generation: () => epoch,
    cancelCode: (gen) => cancelCodes.get(gen),
    signal: () => storage.getStore()?.signal || controller.signal,
    status: () => pending ? { ...pending, cancelling: pending.epoch !== epoch } : null }
}

module.exports = { createRuntime, CancelledError, BusyError, PRIORITIES }
