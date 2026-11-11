/**
 * lib/audit.mjs —— 写操作审计（评论 / 发博 / 回评）
 *
 * 只追加 JSONL，成功和失败都记：贴吧那边就是这么做的。
 * 好处是「到底发没发出去」不用翻日志、不用猜，直接看 audit.jsonl。
 *
 * 另一个用途：连续失败自动停手。同一种动作连续失败 3 次（6 小时内），
 * 就先不让发了 —— 多半是 cookie 过期或被风控，再试只会把账号推得更深。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir } from './config.mjs'

/** 只读文件尾部这么多字节，别把整个文件读进内存 */
const TAIL_BYTES = 512 * 1024

export const auditFile = () => path.join(dir(), 'audit.jsonl')

let chmoded = false

export function audit(entry = {}) {
  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.appendFileSync(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
    if (!chmoded) {
      chmoded = true
      try { fs.chmodSync(auditFile(), 0o600) } catch { /* ignore */ }
    }
  } catch { /* 审计写不进不影响主流程 */ }
}

function tailRows(tail = 400) {
  try {
    const fd = fs.openSync(auditFile(), 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    fs.closeSync(fd)
    return String(buf).split('\n').filter(Boolean).slice(-tail)
  } catch {
    return []
  }
}

/** 某类动作最近连续失败了几次（从后往前数，遇到成功或太久之前就停） */
export function consecutiveFailures(kind, { maxAgeMs = 6 * 3600_000 } = {}) {
  const rows = tailRows()
  let n = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    let x
    try { x = JSON.parse(rows[i]) } catch { continue }
    if (x.kind !== kind) continue
    if (Date.now() - (Date.parse(x.at) || 0) > maxAgeMs) break
    if (x.ok === true) break
    n += 1
  }
  return n
}

/** 连续失败到阈值就返回一句停手理由，否则 null */
export function failTripped(kind, limit = 3) {
  const n = consecutiveFailures(kind)
  if (n < limit) return null
  return `最近连续 ${n} 次${kind === 'post' ? '发博' : '评论'}失败，先停手（看 audit.jsonl）`
}
