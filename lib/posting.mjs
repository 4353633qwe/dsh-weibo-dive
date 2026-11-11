/**
 * lib/posting.mjs —— 把当日日记发成一条微博
 *
 * 规则（先定简单点，够用就好）：
 *   · 内容 = 当天日记的全部段落，按时间顺序拼起来；
 *   · 默认只预览，confirm=true 才真的发；
 *   · 每天最多 postDailyLimit 条（默认 1，0 = 关闭）；
 *   · 同一段内容当天不重复发（模型重试也不会出两条）。
 *
 * 工具和设置页共用这里的逻辑，避免两边判断不一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readConfig, readCookie, dir, ensureDir, readAccount } from './config.mjs'
import { diaryOfDay, dayKey } from './diary.mjs'
import { todayPosts, recordPost, readPostsState } from './posts.mjs'
import { checkOutbound } from './guard.mjs'
import { audit, failTripped } from './audit.mjs'
import { runRound, postPrompt, postTopicPrompt } from './runner.mjs'
import * as weibo from './weibo.js'

/** 微博正文上限 2000 字，留一点余量给结尾的省略号 */
const MAX_CHARS = 2000

export const draftFile = () => path.join(dir(), 'post-draft.json')

/** 模型写好的草稿：只有存下来，绝不在这里发 */
export function saveDraft({ content, note = '', mode = '', topic = '' } = {}) {
  const text = String(content || '').trim()
  if (!text) return { ok: false, error: '草稿是空的，没存' }
  if (text.length > MAX_CHARS) return { ok: false, error: `太长了（${text.length} 字），微博正文上限 2000` }
  try {
    ensureDir()
    fs.writeFileSync(draftFile(), JSON.stringify({
      day: dayKey(),
      at: new Date().toISOString(),
      uid: String(readAccount().uid || ''),
      chars: text.length,
      text,
      note: String(note || '').slice(0, 200),
      mode: mode === 'topic' ? 'topic' : 'diary',
      topic: String(topic || ''),
    }, null, 1), 'utf8')
    return { ok: true, saved: true, chars: text.length, file: draftFile() }
  } catch (e) {
    return { ok: false, error: `草稿没存下来：${e.message}` }
  }
}

/**
 * 读草稿。notBefore 用来挡掉「上一轮留下的旧草稿」：
 * 模型这次没存草稿时，不能把半小时前那份当成新的发出去。
 */
export function readDraft({ day = '', notBefore = 0, uid = '' } = {}) {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile(), 'utf8'))
    if (!d || !d.text) return null
    if (day && d.day !== day) return null
    // 草稿是按账号存的：换号之后不能把上一个号生成的草稿发出去
    if (uid && d.uid && String(d.uid) !== String(uid)) return null
    if (notBefore && (Date.parse(d.at) || 0) < notBefore) return null
    return d
  } catch {
    return null
  }
}

/** 生成草稿的任务说明：日记模式 / 超话话题模式 */
export function buildPostPrompt({ mode = 'diary', topic = '', day, entries, diary } = {}) {
  if (mode === 'topic') {
    const tpl = postTopicPrompt()
    if (!tpl) return ''
    return tpl.replaceAll('{topic}', String(topic || 'DeepSeek'))
  }
  const tpl = postPrompt()
  if (!tpl) return ''
  return tpl
    .replace('{day}', String(day || dayKey()))
    .replace('{n}', String(entries || 0))
    .replace('{diary}', String(diary || ''))
}

