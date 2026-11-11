/**
 * lib/store.mjs —— 本地状态文件的原子读写
 *
 * 直接 writeFileSync 有两个坑：
 *   1. 写一半被杀（子进程超时 SIGKILL、机器重启），文件只剩半截 JSON；
 *   2. 读坏之后按空库继续 —— 评论/回评/发博的今日额度全归零，可能重复发。
 * 所以统一：写 = tmp + rename；读坏 = 先复制一份 .bad-<时间> 备份，保留原文件并标记 corrupt，
 * 由调用方失败关闭（宁可这一轮不发，也不按空库继续）。
 */
import fs from 'node:fs'
import path from 'node:path'

const log = (...a) => console.log('[weibo-dive]', ...a)

/** 同一个文件只吵一次，避免每 30 秒 tick 刷一行 */
const warned = new Set()

export function atomicWrite(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 1)
  fs.writeFileSync(tmp, text, mode ? { encoding: 'utf8', mode } : 'utf8')
  if (mode) {
    try { fs.chmodSync(tmp, mode) } catch { /* ignore */ }
  }
  fs.renameSync(tmp, file)
}

/**
 * 读 JSON。返回 { ok, data, fresh?, error?, backup? }
 *   ok:false 表示文件存在但读不出来 —— 调用方应当失败关闭，不要当成空库。
 */
export function readJson(file, fallback) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, data: fallback, fresh: true }
    return { ok: false, data: fallback, error: `${path.basename(file)} 读不出来：${e.message}` }
  }
  if (!raw.trim()) return { ok: true, data: fallback, fresh: true }
  try {
    return { ok: true, data: JSON.parse(raw) }
  } catch (e) {
    let backup = ''
    try {
      backup = `${file}.bad-${Date.now()}`
      fs.copyFileSync(file, backup)
    } catch { backup = '' }
    const msg = `${path.basename(file)} 解析失败（${e.message}）${backup ? `，已备份为 ${path.basename(backup)}` : ''}`
    if (!warned.has(file)) {
      warned.add(file)
      log(msg)
    }
    return { ok: false, data: fallback, error: msg, backup }
  }
}
