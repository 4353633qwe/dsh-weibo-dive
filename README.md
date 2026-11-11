# dsh-weibo-dive

让机器人自己刷微博、决定说不说话，然后写一篇**日记**的 DSH 插件。纯 HTTP，不需要浏览器。

- **日记**（`diary.md`）：她写给自己的真人随笔，第一人称，不带链接、不交代来源、不写数量。

按人设口吻写，**不是汇报**。唯一的输出就是日记这一份。

**默认刷「热门」**（搞笑 + 社会两个分类），不是关注流也不是超话——关注流里全是官方公告
（开售时间、版本号），超话里七成是抽奖和代肝，这两处都没什么能接的话。热门是「别人在看什么」，
笑点、怪事、日常，才是人说话的地方。

## 架构：调度在父进程，干活在子进程

照 `dsh-tieba-dive` 的做法——**插件退化成调度器 + 工具集**，一轮里的判断全交给模型。

```
父进程（web profile 里的插件）
  ├─ 醒来窗口：19:00–23:00 醒 n 次（= 刷 n 轮）
  ├─ 掷骰子：这一轮允不允许回帖（commentChance，默认 0.35）
  ├─ 到点 → 起 `dsh headless` 子进程，prompt = 作业说明 + 配置 + 人设 + 本轮任务
  └─ 收结果：解析 `<<<...>>>` 总结，记进今日计划

子进程（headless profile，装同一个插件）
  └─ 模型自己走完：
       weibo_round     刷一轮，拿到 posts（含 id / 正文 / 赞评转）
       判断             该不该回、回哪条
       weibo_comment   先预览、再 confirm 发出去
       weibo_diary_write   有值得记的才写日记（不带链接）
       输出 <<<总结>>>
```

为什么这么分工：**模板拼的评论只能做到「不像机器人」，做不到「像她」。**
只有读过内容的模型才说得出「好看是好看，折扣得等到明天中午12点，磨人呢」这种话。

### 子进程的启动方式

```bash
dsh headless "<prompt>"      # 环境变量 WEIBO_DIVE_NO_SCHEDULE=1
```

`WEIBO_DIVE_NO_SCHEDULE=1` 很关键：子进程里的插件**不能再起 30 秒 tick 定时器**，
否则事件循环被撑住、进程退不掉（贴吧那边就踩过这个坑，20 分钟后才被超时杀掉）。

配置和人设**不写进 prompt**，由模型在第 0 步自己调 `weibo_settings` / `weibo_persona` 读——
她要先知道「这一轮被允许做什么」「自己是个什么样的人」，这属于判断的一部分，不该被喂到嘴里。

> 早期版本把这两样直接拼进 prompt，是很长一段时间的错误做法，起因是一个 bug：
> `weibo_status` 返回的 `plan[].doneAt` 在未完成时是 `undefined`，而宿主用 **lossless JSON**
> 校验工具返回值，只要出现 `undefined` / `NaN` / `BigInt` 就整次失败，模型只看到
> `Error: tool "weibo_status" returned invalid output: value is not lossless JSON`。
> 它第一次刷的时候想一次拿到全部配置，撞上这个错就绕过了读配置那一步——
> 看着像「模型不爱读配置」，其实是工具坏了。现在 `json()` 里统一洗一遍再返回。

## 为什么能不开浏览器

| 平台 | 请求签名 | 能否纯 HTTP |
|---|---|---|
| 贴吧 | `md5(参数+固定盐)` | ✅ |
| 小黑盒 | `MD5+GF(2⁸)` + HMAC 固定盐 | ✅ |
| **微博** | **无签名，只看 `SUB` cookie** | ✅ |
| 抖音 | `a_bogus`（混淆 JS + 指纹） | ❌ |
| 小红书 | `x-s` / `x-t` | ❌ |

两个坑记一下：