/** 超话模式的正文要以 `#超话名[超话]#` 开头才会进超话；模型已经写了就不重复加 */
export function composePostText(text, { mode = 'diary', topic = '' } = {}) {
  const t = String(text || '').trim()
  if (mode !== 'topic') return t
  const name = String(topic || 'DeepSeek').replace(/^#+|#+$/g, '').replace(/\[超话\]/g, '').trim() || 'DeepSeek'
  const tag = `#${name}[超话]#`
  return t.includes(tag) ? t : `${tag} ${t}`
}

export function buildPost({ content = '' } = {}) {
  const day = dayKey()
  const d = diaryOfDay(day)
  const raw = String(content || d.text || '').trim()
  const text = raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS - 6)}…` : raw
  return { day, entries: d.entries, rawChars: raw.length, text, chars: text.length }
}

function limitOf() {
  const n = Number(readConfig().postDailyLimit)
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 1
}

export function postQuota(day = dayKey()) {
  const st = readPostsState()
  const limit = limitOf()
  // 流水坏了就当成「今天已发满」：宁可今天不发，也不按空库再发一条重复的
  if (st.corrupt) return { used: limit, limit, left: 0, corrupt: true, error: st.error }
  const uid = String(readAccount().uid || '')
  const used = st.items.filter((x) => {
    if (!x || x.day !== day) return false
    return uid ? String(x.uid || '') === uid : true
  }).length
  return { used, limit, left: Math.max(0, limit - used) }
}

/**
 * 起一个 headless 子进程生成草稿：读人设 → 写正文 → 存草稿。只生成，不发。
 *   mode='diary' 总结当天的日记；
 *   mode='topic' 在指定超话里拟一个讨论性话题（正文由发送前统一加 #超话名#）。
 */
export async function preparePost({ mode = '', topic = '', profile = '', timeoutMs = 5 * 60_000 } = {}) {
  const cfg = readConfig()
  const m = String(mode || cfg.postMode || 'diary').toLowerCase() === 'topic' ? 'topic' : 'diary'
  const t = String(topic || cfg.postTopic || 'DeepSeek').replace(/^#+|#+$/g, '').trim() || 'DeepSeek'
  const b = buildPost({})
  if (m === 'diary' && !b.text) return { ok: false, error: '今天的日记还是空的，没东西可发' }

  const startedAt = Date.now()
  const r = await runRound({
    profile: profile || cfg.headlessProfile || 'headless',
    timeoutMs,
    roundId: `post-${startedAt}`,
    allowComment: false,
    overridePrompt: buildPostPrompt({
      mode: m,
      topic: t,
      day: b.day,
      entries: b.entries,
      diary: m === 'diary' ? b.text : '',
    }),
  })
  if (!r.ok) {
    return { ok: false, error: r.error || '生成草稿失败', log: r.log, skipped: r.skipped === true }
  }
  const d = readDraft({ day: b.day, notBefore: startedAt, uid: readAccount().uid })
  if (!d) {
    return {
      ok: false,
      error: '模型没有保存草稿（可能没调 weibo_post_draft）',
      log: r.log,
      mode: m,
      topic: m === 'topic' ? t : '',
    }
  }

  const finalText = composePostText(d.text, { mode: m, topic: t })
  // 草稿是子进程里的 weibo_post_draft 存的，它不知道这次是哪个模式；
  // 在这里补上，发送时（API / 定时）才能按模式带 page_id。
  saveDraft({ content: d.text, note: d.note, mode: m, topic: m === 'topic' ? t : '' })
  return {
    ok: true,
    preview: true,
    from: 'model',
    mode: m,
    topic: m === 'topic' ? t : '',
    day: d.day,
    entries: m === 'diary' ? b.entries : 0,
    text: finalText,
    chars: finalText.length,
    quota: postQuota(b.day),
    log: r.log,
    note: m === 'topic'
      ? `话题模式：会带着 #${t}# 发出去，还没有发。`
      : '日记模式：模型读人设后的总结，还没有发出去。',
  }
}

