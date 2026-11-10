'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { getCommand, safeChatChunks, normalizeAction, AI_ACTIONS, createRateLimiter } = require('../security')

const invalid = (cmd, args, options) => assert.throws(() => normalizeAction(cmd, args, options), { code: 'INVALID_ACTION' })

test('command lookup accepts own functions without invoking inherited or accessor properties', () => {
  const stop = () => {}
  const inherited = Object.create({ sneaky: stop })
  inherited.stop = stop
  inherited.value = 'not a function'
  Object.defineProperty(inherited, 'getter', { get() { throw new Error('must not run') } })
  assert.equal(getCommand(inherited, 'stop'), stop)
  for (const name of ['sneaky', '__proto__', 'constructor', 'toString', 'value', 'getter', 'missing']) assert.equal(getCommand(inherited, name), null)
  assert.equal(getCommand(null, 'stop'), null)
  assert.equal(getCommand(inherited, null), null)
  const dictionary = Object.create(null)
  dictionary.stop = stop
  assert.equal(getCommand(dictionary, 'stop'), stop)
})

test('chat output strips controls and prevents slash commands at every final chunk', () => {
  const chunks = safeChatChunks('a'.repeat(180) + '/' + 'b'.repeat(178) + '/op player\n\r\u0000\u2028\u202E')
  assert.equal(chunks[0].length, 180)
  assert.equal(chunks[1][0], '·')
  assert.equal(chunks[2][0], '·')
  assert.ok(chunks.every((chunk) => chunk.length <= 180 && !chunk.startsWith('/') && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(chunk)))
  assert.deepEqual(safeChatChunks('/op player'), ['·/op player'])
})

test('chat output limits total transmitted UTF-16 length including prefixes and preserves Unicode', () => {
  const chunks = safeChatChunks('/' + '中😀'.repeat(1000))
  assert.ok(chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 600)
  assert.ok(chunks.every((chunk) => chunk.length <= 180 && chunk === chunk.toWellFormed()))
  assert.equal(chunks.join('').slice(1), ('/' + '中😀'.repeat(1000)).slice(0, chunks.join('').length - 1))
  assert.ok(safeChatChunks('a'.repeat(179) + '😀/tail').every((chunk) => chunk === chunk.toWellFormed()))
  assert.deepEqual(safeChatChunks(''), [])
  assert.deepEqual(safeChatChunks({ toString() { throw new Error('no') } }), [])
  assert.equal(safeChatChunks('\uD800')[0], '�')
})

test('all existing commands and the new status/unmark commands have bounded contracts', () => {
  for (const cmd of ['help', 'status', 'come', 'stay', 'stop', 'pos', 'hp', 'look', 'pickup', 'inv', 'sleep', 'eat', 'chest', 'surface', 'places', 'scan', 'advice', 'lastdeath']) {
    assert.deepEqual(normalizeAction(cmd, []), { cmd, args: [] })
    invalid(cmd, ['unexpected'])
  }
  for (const cmd of ['mark', 'unmark', 'go']) assert.deepEqual(normalizeAction(cmd, ['家_1']), { cmd, args: ['家_1'] })
  assert.deepEqual(normalizeAction('FIND', ['铁']), { cmd: 'find', args: ['铁'] })
  assert.deepEqual(normalizeAction('equip', ['minecraft:iron_helmet']), { cmd: 'equip', args: ['iron_helmet'] })
  assert.deepEqual(normalizeAction('mode', []), { cmd: 'mode', args: [] })
  assert.deepEqual(normalizeAction('mode', ['unstuck', 'off']), { cmd: 'mode', args: ['unstuck', 'off'] })
  assert.deepEqual(normalizeAction('note', []), { cmd: 'note', args: [] })
  assert.deepEqual(normalizeAction('goal', []), { cmd: 'goal', args: [] })
})

test('飞行是显式人工指令，跟随距离有界且保留默认2格', () => {
  assert.deepEqual(normalizeAction('follow', []).args, ['2'])
  assert.deepEqual(normalizeAction('follow', ['8']).args, ['8'])
  for (const value of ['0', '1', '9', 'Infinity', '2.5', '-2']) invalid('follow', [value])
  assert.deepEqual(normalizeAction('fly', ['80', '64', '0']).args, ['80', '64', '0'])
  assert.deepEqual(normalizeAction('fly', ['基地']).args, ['基地'])
  assert.deepEqual(normalizeAction('fly', ['1', '64']).args, ['1', '64'])
  invalid('fly', ['1', '64', '0', '9'])
  invalid('fly', ['1', 'x'])
  assert.throws(() => normalizeAction('fly', ['80', '64', '0'], { ai: true }))
  assert.deepEqual(normalizeAction('mode', ['elbow_room', 'on']).args, ['elbow_room', 'on'])
})

