/**
 * lib/channel.mjs —— 微博请求通道（全插件唯一的 HTTP 出口）
 *
 * 为什么要有这一层（参考「刷贴吧」的做法）：
 *
 *   1. **端点集中登记**。以前每个 fetch 各自拼 URL、各自写 Referer/UA/超时，
 *      微博一改接口，就得满文件找。现在所有端点都在 ENDPOINTS 里，改一行就够。
 *   2. **节奏由通道统一控制**。以前是调用方在循环里 setTimeout(800)，谁忘了写就
 *      一口气打过去。现在每次请求前统一 pace()，最小间隔 GAP_MS。
 *   3. **风控熔断要落盘**。微博撞到「操作频繁 / 安全验证 / 418」之后，继续请求只会
 *      把账号越推越深。这里跟贴吧一样：撞一次就 trip()，冷却期内一个请求都不发，
 *      重启之后也还在冷却（cooldown.json）。
 *   4. **失败要分得清**。cookie 过期、被限流、接口改结构、网络挂了，处理方式完全不同。
 *      统一抛 WeiboError，带 code：NOT_LOGIN / RATE_LIMIT / CHANGED / NETWORK /
 *      EMPTY / COOLDOWN。上层据此给模型不同提示，而不是一句「请求失败」。
 *   5. **能力健康要留痕**。每个端点最近一次成功/失败、耗时、错误都写 health.json，
 *      设置页和 weibo_doctor 直接读它 —— 接口悄悄坏掉时能看见，而不是静默降级。
 *
 * 重试策略：只重试 GET（网络错误 / 5xx）。POST 一律不重试 —— 评论重发会出双份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir } from './config.mjs'

export const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/**
 * 端点注册表。
 *   base      默认 https://weibo.com
 *   path      接口路径
 *   method    默认 GET
 *   ua        用哪个 UA（热门评论走手机站，必须是手机 UA）
 *   referer   该端点要求的来源页
 *   auth      是否带 cookie
 *   timeoutMs 单次超时
 *   retry     覆盖默认重试次数（GET 默认 1，POST 默认 0）
 *   binary    返回 Buffer（图片）
 */
export const ENDPOINTS = {
  timeline: { path: '/ajax/feed/friendstimeline', referer: 'https://weibo.com/', auth: true, timeoutMs: 20000 },
  groups: { path: '/ajax/feed/allGroups', referer: 'https://weibo.com/', auth: true, timeoutMs: 20000 },
  hottimeline: { path: '/ajax/feed/hottimeline', referer: 'https://weibo.com/', auth: true, timeoutMs: 20000 },
  search: { path: '/ajax/statuses/search', referer: 'https://weibo.com/', auth: true, timeoutMs: 20000 },
  sideUser: { path: '/ajax/side/cards/sideUser', referer: 'https://weibo.com/', auth: true, timeoutMs: 15000 },
  myblog: { path: '/ajax/statuses/mymblog', referer: 'https://weibo.com/', auth: true, timeoutMs: 15000 },
  homepage: { path: '/', referer: 'https://weibo.com/', auth: true, timeoutMs: 20000 },
  commentCreate: {
    path: '/ajax/comments/create', method: 'POST', referer: 'https://weibo.com/', auth: true, timeoutMs: 25000, retry: 0,
  },
  commentReply: {
    path: '/ajax/comments/reply', method: 'POST', referer: 'https://weibo.com/', auth: true, timeoutMs: 25000, retry: 0,
  },
  statusUpdate: {
    path: '/ajax/statuses/update', method: 'POST', referer: 'https://weibo.com/', auth: true, timeoutMs: 25000, retry: 0,
  },
  chaohuaFeed: {
    // 超话 feed：containerid=100808..._ -_feed，发完用来确认帖子真进去了。
    // 这个接口必须带 XHR 头，否则 403；403 只是某个超话不给看，不能触发全局熔断。
    path: '/ajax_proxy/chaohua/page', referer: 'https://weibo.com/', auth: true, timeoutMs: 20000, trip: false,
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  },
  hotflow: {
    base: 'https://m.weibo.cn', path: '/comments/hotflow', ua: MOBILE_UA,
    referer: 'https://m.weibo.cn/', auth: false, timeoutMs: 12000,
  },
  mcomments: {
    // 按时间排的评论列表。偶发返回 SPA HTML，调用方要能降级到 hotflow。
    base: 'https://m.weibo.cn', path: '/api/comments/show', ua: MOBILE_UA,
    referer: 'https://m.weibo.cn/', auth: false, timeoutMs: 12000,
  },
  image: {
    // 图床不是微博的接口：403 只代表这张图不给，不代表账号被风控，绝不能触发全局熔断。
    base: '', referer: 'https://weibo.com/', ua: MOBILE_UA, auth: false, timeoutMs: 12000, binary: true, trip: false,
  },
}

