/**
 * lib/replies.mjs —— 自动回评：别人在她微博下的评论
 *
 * 数据源没有贴吧那种「@我的」聚合接口，所以走：
 *   我的微博（mymblog）→ 每篇的评论（comments/show，失败降级热评）
 * 然后过滤掉自己、广告、已回过、太旧的，剩下的交给模型挑一条。
 *
 * 写侧闸（照贴吧的做法）：
 *   confirm=true / 总开关 / 2~140 字 / 出站过滤 / 客服腔过滤 /
 *   每天额度 / 重新核对评论仍在候选里 / 回复后记账去重。
 *
 * 文件：$DSH_HOME/weibo-dive/replies.json
 */
import path from 'node:path'
import { dir, ensureDir, readConfig, readCookie, readAccount } from './config.mjs'
import { dayKey } from './diary.mjs'
import { commentGate } from './guard.mjs'
import { audit, failTripped } from './audit.mjs'
import { readJson, atomicWrite } from './store.mjs'
import * as weibo from './weibo.js'

const KEEP_DAYS = 90
const SPAM = /(加\s*[Vv微]|互关|回踩|福利中心|抽奖|返利|秒到账|点击链接|求关注|https?:\/\/|t\.cn|代肝|代练)/

export const repliesFile = () => path.join(dir(), 'replies.json')

/** 当前登录账号：回评额度/去重按账号分开，换号不会串 */
const acct = () => String(readAccount().uid || '')

export function readReplyState() {
  const r = readJson(repliesFile(), { items: [], lastAttemptAt: 0, lastReplyAt: 0, lastError: '' })
  if (!r.ok) {
    return { items: [], lastAttemptAt: 0, lastReplyAt: 0, lastError: r.error, corrupt: true, error: r.error }
  }
  const j = r.data || {}
  return {
    items: Array.isArray(j.items) ? j.items : [],
    lastAttemptAt: Number(j.lastAttemptAt) || 0,
    lastReplyAt: Number(j.lastReplyAt) || 0,
    lastError: String(j.lastError || ''),
  }
}

function writeReplyState(s) {
  ensureDir()
  atomicWrite(repliesFile(), s)
}

export function replyQuota(day = dayKey()) {
  const cfg = readConfig()
  const raw = Number(cfg.autoReplyPerDay)
  const limit = Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.round(raw))) : 2
  const st = readReplyState()
  // 记录坏了就当成「今天已用完」：宁可这一轮不回，也不按空库继续回第二遍
  if (st.corrupt) return { used: limit, limit, left: 0, corrupt: true, error: st.error }
  const me = acct()
  const used = st.items.filter((x) => x && x.day === day && (me ? String(x.account || '') === me : true)).length
  return { used, limit, left: Math.max(0, limit - used) }
}

export function hasReplied(cid) {
  const id = String(cid || '')
  if (!id) return false
  const me = acct()
  return readReplyState().items.some((x) => String(x.cid) === id
    && (me ? String(x.account || '') === me : true))
}

export function recordReply({ cid, mid, uid = '', author = '', comment = '', reply = '', rootid = '', at = new Date() } = {}) {
  const s = readReplyState()
  s.items.push({
    day: dayKey(at),
    at: at.toISOString(),
    account: acct(),
    cid: String(cid || ''),
    mid: String(mid || ''),
    uid: String(uid || ''),
    author: String(author || ''),
    comment: String(comment || '').slice(0, 200),
    reply: String(reply || ''),
    rootid: String(rootid || ''),
  })
  const cut = Date.now() - KEEP_DAYS * 86400_000
  s.items = s.items.filter((x) => {
    const t = Date.parse(x?.at)
    return !Number.isFinite(t) || t > cut
  })
  s.lastAttemptAt = Date.now()
  s.lastReplyAt = Date.now()
  s.lastError = ''
  writeReplyState(s)
  return { count: s.items.filter((x) => x.day === dayKey(at)).length }
}

export function recordReplyAttempt({ ok = false, error = '', replied = false } = {}) {
  const s = readReplyState()
  s.lastAttemptAt = Date.now()
  if (replied) s.lastReplyAt = Date.now()
  s.lastError = ok ? '' : String(error || '').slice(0, 160)
  writeReplyState(s)
  return s
}

/**
 * 拉候选：最近几篇微博下的、别人发的、没回过的、还在时效内的评论。
 * @returns {{candidates: Array, posts: number, comments: number, error?: string}}
 */
