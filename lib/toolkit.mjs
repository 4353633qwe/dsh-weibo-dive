/**
 * lib/toolkit.mjs —— `defineTool` 的取法 + 参数/输出的兜底
 *
 * 照 dsh-tieba-dive 的做法：宿主不一定把 `dsh-tools` 暴露成能 import 的依赖，
 * 新版宿主要求每个工具声明 `output { schema, render }`，否则注册失败。
 */
let base = (spec) => spec
let usingHost = false

try {
  const m = await import('dsh-tools')
  if (typeof m.defineTool === 'function') { base = m.defineTool; usingHost = true }
} catch { /* 宿主没给，就用本地兜底 */ }

export const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 参数映射 → JSON Schema（宿主原生那层转换的等价物） */
export function toJsonSchema(params) {
  if (!params) return { type: 'object', properties: {}, required: [] }
  if (params.type === 'object') return params
  const props = {}
  const required = []
  for (const [key, val] of Object.entries(params)) {
    if (!val || typeof val !== 'object') continue
    const { required: isRequired, ...schema } = val
    props[key] = schema
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties: props, required, additionalProperties: false }
}

export function defineTool(spec) {
  if (usingHost) return base({ output: textOutput, ...spec })
  return base({ output: textOutput, ...spec, parameters: toJsonSchema(spec.parameters) })
}

export const usingHostDefineTool = () => usingHost