test('AI可规划自动goto/go/come或强制walk，无需绕过原生fly预检', () => {
  assert.deepEqual(normalizeAction('walk', ['家'], { ai: true }), { cmd: 'walk', args: ['家'] })
  assert.deepEqual(normalizeAction('walk', ['300', '64', '0'], { ai: true }).args, ['300', '64', '0'])
  invalid('walk', ['300', '0'], { ai: true })
  invalid('walk', ['Infinity', '64', '0'], { ai: true })
  assert.equal(AI_ACTIONS.has('goto'), true)
  assert.equal(AI_ACTIONS.has('walk'), true)
})

test('normal counts, Chinese aliases and namespaced items preserve command defaults and all-item semantics', () => {
  for (const cmd of ['mine', 'craft']) assert.deepEqual(normalizeAction(cmd, ['铁']).args, ['铁', '1'])
  assert.deepEqual(normalizeAction('chop', []).args, ['4'])
  assert.deepEqual(normalizeAction('smelt', ['raw_iron']).args, ['raw_iron', '64'])
  assert.deepEqual(normalizeAction('hunt', ['cow']).args, ['cow', '1'])
  for (const cmd of ['deposit', 'withdraw', 'drop']) {
    assert.deepEqual(normalizeAction(cmd, ['minecraft:oak_log']).args, ['oak_log'])
    assert.deepEqual(normalizeAction(cmd, ['minecraft:oak_log', '64']).args, ['oak_log', '64'])
  }
  assert.deepEqual(normalizeAction('mine', ['stone', '64']).args, ['stone', '64'])
  assert.deepEqual(normalizeAction('hunt', ['salmon', '8']).args, ['salmon', '8'])
})

test('all item/block commands normalize only the minecraft namespace and preserve mod namespaces and aliases', () => {
  for (const cmd of ['mine', 'craft', 'smelt', 'deposit', 'withdraw', 'drop', 'find', 'equip']) {
    assert.equal(normalizeAction(cmd, ['minecraft:stone']).args[0], 'stone')
    assert.equal(normalizeAction(cmd, ['refinedstorage:controller']).args[0], 'refinedstorage:controller')
    assert.equal(normalizeAction(cmd, ['铁']).args[0], '铁')
  }
})

test('quantities reject negative, zero, fractional, nonnumeric and excessive values instead of falling back', () => {
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '65', '1e2', '2abc', '99999999999999999999']) {
    for (const cmd of ['mine', 'craft', 'smelt', 'deposit', 'withdraw', 'drop']) invalid(cmd, ['stone', value])
    invalid('chop', [value])
  }
  invalid('hunt', ['cow', '9'])
  invalid('hunt', ['wolf', '1'])
})

test('goto requires one safe place name or exactly three finite in-world coordinates', () => {
  assert.deepEqual(normalizeAction('goto', ['家']).args, ['家'])
  assert.deepEqual(normalizeAction('goto', ['-29999984', '-64', '29999984']).args, ['-29999984', '-64', '29999984'])
  assert.deepEqual(normalizeAction('goto', ['+1.5', '3.19e2', '-.5']).args, ['1.5', '319', '-0.5'])
  for (const args of [[], ['1', '2'], ['1', '2', '3', '4'], ['NaN', '64', '0'], ['Infinity', '64', '0'], ['1e309', '64', '0'], ['29999985', '64', '0'], ['0', '-65', '0'], ['0', '320', '0'], ['0', '64', '-29999985'], ['0x10', '64', '0']]) invalid('goto', args)
})

test('prototype names, malformed strings, sparse arrays and unsafe place/item names are rejected', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', '__defineGetter__']) {
    invalid(name, [])
    for (const cmd of ['mark', 'unmark', 'go', 'goto', 'equip', 'find']) invalid(cmd, [name])
  }
  for (const name of ['minecraft:__proto__', 'constructor:stone', 'minecraft:prototype']) invalid('mine', [name])
  for (const args of [null, {}, [null], [1], [''], ['\u0000x'], ['\u202Ex'], ['\uD800'], new Array(1)]) invalid('chop', args)
  for (const cmd of [null, undefined, 1, {}, '', ' stop', '/stop', 'unknown']) invalid(cmd, [])
  for (const name of ['家 里', '家.里', '../家', '/op', 'x'.repeat(33)]) invalid('mark', [name])
})

