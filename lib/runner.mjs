/**
 * lib/runner.mjs —— 跑一轮微博（起 dsh headless 子进程）
 * ============================================================================
 * 设计跟 dsh-tieba-dive 的 runner 一致：
 *
 *   父进程（web profile 里的插件）只做三件事：排时间、起子进程、记结果。
 *   真正干活的全部在子进程里——它拿到 weibo_* 工具，自己看配置、读人设、
 *   刷内容、决定回不回、回哪条、写日记。
 *
 * 为什么这么分工：模板拼的评论只能做到「不像机器人」，做不到「像她」。
 * 只有读过内容的模型才说得出「这版改得比上版实在」这种话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dir, ensureDir, readConfig } from './config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')

export const logsDir = () => path.join(dir(), 'logs')
export const hbFile = () => path.join(dir(), 'hb.json')
export const lockFile = () => path.join(dir(), 'run.lock')

export function dayLogFile(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return path.join(logsDir(), `run-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}

/** 作业说明（模型读的那份） */
export function dutyPrompt() {
  try {
    return fs.readFileSync(path.join(PLUGIN_DIR, 'prompts', 'duty.md'), 'utf8')
  } catch {
    return ''
  }
}

/** 发博任务的说明 */
export function postPrompt() {
  try {
    return fs.readFileSync(path.join(PLUGIN_DIR, 'prompts', 'post.md'), 'utf8')
  } catch {
    return ''
  }
}

/** 话题模式（超话里发讨论）的说明 */
export function postTopicPrompt() {
  try {
    return fs.readFileSync(path.join(PLUGIN_DIR, 'prompts', 'post-topic.md'), 'utf8')
  } catch {
    return ''
  }
}

/** 找 dsh 可执行文件 */
export function resolveDshBin(hint = '') {
  const cands = [hint, process.env.DSH_BIN, '/usr/local/bin/dsh', '/usr/bin/dsh'].filter(Boolean)
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch { /* 没权限就算了 */ }
  }
  return 'dsh' // 交给 PATH
}

// ── 锁：同一时刻只允许一轮 ──────────────────────────────────────────────────
function readLock() {
  try {
    const d = JSON.parse(fs.readFileSync(lockFile(), 'utf8'))
    if (d.pid && !pidAlive(d.pid)) return null
    return d
  } catch {
    return null
  }
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

export function acquireLock(roundId = '') {
  const held = readLock()
  if (held) return { ok: false, pid: held.pid }
  ensureDir()
  fs.mkdirSync(logsDir(), { recursive: true })
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, roundId, at: Date.now() }), 'utf8')
  return { ok: true }
}

export function releaseLock() {
  try { fs.unlinkSync(lockFile()) } catch { /* 已经不在了 */ }
}

export function lockOwner() {
  return readLock()
}

// ── 心跳：父进程定时写，界面/状态接口据此判断「还在跑」 ────────────────────
export function writeHeartbeat(roundId) {
  try {
    ensureDir()
    fs.writeFileSync(hbFile(), JSON.stringify({ pid: process.pid, roundId, at: Date.now() }), 'utf8')
  } catch { /* 写不进就算了，不影响这一轮 */ }
}

export function clearHeartbeat() {
  try { fs.unlinkSync(hbFile()) } catch { /* ignore */ }
}

export function readHeartbeat() {
  try {
    const d = JSON.parse(fs.readFileSync(hbFile(), 'utf8'))
    return { ...d, ageSec: Math.round((Date.now() - d.at) / 1000) }
  } catch {
    return null
  }
}

/**
 * 从子进程输出里抽 `<<< ... >>>` 那段总结。
 *
 * 不能简单用非贪婪正则取第一个：模型的 reasoning 里常出现
 * 「Output summary only in the <<< >>> block」这种句子，
 * 两个标记紧挨着，第一个匹配到的内容只有一个空格，trim 完就是空串。
 * 所以扫全部分块，取内容最长的那个。
 */
export function extractSummary(text) {
  const s = String(text || '')
  const re = /<<<([\s\S]*?)>>>/g
  let best = ''
  let m
  while ((m = re.exec(s)) !== null) {
    const body = m[1].trim()
    if (body.length > best.length) best = body
  }
  return best
}

/** 标记没抓到时的兜底：取最后 3 行非空文本（可能混进 reasoning，所以很短） */
function salvageSummary(text) {
  return String(text || '')
    .split('\n').map((x) => x.trim()).filter(Boolean)
    .slice(-3).join(' · ').slice(0, 200)
}

