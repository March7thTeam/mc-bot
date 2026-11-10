// 串行启动可丢弃的本机原版服；只测临时副本，不碰正式机器人的数据和配置。
'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomBytes } = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const mcData = require('minecraft-data')
const { ping } = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { rconRun } = require('../../rcon')
const { versionFacts, flightVerified, compareRelease } = require('../../versions')
const runFile = promisify(execFile)
const ROOT = path.resolve(__dirname, '../..'), NAME = 'VersionLabBot', TESTER = 'VersionTester'
const ZOMBIE_SCORE = 'vm_zombie_kills'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) throw new Error(message) }

function parseArgs(args) {
  const options = { image: 'itzg/minecraft-server:java25', port: 25590, flight: false, versions: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--flight') options.flight = true
    else if (['--out', '--image', '--port'].includes(arg)) {
      const value = args[++i]
      assert(value && !value.startsWith('--'), `${arg} 缺少值`)
      options[arg.slice(2)] = value
    } else {
      assert(/^\d+\.\d+(?:\.\d+)?$/.test(arg) && mcData(arg), `不支持的版本或参数：${arg}`)
      options.versions.push(arg)
    }
  }
  assert(options.out && options.versions.length, '用法：node scripts/lab/version-matrix.js --out <证据目录> [--image 镜像] [--port 25590] [--flight] <版本...>')
  assert(/^\d+$/.test(String(options.port)), '端口必须是整数')
  options.port = Number(options.port)
  assert(options.port >= 1024 && options.port <= 65534, '端口必须在 1024~65534，下一端口留给 RCON')
  options.out = path.resolve(options.out)
  assert(options.out !== ROOT && !ROOT.startsWith(options.out + path.sep), '证据目录不能是仓库根目录或它的父目录')
  options.versions = [...new Set(options.versions)]
  return options
}

function includeFile(source, root, out) {
  const rel = path.relative(root, source), parts = rel.split(path.sep), first = parts[0]
  if (out && (source === out || source.startsWith(out + path.sep))) return false
  if (['node_modules', 'data', 'logs', 'workflows', '.dual-dev', '.git', '.agents', '.codex', '.aws'].includes(first)) return false
  if (parts.some((name) => name === '.env' || name.startsWith('.env.') || name === 'config.json' || name.endsWith('.log'))) return false
  return first !== 'extensions' || !parts[1] || (parts.length === 2 && parts[1] === 'README.md')
}
async function copySandbox(out) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-bot-versions-'))
  try {
    await fs.cp(ROOT, root, { recursive: true, filter: (source) => includeFile(source, ROOT, out) })
    await fs.symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    return root
  } catch (err) { await fs.rm(root, { recursive: true, force: true }); throw err }
}

function commandsFor(version) {
  const registry = mcData(version), facts = versionFacts({ version, registry }), modern = facts.flattening
  const name = (newName, oldName = newName) => {
    const chosen = modern ? newName : oldName
    assert(registry.itemsByName[chosen] || registry.blocksByName[chosen], `${version} 注册表没有 ${chosen}`)
    return chosen
  }
  const zombie = registry.entitiesArray.find((entry) => entry.name.toLowerCase() === 'zombie')?.name
  const give = (item, count = 1, nbt = '') => modern ? `give ${NAME} ${item}${nbt} ${count}` : `give ${NAME} ${item} ${count} 0${nbt ? ' ' + nbt : ''}`
  const rocket = facts.rocketItem
  return { registry, facts, modern, name, zombie, give,
    mobRule: compareRelease(version, '1.21.11') >= 0 ? 'spawn_mobs' : 'doMobSpawning',
    inventoryRule: compareRelease(version, '1.21.11') >= 0 ? 'keep_inventory' : 'keepInventory',
    forceload: compareRelease(version, '1.14') >= 0,
    zombieCriterion: modern ? 'minecraft.killed:minecraft.zombie' : 'stat.killEntity.Zombie',
    readZombieScore: modern ? `scoreboard players get ${NAME} ${ZOMBIE_SCORE}` : `scoreboard players list ${NAME}`,
    summon: (x, y, z, tag) => {
      assert(zombie, `${version} 注册表没有僵尸，无法执行召唤检查`)
      return `summon ${zombie} ${x} ${y} ${z} {CustomName:${modern ? JSON.stringify(JSON.stringify(tag)) : JSON.stringify(tag)},PersistenceRequired:1b,NoAI:1b,Health:20.0f}`
    },
    effect: (effect, id) => modern ? `effect give ${NAME} minecraft:${effect} 600 5 true` : `effect ${NAME} ${id} 600 5 true`,
    rocketGive: () => facts.components ? give(rocket, 64, '[minecraft:fireworks={flight_duration:1,explosions:[]}]')
      : give(rocket, 64, '{Fireworks:{Flight:1b}}'),
  }
}

