import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trashUsage, purgeMove, purgeAllTrash } from './trash'

function world() {
  const trash = mkdtempSync(join(tmpdir(), 'trash-'))
  mkdirSync(join(trash, '1')); writeFileSync(join(trash, '1', 'a.jsonl'), 'x'.repeat(100))
  mkdirSync(join(trash, '2', 'sub'), { recursive: true }); writeFileSync(join(trash, '2', 'sub', 'b.txt'), 'y'.repeat(50))
  writeFileSync(join(trash, 'stray.txt'), 'ignored') // 非目录条目被忽略
  return trash
}

describe('trash', () => {
  it('统计每条移动与总占用', () => {
    const trash = world()
    const u = trashUsage(trash)
    expect(u.byMove['1']).toBe(100)
    expect(u.byMove['2']).toBe(50) // 递归子目录
    expect(u.total).toBe(150)
  })

  it('purgeMove 清理单条', () => {
    const trash = world()
    purgeMove(trash, 1)
    expect(existsSync(join(trash, '1'))).toBe(false)
    expect(existsSync(join(trash, '2'))).toBe(true)
    expect(trashUsage(trash).total).toBe(50)
  })

  it('purgeAllTrash 清空全部', () => {
    const trash = world()
    purgeAllTrash(trash)
    expect(trashUsage(trash).total).toBe(0)
  })

  it('回收区不存在时返回零', () => {
    expect(trashUsage(join(tmpdir(), 'missing-' + Date.now()))).toEqual({ total: 0, byMove: {} })
  })
})
