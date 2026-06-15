import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistory } from './historyJsonl'

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
