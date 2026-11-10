'use strict'

// All player and model actions pass through the same bounded argument contract.
const RESERVED_NAMES = new Set([
  ...Object.getOwnPropertyNames(Object.prototype), 'prototype',
].map((name) => name.toLowerCase()))
const NO_ARGS = new Set(['help', 'status', 'come', 'stay', 'stop', 'halt', 'pos', 'hp', 'look', 'pickup', 'inv', 'sleep', 'eat', 'chest', 'surface', 'places', 'scan', 'advice', 'lastdeath', 'shear', 'milk', 'torch', 'dump', 'blueprints', 'undo', 'workflows'])
const AI_ACTIONS = new Set(['inspect', 'try', 'tip', 'get', 'plan', 'farm', 'breed', 'shear', 'milk', 'fish', 'tunnel', 'digdown', 'excavate', 'torch', 'explore', 'dump', 'smelt', 'chest', 'chests', 'chestscan', 'fetch', 'deposit', 'withdraw', 'find', 'hunt', 'surface', 'equip', 'mark', 'go', 'note', 'stay', 'eat', 'come', 'follow', 'stop', 'goto', 'walk', 'mine', 'chop', 'pickup', 'craft', 'sleep', 'guard', 'build', 'paste', 'fill', 'materials', 'blueprints', 'bridge', 'pillar', 'use', 'door', 'repeater', 'rs', 'rstrace', 'rsdiag', 'circuit', 'wire', 'parkour', 'run'])
const HUNTABLE = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat', 'cod', 'salmon', 'slime'])
const MODES = new Set(['self_preservation', 'unstuck', 'item_collecting', 'idle_staring', 'elbow_room', 'sleep_with_players'])
const BREEDABLE = new Set(['cow', 'mooshroom', 'sheep', 'goat', 'pig', 'chicken', 'rabbit'])
const DIRECTIONS = { north: 'north', south: 'south', east: 'east', west: 'west', 北: 'north', 南: 'south', 东: 'east', 西: 'west' }
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const CONTROLS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu
let worldMinY = -64, worldMaxY = 319
function setWorldBounds(minY, maxY) {
  if (!Number.isInteger(minY) || !Number.isInteger(maxY) || minY < -2032 || minY >= maxY || maxY > 2031) fail('世界高度范围不合法')
  worldMinY = minY; worldMaxY = maxY
}

function getCommand(commands, name) {
  if (!commands || typeof commands !== 'object' || typeof name !== 'string') return null
  const descriptor = Object.getOwnPropertyDescriptor(commands, name)
  return descriptor && typeof descriptor.value === 'function' ? descriptor.value : null
}

function safeChatChunks(value) {
  let source
  try { source = String(value).replace(CONTROLS, '').toWellFormed() } catch { return [] }
  const chunks = []
  let offset = 0
  let remaining = 600
  while (offset < source.length && remaining > 0) {
    const prefix = source[offset] === '/' ? '·' : ''
    const capacity = Math.min(180, remaining) - prefix.length
    if (capacity <= 0) break
    let end = Math.min(offset + capacity, source.length)
    // 优先在分隔符后断开，避免把物品名和数量切成两条消息。
    if (end < source.length) {
      const window = source.slice(offset, end)
      const cut = Math.max(...[', ', '，', '；', '; ', '。', ' '].map((sep) => { const i = window.lastIndexOf(sep); return i < 0 ? -1 : i + sep.length }))
      if (cut > capacity / 2) end = offset + cut
    }
    // Never split the UTF-16 representation of a Unicode code point.
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--
    if (end === offset) break
    const chunk = prefix + source.slice(offset, end).trimEnd()
    chunks.push(chunk)
    remaining -= chunk.length
    offset = end
    while (source[offset] === ' ') offset++
  }
  return chunks
}

function fail(message) {
  const error = new Error(message)
  error.code = 'INVALID_ACTION'
  throw error
}

function arity(args, min, max = min) {
  if (args.length < min || args.length > max) fail('指令参数数量不正确')
}

function safeName(value, kind = 'name') {
  if (typeof value !== 'string' || value.length > (kind === 'item' ? 128 : 32) || !value) fail('名称为空或过长')
  const valid = kind === 'item'
    ? /^(?:[a-z0-9_.-]+(?::[a-z0-9_./-]+)?|[\p{Script=Han}]{1,32})$/u.test(value)
    : /^[\p{L}\p{N}_-]+$/u.test(value)
  if (!valid || value.split(/[:/]/).some((part) => RESERVED_NAMES.has(part.toLowerCase()))) fail('名称不合法或属于保留名称')
  return kind === 'item' && value.startsWith('minecraft:') ? value.slice('minecraft:'.length) : value
}

