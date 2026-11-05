const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { createGreeter, greetingCommands } = require('../greet')

test('打招呼指令只发给该玩家，JSON 合法且拒绝非法名字', () => {
  const cmds = greetingCommands('Steve_1', 'MinecraftBot', { hour: 9, online: 2 })
  assert.ok(cmds.every((c) => c.includes('Steve_1') && !/[\r\n]/.test(c) && !c.includes('@a')))
  assert.ok(cmds.every((c) => Buffer.byteLength(c) < 1400), 'RCON 单条上限')
  const chat = JSON.parse(cmds[0].slice('tellraw Steve_1 '.length))
  assert.ok(cmds.some((c) => c.includes('早上好')))
  for (const bad of ['@a', 'a b', 'x;op y', '"', 'toolongname_12345']) assert.throws(() => greetingCommands(bad, 'B'))
})

test('未配置 RCON 时直接私聊，重复问候不产生控制台失败日志', async () => {
  const bot = Object.assign(new EventEmitter(), { username: 'MinecraftBot', players: { Steve: {} } })
  const chat = []
  const logs = []
  const greeter = createGreeter(bot, { chat: (s) => chat.push(s), log: (s) => logs.push(s) }, {})
  await greeter.greet('Steve')
  await greeter.greet('Steve')
  assert.equal(chat.length, 2)
  assert.ok(chat.every((s) => s.startsWith('/msg Steve ')))
  assert.deepEqual(logs, [])
})
