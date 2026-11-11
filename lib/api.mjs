/**
 * lib/api.mjs —— 设置页的 HTTP 接口
 *
 * ⚠️ 这个文件**只能**在静态注入 `webServer` 的入口里用（index.js）。
 * 之前踩了很久的坑：用 `ctx.inject(['webServer'], cb)` 拿到的实例是「影子」——
 * `register()` 不报错、`match()` 自检命中、8 秒后路由还在，但 handler 永远不被调用，
 * 请求落到另一个返回空 404 的实例上。同表里 dsh-market 的路由却是 200。
 * 换成静态 `inject: ['webServer']` + `ctx.webServer.register()` 之后一次就通了。
 *
 * 代价是 headless profile 没有 webServer，静态注入会让插件 pending、工具全废，
 * 所以 headless 走另一个入口（headless.js），那份不引这个文件。
 */
import { readConfig, writeConfig, DEFAULTS, readCookie, writeCookie, maskCookie, parseCookie, normalizeCookieInput, readAccount, writeAccount } from './config.mjs'
import { listCategories, fetchLiveCategories, resolveCategorySpec, nameOf, CAUTION_KEYS } from './categories.mjs'
import * as weibo from './weibo.js'
import { readPersona, writePersona, personaName } from './persona.mjs'
import { todayStats } from './comments.mjs'
import { scheduleStatus, nextAt, ensurePlan, atToClock } from './schedule.mjs'
import { readDiary, dayKey } from './diary.mjs'
import { seenStats, resetSeen } from './history.mjs'
import { runRound, lockOwner, readHeartbeat } from './runner.mjs'
import { postDiary, preparePost, readDraft, postQuota, composePostText } from './posting.mjs'
import { checkDepsAsync } from './deps.mjs'
import { collectCandidates, replyQuota, readReplyState } from './replies.mjs'

const PREFIX = '/dsh-weibo-dive/api'
const PATHS = [
  '/settings', '/persona', '/run', '/status', '/diary', '/categories', '/login',
  '/dedupe', '/doctor', '/deps', '/post', '/replies',
]

