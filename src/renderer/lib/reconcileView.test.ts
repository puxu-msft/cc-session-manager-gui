import { describe, it, expect } from 'vitest'
import { reconcileSummary, isLossyForce } from './reconcileView'

describe('reconcileSummary', () => {
  it('统计 ops 会话数与行数、需人工行数', () => {
    const plan = {
      ops: [{ sessionId: 's1', lineNos: [1, 2] }],
      orphans: [{ sessionId: 'o1', lineNos: [3] }],
      ambiguous: [{ sessionId: 'a1', lineNos: [4, 5] }],
    }
    const s = reconcileSummary(plan as any)
    expect(s.opsCount).toBe(1)
    expect(s.opsLines).toBe(2)
    expect(s.manualLines).toBe(3)
  })
})

describe('isLossyForce', () => {
  it('去掉空串后多个不同 project → 有损', () => {
    expect(isLossyForce(['/a', '/b'])).toBe(true)
  })
  it('单个 project 或仅含空串 → 不有损', () => {
    expect(isLossyForce(['/a'])).toBe(false)
    expect(isLossyForce(['/a', ''])).toBe(false)
    expect(isLossyForce([''])).toBe(false)
  })
})
