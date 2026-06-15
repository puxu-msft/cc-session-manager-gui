import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAll } from './scanner'

function fakeProjects() {
  const root = mkdtempSync(join(tmpdir(), 'ccp-'))
  const pdir = join(root, '-p-root'); mkdirSync(pdir)
  const line = (o: any) => JSON.stringify(o)
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
})
