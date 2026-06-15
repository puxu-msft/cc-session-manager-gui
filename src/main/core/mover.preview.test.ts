import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewMove } from './mover'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const dst = join(home, 'work', 'moved'); mkdirSync(dst, { recursive: true })
  return { home, projects, src, dst }
}

describe('previewMove', () => {
  it('正常会话:统计将改写的 cwd 字段与回收区体积,无阻断', async () => {
    const { projects, src, dst } = setup()
    const { encodePath } = await import('./pathCodec')
    const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
    writeFileSync(join(fdir, 's1.jsonl'),
      [JSON.stringify({ type: 'user', cwd: src, timestamp: '2026-06-15T10:00:00Z', message: { content: 'hi' } }),
       JSON.stringify({ type: 'assistant', cwd: src, timestamp: '2026-06-15T10:01:00Z', message: { content: 'ok' } })].join('\n'))
    utimesSync(join(fdir, 's1.jsonl'), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000))
    const pv = await previewMove(['s1'], dst, { projectsRoot: projects })
    expect(pv.items[0].blocked).toBeNull()
    expect(pv.items[0].structuralCwdFields).toBe(2)
    expect(pv.items[0].srcRoot).toBe(src)
    expect(pv.claudeJsonWillAddEntry).toBe(true)
  })

  it('活跃会话被标记 blocked=live', async () => {
    const { projects, src, dst } = setup()
    const { encodePath } = await import('./pathCodec')
    const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
    writeFileSync(join(fdir, 's2.jsonl'), JSON.stringify({ type: 'user', cwd: src, timestamp: 't', message: { content: 'hi' } }))
    const pv = await previewMove(['s2'], dst, { projectsRoot: projects })
    expect(pv.items[0].blocked).toBe('live')
  })
})
