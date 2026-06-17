import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { archiveSession } from './archiver'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'arch2-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  writeFileSync(jsonl, JSON.stringify({ type: 'user', cwd: src, message: { content: 'hi' } }) + '\n')
  mkdirSync(join(fdir, 's1'), { recursive: true }); writeFileSync(join(fdir, 's1', 'meta.json'), '{}')
  const old = new Date(Date.now() - 600_000); utimesSync(jsonl, old, old)
  return { home, projects, archiveRoot, backupsRoot, src, fdir, jsonl }
}
const envOf = (w: any, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, claudeJsonPath: join(w.home, '.claude.json'), db })

describe('archiveSession', () => {
  it('归档后:版本 complete、原件从 projects 消失、sessions 行被删', async () => {
    const w = world(); const db = openDb(':memory:')
    db.upsertSession({ sessionId: 's1', projectPathAbs: w.src, folderName: encodePath(w.src), cwd: w.src, title: 't', firstMessagePreview: '', startedAt: null, lastActivityAt: null, messageCount: 1, lineCount: 1, sizeBytes: 10, mtime: 0, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: [w.src], hasSidecar: true, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null } as any)
    const res = await archiveSession('s1', envOf(w, db))
    expect(res.status).toBe('done')
    expect(db.getArchiveVersion(res.versionId!).kind).toBe('archive')
    expect(existsSync(w.jsonl)).toBe(false)
    expect(existsSync(join(w.fdir, 's1'))).toBe(false)
    expect(db.getSessions(w.src)).toHaveLength(0)
  })
})