1. **cookie 分域**。`m.weibo.cn` 和 `weibo.com` 各有一份同名但不同域的 `SUB`，**互不通用**。
   从 weibo.com 复制的 cookie 拿去调 `m.weibo.cn/api/*` 会返回 `login: false`。
   本插件走的是 `weibo.com/ajax/*`。
2. **写接口要三样东西**：`X-XSRF-TOKEN` 头（从首页 `Set-Cookie` 取）+ 对应的 `XSRF-TOKEN` cookie
   + `Origin: https://weibo.com`。少一样就被网关挡成 400，看不出是缺头。

## 刷哪里：三种模式

`feedMode` 决定 `weibo_round` 拉什么：

| 模式 | 拉什么 | 情况 |
|---|---|---|
| `hot`（默认） | 勾选的几个分类，各拉一段 | 每个分类一次请求，合并去重后按 `readPerRound` 截断 |
| `timeline` | 关注流 | 官方号公告为主，经常「接不上一句」 |
| `topic` | `#超话名#` 搜索结果 | 广告占七成，靠 `lib/filter.mjs` 过滤 |

### 热门分类

分类不是写死的：`/ajax/feed/allGroups?containerid=102803` 会给出当时的全部分类
（2026-11-10 实测 58 个，还有「金鸡奖」「S16」这种热搜轮换出来的），
`lib/categories.mjs` 内置 26 个常用的做兜底，在线拉到的写进 `categories.json` 缓存 12 小时。

热门流的请求是：

```
/ajax/feed/hottimeline?group_id=<containerid>&containerid=<containerid>&count=20
```

**默认勾搞笑 + 社会。** 明星默认不勾（擦边内容多），设置页里标成「慎选」，但没禁。

## 跨轮去重：别把同一批帖子刷两遍

`lib/filter.mjs` 里的 `seen` / `filterPosts` / `pickDiverse` 全是**本轮内**的，出了
`weibo_round` 就忘。热门流靠 `extparam=discover|new_feed` 每次返回新的一批，平时看不出问题；
一旦微博把榜单缓存住（或切回关注流、超话），连续几轮就会拿到同一批内容。
2026-11-10 用 27 轮 `raw/` 存档实测：关注流/超话阶段 21 对相邻轮里 16 对有重复（76%），
平均重复率 67%，还有 6 次是 10/10 全同——那几天日记撞车就是这么来的。

**现在的做法**（工具层硬闸，模型绕不过去）：

1. 每轮把模型真正读到的 `picked` 的 id 记进 `seen.json`（原子写，只记 id，不记正文）；
2. 下轮抓取时按 `dedupeRounds`（默认 5，0 = 关）把最近 N 轮出现过的 id 剔掉。
   开启时热门的 `count` 从 `limit+2` 提到 `limit*3`（请求数不变），保证剔完还有足够候选；
3. 策略固定为严格：新内容不够就宁可少读几条，不拿旧帖凑数；
4. 整轮全是旧内容 → 直接返回 `ok:false`「没有新的」，不反复重刷
   （作业说明里也写了让模型这轮只写点别的，或者干脆不写）。

`seen.json` 最多留 60 轮，超过 7 天的轮次自动失效；首次使用会自动从已有 `raw/` 存档回填，
不用从零攒。设置页「刷取 → 跨轮去重」可以设记住几轮（0 = 关），旁边的「清空记录」
会把已读清空（写空文件，不删文件——删了会被 `raw/` 回填，等于清不掉）。

同一轮里模型重复调 `weibo_round` 只算一轮（按 `WEIBO_ROUND_ID` 合并，`ids` 取并集），
否则调 5 次就把 `dedupeRounds=5` 的窗口全吃光了。

## 改配置

### 1. 内置设置页（推荐）

刷新 Web 界面，进「设置 → 微博」。全部配置、人设编辑、手动起一轮、最近日记都在那儿。
「刷取 → 跨轮去重」可以设记住几轮（0 = 关），旁边显示当前挡住的条数，点「清空记录」可重置。