export async function postDiary({ content = '', confirm = false, mode = 'diary', topic = '' } = {}) {
  // 统一在这里补 `#名字[超话]#`：工具、API、定时都走这条路，避免有的入口漏掉
  const b = buildPost({ content: composePostText(content, { mode, topic }) })
  if (!b.text) return { ok: false, error: '今天的日记还是空的，没东西可发' }
  // 公开微博也要过一遍出站闸：本机路径 / 链接 / 凭证字样不能出现在正文里
  const guard = checkOutbound(b.text)
  if (!guard.ok) {
    return { ok: false, error: `正文里有不该发的东西（${guard.hits.join('、')}）`, text: b.text }
  }
  const q = postQuota(b.day)
  if (q.corrupt) return { ok: false, error: `本地发博流水损坏，先停手：${q.error}` }
  if (q.limit <= 0) return { ok: false, error: '发博是关着的（postDailyLimit=0）' }

  if (!confirm) {
    return {
      ok: true,
      preview: true,
      ...b,
      quota: q,
      note: '这是预览，没有发出去。确认要发就带 confirm=true 再调一次。',
    }
  }

  if (q.used >= q.limit) {
    return { ok: false, error: `今天已经发过 ${q.used} 条（上限 ${q.limit}）`, quota: q }
  }
  if (todayPosts(b.day).some((x) => String(x.text || '').trim() === b.text)) {
    return { ok: false, error: '这段日记今天已经发过了，不重复发', quota: q }
  }

  const cookie = readCookie()
  if (!cookie) return { ok: false, error: '还没登录，先存 cookie' }
  const tripped = failTripped('post')
  if (tripped) return { ok: false, error: tripped }

  // 话题模式：先反查超话的 100808 id，发博时作为 page_id 才能真正进超话。
  const m = mode === 'topic' ? 'topic' : 'diary'
  const name = String(topic || '').replace(/^#+|#+$/g, '').trim()
  let pageId = ''
  if (m === 'topic' && name) {
    try {
      const t = await weibo.resolveTopicId({ cookie, name })
      pageId = t.id || ''
    } catch { /* 找不到就按普通话题发 */ }
  }

  let r
  try {
    const xsrf = await weibo.getXsrf(cookie)
    r = await weibo.postStatus({ cookie, xsrf, text: b.text, pageId })
  } catch (e) {
    audit({ kind: 'post', ok: false, mode: m, chars: b.text.length, error: e.message })
    return { ok: false, error: e.message, code: e.code || '', text: b.text }
  }
  if (!r.ok) {
    const msg = r.msg || '发送失败'
    if (m === 'topic' && /未关注超话/.test(msg)) {
      return {
        ok: false,
        error: `还没关注「${name}」超话，先去微博里关注它再发（超话只允许粉丝发帖）`,
        code: r.code,
        text: b.text,
      }
    }
    audit({ kind: 'post', ok: false, mode: m, chars: b.text.length, error: msg })
    return { ok: false, error: msg, code: r.code, text: b.text }
  }

  const rec = recordPost({
    text: b.text, mid: r.mid, url: r.url, mode: m, topic: name, topicId: pageId,
  })

  // 发完去超话 feed 里核一下：到底进没进去（没关注超话 / 审核中都会导致“发出去了但不在超话”）
  let attached = null
  if (m === 'topic') {
    attached = pageId ? await weibo.postInChaohua({ cookie, pageId, mid: r.mid }) : false
  }
  const warn = m !== 'topic' ? undefined
    : !pageId ? '没找到这个超话的 id，这条按普通话题发出去了'
      : attached === false ? '发出去了，但超话 feed 里没有它——多半是还没关注这个超话，或者正在审核'
        : attached === null ? '发出去了，但没拿到超话列表，无法确认是否进了超话'
          : undefined
  audit({ kind: 'post', ok: true, mode: m, topic: name, mid: r.mid, url: r.url, chars: b.text.length, attached })

  return {
    ok: true,
    sent: true,
    ...b,
    mode: m,
    topic: m === 'topic' ? name : '',
    topicId: pageId,
    topicAttached: m === 'topic' ? attached : null,
    warning: warn,
    mid: r.mid,
    url: r.url,
    quota: { ...q, used: rec.count, left: Math.max(0, q.limit - rec.count) },
  }
}
