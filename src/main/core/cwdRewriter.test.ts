import { describe, it, expect } from 'vitest'
import { rewriteLine } from './cwdRewriter'

const SRC = '/home/xp/src/neighbors', DST = '/home/data/neighbors'

describe('rewriteLine', () => {
  it('改写顶层 cwd', () => {
    const { line, changes } = rewriteLine(JSON.stringify({ type: 'user', cwd: SRC }), SRC, DST)
    expect(JSON.parse(line).cwd).toBe(DST)
    expect(changes).toEqual([{ field: 'cwd', oldCwd: SRC, newCwd: DST }])
  })
  it('改写嵌套 attachment.response.cwd', () => {
    const obj = { type: 'attachment', cwd: SRC, attachment: { response: { cwd: SRC } } }
    const { line } = rewriteLine(JSON.stringify(obj), SRC, DST)
    const p = JSON.parse(line)
    expect(p.cwd).toBe(DST); expect(p.attachment.response.cwd).toBe(DST)
  })
  it('正文里的源路径绝不改写', () => {
    const obj = { type: 'user', cwd: SRC, message: { content: `opened ${SRC}/a.md` } }
    const { line } = rewriteLine(JSON.stringify(obj), SRC, DST)
    expect(JSON.parse(line).message.content).toBe(`opened ${SRC}/a.md`)  // 正文不动
  })
  it('项目外的 cwd 保留(/tmp)', () => {
    const { line, changes } = rewriteLine(JSON.stringify({ type: 'user', cwd: '/tmp' }), SRC, DST)
    expect(JSON.parse(line).cwd).toBe('/tmp'); expect(changes).toEqual([])
  })
  it('无 cwd 的行原样返回', () => {
    const raw = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' })
    expect(rewriteLine(raw, SRC, DST).line).toBe(raw)
  })
  it('损坏行(无法解析)字节级透传', () => {
    const bad = '{"type":"user"\x00 broken'
    expect(rewriteLine(bad, SRC, DST).line).toBe(bad)
  })
})
