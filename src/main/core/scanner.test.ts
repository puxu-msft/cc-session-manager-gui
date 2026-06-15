import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAll, diffSessions } from './scanner'
import type { SessionMeta } from '@shared/types'

const line = (o: any) => JSON.stringify(o)

function fakeProjects() {
  const root = mkdtempSync(join(tmpdir(), 'ccp-'))
  const pdir = join(root, '-p-root'); mkdirSync(pdir)
  writeFileSync(join(pdir, 's1.jsonl'),
    [line({ type: 'user', cwd: '/p/root', timestamp: '2026-06-15T10:00:00Z', message: { content: 'hi' } })].join('\n'))
  return root
}

describe('scanAll', () => {
  it('聚合出项目与会话', async () => {
    const root = fakeProjects()
    const { projects, sessions } = await scanAll(root)
    expect(sessions.map((s) => s.sessionId)).toEqual(['s1'])
    expect(projects.map((p) => p.projectPathAbs)).toEqual(['/p/root'])
    expect(projects[0].sessionCount).toBe(1)
  })

  it('projectsRoot 不存在时返回空集', async () => {
    const { projects, sessions } = await scanAll(join(tmpdir(), 'definitely-missing-' + Date.now()))
    expect(projects).toEqual([])
    expect(sessions).toEqual([])
  })

  it('跳过非 .jsonl、跳过坏文件、忽略无 cwd 的会话,并按真实 cwd 聚合', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccp-'))
    const pdir = join(root, '-p-root'); mkdirSync(pdir)
    // 非目录条目被跳过(顶层散落文件)
    writeFileSync(join(root, 'stray.txt'), 'ignored')
    // 同一 cwd 两个会话 → 聚合成 1 个 project,sessionCount=2
    writeFileSync(join(pdir, 's1.jsonl'),
      line({ type: 'user', cwd: '/p/root', timestamp: '2026-06-15T10:00:00Z', message: { content: 'a' } }))
    writeFileSync(join(pdir, 's2.jsonl'),
      line({ type: 'user', cwd: '/p/root', timestamp: '2026-06-15T11:00:00Z', message: { content: 'b' } }))
    // 无 cwd 的会话 → 不计入任何 project
    writeFileSync(join(pdir, 's3.jsonl'),
      line({ type: 'user', timestamp: '2026-06-15T09:00:00Z', message: { content: 'c' } }))
    // 非 .jsonl 文件被跳过
    writeFileSync(join(pdir, 'notes.md'), '# skip me')

    const { projects, sessions } = await scanAll(root)
    expect(sessions.length).toBe(3)
    expect(projects.length).toBe(1)
    expect(projects[0].projectPathAbs).toBe('/p/root')
    expect(projects[0].sessionCount).toBe(2)
    // lastActivityAt 取会话中最大的时间戳
    expect(projects[0].lastActivityAt).toBe('2026-06-15T11:00:00Z')
  })
})

describe('diffSessions', () => {
  const meta = (id: string, sizeBytes: number, mtime: number): SessionMeta => ({
    sessionId: id, projectPathAbs: '/p', folderName: '-p', cwd: '/p', title: '', firstMessagePreview: '',
    startedAt: null, lastActivityAt: null, messageCount: 0, lineCount: 0, sizeBytes, mtime,
    gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false,
    distinctCwds: [], hasSidecar: false, subagentCount: 0, toolResultsBytes: 0,
  })

  it('区分新增/移除/变化(size 或 mtime 任一不同即变化)', () => {
    const fresh = [meta('a', 10, 1), meta('b', 20, 2), meta('c', 30, 3)]
    const existing = [
      { session_id: 'b', size_bytes: 20, mtime: 2 }, // 未变
      { session_id: 'c', size_bytes: 99, mtime: 3 }, // size 变
      { session_id: 'd', size_bytes: 5, mtime: 5 }, // 已移除
    ]
    const { added, removed, changed } = diffSessions(fresh, existing)
    expect(added).toEqual(['a'])
    expect(changed).toEqual(['c'])
    expect(removed).toEqual(['d'])
  })

  it('mtime 不同也判为变化', () => {
    const { changed } = diffSessions(
      [meta('x', 10, 999)],
      [{ session_id: 'x', size_bytes: 10, mtime: 1 }],
    )
    expect(changed).toEqual(['x'])
  })
})
