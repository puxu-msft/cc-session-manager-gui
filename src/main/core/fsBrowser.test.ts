import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir } from './fsBrowser'

describe('listDir', () => {
  it('只返回子目录并标记 git 仓库', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-'))
    mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b')); mkdirSync(join(root, 'b', '.git'))
    writeFileSync(join(root, 'file.txt'), 'x')
    const r = listDir(root)
    expect(r.entries.map((e) => e.name).sort()).toEqual(['a', 'b'])
    expect(r.entries.find((e) => e.name === 'b')!.isGitRepo).toBe(true)
    expect(r.parent).toBe(require('node:path').dirname(root))
  })
})