function parseZombieScore(reply, modern) {
  const clean = reply.replace(/\x1b\[[0-9;]*m|§[0-9a-fklmnor]/gi, '').trim()
  const pattern = modern ? /^VersionLabBot has (\d+) \[vm_zombie_kills\]$/g
    : /(?:^|[\s-])vm_zombie_kills:\s*(\d+)\s+\(vm_zombie_kills\)(?=\s|$|-)/g
  const values = [...clean.matchAll(pattern)]
  assert(values.length === 1 && Number.isSafeInteger(Number(values[0][1])), `僵尸计分板回执不对：${reply.trim().slice(0, 300)}`)
  return Number(values[0][1])
}

// inv 最多分四条回复，物品名使用当前注册表的原名（旧版原木为 log）。
const INVENTORY_REPLY = /^(?:背包是空的|[a-z0-9_:./-]+x\d+(?:, [a-z0-9_:./-]+x\d+)*)$/
function parseInventoryCount(replies, item) {
  assert(replies.length > 0 && replies.every((text) => INVENTORY_REPLY.test(text)), `背包计数格式不对：${replies.join('；')}`)
  let count = 0
  for (const text of replies) {
    if (text === '背包是空的') continue
    for (const part of text.split(', ')) {
      const [, name, amount] = part.match(/^(.+)x(\d+)$/)
      if (name === item) count += Number(amount)
    }
  }
  assert(Number.isSafeInteger(count) && count >= 0, `背包计数无效：${item}`)
  return count
}

async function prepareArena(tester, c, rcon, waitFor) {
  const corners = [[-12, -12], [-12, 12], [44, -12], [44, 12]]
  await rcon(...(c.forceload ? ['forceload add -16 -16 47 15'] : []), `tp ${TESTER} 16 100 0`)
  await waitFor(() => {
    const p = tester.entity?.position
    return p && Math.hypot(p.x - 16, p.y - 100, p.z) < 1 &&
      corners.every(([x, z]) => tester.blockAt(new Vec3(x, 99, z)))
  }, 30_000, '场地四角区块加载')
  const ground = c.name('grass_block', 'grass')
  await rcon(`fill -12 99 -12 44 99 12 ${ground}`, 'fill -12 100 -12 44 107 12 air')
  const samples = [...corners, [0, 0], [40, 0]]
  let mismatch = []
  try {
    await waitFor(() => {
      mismatch = []
      for (const [x, z] of samples) for (const y of [99, 100, 107]) {
        const expected = y === 99 ? ground : 'air', actual = tester.blockAt(new Vec3(x, y, z))?.name
        if (actual !== expected) mismatch.push(`(${x},${y},${z}) 应为 ${expected}，读到 ${actual || '未加载'}`)
      }
      return !mismatch.length
    }, 15_000, '场地方块核验')
  } catch (err) { throw new Error(`测试场地未建好：${mismatch.join('；')}；${err.message}`) }
}

async function runVersion(version, options, control) {
  const c = commandsFor(version), container = `mc-bot-version-lab-${version.replace(/\./g, '-')}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex'), results = [], chat = [], deaths = new Set(), gone = new Set()
  let sandbox, child, tester, log = '', serverLog = '', exited = false, unexpectedExit = false, cleaning = null
  let testerDisconnected = false, testerClosing = false
  const docker = (...args) => runFile('docker', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  const readServerLog = async () => { const output = await docker('logs', container); return output.stdout + output.stderr }
  const rcon = (...commands) => rconRun({ host: '127.0.0.1', port: options.port + 1, password }, commands)
  const rconReply = async command => (await docker('exec', container, 'rcon-cli', command)).stdout
  const checkLive = () => {
    assert(!control.stopping, '用户中断')
    assert(!exited, '被测机器人提前退出')
    assert(!testerDisconnected, '测试账号已断开')
  }
  async function waitFor(predicate, timeout = 30_000, description = '条件', interval = 200) {
    const deadline = Date.now() + timeout
    do { checkLive(); const value = await predicate(); if (value) return value; await sleep(interval) } while (Date.now() < deadline)
    throw new Error(`等待${description}超时（${timeout / 1000} 秒）`)
  }
  async function check(id, name, fn) {
    const start = Date.now()
    try {
      checkLive()
      const details = await fn()
      results.push({ id, name, status: 'PASS', ms: Date.now() - start, details })
    } catch (err) { results.push({ id, name, status: 'FAIL', ms: Date.now() - start, details: err.details || err.message }) }
    console.log(`[matrix] ${version} ${results.at(-1).status} ${name}`)
  }
  const entity = () => Object.values(tester?.entities || {}).find((entry) => entry.username === NAME)
  const detectedVersion = () => log.match(/\[version\] ([\d.]+)：/)?.[1]
  const position = () => { const p = entity()?.position; return p ? { x: p.x, y: p.y, z: p.z } : null }
  const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity
  async function command(text, pattern, timeout = 30_000) {
    const start = chat.length
    tester.chat(text)
    if (!pattern) return start
    await waitFor(() => chat.slice(start).some((entry) => pattern.test(entry.text)), timeout, `${text} 回复`)
    return chat.slice(start)
  }
  async function stop() {
    await command('bot stop', /停下|停止|降落/, 20_000)
    await sleep(500)
  }
  async function inventoryCount(item) {
    assert(c.registry.itemsByName[item], `${version} 注册表没有物品 ${item}`)
    const start = chat.length
    tester.chat('bot inv')
    const replies = await waitFor(() => {
      const lines = chat.slice(start).filter((entry) => INVENTORY_REPLY.test(entry.text))
      // 回复可能受聊天限速影响，等超过 1.5 秒的发送间隔，收齐分行后再统计。
      return lines.length && Date.now() - lines.at(-1).at >= 2000 ? lines.map((entry) => entry.text) : null
    }, 30_000, 'bot inv 背包计数回复')
    return parseInventoryCount(replies, item)
  }
  async function reset() {
    await stop()
    await command('bot guard off', /关|停|不再/)
    await rcon(`clear ${NAME}`, `tp ${NAME} 0.5 100 0.5`, `tp ${TESTER} -4.5 100 0.5`, 'time set 18000', 'weather clear')
    await waitFor(() => distance(position(), { x: 0.5, y: 100, z: 0.5 }) < 1, 15_000, '机器人回场')
  }
  function closeTester() {
    if (!tester || testerClosing) return
    testerClosing = true
    try {
      if (tester.quit) tester.quit()
      else tester._client?.end?.('matrix complete')
    } catch (err) {
      log += `[tester] 关闭失败：${err.message}\n`
      tester._client?.socket?.destroy()
    }
  }
  async function cleanup() {
    if (cleaning) return cleaning
    cleaning = (async () => {
      closeTester()
      if (child && !exited) {
        child.kill('SIGTERM')
        for (let i = 0; i < 25 && !exited; i++) await sleep(200)
        if (!exited) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)) }
      }
      try { serverLog = await readServerLog() } catch (err) { serverLog += `\n读取服务器日志失败：${err.message}` }
      try { await docker('rm', '-f', '-v', container) } catch (err) {
        if (!/No such container/i.test(err.stderr || '')) results.push({ id: 'cleanup', name: '删除测试容器', status: 'FAIL', details: err.message })
      }
      if (sandbox) await fs.rm(sandbox, { recursive: true, force: true }).catch((err) => results.push({ id: 'sandbox', name: '删除临时副本', status: 'FAIL', details: err.message }))
    })()
    return cleaning
  }
  control.interrupt = () => { child?.kill('SIGTERM'); closeTester() }
  try {
    // 每轮独占随机实验容器名，清理只处理这一轮启动的容器。
    checkLive()
    await docker('run', '-d', '--name', container, '--dns', '223.5.5.5', '--dns', '8.8.8.8',
      '-p', `127.0.0.1:${options.port}:25565`, '-p', `127.0.0.1:${options.port + 1}:25575`,
      ...['EULA=TRUE', 'TYPE=VANILLA', `VERSION=${version}`, 'ONLINE_MODE=FALSE', 'ENABLE_RCON=true', `RCON_PASSWORD=${password}`,
        'MEMORY=1500M', 'SEED=12345', 'SPAWN_PROTECTION=0', 'DIFFICULTY=easy'].flatMap((value) => ['-e', value]), options.image)
    await waitFor(async () => {
      serverLog = await readServerLog()
      return serverLog.includes('Done (')
    }, 360_000, '服务器启动')
    await waitFor(async () => {
      try {
        const status = await ping({ host: '127.0.0.1', port: options.port, version, closeTimeout: 3000, noPongTimeout: 500 })
        return status.version?.protocol === c.registry.version.version
      } catch { return false }
    }, 30_000, '游戏端口返回目标协议')
    sandbox = await copySandbox(options.out)
    tester = mineflayer.createBot({ host: '127.0.0.1', port: options.port, username: TESTER, auth: 'offline', version, viewDistance: 'short' })
    let testerSpawned = false
    tester.physicsEnabled = false
    tester.once('spawn', () => { tester.physicsEnabled = false; testerSpawned = true })
    tester.on('error', (err) => { log += `[tester] ${err.message}\n` })
    tester.once('end', () => { testerDisconnected = true })
    tester.on('kicked', (reason) => { log += `[tester] 被踢：${JSON.stringify(reason)}\n` })
    tester.on('chat', (user, text) => { if (user === NAME) chat.push({ at: Date.now(), text }) })
    tester.on('entityDead', (entry) => deaths.add(entry.id))
    tester.on('entityGone', (entry) => gone.add(entry.id))
    await waitFor(() => testerSpawned, 60_000, '测试账号出生')
    await sleep(1000)
    await rcon(`gamemode creative ${TESTER}`, `gamerule ${c.mobRule} false`, `gamerule ${c.inventoryRule} true`)
    // 场地不成立就抛到启动失败分支，不再启动机器人或执行后续项目。
    await prepareArena(tester, c, rcon, waitFor)
    await rcon('setworldspawn 0 100 0')
    const env = { ...process.env, MC_HOST: '127.0.0.1', MC_PORT: String(options.port), MC_NAME: NAME, MC_VERSION: '', AI_PROVIDER: 'off',
      MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(options.port + 1), MC_RCON_PASSWORD: password,
      MC_CTL: '', MC_AGENT_PORT: '', MC_AUTONOMY: 'off', MC_MODS: '', MC_MODS_DISABLE: '' }
    child = spawn(process.execPath, ['--max-old-space-size=256', 'bot.js'], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => { log += chunk.toString() })
    child.stderr.on('data', (chunk) => { log += chunk.toString() })
    child.on('error', (err) => { exited = true; log += `[child] ${err.message}\n` })
    child.on('exit', (code, signal) => { exited = true; unexpectedExit = !cleaning && !control.stopping; log += `[child] 退出 ${code} ${signal || ''}\n` })
    await waitFor(() => log.includes('[spawn]'), 60_000, '被测机器人出生')
    await sleep(1000)
    await rcon(`tp ${TESTER} -4.5 100 0.5`, `tp ${NAME} 0.5 100 0.5`)
    await waitFor(() => distance(position(), { x: 0.5, y: 100, z: 0.5 }) < 2, 15_000, '测试账号看到机器人回场')
    await check(1, '自动检测版本', async () => {
      const detected = detectedVersion()
      assert(detected && mcData(detected)?.version.version === c.registry.version.version, `请求 ${version}，日志检测 ${detected}`)
      assert(tester.registry.version.version === c.registry.version.version, `测试账号检测成 ${tester.version}`)
      return { requested: version, detected, tester: tester.version, protocol: c.registry.version.version }
    })
    await check(2, '版本日志和世界上下界', async () => {
      const facts = versionFacts(tester), line = log.split('\n').find((entry) => entry.includes('[version]'))
      assert(line?.includes(`世界 ${facts.minY}~${facts.maxY}`), `服务器 ${facts.minY}~${facts.maxY}；日志 ${line}`)
      return { line, minY: tester.game.minY, height: tester.game.height, facts: [facts.minY, facts.maxY] }
    })
    await check(3, 'pos/help/inv 回复', async () => {
      const replies = {}
      for (const [cmd, pattern] of [['pos', /我在/], ['help', /bot |指令/], ['inv', /背包|空/]]) replies[cmd] = await command(`bot ${cmd}`, pattern)
      return replies
    })
    await check(4, '现代原木名挖掘和旧名别名', async () => {
      await reset()
      const item = c.name('oak_log', 'log'), before = await inventoryCount(item)
      await rcon(`setblock 2 100 0 ${item}`, `setblock 2 101 0 ${item}`)
      await waitFor(() => tester.blockAt(new Vec3(2, 100, 0))?.name === item, 6000, '原木生成')
      await sleep(900)
      const reply = await command('bot mine oak_log 2', /挖完了|只挖到|找不到|不认识/, 60_000)
      const after = await inventoryCount(item)
      assert(after - before >= 2, `原木 ${before}→${after}，${reply.map((entry) => entry.text).join('；')}`)
      return { item, before, after, reply }
    })
    await check(5, '合成工作台', async () => {
      await reset()
      await rcon(c.give(c.name('oak_planks', 'planks'), 4))
      await sleep(900)
      const reply = await command('bot craft crafting_table 1', /做好|做了|做不了|不认识|缺/, 30_000)
      const count = await inventoryCount(c.name('crafting_table'))
      assert(count >= 1, `工作台 ${count} 个，${reply.map((entry) => entry.text).join('；')}`)
      return { count, reply }
    })
    await check(6, '挖掘另一种方块', async () => {
      await reset()
      await rcon('setblock 2 100 0 dirt', 'setblock 3 100 0 dirt')
      await waitFor(() => tester.blockAt(new Vec3(2, 100, 0))?.name === 'dirt', 6000, '泥土生成')
      await sleep(900)
      const reply = await command('bot mine dirt 2', /挖完了|只挖到|找不到/, 60_000)
      const count = await inventoryCount(c.name('dirt'))
      assert(count >= 2, `泥土 ${count} 个`)
      return { count, reply }
    })
    await check(7, '持剑守卫杀死僵尸', async () => {
      await reset()
      assert(c.registry.itemsByName.iron_sword, `${version} 注册表没有铁剑（iron_sword）`)
      await rcon(c.give('iron_sword'))
      assert(await inventoryCount('iron_sword') >= 1, `${version} 铁剑发放失败，机器人背包没有 iron_sword`)
      await rconReply(`scoreboard objectives add ${ZOMBIE_SCORE} ${c.zombieCriterion}`)
      await rconReply(`scoreboard players set ${NAME} ${ZOMBIE_SCORE} 0`)
      const score = async () => parseZombieScore(await rconReply(c.readZombieScore), c.modern)
      const before = await score()
      assert(before === 0, `僵尸计分板初始值是 ${before}`)
      const ids = new Set(Object.keys(tester.entities)), tag = 'VmZombie'
      const summon = c.summon(4.5, 100, 0.5, tag)
      await rcon(summon)
      let zombie
      try {
        zombie = await waitFor(() => Object.values(tester.entities).find((entry) => !ids.has(String(entry.id)) && entry.name?.toLowerCase() === c.zombie.toLowerCase()), 10_000, '僵尸出现')
      } catch (err) { throw new Error(`${version} 僵尸召唤失败，未观察到实体；指令：${summon}；${err.message}`) }
      try {
        await command('bot guard on', /自卫已开/)
        const after = await waitFor(async () => {
          const value = await score()
          assert(value <= before + 1, `本轮击杀计数意外增加到 ${value}`)
          return value === before + 1 ? value : false
        }, 30_000, '服务器确认机器人击杀一只僵尸', 600)
        return { entity: zombie.id, deathEvent: deaths.has(zombie.id), gone: gone.has(zombie.id), criterion: c.zombieCriterion, before, after }
      } finally {
        if (!exited && !testerDisconnected && !control.stopping) await command('bot guard off', /自卫已关/, 6000).catch(err => { log += `[matrix] ${err.message}\n` })
      }
    })
    await check(8, 'come 走到测试账号四格内', async () => {
      await reset()
      await rcon(`tp ${TESTER} 20.5 100 0.5`)
      await waitFor(() => Math.abs(tester.entity.position.x - 20.5) < 1)
      await sleep(900)
      tester.chat('bot come')
      await waitFor(() => distance(position(), tester.entity.position) <= 4, 60_000, 'come 到达')
      return { bot: position(), tester: { ...tester.entity.position } }
    })
    await check(9, 'goto 三十格与途中 stop', async () => {
      await reset()
      const target = { x: 30.5, y: 100, z: 0.5 }
      await command('bot goto 30 100 0', /到了|未到目标|没走到|找不到|失败/, 60_000)
      assert(distance(position(), target) <= 3, `没有到达：${JSON.stringify(position())}`)
      const start = position(), second = { x: -9.5, y: 100, z: 0.5 }
      tester.chat('bot goto -10 100 0')
      await waitFor(() => position()?.x < start.x - 2, 15_000, '第二程确认已开始移动')
      await stop()
      const stopped = position()
      await sleep(2500)
      assert(stopped && distance(stopped, second) > 4 && distance(position(), stopped) < 1, `途中 stop 未通过：${JSON.stringify({ stopped, after: position() })}`)
      return { target, second, stopped, after: position() }
    })
    if (options.flight) await check(11, '四百格自动交通与飞行证据', async () => {
      await reset()
      const detected = detectedVersion()
      assert(detected, '没有机器人版本检测回执，无法验证自动交通')
      const verified = flightVerified(detected), targetX = 400.5, targetZ = 0.5
      if (c.facts.elytra) await rcon(c.give(c.name('elytra')), c.rocketGive())
      if (!verified) {
        // 非白名单只观察场地上的交通选择，及时停下，不要求走完四百格。
        const rocketsBefore = c.facts.elytra ? await inventoryCount(c.facts.rocketItem) : 0
        const mark = log.length, start = chat.length
        try { await command('bot goto 400 100 0', /步行/, 20_000) } finally { await stop() }
        const rocketsAfter = c.facts.elytra ? await inventoryCount(c.facts.rocketItem) : 0
        const lines = log.slice(mark), replies = chat.slice(start)
        const walking = replies.some((entry) => /步行/.test(entry.text)), usedFlight = /\[flight\].*CLIMB/.test(lines)
        const details = { detected, verified, elytraAvailable: c.facts.elytra, target: { x: targetX, y: 100, z: targetZ },
          walking, usedFlight, rocketsBefore, rocketsAfter, replies, log: lines, stopped: position() }
        if (!walking || usedFlight || rocketsBefore !== rocketsAfter) throw Object.assign(new Error('非白名单步行选择或火箭核验失败'), { details })
        return details
      }
      // 先让测试账号加载目的地，地面高度取真实方块，不把空中的 y=200 当落点。
      await rcon(`tp ${TESTER} ${targetX} 200 ${targetZ}`)
      await waitFor(() => Math.abs(tester.entity.position.x - targetX) < 1)
      await waitFor(() => tester.blockAt(new Vec3(400, 100, 0)), 30_000, '目的地区块加载')
      const top = c.facts.maxY
      let targetY = null
      for (let y = top; y >= c.facts.minY; y--) {
        const block = tester.blockAt(new Vec3(400, y, 0))
        if (block && block.boundingBox === 'block') { targetY = y + 1; break }
      }
      assert(targetY !== null && targetY <= c.facts.maxY, '读不到目的地地面')
      // 自动飞行要求站稳起飞；白名单版本给一个临时起飞台，飞离后再删，下面仍是自然地形。
      await rcon(`fill -3 199 -4 3 199 4 ${c.name('grass_block', 'grass')}`, 'fill -3 200 -4 3 224 4 air')
      await rcon(c.effect('resistance', 11), c.effect('saturation', 23), `tp ${NAME} 0.5 200 0.5`, `tp ${TESTER} -2.5 200 0.5`)
      await waitFor(() => position()?.y >= 198, 10_000, '高处传送')
      const highStart = position()
      let lastY = null, stable = 0
      await waitFor(() => {
        const y = position()?.y
        stable = y !== undefined && lastY !== null && Math.abs(y - lastY) < 0.01 ? stable + 1 : 0
        lastY = y
        return stable >= 5 && y >= 199.9
      }, 20_000, '稳定落脚')
      const rocketsBefore = c.facts.elytra ? await inventoryCount(c.facts.rocketItem) : 0
      const mark = log.length, start = chat.length
      let lastFollow = 0
      const observed = [], observe = () => { const p = position(); if (p) observed.push({ at: Date.now(), ...p }) }
      tester.chat(`bot goto 400 ${targetY} 0`)
      let failure = null
      try { await waitFor(async () => {
        observe()
        const p = position()
        if (p && Date.now() - lastFollow > 1000) {
          // 让观察账号保持在可见范围，留出距离，避免挤到被测机器人。
          await rcon(`tp ${TESTER} ${p.x} ${p.y + 8} ${p.z + 12}`)
          lastFollow = Date.now()
        }
        return chat.slice(start).some((entry) => /到了 |未到目标，停在/.test(entry.text))
      }, 180_000, '四百格交通结果') } catch (err) { failure = err.message }
      const lines = log.slice(mark), replies = chat.slice(start), reached = distance(position(), { x: targetX, y: targetY, z: targetZ }) <= 4
      const rocketsAfter = c.facts.elytra ? await inventoryCount(c.facts.rocketItem) : 0
      const usedFlight = /\[flight\].*(?:CLIMB|CRUISE)/.test(lines)
      const flightReceipt = replies.some((entry) => /到了 .*使用鞘翅/.test(entry.text))
      const walking = replies.some((entry) => /到了 .*步行/.test(entry.text))
      const details = { detected, verified, elytraAvailable: c.facts.elytra, highStart, target: { x: targetX, y: targetY, z: targetZ }, reached,
        usedFlight, flightReceipt, walking, rocketsBefore, rocketsAfter, replies, observed, log: lines, failure }
      if (failure || !reached || !usedFlight || !flightReceipt || rocketsAfter >= rocketsBefore) {
        throw Object.assign(new Error('自动交通未通过'), { details })
      }
      await rcon('fill -3 199 -4 3 199 4 air')
      return details
    })
  } catch (err) {
    results.push({ id: 'setup', name: '启动与运行', status: 'FAIL', details: err.message })
  } finally {
    await cleanup()
    control.interrupt = null
  }
  const errors = log.split('\n').filter((line) => /TypeError|ReferenceError|uncaught|unhandled(?:Rejection| rejection)|未捕获异常/i.test(line))
  results.push({ id: 10, name: '日志没有程序异常', status: errors.length || unexpectedExit || !log.includes('[spawn]') ? 'FAIL' : 'PASS', details: { errors, unexpectedExit } })
  for (const id of [...Array.from({ length: 10 }, (_, i) => i + 1), ...(options.flight ? [11] : [])]) {
    if (!results.some((result) => result.id === id)) results.push({ id, name: `检查 ${id}`, status: 'FAIL', details: '前置启动失败，未执行' })
  }
  results.sort((a, b) => Number(a.id) - Number(b.id))
  const result = { version, image: options.image, at: new Date().toISOString(), interrupted: control.stopping,
    ok: results.every((entry) => entry.status === 'PASS'), checks: results, log, serverLog, chat }
  // 容器启动日志有可能打印环境变量；证据中去掉本次随机 RCON 密码。
  const json = JSON.stringify(result, null, 2).replaceAll(password, '[已隐藏]')
  await fs.writeFile(path.join(options.out, `${version}.json`), json + '\n', { mode: 0o600 })
  await fs.writeFile(path.join(options.out, `${version}.txt`), results.map((entry) => `${entry.status} ${entry.id}. ${entry.name}\n${JSON.stringify(entry.details)}`).join('\n')
    .replaceAll(password, '[已隐藏]') + '\n\n--- 机器人日志 ---\n' + log.replaceAll(password, '[已隐藏]') + '\n\n--- 服务器日志 ---\n' + serverLog.replaceAll(password, '[已隐藏]'), { mode: 0o600 })
  return { version, ok: result.ok, checks: JSON.parse(json).checks.map(({ id, name, status, details }) => ({ id, name, status, details })) }
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args), control = { stopping: false, interrupt: null }, results = []
  await fs.mkdir(options.out, { recursive: true, mode: 0o700 })
  const interrupt = () => { control.stopping = true; control.interrupt?.() }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    for (const version of options.versions) {
      if (control.stopping) break
      results.push(await runVersion(version, options, control))
      // 清理失败时停止矩阵，避免下一服与未删掉的容器同时占用内存。
      if (results.at(-1).checks.some((entry) => entry.id === 'cleanup' && entry.status === 'FAIL')) break
    }
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    const ok = !control.stopping && results.length === options.versions.length && results.every((entry) => entry.ok)
    await fs.writeFile(path.join(options.out, 'summary.json'), JSON.stringify({ ok, interrupted: control.stopping, requested: options.versions, results }, null, 2) + '\n', { mode: 0o600 })
    process.exitCode = ok ? 0 : 1
  }
}

if (require.main === module) main().catch((err) => { console.error(`[matrix] ${err.message}`); process.exitCode = 1 })
module.exports = { parseArgs, includeFile, commandsFor, parseInventoryCount, parseZombieScore, prepareArena }
