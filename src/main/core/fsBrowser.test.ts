import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { listDir } from './fsBrowser'

describe('listDir', () => {
  it('只返回子目录并标记 git 仓库,带 home 字段', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-'))
    mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b')); mkdirSync(join(root, 'b', '.git'))
    writeFileSync(join(root, 'file.txt'), 'x')
    const r = listDir(root)
    expect(r.entries.map((e) => e.name).sort()).toEqual(['a', 'b'])
    expect(r.entries.find((e) => e.name === 'b')!.isGitRepo).toBe(true)
    expect(r.parent).toBe(dirname(root))
    expect(r.home).toBe(homedir())
    expect(r.error).toBeUndefined()
  })

  it('文件系统根的 parent 为 null', () => {
    expect(listDir('/').parent).toBeNull()
  })

  it('不可读/不存在目录不抛错,返回空列表 + error', () => {
    const r = listDir(join(tmpdir(), 'definitely-missing-' + Date.now()))
    expect(r.entries).toEqual([])
    expect(r.error).toBeTruthy()
  })
})