function count(value, fallback, max = 64) {
  if (value === undefined) return fallback === undefined ? undefined : String(fallback)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail(`数量必须是 1 到 ${max} 的整数`)
  return String(Number(value))
}

function textArgs(args, max, allowEmpty = false) {
  if (!args.length) {
    if (allowEmpty) return []
    fail('请输入内容')
  }
  const text = args.join(' ')
  if (!text.trim() || text.length > max) fail(`文本内容必须非空且不超过 ${max} 个字符`)
  return [text]
}

const RARE_BLOCK = /(diamond|emerald|netherite|gold_block|iron_block|beacon|ancient_debris|enchanting_table|anvil|lapis_block|shulker_box|dragon)/

function blockCoord(value) {
  if (!/^[+-]?\d{1,8}$/.test(value)) fail('坐标必须是整数')
  const n = Number(value)
  if (Math.abs(n) > 29_999_984) fail('坐标超出世界边界')
  return n
}
// build/paste/circuit 的 key=value 选项
function option(value) {
  const m = /^([a-z]{1,8})=([a-z0-9_:,+-]{1,64})$/.exec(value)
  if (!m || RESERVED_NAMES.has(m[2].toLowerCase())) fail('选项要写成 key=value，比如 m=cobblestone at=10,64,-3 f=east')
  return `${m[1]}=${m[2].replace(/^minecraft:/, '')}`
}

