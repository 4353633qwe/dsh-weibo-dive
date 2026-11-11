/**
 * lib/config.mjs —— 配置与路径
 *
 * 一切落在 $DSH_HOME/weibo-dive/ 下：
 *   config.json   配置（644）
 *   cookie.txt    登录 cookie（600，不回显、不进日志）
 *   diary.md      日记（追加写，写给她自己）
 *   raw/          每轮抓到的原始条目（JSON，便于回溯）
 *   seen.json     跨轮「已读」记录：每轮读过的帖子 id，用来挡重复
 *
 * 唯一的输出是日记：她写给自己的随笔，第一人称，不带链接、不交代来源、不写数量。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
export function dir() {
  return path.join(homeDir(), 'weibo-dive')
}
export const cfgFile = () => path.join(dir(), 'config.json')
export const cookieFile = () => path.join(dir(), 'cookie.txt')
export const accountFile = () => path.join(dir(), 'account.json')
export const diaryFile = () => path.join(dir(), 'diary.md')
export const rawDir = () => path.join(dir(), 'raw')

export const DEFAULTS = {
  /** 每轮读几条 */
  readPerRound: 10,
  /** 最多翻几页（一页约 10 条） */
  pageLimit: 2,
  /** 单条正文最多留多少字（超了截断） */
  maxTextChars: 160,
  /** 日记里的称呼 */
  personaName: '大肥鱼',
  /** 每天最多评论几条 */
  commentDailyLimit: 5,
  /** 两条评论之间至少隔多少分钟 */
  commentMinGapMin: 30,
  /** 一轮里最多评几条 */
  commentPerRound: 1,
  /** 爱看什么：写进每轮提示词，判断值不值得接一句时参考 */
  likes: 'ai，deepseek，dsh',
  /** 不爱看什么：碰到这类直接跳过 */
  dislikes: '带货，擦边，纯搬运，性别对立',
  /** 让模型看帖子的图片 / 视频封面（每轮最多 3 张） */
  visionEnabled: true,
  /** 自动模式：醒来就刷，刷完按概率决定说不说话 */
  autoRun: true,
  /** 每轮抽中评论的概率（0~1）。父进程掷骰，结果写进这一轮的任务说明 */
  commentChance: 0.35,
  /** 自动轮刷什么：hot = 热门（默认） / timeline = 关注流 / topic = 超话 */
  feedMode: 'hot',
  /** 热门要刷哪些分类（containerid）。默认搞笑 + 社会；明星默认不勾（多是擦边内容） */
  hotCategories: [
    '102803_ctg1_4388_-_ctg1_4388', // 搞笑
    '102803_ctg1_2088_-_ctg1_2088', // 科技
  ],
  /** 自动轮刷哪个超话；空 = 不刷超话（只在 feedMode=topic 时用） */
  autoTopic: '',
  /** 用哪个 profile 起子进程（那个 profile 里必须也装了本插件） */
  headlessProfile: 'headless',
  /** 一轮最长等多久（分钟） */
  runTimeoutMin: 10,
  /** 到点要不要真的执行；false = 只写计划不跑（空跑观察） */
  autoComment: true,
  /** 醒来窗口：start/end 为本地时间，wakes = 窗口内醒几次 */
  night: {
    enabled: true,
    windows: [{ start: '19:00', end: '23:00', wakes: 2 }],
    minGapMin: 20,
  },
  /** 原始条目保留天数 */
  keepRawDays: 7,
  /**
   * 跨轮去重：记住最近几轮读过的帖子 id，下轮抓取时直接剔掉。0 = 关闭。
   * 之前只有「轮内」去重，热门榜单被缓存住时连续几轮会刷到同一批内容
   * （关注流阶段实测 76% 的相邻轮有重复），日记会跟着写重。
   * 策略固定为严格：剔完旧帖后新内容不够 readPerRound，宁可少读几条，也不拿旧帖补齐。
   */
  dedupeRounds: 5,
  /** 每天最多把日记发成几条微博（默认 2，0 = 关闭发博） */
  postDailyLimit: 2,
  /** 每天定时发博：到点让模型读人设、把当天日记总结成一条 */
  autoPost: true,
  /** 定时发博的时间（HH:MM） */
  postAt: '22:30',
  /** 发博模式：diary = 总结当天日记；topic = 在超话里发一个讨论 */
  postMode: 'topic',
  /** 话题模式发到哪个超话（不带 #） */
  postTopic: 'DeepSeek',
  /** 自动回评：回复别人在她微博下的评论 */
  autoReplyComment: true,
  /** 自动回评每天最多几条 */
  autoReplyPerDay: 2,
  /** 只回最近多少分钟内的评论 */
  autoReplyMaxAgeMin: 720,
}

