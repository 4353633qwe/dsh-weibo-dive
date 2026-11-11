/**
 * lib/topics.mjs —— 超话库
 *
 * 微博没有公开的「我关注的超话」接口（实测 10 个候选端点全返回 SPA 外壳），
 * 所以这里换个思路：**从她真正刷到的内容里反推**。
 * 每条微博的正文里都带超话链接（/p/100808…）和 topic_struct 标题，
 * 按出现次数累积，就是「她实际在混的超话」——比「关注列表」更接近真实行为。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir, ensureDir } from './config.mjs'

export const topicsFile = () => path.join(dir(), 'topics.json')

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(topicsFile(), 'utf8'))
    if (d && d.items && typeof d.items === 'object') return d
  } catch { /* 没有就用空库 */ }
  return { version: 1, items: {} }
}

function write(db) {
  ensureDir()
  fs.writeFileSync(topicsFile(), JSON.stringify(db, null, 1), 'utf8')
  return db
}

/** 把这一轮看到的超话并进库里 */
export function mergeTopics(posts = []) {
  const db = read()
  const at = new Date().toISOString()
  let touched = 0
  for (const p of posts) {
    for (const t of p.topics || []) {
      if (!t.id) continue
      const cur = db.items[t.id] || { id: t.id, title: '', count: 0, firstSeen: at }
      cur.count += 1
      cur.lastSeen = at
      if (t.title && !cur.title) cur.title = t.title
      // 标题可能先后补全，取更长的那个（「绝区零」vs「绝区零超话」）
      if (t.title && cur.title && t.title.length > cur.title.length) cur.title = t.title
      db.items[t.id] = cur
      touched += 1
    }
  }
  if (touched) write(db)
  return { touched, total: Object.keys(db.items).length }
}

/** 按频次列出来 */
export function listTopics({ limit = 20, minCount = 1 } = {}) {
  const db = read()
  const rows = Object.values(db.items)
    .filter((x) => x.count >= minCount)
    .sort((a, b) => b.count - a.count)
  return {
    total: rows.length,
    rows: rows.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100))).map((x) => ({
      id: x.id,
      title: x.title || '(标题未取到)',
      count: x.count,
      lastSeen: x.lastSeen,
      url: `https://weibo.com/p/${x.id}/super_index`,
    })),
  }
}


export function topicsCount() {
  return Object.keys(read().items).length
}
