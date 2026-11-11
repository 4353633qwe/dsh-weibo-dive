/**
 * lib/deps.mjs —— 首次使用的依赖自检
 *
 * 这个插件本身没有 npm 依赖（纯 node 内置模块 + fetch），但跑起来还需要几样外部条件：
 *   1. Node 22+；
 *   2. 能执行 `dsh`（每轮/发博/回评都是在 headless profile 里起子进程）；
 *   3. **headless profile 里也装了本插件**（只在 web profile 装，子进程会找不到工具）；
 *   4. 数据目录可写（config / cookie / 日志都写在这里）；
 *   5. 能访问微博（weibo.com / m.weibo.cn）；
 *   6. 登录 cookie。
 *
 * 只读检查，不改任何东西；失败项都带一句怎么修。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { dir, readConfig, readCookie } from './config.mjs'
import { resolveDshBin } from './runner.mjs'

const homeDir = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

export function checkDeps() {
  const items = []

  // 1) Node 版本
  const nodeVer = process.versions.node
  const major = Number(String(nodeVer).split('.')[0]) || 0
  items.push({
    name: 'node',
    label: 'Node.js',
    ok: major >= 22,
    detail: `v${nodeVer}`,
    fix: major >= 22 ? '' : '升级到 Node 22 或更高（插件用了 node: 前缀模块与内置 fetch）',
  })

  // 2) dsh 可执行
  const bin = resolveDshBin()
  let dshVer = ''
  let dshOk = false
  try {
    dshVer = String(execFileSync(bin, ['--version'], { timeout: 4000, encoding: 'utf8' }) || '')
      .trim().split('\n')[0]
    dshOk = true
  } catch { dshOk = false }
  items.push({
    name: 'dsh',
    label: 'dsh 命令',
    ok: dshOk,
    detail: dshOk ? `${bin}${dshVer ? ` · ${dshVer}` : ''}` : `执行不了（试过 ${bin}）`,
    fix: dshOk ? '' : '安装 dsh，或设置环境变量 DSH_BIN 指向 dsh 可执行文件',
  })

  // 3) headless profile 里装了本插件
  const cfg = readConfig()
  const profile = String(cfg.headlessProfile || 'headless')
  const pkgFile = path.join(homeDir(), 'profiles', profile, 'node_modules', 'dsh-weibo-dive', 'package.json')
  let profileVer = ''
  try { profileVer = String(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version || '') } catch { profileVer = '' }
  items.push({
    name: 'profile',
    label: `headless profile（${profile}）`,
    ok: Boolean(profileVer),
    detail: profileVer ? `已装 dsh-weibo-dive ${profileVer}` : `没找到 ${pkgFile}`,
    fix: profileVer ? '' : `dsh plugin --profile ${profile} add dsh-weibo-dive`,
  })

  // 4) 数据目录可写
  let dirOk = false
  let dirDetail = dir()
  try {
    fs.mkdirSync(dir(), { recursive: true })
    const probe = path.join(dir(), '.dep-probe')
    fs.writeFileSync(probe, '1')
    fs.unlinkSync(probe)
    dirOk = true
  } catch (e) {
    dirDetail = `${dir()}（${e.message}）`
  }
  items.push({
    name: 'datadir',
    label: '数据目录可写',
    ok: dirOk,
    detail: dirDetail,
    fix: dirOk ? '' : '检查目录权限；插件要把 config / cookie / 日志写在这里',
  })

  // 登录 cookie（不算依赖，但首次使用必须有）
  const hasCookie = Boolean(readCookie())
  items.push({
    name: 'cookie',
    label: '登录 cookie',
    ok: hasCookie,
    detail: hasCookie ? '已保存' : '还没保存',
    fix: hasCookie ? '' : '在「账号」里填 SUB（有 SUBP 就一起填）并保存',
  })

  const depsOk = items.filter((x) => x.name !== 'cookie').every((x) => x.ok === true)
  return {
    ok: depsOk,
    at: new Date().toISOString(),
    items,
    hint: depsOk
      ? (hasCookie ? '依赖齐全。' : '依赖齐全，但还没登录——填 SUB 保存即可。')
      : '看 ok:false 的那一项，按 fix 处理完再查一次。',
  }
}

/**
 * 网络项要异步，所以真正给设置页用的是 checkDepsAsync：
 * 在 cookie 之前插一条真实的「访问微博」探测。
 */

async function probeNetwork() {
  const t0 = Date.now()
  try {
    const r = await fetch('https://weibo.com/', {
      method: 'GET',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    return {
      name: 'network',
      label: '访问微博',
      ok: true,
      ms: Date.now() - t0,
      detail: `weibo.com 返回 ${r.status}`,
      fix: '',
    }
  } catch (e) {
    return {
      name: 'network',
      label: '访问微博',
      ok: false,
      ms: Date.now() - t0,
      detail: `连不上：${e?.message ?? e}`,
      fix: '检查网络 / 代理 / DNS，服务器要能直连 weibo.com 与 m.weibo.cn',
    }
  }
}

/** 给设置页用：把网络探测结果插进去 */
export async function checkDepsAsync() {
  const base = checkDeps()
  const net = await probeNetwork()
  const idx = base.items.findIndex((x) => x.name === 'cookie')
  const items = [...base.items]
  items.splice(idx < 0 ? items.length : idx, 0, net)
  const depsOk = items.filter((x) => x.name !== 'cookie').every((x) => x.ok === true)
  const hasCookie = Boolean(readCookie())
  return {
    ...base,
    ok: depsOk,
    items,
    hint: depsOk
      ? (hasCookie ? '依赖齐全。' : '依赖齐全，但还没登录——填 SUB 保存即可。')
      : '看 ok:false 的那一项，按 fix 处理完再查一次。',
  }
}