/**
 * 组装这一轮的提示词。
 *
 * 配置和人设**不写进提示词**，由模型自己在第 0 步调 weibo_settings / weibo_persona 读。
 * 理由：她要先知道「这一轮被允许做什么」「自己是谁」，这属于判断的一部分，不该被喂到嘴里。
 * （早期版本因为 weibo_status 返回值里有 undefined、整次调用报 lossless JSON 错误，
 *   模型撞上报错就绕过了读配置那一步——那是 bug，不是模型偷懒。现在已修。）
 *
 * @param {{clock?: string, allowComment?: boolean, forceTopic?: string}} opt
 */
export function buildPrompt({ clock = '', allowComment = false, forceTopic = '', forceMode = '' } = {}) {
  const cfg = readConfig()
  const scope = forceTopic
    ? `刷取范围：这一轮只看超话「${forceTopic}」，用 weibo_round topic="${forceTopic}"`
    : forceMode === 'hot'
      ? '刷取范围：热门。用 weibo_round mode="hot"——不传 categories，工具会按配置里勾选的分类各拉一段。'
      : forceMode === 'timeline'
        ? '刷取范围：关注流。用 weibo_round mode="timeline"。'
        : '刷取范围：按 `weibo_settings` 里的 `feedMode` 决定——hot 就 `weibo_round mode="hot"`'
          + '（不传 categories，工具会按勾选的分类各拉一段）；timeline 就 `mode="timeline"`；'
          + 'topic 就 `mode="topic" topic="<autoTopic 里那几个>"`。别自己改成关注流。'

  // 口味：主人在设置页填的「爱看 / 不爱看」，直接进提示词。
  // 放在任务段里而不是 duty.md 里，是因为它是用户当天改的、跟这一轮直接相关。
  const likes = String(cfg.likes || '').trim()
  const dislikes = String(cfg.dislikes || '').trim()
  const prefs = [
    likes ? `- 爱看：${likes}` : '',
    dislikes ? `- 不爱看：${dislikes}` : '',
  ].filter(Boolean)

  const task = [
    '',
    '===== 这一轮的任务 =====',
    clock ? `醒来时间：${clock}` : '',
    scope,
    allowComment
      ? '本轮可以回帖：最多 1 条。挑有话说、接得上的一条；没合适的就不发。'
      : '本轮不回帖：刷完、写日记就行。不要调用 weibo_comment。',
    prefs.length
      ? [
        '',
        '主人的口味（判断值不值得接一句、要不要写进日记时按这个来）：',
        ...prefs,
        '不爱看的直接跳过，别为了凑一条去硬接。',
      ].join('\n')
      : '',
  ].filter(Boolean).join('\n')

  return [
    '你现在替使用者刷一轮微博。**开始之前先调 `weibo_settings` 和 `weibo_persona`**，'
      + '弄清楚这一轮被允许做什么、你是个什么样的人——这两个结果没出来之前不要往下做。',
    '',
    dutyPrompt(),
    task,
  ].join('\n')
}

/**
 * 起一轮。返回 Promise；不会抛（错误也写进日志）。
 * @param {{profile?:string, dshBin?:string, timeoutMs?:number, roundId?:string, allowComment?:boolean, forceTopic?:string, forceMode?:string, clock?:string}} opt
 */
