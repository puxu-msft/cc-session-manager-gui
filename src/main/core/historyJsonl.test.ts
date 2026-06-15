import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistory, applyHistoryRewrite } from './historyJsonl'

let dir: string
const histPath = () => join(dir, 'history.jsonl')
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('readHistory', () => {
  it('文件不存在返回空,不抛', () => {
    const r = readHistory(histPath())
    expect(r.lines).toEqual([])
    expect(r.size).toBe(0)
  })

  it('逐行解析,损坏行 parsed=null 但保留 raw', () => {
    writeFileSync(histPath(), '{"sessionId":"a","project":"/p"}\nNOT_JSON\n{"sessionId":"b","project":"/q"}\n')
    const r = readHistory(histPath())
    expect(r.lines).toHaveLength(3)
    expect(r.lines[0].parsed?.sessionId).toBe('a')
    expect(r.lines[1].parsed).toBeNull()
    expect(r.lines[1].raw).toBe('NOT_JSON')
    expect(r.lines[2].lineNo).toBe(3)
    expect(r.size).toBeGreaterThan(0)
    expect(r.mtime).toBeGreaterThan(0)
  })
})

describe('applyHistoryRewrite', () => {
  it('只改命中 (sessionId, oldProject) 的 project,非目标/损坏行字节透传', () => {
    const raw = '{"display":"x","project":"/a","sessionId":"s1"}\nBROKEN\n{"display":"y","project":"/keep","sessionId":"s2"}\n'
    writeFileSync(histPath(), raw)
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [{ sessionId: 's1', oldProject: '/a', newProject: '/b' }], { size: g.size, mtime: g.mtimeMs })
    const after = readFileSync(histPath(), 'utf8')
    expect(after).toContain('"project":"/b"')
    expect(after).toContain('BROKEN')
    expect(after).toContain('"project":"/keep"')
    expect(after.startsWith('{"display":"x"')).toBe(true)
    expect(ops).toEqual([{ oldProject: '/a', newProject: '/b', sessionIds: ['s1'], affectedLines: 1 }])
  })

  it('同 sessionId 散落 A、B 两组各自聚合成一条 op', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s"}\n{"project":"/x","sessionId":"s"}\n')
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [
      { sessionId: 's', oldProject: '/a', newProject: '/c' },
      { sessionId: 's', oldProject: '/x', newProject: '/c' },
    ], { size: g.size, mtime: g.mtimeMs })
    expect(ops).toContainEqual({ oldProject: '/a', newProject: '/c', sessionIds: ['s'], affectedLines: 1 })
    expect(ops).toContainEqual({ oldProject: '/x', newProject: '/c', sessionIds: ['s'], affectedLines: 1 })
  })

  it('rename 前 size/mtime 与 guard 不符则中止,不覆盖原文件', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s1"}\n')
    const stale = { size: 999999, mtime: 1 }
    expect(() => applyHistoryRewrite(histPath(), [{ sessionId: 's1', oldProject: '/a', newProject: '/b' }], stale))
      .toThrow(/对账期间被修改/)
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/a"')
  })

  it('含空格的 cwd 路径:返回的 old/new project 完整不被截断', () => {
    writeFileSync(histPath(), '{"project":"/Users/me/My Project","sessionId":"s1"}\n')
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [{ sessionId: 's1', oldProject: '/Users/me/My Project', newProject: '/Users/me/New Project' }], { size: g.size, mtime: g.mtimeMs })
    expect(ops).toEqual([{ oldProject: '/Users/me/My Project', newProject: '/Users/me/New Project', sessionIds: ['s1'], affectedLines: 1 }])
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/Users/me/New Project"')
  })

  it('无命中则不写、返回空', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s1"}\n')
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [{ sessionId: 'nope', oldProject: '/z', newProject: '/b' }], { size: g.size, mtime: g.mtimeMs })
    expect(ops).toEqual([])
  })
})
