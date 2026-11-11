/**
 * lib/schema.mjs —— 设置页的配置契约（Schemastery）
 *
 * 走宿主自带的设置页：插件导出 `Config`，再 `ctx.settings.register(...)`，
 * DSH 就会在「设置 → 插件」里按这份 schema 自动渲染表单——不用自己写前端、
 * 不用注册 webServer 路由（那条路在本机实测拿到的 WebServer 实例不处理请求，
 * 注册进了表、自检也命中，但 handler 永远不被调用）。
 *
 * 这里只声明「用户该改的」字段：cookie 走 weibo_login，人设走 weibo_persona，
 * 都不进设置页（凭据不该出现在任何表单里）。
 */
import { DEFAULTS } from './config.mjs'

/**
 * @param {any} z `@deepseek-ai/schemastery` 的默认导出
 */
export function buildSchema(z) {
  return z.object({
    // ── 刷取 ──────────────────────────────────────────────
    readPerRound: z.natural().min(1).max(50).default(DEFAULTS.readPerRound)
      .description('每轮读几条微博。太多会变慢，10 条左右够看。'),
    feedMode: z.union([
      z.const('hot').description('热门（推荐）'),
      z.const('timeline').description('关注流'),
      z.const('topic').description('超话'),
    ]).default(DEFAULTS.feedMode)
      .description('刷哪里。热门 = 别人在看什么，最适合说话；关注流多是官方公告；超话多是抽奖代肝。'),
    hotCategories: z.array(z.string()).default(DEFAULTS.hotCategories)
      .description('热门勾选哪些分类（containerid）。在设置页勾更方便。'),
    autoTopic: z.string().default(DEFAULTS.autoTopic)
      .description('只刷这些超话，留空 = 刷关注流。多个用逗号分隔，如「绝区零,DeepSeek」。'
        + '名字不用先关注过——直接按 #名字# 搜。关注流多是官方公告，容易「接不上一句」。'),
    pageLimit: z.natural().min(1).max(5).default(DEFAULTS.pageLimit)
      .description('最多翻几页，一页约 10 条。'),
    maxTextChars: z.natural().min(40).max(2000).default(DEFAULTS.maxTextChars)
      .description('单条正文超过多少字就截断，再交给模型。'),
    dedupeRounds: z.natural().max(50).default(DEFAULTS.dedupeRounds)
      .description('跨轮去重：记住最近几轮读过的帖子，下一轮直接剔掉。0 = 关闭。'
        + '热门榜单被缓存住时，不开这个会连续几轮刷到同一批内容、日记跟着写重。'),

    // ── 回帖 ──────────────────────────────────────────────
    autoComment: z.boolean().default(DEFAULTS.autoComment)
      .description('允许自动回帖。关掉就只刷，一句话都不说。'),
    commentChance: z.number().min(0).max(1).default(DEFAULTS.commentChance)
      .description('每轮掷骰决定「这一轮允不允许说话」的概率。0 = 永不说，1 = 每轮都考虑。'),
    commentDailyLimit: z.natural().max(20).default(DEFAULTS.commentDailyLimit)
      .description('每天最多回几条（硬上限，模型撞到就收手）。'),
    commentMinGapMin: z.natural().max(1440).default(DEFAULTS.commentMinGapMin)
      .description('两条之间至少隔几分钟，太密容易被限流。'),
    commentPerRound: z.natural().max(3).default(DEFAULTS.commentPerRound)
      .description('一轮里最多评几条（默认 1；同一帖每天只评一次，不受这个影响）。'),
    likes: z.string().default(DEFAULTS.likes)
      .description('爱看什么。会写进每轮提示词，判断值不值得接一句时参考。'),
    dislikes: z.string().default(DEFAULTS.dislikes)
      .description('不爱看什么。碰到这类直接跳过。'),
    visionEnabled: z.boolean().default(DEFAULTS.visionEnabled)
      .description('让模型看帖子的配图和视频封面（每轮最多 3 张）。'),

    // ── 作息 ──────────────────────────────────────────────
    autoRun: z.boolean().default(DEFAULTS.autoRun)
      .description('到点自动醒来刷。关掉就只在你手动触发时才动。'),
    night: z.object({
      enabled: z.boolean().default(true).description('启用下面的醒来窗口'),
      windows: z.array(z.object({
        start: z.string().default('19:00').description('开始时间 HH:MM'),
        end: z.string().default('23:00').description('结束时间 HH:MM'),
        wakes: z.natural().max(6).default(2).description('这个窗口里随机醒几次，一次醒 = 刷一轮'),
      })).default(DEFAULTS.night.windows)
        .description('醒来窗口。比如 19:00–23:00 醒 2 次，就是这段时间里刷 2 轮。'),
      minGapMin: z.natural().max(1440).default(DEFAULTS.night.minGapMin)
        .description('两次醒来至少隔几分钟。'),
    }).default({}).description('作息'),

    // ── 发博 ──────────────────────────────────────────────
    autoPost: z.boolean().default(DEFAULTS.autoPost)
      .description('每天定时把当天的日记总结成一条微博发出去。'),
    postAt: z.string().default(DEFAULTS.postAt)
      .description('定时发博的时间，格式 HH:MM（默认 22:30）。'),
    postMode: z.union([
      z.const('diary').description('日记模式：总结当天日记'),
      z.const('topic').description('话题模式：在超话里发一个讨论'),
    ]).default(DEFAULTS.postMode)
      .description('发什么。日记模式总结当天的日记；话题模式在指定超话里拟一个有讨论空间的话题。'),
    postTopic: z.string().default(DEFAULTS.postTopic)
      .description('话题模式发到哪个超话（默认 DeepSeek，不用带 #）。'),
    postDailyLimit: z.natural().max(3).default(DEFAULTS.postDailyLimit)
      .description('每天最多发几条微博（默认 2，0 = 关闭发博）。'),

    // ── 回评 ──────────────────────────────────────────────
    autoReplyComment: z.boolean().default(DEFAULTS.autoReplyComment)
      .description('自动回评：回复别人在她微博下的评论。'),
    autoReplyPerDay: z.natural().max(10).default(DEFAULTS.autoReplyPerDay)
      .description('每天最多回几条评论。'),
    autoReplyMaxAgeMin: z.natural().min(10).max(10080).default(DEFAULTS.autoReplyMaxAgeMin)
      .description('只回最近多少分钟内的评论（默认 12 小时）。'),

    // ── 运行 ──────────────────────────────────────────────
    runTimeoutMin: z.natural().min(1).max(60).default(DEFAULTS.runTimeoutMin)
      .description('一轮最长等几分钟，超时就杀掉子进程。'),
    headlessProfile: z.string().default(DEFAULTS.headlessProfile)
      .description('用哪个 profile 起子进程干活（那个 profile 里也要装本插件）。'),
  })
}
