import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRename } from './fsMove'

function tmp() { return mkdtempSync(join(tmpdir(), 'fsmove-')) }

describe('safeRename', () => {
  it('同 fs 下移动文件,内容保留、源消失', () => {
    const d = tmp()
    const from = join(d, 'a.txt'); writeFileSync(from, 'hello')
    const to = join(d, 'sub', 'b.txt')
    safeRename(from, to)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf8')).toBe('hello')
  })

  it('移动目录树,保留 symlink 不解引用', () => {
    const d = tmp()
    const from = join(d, 'tree'); mkdirSync(join(from, 'inner'), { recursive: true })
    writeFileSync(join(from, 'inner', 'f.txt'), 'x')
    symlinkSync('/nonexistent/target', join(from, 'link'))
    const to = join(d, 'moved')
    safeRename(from, to)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'inner', 'f.txt'), 'utf8')).toBe('x')
    expect(lstatSync(join(to, 'link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(to, 'link'))).toBe('/nonexistent/target')
  })
})
