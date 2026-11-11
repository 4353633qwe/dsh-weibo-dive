/**
 * lib/weibo.js —— 微博 weibo.com 的读取 + 评论
 *
 * 实测结论（2026-11-10）：
 *   · m.weibo.cn 用的是 `.weibo.cn` 域的 SUB，从 weibo.com 复制的 SUB 在那边是「未登录」；
 *   · weibo.com 的 `/ajax/feed/friendtimeline` 认 `.weibo.com` 域的 SUB，返回 ok:1 + statuses；
 *   · 全程没有任何请求签名 —— 只要 cookie 有效，纯 HTTP 就能读关注流，不需要浏览器。
 *
 * 所有请求都走 lib/channel.mjs：端点、UA/Referer、节奏、熔断、健康记录都在那边。
 * 这个文件只负责「把微博的 JSON 变成能用的数据」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { request, WeiboAuthError, WeiboError, channelInfo, readCooldown, readHealth, getGap } from './channel.mjs'
import { dir } from './config.mjs'

export { WeiboAuthError, WeiboError, channelInfo }

const reqJson = async (name, opt) => (await request(name, opt)).data

/** 去掉 HTML 标签、解码常见实体 */
export function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 关注流的查询参数：group_id=0 即「全部关注」 */
const feedQuery = (count, sinceId = '') => ({
  refresh: 0,
  group_id: 0,
  count,
  since_id: sinceId || '',
})

/** 当前登录的是谁：先用关注流探活，再问 sideUser 拿 uid / 昵称 */
export async function checkLogin(cookie) {
  const d = await reqJson('timeline', { query: feedQuery(1), cookie })
  const ok = d && d.ok === 1 && Array.isArray(d.statuses)
  let screenName = ''
  let uid = ''
  if (ok) {
    try {
      // 实测：`/ajax/side/cards/sideUser` 返回 { ok:1, data:{ user:{ id, screen_name } } }。
      // 老办法（首页 HTML 里的 $CONFIG['uid'] / ['nick']）在 V7 上已经没有了。
      const me = await reqJson('sideUser', { cookie })
      const u = me && me.data && me.data.user
      if (u) {
        uid = String(u.id || u.idstr || '')
        screenName = String(u.screen_name || u.name || '')
      }
    } catch { /* 昵称拿不到不影响主流程 */ }
  }
  return { ok, uid, screenName }
}

function normalize(s) {
  if (!s || s.id === undefined) return null
  const text = stripHtml(s.text_raw || s.text)
  const rt = s.retweeted_status ? stripHtml(s.retweeted_status.text_raw || s.retweeted_status.text) : ''
  const pics = Number(s.pic_num || (Array.isArray(s.pic_ids) ? s.pic_ids.length : 0))
  const page = s.page_info || {}
  // 图片：pic_infos 里每张有几个尺寸，bmiddle（约 440px）够看懂又便宜
  const infos = s.pic_infos && typeof s.pic_infos === 'object' ? s.pic_infos : {}
  const images = Object.keys(infos)
    .map((k) => {
      const it = infos[k] || {}
      const pick = it.bmiddle || it.large || it.original || it.largest || {}
      const url = String(pick.url || '')
      return url ? { url, w: Number(pick.width) || 0, h: Number(pick.height) || 0 } : null
    })
    .filter(Boolean)
  // 视频封面：视频本身看不了，封面至少是一张图
  const cover = String(page.page_pic || '')
  // 超话：从正文 HTML 的 /p/100808… 链接 + topic_struct 里取
  const html = String(s.text || '')
  const ids = [...html.matchAll(/\/p\/(100808[0-9a-f]{6,})/g)].map((m) => m[1])
  const titles = (Array.isArray(s.topic_struct) ? s.topic_struct : [])
    .map((t) => String(t.topic_title || '').trim())
    .filter(Boolean)
  const topics = [...new Set(ids)].map((id, i) => ({ id, title: titles[i] || titles[0] || '' }))
  return {
    id: String(s.idstr || s.id),
    mblogid: s.mblogid || '',
    author: s.user?.screen_name || '（未知）',
    uid: s.user?.id ? String(s.user.id) : '',
    text,
    topics,
    isRepost: Boolean(s.retweeted_status),
    repostText: rt.slice(0, 120),
    pics,
    images,
    cover,
    hasVideo: page.type === 'video' || Boolean(page.media_info),
    reposts: Number(s.reposts_count || 0),
    comments: Number(s.comments_count || 0),
    likes: Number(s.attitudes_count || 0),
    createdAt: s.created_at || '',
    source: stripHtml(s.source || ''),
    url: s.mblogid && s.user?.id ? `https://weibo.com/${s.user.id}/${s.mblogid}` : `https://weibo.com/detail/${s.idstr || s.id}`,
  }
}

