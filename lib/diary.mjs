/**
 * lib/diary.mjs —— 日记与原始素材落盘
 */
import fs from 'node:fs'
import path from 'node:path'
import { diaryFile, rawDir, ensureDir, readConfig } from './config.mjs'

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 追加一段日记（带时间小标题），不覆盖已有内容 */
export function appendDiary(content, { at = new Date(), heading = '' } = {}) {
  const text = String(content || '').trim()
  if (!text) return { ok: false, error: '内容为空，没写' }
  ensureDir()
  const f = diaryFile()
  // 模型偶尔会把时间/日期写进 heading，剥掉，免得「2026-11-10 18:43 · 18:43」
  const h = String(heading || '').trim().replace(/^\d{4}-\d{2}-\d{2}[\sT]*/, '').replace(/^\d{1,2}:\d{2}\s*[·\-—|]?\s*/, '').trim()
  const title = h ? `${stamp(at)} · ${h}` : stamp(at)
  const block = `\n## ${title}\n\n${text}\n`
  fs.appendFileSync(f, block, 'utf8')
  const size = fs.statSync(f).size
  return { ok: true, file: f, bytes: size, added: text.length }
}

/** 取最后一段日记的正文（不含 `## 时间` 那行），用来做重复检测 */
export function lastEntryText() {
  try {
    const all = fs.readFileSync(diaryFile(), 'utf8')
    const i = all.lastIndexOf('\n## ')
    if (i < 0) return ''
    return all.slice(i).replace(/^\s*##[^\n]*\n/, '').trim()
  } catch {
    return ''
  }
}

/** 两段文字的相似度（按二字组算 Jaccard）。重复刷到同一批内容时日记会撞车。 */
export function similarity(a, b) {
  const norm = (x) => String(x || '').replace(/[\s\u3000，。！？、；：""''（）《》…—·,.!?;:()"'<>-]/g, '')
  const A = norm(a)
  const B = norm(b)
  if (!A || !B) return 0
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const ga = grams(A)
  const gb = grams(B)
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter += 1
  return inter / (ga.size + gb.size - inter)
}

/** 取某一天的日记正文（去掉 `## 时间` 标题），按时间顺序拼起来 */
export function diaryOfDay(day = dayKey()) {
  let all = ''
  try {
    all = fs.readFileSync(diaryFile(), 'utf8')
  } catch {
    return { day, entries: 0, text: '' }
  }
  const picked = []
  for (const block of all.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n')
    const head = nl < 0 ? block : block.slice(0, nl)
    const body = nl < 0 ? '' : block.slice(nl + 1).trim()
    if (!head.startsWith(day) || !body) continue
    picked.push(body)
  }
  return { day, entries: picked.length, text: picked.join('\n\n') }
}

export function readDiary({ lines = 200 } = {}) {
  const f = diaryFile()
  try {
    const all = fs.readFileSync(f, 'utf8')
    const list = all.split('\n')
    const tail = list.slice(-Math.max(20, Math.min(Number(lines) || 200, 2000))).join('\n')
    return { ok: true, file: f, bytes: Buffer.byteLength(all), days: (all.match(/^## /gm) || []).length, text: tail }
  } catch {
    return { ok: false, file: f, error: '还没有日记', text: '' }
  }
}

/** 把这一轮抓到的原始条目存一份，便于回溯（每轮一个文件，同一天不互相覆盖） */
export function saveRaw(payload, { at = new Date() } = {}) {
  ensureDir()
  const p2 = (n) => String(n).padStart(2, '0')
  const hhmm = `${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`
  const f = path.join(rawDir(), `raw-${dayKey(at)}-${hhmm}.json`)
  fs.writeFileSync(f, JSON.stringify(payload, null, 1), 'utf8')
  // 顺手清掉过期原始文件
  try {
    const keep = Number(readConfig().keepRawDays) || 7
    const cut = Date.now() - keep * 86400_000
    for (const name of fs.readdirSync(rawDir())) {
      if (!name.startsWith('raw-')) continue
      const p = path.join(rawDir(), name)
      if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p)
    }
  } catch { /* 清理失败不影响主流程 */ }
  return f
}