function normalizeAction(cmd, args, { ai = false } = {}) {
  if (typeof cmd !== 'string' || !cmd || cmd.length > 32 || !/^[a-z]+$/i.test(cmd)) fail('指令名不合法')
  cmd = cmd.toLowerCase()
  if (!Array.isArray(args) || args.length > 600 || Array.from(args).some((arg) => typeof arg !== 'string' || arg.length > 600 || !arg.trim() || CONTROL.test(arg) || arg !== arg.toWellFormed())) fail('指令参数必须是有限的非空字符串数组')
  if (RESERVED_NAMES.has(cmd)) fail('不允许使用保留指令名')
  if (ai && cmd === 'drop') fail('AI 不能丢弃物品，请玩家直接使用 bot drop <物品> [数量]')
  if (ai && !AI_ACTIONS.has(cmd)) fail('AI 不允许执行此指令')
  let normalized
  if (NO_ARGS.has(cmd)) {
    arity(args, 0)
    normalized = []
  } else if (['mine', 'craft', 'smelt', 'deposit', 'withdraw', 'fetch', 'drop', 'get', 'plan'].includes(cmd)) {
    arity(args, 1, 2)
    const fallback = cmd === 'smelt' ? 64 : ['mine', 'craft', 'get', 'plan'].includes(cmd) ? 1 : undefined
    const quantity = count(args[1], fallback)
    normalized = [safeName(args[0], 'item'), ...(quantity === undefined ? [] : [quantity])]
  } else if (cmd === 'chop') {
    arity(args, 0, 1)
    normalized = [count(args[0], 4)]
  } else if (cmd === 'farm') {
    arity(args, 0, 1)
    normalized = [count(args[0], 16, 32)]
  } else if (cmd === 'fish') {
    arity(args, 0, 1)
    normalized = [count(args[0], 3, 16)]
  } else if (cmd === 'digdown') {
    arity(args, 0, 1)
    normalized = [count(args[0], 8, 32)]
  } else if (cmd === 'excavate') {
    arity(args, 1, 5)
    const names = args[0].split(/[,，]/)
    if (names.length > 6) fail('一次最多 6 种方块')
    const options = {}
    for (const arg of args.slice(1)) {
      const m = /^(r|above|below|max)=(-?\d{1,4})$/.exec(arg)
      if (!m || Object.hasOwn(options, m[1])) fail('excavate 参数只能是 r= above= below= max=')
      options[m[1]] = Number(m[2])
    }
    if (options.r !== undefined && (options.r < 1 || options.r > 32)) fail('r 只能是 1 到 32')
    if (options.max !== undefined && (options.max < 1 || options.max > 512)) fail('max 只能是 1 到 512')
    normalized = [names.map((name) => safeName(name, 'item')).join(','), ...args.slice(1)]
  } else if (cmd === 'tunnel') {
    arity(args, 0, 2)
    let [len, dir] = args
    if (len !== undefined && Object.hasOwn(DIRECTIONS, len)) [len, dir] = [dir, len] // bot tunnel 北 20 也行
    if (dir !== undefined && !Object.hasOwn(DIRECTIONS, dir)) fail('方向只能是 north/south/east/west 或 东南西北')
    normalized = [count(len, 16, 64), ...(dir === undefined ? [] : [DIRECTIONS[dir]])]
  } else if (cmd === 'breed') {
    arity(args, 1)
    if (!BREEDABLE.has(args[0])) fail('只能喂养 cow/mooshroom/sheep/goat/pig/chicken/rabbit')
    normalized = [args[0]]
  } else if (cmd === 'inspect' || cmd === 'try') {
    arity(args, 1)
    normalized = [safeName(args[0], 'item')]
  } else if (cmd === 'run') {
    arity(args, 1)
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(args[0])) fail('工作流名只能用小写字母、数字、_ 和 -')
    normalized = [args[0]]
  } else if (cmd === 'tip') normalized = textArgs(args, 40, true)
  else if (cmd === 'replan') {
    arity(args, 0, 1)
    if (args.length && !['on', 'off'].includes(args[0])) fail('开关只能使用 on 或 off')
    normalized = [args[0] || 'on']
  } else if (cmd === 'chests') {
    arity(args, 0, 1)
    normalized = args.length ? [safeName(args[0], 'item')] : []
  } else if (cmd === 'chestscan') {
    arity(args, 0, 1)
    normalized = [count(args[0], 16, 32)]
  } else if (cmd === 'lessons') {
    arity(args, 0, 1)
    if (args.length && args[0] !== 'clear') fail('只能用 bot lessons 或 bot lessons clear')
    normalized = [...args]
  } else if (cmd === 'explore') {
    arity(args, 1)
    normalized = [safeName(args[0], 'item')]
  } else if (cmd === 'hunt') {
    arity(args, 1, 2)
    if (!HUNTABLE.has(args[0])) fail('只能狩猎支持的动物')
    normalized = [args[0], count(args[1], 1, 8)]
  } else if (['find', 'equip'].includes(cmd)) {
    arity(args, 1)
    normalized = [safeName(args[0], 'item')]
  } else if (['mark', 'unmark', 'go'].includes(cmd)) {
    arity(args, 1)
    normalized = [safeName(args[0])]
  } else if (cmd === 'follow') {
    arity(args, 0, 1)
    const distance = count(args[0], 2, 8)
    if (Number(distance) < 2) fail('跟随距离必须是2到8格')
    normalized = [distance]
  } else if (cmd === 'goto' || cmd === 'walk' || cmd === 'fly') {
    if (args.length === 1) normalized = [safeName(args[0])]
    else if (cmd === 'fly' && args.length === 2) {
      const coordinates = args.map((value) => {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) fail('坐标必须是有限数字')
        return Number(value)
      })
      if (!coordinates.every((c) => Number.isFinite(c) && Math.abs(c) <= 29_999_984)) fail('坐标超出世界边界')
      normalized = coordinates.map(String)
    } else {
      arity(args, 3)
      const coordinates = args.map((value) => {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) fail('坐标必须是有限数字')
        return Number(value)
      })
      if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 29_999_984 || Math.abs(coordinates[2]) > 29_999_984 || coordinates[1] < worldMinY || coordinates[1] > worldMaxY) fail('坐标超出世界边界或高度范围')
      normalized = coordinates.map(String)
    }
  } else if (cmd === 'build' || cmd === 'paste' || cmd === 'circuit' || cmd === 'materials') {
    arity(args, 1, 8)
    const [name, ...rest] = args
    normalized = [safeName(name), ...rest.map(option)]
    // AI 动手时打上标记：禁用稀有材料，也不能用 clear 挖地形
    if (ai && cmd !== 'materials') normalized = [normalized[0], ...normalized.slice(1).filter((o) => !/^(ai|clear)=/.test(o)), 'ai=1']
  } else if (cmd === 'fill') {
    arity(args, 7, 8)
    const nums = args.slice(0, 6).map(blockCoord)
    if (args[7] !== undefined && args[7] !== 'hollow') fail('fill 第八个参数只能是 hollow')
    const volume = (Math.abs(nums[0] - nums[3]) + 1) * (Math.abs(nums[1] - nums[4]) + 1) * (Math.abs(nums[2] - nums[5]) + 1)
    const material = safeName(args[6], 'item')
    if (ai && volume > 256) fail('AI 一次最多填 256 格，更大的请玩家直接下指令')
    if (ai && RARE_BLOCK.test(material)) fail('AI 不能自己决定用稀有材料')
    normalized = [...nums.map(String), material, ...(args[7] ? ['hollow'] : [])]
  } else if (cmd === 'copy') {
    arity(args, 7)
    normalized = [...args.slice(0, 6).map(blockCoord).map(String), safeName(args[6])]
  } else if (cmd === 'wire') {
    arity(args, 6)
    normalized = args.map(blockCoord).map(String)
  } else if (cmd === 'rstrace' || cmd === 'rsdiag') {
    arity(args, 3)
    normalized = args.map(blockCoord).map(String)
  } else if (cmd === 'use') {
    if (args.length && args.length !== 3) fail('用法: bot use [x y z]')
    normalized = args.map(blockCoord).map(String)
  } else if (cmd === 'repeater') {
    arity(args, 4)
    if (!/^[1-4]$/.test(args[3])) fail('中继器延迟只能是 1 到 4')
    normalized = [...args.slice(0, 3).map(blockCoord).map(String), args[3]]
  } else if (cmd === 'door') {
    arity(args, 1)
    if (!['open', 'close'].includes(args[0])) fail('开关只能是 open 或 close')
    normalized = [args[0]]
  } else if (cmd === 'rs') {
    arity(args, 0, 1)
    normalized = [count(args[0], 16, 32)]
  } else if (cmd === 'bridge') {
    arity(args, 0, 3)
    let [len, dir, material] = args
    if (len !== undefined && Object.hasOwn(DIRECTIONS, len)) [len, dir] = [dir, len]
    if (dir !== undefined && !Object.hasOwn(DIRECTIONS, dir)) fail('方向只能是 north/south/east/west 或 东南西北')
    normalized = [count(len, 8, 64), ...(dir === undefined ? [] : [DIRECTIONS[dir]]), ...(material === undefined ? [] : [safeName(material, 'item')])]
  } else if (cmd === 'pillar') {
    arity(args, 0, 2)
    normalized = [count(args[0], 3, 32), ...(args[1] === undefined ? [] : [safeName(args[1], 'item')])]
  } else if (cmd === 'parkour') {
    const check = args[0] === 'check'
    const rest = check ? args.slice(1) : args
    if (rest.length < 3 || rest.length > 4) fail('用法: bot parkour x y z [risk] / bot parkour check x y z')
    if (rest[3] !== undefined && rest[3] !== 'risk') fail('第四个参数只能是 risk')
    if (ai && rest[3]) fail('AI 不能选择高风险跑酷路线')
    normalized = [...(check ? ['check'] : []), ...rest.slice(0, 3).map(blockCoord).map(String), ...(rest[3] ? ['risk'] : [])]
  } else if (cmd === 'guard' || cmd === 'auto') {
    arity(args, 0, 1)
    if (args.length && !['on', 'off'].includes(args[0])) fail('开关只能使用 on 或 off')
    normalized = [args[0] || 'on']
  } else if (cmd === 'mode') {
    if (!args.length) normalized = []
    else {
      arity(args, 2)
      if (!MODES.has(args[0]) || !['on', 'off'].includes(args[1])) fail('模式名称不正确，开关只能使用 on 或 off')
      normalized = [...args]
    }
  } else if (cmd === 'goal') normalized = textArgs(args, 300, true)
  else if (cmd === 'note') normalized = textArgs(args, 100, true)
  else if (cmd === 'say') normalized = textArgs(args, 600)
  else fail('未知指令')
  return { cmd, args: normalized }
}

