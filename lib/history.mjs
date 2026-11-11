/**
 * lib/history.mjs —— 跨轮「已读」记录
 *
 * 为什么需要它：原本 weibo_round 里的 seen / filterPosts / pickDiverse 全是**本轮内**的，
 * 抓完就忘。热门流每次返回新一批时看不出问题，但微博一旦把榜单缓存住（关注流阶段
 * 实测 21 对相邻轮里 16 对有重复，6 次是 10/10 完全一样），连续几轮就会把同一批帖子
 * 反复交给模型，日记跟着写重。
 *
 * 做法：每轮把**模型真正读到的** picked 的 id 记进 seen.json，下轮抓取时在工具层
 * 把最近 N 轮出现过的 id 剔掉。工具层是硬闸，不依赖模型记得传参或自觉跳过。
 *
 * 文件：$DSH_HOME/weibo-dive/seen.json
 *   { version: 1, rounds: [{ at, mode, round?, calls?, ids: [...] }] }
 *   round = 这一轮的 id（子进程里的 WEIBO_ROUND_ID）。同一轮里模型重复调 weibo_round
 *   会并进同一条：一次调用算一轮的话，调 5 次就把 dedupeRounds=5 的窗口全吃光了。
 * 只记 id，不记正文、不记 cookie。原子写（tmp + rename），避免子进程被杀时写坏一半。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir, rawDir, readConfig } from './config.mjs'

const log = (...a) => console.log('[weibo-dive]', ...a)

/** 记录最多保留多少轮（配置里的 dedupeRounds 是「生效几轮」，这里才是物理上限） */
export const MAX_ROUNDS = 60
/** 太久之前的轮次不再生效，免得隔了一周回来还被旧 id 挡住 */
const MAX_AGE_DAYS = 7

export const seenFile = () => path.join(dir(), 'seen.json')

const EMPTY = () => ({ version: 1, rounds: [] })

function atomicWrite(data) {
  fs.mkdirSync(dir(), { recursive: true })
  const f = seenFile()
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
  fs.renameSync(tmp, f)
  return data
}

/**
 * 升级时不用从零攒：把 raw/ 里已有的每轮存档读回来，按时间排序补成历史。
 * 只在 seen.json **不存在**（ENOENT）时跑一次。设置页点「清空」走 resetSeen()，
 * 写的是空文件而不是删文件，所以清空之后不会被重新灌满。
 */
function backfillFromRaw() {
  const rounds = []
  let names = []
  try { names = fs.readdirSync(rawDir()).filter((n) => /^raw-.*\.json$/.test(n)) } catch { return EMPTY() }
  for (const name of names) {
    try {
      const p = path.join(rawDir(), name)
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      const ids = (Array.isArray(d.picked) ? d.picked : [])
        .map((x) => String(x?.id || x?.mblogid || '')).filter(Boolean)
      if (!ids.length) continue
      const at = d.at ? new Date(d.at) : new Date(fs.statSync(p).mtimeMs)
      rounds.push({
        at: Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString(),
        mode: String(d.mode || (d.topic ? 'topic' : 'timeline')),
        ids,
      })
    } catch { /* 单个坏文件跳过 */ }
  }
  rounds.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  return { version: 1, rounds: rounds.slice(-MAX_ROUNDS), backfilled: true }
}

/** 读历史。文件不存在就回填一次并落盘；文件写坏了就重置成空历史（别拿坏文件继续算）。 */
export function loadSeen() {
  let text
  try {
    text = fs.readFileSync(seenFile(), 'utf8')
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      log(`seen.json 读不了（${e?.code || e?.message}），按空历史处理`)
      return EMPTY()
    }
    try { return atomicWrite(backfillFromRaw()) } catch { return EMPTY() }
  }
  try {
    const d = JSON.parse(text)
    return { version: 1, rounds: Array.isArray(d.rounds) ? d.rounds : [] }
  } catch {
    log('seen.json 解析失败（多半是写坏了），已重置为空历史')
    try { return atomicWrite(EMPTY()) } catch { return EMPTY() }
  }
}

/** 只保留还在有效期内的轮次，按时间从旧到新 */
function activeRounds(data = loadSeen()) {
  const cut = Date.now() - MAX_AGE_DAYS * 86400_000
  return (data.rounds || [])
    .filter((r) => r && Array.isArray(r.ids) && r.ids.length)
    .filter((r) => {
      const t = Date.parse(String(r.at || ''))
      return !Number.isFinite(t) || t >= cut // 时间读不出来就当有效，宁可多挡
    })
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
}

/**
 * 最近 n 轮读过的 id。
 * @returns {Map<string, number>} id → 「第几轮之前读过」（1 = 上一轮，数值越大越旧）
 *          用 Map 而不只是 Set，是为了非严格模式补齐时优先拿最久没见过的那条。
 */
