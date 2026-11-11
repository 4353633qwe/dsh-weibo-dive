/**
 * dsh-weibo-dive —— 按作息醒来刷微博，写真人日记
 * ============================================================================
 * 插件退化成「调度器 + 工具集」：父进程排班、起 headless 子进程，
 * 一轮里的判断全交给模型（看配置 → 读人设 → 刷内容 → 决定回不回 → 写日记）。
 *
 * 唯一的输出是日记：她写给自己的随笔，不带链接、不交代来源（diary.md）。
 *
 * 四条底线：
 *   1. 唯一的写操作是评论，默认只预览、必须 confirm=true 才发，
 *      另有额度、最小间隔、「只评刷到过的帖子」三道闸；
 *   2. cookie 只存本地 `$DSH_HOME/weibo-dive/cookie.txt`（600），工具回显一律打码；
 *   3. 每轮请求有限速（页间 800ms），不去打疼人家接口；
 *   4. 跨轮去重是工具层的硬闸：最近 N 轮读过的帖子 id 不会再交给模型，
 *      提示词和模型自觉都拦不住重复，只有抓取层能。
 *
 * 为什么能纯 HTTP：微博 weibo.com/ajax/* 没有请求签名，只要有 SUB cookie 就行，
 * 不需要浏览器（对比抖音的 a_bogus、小红书的 x-s 就必须真浏览器）。
 */
import { defineTool as hostDefineTool } from './lib/toolkit.mjs'
import * as weibo from './lib/weibo.js'
import { mergeTopics, listTopics, topicsCount } from './lib/topics.mjs'
import { canComment, recordComment, findSeenPost, commentHistory, todayStats } from './lib/comments.mjs'
import { commentGate } from './lib/guard.mjs'
import { audit, failTripped } from './lib/audit.mjs'
import { ensurePlan, dueItem, markDone, scheduleStatus, nextAt, atToClock, lastDoneAt } from './lib/schedule.mjs'
import { ensurePersona, readPersona, writePersona, personaName } from './lib/persona.mjs'
import { runRound, readHeartbeat, lockOwner, dayLogFile, logsDir } from './lib/runner.mjs'
import { filterPosts, pickDiverse } from './lib/filter.mjs'
import { applyDedupe, recordRound, seenStats } from './lib/history.mjs'
import {
  resolveCategorySpec, listCategories, nameOf, fetchLiveCategories,
  CAUTION_KEYS, DEFAULT_IDS as DEFAULT_CATEGORY_IDS,
} from './lib/categories.mjs'
import { buildSchema } from './lib/schema.mjs'
import { mountApiRoutes } from './lib/api.mjs'
import {
  readConfig, writeConfig, DEFAULTS, readCookie, writeCookie, maskCookie, parseCookie,
  normalizeCookieInput, cfgFile, cookieFile, diaryFile, dir, readAccount, writeAccount,
} from './lib/config.mjs'
import { appendDiary, readDiary, saveRaw, stamp, dayKey, lastEntryText, similarity } from './lib/diary.mjs'
import { postDiary, preparePost, saveDraft, postQuota, buildPost } from './lib/posting.mjs'
import { collectCandidates, replyToComment, replyQuota, readReplyState, recordReplyAttempt, buildReplyPrompt } from './lib/replies.mjs'

export const name = 'dsh-weibo-dive'

// 必需依赖只声明 tools / settings。
// ⚠️ 不能把 webServer 写进来：headless profile 没有这个服务，
// 写进去整个插件会 PENDING、所有工具都不可用（子进程就废了）。
export const inject = ['tools', 'settings', 'webServer']

let z
try { z = (await import('@deepseek-ai/schemastery')).default } catch { z = null }

/** 设置页的配置契约；宿主没有 schemastery 时退化成「无表单、纯文件配置」 */
export const Config = z ? buildSchema(z) : undefined

const log = (...a) => console.log('[weibo-dive]', ...a)

/** 把一条微博压成模型能用的一行 */
function line(p, maxChars) {
  const body = p.text.length > maxChars ? `${p.text.slice(0, maxChars)}…` : p.text
  const flat = body.replace(/\n+/g, ' ')
  const extra = [p.hasVideo ? '视频' : '', p.pics ? `${p.pics} 图` : ''].filter(Boolean).join('·')
  const counts = `赞 ${p.likes} / 评 ${p.comments}`
  return {
    id: p.id,              // 评论要用这个
    mblogid: p.mblogid,
    author: p.author,
    text: flat,
    extra,
    counts,
    likes: p.likes,
    comments: p.comments,
    url: p.url,
    isRepost: p.isRepost,
    repostText: p.repostText,
    // 评论区热评：先看别人在说什么，再决定在帖子正文底下接哪句（拿不到就没有这个字段）
    hotComments: Array.isArray(p.hotComments) && p.hotComments.length
      ? p.hotComments.map((c) => ({ id: c.id, author: c.author, likes: c.likes, text: c.text }))
      : undefined,
  }
}

/**
 * 给这一轮的帖子挂上热评。
 *
 * 只挑评论数最多的前 maxPosts 条、每条 perPost 条：
 * 评论区是参考不是正文，热门一轮 10 条全拉会多出 10 个请求，把这一轮拖慢好几秒。
 * 任何一条失败都只是少一份参考，不能让整轮失败。
 */
async function attachHotComments(picked, { perPost = 3, maxPosts = 6, gapMs = 150 } = {}) {
  const targets = (picked || [])
    .filter((p) => p && Number(p.comments) >= 2)
    .sort((a, b) => Number(b.comments) - Number(a.comments))
    .slice(0, maxPosts)
  let got = 0
  for (const p of targets) {
    try {
      const list = await weibo.fetchHotComments({ mid: p.id, count: perPost })
      if (list.length) {
        p.hotComments = list
        got += list.length
      }
    } catch { /* 拿不到就算了 */ }
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
  }
  return { posts: targets.length, comments: got }
}

/** 按文件头判断图片类型，防止把错误页当成图存进去 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
  return ''
}

/**
 * 把这一轮前几条带图的帖子图片塞进附件库，变成可以直接放进内容块的 ref。
 *
 * 顺序就是 picked 的顺序，只取每帖第一张（够看懂，也不至于把一轮撑爆）。
 * 视频帖取封面——封面是画面，比只看「这条有视频」强。
 * 任何一张失败都跳过，不能让看图把整轮搞挂。
 */
