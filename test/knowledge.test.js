const test = require('node:test')
const assert = require('node:assert/strict')
const { relevantTips, modTipFor, useMods, useVersion, TIPS } = require('../knowledge')
const { versionFacts } = require('../versions')
const { createMods } = require('../mods')

test('按关键词挑相关知识，最多返回指定条数', () => {
  assert.ok(relevantTips('去挖钻石').some((t) => t.includes('Y -58')))
  assert.ok(relevantTips('苦力怕来了')[0].includes('7 格'))
  assert.equal(relevantTips('挖矿 矿 铁 钻石 煤', 2).length, 2)
  assert.deepEqual(relevantTips('完全无关的内容xyz'), [])
  for (const t of TIPS) assert.ok(t.text.length <= 120 && t.keys.length)
})

test('模组知识只来自已启用的扩展：没装的模组不会出现在提示里', () => {
  const mods = createMods({ log: () => {} })
  useMods(mods)
  mods.activate(new Set(['refinedstorage']))
  assert.match(modTipFor('refinedstorage:controller'), /精致存储/)
  assert.equal(modTipFor('waystones:warp_scroll'), null)
  assert.ok(relevantTips('精致存储 控制器').some((t) => t.includes('Refined Storage')))
  assert.ok(!relevantTips('传送石碑').some((t) => t.includes('Waystones')))
  assert.equal(modTipFor('unknownmod:thing'), null)
  useMods(null)
})

test('1.17 的旧矿石和亮度不会混入现代建议，1.18 和 26.1 切回现代分布', (t) => {
  t.after(() => useVersion(null))
  const select = (version) => useVersion(versionFacts({ version, registry: require('minecraft-data')(version) }))
  select('1.17.1')
  for (const [query, pattern] of [['钻石', /Y 5~12.*Y 11/], ['铁矿', /Y 0~63/], ['金矿', /Y 0~31/], ['恶地 金', /Y 32~79/],
    ['红石', /Y 0~15/], ['青金石', /Y 0~30.*Y 13~16/], ['煤', /Y 0~127/], ['铜', /Y 0~96/], ['刷怪亮度', /亮度 ≤7/]]) {
    assert.ok(relevantTips(query, 20).some((text) => pattern.test(text)), query)
  }
  assert.ok(!relevantTips('钻石 铁 红石 铜 刷怪亮度', 100).some((text) => /Y -58|Y -59|Y 232|亮度 0 才/.test(text)))
  for (const version of ['1.18.2', '26.1']) {
    select(version)
    assert.ok(relevantTips('钻石').some((text) => /Y -58/.test(text)))
    assert.ok(!relevantTips('钻石', 100).some((text) => /Y 5~12/.test(text)))
    assert.ok(relevantTips('刷怪亮度').some((text) => /亮度 0/.test(text)))
  }
})

test('内容相关知识按下界更新、铜、幻翼和副手的边界过滤', (t) => {
  t.after(() => useVersion(null))
  for (const version of ['1.8.8', '1.12.2', '1.16.5', '1.17.1']) {
    useVersion(versionFacts({ version, registry: require('minecraft-data')(version) }))
    assert.equal(relevantTips('铜 copper', 100).length > 0, version === '1.17.1')
    assert.equal(relevantTips('远古残骸 netherite', 100).some((text) => /远古残骸/.test(text)), ['1.16.5', '1.17.1'].includes(version))
    if (version === '1.8.8') assert.ok(!relevantTips('盔甲 骷髅', 100).some((text) => /举盾|盾牌只要/.test(text)))
    if (version === '1.12.2') assert.deepEqual(relevantTips('phantom'), [])
  }
})

test('since/until 是闭区间，数字比较支持 26.x，模组知识共用过滤且可清除版本', (t) => {
  t.after(() => { useVersion(null); useMods(null) })
  useMods({ tips: () => [
    { keys: ['边界'], text: '区间', since: '1.20.5', until: '26.1' },
    { keys: ['边界'], text: '通用' },
  ] })
  for (const [version, expected] of [['1.20.4', false], ['1.20.5', true], ['26.1', true], ['26.1.1', false]]) {
    useVersion({ version, release: require('../versions').releaseOf(version) })
    assert.equal(relevantTips('边界').includes('区间'), expected)
    assert.ok(relevantTips('边界').includes('通用'))
  }
  useVersion(null)
  assert.deepEqual(relevantTips('边界'), ['区间', '通用'])
})
