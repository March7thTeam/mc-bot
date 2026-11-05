const { test } = require('node:test')
const assert = require('node:assert/strict')
const { chooseAction, createDirector } = require('../autonomy')
const { PRIORITIES } = require('../runtime')

const base = { hp: 20, food: 20, night: false, distanceToHome: 0, homeName: '家', inventory: { oak_log: 16, stone: 32, wooden_pickaxe: 1 }, nearHostiles: 0, busy: false }

test('食物偏低且有吃的就去吃', () => {
  const next = chooseAction({ ...base, food: 10, inventory: { bread: 2 } })
  assert.equal(next.cmd, 'eat')
  assert.match(next.why, /饱食/)
})

test('没食物时不空转 eat，交给待机', () => {
  const next = chooseAction({ ...base, food: 5, inventory: { stone: 40 } })
  assert.equal(next.cmd, null)
  assert.match(next.why, /没有食物/)
})

test('天黑且离家超过 16 格就回家', () => {
  const next = chooseAction({ ...base, night: true, distanceToHome: 80 })
  assert.deepEqual(next.args, ['家'])
  assert.equal(next.cmd, 'go')
})

test('天亮在基地附近不回家', () => {
  const next = chooseAction({ ...base, night: true, distanceToHome: 4, inventory: { oak_log: 4 } })
  assert.equal(next.cmd, 'chop')
})

test('木头不足 16 去砍，含木板和原木', () => {
  assert.equal(chooseAction({ ...base, inventory: { oak_log: 12, oak_planks: 4, wooden_pickaxe: 1 } }).cmd, 'mine') // 正好 16，够用
  const next = chooseAction({ ...base, inventory: { oak_log: 10 } })
  assert.deepEqual(next, { cmd: 'chop', args: ['16'], why: '木头 10<16' })
})

test('有木头没镐先做木镐', () => {
  const next = chooseAction({ ...base, inventory: { oak_log: 16, stone: 0 } })
  assert.equal(next.cmd, 'craft')
  assert.deepEqual(next.args, ['wooden_pickaxe', '1'])
})

test('石头不足 32 去挖', () => {
  const next = chooseAction({ ...base, inventory: { oak_log: 16, cobblestone: 7, wooden_pickaxe: 1 } })
  assert.equal(next.cmd, 'mine')
  assert.deepEqual(next.args, ['stone', '32'])
})

test('阈值都满足就待机，不随机游走', () => {
  const next = chooseAction(base)
  assert.equal(next.cmd, null)
  assert.equal(next.idle, true)
})

test('忙、附近有怪、低血都不抢控制权', () => {
  assert.equal(chooseAction({ ...base, busy: true }).cmd, null)
  assert.equal(chooseAction({ ...base, nearHostiles: 2 }).cmd, null)
  assert.match(chooseAction({ ...base, hp: 4 }).why, /血量/)
})

test('director 未启动时不动作', async () => {
  let calls = 0
  const d = createDirector({ getState: () => ({ ...base, inventory: {} }), run: async () => { calls++ } })
  assert.equal(await d.tick(), null)
  assert.equal(calls, 0)
})

test('director 启动后按 routine 优先级执行并写审计', async () => {
  const lines = []
  let seen = null
  const d = createDirector({
    getState: () => ({ ...base, inventory: { oak_log: 3 } }),
    run: async (next, opts) => { seen = { next, opts }; return { ok: true } },
    log: (line) => lines.push(line),
  })
  d.start()
  const result = await d.tick()
  d.stop()
  assert.equal(result.ok, true)
  assert.equal(seen.opts.priority, PRIORITIES.routine)
  assert.equal(seen.opts.origin, 'auto')
  assert.equal(seen.next.cmd, 'chop')
  assert.equal(lines.length, 1)
  const audit = JSON.parse(lines[0].replace('[auto] ', ''))
  assert.equal(audit.action, 'chop')
  assert.equal(audit.result, 'ok')
  assert.ok(Number.isInteger(audit.ms))
})

test('director 超出每小时预算后不再动作', async () => {
  let calls = 0
  let t = 0
  const d = createDirector({
    getState: () => ({ ...base, inventory: { oak_log: 0 } }),
    run: async () => { calls++; return { ok: true } },
    maxPerHour: 2, now: () => t, log: () => {},
  })
  d.start()
  await d.tick(); await d.tick(); await d.tick()
  d.stop()
  assert.equal(calls, 2)
  assert.deepEqual(d.budget(), { used: 2, max: 2, left: 0 })
  t = 3_600_001
  assert.equal(d.budget().left, 2) // 窗口滚过去后恢复
})

test('执行失败也记账，不无限重试同一条', async () => {
  const lines = []
  let calls = 0
  const d = createDirector({
    getState: () => ({ ...base, inventory: { oak_log: 0 } }),
    run: async () => { calls++; throw new Error('找不到路') },
    maxPerHour: 1, log: (line) => lines.push(line),
  })
  d.start()
  await d.tick(); await d.tick()
  d.stop()
  assert.equal(calls, 1)
  assert.match(lines[0], /"result":"fail"/)
})

for (const reason of ['preempted', 'stopped']) {
  test(`director 将 ${reason} 记录为中断，不计预算也不退避`, async () => {
    const lines = []
    let calls = 0
    const d = createDirector({
      getState: () => ({ ...base, inventory: {} }),
      run: async () => ++calls === 1 ? { ok: false, [reason]: true } : { ok: true },
      maxPerHour: 1, log: (line) => lines.push(line),
    })
    d.start()
    await d.tick()
    assert.deepEqual(d.budget(), { used: 0, max: 1, left: 1 })
    assert.equal(JSON.parse(lines[0].replace('[auto] ', '')).result, 'interrupted')
    assert.equal(JSON.parse(lines[0].replace('[auto] ', '')).reason, reason)
    await d.tick()
    d.stop()
    assert.equal(calls, 2, '中断不触发失败冷却')
    assert.equal(d.budget().used, 1)
  })
}

test('director 不把未返回成功结果的动作记为成功', async () => {
  const lines = []
  const d = createDirector({ getState: () => ({ ...base, inventory: {} }), run: async () => undefined, log: (line) => lines.push(line) })
  d.start()
  await d.tick()
  d.stop()
  assert.equal(JSON.parse(lines[0].replace('[auto] ', '')).result, 'fail')
})
