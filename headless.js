/**
 * headless.js —— headless profile 的入口（纯工具，不带 HTTP 路由）
 *
 * 为什么需要单独一个入口：
 *   web 入口必须**静态**注入 `webServer`，否则 `ctx.inject(['webServer'], cb)`
 *   拿到的是影子实例——register 不报错、match 命中、路由却永远不接请求。
 *   但 headless profile 没有 webServer，静态注入会让整个插件 PENDING，
 *   15 个工具全都不出来，子进程直接废掉。
 *
 * 于是拆成两个入口，共用同一份 `applyTools`：
 *   · index.js    → inject 带 webServer，工具 + 设置页接口
 *   · headless.js → inject 不带 webServer，只有工具
 *
 * 加载方式：headless profile 的 `cordis.patch.yml` 里禁用原条目、插入这一条：
 *   - id: weibo-dive
 *     disabled: true
 *   - insert:
 *       - id: weibo-dive-headless
 *         name: dsh-weibo-dive/headless
 */
import { applyTools } from './index.js'

export const name = 'dsh-weibo-headless'
export const inject = ['tools', 'settings']
export const Config = undefined // 子进程不需要设置页表单

export function apply(ctx, config) {
  applyTools(ctx, config)
}