export async function collectCandidates({ cookie = '', uid = '', limit = 8, maxAgeMin = 0, maxPosts = 5 } = {}) {
  const cfg = readConfig()
  const ck = cookie || readCookie()
  if (!ck) return { candidates: [], posts: 0, comments: 0, error: '还没登录' }
  const me = String(uid || readAccount().uid || '').trim()
  if (!me) return { candidates: [], posts: 0, comments: 0, error: '拿不到自己的 uid' }

  const age = Number(maxAgeMin || cfg.autoReplyMaxAgeMin || 720) * 60_000
  const now = Date.now()
  const posts = await weibo.fetchMyPosts({ cookie: ck, uid: me, pages: 1 })
  const out = []
  let comments = 0
  // 一次性读出「已回过」的 cid 集合：以前每条评论都读一遍 replies.json，
  // 5 篇 × 20 条就是上百次同步读盘。
  const me0 = acct()
  const replied = new Set(readReplyState().items
    .filter((x) => (me0 ? String((x && x.account) || '') === me0 : true))
    .map((x) => String((x && x.cid) || '')))

  for (const p of posts.slice(0, Math.max(1, Math.min(10, maxPosts)))) {
    let list = []
    try {
      list = await weibo.fetchPostComments({ mid: p.id, pages: 1, cookie: ck })
    } catch { /* 单篇失败跳过 */ continue }
    for (const c of list) {
      comments += 1
      if (c.uid && String(c.uid) === me) continue
      const text = String(c.text || '').trim()
      if (text.length < 2 || text.length > 200) continue
      if (SPAM.test(text)) continue
      if (replied.has(String(c.id))) continue
      const ts = Number(c.ts) || 0
      if (ts && now - ts > age) continue
      out.push({
        cid: String(c.id),
        mid: String(p.id),
        author: String(c.author || '（未知）'),
        uid: String(c.uid || ''),
        text: text.slice(0, 120),
        createdAt: String(c.createdAt || ''),
        ts,
        likes: Number(c.likes) || 0,
        postText: p.text.slice(0, 80),
        postUrl: p.url,
      })
    }
  }

  out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return { candidates: out.slice(0, Math.max(1, Math.min(30, limit))), posts: posts.length, comments }
}

/** 回一条评论。所有闸都在这里，工具和自动轮共用。 */
export async function replyToComment({ cid, mid = '', content = '', confirm = false } = {}) {
  const cfg = readConfig()
  if (confirm !== true) return { ok: false, error: '没确认：公开回复要传 confirm: true' }
  if (cfg.autoReplyComment !== true) return { ok: false, error: '自动回评是关着的' }

  const text = String(content || '').trim()
  if (text.length < 2 || text.length > 140) return { ok: false, error: '回复要 2~140 字' }
  const bad = commentGate(text, { toneGate: cfg.toneGate !== false })
  if (bad) return { ok: false, error: bad }

  const q = replyQuota()
  if (q.corrupt) return { ok: false, error: `本地回评记录损坏，先停手：${q.error}` }
  if (q.used >= q.limit) return { ok: false, error: `今天回评的额度用完了（${q.limit} 条）` }

  const ck = readCookie()
  if (!ck) return { ok: false, error: '还没登录' }
  if (hasReplied(cid)) return { ok: false, error: '这条评论已经回过了' }
  const tripped = failTripped('reply')
  if (tripped) return { ok: false, error: tripped }

  // 重新核对：评论还在、还是别人发的、还在时效内。防模型编 cid。
  const scan = await collectCandidates({ cookie: ck, limit: 50 })
  const target = scan.candidates.find((x) => String(x.cid) === String(cid))
  if (!target) return { ok: false, error: '这条评论不在候选里（可能被删、太旧，或不是给你的）' }

  try {
    const xsrf = await weibo.getXsrf(ck)
    const r = await weibo.postComment({ cookie: ck, xsrf, mid: target.mid, text, replyTo: String(cid) })
    if (!r.ok) {
      audit({ kind: 'reply', ok: false, cid: String(cid), mid: target.mid, text, error: r.msg || '回复失败', code: r.code || '' })
      return { ok: false, error: r.msg || '回复失败', code: r.code }
    }
    const rootid = String(r.rootid || '')
    const asTop = rootid && rootid !== String(cid)
    recordReply({
      cid: String(cid),
      mid: target.mid,
      uid: target.uid,
      author: target.author,
      comment: target.text,
      reply: text,
      rootid,
    })
    audit({ kind: 'reply', ok: true, cid: String(cid), mid: target.mid, text, rootid })
    return {
      ok: true,
      sent: true,
      cid,
      mid: target.mid,
      to: target.author,
      content: text,
      rootid,
      note: asTop ? '接口把回复发成了顶层评论（rootid 不等于 cid），去页面看一眼' : '回复发出去了',
    }
  } catch (e) {
    audit({ kind: 'reply', ok: false, cid: String(cid), text, error: e.message, code: e.code || '' })
    return { ok: false, error: e.message, code: e.code || '' }
  }
}

/** 自动轮的任务说明：候选直接给进去，模型只负责挑一条、写一句 */
export function buildReplyPrompt(cands = [], { maxAgeMin = 720 } = {}) {
  const lines = [
    '你现在要回一条微博评论。',
    '',
    '**开始之前先调用 `weibo_persona` 读她的人设**——没读之前不要写。',
    '',
    '## 规则',
    `- 下面是从她最近微博的评论区捞出来的、别人给她的评论（已滤掉广告、自己、${maxAgeMin} 分钟前的旧评论）。`,
    '- 最多挑 1 条回复。只回真正接得上的：提问、打招呼、有具体内容的。',
    '- 纯表情、广告、引战、看不懂、只是打卡的，直接跳过。',
    '- 回复 2~80 字，像人随口接一句；不要客服腔（「感谢您的评论」），不要解释、不要科普。',
    '- 回复用 `weibo_reply_comment({ cid, mid, content, confirm: true })`，最多调用一次。',
    '- 没有合适的，就不要调用回复工具，最后回一句「这轮没回」。',
    '',
    '## 候选评论',
    ...cands.map((c, i) => `${i + 1}. cid=${c.cid} mid=${c.mid} 来自 @${c.author}`
      + `（${c.createdAt || '时间未知'}）：${c.text}`),
  ]
  return lines.join('\n')
}