// ── 错误分类 ───────────────────────────────────────────────────────────────
export class WeiboError extends Error {
  constructor(message, code = 'UNKNOWN', extra = {}) {
    super(message)
    this.name = 'WeiboError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** 保留旧名字：上层有些地方按 e.name === 'WeiboAuthError' 给提示 */
export class WeiboAuthError extends WeiboError {
  constructor(message) {
    super(message, 'NOT_LOGIN')
    this.name = 'WeiboAuthError'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 节奏 ───────────────────────────────────────────────────────────────────
let GAP_MS = 900
let lastAt = 0

export function setGap(ms) {
  const n = Number(ms)
  if (Number.isFinite(n)) GAP_MS = Math.max(200, Math.min(5000, Math.round(n)))
}
export const getGap = () => GAP_MS

async function pace() {
  const left = GAP_MS - (Date.now() - lastAt)
  if (left > 0) await sleep(left)
  lastAt = Date.now()
}

// ── 熔断（落盘，重启也认） ─────────────────────────────────────────────────
export const cooldownFile = () => path.join(dir(), 'cooldown.json')

export function readCooldown() {
  try {
    const j = JSON.parse(fs.readFileSync(cooldownFile(), 'utf8'))
    const until = Number(j.until) || 0
    return { until, reason: j.reason || '', active: until > Date.now() }
  } catch {
    return { until: 0, reason: '', active: false }
  }
}

export function remainingMs() {
  return Math.max(0, readCooldown().until - Date.now())
}

export function trip(minutes = 30, reason = '微博风控') {
  const ms = Math.max(0, Number(minutes) || 0) * 60_000
  if (!ms) return { active: false }
  const until = Date.now() + ms
  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(cooldownFile(), JSON.stringify({ until, reason, at: new Date().toISOString() }, null, 1) + '\n', 'utf8')
    console.log(`[weibo-dive] 通道熔断 ${Math.round(ms / 60000)} 分钟：${reason}`)
  } catch (e) {
    console.log(`[weibo-dive] 熔断记录没写进去：${e?.message ?? e}`)
  }
  return { active: true, until, reason }
}

export function clearCooldown() {
  try { fs.unlinkSync(cooldownFile()) } catch { /* 本来就没有 */ }
  return { active: false }
}

// ── 健康记录 ───────────────────────────────────────────────────────────────
export const healthFile = () => path.join(dir(), 'health.json')

export function readHealth() {
  try {
    const j = JSON.parse(fs.readFileSync(healthFile(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function record(name, ok, info) {
  try {
    const all = readHealth()
    const ep = all[name] || { ok: 0, fail: 0 }
    const now = Date.now()
    if (ok) {
      ep.ok = Number(ep.ok || 0) + 1
      ep.lastOkAt = now
      if (info && Number.isFinite(info.ms)) ep.lastMs = info.ms
    } else {
      ep.fail = Number(ep.fail || 0) + 1
      ep.lastFailAt = now
      ep.lastFailError = String(info?.message || info || '').slice(0, 140)
      ep.lastFailCode = String(info?.code || '')
    }
    all[name] = ep
    all.updatedAt = now
    fs.mkdirSync(dir(), { recursive: true })
    // 先写临时文件再改名：web / headless / 子进程可能同时在写，
    // 直接写有机会被读到半截 JSON（那会把这之前的历史全丢掉）。
    const f = healthFile()
    const tmp = `${f}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1), 'utf8')
    fs.renameSync(tmp, f)
  } catch { /* 健康记录不能影响主流程 */ }
}

/** 给设置页 / 工具看的一句话状态 */
export function channelInfo() {
  const cd = readCooldown()
  return {
    gapMs: GAP_MS,
    cooldown: {
      active: cd.active,
      leftMin: Math.max(0, Math.ceil((cd.until - Date.now()) / 60000)),
      reason: cd.reason || '',
      until: cd.until || 0,
    },
    health: readHealth(),
  }
}

// ── 请求 ───────────────────────────────────────────────────────────────────
function buildUrl(spec, query) {
  const base = spec.base === undefined ? 'https://weibo.com' : spec.base
  const u = new URL(`${base}${spec.path || ''}`)
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue
    u.searchParams.set(k, String(v))
  }
  return u.toString()
}

/** 验证码 / 限流这类页面，文字判断（微博的拦截页没有固定格式） */
const BLOCK_TEXT = /(安全验证|访问过于频繁|操作过于频繁|系统繁忙|请求过于频繁|too many requests|rate limit|验证码|slide|captcha)/i

async function once(name, spec, o) {
  await pace()

  const url = o.url || buildUrl(spec, o.query)
  const method = (o.method || spec.method || 'GET').toUpperCase()
  const ms = Number(o.timeoutMs) || spec.timeoutMs || 20000
  const headers = {
    'User-Agent': spec.ua || PC_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Accept: o.binary ? '*/*' : 'application/json, text/plain, */*',
  }
  if (spec.referer) headers.Referer = spec.referer
  if (spec.headers) Object.assign(headers, spec.headers)
  if ((spec.auth || o.cookie) && o.cookie) headers.Cookie = o.cookie
  Object.assign(headers, o.headers || {})
  if (o.form) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'

  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: o.form,
      redirect: 'follow',
      signal: AbortSignal.timeout(ms),
    })
  } catch (e) {
    const err = new WeiboError(`网络失败：${e.message}`, 'NETWORK')
    record(name, false, err)
    throw err
  }

  const duration = Date.now() - t0

  if (res.redirected && /passport|login|signin/i.test(res.url)) {
    const err = new WeiboAuthError('被跳到登录页：cookie 无效或已过期')
    record(name, false, err)
    throw err
  }
  if (res.status === 418 || res.status === 429 || res.status === 403) {
    if (spec.trip !== false) trip(30, `HTTP ${res.status}`)
    const err = new WeiboError(`被微博风控拦了（HTTP ${res.status}）`
      + (spec.trip === false ? '' : '，已熔断 30 分钟'), 'RATE_LIMIT')
    record(name, false, err)
    throw err
  }
  if (res.status >= 500) {
    const err = new WeiboError(`微博服务端错误（HTTP ${res.status}）`, 'NETWORK', { retryable: true })
    record(name, false, err)
    throw err
  }

  if (o.binary) {
    const buf = Buffer.from(await res.arrayBuffer())
    record(name, true, { ms: duration })
    return { buf, status: res.status, contentType: res.headers.get('content-type') || '', ms: duration }
  }

  const text = await res.text()
  if (o.raw) {
    record(name, true, { ms: duration })
    return { res, text, status: res.status, ms: duration }
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    if (BLOCK_TEXT.test(text)) {
      trip(30, '返回验证/限流页面')
      const err = new WeiboError('被拦到验证页了（返回的不是 JSON），已熔断 30 分钟', 'RATE_LIMIT')
      record(name, false, err)
      throw err
    }
    const head = text.slice(0, 80).replace(/\s+/g, ' ')
    const err = new WeiboError(`接口返回的不是 JSON（可能改版了）：${head}`, 'CHANGED')
    record(name, false, err)
    throw err
  }

  const msg = String(data?.msg || data?.message || '')
  if (data && (data.ok === -100 || (data.url && /passport|signin/i.test(String(data.url))))) {
    const err = new WeiboAuthError('接口要求登录态：cookie 缺失或过期')
    record(name, false, err)
    throw err
  }
  if (data && data.ok === 0 && /登录|login/i.test(msg)) {
    const err = new WeiboAuthError(`接口说没登录：${msg}`)
    record(name, false, err)
    throw err
  }
  if (data && data.ok === 0 && BLOCK_TEXT.test(msg)) {
    trip(30, msg.slice(0, 40))
    const err = new WeiboError(`微博限流：${msg}（已熔断 30 分钟）`, 'RATE_LIMIT')
    record(name, false, err)
    throw err
  }

  record(name, true, { ms: duration })
  return { data, status: res.status, ms: duration }
}

/**
 * 唯一出口。
 *
 * @param {string} name ENDPOINTS 里的端点名
 * @param {object} opt
 *   query    查询参数
 *   form     POST 表单（URLSearchParams）
 *   cookie   cookie 串（POST 时可含 XSRF）
 *   headers  额外请求头（写接口的 X-XSRF-TOKEN 等）
 *   url      跳过拼装，直接请求这个地址（图片）
 *   raw      返回原始 Response + 文本
 *   binary   返回 Buffer
 *   retry    覆盖重试次数
 */
export async function request(name, opt = {}) {
  const spec = ENDPOINTS[name]
  if (!spec) throw new WeiboError(`未登记的端点：${name}`, 'BUG')

  const cd = remainingMs()
  if (cd > 0) {
    throw new WeiboError(
      `风控熔断中：还要等 ${Math.ceil(cd / 60000)} 分钟（${readCooldown().reason || '上次被拦'}）`,
      'COOLDOWN',
      { until: readCooldown().until },
    )
  }

  const method = (opt.method || spec.method || 'GET').toUpperCase()
  const tries = Number.isFinite(opt.retry) ? Math.max(0, opt.retry)
    : Number.isFinite(spec.retry) ? spec.retry
      : method === 'GET' ? 1 : 0

  let lastErr
  for (let attempt = 0; attempt <= tries; attempt += 1) {
    if (attempt > 0) await sleep(1200)
    try {
      return await once(name, spec, { ...opt, method })
    } catch (e) {
      lastErr = e
      // 只有网络 / 5xx 值得再来一次；登录态、改版、限流重试也没用
      if (e.code !== 'NETWORK' || attempt >= tries) throw e
    }
  }
  throw lastErr
}
