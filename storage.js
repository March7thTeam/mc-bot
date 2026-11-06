const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function readJSON(file, fallback, maxBytes = 32_768) {
  try {
    const stat = fs.statSync(file)
    if (stat.size > maxBytes) throw new Error('数据文件超过大小上限')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[storage] ${path.basename(file)} 未加载：${err.message}`)
    return fallback
  }
}

function writeJSON(file, data, maxBytes = 32_768) {
  const encoded = JSON.stringify(data, null, 2)
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error('数据超过大小上限')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, encoded, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    try { fs.unlinkSync(temp) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
}

module.exports = { readJSON, writeJSON }