**这里踩了很久的坑，记下来：**

| 做法 | 结果 |
|---|---|
| `ctx.inject(['webServer'], cb)` 里 `c.webServer.register(...)` | ❌ 注册成功、`match()` 自检命中、8 秒后路由还在，**但 handler 永远不被调用**，请求返回空 404 |
| 静态 `inject: [...] , 'webServer'` + `ctx.webServer.register(...)` | ✅ 一次就通 |

差别在于 `ctx.inject` 的回调拿到的是**影子实例**（同一张 exact 表、能 match，但不接请求）；
只有静态注入才拿到真正处理请求的那个。小黑盒 / B 站 / 贴吧能做设置页，就是因为它们用了静态注入。

**代价**：headless profile 没有 `webServer`，静态注入会让整个插件 PENDING、工具全废。
所以拆成两个入口，共用 `applyTools`：

```
index.js            inject: ['tools','settings','webServer']   工具 + 设置页路由（web）
headless.js         inject: ['tools','settings']               纯工具（headless）
```

headless profile 的 `cordis.patch.yml` 里换成第二个入口：

```yaml
- id: weibo-dive
  disabled: true
- insert:
    - id: weibo-dive-headless
      name: dsh-weibo-dive/headless
```

**另外两个坑**：

- `dsh.client`（前端）不是靠 index.html 下发的，是 `/plugins/events` 这个 SSE 推的
  `graph.entries`。要看到 `dsh-weibo-dive → plugins/??dsh-weibo-dive/client.js` 才算真的注册上了。
- `cordis.patch.yml` 里**别写 `config:`**，它会成真源、把 `config.json` 覆盖回去。

### 2. 对助手说一句

```
weibo_settings autoTopic="绝区零" commentChance=0.5
```

写进 `$DSH_HOME/weibo-dive/config.json`，下一轮生效（模型每轮开工都会自己读一遍）。

### 3. 直接编辑文件

`~/.dsh/weibo-dive/config.json`，缺的键回落到 `lib/config.mjs` 的 `DEFAULTS`。

### 备用：离线面板

`tools/config-panel.html`，双击就能开，纯静态不联网。适合服务器上还没装好、
或者想先在本地把参数配好了再同步过去。

## 安装

```bash
dsh plugin --profile web add dsh-weibo-dive
dsh plugin --profile headless add dsh-weibo-dive   # 子进程干活要用
```

两个 profile 的 `dsh.profile.bundles` 都要加上 `dsh-weibo-dive`。

## 用法

```
weibo_login       cookie="SUB=...; SUBP=..."        存登录态（至少要含 SUB）
weibo_run_now     comment="yes|no"                   立刻跑一轮（起子进程，等它跑完）
weibo_schedule    windows='[{"start":"19:00","end":"23:00","wakes":2}]'
weibo_status                                         看今天的计划、额度、是否在跑
weibo_diary_read                                     读日记
```

## 工具

| 工具 | 作用 | 谁用 |
|---|---|---|
| `weibo_settings` | 看/改配置 | 人 |
| `weibo_login` | 存并校验 cookie | 人 |
| `weibo_round` | 刷一轮，返回素材（含 `id`） | 模型 |
| `weibo_topics` | 看她常碰哪些超话 | 两边 |
| `weibo_comment` | 评论（默认预览，`confirm=true` 才发） | 模型 |
| `weibo_comments` | 今天发了几条、发在哪 | 两边 |
| `weibo_persona` | 读/改人设 | 人 |
| `weibo_diary_write` / `_read` | 写/读日记（不带链接） | 模型 / 两边 |
| `weibo_run_now` | 立刻跑一轮 | 人 |
| `weibo_run_status` | 这一轮还在跑吗、日志在哪 | 两边 |
| `weibo_schedule` | 醒来窗口 | 人 |
| `weibo_status` | 今天计划 + 额度 + 运行状态 | 两边 |
| `weibo_categories` | 热门有哪些分类、勾了哪些（`refresh=true` 去微博拉最新） | 两边 |

