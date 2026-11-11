/**
 * lib/guard.mjs —— 出站过滤（评论 / 回评 / 发博共用）
 *
 * 只做两件事：
 *   1. checkOutbound：本机路径、链接、凭证字样，一律不许出现在公开内容里；
 *   2. toneCheck：客服腔句式，只拦最像模板的几句。
 *
 * 为什么单独拎出来：以前只有「回评」走这套闸，顶层评论和发博是裸奔的 ——
 * 模型完全可能把 /root/...、https://...、SUB= 写进公开微博。
 */
const PATTERNS = [
  { re: /(^|[\s(（])(~?\/[A-Za-z0-9_.-]+){2,}/, why: '本机路径' },
  { re: /\b[A-Za-z]:\\[^\s]+/, why: 'Windows 路径' },
  { re: /\bhttps?:\/\/|\bfile:\/\/|\bftp:\/\//i, why: '链接' },
  { re: /\b(sub|subp|bduss|token|password|passwd|xsrf)\b/i, why: '凭证字样' },
  { re: /\.dsh\b|\/root\b|\/home\/[A-Za-z0-9_-]+/i, why: '本机路径' },
]

export function checkOutbound(text) {
  const s = String(text || '')
  const hits = []
  for (const p of PATTERNS) if (p.re.test(s)) hits.push(p.why)
  return { ok: hits.length === 0, hits: [...new Set(hits)] }
}

/** 客服腔：只拦几个最像模板的句式 */
const TONE = [
  /感谢(您|你)的(评论|留言|支持|关注)/,
  /^您好[，,！!]/,
  /很高兴(能)?(和|与)(您|你)/,
  /期待(您|你)的(下次|再次)/,
  /希望能(帮|对)(到)?(您|你)/,
]

export function toneCheck(text) {
  return TONE.filter((re) => re.test(String(text || ''))).length
}

/** 评论/回评的统一文字闸：返回 null 表示通过 */
export function commentGate(text, { toneGate = true } = {}) {
  const g = checkOutbound(text)
  if (!g.ok) return `这句里有不该发的东西（${g.hits.join('、')}）`
  if (toneGate !== false && toneCheck(text)) return '这句太像客服了，换个说法'
  return null
}
