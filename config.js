// 可选的 config.json：把常用设置写在一个文件里。规则：
// - 环境变量优先（包括 .env 和进程管理器提供的变量，不会被文件覆盖）
// - 只认下面列出的键，类型和范围不对直接报错，不猜
// - 密钥（API key、RCON 密码、Agent 令牌）只能放 .env：文件里出现 key/password/token/secret 一类的键直接拒绝，免得被提交进 git
const fs = require('node:fs')
const path = require('node:path')

const str = (max) => (v) => { if (typeof v !== 'string' || !v || v.length > max || /[\r\n\0]/.test(v)) throw new Error(`必须是 1 到 ${max} 个字符的单行文本`); return v }
const int = (min, max) => (v) => { if (!Number.isInteger(v) || v < min || v > max) throw new Error(`必须是 ${min} 到 ${max} 的整数`); return String(v) }
const bool = (v) => { if (typeof v !== 'boolean') throw new Error('必须是 true 或 false'); return v ? 'on' : 'off' }
const oneOf = (...xs) => (v) => { if (!xs.includes(v)) throw new Error(`只能是 ${xs.join('/')}`); return v }
const list = (re, max) => (v) => { if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !re.test(x))) throw new Error(`必须是最多 ${max} 项、每项匹配 ${re} 的数组`); return v.join(',') }

// 文件里的键 → 环境变量
const KEYS = {
  'server.host': ['MC_HOST', str(253)],
  'server.port': ['MC_PORT', int(1, 65535)],
  'server.username': ['MC_NAME', (v) => { if (!/^[A-Za-z0-9_]{3,16}$/.test(v)) throw new Error('只能是 3 到 16 位字母数字下划线'); return v }],
  'server.version': ['MC_VERSION', (v) => { if (!/^\d+\.\d+(\.\d+)?$/.test(v)) throw new Error('写成 26.1 或 1.21.4 这样；留空自动检测'); return v }],
  'server.viewDistance': ['MC_VIEW', oneOf('tiny', 'short', 'normal', 'far')],
  'chat.prefixes': ['MC_PREFIX', list(/^[A-Za-z\p{Script=Han}][\w\p{Script=Han}]{0,11}$/u, 4)],
  'ai.provider': ['AI_PROVIDER', oneOf('deepseek', 'openai', 'anthropic', 'external', 'off')],
  'ai.model': ['AI_MODEL', str(80)],
  'ai.baseUrl': ['AI_BASE_URL', str(300)],
  'ai.jsonMode': ['AI_JSON_MODE', bool],
  'ai.thinking': ['AI_THINKING', bool],
  'ai.fallbacks': ['AI_FALLBACKS', bool],
  'ai.perMinute': ['AI_RPM', int(1, 60)],
  'ai.perHour': ['AI_RPH', int(1, 2000)],
  'agent.port': ['MC_AGENT_PORT', int(1024, 65535)],
  'agent.host': ['MC_AGENT_HOST', str(64)],
  'mods.enable': ['MC_MODS', list(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 64)],
  'mods.disable': ['MC_MODS_DISABLE', list(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 64)],
  'memory.world': ['MC_MEMORY_WORLD', (v) => { if (typeof v !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(v)) throw new Error('必须是1到64位稳定世界标识'); return v }],
  'memory.observe': ['MC_MEMORY_OBSERVE', bool],
  'workflows.auto': ['MC_WORKFLOWS_AUTO', bool],
  'autonomy.enabled': ['MC_AUTONOMY', bool],
  'autonomy.tickMs': ['MC_AUTONOMY_TICK', int(1000, 60000)],
  'autonomy.maxPerHour': ['MC_AUTONOMY_MAX', int(1, 240)],
  'greet.serverName': ['MC_SERVER_NAME', str(32)],
  'greet.rconHost': ['MC_RCON_HOST', str(253)],
  'greet.rconPort': ['MC_RCON_PORT', int(1, 65535)],
}
const SECRET = /(key|password|passwd|token|secret)/i

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (SECRET.test(k)) throw new Error(`${full}: 密钥只能放 .env，不能写进 config.json`)
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, full, out)
    else out[full] = v
  }
  return out
}

// 读 config.json 并把没设过的环境变量补上；返回补了哪些（日志用，不含值）
function loadConfig({ file = process.env.MC_CONFIG || path.join(__dirname, 'config.json'), env = process.env } = {}) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return []; throw new Error(`读不了 ${path.basename(file)}: ${err.message}`) }
  if (text.length > 64 * 1024) throw new Error('config.json 超过 64KB')
  let raw
  try { raw = JSON.parse(text) } catch (err) { throw new Error(`config.json 不是合法 JSON: ${err.message}`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json 顶层必须是对象')
  const applied = []
  for (const [key, value] of Object.entries(flatten(raw))) {
    if (key.startsWith('$') || key.startsWith('_')) continue // "$comment" 之类的注释键
    const spec = KEYS[key]
    if (!spec) throw new Error(`config.json 里不认识的设置 ${key}`)
    let converted
    try { converted = spec[1](value) } catch (err) { throw new Error(`config.json 的 ${key} ${err.message}`) }
    if (env[spec[0]] === undefined || env[spec[0]] === '') { env[spec[0]] = converted; applied.push(key) }
  }
  return applied
}

module.exports = { loadConfig, KEYS }
