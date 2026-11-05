// 有人上线时私聊打招呼。带颜色、渐变、标题、音效、粒子的特效需要 /tellraw 等管理员指令，
// 无需给机器人 OP：通过服务器标准 RCON 接口发送，只发给上线的那个人。
//   MC_RCON_PASSWORD（+ MC_RCON_HOST、MC_RCON_PORT）：直接走 RCON
// 未配置或不可用时退回普通 /msg 私聊。
const { rconRun } = require('./rcon')

const USERNAME = /^[A-Za-z0-9_]{1,16}$/
const COOLDOWN = 10 * 60_000 // 同一个人 10 分钟内重进不再打招呼
const GRADIENT = ['#FF5F6D', '#FF8C5A', '#FFC371', '#7CF29A', '#47C9FF', '#8E7CFF', '#E36BFF']

// 把文字染成渐变色（两个字一段）
function gradient(text, extra = {}) {
  const chars = [...text]
  const parts = []
  for (let i = 0; i < chars.length; i += 2) parts.push(chars.slice(i, i + 2).join(''))
  return parts.map((t, i) => ({ text: t, color: GRADIENT[Math.round(i * (GRADIENT.length - 1) / Math.max(parts.length - 1, 1))], ...extra }))
}

function timeGreeting(hour) {
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

// 生成要在控制台执行的指令（纯函数，方便测试）
function greetingCommands(name, botName, { hour = new Date().getHours(), online = 1, serverName = '' } = {}) {
  if (!USERNAME.test(name)) throw new Error('玩家名不合法')
  const server = serverNameOf(serverName)
  const sparkle = { text: '✦✧', color: '#FFD700', obfuscated: true }
  const arrow = { text: '  ➤ ', color: 'dark_gray' }
  // RCON 单条指令上限约 1446 字节（中文 3 字节一个），所以一行一条 tellraw
  const lines = [
    [sparkle, ' ', ...gradient(`${botName} 悄悄对你说`, { bold: true }), ' ', sparkle],
    [arrow, { text: `${timeGreeting(hour)}，`, color: 'white' },
      { text: name, color: 'gold', bold: true },
      ...(server ? [{ text: '！欢迎回到 ', color: 'white' }, ...gradient(server, { italic: true })] : [{ text: '！欢迎回来', color: 'white' }])],
    [arrow, { text: `现在有 ${online} 位伙伴在线，我随时帮你干活`, color: 'gray' }],
    [arrow, { text: '说 ', color: 'gray' },
      { text: '[bot help]', color: 'aqua', underlined: true,
        click_event: { action: 'suggest_command', command: 'bot help' },
        hover_event: { action: 'show_text', value: { text: '点一下填进聊天框：挖矿·砍树·合成·烧炉·打怪·跟随', color: 'yellow' } } },
      { text: ' 或 ', color: 'gray' },
      { text: '[bot 帮我…]', color: 'light_purple', underlined: true,
        click_event: { action: 'suggest_command', command: 'bot 帮我' },
        hover_event: { action: 'show_text', value: { text: '用大白话告诉我要做什么', color: 'yellow' } } }],
  ]
  const title = gradient('✦ 欢迎回来 ✦', { bold: true })
  const subtitle = [{ text: name, color: 'gold' }, { text: ` · ${botName} 向你问好`, color: 'gray' }]
  const json = (v) => JSON.stringify(v)
  return [
    ...lines.map((l) => `tellraw ${name} ${json(['', ...l])}`),
    `title ${name} times 10 50 20`,
    `title ${name} subtitle ${json(subtitle)}`,
    `title ${name} title ${json(title)}`,
    `execute as ${name} at @s run playsound minecraft:entity.player.levelup master @s ~ ~ ~ 0.6 1.4`,
    `execute as ${name} at @s run playsound minecraft:block.amethyst_block.chime master @s ~ ~ ~ 1 1.2`,
    `execute at ${name} run particle minecraft:totem_of_undying ~ ~1 ~ 0.6 0.8 0.6 0.35 60 normal ${name}`,
    `execute at ${name} run particle minecraft:end_rod ~ ~1.2 ~ 0.8 0.6 0.8 0.03 25 normal ${name}`,
  ]
}

// 服务器名只用于欢迎语：单行、最长 32 字，不合格就不写
function serverNameOf(value) {
  const s = String(value || '').trim()
  return s.length <= 32 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s) ? s : ''
}

// 按环境变量选控制台；返回 null 表示没有控制台，只能 /msg
function consoleFrom(env) {
  if (env.MC_RCON_PASSWORD) {
    const port = Number(env.MC_RCON_PORT || 25575)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MC_RCON_PORT 不是合法端口')
    const options = { host: env.MC_RCON_HOST || env.MC_HOST || '127.0.0.1', port, password: env.MC_RCON_PASSWORD }
    return (commands) => rconRun(options, commands)
  }
  return null
}

function createGreeter(bot, ctx, env = process.env) {
  let run = null
  try { run = consoleFrom(env) } catch (err) { ctx.log(`[greet] ${err.message}，只用 /msg 打招呼`) }
  const serverName = env.MC_SERVER_NAME || ''
  const greeted = new Map()
  let readyAt = Infinity
  let queue = Promise.resolve()

  async function greet(name) {
    const online = Object.keys(bot.players).filter((n) => n !== bot.username).length
    if (run) {
      try {
        await run(greetingCommands(name, bot.username, { online, serverName }))
        ctx.log(`[greet] ${name}（特效）`)
        return
      } catch (err) {
        ctx.log(`[greet] 控制台不可用，改用 /msg: ${err.message.split('\n')[0]}`)
      }
    }
    ctx.chat(`/msg ${name} ${timeGreeting(new Date().getHours())}，${name}！欢迎回来～我是 ${bot.username}，说 bot help 看我能帮你做什么`)
  }

  // 刚进服时会收到所有已在线玩家的 playerJoined，跳过这批，免得每次重启都把大家问候一遍
  bot.once('spawn', () => { readyAt = Date.now() + 5000 })
  bot.on('playerJoined', (player) => {
    const name = player?.username
    if (Date.now() < readyAt || !name || name === bot.username || !USERNAME.test(name)) return
    if (Date.now() - (greeted.get(name) ?? 0) < COOLDOWN) return
    greeted.set(name, Date.now())
    // 等对方加载完世界再发，否则标题和粒子会错过
    queue = queue.then(() => new Promise((r) => setTimeout(r, 4000)))
      .then(() => (bot.players[name] ? greet(name) : null))
      .catch((err) => ctx.log(`[greet] ${err.message}`))
  })
  return { greet }
}

module.exports = { createGreeter, greetingCommands, consoleFrom }
