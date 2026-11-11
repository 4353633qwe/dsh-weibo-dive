/**
 * lib/schedule.mjs —— 醒来窗口与今日计划
 *
 * 照 dsh-tieba-dive 的思路：
 *   · 配若干个时间窗口（例：19:00–23:00，醒 2 次）
 *   · 每天第一次 tick 时，在每个窗口内随机撒 n 个时刻，落成「今日计划」
 *   · tick 发现到点且没执行过 → 跑一轮
 *   · 计划持久化，重启不重排（当天已经走过的不会重来）
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir, ensureDir } from './config.mjs'

export const scheduleFile = () => path.join(dir(), 'schedule.json')

const pad = (n) => String(n).padStart(2, '0')
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** "19:00" → 1140 分钟；"24:00" → 1440 */
function toMin(hhmm, fallback) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  return Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2]))
}

/**
 * 窗口拆成当天可执行的几段。
 * 普通窗口一段；`22:00–02:00` 这类跨午夜的拆成「当天 00:00–02:00」+「当天 22:00–24:00」，
 * 否则凌晨那段会被直接丢掉（以前 e<=s 一律推到 24:00）。
 */
function windowSegments(w) {
  const s = toMin(w.start, 19 * 60)
  const e = toMin(w.end, 23 * 60)
  if (e > s) return [[s, e]]
  const segs = []
  if (e > 0) segs.push([0, e])
  if (s < 24 * 60) segs.push([s, 24 * 60])
  return segs.length ? segs : [[s, Math.min(24 * 60, s + 60)]]
}

/** 把这一窗口的「醒几次」按长度分到各段，每段至少 1 次（次数不够时给最长的段） */
function allocWakes(segs, n) {
  const lens = segs.map(([a, b]) => Math.max(0, b - a))
  if (segs.length === 1) return [n]
  if (n < segs.length) {
    const counts = segs.map(() => 0)
    lens
      .map((len, i) => [len, i])
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .forEach(([, i]) => { counts[i] = 1 })
    return counts
  }
  const total = lens.reduce((x, y) => x + y, 0) || 1
  const counts = lens.map((len) => (len ? Math.max(1, Math.round((n * len) / total)) : 0))
  let sum = counts.reduce((x, y) => x + y, 0)
  while (sum < n) {
    counts[lens.indexOf(Math.max(...lens))] += 1
    sum += 1
  }
  while (sum > n) {
    const i = counts.indexOf(Math.max(...counts))
    if (counts[i] <= 1) break
    counts[i] -= 1
    sum -= 1
  }
  return counts
}

export const DEFAULT_WINDOWS = [{ start: '19:00', end: '23:00', wakes: 2 }]

function readRaw() {
  try {
    const d = JSON.parse(fs.readFileSync(scheduleFile(), 'utf8'))
    if (d && Array.isArray(d.plan)) return d
  } catch { /* 无 */ }
  return null
}

function writeRaw(d) {
  ensureDir()
  fs.writeFileSync(scheduleFile(), JSON.stringify(d, null, 1), 'utf8')
  return d
}

/**
 * 保证今天有计划。窗口/次数变了就按新配置重排（只影响今天还没走完的部分）。
 * @returns {{date:string, plan:Array}}
 */
