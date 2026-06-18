import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { snapshotSession } from './archiver'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'arch-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  writeFileSync(jsonl, [
    JSON.stringify({ type: 'user', cwd: src, message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', cwd: src, message: { content: 'ok' } }),
  ].join('\n') + '\n')
  // sidecar
  mkdirSync(join(fdir, 's1', 'tool-results'), { recursive: true })
  writeFileSync(join(fdir, 's1', 'tool-results', 'r.txt'), 'big')
  const old = new Date(Date.now() - 600_000)
  utimesSync(jsonl, old, old)
  return { home, projects, archiveRoot, backupsRoot, src, fdir, jsonl }
}
const envOf = (w: ReturnType<typeof world>, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, claudeJsonPath: join(w.home, '.claude.json'), db })

describe('snapshotSession', () => {
  it('快照写出 complete 版本,原件不动', async () => {
    const w = world(); const db = openDb(':memory:')
    const res = await snapshotSession('s1', envOf(w, db))
    expect(res.status).toBe('done')
    const v = db.getArchiveVersion(res.versionId!)
    expect(v.status).toBe('complete')
    expect(v.kind).toBe('snapshot')
    expect(v.sourceCwd).toBe(w.src)
    // 原件仍在
    expect(existsSync(w.jsonl)).toBe(true)
    // 版本目录含 content.tar.zst + manifest.json
    const vdir = join(w.archiveRoot, 's1', String(res.versionId))
    expect(existsSync(join(vdir, 'content.tar.zst'))).toBe(true)
    expect(existsSync(join(vdir, 'manifest.json'))).toBe(true)
  })

  it('活跃会话(mtime 在阈值内)被拒绝', async () => {
    const w = world(); const db = openDb(':memory:')
    utimesSync(w.jsonl, new Date(), new Date())
    const res = await snapshotSession('s1', envOf(w, db))
    expect(res.status).toBe('skipped')
    expect(db.getArchiveVersions('s1')).toHaveLength(0)
  })

  it('无 cwd 的会话被拒绝归档(将无法还原)', async () => {
    const w = world(); const db = openDb(':memory:')
    writeFileSync(w.jsonl, JSON.stringify({ type: 'user', message: { content: 'no cwd here' } }) + '\n')
    const old = new Date(Date.now() - 600_000); utimesSync(w.jsonl, old, old)
    const res = await snapshotSession('s1', envOf(w, db))
    expect(res.status).toBe('skipped')
    expect(db.getArchiveVersions('s1')).toHaveLength(0)
  })
})