/**
 * 拉一轮关注流。
 * @returns {{posts: Array, pages: number, sinceId: string}}
 */
export async function fetchTimeline({ cookie, count = 10, pageLimit = 2 } = {}) {
  const seen = new Set()
  const posts = []
  let sinceId = ''
  let pages = 0

  for (let i = 0; i < Math.max(1, Math.min(pageLimit, 5)); i += 1) {
    const d = await reqJson('timeline', { query: feedQuery(Math.max(1, Math.min(count, 20)), sinceId), cookie })
    pages += 1
    const list = Array.isArray(d.statuses) ? d.statuses : []
    let added = 0
    for (const s of list) {
      const p = normalize(s)
      if (!p || seen.has(p.id)) continue
      seen.add(p.id)
      posts.push(p)
      added += 1
    }
    if (d.since_id) sinceId = String(d.since_id)
    if (added === 0) break
    // 翻页节奏由 channel 的 pace() 控制，这里不再自己 sleep
  }

  return { posts, pages, sinceId }
}

/**
 * 取当前的「热门」分类列表（名字 + containerid）。
 * 热搜活动（金鸡奖、S16 之类）会轮换，所以设置页偶尔刷一次这份列表就够。
 */
export async function fetchGroupList(cookie) {
  const d = await reqJson('groups', { query: { containerid: '102803' }, cookie })
  // 结构是两层的：groups[] 是「分组块」（默认分组 / 热门 …），真正的分类在
  // groups[i].group[] 里，字段是 title + containerid。第一版按顶层 groups 取，
  // 结果永远是 0 条，白白以为接口变了。
  const out = []
  const push = (x) => {
    const id = String(x?.containerid || x?.group_id || '').trim()
    const name = String(x?.title || '').trim()
    // 只留「热门」这一类的 containerid，关注分组那种是 gid（纯数字）
    if (id && name && /^102803/.test(id)) out.push({ id, name })
  }
  for (const block of Array.isArray(d?.groups) ? d.groups : []) {
    if (Array.isArray(block?.group)) block.group.forEach(push)
    else push(block)
  }
  return out
}

/**
 * 拉一段「热门」流（按分类）。
 *
 * 实测（2026-11-10）：`/ajax/feed/hottimeline` 传 group_id + containerid 都填
 * `102803_ctg1_4388_-_ctg1_4388` 这种分类 id，返回 ok:1 + 15~18 条 statuses，
 * 结构和关注流一致。分类 id 见 lib/categories.mjs。
 *
 * 一个分类一页就够：热门的意义是「不同圈子各拿几条」，翻页只会更偏。
 *
 * @param {{cookie: string, containerIds?: string[], count?: number, pageLimit?: number}} opt
 * @returns {{posts: Array, pages: number, segments: Array<{id: string, count: number}>}}
 */
