/**
 * lib/posts.mjs —— 发博流水
 *
 * 记账目的：一天发过几条、内容是什么。查重和日额度都要靠它，
 * 不然模型重试一次就会把同一段日记发两遍。
 *
 * 文件：$DSH_HOME/weibo-dive/posted.json（保留 90 天）
 */
import path from 'node:path'
import { dir, ensureDir, readAccount } from './config.mjs'
import { dayKey } from './diary.mjs'
import { readJson, atomicWrite } from './store.mjs'

const KEEP_DAYS = 90

export const postsFile = () => path.join(dir(), 'posted.json')

/** 当前登录账号；发博额度按账号分开算，换号不会串用旧账号的额度 */
function currentUid() {
  return String(readAccount().uid || '')
}

function readState() {
  const r = readJson(postsFile(), [])
  if (!r.ok) return { items: [], corrupt: true, error: r.error }
  return { items: Array.isArray(r.data) ? r.data : [], corrupt: false, error: '' }
}

export function readPosts() {
  return readState().items
}

export function todayPosts(day = dayKey()) {
  const uid = currentUid()
  return readPosts().filter((x) => {
    if (!x || x.day !== day) return false
    // 有 uid 就按账号算；老记录没有 uid 时不算进当前账号（换号后不该被旧记录挡住）
    return uid ? String(x.uid || '') === uid : true
  })
}

export { readState as readPostsState }

export function recordPost({ text, mid = '', url = '', mode = '', topic = '', topicId = '', at = new Date() } = {}) {
  const all = readPosts()
  const day = dayKey(at)
  all.push({
    day,
    at: at.toISOString(),
    uid: currentUid(),
    chars: String(text || '').length,
    text: String(text || ''),
    mid: String(mid || ''),
    url: String(url || ''),
    mode: mode === 'topic' ? 'topic' : 'diary',
    topic: String(topic || ''),
    topicId: String(topicId || ''),
  })
  const cut = Date.now() - KEEP_DAYS * 86400_000
  const keep = all.filter((x) => {
    const t = Date.parse(x?.at)
    return !Number.isFinite(t) || t > cut
  })
  ensureDir()
  atomicWrite(postsFile(), keep)
  const uid = currentUid()
  const count = keep.filter((x) => x.day === day && (uid ? String(x.uid || '') === uid : true)).length
  return { count, file: postsFile() }
}
