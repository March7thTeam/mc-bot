'use strict'
// 经验记忆（参考 JARVIS-1 / Optimus-1 的“成功计划 + 失败反思”，检索退化成 Mindcraft 的词重叠，不依赖嵌入模型）。
// 只记程序看到的结果：做成了没有、用了哪些动作、哪里反复失败。模型自己的说法不进来。
const path = require('path')
const { readJSON, writeJSON } = require('./storage')

const FILE = path.join(__dirname, 'data', 'experience.json')
const MAX_ENTRIES = 50
const MAX_BYTES = 30_000
const MIN_SCORE = 0.2
// 口头语不算相似（实测：“帮我做铁镐”和“帮我砍树”只因“帮我”就匹配上）
const FILLER = new Set(['帮我', '给我', '我要', '我想', '一下', '一个', '一些', '然后', '记得', '可以', '能不', '不能'])
const short = (v, max) => String(v).replace(/[\p{Cc}\p{Cf}]/gu, ' ').toWellFormed().trim().slice(0, max)

// 英文按词，中文按相邻两字
function tokens(text) {
  const out = new Set()
  const s = String(text).toLowerCase()
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  for (const run of s.match(/\p{Script=Han}+/gu) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) if (!FILLER.has(run.slice(i, i + 2))) out.add(run.slice(i, i + 2))
  }
  return out
}
function similarity(a, b) {
  const x = tokens(a), y = tokens(b)
  if (!x.size || !y.size) return 0
  let hit = 0
  for (const t of x) if (y.has(t)) hit++
  return hit / Math.sqrt(x.size * y.size)
}
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.goal !== 'string' || !e.goal.trim() || !['done', 'failed', 'unverified'].includes(e.outcome)) return null
  const list = (v, n, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => short(x, max)) : [])
  return { goal: short(e.goal, 80), outcome: e.outcome, rounds: Number.isSafeInteger(e.rounds) && e.rounds > 0 ? e.rounds : 1, steps: list(e.steps, 10, 24), why: list(e.why, 3, 40), ...(e.conditionVerified === true ? { conditionVerified: true } : {}), at: Number.isFinite(e.at) ? e.at : 0 }
}
function format(e) {
  const steps = e.steps.length ? `：${e.steps.join(' → ')}` : ''
  if (e.outcome === 'done' && e.conditionVerified) return `「${e.goal}」当前条件已核对（不证明由Bot造成）${steps}`
  if (e.outcome === 'unverified') return `「${e.goal}」处理结束但未完整核验${steps}`
  return e.outcome === 'done' ? `「${e.goal}」做成了（${e.rounds} 轮）${steps}` : `「${e.goal}」没做成${e.why.length ? `，卡在 ${e.why.join('、')}` : ''}${steps}`
}

function createExperience({ file = FILE, now = Date.now } = {}) {
  const saved = readJSON(file, {})
  let entries = Array.isArray(saved?.entries) ? saved.entries.map(cleanEntry).filter(Boolean).slice(-MAX_ENTRIES) : []
  function persist() {
    while (entries.length > 1 && Buffer.byteLength(JSON.stringify({ entries }, null, 2)) > MAX_BYTES) entries.shift()
    try { writeJSON(file, { entries }) } catch (err) { console.log('[experience] 保存失败', err.message) }
  }
  return {
    // 同一件事只留最新结果：后来做成了，旧的失败就不该再劝退
    record(raw) {
      const e = cleanEntry({ ...raw, at: now() })
      if (!e) return false
      entries = [...entries.filter((o) => o.goal !== e.goal), e].slice(-MAX_ENTRIES)
      persist()
      return true
    },
    recall(text, limit = 3) {
      return entries.map((e) => ({ e, score: similarity(text, e.goal) }))
        .filter((x) => x.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score || b.e.at - a.e.at)
        .slice(0, limit).map((x) => format(x.e))
    },
    recent: (limit = 5) => entries.slice(-limit).map(format),
    clear() { entries = []; persist() },
  }
}

module.exports = { createExperience, similarity, tokens }