export async function fetchHot({ cookie, containerIds = [], count = 20, pageLimit = 1 } = {}) {
  const ids = (Array.isArray(containerIds) ? containerIds : [containerIds]).filter(Boolean)
  if (!ids.length) throw new Error('至少给一个热门分类 id')
  const per = Math.max(5, Math.min(count, 30))
  const seen = new Set()
  const posts = []
  const segments = []
  let pages = 0

  for (const id of ids) {
    let added = 0
    for (let page = 1; page <= Math.max(1, Math.min(pageLimit, 3)); page += 1) {
      const d = await reqJson('hottimeline', {
        cookie,
        query: {
          since_id: '',
          refresh: page === 1 ? '0' : '1',
          group_id: id,
          containerid: id,
          extparam: 'discover|new_feed',
          max_id: '0',
          count: per,
          page,
        },
      })
      pages += 1
      const list = Array.isArray(d.statuses) ? d.statuses : []
      for (const s of list) {
        // 热门里混着「卡片」（话题榜、活动入口），没有作者也不是微博正文，直接跳
        if (!s || !s.user || !(s.text_raw || s.text)) continue
        const p = normalize(s)
        if (!p || seen.has(p.id)) continue
        seen.add(p.id)
        p.categoryId = id
        posts.push(p)
        added += 1
      }
      if (!list.length) break
      // 分页 / 分类之间的间隔都由 channel 的 pace() 统一控制
    }
    segments.push({ id, count: added })
  }

  return { posts, pages, segments }
}

/**
 * 拉某个超话的内容。
 *
 * 实测说明：weibo.com 没有公开的「超话流」接口 —— /ajax/statuses/topic_band
 * 不管传 topic_id 还是 containerid，返回的都是同一个「热门话题榜」。
 * 可用的路子是搜索 `#超话名#`（/ajax/statuses/search），返回结构和关注流一致。
 * 代价是搜索结果里混着代肝、抽奖这类广告，调用方需要自己过滤。
 */
export async function fetchTopicFeed({ cookie, title, pageLimit = 1 } = {}) {
  const t = String(title || '').trim()
  if (!t) throw new Error('需要一个超话名字（微博没有按 id 搜内容的接口）')
  const seen = new Set()
  const posts = []
  let pages = 0

  for (let page = 1; page <= Math.max(1, Math.min(pageLimit, 5)); page += 1) {
    const d = await reqJson('search', { query: { q: `#${t}#`, page }, cookie })
    pages += 1
    const list = Array.isArray(d.statuses) ? d.statuses : []
    let added = 0
    for (const s of list) {
      const p = normalize(s)
      if (!p || seen.has(p.id)) continue
      seen.add(p.id)
      posts.push(p)
      added += 1
    }
    if (added === 0) break
  }

  return { posts, pages, topicTitle: t }
}

/**
 * 取一个 XSRF-TOKEN（写接口必需，且不在用户给的 SUB cookie 里）。
 * 做法：带 SUB 访问首页，从 Set-Cookie 里读。
 */
export async function getXsrf(cookie) {
  let res
  try {
    const r = await request('homepage', { cookie, raw: true })
    res = r.res
  } catch (e) {
    if (e instanceof WeiboError) throw e
    throw new Error(`取 XSRF 失败：${e.message}`)
  }
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const line of list) {
    const m = String(line).match(/XSRF-TOKEN=([^;]+)/i)
    if (m) {
      const raw = m[1]
      // 关键：头里的 token 和 cookie 里的值必须对得上，缺一个就报 missing csrf token
      return { token: decodeURIComponent(raw), raw, cookie: `XSRF-TOKEN=${raw}` }
    }
  }
  throw new WeiboAuthError('拿不到 XSRF-TOKEN（首页没下发，通常意味着 cookie 已失效）')
}

/**
 * 写接口必须带齐的头，少一个就会被网关挡成 400。
 * UA / Referer / Accept / Content-Type / Cookie 由 channel 统一补，这里只放它没有的。
 */
