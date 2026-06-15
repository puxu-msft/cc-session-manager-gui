import { reRoot } from './pathCodec'

export interface LineChange { field: string; oldCwd: string; newCwd: string }

// 逐行改写:仅改写结构化 cwd 字段(顶层 cwd 与 attachment.response.cwd),绝不触碰正文/工具输出;
// 无法解析或未改动的行返回原始字符串(避免 JSON 往返改变格式或丢失损坏行)
export function rewriteLine(line: string, srcRoot: string, dstRoot: string): { line: string; changes: LineChange[] } {
  let obj: any
  try { obj = JSON.parse(line) } catch { return { line, changes: [] } }
  if (obj === null || typeof obj !== 'object') return { line, changes: [] }
  const changes: LineChange[] = []

  const apply = (holder: any, key: string, field: string) => {
    const v = holder?.[key]
    if (typeof v !== 'string') return
    const nv = reRoot(v, srcRoot, dstRoot)
    if (nv !== v) { holder[key] = nv; changes.push({ field, oldCwd: v, newCwd: nv }) }
  }
  apply(obj, 'cwd', 'cwd')
  if (obj.attachment && obj.attachment.response) apply(obj.attachment.response, 'cwd', 'attachment.response.cwd')

  if (changes.length === 0) return { line, changes: [] }
  return { line: JSON.stringify(obj), changes }
}
