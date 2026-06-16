import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { winPathToWsl, detectSources } from './sources'

describe('winPathToWsl', () => {
  it('C:\\Users\\foo → /mnt/c/Users/foo', () => {
    expect(winPathToWsl('C:\\Users\\foo')).toBe('/mnt/c/Users/foo')
  })
  it('小写盘符与正斜杠也能处理', () => {
    expect(winPathToWsl('D:/work/x')).toBe('/mnt/d/work/x')
  })
  it('非 Windows 路径返回 null', () => {
    expect(winPathToWsl('/home/xp')).toBeNull()
    expect(winPathToWsl('')).toBeNull()
  })
})

describe('detectSources', () => {
  it('始终包含本机源,projectsRoot 指向 ~/.claude/projects', () => {
    const s = detectSources()
    expect(s.length).toBeGreaterThanOrEqual(1)
    const local = s.find((x) => x.id === 'local')!
    expect(local.projectsRoot).toBe(join(homedir(), '.claude', 'projects'))
    expect(local.claudeJsonPath).toBe(join(homedir(), '.claude.json'))
    expect(local.trashRoot).toBe(join(homedir(), '.claude', '.cc-move-trash'))
  })
  it('每个 source 含由 claudeHome 派生的 historyJsonlPath', () => {
    for (const s of detectSources()) {
      expect(s.historyJsonlPath).toMatch(/\.claude[\/\\]history\.jsonl$/)
      expect(s.historyJsonlPath.replace(/history\.jsonl$/, 'projects')).toBe(s.projectsRoot)
    }
  })
})
