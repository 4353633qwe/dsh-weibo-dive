/**
 * lib/categories.mjs —— 微博「热门」的分类
 *
 * 分类不是写死的常量：weibo.com 的 `/ajax/feed/allGroups?containerid=102803`
 * 会返回当前所有分类（2026-11-10 实测 58 个），名字和 containerid 都在里面，
 * 热门活动（金鸡奖、S16、KPL）会随热搜轮换。
 *
 * 所以这里只做两件事：
 *   1. 内置一份常用分类（key + 中文名 + containerid），离线也能用；
 *   2. 在线拉一次全量并缓存到 categories.json，让「名字 → containerid」在
 *      缓存有效期内可以互查（用户在设置页勾的、工具里手打的名字都能认）。
 *
 * 每条热门流的请求是：
 *   /ajax/feed/hottimeline?group_id=<containerid>&containerid=<containerid>&count=20
 */
import fs from 'node:fs'
import path from 'node:path'
import { dir } from './config.mjs'

const CACHE_TTL_MS = 12 * 3600 * 1000

/** 常用分类。key 是给配置/工具用的短名，id 是 containerid */
export const COMMON = [
  { key: 'funny', name: '搞笑', id: '102803_ctg1_4388_-_ctg1_4388' },
  { key: 'social', name: '社会', id: '102803_ctg1_4188_-_ctg1_4188' },
  { key: 'star', name: '明星', id: '102803_ctg1_4288_-_ctg1_4288' },
  { key: 'emotion', name: '情感', id: '102803_ctg1_1988_-_ctg1_1988' },
  { key: 'game', name: '游戏', id: '102803_ctg1_4888_-_ctg1_4888' },
  { key: 'anime', name: '动漫', id: '102803_ctg1_2388_-_ctg1_2388' },
  { key: 'movie', name: '电影', id: '102803_ctg1_3288_-_ctg1_3288' },
  { key: 'tv', name: '电视剧', id: '102803_ctg1_2488_-_ctg1_2488' },
  { key: 'show', name: '综艺', id: '102803_ctg1_4688_-_ctg1_4688' },
  { key: 'music', name: '音乐', id: '102803_ctg1_5288_-_ctg1_5288' },
  { key: 'sport', name: '体育', id: '102803_ctg1_1388_-_ctg1_1388' },
  { key: 'pet', name: '萌宠', id: '102803_ctg1_2788_-_ctg1_2788' },
  { key: 'food', name: '美食', id: '102803_ctg1_2688_-_ctg1_2688' },
  { key: 'tech', name: '科技', id: '102803_ctg1_2088_-_ctg1_2088' },
  { key: 'knowledge', name: '科普', id: '102803_ctg1_5988_-_ctg1_5988' },
  { key: 'history', name: '历史', id: '102803_ctg1_6788_-_ctg1_6788' },
  { key: 'collection', name: '收藏', id: '102803_ctg1_8189_-_ctg1_8189' },
  { key: 'digital', name: '数码', id: '102803_ctg1_5088_-_ctg1_5088' },
  { key: 'car', name: '汽车', id: '102803_ctg1_5188_-_ctg1_5188' },
  { key: 'travel', name: '旅游', id: '102803_ctg1_2588_-_ctg1_2588' },
  { key: 'photo', name: '摄影', id: '102803_ctg1_4988_-_ctg1_4988' },
  { key: 'art', name: '艺术', id: '102803_ctg1_5488_-_ctg1_5488' },
  { key: 'campus', name: '校园', id: '102803_ctg1_600177_-_ctg1_600177' },
  { key: 'shortdrama', name: '短剧', id: '102803_ctg1_600410_-_ctg1_600410' },
  { key: 'looks', name: '颜值', id: '102803_ctg1_600165_-_ctg1_600165' },
  { key: 'all', name: '热门（综合）', id: '102803' },
]

/** 默认勾选：搞笑 + 社会。明星默认不勾（多为擦边内容） */
export const DEFAULT_IDS = COMMON.filter((c) => ['funny', 'social'].includes(c.key)).map((c) => c.id)
/** 默认不勾的（设置页里标成「不推荐」） */
export const CAUTION_KEYS = ['star', 'looks']

const cacheFile = () => path.join(dir(), 'categories.json')

function readCache() {
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (Array.isArray(d?.items) && Date.now() - Number(d.at || 0) < CACHE_TTL_MS) {
      return { items: d.items, at: Number(d.at || 0) }
    }
  } catch { /* 没有缓存 */ }
  return null
}

function writeCache(items) {
  try {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), items }, null, 1), 'utf8')
  } catch { /* 写不进去不影响用 */ }
}

/**
 * 拉一份全量分类并写缓存。
 * @param {() => Promise<Array<{id: string, name: string}>>} loader 由调用方给（通常是 weibo.fetchGroupList）
 */
export async function fetchLiveCategories(loader) {
  const groups = await loader()
  const items = []
  for (const g of groups || []) {
    const id = String(g?.id || '').trim()
    const name = String(g?.name || '').trim()
    if (!id || !name) continue
    const known = COMMON.find((c) => c.id === id)
    items.push({ id, name, key: known?.key || '' })
  }
  if (items.length) writeCache(items)
  return items
}

/** 内置 + 缓存合并（缓存里可能有热搜轮换出来的活动分类） */
export function listCategories() {
  const cache = readCache()
  if (!cache) return { items: COMMON.map((c) => ({ ...c })), cached: false, at: 0 }
  const seen = new Set(cache.items.map((x) => x.id))
  const extra = COMMON.filter((c) => !seen.has(c.id))
  return { items: [...cache.items, ...extra], cached: true, at: cache.at }
}

/**
 * 把用户/模型给的东西解析成 containerid。
 * 认：key（funny）、中文名（搞笑）、containerid 本身、以及逗号分隔的多个。
 * @returns {{ids: string[], unknown: string[], titles: string[]}}
 */
export function resolveCategorySpec(spec) {
  const items = listCategories().items
  const ids = []
  const titles = []
  const unknown = []
  const parts = String(spec || '')
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

  for (const raw of parts) {
    const hit = items.find((c) => c.key === raw)
      || items.find((c) => c.name === raw)
      || items.find((c) => c.id === raw)
      || items.find((c) => c.name.replace(/[（(].*$/, '') === raw)
    if (hit) {
      if (!ids.includes(hit.id)) { ids.push(hit.id); titles.push(hit.name) }
    } else if (/^102803(_.+)?$/.test(raw)) {
      if (!ids.includes(raw)) { ids.push(raw); titles.push(raw) }
    } else {
      unknown.push(raw)
    }
  }
  return { ids, titles, unknown }
}

/** containerid → 中文名（拿不到就回 id 尾巴，别报错） */
export function nameOf(id) {
  const hit = listCategories().items.find((c) => c.id === id)
  return hit?.name || String(id).replace(/^102803_ctg1_/, '分类').replace(/-_ctg1_.*$/, '')
}