export function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true })
  fs.mkdirSync(rawDir(), { recursive: true })
}

export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeConfig(patch = {}) {
  ensureDir()
  const next = { ...readConfig(), ...patch }
  fs.writeFileSync(cfgFile(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function readCookie() {
  try {
    return fs.readFileSync(cookieFile(), 'utf8').trim()
  } catch {
    return ''
  }
}

export function writeCookie(cookie) {
  ensureDir()
  fs.writeFileSync(cookieFile(), String(cookie || '').trim(), { mode: 0o600 })
  try { fs.chmodSync(cookieFile(), 0o600) } catch { /* 某些文件系统不支持 */ }
}

/** cookie 只露头尾，给日志/工具回显用 */
export function maskCookie(c) {
  const s = String(c || '')
  if (!s) return ''
  if (s.length <= 16) return s.replace(/./g, '*')
  return s.slice(0, 8) + '…' + s.slice(-6)
}

/**
 * 登录账号信息（uid / 昵称）。只给设置页显示用，不参与任何认证。
 * 校验 cookie 时顺手存下来，之后 `/status` 不用每次都去请求微博。
 */
export function readAccount() {
  try {
    const d = JSON.parse(fs.readFileSync(accountFile(), 'utf8'))
    return { uid: String(d.uid || ''), screenName: String(d.screenName || ''), at: Number(d.at) || 0 }
  } catch {
    return { uid: '', screenName: '', at: 0 }
  }
}

export function writeAccount({ uid = '', screenName = '' } = {}) {
  ensureDir()
  const next = { uid: String(uid || ''), screenName: String(screenName || ''), at: Date.now() }
  fs.writeFileSync(accountFile(), JSON.stringify(next, null, 1), 'utf8')
  return next
}

/**
 * 容忍几种粘贴方式，统一成 "K=V; K=V"：
 *  1. 完整 cookie 串：           SUB=abc; SUBP=def
 *  2. 从 DevTools 表格复制：     SUB<TAB>abc（换行分隔）
 *  3. 只有 SUB 的值：             abc
 *  4. 多行 "K: V" 形态
 */
export function normalizeCookieInput(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  // 全角冒号/等号/空格 → 半角；并把「空格 + 已知键名」当成分隔
  text = text
    .replace(/：/g, ':')
    .replace(/＝/g, '=')
    .replace(/\u3000/g, ' ')
    .replace(/\s+(?=(?:SUB|SUBP|_T_WM|ALF|SCF|SSOLoginState|SRT|XSRF-TOKEN|MLOGIN|MWEIBOID|WEIBOCN_FROM)[:=])/gi, '\n')

  // 3. 纯值：没有 '=' 也没有制表符/换行，且不像键名
  if (!text.includes('=') && !/[\t\n]/.test(text)) {
    if (/^SUB(P)?$/i.test(text)) return '' // 只贴了个键名，没给值
    return `SUB=${text}`
  }

  const pairs = []
  for (const line of text.split(/\n+/)) {
    const t = line.trim()
    if (!t) continue
    let k = ''
    let v = ''
    if (t.includes('\t')) {
      const [a, ...rest] = t.split('\t')
      k = a.trim()
      v = rest.join('\t').trim()
    } else if (t.includes('=') && (t.indexOf('=') < t.indexOf(':') || !t.includes(':'))) {
      const i = t.indexOf('=')
      k = t.slice(0, i).trim()
      v = t.slice(i + 1).trim()
    } else if (t.includes(':')) {
      const i = t.indexOf(':')
      k = t.slice(0, i).trim()
      v = t.slice(i + 1).trim()
    }
    if (k) pairs.push(`${k}=${v.replace(/[;；]+$/, '').trim()}`)
  }

  const joined = pairs.join('; ')
  if (!/(^|;\s*)SUB=/.test(joined)) return joined
  return joined
}

/** 从一长串浏览器 cookie 里挑出微博相关的键，顺便判断有没有登录态 */
export function parseCookie(raw) {
  const text = String(raw || '').trim()
  const out = {}
  for (const part of text.split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return {
    map: out,
    hasSub: Boolean(out.SUB),
    hasSubp: Boolean(out.SUBP),
    keys: Object.keys(out),
  }
}
