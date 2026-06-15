import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProjectEntry, removeProjectEntry } from './claudeJson'

describe('ensureProjectEntry', () => {
  it('从源克隆白名单字段、重置易失字段、保留其它顶层 key', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({
      userID: 'keep-me',
      projects: { '/src': { allowedTools: ['Bash'], mcpServers: { x: 1 }, lastSessionId: 'old', lastCost: 9, hasTrustDialogAccepted: true } },
    }))
    const added = ensureProjectEntry(f, '/dst', '/src')
    expect(added).toBe(true)
    const j = JSON.parse(readFileSync(f, 'utf8'))
    expect(j.userID).toBe('keep-me')
    expect(j.projects['/src']).toBeTruthy()
    expect(j.projects['/dst'].allowedTools).toEqual(['Bash'])
    expect(j.projects['/dst'].mcpServers).toEqual({ x: 1 })
    expect(j.projects['/dst'].hasTrustDialogAccepted).toBe(true)
    expect(j.projects['/dst'].lastSessionId).toBeUndefined()
    expect(j.projects['/dst'].lastCost).toBeUndefined()
  })
  it('目标已存在则不覆盖,返回 false', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({ projects: { '/dst': { allowedTools: ['Existing'] } } }))
    expect(ensureProjectEntry(f, '/dst', '/src')).toBe(false)
    expect(JSON.parse(readFileSync(f, 'utf8')).projects['/dst'].allowedTools).toEqual(['Existing'])
  })
  it('.claude.json 缺失时不创建、返回 false', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    expect(ensureProjectEntry(f, '/dst', '/src')).toBe(false)
    expect(existsSync(f)).toBe(false)
  })
  it('源项目无条目时克隆空对象', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({ projects: {} }))
    expect(ensureProjectEntry(f, '/dst', '/src')).toBe(true)
    expect(JSON.parse(readFileSync(f, 'utf8')).projects['/dst']).toEqual({})
  })
})

describe('removeProjectEntry', () => {
  it('删除存在的目标条目', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({ projects: { '/dst': { allowedTools: ['X'] }, '/keep': {} } }))
    removeProjectEntry(f, '/dst')
    const j = JSON.parse(readFileSync(f, 'utf8'))
    expect(j.projects['/dst']).toBeUndefined()
    expect(j.projects['/keep']).toBeTruthy()
  })
  it('文件缺失时安全返回(无操作)', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    expect(() => removeProjectEntry(f, '/dst')).not.toThrow()
    expect(existsSync(f)).toBe(false)
  })
  it('目标条目不存在时不改写文件', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({ projects: { '/other': {} } }))
    removeProjectEntry(f, '/dst')
    expect(JSON.parse(readFileSync(f, 'utf8')).projects['/other']).toBeTruthy()
  })
})
