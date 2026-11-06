#!/usr/bin/env node
// MCP 服务器（stdio）：把机器人的本机 Agent API 包成 MCP 工具，Claude Code、Claude Desktop、Cursor 等可以直接操控机器人。
// 只做转发：所有校验和权限都在机器人那边。需要机器人开着 Agent API。
//
// 环境变量：MC_AGENT_TOKEN（必填，同机器人的 .env）、MC_AGENT_URL（默认 http://127.0.0.1:${MC_AGENT_PORT||25599}/v1）
// Claude Code 里注册：claude mcp add minecraft -e MC_AGENT_TOKEN=... -- node /path/to/mc-bot/scripts/mcp-server.js
const readline = require('node:readline')

const TOKEN = process.env.MC_AGENT_TOKEN || ''
const BASE = (process.env.MC_AGENT_URL || `http://127.0.0.1:${process.env.MC_AGENT_PORT || 25599}/v1`).replace(/\/+$/, '')
const VERSION = require('../package.json').version

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const TOOLS = [
  { name: 'minecraft_state', description: '机器人当前状态：坐标、血量、饥饿、维度、背包、正在做的任务、附近玩家', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => api('GET', '/state') },
  { name: 'minecraft_memories', description: '检索当前世界长期记忆：门户、结构候选、设施与行动经历。历史线索需要现场复核；本工具不修改或确认事实',
    inputSchema: { type: 'object', properties: { query: str('可选关键词', { maxLength: 120 }) }, additionalProperties: false },
    call: (a) => api('POST', '/command', { cmd: 'memories', args: a.query ? [a.query] : [], wait: true }) },
  { name: 'minecraft_commands', description: '列出可用指令（含模组扩展注册的）和用法', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => api('GET', '/commands') },
  { name: 'minecraft_command', description: '让机器人执行一条固定指令，和玩家说 "bot <cmd> <args>" 一样，同样的参数校验。默认等它做完再返回结果（最长 10 分钟）',
    inputSchema: { type: 'object', properties: { cmd: str('指令名，比如 mine、goto、craft、get'), args: { type: 'array', items: { type: 'string' }, maxItems: 8, description: '参数，比如 ["iron_ore","8"]' }, wait: { type: 'boolean', description: '等做完再返回，默认 true' } }, required: ['cmd'], additionalProperties: false },
    call: (a) => api('POST', '/command', a) },
  { name: 'minecraft_say', description: '让机器人在公屏说一句话（以 / 开头的会被改写，不能执行服务器指令）',
    inputSchema: { type: 'object', properties: { text: str('要说的话，最多 600 字') }, required: ['text'], additionalProperties: false },
    call: (a) => api('POST', '/say', a) },
  { name: 'minecraft_ask', description: '用机器人内置的 AI 理解一句自然语言并执行（需要机器人配置了 AI）',
    inputSchema: { type: 'object', properties: { text: str('比如 "砍 16 个木头做个箱子"') }, required: ['text'], additionalProperties: false },
    call: (a) => api('POST', '/ask', a) },
  { name: 'minecraft_stop', description: '立即停下机器人正在做的所有事', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => api('POST', '/stop', {}) },
  { name: 'minecraft_workflows', description: '列出 workflows/ 里定义的工作流', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    call: () => api('GET', '/workflows') },
  { name: 'minecraft_run_workflow', description: '运行一个工作流',
    inputSchema: { type: 'object', properties: { name: str('工作流 id') }, required: ['name'], additionalProperties: false },
    call: (a) => { if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(a.name || '')) throw new Error('工作流 id 不合法'); return api('POST', `/workflows/${a.name}/run`) } },
  { name: 'minecraft_events', description: '取最近发生的事（聊天、玩家叫机器人、任务开始结束、死亡）。传上次返回的 last 只取新的',
    inputSchema: { type: 'object', properties: { since: { type: 'integer', minimum: 0, description: '上次结果里的 last' } }, additionalProperties: false },
    call: (a) => api('GET', `/events/recent?since=${Number.isSafeInteger(a.since) ? a.since : 0}`) },
]

async function api(method, path, body) {
  if (!TOKEN) throw new Error('没设置 MC_AGENT_TOKEN')
  const res = await fetch(BASE + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(11 * 60_000),
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((err) => { throw new Error(`连不上机器人的 Agent API（${BASE}）：${err.cause?.code || err.message}`) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => out({ jsonrpc: '2.0', id, result })
const error = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mc-bot', version: VERSION } })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ call, ...t }) => t) })
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) return error(id, -32602, `没有工具 ${String(params?.name).slice(0, 64)}`)
    try {
      const result = await tool.call(params.arguments || {})
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: err.message }], isError: true })
    }
  }
  if (id !== undefined) error(id, -32601, `不支持 ${String(method).slice(0, 64)}`)
  // 没有 id 的是通知（notifications/initialized 等），不用回
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return error(null, -32700, 'JSON 解析失败') }
    handle(msg).catch((err) => error(msg.id ?? null, -32603, err.message))
  })
}

module.exports = { handle, TOOLS }