export function runRound({
  profile = 'headless',
  dshBin = '',
  timeoutMs = 10 * 60_000,
  roundId = '',
  allowComment = false,
  forceTopic = '',
  forceMode = '',
  clock = '',
  overridePrompt = '',
} = {}) {
  const prompt = String(overridePrompt || '') || buildPrompt({ clock, allowComment, forceTopic, forceMode })

  const lock = acquireLock(roundId)
  if (!lock.ok) {
    return Promise.resolve({ ok: false, error: `另一轮还在跑（pid ${lock.pid}），这次跳过`, skipped: true })
  }

  const bin = resolveDshBin(dshBin)
  const args = [profile, prompt]
  const f = dayLogFile()
  fs.mkdirSync(logsDir(), { recursive: true })

  let fd
  let startOffset = 0
  try {
    fd = fs.openSync(f, 'a')
    fs.writeSync(fd, `\n===== ${new Date().toISOString()} 起一轮 ${roundId} =====\n`)
    startOffset = fs.statSync(f).size
    fs.writeSync(fd, `$ ${bin} ${profile} <prompt ${prompt.length} 字>\n`)
    fs.writeSync(fd, `允许回帖：${allowComment ? '是' : '否'}${forceTopic ? ` · 超话 ${forceTopic}` : ''}${forceMode ? ` · 模式 ${forceMode}` : ''}\n\n`)
  } catch (e) {
    releaseLock()
    return Promise.resolve({ ok: false, error: `写日志失败：${e.message}` })
  }

  const startedAt = Date.now()
  writeHeartbeat(roundId)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, {
        cwd: process.env.DSH_WORKSPACE || os.homedir(),
        env: {
          ...process.env,
          // 关键：子进程里的插件不要再起定时器，否则事件循环撑着不退（贴吧踩过这个坑）
          WEIBO_DIVE_NO_SCHEDULE: '1',
          WEIBO_ROUND_ID: String(roundId),
          WEIBO_FORCE_TOPIC: forceTopic || '',
          WEIBO_FORCE_MODE: forceMode || '',
          WEIBO_NO_COMMENT: allowComment ? '' : '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      child.unref()
      // 锁改记**子进程** pid：父进程（dsh-web）重启后旧锁不会被判死，
      // 避免「父进程重启了、子进程还在跑」时又起一轮，两边同时发评论。
      if (child.pid) {
        try {
          fs.writeFileSync(lockFile(), JSON.stringify({
            pid: child.pid, parentPid: process.pid, roundId, at: Date.now(),
          }), 'utf8')
        } catch { /* 写不进就算了，退回用父进程 pid 的锁 */ }
      }
    } catch (e) {
      try { fs.writeSync(fd, `spawn 失败：${e.message}\n`); fs.closeSync(fd) } catch { /* ignore */ }
      clearHeartbeat()
      releaseLock()
      return resolve({ ok: false, error: `起子进程失败：${e.message}`, log: f })
    }

    // 心跳每 20 秒续一次，让状态查询知道这轮还活着
    const hbTimer = setInterval(() => writeHeartbeat(roundId), 20_000)
    try { hbTimer.unref?.() } catch { /* 老 Node 没有 */ }

    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch {
        try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
      }
    }, timeoutMs)
    try { killTimer.unref?.() } catch { /* ignore */ }

    let out = ''
    const append = (d) => {
      try { fs.writeSync(fd, d) } catch { /* 盘满 */ }
      out += d.toString('utf8')
      if (out.length > 400_000) out = out.slice(-200_000) // 别把内存撑爆
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const finish = (code, errMsg) => {
      clearInterval(hbTimer)
      clearTimeout(killTimer)
      clearHeartbeat()
      releaseLock()
      const ms = Date.now() - startedAt

      // 总结优先从 stdout 抓；抓不到就读日志尾部（同步 write 过的，内容更完整）
      let summary = extractSummary(out)
      let summaryFrom = summary ? 'stdout' : ''
      if (!summary) {
        try {
          // 只读本轮开始之后写进去的那一段。
          // 直接读文件尾部会抓到**上一轮**的 <<<>>> —— 日志是当天累积的，
          // 于是几轮之后会看到「总结」说的是几十条之前那次评论。
          const all = fs.readFileSync(f, 'utf8')
          const mine = all.slice(Math.max(0, startOffset))
          summary = extractSummary(mine)
          if (summary) summaryFrom = 'log'
          else summary = salvageSummary(mine.slice(-20_000))
        } catch { /* 读不到就算了 */ }
      }

      try {
        fs.writeSync(fd, `\n===== 结束 code=${code}${timedOut ? '（超时被杀）' : ''} · ${(ms / 1000).toFixed(0)}s`
          + ` · stdout ${out.length} 字节${summaryFrom ? ` · 总结来自 ${summaryFrom}` : ''} =====\n`)
        if (summary) fs.writeSync(fd, `总结：\n${summary}\n`)
        fs.closeSync(fd)
      } catch { /* ignore */ }
      resolve({
        ok: code === 0 && !timedOut,
        code,
        ms,
        log: f,
        summary,
        timedOut,
        error: errMsg || (timedOut ? `超过 ${Math.round(timeoutMs / 1000)} 秒没跑完，已结束` : code === 0 ? '' : `子进程退出码 ${code}`),
      })
    }

    child.on('error', (e) => finish(-1, `子进程出错：${e.message}`))
    child.on('close', (code) => finish(code))
  })
}
