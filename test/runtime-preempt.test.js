const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRuntime, CancelledError, BusyError, PRIORITIES } = require('../runtime')
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('高优先级抢占低优先级：低优先级收到 CancelledError，原因记为 preempted', async () => {
  const runtime = createRuntime()
  const gen = runtime.generation()
  let interrupted = null
  const low = runtime.runTask('mine', async () => {
    try {
      await runtime.delay(5000)
    } catch (err) {
      interrupted = err
      throw err
    }
  }, { priority: PRIORITIES.routine })
  await tick()
  assert.equal(runtime.busy(), true)

  const high = runtime.runTask('come', async () => 'done', { priority: PRIORITIES.player })
  assert.equal(await high, 'done')
  await assert.rejects(low, CancelledError)
  assert.ok(interrupted instanceof CancelledError)
  assert.equal(runtime.cancelCode(gen), 'preempted')
  assert.equal(runtime.busy(), false)
})

test('低优先级不能顶掉正在执行的高优先级，拿到 BUSY', async () => {
  const runtime = createRuntime()
  const high = runtime.runTask('come', () => runtime.delay(150), { priority: PRIORITIES.player })
  await tick()
  await assert.rejects(runtime.runTask('idle', async () => {}, { priority: PRIORITIES.idle }), (err) => {
    assert.ok(err instanceof BusyError)
    assert.equal(err.code, 'BUSY')
    assert.match(err.message, /收尾|执行/)
    return true
  })
  await high
})

test('同优先级仍然互斥，不抢占', async () => {
  const runtime = createRuntime()
  const first = runtime.runTask('a', () => runtime.delay(120), { priority: PRIORITIES.routine })
  await tick()
  await assert.rejects(runtime.runTask('b', async () => {}, { priority: PRIORITIES.routine }), BusyError)
  await first
})

test('抢占后高优先级正常结束，低优先级才能再进来', async () => {
  const runtime = createRuntime()
  const order = []
  const low = runtime.runTask('mine', async () => {
    try { await runtime.delay(5000) } catch (err) { order.push('preempted'); throw err }
  }, { priority: PRIORITIES.routine }).catch(() => {})
  await tick()
  await runtime.runTask('come', async () => { order.push('come') }, { priority: PRIORITIES.player })
  await low
  assert.deepEqual(order, ['preempted', 'come'])
  assert.equal(runtime.busy(), false)
})

test('数字超时参数保持兼容', async () => {
  const runtime = createRuntime()
  assert.equal(await runtime.runTask('old-style', async () => 42, 1000), 42)
})

test('玩家 stop 与抢占的取消原因区分开', async () => {
  const runtime = createRuntime()
  const gen = runtime.generation()
  const task = runtime.runTask('mine', () => runtime.delay(5000), { priority: PRIORITIES.routine })
  await tick()
  runtime.cancel('停下了', 'stop')
  await assert.rejects(task, CancelledError)
  assert.equal(runtime.cancelCode(gen), 'stop')
})

for (const reason of ['stop', 'timeout']) {
  test(`抢占收尾中收到 ${reason}，所有等候者都取消且不启动`, async () => {
    const runtime = createRuntime()
    const wait = deferred()
    const starts = []
    const low = runtime.runTask('auto', () => wait.promise, { priority: PRIORITIES.routine }).catch((err) => err)
    const first = runtime.runTask('first', async () => starts.push('first'), { priority: PRIORITIES.player }).catch((err) => err)
    const second = runtime.runTask('second', async () => starts.push('second'), { priority: PRIORITIES.player }).catch((err) => err)
    assert.equal(runtime.generation(), 1, '同一个受害任务只能抢占一次')
    runtime.cancel('停止', reason)
    wait.resolve()
    assert.ok(await low instanceof CancelledError)
    for (const request of [first, second]) {
      const err = await request
      assert.ok(err instanceof CancelledError)
      assert.equal(err.code, reason)
    }
    assert.deepEqual(starts, [])
    assert.equal(runtime.busy(), false)
  })
}

test('halt 取消自主动作但保留已等待的玩家交接请求', async () => {
  const runtime = createRuntime()
  const wait = deferred()
  const low = runtime.runTask('auto', () => wait.promise, { priority: PRIORITIES.routine }).catch(() => {})
  const player = runtime.runTask('player', async () => 'player ran', { priority: PRIORITIES.player })
  runtime.cancel('只停自主', 'halt')
  wait.resolve()
  await low
  assert.equal(await player, 'player ran')
})

test('并发抢占只取消一个代际、只放行一个玩家，后继玩家不覆盖持锁者', async () => {
  let preempts = 0
  const runtime = createRuntime({ onPreempt: () => preempts++ })
  const lowWait = deferred(), highWait = deferred()
  const low = runtime.runTask('auto', () => lowWait.promise, { priority: PRIORITIES.routine }).catch(() => {})
  const first = runtime.runTask('first', () => highWait.promise, { priority: PRIORITIES.player })
  const second = runtime.runTask('second', async () => {}, { priority: PRIORITIES.player }).catch((err) => err)
  lowWait.resolve()
  await low
  await tick(0)
  assert.equal(runtime.status().name, 'first')
  assert.ok(await second instanceof BusyError)
  assert.equal(preempts, 1)
  assert.equal(runtime.generation(), 1)
  highWait.resolve()
  await first
})

test('已被 stop 取消的任务不能再次被高优先级抢占后复活', async () => {
  const runtime = createRuntime()
  const wait = deferred()
  const low = runtime.runTask('auto', () => wait.promise, { priority: PRIORITIES.routine }).catch(() => {})
  runtime.cancel('停止', 'stop')
  await assert.rejects(runtime.runTask('player', async () => {}, { priority: PRIORITIES.player }), BusyError)
  wait.resolve()
  await low
})

test('抢占已收尾但调用者尚未恢复的微任务间隙收到 stop 也不能启动', async () => {
  const wait = deferred()
  let started = false
  const runtime = createRuntime({
    onPreempt: (victim) => { victim.settled.then(() => queueMicrotask(() => runtime.cancel('停止', 'stop'))) },
  })
  const low = runtime.runTask('auto', () => wait.promise, { priority: PRIORITIES.routine }).catch(() => {})
  const player = runtime.runTask('player', async () => { started = true }, { priority: PRIORITIES.player }).catch((err) => err)
  wait.resolve()
  await low
  const err = await player
  assert.ok(err instanceof CancelledError)
  assert.equal(err.code, 'stop')
  assert.equal(started, false)
})