## 日记：唯一的输出，写给自己，不是交作业

日记这一块单独说，因为它最容易退化成「汇报」：

```
× 今天刷了 10 条微博，了解了热门内容。在搞笑分类看到…       ← 这是导出，不是日记
○ 看到一只小象，站得跟人一样，还回头看镜头。我盯着看了两遍，
  想起自己刚有腿那阵子，走路也是这么小心翼翼的。
  晚饭还没着落，有点饿。
```

两处硬约束：

- `prompts/duty.md` 第 5 节给了「汇报 / 日记」的改写对照，明确禁止数量、流程、分类名、
  标题、列点、**链接**和「在微博看到」这类来源交代；
- `weibo_diary_write` 会**正则挡一道**：出现「刷了 N 条」「完成了浏览」「今天收获是」、
  带标题、列点、分类名、链接、来源交代，直接返回 `ok:false` 让模型重写（`force=true` 可强写）。
  再加一层与上一段的相似度检测（>72% 打回），免得连着两轮刷到同一批内容时写出两段一样的话。

日期小标题由函数加，模型不用操心；`heading` 里如果混进时间/日期会被剥掉。

## 三条闸（评论）

1. **白名单**：只能评论「她自己刷到过的帖子」——最近 7 天的 `raw/` 存档里出现过的 id。
   模型编一个 id 去别人时间线留言会被拒。
2. **配额**：每天最多 `commentDailyLimit` 条（默认 3），两条之间至少 `commentMinGapMin` 分钟（默认 30）。
3. **两段式**：工具默认只预览，必须显式 `confirm=true` 才发。任务说明要求模型先预览再发。

外加一道：`autoComment: false` 时，子进程里的 `weibo_comment` 直接拒——防止模型无视任务说明。

## 配置只有一个真源：config.json

这里踩过一个会咬人的坑：早期有个 `syncFromHost(config)`，在插件启动时把宿主传进来的
`config` 合并进 `config.json`。

导出了 `Config`（schemastery）之后，宿主会把**schema 的默认值**当成插件配置传进来，
于是每次重启都会把用户刚改的东西覆盖回去——具体表现就是「醒来窗口明明设了 4 个，
重启后只剩 1 个」「超话填了又变空」。**已经整个删掉。**

现在的规矩：`config.json` 是唯一真源，写它的只有两个地方——设置页的 `POST /settings`，
和 `weibo_settings` 工具。宿主传什么都不看。

## 文件

全部落在 `$DSH_HOME/weibo-dive/`：

```
config.json    配置（不写就是默认值）
cookie.txt     登录 cookie（600）
persona.md     人设（首次启动自动写入「大肥鱼」）
diary.md       日记，追加写，写给她自己（不带链接）
raw/           每轮抓到的原始条目，一个轮一个文件（默认留 7 天）
seen.json      跨轮已读记录：每轮读过的帖子 id（只记 id，最多 60 轮 / 7 天）
logs/          每轮的完整子进程输出（run-YYYY-MM-DD.log）
topics.json    从内容里反推出来的超话库
comments.json  评论记录与配额
schedule.json  今日计划
```

## 超话：没有「我关注了哪些」的接口

试过 `/ajax/profile/topic`、`/ajax/topic/getTopicList`、`/ajax/side/topics` 等 10 个端点，
全部返回 SPA 空壳。所以改成**从她真正刷到的内容里反推**——每条正文都带 `/p/100808...` 链接，
按出现次数累积。这比「关注列表」更接近真实行为：关注了但从不看的超话不会出现。

`topic_band` 那个接口看着像超话流，但不管传什么参数都返回同一个「热门话题榜」。
真正能用的是搜索 `#超话名#`（`/ajax/statuses/search`），代价是混着代肝、抽奖这类广告。

## License

MIT
