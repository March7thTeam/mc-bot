const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSkills, loadPlaces } = require('../skills')
const { readJSON, writeJSON } = require('../storage')

test('地点最多64个、允许更新、显式删除后可新增且不接受继承名称', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-places-'))
  try {
    const file = path.join(dir, 'places.json')
    const messages = []
    const bot = { entity: { position: { x: 1, y: 64, z: 2 } }, game: { dimension: 'overworld' } }
    const skills = createSkills(bot, { placesFile: file, say: (x) => messages.push(x), fmt: () => '1 64 2' })
    for (let n = 0; n < 64; n++) skills.commands.mark(null, [`地点${n}`])
    skills.commands.mark(null, ['多余'])
    skills.commands.mark(null, ['__proto__'])
    assert.equal(Object.keys(skills.places).length, 64)
    assert.equal(Object.hasOwn(skills.places, '多余'), false)
    bot.entity.position.x = 10
    skills.commands.mark(null, ['地点0'])
    assert.equal(loadPlaces(file)['地点0'].x, 10)
    skills.commands.unmark(null, ['地点1'])
    skills.commands.mark(null, ['新地点'])
    assert.equal(Object.keys(loadPlaces(file)).length, 64)
    assert.ok(skills.describePlaces().length <= 1200)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(dir), ['places.json'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('写盘失败不向内存发布新地点；加载拒绝非法形状和坐标', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-store-'))
  try {
    const file = path.join(dir, 'places.json')
    writeJSON(file, { good: { x: 1, y: 64, z: 2 }, bad: { x: null, y: 64, z: 2 } })
    assert.deepEqual(Object.keys(loadPlaces(file)), ['good'])
    const skills = createSkills({ entity: { position: { x: 1, y: 64, z: 2 } }, game: { dimension: 'overworld' } }, { placesFile: file, say() {}, fmt() {} })
    fs.unlinkSync(file)
    fs.mkdirSync(file)
    assert.throws(() => skills.commands.mark(null, ['fail']))
    assert.equal(Object.hasOwn(skills.places, 'fail'), false)
    assert.deepEqual(fs.readdirSync(dir), ['places.json'])
    assert.throws(() => writeJSON(path.join(dir, 'big.json'), { data: 'x'.repeat(40_000) }), /大小上限/)
    assert.deepEqual(readJSON(path.join(dir, 'missing.json'), {}), {})
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('显式字节上限支持长期快照，默认32KiB和原子拒绝行为保持', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-store-cap-'))
  try {
    const file = path.join(dir, 'large.json'), old = { original: true }
    writeJSON(file, old); const before = fs.readFileSync(file)
    const value = { text: '长'.repeat(16_000) }
    assert.throws(() => writeJSON(file, value), /大小上限/)
    assert.deepEqual(fs.readFileSync(file), before)
    writeJSON(file, value, 65_536)
    assert.deepEqual(readJSON(file, null, 65_536), value)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(dir), ['large.json'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