// 扩展指令的参数：内容由扩展自己解释，这里只管边界——最多 8 个，每个 1 到 64 字符、单行
function normalizeExtensionArgs(args) {
  if (!Array.isArray(args) || args.length > 8) fail('扩展指令最多 8 个参数')
  for (const arg of args) if (typeof arg !== 'string' || !arg || arg.length > 64 || CONTROL.test(arg) || arg !== arg.toWellFormed()) fail('扩展指令参数必须是 1 到 64 个字符的单行文本')
  return [...args]
}

function createRateLimiter({ limit, windowMs, maxKeys = 256, now = Date.now }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0 || !Number.isSafeInteger(maxKeys) || maxKeys < 1 || typeof now !== 'function') throw new TypeError('限流配置不正确')
  const windows = new Map()
  let lastTime = -Infinity
  return {
    take(key = 'global') {
      const current = now()
      if (!Number.isFinite(current) || (typeof key !== 'string' && typeof key !== 'number')) return false
      const time = lastTime = Math.max(lastTime, current)
      // Expired keys can be removed; active keys are never evicted to reset a quota.
      for (const [name, entries] of windows) {
        while (entries.length && entries[0] <= time - windowMs) entries.shift()
        if (!entries.length) windows.delete(name)
      }
      let entries = windows.get(key)
      if (!entries) {
        if (windows.size >= maxKeys) return false
        entries = []
        windows.set(key, entries)
      }
      if (entries.length >= limit) return false
      entries.push(time)
      return true
    },
  }
}

module.exports = { getCommand, safeChatChunks, normalizeAction, normalizeExtensionArgs, AI_ACTIONS, createRateLimiter, setWorldBounds }