export function recentSeen(n) {
  const k = Math.max(0, Math.min(MAX_ROUNDS, Math.round(Number(n) || 0)))
  if (!k) return new Map()
  const rounds = activeRounds().slice(-k)
  const out = new Map()
  // 从旧到新遍历：同一条被刷到多次，以最近那次为准
  for (let i = 0; i < rounds.length; i += 1) {
    const age = rounds.length - i
    for (const raw of rounds[i].ids || []) {
      const id = String(raw || '').trim()
      if (id) out.set(id, age)
    }
  }
  return out
}

/**
 * 记一轮。只记模型真正看到的 picked，被跨轮闸剔掉的候选不算「读过」。
 *
 * roundId 是同一条记录的主键：模型在一轮里可能连着调几次 weibo_round（热门返回空、
 * 想「多刷点」），每次都追加一条的话，dedupeRounds=5 实际只覆盖 1~2 轮，而且第二次
 * 调用会把自己第一次的记录当成旧内容全剔掉。所以同一个 roundId 只维护一条，ids 取并集。
 *
 * @param {{at?:Date|string, mode?:string, ids?:Array, roundId?:string}} opt
 */
export function recordRound({ at = new Date(), mode = '', ids = [], roundId = '' } = {}) {
  const clean = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))]
  if (!clean.length) return seenStats()
  const data = loadSeen()
  const rounds = [...(data.rounds || [])]
  const rid = String(roundId || '').trim()

  let merged = false
  if (rid) {
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      const r = rounds[i]
      if (!r || String(r.round || '') !== rid) continue
      const have = new Set((Array.isArray(r.ids) ? r.ids : []).map(String))
      const add = clean.filter((id) => !have.has(id))
      rounds[i] = {
        ...r,
        ids: [...(Array.isArray(r.ids) ? r.ids : []), ...add],
        calls: (Number(r.calls) || 1) + 1,
      }
      merged = true
      break
    }
  }
  if (!merged) {
    rounds.push({
      at: at instanceof Date ? at.toISOString() : String(at || new Date().toISOString()),
      mode: String(mode || ''),
      ids: clean,
      ...(rid ? { round: rid, calls: 1 } : {}),
    })
  }
  try { atomicWrite({ version: 1, rounds: rounds.slice(-MAX_ROUNDS) }) } catch { /* 写失败不影响这一轮 */ }
  return seenStats()
}

/**
 * 清空跨轮「已读」记录。
 * 写空文件而不是删文件——删掉的话 loadSeen() 会当成首次使用、从 raw/ 里原样回填，
 * 等于清不掉。返回清空前的条数，设置页用来给一句人话反馈。
 */
export function resetSeen() {
  const before = activeRounds(loadSeen())
  let remembered = 0
  for (const r of before) remembered += (r.ids || []).length
  try {
    atomicWrite(EMPTY())
  } catch (e) {
    return { ok: false, error: `清空失败：${e?.message || e}`, cleared: 0 }
  }
  return { ok: true, cleared: remembered, ...seenStats() }
}

/** 给设置页 / 工具看的状态 */
export function seenStats(cfg = readConfig()) {
  const data = loadSeen()
  const rounds = activeRounds(data)
  const n = Math.max(0, Math.min(50, Math.round(Number(cfg?.dedupeRounds ?? 5))))
  const effective = rounds.slice(-n)
  const ids = new Set()
  for (const r of effective) for (const id of r.ids || []) ids.add(String(id))
  return {
    ok: true,
    enabled: n > 0,
    rounds: n,
    storedRounds: (data.rounds || []).length,
    activeRounds: rounds.length,
    effectiveRounds: effective.length,
    rememberedIds: ids.size,
    lastAt: rounds.length ? rounds.at(-1).at : null,
    file: seenFile(),
  }
}

/**
 * 跨轮过滤：把最近 N 轮模型读过的帖子从候选里剔掉。
 *
 * 策略固定为严格：剔完旧帖后新内容不够 readPerRound，宁可少读几条，
 * 也不拿旧帖凑数——旧帖写进日记只会「今天又写了一遍」。
 * 抽成独立函数是为了能脱离网络单测。
 * @param {Array} posts 已做完轮内去重和内容过滤的候选
 * @param {{rounds?:number, limit?:number}} opt
 * @returns {{posts:Array, dedupe:object, empty:boolean}}
 *          empty=true 表示「一条新内容都没有」，调用方应直接收工、别重刷。
 */
export function applyDedupe(posts, { rounds = 5, limit = 10 } = {}) {
  const all = Array.isArray(posts) ? posts : []
  const n = Math.max(0, Math.min(50, Math.round(Number(rounds) || 0)))
  const dedupe = {
    enabled: n > 0,
    rounds: n,
    remembered: 0,
    removed: 0,
    fresh: all.length,
  }
  if (!n) return { posts: all, dedupe, empty: false }

  const before = recentSeen(n)
  dedupe.remembered = before.size
  const fresh = []
  for (const p of all) {
    if (!before.has(String(p?.id ?? ''))) fresh.push(p)
  }
  dedupe.removed = all.length - fresh.length
  dedupe.fresh = fresh.length
  if (!fresh.length) return { posts: [], dedupe, empty: true }
  return { posts: fresh, dedupe, empty: false }
}