async function attachVision(ctx, picked, { maxImages = 3 } = {}) {
  const attachments = ctx.get('attachments')
  if (!attachments) return { refs: [], used: [] }
  const refs = []
  const used = []
  for (const p of picked || []) {
    if (refs.length >= maxImages) break
    const pic = Array.isArray(p.images) && p.images[0] ? String(p.images[0].url || '') : ''
    const url = pic || (p.hasVideo ? String(p.cover || '') : '')
    if (!/^https?:\/\//.test(url)) continue
    try {
      const { buf } = await weibo.fetchImageBytes(url)
      if (!buf.length || buf.length > 2 * 1024 * 1024) continue
      const mediaType = sniffImage(buf)
      if (!mediaType) continue
      const [ref] = await attachments.saveImages([{ data: new Uint8Array(buf), mediaType, name: `weibo-${p.id}.img` }])
      if (!ref) continue
      refs.push(ref)
      used.push({ id: p.id, kind: pic ? 'pic' : 'video-cover' })
    } catch { /* 单张失败跳过 */ }
  }
  return { refs, used }
}

// 这里原本有个 syncFromHost(config)：把宿主传进来的 config 合并进 config.json。
// 2026-11-10 删掉，因为它是错的 —— 导出 Config(schemastery) 之后，宿主会把
// **schema 的默认值**当作插件配置传进来。于是每次重启，用户自己改的作息、
// 分类、超话都会被默认值覆盖回去（用户就撞上过：4 个醒来窗口变成 1 个）。
//
// 现在的规矩很简单：config.json 是唯一真源。写它的只有两个地方 ——
// 设置页的 POST /settings，和 weibo_settings 工具。宿主传什么都不看。

/**
 * 注册全部工具 + 生物钟。web 和 headless 两个入口都调这个。
 * 不含 HTTP 路由——那部分需要 ctx.webServer，只有 web 入口有。
 */
export function applyTools(ctx, config) {
  const tool = (spec) => {
    // 包一层：把每次工具调用打进日志（子进程里会落到 run-*.log），
    // 这样「她这一轮到底调了什么、有没有读人设」不用再靠猜。
    const inner = spec.execute
    const wrapped = {
      ...spec,
      execute: async (args, ...rest) => {
        const t0 = Date.now()
        try {
          const r = await inner(args, ...rest)
          const ms = Date.now() - t0
          const bad = r && r.ok === false
          log(`↳ ${spec.name} ${ms}ms ${bad ? `✗ ${String(r.error || '').slice(0, 60)}` : '✓'}`)
          return r
        } catch (e) {
          log(`↳ ${spec.name} 抛错 ${String(e?.message ?? e).slice(0, 80)}`)
          throw e
        }
      },
    }
    try {
      ctx.tools.register(hostDefineTool(wrapped))
    } catch (e) {
      log(`工具 ${spec.name} 没注册上（不影响别的）：${e?.message ?? e}`)
    }
  }
  // 宿主用「lossless JSON」校验工具返回值：对象里只要出现 undefined / NaN / Infinity / BigInt，
  // 整次调用就失败，模型只看到 `Error: ... value is not lossless JSON`，等于这个工具废了。
  // （weibo_status 就因为 plan[].doneAt 未完成时是 undefined 而一直报这个错，
  //   模型第一次刷的时候调它拿配置，撞上报错就绕过了读配置那一步。）
  // 这里统一洗一遍：undefined 属性丢掉，NaN/Infinity 换 null，BigInt 换字符串。
  const json = (v) => {
    try {
      const s = JSON.stringify(v, (_k, val) => {
        if (typeof val === 'bigint') return String(val)
        if (typeof val === 'number' && !Number.isFinite(val)) return null
        if (typeof val === 'function' || typeof val === 'symbol') return undefined
        return val
      })
      return s === undefined ? { ok: false, error: '没有内容' } : JSON.parse(s)
    } catch {
      return { ok: false, error: '返回值无法序列化' }
    }
  }
  try { ensurePersona() } catch (e) { log(`人设初始化失败（不影响用）：${e?.message ?? e}`) }

  const noSched = process.env.WEIBO_DIVE_NO_SCHEDULE === '1'

  // 尝试把配置表单注册到宿主设置页。
  // 这台宿主（0.2.1-rc.5）上 ctx.settings.register 不存在，只有 configure，
  // 而 configure 是静默无效的（服务视图缺 fiber 绑定）。所以下面两种写法都试一遍、
  // 都不成立就安静跳过——配置照样能改：weibo_settings 工具、或直接编辑 config.json。
  if (Config && ctx.settings) {
    const reg = ctx.settings.register || ctx.settings.configure
    if (typeof reg === 'function') {
      try {
        reg.call(ctx.settings, 'weibo-dive', Config, { base: readConfig(), applies: 'live' })
        log('设置页：已提交配置表单')
      } catch (e) {
        log(`设置页：宿主不接受配置表单（${String(e?.message ?? e).slice(0, 60)}），用 weibo_settings 工具改`)
      }
    }
  }

  // ── 配置 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_settings',
    description: '看/改微博刷新的配置（每轮读几条、正文截断长度、跨轮去重）。'
      + '不传参数就是读当前配置。cookie 不在这里，用 weibo_login。',
    parameters: {
      readPerRound: { type: 'number', description: '每轮读几条（默认 10）' },
      pageLimit: { type: 'number', description: '最多翻几页（默认 2，一页约 10 条）' },
      maxTextChars: { type: 'number', description: '单条正文最多留多少字（默认 160）' },
      personaName: { type: 'string', description: '日记里的人设称呼（默认 大肥鱼）' },
      commentDailyLimit: { type: 'number', description: '每天最多评论几条（默认 3）' },
      commentMinGapMin: { type: 'number', description: '两条评论之间至少隔几分钟（默认 30）' },
      commentPerRound: { type: 'number', description: '一轮里最多评几条（默认 1）' },
      likes: { type: 'string', description: '爱看什么。会写进每轮提示词，用来判断值不值得接一句' },
      dislikes: { type: 'string', description: '不爱看什么。碰到这类直接跳过' },
      visionEnabled: { type: 'boolean', description: '让模型看帖子配图和视频封面（每轮最多 3 张）' },
      feedMode: { type: 'string', description: '刷哪里：hot = 热门（默认）/ timeline = 关注流 / topic = 超话' },
      hotCategories: {
        type: 'string',
        description: '热门勾选哪些分类，逗号分隔（如「搞笑,社会」）。默认搞笑 + 社会。'
          + '传空字符串表示「清空」，会退回默认两项。',
      },
      autoTopic: { type: 'string', description: '只在 feedMode=topic 时用：刷哪个超话，多个用逗号分隔' },
      autoRun: { type: 'boolean', description: '自动轮总开关' },
      autoComment: { type: 'boolean', description: '自动轮允不允许回帖（关了就只刷，一句话都不说）' },
      commentChance: { type: 'number', description: '每轮掷骰决定允不允许回帖的概率（默认 0.35）' },
      runTimeoutMin: { type: 'number', description: '一轮最长等多少分钟（默认 10）' },
      headlessProfile: { type: 'string', description: '用哪个 profile 起子进程（默认 headless）' },
      dedupeRounds: {
        type: 'number',
        description: '跨轮去重：记住最近几轮读过的帖子 id，下轮直接剔掉（默认 5，0 = 关闭，最多 50）。',
      },
      autoPost: { type: 'boolean', description: '每天定时把当天日记总结成一条微博发出去' },
      postAt: { type: 'string', description: '定时发博的时间 HH:MM（默认 22:30）' },
      postMode: { type: 'string', description: '发博模式：diary = 总结当天日记（默认）/ topic = 在超话里发一个讨论' },
      postTopic: { type: 'string', description: '话题模式发到哪个超话（默认 DeepSeek，不用带 #）' },
      postDailyLimit: { type: 'number', description: '每天最多发几条微博（默认 1，0 = 关掉定时发博）' },
      autoReplyComment: { type: 'boolean', description: '自动回评：回复别人在她微博下的评论' },
      autoReplyPerDay: { type: 'number', description: '自动回评每天最多几条（默认 2）' },
      autoReplyMaxAgeMin: { type: 'number', description: '只回最近多少分钟内的评论（默认 720 = 12 小时）' },
    },
    execute: async (args = {}) => {
      const STR = new Set([
        'personaName', 'autoTopic', 'headlessProfile', 'feedMode', 'likes', 'dislikes',
        'postAt', 'postMode', 'postTopic',
      ])
      const BOOL = new Set(['autoRun', 'autoComment', 'visionEnabled', 'autoPost', 'autoReplyComment'])
      const patch = {}
      for (const k of [
        'readPerRound', 'pageLimit', 'maxTextChars', 'personaName',
        'commentDailyLimit', 'commentMinGapMin', 'commentPerRound',
        'likes', 'dislikes', 'visionEnabled',
        'autoTopic', 'autoRun', 'autoComment',
        'commentChance', 'runTimeoutMin', 'headlessProfile', 'feedMode', 'dedupeRounds',
        'autoPost', 'postAt', 'postMode', 'postTopic', 'postDailyLimit',
        'autoReplyComment', 'autoReplyPerDay', 'autoReplyMaxAgeMin',
      ]) {
        if (args[k] === undefined || args[k] === null || args[k] === '') continue
        if (BOOL.has(k)) patch[k] = args[k] === true
        else if (STR.has(k)) patch[k] = String(args[k])
        else {
          const n = Number(args[k])
          if (Number.isFinite(n)) {
            patch[k] = k === 'commentChance' ? Math.max(0, Math.min(1, n))
              : k === 'dedupeRounds' ? Math.max(0, Math.min(50, Math.round(n)))
                : k === 'postDailyLimit' ? Math.max(0, Math.min(3, Math.round(n)))
                  : k === 'commentPerRound' ? Math.max(0, Math.min(3, Math.round(n)))
                    : n
          }
        }
      }
      // 分类单独处理：允许传中文名 / key，统一换成 containerid 存进配置
      if (args.hotCategories !== undefined && args.hotCategories !== null) {
        const r = resolveCategorySpec(String(args.hotCategories))
        const ids = r.ids.length ? r.ids : DEFAULT_CATEGORY_IDS
        patch.hotCategories = ids
        if (r.unknown.length) log(`不认识的分类（已忽略）：${r.unknown.join('、')}`)
      }
      if ('feedMode' in patch) {
        const m = String(patch.feedMode).toLowerCase()
        patch.feedMode = ['hot', 'timeline', 'topic'].includes(m) ? m : 'hot'
      }
      if ('postMode' in patch) {
        patch.postMode = String(patch.postMode).toLowerCase() === 'topic' ? 'topic' : 'diary'
      }
      if ('postTopic' in patch) {
        patch.postTopic = String(patch.postTopic).replace(/^#+|#+$/g, '').trim() || 'DeepSeek'
      }
      const cfg = Object.keys(patch).length ? writeConfig(patch) : readConfig()
      const ck = parseCookie(readCookie())
      return json({
        ok: true,
        changed: Object.keys(patch),
        hotCategoryNames: (cfg.hotCategories || []).map(nameOf),
        config: cfg,
        login: { hasCookie: ck.hasSub, keys: ck.keys },
        paths: {
          config: cfgFile(), cookie: cookieFile(), diary: diaryFile(), dir: dir(),
        },
        dedupe: seenStats(cfg),
      })
    },
  })

  // ── 登录 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_login',
    description: '保存并校验微博 cookie。cookie 从浏览器里复制（m.weibo.cn 或 weibo.com，'
      + '至少要带 SUB）。不传 cookie 就是校验已存的那份。只读用途，不会做任何写操作。',
    parameters: {
      cookie: { type: 'string', description: '完整的 Cookie 字符串，形如 "SUB=...; SUBP=...; ..."' },
    },
    execute: async (args = {}) => {
      const incoming = normalizeCookieInput(args.cookie)
      let saved = false
      if (incoming) {
        const parsed = parseCookie(incoming)
        if (!parsed.hasSub) {
          return json({ ok: false, error: '这串里没有 SUB，不是登录态', gotKeys: parsed.keys })
        }
        writeCookie(incoming)
        saved = true
      }
      const cookie = readCookie()
      if (!cookie) {
        return json({ ok: false, error: '还没有 cookie', hint: '把浏览器里的 Cookie 整串传给 cookie 参数' })
      }
      try {
        const r = await weibo.checkLogin(cookie)
        // 校验成功就顺手存下账号（设置页要显示 uid，之后不用每次都去问微博）
        if (r.ok && (r.uid || r.screenName)) {
          try { writeAccount({ uid: r.uid, screenName: r.screenName }) } catch { /* 存不下不影响登录 */ }
        }
        return json({
          ok: r.ok,
          saved,
          cookie: maskCookie(cookie),
          uid: r.uid,
          screenName: r.screenName,
          note: r.ok ? '登录态有效' : '接口说没登录，cookie 可能过期了',
        })
      } catch (e) {
        return json({
          ok: false,
          saved,
          cookie: maskCookie(cookie),
          error: e.message,
          hint: e.name === 'WeiboAuthError' ? '重新从浏览器复制一份 SUB 再试' : undefined,
        })
      }
    },
  })

  // ── 刷一轮 ──────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_round',
    description: '刷一轮微博，返回这一轮的素材。三种刷法：mode="hot" 热门（默认，按勾选的分类）、'
      + 'mode="timeline" 关注流、mode="topic" 超话。只读，不点赞不评论。'
      + '返回前会自动剔掉最近几轮已经读过的内容（配置 dedupeRounds，默认 5，0 = 关），'
      + '并给部分帖子附上评论区热评（hotComments，最多 3 条）。'
      + '拿到素材后用 weibo_comment 回帖、weibo_diary_write 写日记。',
    parameters: {
      mode: {
        type: 'string',
        description: '刷哪里：hot = 热门（默认）/ timeline = 关注流 / topic = 超话。'
          + '不传就按配置的 feedMode；配置是 topic 又没填超话名时会退到热门。',
      },
      limit: { type: 'number', description: '这一轮读几条（默认取配置的 readPerRound）' },
      topic: {
        type: 'string',
        description: '只刷超话：填名字，多个用逗号分隔（如「绝区零,DeepSeek」）。'
          + '给了这个参数就自动按 mode=topic 走。名字不用事先关注过，直接按 #名字# 搜。',
      },
      categories: {
        type: 'string',
        description: '只刷这些热门分类：填名字或 key，多个逗号分隔（如「搞笑,社会」）。'
          + '不传就用配置里勾选的那几个。分类清单见 weibo_categories。',
      },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => {
        const v = value || {}
        // imageRefs 是给宿主的附件引用，不进正文——正文里只留可见的 JSON
        const { imageRefs, ...rest } = v
        const blocks = [{ type: 'text', text: JSON.stringify(rest, null, 2) }]
        for (const ref of imageRefs || []) blocks.push({ type: 'image', attachment: ref })
        return blocks
      },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      const cookie = readCookie()
      if (!cookie) {
        return json({ ok: false, error: '还没登录', hint: '先调用 weibo_login 存 cookie，或在设置页点「登录」' })
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || Number(cfg.readPerRound) || 10, 50))
      const at = new Date()
      // 跨轮去重：0 = 关闭。配置里的值在工具层生效，模型绕不过去。
      const dedupeRounds = Math.max(0, Math.min(50, Math.round(Number(cfg.dedupeRounds ?? 5))))
      // 开着去重就多拉几倍候选，否则剔完旧帖凑不够 readPerRound 条。
      // 热门是「每个分类一个请求」，count 变大并不增加请求数。
      const wantMore = dedupeRounds > 0

      // ── 这一轮刷哪里 ──────────────────────────────────────────────────
      // 模型有时会忘记传参数（实测过：任务里写了刷超话，它调工具时空着就来了），
      // 所以每一级都有兜底：参数 → 本轮强制值（环境变量）→ 配置。
      const cfgMode = String(cfg.feedMode || 'hot').toLowerCase()
      let mode = String(args.mode || process.env.WEIBO_FORCE_MODE || cfgMode || 'hot').toLowerCase()
      if (args.topic) mode = 'topic'
      if (!['hot', 'timeline', 'topic'].includes(mode)) mode = 'hot'

      // ── 超话名 ────────────────────────────────────────────────────────
      // 以前这里要求「必须先刷到过才能认」，于是没入库的超话一律报「没认出来」。
      // 实际上搜索接口只用名字，根本不需要 id，所以现在直接按名字搜。
      const topicSpec = String(args.topic || process.env.WEIBO_FORCE_TOPIC || cfg.autoTopic || '').trim()
      const names = []
      for (const raw of topicSpec.split(/[,，、;；\s]+/)) {
        const one = raw.trim().replace(/^#+|#+$/g, '')
        if (!one) continue
        if (/^100808[0-9a-f]{6,}$/i.test(one)) {
          const hit = listTopics({ limit: 300 }).rows.find((r) => r.id === one)
          if (!hit?.title) {
            return json({
              ok: false,
              error: `只给了 id（${one}），不知道对应的超话名`,
              hint: '微博按内容搜只认超话名字，换成中文名再试，例如 topic="绝区零"',
            })
          }
          names.push(hit.title)
        } else {
          names.push(one)
        }
      }
      // 配置说刷超话但没填名字 → 退到热门，别让一轮空转
      if (mode === 'topic' && !names.length) mode = 'hot'

      // ── 热门分类 ──────────────────────────────────────────────────────
      let catIds = []
      let catTitles = []
      const catSpec = String(args.categories || process.env.WEIBO_FORCE_CATEGORIES || '').trim()
      if (mode === 'hot') {
        const spec = catSpec || (Array.isArray(cfg.hotCategories) ? cfg.hotCategories.join(',') : '')
        const r = resolveCategorySpec(spec)
        catIds = r.ids
        catTitles = r.titles
        if (!catIds.length) {
          // 配置被清空了也别报错：用默认的搞笑 + 社会
          const fallback = resolveCategorySpec(DEFAULT_CATEGORY_IDS.join(','))
          catIds = fallback.ids
          catTitles = fallback.titles
        }
      }

      try {
        let posts = []
        let pages = 0
        let source = ''
        let segments = null
        const warnings = []

        if (mode === 'hot') {
          const per = wantMore ? Math.min(30, Math.max(12, limit * 3)) : Math.min(30, limit + 2)
          const r = await weibo.fetchHot({ cookie, containerIds: catIds, count: per })
          posts = r.posts
          pages = r.pages
          segments = r.segments.map((x) => ({ name: nameOf(x.id), count: x.count }))
          source = `热门：${catTitles.join('、') || catIds.map(nameOf).join('、')}`
        } else if (mode === 'timeline') {
          const r = await weibo.fetchTimeline({
            cookie,
            count: wantMore ? Math.min(20, Math.max(limit, limit * 2)) : limit,
            pageLimit: Math.min(5, Math.max(Number(cfg.pageLimit) || 2, wantMore ? 3 : 2)),
          })
          posts = r.posts
          pages = r.pages
          source = '关注流'
        } else {
          for (const [i, name] of names.entries()) {
            try {
              const base = Math.max(1, Number(cfg.pageLimit) || 2)
              const pagesPerTopic = names.length > 1 ? 1 : Math.min(5, Math.max(base, wantMore ? 3 : 2))
              const r = await weibo.fetchTopicFeed({ cookie, title: name, pageLimit: pagesPerTopic })
              posts.push(...r.posts)
              pages += r.pages
            } catch (e) {
              warnings.push(`${name}：${e.message}`)
            }
            if (i < names.length - 1) await new Promise((res) => setTimeout(res, 700))
          }
          source = `超话：${names.join('、')}`
        }

        if (!posts.length) {
          return json({
            ok: false,
            mode,
            error: '这一轮一条都没拉到（可能被限流，或这个来源暂时没有内容）',
            categories: catIds,
            topics: names,
            warnings: warnings.length ? warnings : undefined,
          })
        }

        // 去重（多个分类/超话之间会交叉）
        const seen = new Set()
        posts = posts.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))

        // 过滤抽奖机器人和代肝广告：这些在热门流里同样占不少，交给模型只是烧 token
        const filtered = filterPosts(posts)
        posts = filtered.kept
        if (!posts.length) {
          return json({
            ok: false,
            mode,
            error: '拉到的全是抽奖 / 代肝广告，没有能看的',
            categories: catIds,
            filteredOut: filtered.dropped,
            samples: filtered.samples,
            hint: '换几个分类试试（weibo_categories 看清单），或改用关注流',
          })
        }

        // ── 跨轮去重（工具层硬闸）──────────────────────────────────────
        // 上面的 seen 只是「本轮内」去重，出了这个函数就忘。热门榜单被缓存住时，
        // 连着几轮会拿到同一批帖子（关注流阶段实测 76% 相邻轮有重复、6 次 10/10 全同），
        // 日记就会写重。这里把最近 N 轮模型已经读过的 id 直接剔掉，
        // 不靠提示词、不靠模型自觉，它拿到什么就只有什么。
        const d = applyDedupe(posts, { rounds: dedupeRounds, limit })
        const dedupe = d.dedupe
        if (d.empty) {
          return json({
            ok: false,
            mode,
            dedupe,
            categories: catIds,
            topics: names,
            error: '这一轮拉到的全是最近几轮读过的内容，没有新的',
            hint: '不要反复重刷。这轮可以只写日记（写点别的），'
              + '或在设置页把「跨轮去重 · 记住最近几轮」调小或关掉。',
          })
        }
        posts = d.posts
        if (dedupe.enabled) {
          log(`跨轮去重：记住 ${dedupe.remembered} 条 / 剔掉 ${dedupe.removed} 条 / 剩 ${dedupe.fresh} 条`)
        }

        // 每轮都把看到的超话并进库，越刷越准
        mergeTopics(posts)
        const picked = pickDiverse(posts, limit)
        // 评论区参考：给评论数最多的几条各挂 2~3 条热评，随 raw 一起落盘
        const cmt = await attachHotComments(picked, { perPost: 3, maxPosts: 6 })
        if (cmt.comments) log(`热评：${cmt.posts} 条帖子 / ${cmt.comments} 条评论`)
        // 看图：只取每帖第一张，最多 3 张；视频帖退而取封面
        const vision = cfg.visionEnabled === true ? await attachVision(ctx, picked) : { refs: [], used: [] }
        if (vision.refs.length) log(`看图：附了 ${vision.refs.length} 张（${vision.used.filter((u) => u.kind === 'video-cover').length} 张视频封面）`)
        const rawFile = saveRaw({ at: at.toISOString(), mode, categories: catIds, topics: names, picked }, { at })
        // 落盘成功之后才记去重：saveRaw 抛错时这一轮等于没读，不该把这些 id 挡住。
        // 只记「模型真正读到的」这几条；被闸剔掉的候选不算读过，下轮还能用。
        // roundId 让同一轮里的多次调用合并成一条（见 history.recordRound）。
        if (dedupe.enabled) {
          recordRound({
            at,
            mode,
            ids: picked.map((p) => p.id),
            roundId: process.env.WEIBO_ROUND_ID || '',
          })
        }

        return json({
          ok: true,
          at: stamp(at),
          mode,
          source,
          categories: catIds,
          categoryNames: catTitles,
          segments,
          topics: names,
          warnings: warnings.length ? warnings : undefined,
          pages,
          fetched: posts.length,
          read: picked.length,
          filteredOut: filtered.dropped,
          dedupe,
          raw: rawFile,
          topicsSeen: [...new Set(picked.flatMap((p) => (p.topics || []).map((t) => t.title || t.id)))].slice(0, 8),
          knownTopics: topicsCount(),
          stats: {
            avgLikes: Math.round(picked.reduce((s, p) => s + p.likes, 0) / picked.length),
            reposts: picked.filter((p) => p.isRepost).length,
          },
          posts: picked.map((p) => line(p, Number(cfg.maxTextChars) || 160)),
          hotComments: cmt.comments,
          vision: vision.used.length ? vision.used : undefined,
          imageRefs: vision.refs.length ? vision.refs : undefined,
          note: 'posts 就是这一轮的素材。自己判断该不该回、回哪条。'
            + '带 hotComments 的帖子给了评论区热评，那是参考，不是让你复述的素材。'
            + (vision.refs.length
              ? `附了 ${vision.refs.length} 张图，顺序和 vision 列表一致（pic = 正文配图，video-cover = 视频封面，视频内容本身看不到）。`
              : '')
            + '回帖用 weibo_comment（先预览、再 confirm）；日记用 weibo_diary_write。'
            + (dedupe.enabled ? ` 已剔掉最近 ${dedupe.rounds} 轮读过的 ${dedupe.removed} 条旧内容。` : '')
            + '别把「刷了几条」写进日记。',
        })
      } catch (e) {
        return json({
          ok: false,
          mode,
          error: e.message,
          code: e.code || undefined,
          hint: e.code === 'COOLDOWN' ? '风控熔断中，等冷却结束再刷，不要重试'
            : e.code === 'RATE_LIMIT' ? '被微博限流了，这一轮先停'
              : e.code === 'CHANGED' ? '接口可能改版了，跑 weibo_doctor 看是哪一项'
                : e.name === 'WeiboAuthError' ? 'cookie 可能过期了，重新执行 weibo_login'
                  : undefined,
        })
      }
    },
  })

  // ── 热门分类 ────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_categories',
    description: '看「热门」有哪些分类、当前勾选了哪些。传 refresh=true 会去微博拉一次最新列表'
      + '（热搜活动会轮换，比如金鸡奖、S16 这种是临时的）。',
    parameters: {
      refresh: { type: 'boolean', description: '是否重新从微博拉取分类列表（默认否，用本地缓存/内置表）' },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      let live = null
      if (args.refresh === true) {
        const cookie = readCookie()
        if (!cookie) return json({ ok: false, error: '还没登录，拉不到分类列表' })
        try {
          live = await fetchLiveCategories(() => weibo.fetchGroupList(cookie))
        } catch (e) {
          return json({ ok: false, error: `拉分类失败：${e.message}` })
        }
      }
      const list = listCategories()
      const ids = new Set(Array.isArray(cfg.hotCategories) ? cfg.hotCategories : [])
      return json({
        ok: true,
        feedMode: cfg.feedMode || 'hot',
        selected: [...ids],
        selectedNames: [...ids].map(nameOf),
        count: list.items.length,
        cached: list.cached,
        refreshed: live ? live.length : 0,
        categories: list.items.map((c) => ({
          key: c.key || '',
          name: c.name,
          id: c.id,
          selected: ids.has(c.id),
          caution: CAUTION_KEYS.includes(c.key),
        })),
        note: '改勾选：weibo_settings hotCategories="搞笑,社会"；也可以在设置页勾。',
      })
    },
  })

  // ── 超话 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_topics',
    description: '看她都在混哪些超话。微博没有公开的「我关注的超话」接口，'
      + '这里是按每轮刷到的内容里出现的超话统计出来的——出现越多，说明她越常碰到。',
    parameters: {
      limit: { type: 'number', description: '列前几个（默认 20）' },
      minCount: { type: 'number', description: '至少出现几次（默认 1）' },
    },
    execute: async (args = {}) => json({
      ok: true,
      ...listTopics({ limit: args.limit, minCount: args.minCount }),
      note: '想刷某个超话：weibo_round topic="名字或 id"',
    }),
  })

  // ── 评论 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_comment',
    description: '给一条微博发评论。**默认只预览不发送**，要真发必须显式传 confirm=true。'
      + '只能评论她自己刷到过的帖子（最近 7 天素材里出现过的），有每日额度与最小间隔。'
      + '只能发顶层评论；不回别人的评论（楼中楼）。',
    parameters: {
      post: { type: 'string', description: '微博的 id / mblogid / 完整链接（必须是她刷到过的那条）' },
      text: { type: 'string', description: '评论正文（140 字以内）' },
      confirm: { type: 'boolean', description: 'true 才真的发出去；不传或 false 只返回预览' },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      const text = String(args.text || '').trim()

      const post = findSeenPost(args.post)
      if (!post) {
        return json({
          ok: false,
          error: '这条不在她刷到过的帖子里，不发',
          hint: '先用 weibo_round 刷一轮，从返回的 posts 里挑一条再评',
        })
      }
      if (!text) return json({ ok: false, error: '评论正文是空的' })
      if (text.length > 140) return json({ ok: false, error: `太长（${text.length} 字），微博评论上限 140` })
      // 顶层评论也是公开输出：和回评共用同一套出站闸
      const bad = commentGate(text, { toneGate: cfg.toneGate !== false })
      if (bad) return json({ ok: false, error: bad })

      // 硬闸：本轮任务写的是「只刷不回」时，工具直接拒。
      // prompt 里说了不算数——模型偶尔还是会顺手回一条（实测发生过）。
      if (process.env.WEIBO_NO_COMMENT === '1') {
        return json({ ok: false, error: '这一轮不允许回帖（任务是只刷不回）', hint: '不要重试' })
      }
      // 子进程里（自动轮）再加一道：总开关关着就不许发
      if (process.env.WEIBO_ROUND_ID && cfg.autoComment === false) {
        return json({ ok: false, error: '自动回帖开关是关的，这一轮不发评论' })
      }

      const limN = Number(cfg.commentDailyLimit)
      const gapN = Number(cfg.commentMinGapMin)
      const perN = Number(cfg.commentPerRound)
      const gate = canComment({
        dailyLimit: Number.isFinite(limN) ? limN : 3,
        minGapMin: Number.isFinite(gapN) ? gapN : 30,
        mid: post.id,
        perRound: Number.isFinite(perN) ? perN : 1,
      })
      if (!gate.ok) return json({ ok: false, error: gate.reason })
      // 连续失败自停：多半是 cookie 过期或被风控，再试只会更深
      const tripped = failTripped('comment')
      if (tripped) return json({ ok: false, error: tripped })

      const target = { author: post.author, text: post.text.slice(0, 60), url: post.url, mid: post.id }

      if (args.confirm !== true) {
        return json({
          ok: true,
          preview: true,
          to: target,
          comment: text,
          length: text.length,
          quota: { used: gate.used, left: gate.left, dailyLimit: cfg.commentDailyLimit },
          note: '这是预览，没有发出去。确认要发就带 confirm=true 再调一次。',
        })
      }

      const cookie = readCookie()
      try {
        const xsrf = await weibo.getXsrf(cookie)
        const r = await weibo.postComment({ cookie, xsrf, mid: post.id, text })
        if (!r.ok) {
          audit({ kind: 'comment', ok: false, mid: post.id, text, error: r.msg || '发送失败', code: r.code || '' })
          return json({ ok: false, error: r.msg || '发送失败', code: r.code, to: target })
        }
        const st = recordComment({
          mid: post.id,
          text,
          rpid: r.data?.idstr || r.data?.id || r.data?.rpid,
          url: post.url,
          author: post.author,
        })
        audit({ kind: 'comment', ok: true, mid: post.id, text, rpid: r.data?.idstr || r.data?.id || '' })
        return json({
          ok: true,
          sent: true,
          to: target,
          comment: text,
          rpid: r.data?.idstr || r.data?.id || null,
          todayUsed: st.count,
          note: '发出去了。复核一遍可以在浏览器打开 to.url 看评论区。',
        })
      } catch (e) {
        audit({ kind: 'comment', ok: false, mid: post.id, text, error: e.message })
        return json({ ok: false, error: e.message, to: target })
      }
    },
  })

  tool({
    name: 'weibo_comments',
    description: '看她今天/最近发过哪些评论（本地记录）。',
    parameters: {
      limit: { type: 'number', description: '最近几条（默认 20）' },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      const h = commentHistory({ limit: args.limit })
      return json({
        ok: true,
        todayUsed: h.today,
        dailyLimit: cfg.commentDailyLimit,
        rows: h.rows,
      })
    },
  })

  // ── 回评 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_mentions',
    description: '列出最近别人在她微博下的评论（只读）。已经滤掉自己、广告、回过的和太旧的。'
      + '要回复用 weibo_reply_comment({cid, mid, content, confirm:true})。',
    parameters: {
      limit: { type: 'number', description: '最多几条（默认 10）' },
      maxAgeMin: { type: 'number', description: '只看最近多少分钟（默认取配置，720 = 12 小时）' },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      if (!readCookie()) return json({ ok: false, error: '还没登录' })
      const r = await collectCandidates({
        limit: Math.max(1, Math.min(20, Number(args.limit) || 10)),
        maxAgeMin: Number(args.maxAgeMin) || cfg.autoReplyMaxAgeMin,
      })
      return json({ ok: true, ...r, quota: replyQuota() })
    },
  })

  tool({
    name: 'weibo_reply_comment',
    description: '回复一条别人在她微博下的评论（楼中楼）。**默认只预览**，要真发必须显式传 confirm=true。'
      + '受自动回评总开关、每日额度、时效、出站过滤限制。',
    parameters: {
      cid: { type: 'string', required: true, description: 'weibo_mentions 返回的 cid' },
      mid: { type: 'string', description: '那条微博的 mid（可选，工具会自己核对）' },
      content: { type: 'string', required: true, description: '回复正文（2~140 字）' },
      confirm: { type: 'boolean', description: '必须显式传 true 才会发出去' },
    },
    execute: async (args = {}) => {
      const r = await replyToComment({
        cid: args.cid,
        mid: args.mid,
        content: args.content,
        confirm: args.confirm === true,
      })
      log(`回评：${r.sent ? `已回 @${r.to}（${r.content.length} 字）` : `没回（${r.error}）`}`)
      return json(r)
    },
  })

  // ── 人设 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_persona',
    description: '读/改她的人设（默认是「大肥鱼」）。人设决定评论口吻和日记写法。不传参数就是读当前人设。',
    parameters: {
      content: { type: 'string', description: '整份人设 markdown，传了就覆盖' },
      append: { type: 'string', description: '只追加一句/一段，不想整份替换时用' },
    },
    execute: async (args = {}) => {
      if (args.content) writePersona(String(args.content))
      else if (args.append) writePersona(`${readPersona()}\n\n${String(args.append)}`)
      const text = readPersona()
      return json({
        ok: true,
        name: personaName(),
        chars: text.length,
        persona: text,
        note: '这是她的人设全文。回帖和写日记都按这个口吻写；写之前把「怎么说话」那一段再看一遍。',
      })
    },
  })

  // ── 日记 ────────────────────────────────────────────────────────────────
  tool({
    name: 'weibo_diary_write',
    description: '写日记（追加，不覆盖）。日记是她写给自己看的，不是汇报：'
      + '第一人称、写具体的一件小事、两三句到一小段，不要数量、不要流程、不要总结、'
      + '不要链接、不要交代「在微博看到」，日记不记流水账。'
      + '文件：$DSH_HOME/weibo-dive/diary.md',
    parameters: {
      content: { type: 'string', description: '日记正文。不要加标题、不要列点，函数会自动加日期。', required: true },
      heading: { type: 'string', description: '一般不用传。想标一句也行，会显示成「日期 · 标题」' },
      force: { type: 'boolean', description: '读起来像汇报时是否强行写入（默认否，会让你重写）' },
    },
    execute: async (args = {}) => {
      const text = String(args.content || '').trim()
      if (!text) return json({ ok: false, error: '日记是空的' })

      // 挡一下「汇报体」。模型偶尔会退回「今天刷了 10 条微博，了解了…」这种句式，
      // 这种日记写进去等于没写，直接打回去让它重写（force=true 可以强写）。
      if (args.force !== true) {
        const bad = [
          [/刷了\s*\d+\s*[条个]/, '写了条数'],
          [/(浏览|完成)(了)?[^。\n]{0,6}(任务|浏览|阅读|查看)/, '写了流程'],
          [/今天(的)?(收获|总结|感受)[:：是]/, '在总结'],
          [/^(#|\*\*)[^\n]*\n/m, '带了标题'],
          [/\n\s*[-*]\s/, '列了点'],
          [/[【\[]?(热门|搞笑|社会|超话)(分类|频道)[】\]]?/, '写了分类名'],
          [/https?:\/\/|\]\(/, '带了链接（日记不放链接）'],
          [/(微博|热门|超话|分类)(上|里|中)?(看到|刷到|刷了)/, '交代了来源'],
        ]
        const hit = bad.find(([re]) => re.test(text))
        if (hit) {
          return json({
            ok: false,
            error: `这条读起来像汇报（${hit[1]}）。日记是她写给自己的，不是交作业。`,
            hint: '换成第一人称，写一件具体的小事：看到了什么、想到什么、哪里不舒服。两三句就够。'
              + '别写数量、别写「刷了/浏览了」、别列点、别加标题。',
            draft: text.slice(0, 80),
          })
        }
      }

      // 连着两轮刷到同一批内容时，日记会写成几乎一样的两段（实测过「小象」写了两遍）。
      // 相似度太高就打回去，宁可这轮不写。
      if (args.force !== true) {
        const last = lastEntryText()
        if (last) {
          const sim = similarity(text, last)
          if (sim > 0.72) {
            return json({
              ok: false,
              error: `跟上一段日记太像了（相似度 ${Math.round(sim * 100)}%）`,
              hint: '这批内容刚写过。换一个角度、写别的细节，或者这一轮干脆不写——'
                + '同一天里两段几乎一样的话，读起来很假。',
              lastEntry: last.slice(0, 100),
            })
          }
        }
      }

      const r = appendDiary(text, { heading: String(args.heading || '').trim() })
      return json(r)
    },
  })

  tool({
    name: 'weibo_diary_read',
    description: '读日记（默认最后 200 行）。',
    parameters: {
      lines: { type: 'number', description: '读最后多少行（默认 200）' },
    },
    execute: async (args = {}) => json(readDiary({ lines: args.lines })),
  })

  // ── 把当日日记发成微博 ──────────────────────────────────────────────────
  // 写操作：默认只预览，confirm=true 才发；每天一条，同内容不重复发。
  tool({
    name: 'weibo_post_diary',
    description: '把今天的日记发成一条微博。**默认只预览**，要真发必须显式传 confirm=true。'
      + '内容不传就用当天日记全文（所有段落按时间拼起来）；每天最多 1 条，同一段内容不会重复发。'
      + '只发文字，不带图。',
    parameters: {
      content: { type: 'string', description: '可选：覆盖要发的内容；不传就用当天日记' },
      confirm: { type: 'boolean', description: 'true 才真的发出去；不传或 false 只返回预览' },
      mode: { type: 'string', description: 'diary = 日记（默认）/ topic = 超话话题' },
      topic: { type: 'string', description: '话题模式的超话名（如 DeepSeek）' },
    },
    execute: async (args = {}) => {
      const r = await postDiary({
        content: args.content,
        confirm: args.confirm === true,
        mode: args.mode,
        topic: args.topic,
      })
      log(`发博：${r.sent ? `已发 ${r.chars} 字 ${r.url || ''}` : r.preview ? `预览 ${r.chars} 字` : `没发（${r.error}）`}`)
      return json(r)
    },
  })

  // 子进程（发博任务）用它存草稿；存完不发送，等主人确认。
  tool({
    name: 'weibo_post_draft',
    description: '把要发的微博正文存成草稿，不会发出去。'
      + '发博任务里写完总结后，用这个工具把正文放进 content。',
    parameters: {
      content: { type: 'string', description: '写好的微博正文', required: true },
      note: { type: 'string', description: '可选：给主人看的一句说明' },
    },
    execute: async (args = {}) => {
      const r = saveDraft({ content: args.content, note: args.note })
      log(`发博草稿：${r.saved ? `已存 ${r.chars} 字` : r.error}`)
      return json(r)
    },
  })

  // ── 跑一轮（起子进程，全交给模型） ──────────────────────────────────────
  tool({
    name: 'weibo_run_now',
    description: '立刻跑一轮（不等作息）。父进程起一个 headless 子进程，'
      + '模型自己在里面看配置、读人设、刷内容、决定回不回、写日记，跑完返回它的总结。'
      + '会阻塞到这一轮结束（通常 1~3 分钟）。',
    parameters: {
      topic: { type: 'string', description: '这一轮只刷某个超话（留空用配置里的 autoTopic / 关注流）' },
      comment: { type: 'string', description: 'yes = 允许回帖；no = 只刷不回；留空 = 按配置的概率掷骰' },
      wait: { type: 'boolean', description: '要不要等它跑完（默认 true）。false 只起不等' },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      if (!readCookie()) {
        return json({ ok: false, error: '还没登录', hint: '先用 weibo_login 存 cookie' })
      }
      const held = lockOwner()
      if (held) return json({ ok: false, error: `已经有一轮在跑（pid ${held.pid}）` })

      let allowComment
      if (String(args.comment).toLowerCase() === 'yes') allowComment = true
      else if (String(args.comment).toLowerCase() === 'no') allowComment = false
      else allowComment = cfg.autoComment !== false && Math.random() < Number(cfg.commentChance ?? 0.35)

      const topic = String(args.topic || cfg.autoTopic || '').trim()
      const roundId = `manual-${Date.now()}`
      const p = runRound({
        profile: cfg.headlessProfile || 'headless',
        timeoutMs: (Number(cfg.runTimeoutMin) || 10) * 60_000,
        roundId,
        allowComment,
        forceTopic: topic,
        clock: atToClock(new Date().getHours() * 60 + new Date().getMinutes()),
      })

      if (args.wait === false) {
        p.then((r) => log(`手动一轮结束：${r.ok ? 'ok' : r.error}`)).catch(() => {})
        return json({ ok: true, started: true, roundId, allowComment, topic: topic || null, note: '在后台跑，用 weibo_run_status 看进度' })
      }
      const r = await p
      return json({
        ok: r.ok,
        roundId,
        allowComment,
        topic: topic || null,
        seconds: Math.round((r.ms || 0) / 1000),
        summary: r.summary || '',
        error: r.error || undefined,
        log: r.log,
      })
    },
  })

  tool({
    name: 'weibo_run_status',
    description: '看这一轮是不是还在跑、最近一轮的日志在哪。',
    parameters: {},
    execute: async () => {
      const hb = readHeartbeat()
      const held = lockOwner()
      return json({
        ok: true,
        running: Boolean(held || (hb && hb.ageSec < 120)),
        lock: held || null,
        heartbeat: hb,
        log: dayLogFile(),
        logsDir: logsDir(),
      })
    },
  })

  // ── 作息与状态 ──────────────────────────────────────────────────────────
  tool({
    name: 'weibo_schedule',
    description: '设置「醒来窗口」：窗口期内随机醒 n 次，每醒一次刷一轮博，每轮按概率决定说不说话。'
      + '不传参数就是看当前作息。',
    parameters: {
      windows: {
        type: 'string',
        description: '窗口数组的 JSON，例如 [{"start":"19:00","end":"23:00","wakes":2}]（wakes = 醒几次 = 刷几轮）',
      },
      commentChance: { type: 'number', description: '每轮评论概率 0~1（默认 0.35）' },
      autoRun: { type: 'boolean', description: '总开关：到点要不要自动刷' },
      autoComment: { type: 'boolean', description: '自动评论开关（关了就只刷不说话）' },
      minGapMin: { type: 'number', description: '两次醒来至少隔几分钟（默认 20）' },
    },
    execute: async (args = {}) => {
      const patch = {}
      if (args.windows) {
        try {
          const w = JSON.parse(String(args.windows))
          if (!Array.isArray(w) || !w.length) throw new Error('要是数组')
          patch.night = {
            ...(readConfig().night || {}),
            enabled: true,
            windows: w.map((x) => ({ start: String(x.start), end: String(x.end), wakes: Number(x.wakes) || 1 })),
          }
        } catch (e) {
          return json({ ok: false, error: `windows 解析失败：${e.message}` })
        }
      }
      if (args.commentChance !== undefined) patch.commentChance = Math.max(0, Math.min(1, Number(args.commentChance)))
      if (args.autoRun !== undefined) patch.autoRun = args.autoRun === true
      if (args.autoComment !== undefined) patch.autoComment = args.autoComment === true
      if (args.minGapMin !== undefined) {
        patch.night = { ...(readConfig().night || {}), ...(patch.night || {}), minGapMin: Number(args.minGapMin) || 20 }
      }

      const cfg = Object.keys(patch).length ? writeConfig(patch) : readConfig()
      // 配置变了就重排今天剩下的计划
      const plan = ensurePlan(
        { windows: cfg.night?.windows, minGapMin: cfg.night?.minGapMin },
        new Date(),
      )
      return json({
        ok: true,
        changed: Object.keys(patch),
        night: cfg.night,
        autoRun: cfg.autoRun,
        autoComment: cfg.autoComment,
        commentChance: cfg.commentChance,
        autoTopic: cfg.autoTopic || '',
        today: plan.plan.map((x) => ({ clock: atToClock(x.at), done: x.done })),
      })
    },
  })

  tool({
    name: 'weibo_status',
    description: '看今天的醒来计划、下一次什么时候醒、今天评论了几条、最近一轮的结果、这一轮是否还在跑。',
    parameters: {},
    execute: async () => {
      const cfg = readConfig()
      const st = scheduleStatus(new Date())
      const cs = todayStats()
      const hb = readHeartbeat()
      const held = lockOwner()
      // 子进程里调这个工具时，锁和心跳都是「自己这一轮」留下的。直接算 running
      // 会让模型以为还有别的轮在跑（线上真发生过：看到 running:true 又去查了一次
      // weibo_run_status，白烧一轮工具调用）。按 WEIBO_ROUND_ID 把自己的认出来。
      const selfId = String(process.env.WEIBO_ROUND_ID || '')
      const isSelf = (x) => Boolean(selfId && x && String(x.roundId || '') === selfId)
      const otherLock = held && !isSelf(held) ? held : null
      const otherHb = hb && !isSelf(hb) ? hb : null
      return json({
        ok: true,
        autoRun: cfg.autoRun,
        autoComment: cfg.autoComment,
        commentChance: cfg.commentChance,
        autoTopic: cfg.autoTopic || '',
        windows: cfg.night?.windows || [],
        plan: st.today,
        next: nextAt(new Date()),
        comments: {
          today: cs.count,
          limit: cfg.commentDailyLimit,
          corrupt: cs.corrupt === true,
          error: cs.corrupt ? cs.error : '',
        },
        dedupe: seenStats(cfg),
        hasCookie: Boolean(readCookie()),
        running: Boolean(otherLock || (otherHb && otherHb.ageSec < 120)),
        self: Boolean(selfId),
        channel: weibo.channelInfo(),
        replies: { ...replyQuota(), lastAt: readReplyState().lastReplyAt || 0, lastError: readReplyState().lastError || '' },
        post: {
          autoPost: cfg.autoPost === true,
          at: cfg.postAt || '22:30',
          mode: cfg.postMode === 'topic' ? 'topic' : 'diary',
          topic: cfg.postTopic || '',
          ...postQuota(),
        },
      })
    },
  })

  // ── 通道自检 ────────────────────────────────────────────────────────────
  // 接口改版、cookie 过期、被风控，这一项会直接指出来。
  // 不跑自检的话，这些故障只会表现成「这一轮 0 条」，很难看出是哪坏了。
  tool({
    name: 'weibo_doctor',
    description: '微博通道自检：cookie / 登录态 / 关注流 / 热门 / 超话搜索 / 热评 / 图片，'
      + '逐项给出能不能用、耗时多少，并显示风控熔断和每个端点最近的错误。'
      + '刷不出来东西、或者怀疑接口改版时，先跑它。只读，不会发任何内容。',
    parameters: {
      topic: { type: 'string', description: '顺便测哪个超话（默认用配置里的 autoTopic，或「微博」）' },
    },
    execute: async (args = {}) => {
      const cfg = readConfig()
      const topic = String(args.topic || cfg.autoTopic || '').split(/[,，、\s]+/).filter(Boolean)[0] || '微博'
      const r = await weibo.diagnose({ cookie: readCookie(), topic })
      log(`自检：${r.ok ? '正常' : '有问题'}（${r.items.filter((x) => x.ok === true).length} 项可用`
        + `${r.items.some((x) => x.ok === false) ? `，${r.items.filter((x) => x.ok === false).map((x) => x.label).join('、')} 失败` : ''}）`)
      return json(r)
    },
  })

  // ── 生物钟 ──────────────────────────────────────────────────────────────
  let busy = false
  const tick = async () => {
    if (busy) return
    const cfg = readConfig()
    if (!cfg.autoRun || !cfg.night?.enabled) return
    if (!readCookie()) return

    ensurePlan({ windows: cfg.night.windows, minGapMin: cfg.night.minGapMin }, new Date())
    const due = dueItem(new Date())
    if (!due) return

    // 错过太久的不要补跑，直接标记掉。
    // 少了这一步，改一次作息就会重排出好几个「已经过去」的时间点，tick 会挨个补跑。
    if (Array.isArray(due.stale)) {
      for (const st of due.stale) {
        markDone(st.at, `错过窗口（${st.clock}）太久，跳过`)
        log(`跳过过期的一轮：${st.label} ${st.clock}`)
      }
      return
    }

    // 离上一轮太近就等下次 tick（minGapMin 是「两次醒来至少隔多久」）
    const gapMs = (Number(cfg.night?.minGapMin) || 20) * 60_000
    const last = lastDoneAt()
    if (last && Date.now() - last < gapMs) {
      log(`距上一轮不到 ${Math.round(gapMs / 60_000)} 分钟，先不跑`)
      return
    }

    // 父进程只决定「这一轮允不允许说话」，其余全交给子进程里的模型
    const allowComment = cfg.autoComment !== false && Math.random() < Number(cfg.commentChance ?? 0.35)
    const clock = due.clock || atToClock(due.at)

    busy = true
    try {
      log(`醒来 ${due.label} ${clock}${allowComment ? '（本轮可回帖）' : '（本轮只刷）'}`)
      const r = await runRound({
        profile: cfg.headlessProfile || 'headless',
        timeoutMs: (Number(cfg.runTimeoutMin) || 10) * 60_000,
        roundId: `auto-${dayKey()}-${due.at}`,
        allowComment,
        forceTopic: String(cfg.autoTopic || '').trim(),
        clock,
      })
      const summary = r.ok
        ? (r.summary || '（模型没给总结）').replace(/\n+/g, ' · ').slice(0, 200)
        : (r.skipped ? r.error : `失败：${r.error}`)
      markDone(due.at, summary)
      log(`一轮结束：${summary}`)
    } catch (e) {
      markDone(due.at, `出错：${e.message}`)
      log(`自动一轮出错：${e.message}`)
    } finally {
      busy = false
    }
  }

  // ── 每日定时发博 ────────────────────────────────────────────────────────
  // 到点先让模型读人设、把当天日记总结成草稿，再走和手动一样的发送闸（额度 / 查重）。
  // 窗口只有 1 小时，错过就不补发；失败 30 分钟内不重试，免得反复起模型。
  let postBusy = false
  let postFailAt = 0
  const postTick = async () => {
    if (postBusy) return
    const cfg = readConfig()
    if (cfg.autoPost !== true) return
    if (!readCookie()) return
    const at = /^\d{1,2}:\d{2}$/.test(String(cfg.postAt || '')) ? String(cfg.postAt) : '22:30'
    const [hh, mm] = at.split(':').map(Number)
    const now = new Date()
    const start = new Date(now)
    start.setHours(hh, mm, 0, 0)
    const end = new Date(start.getTime() + 60 * 60_000)
    if (now < start || now >= end) return
    const q = postQuota()
    if (q.corrupt || q.left <= 0) return
    if (cfg.postMode !== 'topic' && !buildPost().text) return
    if (Date.now() - postFailAt < 30 * 60_000) return
    if (lockOwner()) return

    postBusy = true
    try {
      log(`定时发博：${at} 到点（${cfg.postMode === 'topic' ? `超话 #${cfg.postTopic || 'DeepSeek'}#` : '日记'}），开始生成草稿`)
      const p = await preparePost({ timeoutMs: (Number(cfg.runTimeoutMin) || 10) * 60_000 })
      if (!p.ok) {
        postFailAt = Date.now()
        log(`定时发博：总结没生成（${p.error}），30 分钟后再试`)
        return
      }
      const r = await postDiary({ content: p.text, confirm: true, mode: p.mode, topic: p.topic })
      if (r.ok) log(`定时发博：已发出 ${r.chars} 字 ${r.url || ''}`)
      else {
        postFailAt = Date.now()
        log(`定时发博：没发出去（${r.error}），30 分钟后再试`)
      }
    } catch (e) {
      postFailAt = Date.now()
      log(`定时发博出错：${e?.message ?? e}`)
    } finally {
      postBusy = false
    }
  }

  // ── 自动回评 ────────────────────────────────────────────────────────────
  // 每 30 分钟扫一次「我的微博 → 评论」，有新评论才起子进程；子进程最多回 1 条。
  // 额度和去重都在 replies.mjs 里，父进程只做节奏和锁。
  let replyBusy = false
  let lastReplyScan = 0
  const replyTick = async () => {
    if (replyBusy) return
    const cfg = readConfig()
    if (cfg.autoReplyComment !== true) return
    if (!readCookie()) return
    const q = replyQuota()
    if (q.limit <= 0 || q.used >= q.limit) return
    if (Date.now() - lastReplyScan < 30 * 60_000) return
    const st = readReplyState()
    if (Date.now() - Number(st.lastAttemptAt || 0) < 20 * 60_000) return
    if (lockOwner()) return

    lastReplyScan = Date.now()
    let scan
    try {
      scan = await collectCandidates({ limit: 5 })
    } catch (e) {
      log(`自动回评：拉候选失败（${e?.message ?? e}）`)
      return
    }
    if (!scan.candidates.length) {
      // 别静默：uid 缺失 / 冲接口失败都要在日志和 replies.lastError 里留痕
      if (scan.error) {
        log(`自动回评：${scan.error}`)
        recordReplyAttempt({ ok: false, error: scan.error })
      }
      return
    }

    replyBusy = true
    try {
      const before = replyQuota().used
      log(`自动回评：${scan.candidates.length} 条候选，起子进程`)
      const r = await runRound({
        profile: cfg.headlessProfile || 'headless',
        timeoutMs: (Number(cfg.runTimeoutMin) || 10) * 60_000,
        roundId: `reply-${Date.now()}`,
        allowComment: false,
        overridePrompt: buildReplyPrompt(scan.candidates, {
          maxAgeMin: Number(cfg.autoReplyMaxAgeMin) || 720,
        }),
      })
      const after = replyQuota().used
      if (r.skipped === true) {
        // 锁被占（上一轮还没跑完）不是失败，别记一次 attempt 白等 20 分钟
        log('自动回评：上一轮还没跑完，这次跳过')
        return
      }
      recordReplyAttempt({ ok: r.ok, error: r.error || '', replied: after > before })
      log(`自动回评：${after > before ? '已回 1 条' : r.ok ? '没有合适的，跳过' : `失败：${r.error}`}`)
    } catch (e) {
      recordReplyAttempt({ ok: false, error: e?.message ?? e })
      log(`自动回评出错：${e?.message ?? e}`)
    } finally {
      replyBusy = false
    }
  }

  // 子进程里（headless）不要再起定时器：帖吧那边就是因为它撑住事件循环、进程退不掉
  if (!noSched) {
    const hourTimer = setInterval(() => {
      tick().catch(() => {})
      postTick().catch(() => {})
      replyTick().catch(() => {})
    }, 30_000)
    try { hourTimer.unref?.() } catch { /* 老宿主没有 */ }
    try { ctx.effect(() => () => clearInterval(hourTimer), 'weibo-dive: 生物钟') } catch { /* 老宿主没有 effect */ }
  }

  const cfg0 = readConfig()
  const ck0 = parseCookie(readCookie())
  const w0 = (cfg0.night?.windows || []).map((w) => `${w.start}-${w.end}×${w.wakes}`).join(' / ') || '无窗口'
  log(`已挂载（人设=${personaName()} · 每轮 ${cfg0.readPerRound} 条 · 登录=${ck0.hasSub ? '有' : '无'}`
    + ` · 自动=${noSched ? '子进程模式（不排班）' : cfg0.autoRun ? `开 ${w0}` : '关'}`
    + ` · 评论概率=${cfg0.commentChance}`
    + ` · 跨轮去重=${Number(cfg0.dedupeRounds ?? 5) > 0 ? `${Number(cfg0.dedupeRounds ?? 5)} 轮(严格)` : '关'}`
    + ` · 刷=${cfg0.feedMode === 'topic' ? `超话 ${cfg0.autoTopic || '(未填)'}`
      : cfg0.feedMode === 'timeline' ? '关注流'
        : `热门 ${(cfg0.hotCategories || []).map(nameOf).join('+') || '(默认)'}`}）`)
}

/**
 * web 入口：工具 + 设置页接口。
 *
 * `webServer` 必须**静态**注入：运行时 `ctx.inject(['webServer'], cb)` 拿到的是影子实例，
 * register 不报错、match 也命中，但 handler 永远不被调用（踩了很久）。
 * 静态注入的代价是 headless 会 pending，所以 headless 走 headless.js。
 */
export function apply(ctx, config) {
  applyTools(ctx, config)
  try {
    mountApiRoutes(ctx)
  } catch (e) {
    log(`设置页接口没挂上（不影响工具）：${e?.message ?? e}`)
  }
}