test('switches require exact on/off values and text commands enforce joined-text limits', () => {
  for (const cmd of ['guard', 'auto']) {
    assert.deepEqual(normalizeAction(cmd, []).args, ['on'])
    assert.deepEqual(normalizeAction(cmd, ['off']).args, ['off'])
    for (const value of ['false', 'OFF', 'yes']) invalid(cmd, [value])
  }
  invalid('mode', ['unstuck'])
  invalid('mode', ['constructor', 'on'])
  invalid('mode', ['unstuck', 'yes'])
  assert.deepEqual(normalizeAction('note', ['基地在', '山后']).args, ['基地在 山后'])
  assert.deepEqual(normalizeAction('goal', ['修一间小屋']).args, ['修一间小屋'])
  assert.equal(normalizeAction('say', Array(300).fill('好')).args[0].length, 599)
  invalid('goal', ['中'.repeat(301)])
  invalid('note', ['中'.repeat(101)])
  invalid('say', ['中'.repeat(601)])
})

test('AI actions forbid drop, say, auto, goal and mode regardless of player wording', () => {
  for (const cmd of ['drop', 'say', 'auto', 'goal', 'mode', '__proto__', 'status']) {
    assert.equal(AI_ACTIONS.has(cmd), false)
    invalid(cmd, cmd === 'drop' ? ['stone'] : [], { ai: true })
  }
  assert.throws(() => normalizeAction('drop', ['stone'], { ai: true }), /bot drop/)
  assert.deepEqual(normalizeAction('guard', [], { ai: true }), { cmd: 'guard', args: ['on'] })
  assert.deepEqual(normalizeAction('note', ['记住基地'], { ai: true }), { cmd: 'note', args: ['记住基地'] })
})

test('rate limiter uses per-key sliding windows and never evicts active keys to bypass limits', () => {
  let time = 0
  const limiter = createRateLimiter({ limit: 2, windowMs: 100, maxKeys: 2, now: () => time })
  assert.equal(limiter.take('__proto__'), true)
  assert.equal(limiter.take('__proto__'), true)
  assert.equal(limiter.take('__proto__'), false)
  assert.equal(limiter.take('constructor'), true)
  assert.equal(limiter.take('third'), false)
  assert.equal(limiter.take('constructor'), true)
  time = -100
  assert.equal(limiter.take('__proto__'), false)
  time = 100
  assert.equal(limiter.take('third'), true)
  assert.equal(limiter.take('__proto__'), true)
  assert.equal(limiter.take('constructor'), false)
})

test('rate limiter validates configuration and defaults to the global key', () => {
  for (const options of [{ limit: 0, windowMs: 100 }, { limit: 1.1, windowMs: 100 }, { limit: 1, windowMs: Infinity }, { limit: 1, windowMs: 100, maxKeys: 0 }]) assert.throws(() => createRateLimiter(options), TypeError)
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 1 })
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), false)
  assert.equal(limiter.take({}), false)
})

test('第二批技能的参数都有上限，方向支持中文，AI 可用但不能越界', () => {
  assert.deepEqual(normalizeAction('get', ['铁镐']).args, ['铁镐', '1'])
  assert.deepEqual(normalizeAction('get', ['minecraft:torch', '8']).args, ['torch', '8'])
  invalid('get', ['torch', '65'])
  assert.deepEqual(normalizeAction('farm', []).args, ['16'])
  invalid('farm', ['33'])
  assert.deepEqual(normalizeAction('fish', []).args, ['3'])
  assert.deepEqual(normalizeAction('tunnel', ['北', '20']).args, ['20', 'north'])
  assert.deepEqual(normalizeAction('tunnel', []).args, ['16'])
  invalid('tunnel', ['20', 'up'])
  invalid('tunnel', ['65'])
  assert.deepEqual(normalizeAction('digdown', []).args, ['8'])
  invalid('digdown', ['33'])
  assert.deepEqual(normalizeAction('breed', ['cow']).args, ['cow'])
  invalid('breed', ['villager'])
  for (const cmd of ['shear', 'milk', 'torch', 'dump']) { assert.deepEqual(normalizeAction(cmd, []).args, []); invalid(cmd, ['x']) }
  for (const cmd of ['get', 'plan', 'farm', 'fish', 'tunnel', 'digdown', 'explore', 'dump']) assert.ok(AI_ACTIONS.has(cmd))
  assert.deepEqual(normalizeAction('mode', ['sleep_with_players', 'off']).args, ['sleep_with_players', 'off'])
})