function sendJson(res, code, obj) {
  let body
  try { body = JSON.stringify(obj) } catch { body = '{"ok":false,"error":"返回内容无法序列化"}' }
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function readBody(req, limit = 512_000) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > limit) { req.destroy(); resolve({}) }
    })
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } })
  })
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** 只比 hostname：反代 / 端口映射下 Origin 与 Host 的端口经常不一致（这台是公网 IP + nginx） */
function isSameOrigin(origin, host) {
  if (!origin) return true // curl / 同源 GET 可能没有 Origin 头
  let o
  let h
  try { o = new URL(origin) } catch { return false }
  try { h = new URL('http://' + String(host || '')) } catch { return false }
  if (LOOPBACK.has(o.hostname) && LOOPBACK.has(h.hostname)) return true
  return o.hostname === h.hostname
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

function normWindows(list, fallback) {
  if (!Array.isArray(list)) return fallback
  const out = []
  for (const w of list.slice(0, 6)) {
    const start = /^\d{1,2}:\d{2}$/.test(String(w?.start)) ? String(w.start) : null
    const end = /^\d{1,2}:\d{2}$/.test(String(w?.end)) ? String(w.end) : null
    if (!start || !end) continue
    out.push({ start, end, wakes: Math.round(clamp(w?.wakes, 0, 6, 1)) })
  }
  return out.length ? out : fallback
}

/** 只接受白名单字段，逐个夹紧范围 */
export function normalizeConfig(incoming, cur) {
  const p = {}
  const has = (k) => incoming[k] !== undefined && incoming[k] !== null

  if (has('readPerRound')) p.readPerRound = Math.round(clamp(incoming.readPerRound, 1, 50, cur.readPerRound))
  if (has('pageLimit')) p.pageLimit = Math.round(clamp(incoming.pageLimit, 1, 5, cur.pageLimit))
  if (has('maxTextChars')) p.maxTextChars = Math.round(clamp(incoming.maxTextChars, 40, 2000, cur.maxTextChars))
  if (has('autoTopic')) p.autoTopic = String(incoming.autoTopic).trim().slice(0, 40)
  if (has('feedMode')) {
    const m = String(incoming.feedMode).toLowerCase()
    p.feedMode = ['hot', 'timeline', 'topic'].includes(m) ? m : 'hot'
  }
  if (incoming.hotCategories !== undefined) {
    // 允许传 ["102803_...", …] 或 "搞笑,社会"
    const raw = Array.isArray(incoming.hotCategories)
      ? incoming.hotCategories.join(',')
      : String(incoming.hotCategories || '')
    const r = resolveCategorySpec(raw)
    p.hotCategories = r.ids.length ? r.ids : []
  }
  if (has('autoComment')) p.autoComment = incoming.autoComment === true
  if (has('commentChance')) p.commentChance = Math.round(clamp(incoming.commentChance, 0, 1, cur.commentChance) * 100) / 100
  if (has('commentDailyLimit')) p.commentDailyLimit = Math.round(clamp(incoming.commentDailyLimit, 0, 20, cur.commentDailyLimit))
  if (has('commentMinGapMin')) p.commentMinGapMin = Math.round(clamp(incoming.commentMinGapMin, 0, 1440, cur.commentMinGapMin))
  if (has('commentPerRound')) p.commentPerRound = Math.round(clamp(incoming.commentPerRound, 0, 3, cur.commentPerRound ?? 1))
  if (has('likes')) p.likes = String(incoming.likes).slice(0, 300)
  if (has('dislikes')) p.dislikes = String(incoming.dislikes).slice(0, 300)
  if (has('visionEnabled')) p.visionEnabled = incoming.visionEnabled === true
  if (has('autoRun')) p.autoRun = incoming.autoRun === true
  if (has('runTimeoutMin')) p.runTimeoutMin = Math.round(clamp(incoming.runTimeoutMin, 1, 60, cur.runTimeoutMin))
  if (has('headlessProfile')) p.headlessProfile = String(incoming.headlessProfile).trim().slice(0, 40) || 'headless'
  if (has('dedupeRounds')) p.dedupeRounds = Math.round(clamp(incoming.dedupeRounds, 0, 50, cur.dedupeRounds ?? 5))
  if (has('autoPost')) p.autoPost = incoming.autoPost === true
  if (has('postAt')) {
    const t = String(incoming.postAt || '').trim()
    if (/^\d{1,2}:\d{2}$/.test(t)) p.postAt = t
  }
  if (has('postMode')) p.postMode = String(incoming.postMode).toLowerCase() === 'topic' ? 'topic' : 'diary'
  if (has('postTopic')) p.postTopic = String(incoming.postTopic).replace(/^#+|#+$/g, '').trim() || 'DeepSeek'
  if (has('postDailyLimit')) p.postDailyLimit = Math.round(clamp(incoming.postDailyLimit, 0, 3, cur.postDailyLimit ?? 1))
  if (has('autoReplyComment')) p.autoReplyComment = incoming.autoReplyComment === true
  if (has('autoReplyPerDay')) p.autoReplyPerDay = Math.round(clamp(incoming.autoReplyPerDay, 0, 10, cur.autoReplyPerDay ?? 2))
  if (has('autoReplyMaxAgeMin')) p.autoReplyMaxAgeMin = Math.round(clamp(incoming.autoReplyMaxAgeMin, 10, 10080, cur.autoReplyMaxAgeMin ?? 720))

  if (incoming.night && typeof incoming.night === 'object') {
    const n = { ...(cur.night || {}) }
    if (incoming.night.enabled !== undefined) n.enabled = incoming.night.enabled === true
    if (incoming.night.windows !== undefined) n.windows = normWindows(incoming.night.windows, cur.night?.windows || [])
    if (incoming.night.minGapMin !== undefined) n.minGapMin = Math.round(clamp(incoming.night.minGapMin, 0, 1440, cur.night?.minGapMin ?? 20))
    p.night = n
  }
  return p
}

// ── 手动起一轮（后台跑，不等） ─────────────────────────────────────────────
let webRunning = false
let webLastRun = null

function startRound({ comment, topic } = {}) {
  const cfg = readConfig()
  const c = String(comment || '').toLowerCase()
  const allowComment = c === 'yes' ? true
    : c === 'no' ? false
      : (cfg.autoComment !== false && Math.random() < Number(cfg.commentChance ?? 0.35))
  const forceTopic = String(topic ?? cfg.autoTopic ?? '').trim()
  const roundId = `web-${Date.now()}`

  webRunning = true
  runRound({
    profile: cfg.headlessProfile || 'headless',
    timeoutMs: (Number(cfg.runTimeoutMin) || 10) * 60_000,
    roundId,
    allowComment,
    forceTopic,
    clock: atToClock(new Date().getHours() * 60 + new Date().getMinutes()),
  }).then((r) => {
    webLastRun = {
      at: Date.now(),
      ok: r.ok === true,
      summary: String(r.summary || ''),
      seconds: Math.round((r.ms || 0) / 1000),
      error: r.error || '',
      allowComment,
      topic: forceTopic,
    }
    console.log(`[weibo-dive] 设置页起的一轮结束：${webLastRun.ok ? `ok ${webLastRun.seconds}s` : webLastRun.error}`)
  }).catch((e) => {
    webLastRun = { at: Date.now(), ok: false, summary: '', error: String(e?.message ?? e) }
    console.log(`[weibo-dive] 设置页起的一轮出错：${e?.message ?? e}`)
  }).finally(() => { webRunning = false })

  return { ok: true, started: true, roundId, allowComment, topic: forceTopic || null }
}

/**
 * 挂路由。只能在静态注入了 webServer 的入口里调用。
 * @param {object} ctx 插件 ctx（需要 ctx.webServer）
 */
export function mountApiRoutes(ctx) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return

  const statusPayload = () => {
    const cfg = readConfig()
    const st = scheduleStatus(new Date())
    const cs = todayStats()
    const ck = parseCookie(readCookie())
    const hb = readHeartbeat()
    return {
      login: { has: ck.hasSub, masked: ck.hasSub ? maskCookie(readCookie()) : '' },
      account: readAccount(),
      comments: {
        today: cs.count,
        limit: cfg.commentDailyLimit,
        corrupt: cs.corrupt === true,
        error: cs.corrupt ? cs.error : '',
      },
      plan: (st.today || []).map((x) => ({ clock: x.clock, done: x.done, result: x.result || '' })),
      next: nextAt(new Date())?.clock || null,
      autoRun: cfg.autoRun === true,
      feedMode: cfg.feedMode || 'hot',
      dedupe: seenStats(cfg),
      hotCategories: Array.isArray(cfg.hotCategories) ? cfg.hotCategories : [],
      hotCategoryNames: (Array.isArray(cfg.hotCategories) ? cfg.hotCategories : []).map(nameOf),
      autoTopic: cfg.autoTopic || '',
      running: webRunning || Boolean(lockOwner()) || Boolean(hb && hb.ageSec < 120),
      last: webLastRun,
      channel: weibo.channelInfo(),
      posts: postQuota(),
      replies: replyQuota(),
    }
  }

  const handle = async (req, res) => {
    if (!isSameOrigin(req.headers?.origin, req.headers?.host)) {
      return sendJson(res, 403, { ok: false, error: '跨站请求被拒（只接受同源）' })
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(PREFIX, '') || '/'
    const method = (req.method || 'GET').toUpperCase()

    if (sub === '/settings' && method === 'GET') {
      const cfg0 = readConfig()
      const cats = listCategories()
      return sendJson(res, 200, {
        ok: true,
        config: cfg0,
        status: statusPayload(),
        persona: { name: personaName(), text: readPersona() },
        categories: cats.items.map((c) => ({
          key: c.key || '',
          name: c.name,
          id: c.id,
          caution: CAUTION_KEYS.includes(c.key),
        })),
        categoriesCached: cats.cached,
      })
    }

    if (sub === '/settings' && method === 'POST') {
      const body = await readBody(req)
      const incoming = body?.config && typeof body.config === 'object' ? body.config : body
      const cur = readConfig()
      const patch = normalizeConfig(incoming || {}, cur)
      if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, changed: [], config: cur })
      const next = writeConfig(patch)
      try { ensurePlan({ windows: next.night?.windows, minGapMin: next.night?.minGapMin }, new Date()) } catch { /* 不影响保存 */ }
      return sendJson(res, 200, { ok: true, changed: Object.keys(patch), config: next, status: statusPayload() })
    }

    if (sub === '/persona' && method === 'POST') {
      const body = await readBody(req)
      const content = String(body?.content || '').trim()
      const append = String(body?.append || '').trim()
      if (!content && !append) return sendJson(res, 400, { ok: false, error: '内容为空' })
      const next = content || `${readPersona()}\n\n${append}`
      writePersona(next)
      return sendJson(res, 200, { ok: true, chars: next.length, text: next })
    }

    if (sub === '/run' && method === 'POST') {
      if (!readCookie()) return sendJson(res, 400, { ok: false, error: '还没登录，先存 cookie' })
      if (webRunning || lockOwner()) return sendJson(res, 409, { ok: false, error: '已经有一轮在跑了' })
      const body = await readBody(req)
      return sendJson(res, 200, startRound({ comment: body?.comment, topic: body?.topic }))
    }

    if (sub === '/categories' && method === 'GET') {
      if (url.searchParams.get('refresh') === '1') {
        const ck = readCookie()
        if (!ck) return sendJson(res, 400, { ok: false, error: '还没登录，拉不到分类列表' })
        try {
          await fetchLiveCategories(() => weibo.fetchGroupList(ck))
        } catch (e) {
          return sendJson(res, 502, { ok: false, error: `拉分类失败：${e.message}` })
        }
      }
      const cats = listCategories()
      const cfg0 = readConfig()
      const sel = new Set(Array.isArray(cfg0.hotCategories) ? cfg0.hotCategories : [])
      return sendJson(res, 200, {
        ok: true,
        cached: cats.cached,
        categories: cats.items.map((c) => ({
          key: c.key || '',
          name: c.name,
          id: c.id,
          caution: CAUTION_KEYS.includes(c.key),
          selected: sel.has(c.id),
        })),
      })
    }

    if (sub === '/login' && method === 'GET') {
      const ck = readCookie()
      if (!ck) return sendJson(res, 200, { ok: true, has: false })
      return sendJson(res, 200, { ok: true, has: true, masked: maskCookie(ck) })
    }

    if (sub === '/login' && method === 'POST') {
      const body = await readBody(req)
      // 设置页拆成 SUB / SUBP 两个输入框；老的整串 cookie 也还认
      const subVal = String(body?.sub || '').trim()
      const subpVal = String(body?.subp || '').trim()
      const parts = []
      if (subVal) parts.push(/^SUB=/i.test(subVal) ? subVal : `SUB=${subVal}`)
      if (subpVal) parts.push(/^SUBP=/i.test(subpVal) ? subpVal : `SUBP=${subpVal}`)
      const incoming = normalizeCookieInput(parts.length ? parts.join('; ') : body?.cookie)
      if (!incoming) return sendJson(res, 400, { ok: false, error: '没有收到 cookie' })
      const parsed = parseCookie(incoming)
      if (!parsed.hasSub) {
        return sendJson(res, 400, {
          ok: false,
          error: '这串里没有 SUB，不是登录态',
          gotKeys: parsed.keys,
          hint: '在 weibo.com 登录后按 F12 → Application → Cookies，把 SUB（和 SUBP，如果有）填到对应框里',
        })
      }
      writeCookie(incoming)
      try {
        const r = await weibo.checkLogin(readCookie())
        // 校验成功就记下账号，设置页直接读 account.json 显示 uid
        if (r.ok && (r.uid || r.screenName)) {
          try { writeAccount({ uid: r.uid, screenName: r.screenName }) } catch { /* 存不下不影响登录 */ }
        }
        return sendJson(res, 200, {
          ok: true,
          valid: r.ok,
          masked: maskCookie(incoming),
          uid: r.uid || '',
          screenName: r.screenName || '',
          note: r.ok ? '登录态有效' : '存下来了，但接口说没登录——cookie 可能过期了',
        })
      } catch (e) {
        return sendJson(res, 200, {
          ok: true,
          valid: false,
          masked: maskCookie(incoming),
          note: `存下来了，但校验失败：${String(e?.message ?? e).slice(0, 80)}`,
        })
      }
    }

    if (sub === '/status' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...statusPayload(), config: readConfig() })
    }

    if (sub === '/dedupe' && method === 'GET') {
      return sendJson(res, 200, { ok: true, dedupe: seenStats(readConfig()) })
    }

    // 清空跨轮「已读」记录。写空文件（不是删文件），否则下次会被 raw/ 回填灌满。
    if (sub === '/dedupe' && method === 'POST') {
      const r = resetSeen()
      if (r.ok === false) return sendJson(res, 500, { ok: false, error: r.error })
      return sendJson(res, 200, { ok: true, cleared: r.cleared ?? 0, status: statusPayload() })
    }

    // 首次使用的依赖检查：Node / dsh / headless profile / 数据目录 / 网络 / cookie
    if (sub === '/deps' && (method === 'GET' || method === 'POST')) {
      try {
        const d = await checkDepsAsync()
        return sendJson(res, 200, { ok: true, deps: d })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `依赖检查没跑起来：${e?.message ?? e}` })
      }
    }

    if (sub === '/diary' && method === 'GET') {
      return sendJson(res, 200, readDiary({ lines: Number(url.searchParams.get('lines')) || 200 }))
    }

    // 通道自检：逐项探测接口还能不能用。只读，不碰评论。
    if (sub === '/doctor' && (method === 'GET' || method === 'POST')) {
      const cfg0 = readConfig()
      const topic = String(url.searchParams.get('topic') || cfg0.autoTopic || '')
        .split(/[,，、\s]+/).filter(Boolean)[0] || '微博'
      try {
        const r = await weibo.diagnose({ cookie: readCookie(), topic })
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `自检没跑起来：${e?.message ?? e}` })
      }
    }

    // 发博：GET 让模型生成草稿（日记模式 / 超话话题模式）；POST 才发。
    if (sub === '/post' && method === 'GET') {
      try {
        const r = await preparePost({
          mode: url.searchParams.get('mode') || '',
          topic: url.searchParams.get('topic') || '',
        })
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `生成草稿失败：${e?.message ?? e}` })
      }
    }
    if (sub === '/post' && method === 'POST') {
      const body = await readBody(req)
      const d = readDraft({ day: dayKey(), uid: readAccount().uid })
      const raw = String((body && body.content) || (d && d.text) || '').trim()
      if (!raw) return sendJson(res, 400, { ok: false, error: '还没有草稿，先生成再发' })
      const mode = String((body && body.mode) || (d && d.mode) || 'diary')
      const topic = String((body && body.topic) || (d && d.topic) || '')
      try {
        const r = await postDiary({
          content: composePostText(raw, { mode, topic }),
          confirm: body?.confirm === true,
          mode,
          topic,
        })
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `发送失败：${e?.message ?? e}` })
      }
    }

    // 回评：看最近别人在她微博下的评论（只读，不发）。
    if (sub === '/replies' && method === 'GET') {
      try {
        const r = await collectCandidates({ limit: 10 })
        const st = readReplyState()
        return sendJson(res, 200, {
          ok: true,
          quota: replyQuota(),
          ...r,
          last: { at: st.lastAttemptAt, error: st.lastError },
        })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `拉评论失败：${e?.message ?? e}` })
      }
    }

    return sendJson(res, 404, { ok: false, error: `没有这个接口：${sub}` })
  }

  let count = 0
  const reg = (route) => {
    try {
      ctx.effect(() => webServer.register(route))
      count += 1
    } catch (e) {
      console.log(`[weibo-dive] 路由 ${route.path} 注册失败：${e?.message ?? e}`)
    }
  }

  for (const p of PATHS) reg({ kind: 'exact', path: `${PREFIX}${p}`, handler: handle })
  reg({ kind: 'prefix', path: PREFIX, handler: handle })

  console.log(`[weibo-dive] 设置页接口已挂载：${PREFIX}/*（${count} 条路由）`)
}
