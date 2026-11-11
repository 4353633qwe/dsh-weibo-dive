/**
 * lib/filter.mjs —— 把超话流里的垃圾挡在模型外面
 *
 * 微博超话的搜索结果里，抽奖机器人 / 代肝广告能占七成：
 *   「我在#绝区零#福利中心活动中抽中了关注礼包，快来一起参与吧！」
 *   「#绝区零代肝# 🌠-http://t.cn/xxx V：abc123」
 * 这些东西交给模型，等于把 10 条素材里的 7 条烧成废token，还容易让它学歪口吻。
 *
 * 所以先在抓取层筛一遍，模型只看到有内容可接的帖子。
 * 判据宁可宽一点（漏掉几条广告没关系，别把真人发言误杀）。
 */

/** 明显的机器号 / 广告特征 */
const SPAM_PATTERNS = [
  /福利中心/,                       // 官方抽奖机器人
  /抽中了[^，。！]{0,8}(礼包|原石|点券|皮肤|钻石)/,
  /快来一起参与|一起来参加吧/,
  /代肝|代练|代打/,
  /加\s*[Vv微]|[Vv]\s*[:：]\s*[A-Za-z0-9_-]{5,}/,
  /返利|秒到账|回收账号|收号|出售账号/,
  /直播间|点关注不迷路|双击关注/,
  /商品到店|到店情报|新品上市|现货开售|限时特惠|摄影会|门店速报/,
  /^#?[\u4e00-\u9fa5]{0,6}代肝#?$/,
]

/** 链接刷屏：正文里塞了两个以上短链，基本是推广 */
function linkSpam(text) {
  const links = text.match(/https?:\/\/t\.cn\/|http:\/\/t\.cn\//g)
  return Boolean(links && links.length >= 2)
}

/**
 * 剥掉标签、@提及、表情、链接之后还剩多少字。
 *
 * 有一类帖子很常见：`#绝区零# #绝区零3.3# #绝区零赛维里安# @鸭鸭九琼`
 * ——看着有几十个字，其实一个信息都没有。用原文长度判断不出来，得先剥干净。
 */
export function effectiveText(text) {
  return String(text || '')
    .replace(/#[^#\n]{1,40}#/g, '')            // #超话# / #话题#
    .replace(/@\s?[\w\u4e00-\u9fa5-]{1,24}/g, '') // @某人（有的号写成「@ 名字」）
    .replace(/\[[^\]\n]{1,12}\]/g, '')          // [打call] [心] 这类
    .replace(/https?:\/\/\S+/g, '')             // 链接
    .replace(/[\s\u200b]+/g, '')                // 空白和零宽字符
    .trim()
}

/**
 * 这条值不值得给模型看。
 * @param {{text?:string, pics?:number, hasVideo?:boolean, author?:string}} p
 * @returns {boolean} true = 是垃圾，丢掉
 */
export function isSpam(p) {
  const text = String(p?.text || '').trim()
  if (!text) return true
  if (SPAM_PATTERNS.some((re) => re.test(text))) return true
  if (linkSpam(text)) return true
  // 剥掉标签 / @ / 表情 / 链接之后什么都不剩 —— 纯标签帖、画师搬运帖。
  // 不看有没有配图：模型读不到图，一条只有「#绝区零# DDD @某人」的帖子它没法接话，
  // 留着只会占掉十个名额里的一个。
  const eff = effectiveText(text)
  if (eff.length < 5) return true
  return false
}

/**
 * 过滤一轮素材。
 * @returns {{kept:Array, dropped:number, samples:string[]}}
 */
export function filterPosts(posts) {
  const kept = []
  const samples = []
  const seenText = new Set()
  let dropped = 0
  for (const p of posts || []) {
    // 内容完全重复（同一个号连发好几条一样的）
    const key = effectiveText(p?.text)
    const dup = key && seenText.has(key)
    if (dup || isSpam(p)) {
      dropped += 1
      if (samples.length < 3) samples.push(String(p?.text || '').slice(0, 30))
      continue
    }
    if (key) seenText.add(key)
    kept.push(p)
  }
  return { kept, dropped, samples }
}

/**
 * 挑这一轮要读的：同一作者最多 2 条，避免一个人刷屏占满整轮。
 * @param {Array} posts 已过滤的候选
 * @param {number} limit
 */
export function pickDiverse(posts, limit) {
  const byAuthor = new Map()
  const out = []
  for (const p of posts || []) {
    const n = byAuthor.get(p.author) || 0
    if (n >= 2) continue
    byAuthor.set(p.author, n + 1)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}