export function ensurePlan({ windows = DEFAULT_WINDOWS, minGapMin = 20 } = {}, now = new Date()) {
  const today = dayKey(now)
  const cur = readRaw()
  const sig = JSON.stringify({ windows, minGapMin })

  if (cur && cur.date === today && cur.sig === sig) return cur

  // 改了设置但今天已经跑过几轮：保留那些已完成项，只重排还没走的，
  // 否则「改一下设置」会把 done 全清掉，已经跑过的时间点又冒出来补跑。
  const kept = cur && cur.date === today ? (cur.plan || []).filter((x) => x && x.done) : []

  const plan = []
  for (const w of windows) {
    const n = Math.max(0, Math.min(Number(w.wakes) || 0, 6))
    if (!n) continue
    const segs = windowSegments(w)
    const alloc = allocWakes(segs, n)
    segs.forEach(([s, e], si) => {
      const count = alloc[si]
      if (!count || e <= s) return
      const span = Math.max(10, e - s)
      // 段内均匀分 count 份，每份随机取一点，天然保证间隔
      for (let i = 0; i < count; i += 1) {
        const segStart = s + Math.floor((span / count) * i)
        const segEnd = s + Math.floor((span / count) * (i + 1))
        const at = Math.min(23 * 60 + 59, segStart + Math.floor(Math.random() * Math.max(1, segEnd - segStart)))
        plan.push({ at, label: `${w.start}–${w.end}`, done: false, result: null })
      }
    })
  }
  plan.sort((a, b) => a.at - b.at)

  // 太挤的往后推开
  for (let i = 1; i < plan.length; i += 1) {
    const gap = plan[i].at - plan[i - 1].at
    if (gap < minGapMin) plan[i].at = plan[i - 1].at + minGapMin
  }

  // 已完成项合并回来（同一时间点只留一条）
  if (kept.length) {
    const have = new Set(plan.map((x) => x.at))
    for (const k of kept) if (!have.has(k.at)) plan.push({ ...k })
    plan.sort((a, b) => a.at - b.at)
  }

  return writeRaw({ date: today, sig, plan, createdAt: now.toISOString() })
}

const atToClock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

/**
 * 错过多久就不补跑了（分钟）。
 *
 * 没有这个的话会有个大坑：改一次作息就重排一次计划，重排出来的凌晨/上午时间点
 * 全都「at <= now」，tick 就一轮接一轮地补跑——用户手动点一轮，结果冒出三个子进程。
 * 90 分钟足够覆盖「刚好错过一点点」，又不至于中午去补早上的。
 */
export const LATE_GRACE_MIN = 90

/**
 * 该执行的那一项。
 * - 返回 `{ stale: [...] }`：这些已经错过太久，调用方应该标记掉、不要跑；
 * - 返回 `{ at, clock, label }`：现在就跑；
 * - 返回 `null`：还没到点。
 */
export function dueItem(now = new Date(), { graceMin = LATE_GRACE_MIN } = {}) {
  const cur = readRaw()
  if (!cur || cur.date !== dayKey(now)) return null
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const pending = cur.plan.filter((x) => !x.done)

  const stale = pending.filter((x) => nowMin - x.at > graceMin)
  if (stale.length) {
    return { stale: stale.map((x) => ({ at: x.at, clock: atToClock(x.at), label: x.label })) }
  }

  const hit = pending.find((x) => x.at <= nowMin)
  return hit ? { at: hit.at, clock: atToClock(hit.at), label: hit.label } : null
}

/** 最近一次真正执行完的时间（毫秒），用来算「离上一轮够不够久」 */
export function lastDoneAt() {
  const cur = readRaw()
  if (!cur) return 0
  let latest = 0
  for (const x of cur.plan) {
    if (!x.done || !x.doneAt) continue
    const t = Date.parse(x.doneAt)
    if (Number.isFinite(t) && t > latest) latest = t
  }
  return latest
}

export function markDone(at, result) {
  const cur = readRaw()
  if (!cur) return null
  const item = cur.plan.find((x) => x.at === at)
  if (item) {
    item.done = true
    item.result = result
    item.doneAt = new Date().toISOString()
    writeRaw(cur)
  }
  return cur
}

export function nextAt(now = new Date()) {
  const cur = readRaw()
  if (!cur || cur.date !== dayKey(now)) return null
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const next = cur.plan.find((x) => !x.done && x.at > nowMin)
  return next ? { at: next.at, clock: atToClock(next.at), label: next.label } : null
}

export function scheduleStatus(now = new Date()) {
  const cur = readRaw()
  if (!cur || cur.date !== dayKey(now)) {
    return { planned: false, today: [], next: null }
  }
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return {
    planned: true,
    today: cur.plan.map((x) => ({
      clock: atToClock(x.at),
      window: x.label,
      done: x.done,
      due: !x.done && x.at <= nowMin,
      result: x.result,
      doneAt: x.doneAt,
    })),
    next: nextAt(now),
  }
}

export { atToClock }