function writeHeaders(xsrf) {
  return {
    Origin: 'https://weibo.com',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': xsrf,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }
}

/**
 * 发一条评论。
 *
 * 实测（2026-11-10）：
 *   · 顶层评论走 `/ajax/comments/create`，`id` 传微博数字 id（不是 mblogid）；
 *   · **回复评论必须换接口** `/ajax/comments/reply`，带 `cid` + `is_comment=1`。
 *     往 create 里塞 cid 不会报错，但会静默发成顶层评论（rootid 等于自己）——
 *     第一次就是这么踩的。
 *   · 成功与否看返回的 `rootid`：回复时它应等于被回复评论的 cid。
 * @returns {{ok: boolean, code?: any, msg?: string, raw?: any}}
 */
export async function postComment({ cookie, xsrf, mid, text, replyTo = '' } = {}) {
  const token = typeof xsrf === 'string' ? xsrf : (xsrf?.token || '')
  const cookieHeader = (typeof xsrf === 'object' && xsrf?.cookie) ? `${cookie}; ${xsrf.cookie}` : cookie
  if (!token) return { ok: false, msg: '缺少 XSRF token' }

  const body = new URLSearchParams({
    id: String(mid || ''),
    comment: String(text || ''),
    pic_id: '',
    is_repost: '0',
    comment_ori: '0',
  })
  if (replyTo) {
    body.set('cid', String(replyTo))
    body.set('is_comment', '1')
  }
  const endpoint = replyTo ? 'commentReply' : 'commentCreate'
  let r
  try {
    r = await request(endpoint, {
      form: body,
      cookie: cookieHeader,
      headers: writeHeaders(token),
    })
  } catch (e) {
    return { ok: false, msg: `请求失败：${e.message}`, code: e.code || '', blocked: e.code === 'RATE_LIMIT' || e.code === 'COOLDOWN' }
  }
  const data = r.data
  return {
    ok: data.ok === 1,
    code: data.code,
    msg: data.msg || data.message || '',
    rootid: String(data.data?.rootid || ''),
    data: data.data,
  }
}

/**
 * 发一条微博（纯文字）。
 *
 * 实测（2026-11-11）：`POST /ajax/statuses/update`，表单要 `content` + `visible`，
 * 头跟评论一样要 X-XSRF-TOKEN。
 *   · 正文里带 `#超话名#` 只是普通话题，**不会**把微博发进超话；
 *   · 超话帖的正确写法是正文带 `#超话名[超话]#`，并传 `topic_id=1022:<100808 id>`
 *     （网页版超话发布器就是 `"1022:" + pageId`，并带 `sync_mblog`）。
 *     只传 page_id 会被当成普通话题 —— 之前就是这么错的。
 *
 * @param {{cookie:string, xsrf:any, text:string, pageId?:string}} opt
 * @returns {{ok:boolean, code?:any, msg?:string, mid?:string, url?:string, data?:any}}
 */
export async function postStatus({ cookie, xsrf, text, pageId = '' } = {}) {
  const token = typeof xsrf === 'string' ? xsrf : (xsrf?.token || '')
  const cookieHeader = (typeof xsrf === 'object' && xsrf?.cookie) ? `${cookie}; ${xsrf.cookie}` : cookie
  if (!token) return { ok: false, msg: '缺少 XSRF token' }
  const t = String(text || '').trim()
  if (!t) return { ok: false, msg: '内容为空' }

  const body = new URLSearchParams({ content: t, visible: '0' })
  if (pageId) {
    body.set('page_id', String(pageId))
    body.set('topic_id', `1022:${String(pageId)}`)
    // 1 = 同时保留在个人主页
    body.set('sync_mblog', '1')
  }
  let data
  try {
    const r = await request('statusUpdate', {
      form: body,
      cookie: cookieHeader,
      headers: writeHeaders(token),
    })
    data = r.data || {}
  } catch (e) {
    return { ok: false, msg: `请求失败：${e.message}`, code: e.code || '', blocked: e.code === 'RATE_LIMIT' || e.code === 'COOLDOWN' }
  }

  // 微博这里成功不一定给 ok:1，老接口用 code:"100000"；两种都认。
  const ok = data.ok === 1 || String(data.code) === '100000'
  const d = data.data || {}
  const mid = String(d.idstr || d.id || d.mid || '')
  return {
    ok,
    code: data.code,
    msg: data.message || data.msg || '',
    mid,
    url: mid && /^\d+$/.test(mid) ? `https://weibo.com/detail/${mid}` : '',
    data: d,
  }
}
// ── 超话 id ────────────────────────────────────────────────────────────────
// 发进超话要用 `page_id=100808xxxx`。名字和 id 的对应关系没有公开接口，
// 但超话里的帖子正文会带 `<a href="/p/100808..."><img title="#名字[超话]#">`，
// 所以拿搜索结果里别人的超话帖反查，最可靠。
const TOPIC_CACHE_MS = 30 * 86400_000
const topicIdsFile = () => path.join(dir(), 'topic-ids.json')

function readTopicCache() {
  try {
    return JSON.parse(fs.readFileSync(topicIdsFile(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function findTopicInHtml(html, key) {
  const want = key.toLowerCase()
  const pick = (id, rawTitle) => {
    const t = String(rawTitle || '').replace(/^#+|#+$/g, '').replace(/\[超话\]/g, '').trim()
    return t.toLowerCase() === want ? { id, title: t } : null
  }
  for (const m of html.matchAll(/\/p\/(100808[0-9a-f]{6,})"[^>]*>\s*<img[^>]*title="([^"]*)"/gi)) {
    const r = pick(m[1], m[2])
    if (r) return r
  }
  for (const m of html.matchAll(/\/p\/(100808[0-9a-f]{6,})"[^>]*>([^<]{1,60})<\/a>/gi)) {
    const r = pick(m[1], m[2])
    if (r) return r
  }
  return null
}

/**
 * 确认一条微博是否真的进了超话：拉超话 feed，看 mid 在不在里面。
 * @returns {Promise<boolean|null>} true = 在；false = 不在；null = 拿不到 feed（未知）
 */
export async function postInChaohua({ cookie, pageId, mid } = {}) {
  const pid = String(pageId || '').trim()
  const id = String(mid || '').trim()
  if (!pid || !id) return null
  let d
  try {
    d = await reqJson('chaohuaFeed', { query: { containerid: `${pid}_-_feed` }, cookie })
  } catch {
    return null
  }
  const items = Array.isArray(d?.items) ? d.items : []
  const ids = items
    .filter((x) => x && x.category === 'feed' && x.data)
    .map((x) => String(x.data.idstr || x.data.id || ''))
    .filter(Boolean)
  if (!ids.length) return null
  return ids.includes(id)
}

/**
 * 超话名 → 100808 容器 id（发博时作为 page_id）。
 * 直接给 id 就原样返回；找不到就返回空 id，调用方降级成普通话题微博。
 */
export async function resolveTopicId({ cookie, name } = {}) {
  const raw = String(name || '').trim()
  if (/^100808[0-9a-f]{6,}$/i.test(raw)) return { id: raw, title: '', from: 'input' }
  const key = raw.replace(/^#+|#+$/g, '').trim()
  if (!key) return { id: '', title: '', found: false }

  const cache = readTopicCache()
  const hit = cache[key.toLowerCase()]
  if (hit && hit.id && Date.now() - Number(hit.at || 0) < TOPIC_CACHE_MS) {
    return { id: hit.id, title: hit.title || key, from: 'cache', found: true }
  }

  for (let page = 1; page <= 2; page += 1) {
    let d
    try {
      d = await reqJson('search', { query: { q: `#${key}#`, page }, cookie })
    } catch {
      break
    }
    for (const s of (Array.isArray(d?.statuses) ? d.statuses : [])) {
      const found = findTopicInHtml(String(s.text || ''), key)
      if (!found) continue
      try {
        cache[key.toLowerCase()] = { id: found.id, title: found.title, at: Date.now() }
        fs.mkdirSync(dir(), { recursive: true })
        fs.writeFileSync(topicIdsFile(), JSON.stringify(cache, null, 1), 'utf8')
      } catch { /* 缓存失败不影响结果 */ }
      return { ...found, from: 'search', found: true }
    }
  }
  return { id: '', title: key, found: false }
}

// ── 评论列表（只读） ──────────────────────────────────────────────────────
/** 评论区里的垃圾：互关、加微、抽奖、外链 */
const CMT_SPAM = /(加\s*[Vv微]|互关|回踩|福利中心|抽奖|返利|秒到账|点击链接|求关注|https?:\/\/|t\.cn)/

/** 评论正文：去标签、压空白；纯表情/纯标点当空的 */
function cleanCommentText(text) {
  const s = stripHtml(text).replace(/\s+/g, ' ').trim()
  return /^[\p{P}\p{S}\s]+$/u.test(s) ? '' : s
}

/**
 * 拿一条微博的热评（按赞排序）。
 *
 * 为什么走 m.weibo.cn：weibo.com 的 `/ajax/statuses/buildComments` 现在一律
 * 返回「参数错误」（试过 6 种参数组合），而移动站这个接口不登录也能读。
 * 实测（2026-11-10）：手机 UA、不带 cookie，200 返回热门评论 + 楼中楼。
 *
 * @param {{mid:string, count?:number, timeoutMs?:number}} opt
 * @returns {Promise<Array<{id:string, author:string, likes:number, text:string, replies:number}>>}
 */
export async function fetchHotComments({ mid, count = 3, timeoutMs = 12000, strict = false } = {}) {
  const id = String(mid || '').trim()
  if (!/^\d{6,}$/.test(id)) return []
  let data
  try {
    data = await reqJson('hotflow', {
      query: { id, mid: id, max_id: 0, max_id_type: 0 },
      timeoutMs,
      retry: 0,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
  } catch (e) {
    if (strict) throw e
    return []
  }

  const raw = data && data.data && Array.isArray(data.data.data) ? data.data.data : []
  const out = []
  const seen = new Set()
  for (const c of raw) {
    const text = cleanCommentText(c && c.text)
    if (!text || text.length < 2 || text.length > 120) continue
    if (CMT_SPAM.test(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push({
      id: String((c && c.id) || ''),
      author: String((c && c.user && c.user.screen_name) || '（未知）'),
      likes: Number((c && c.like_count) || 0),
      replies: Array.isArray(c && c.comments) ? c.comments.length : 0,
      text: text.slice(0, 80),
    })
  }
  out.sort((a, b) => b.likes - a.likes)
  return out.slice(0, Math.max(1, Math.min(5, Math.round(Number(count) || 3))))
}

// ── 我的微博 / 我帖子下的评论（回评用） ───────────────────────────────────
/** 我的原创微博（按时间倒序，一页约 10 条） */
export async function fetchMyPosts({ cookie, uid, pages = 1 } = {}) {
  const id = String(uid || '').trim()
  if (!/^\d+$/.test(id)) throw new WeiboError('缺少自己的 uid，拿不到「我的微博」', 'BAD_REQUEST')
  const out = []
  const seen = new Set()
  for (let page = 1; page <= Math.max(1, Math.min(pages, 3)); page += 1) {
    const d = await reqJson('myblog', { query: { uid: id, page, feature: 0 }, cookie })
    const list = Array.isArray(d?.data?.list) ? d.data.list : []
    for (const s of list) {
      const p = normalize(s)
      if (!p || seen.has(p.id)) continue
      seen.add(p.id)
      out.push(p)
    }
    if (!list.length) break
  }
  return out
}

/** 微博时间串（"2小时前" / "Wed Nov 11 …"）→ 毫秒；认不出就当 0 */
function commentTs(c) {
  const n = Number(c?.time)
  if (Number.isFinite(n) && n > 1e9) return n * 1000
  const s = String(c?.created_at || '').trim()
  const m = /^(\d+)\s*(秒|分钟|小时|天)前$/.exec(s)
  if (m) {
    const v = Number(m[1])
    const unit = m[2] === '秒' ? 1000 : m[2] === '分钟' ? 60_000 : m[2] === '小时' ? 3_600_000 : 86_400_000
    return Date.now() - v * unit
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

/**
 * 一条微博下的评论（按时间）。走 m.weibo.cn 的 comments/show。
 * 它偶发返回 SPA HTML；这时直接当作没扫到，不再降级到热评——
 * 自动回评只认「按时间排的回复」，热评兜底会带进一堆旧评论。
 */
export async function fetchPostComments({ mid, pages = 1, cookie = '' } = {}) {
  const id = String(mid || '').trim()
  if (!/^\d{6,}$/.test(id)) return []
  const out = []
  const seen = new Set()
  for (let page = 1; page <= Math.max(1, Math.min(pages, 3)); page += 1) {
    let d
    try {
      d = await reqJson('mcomments', {
        query: { id, page },
        cookie,
        retry: 1,
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      })
    } catch {
      break
    }
    const list = Array.isArray(d?.data?.data) ? d.data.data : Array.isArray(d?.data) ? d.data : []
    let added = 0
    for (const c of list) {
      const text = cleanCommentText(c?.text)
      const cid = String(c?.id || '')
      if (!cid || !text || seen.has(cid)) continue
      seen.add(cid)
      out.push({
        id: cid,
        author: String(c?.user?.screen_name || '（未知）'),
        uid: String(c?.user?.id || ''),
        text,
        createdAt: String(c?.created_at || ''),
        ts: commentTs(c),
        likes: Number(c?.like_count || 0),
      })
      added += 1
    }
    if (!added) break
  }
  return out
}

// ── 图片（只读） ──────────────────────────────────────────────────────────
/**
 * 取一张图 / 视频封面。也走通道：超时、重试、健康记录一致。
 * @returns {{buf: Buffer, contentType: string}}
 */
export async function fetchImageBytes(url, { timeoutMs = 12000 } = {}) {
  const u = String(url || '')
  if (!/^https?:\/\//.test(u)) throw new WeiboError('图片地址不是 http(s)', 'CHANGED')
  const r = await request('image', { url: u, binary: true, timeoutMs })
  return { buf: r.buf, contentType: r.contentType }
}

// ── 自检 ──────────────────────────────────────────────────────────────────
const DEFAULT_HOT_ID = '102803_ctg1_4388_-_ctg1_4388' // 搞笑，自带兜底

/**
 * 逐项探测「插件还活着吗」。
 *
 * 只看一件事：每个能力现在还能不能用、慢不慢。接口改版、cookie 过期、被风控，
 * 在这里会看到具体是哪一项坏了 —— 而不是等某一轮默默刷出 0 条才发现。
 *
 * @param {{cookie?: string, topic?: string}} opt
 */
export async function diagnose({ cookie = '', topic = '微博' } = {}) {
  const items = []

  const probe = async (name, label, fn) => {
    const t0 = Date.now()
    try {
      const note = await fn()
      // 返回 { skip } 表示「接口是通的，只是这次没数据」，标成 – 而不是 ✗
      if (note && typeof note === 'object' && note.skip) {
        items.push({ name, label, ok: null, ms: Date.now() - t0, error: note.skip })
        return null
      }
      items.push({ name, label, ok: true, ms: Date.now() - t0, note: note || '' })
      return note || true
    } catch (e) {
      items.push({
        name,
        label,
        ok: false,
        ms: Date.now() - t0,
        error: String(e?.message ?? e).slice(0, 160),
        code: e?.code || '',
      })
      return null
    }
  }

  items.push(
    cookie
      ? { name: 'cookie', label: 'cookie', ok: true, ms: 0 }
      : { name: 'cookie', label: 'cookie', ok: false, ms: 0, error: '还没有保存 cookie' },
  )

  let firstPost = null

  if (!cookie) {
    // 没 cookie 就别去打接口了：只会被跳到登录页，白记一堆失败。
    for (const [name, label] of [
      ['login', '登录态'], ['timeline', '关注流'], ['hot', '热门'],
      ['topic', `超话（#${topic}#）`], ['hotComments', '热评'], ['image', '图片'],
    ]) {
      items.push({ name, label, ok: null, ms: 0, error: '没有 cookie，跳过' })
    }
    const cd0 = readCooldown()
    return {
      ok: false,
      at: new Date().toISOString(),
      gapMs: getGap(),
      items,
      cooldown: {
        active: cd0.active,
        leftMin: Math.max(0, Math.ceil((cd0.until - Date.now()) / 60000)),
        reason: cd0.reason || '',
      },
      health: readHealth(),
      hint: '先保存 cookie（weibo_login 或设置页「登录」），再跑自检。',
    }
  }

  await probe('login', '登录态', async () => {
    const r = await checkLogin(cookie)
    if (!r.ok) throw new WeiboAuthError('接口说没登录，cookie 可能过期了')
    return r.screenName ? `@${r.screenName}${r.uid ? ` (${r.uid})` : ''}` : '已登录'
  })

  await probe('timeline', '关注流', async () => {
    const r = await fetchTimeline({ cookie, count: 1, pageLimit: 1 })
    if (!r.posts.length) throw new WeiboError('返回 0 条（cookie 可能失效，或被限流）', 'EMPTY')
    firstPost = r.posts[0]
    return `${r.posts.length} 条`
  })

  await probe('hot', '热门', async () => {
    const r = await fetchHot({ cookie, containerIds: [DEFAULT_HOT_ID], count: 5 })
    if (!r.posts.length) throw new WeiboError('返回 0 条（分类接口可能改版）', 'EMPTY')
    return `${r.posts.length} 条`
  })

  await probe('topic', `超话（#${topic}#）`, async () => {
    const r = await fetchTopicFeed({ cookie, title: topic, pageLimit: 1 })
    if (!r.posts.length) throw new WeiboError('搜索返回 0 条（可能只是这个词没内容）', 'EMPTY')
    return `${r.posts.length} 条`
  })

  if (firstPost) {
    await probe('hotComments', '热评', async () => {
      const list = await fetchHotComments({ mid: firstPost.id, count: 1, strict: true })
      if (!list.length) return { skip: '这条没有热评（接口正常，不代表通道坏了）' }
      return `${list.length} 条`
    })
    const img = firstPost.images?.[0]?.url || firstPost.cover || ''
    if (img) {
      await probe('image', '图片', async () => {
        const r = await fetchImageBytes(img)
        if (!r.buf.length) throw new WeiboError('图片是空的', 'EMPTY')
        return `${Math.round(r.buf.length / 1024)} KB`
      })
    } else {
      items.push({ name: 'image', label: '图片', ok: null, ms: 0, error: '这条没有配图，跳过' })
    }
  } else {
    items.push({ name: 'hotComments', label: '热评', ok: null, ms: 0, error: '没有可用的微博 id，跳过' })
    items.push({ name: 'image', label: '图片', ok: null, ms: 0, error: '没有可用的图片地址，跳过' })
  }

  // 核心能力：cookie / 登录 / 关注流 / 热门。其余是辅助，坏了不影响刷。
  const must = ['cookie', 'login', 'timeline', 'hot']
  const ok = items.filter((x) => must.includes(x.name)).every((x) => x.ok === true)

  const cd = readCooldown()
  return {
    ok,
    at: new Date().toISOString(),
    gapMs: getGap(),
    items,
    cooldown: {
      active: cd.active,
      leftMin: Math.max(0, Math.ceil((cd.until - Date.now()) / 60000)),
      reason: cd.reason || '',
    },
    health: readHealth(),
    hint: ok
      ? '通道正常。'
      : '看 items 里 ok:false 的那一项：对应接口可能改版、cookie 过期，或正在风控熔断。',
  }
}


