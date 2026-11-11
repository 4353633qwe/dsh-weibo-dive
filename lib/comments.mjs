/**
 * lib/comments.mjs —— 评论的配额、记录与「这条帖子是哪来的」核对
 *
 * 三条闸：
 *   1. 只允许评论**她自己刷到过的帖子**（最近几天的 raw 存档里出现过），
 *      防止模型随手编一个 id 去别人时间线底下留言；
 *   2. 每日条数上限；
 *   3. 两条之间的最小间隔。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir, ensureDir, rawDir, readAccount } from './config.mjs'
import { readJson, atomicWrite } from './store.mjs'

export const commentsFile = () => path.join(dir(), 'comments.json')

const todayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const EMPTY = () => ({ version: 1, items: [] })

function read() {
  const r = readJson(commentsFile(), EMPTY())
  if (!r.ok) return { ...EMPTY(), corrupt: true, error: r.error }
  const d = r.data
  if (!d || !Array.isArray(d.items)) return { ...EMPTY(), corrupt: true, error: 'comments.json 结构不对' }
  return d
}

function write(db) {
  ensureDir()
  atomicWrite(commentsFile(), db, { mode: 0o600 })
  return db
}

/** 今天的评论条数 + 最后一条的时间（只算当前登录账号的） */
export function todayStats() {
  const db = read()
  const day = todayKey()
  const uid = String(readAccount().uid || '')
  const mine = db.items.filter((x) => {
    if (!x || x.day !== day) return false
    return uid ? String(x.uid || '') === uid : true
  })
  return {
    count: mine.length,
    lastAt: mine.length ? mine[mine.length - 1].at : 0,
    items: mine,
    corrupt: db.corrupt === true,
    error: db.error || '',
  }
}

export function canComment({ dailyLimit = 3, minGapMin = 30, mid = '', perRound = 1 } = {}) {
  const st = todayStats()
  // 记录坏了就停手：按空库继续会把今天的额度重新发一遍
  if (st.corrupt) return { ok: false, reason: `本地评论记录损坏，先停手：${st.error}`, corrupt: true }
  if (st.count >= dailyLimit) {
    return { ok: false, reason: `今天的评论额度用完了（${st.count}/${dailyLimit}）` }
  }
  // 同一帖每天只评一次（贴吧那边也是这么卡的）
  if (mid) {
    const same = st.items.find((x) => String(x.mid) === String(mid))
    if (same) return { ok: false, reason: '这条帖子今天已经评过了，同一帖每天只评一次' }
  }
  // 每轮额度：一轮里最多评几条，防止模型一次刷满
  const round = String(process.env.WEIBO_ROUND_ID || '')
  const cap = Number.isFinite(Number(perRound)) ? Number(perRound) : 1
  if (round && cap > 0) {
    const inRound = st.items.filter((x) => String(x.round || '') === round).length
    if (inRound >= cap) return { ok: false, reason: `这一轮已经评过 ${inRound} 条（每轮上限 ${cap}）` }
  }
  if (st.lastAt) {
    const gapMin = (Date.now() - st.lastAt) / 60000
    if (gapMin < minGapMin) {
      return { ok: false, reason: `离上一条才 ${gapMin.toFixed(0)} 分钟，还差 ${(minGapMin - gapMin).toFixed(0)} 分钟` }
    }
  }
  return { ok: true, used: st.count, left: dailyLimit - st.count }
}

export function recordComment({ mid, text, rpid, url, author }) {
  const db = read()
  db.items.push({
    at: Date.now(),
    day: todayKey(),
    uid: String(readAccount().uid || ''),
    mid: String(mid),
    text: String(text || '').slice(0, 200),
    rpid: rpid || null,
    url: url || '',
    author: author || '',
    round: String(process.env.WEIBO_ROUND_ID || ''),
  })
  write(db)
  return todayStats()
}

/**
 * 在最近的 raw 存档里找这条帖子。
 * 支持：数字 id / mblogid / 完整链接
 */
export function findSeenPost(ref) {
  const q = String(ref || '').trim()
  if (!q) return null

  // 链接 → 取出 mblogid 再精确比，避免 "1" 这种短串误命中
  const bidFromUrl = (s) => {
    const m = s.match(/weibo\.com\/(?:\d+\/)?([A-Za-z0-9]{6,})/)
    return m ? m[1] : ''
  }
  const wantBid = /^https?:\/\//i.test(q) ? bidFromUrl(q) : ''
  const wantId = /^\d{10,}$/.test(q) ? q : ''
  const wantShort = !wantBid && !wantId && /^[A-Za-z0-9]{6,12}$/.test(q) ? q : ''
  if (!wantBid && !wantId && !wantShort) return null

  // 每轮一个文件（raw-YYYY-MM-DD-HHmm.json），按修改时间倒序，只留最近 7 天的
  let files = []
  try {
    const cut = Date.now() - 7 * 86400_000
    files = fs.readdirSync(rawDir())
      .filter((f) => f.startsWith('raw-'))
      .map((f) => path.join(rawDir(), f))
      .map((p) => { try { return { p, m: fs.statSync(p).mtimeMs } } catch { return null } })
      .filter((x) => x && x.m >= cut)
      .sort((a, b) => b.m - a.m)
      .slice(0, 40)
      .map((x) => x.p)
  } catch { return null }

  for (const fp of files) {
    let data
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    } catch { continue }
    for (const p of (data.picked || data.posts || [])) {
      if (wantId && p.id === wantId) return { ...p, from: path.basename(fp) }
      if (wantBid && p.mblogid === wantBid) return { ...p, from: path.basename(fp) }
      if (wantShort && p.mblogid === wantShort) return { ...p, from: path.basename(fp) }
    }
  }
  return null
}

export function commentHistory({ limit = 20 } = {}) {
  const db = read()
  return {
    today: todayStats().count,
    rows: db.items.slice(-Math.max(1, Math.min(limit, 100))).reverse(),
  }
}