test('探索与知识指令：inspect/try 只收物品名，tip 有长度上限，replan 只认开关', () => {
  assert.deepEqual(normalizeAction('inspect', ['refinedstorage:controller']).args, ['refinedstorage:controller'])
  assert.deepEqual(normalizeAction('try', ['waystones:warp_stone'], { ai: true }).args, ['waystones:warp_stone'])
  invalid('try', ['a', 'b'])
  assert.deepEqual(normalizeAction('tip', []).args, [])
  invalid('tip', ['x'.repeat(41)])
  assert.deepEqual(normalizeAction('replan', ['off']).args, ['off'])
  invalid('replan', ['maybe'])
  assert.equal(AI_ACTIONS.has('replan'), false)
})

test('excavate 只收限定的参数', () => {
  assert.deepEqual(normalizeAction('excavate', ['dirt,grass_block', 'r=32', 'above=76'], { ai: true }), { cmd: 'excavate', args: ['dirt,grass_block', 'r=32', 'above=76'] })
  for (const args of [[], ['dirt', 'r=33'], ['dirt', 'max=513'], ['dirt', 'r=0'], ['dirt', 'x=1'], ['dirt', 'r=1', 'r=2'], ['a,b,c,d,e,f,g']]) assert.throws(() => normalizeAction('excavate', args, { ai: true }), { code: 'INVALID_ACTION' })
})

test('长列表在逗号后分段，不把物品名和数量拆开；断开后的斜杠仍加前缀', () => {
  const inv = Array.from({ length: 20 }, (_, i) => `netherite_item_${i}x${i + 1}`).join(', ')
  const chunks = safeChatChunks(inv)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.match(chunk, /^netherite_item_\d+x\d+(, netherite_item_\d+x\d+)*,?$/)
  assert.equal(chunks.join(' ').replace(/,$/, ''), inv)
  assert.equal(safeChatChunks('a'.repeat(175) + '  /opxxxxxxxxxx yy')[1].slice(0, 3), '·/o')
})

test('扩展指令参数：最多 8 个、每个 1 到 64 字符、单行', () => {
  const { normalizeExtensionArgs } = require('../security')
  assert.deepEqual(normalizeExtensionArgs(['a', '中文']), ['a', '中文'])
  assert.throws(() => normalizeExtensionArgs(Array(9).fill('a')), /最多 8/)
  assert.throws(() => normalizeExtensionArgs(['x'.repeat(65)]), /64/)
  assert.throws(() => normalizeExtensionArgs(['a\u0000b']), /单行/)
})
test('世界高度只接受有界整数，失败不改变当前范围，横向和 AI 边界保持', (t) => {
  const { setWorldBounds } = require('../security')
  t.after(() => setWorldBounds(-64, 319))
  setWorldBounds(0, 255)
  for (const cmd of ['goto', 'walk', 'fly']) {
    assert.deepEqual(normalizeAction(cmd, ['0', '255', '0']).args, ['0', '255', '0'])
    invalid(cmd, ['0', '-1', '0'])
    invalid(cmd, ['0', '256', '0'])
  }
  for (const bounds of [[0, 0], [1, 0], [-2033, 255], [0, 2032], [-64.5, 319], [0, 255.5], ['0', 255], [NaN, 319], [0, Infinity]]) {
    assert.throws(() => setWorldBounds(...bounds), /世界高度/)
    invalid('goto', ['0', '-1', '0'])
  }
  setWorldBounds(-2032, 2031)
  for (const y of ['-2032', '2031']) assert.equal(normalizeAction('goto', ['0', y, '0'], { ai: true }).args[1], y)
  invalid('goto', ['29999985', '0', '0'])
  invalid('goto', ['0', '2032', '0'])
  invalid('goto', ['0', 'NaN', '0'])
  assert.throws(() => normalizeAction('fly', ['0', '0', '0'], { ai: true }))
})
