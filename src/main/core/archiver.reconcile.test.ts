import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { archiverReconcile } from './archiver'

function base() {
  const home = mkdtempSync(join(tmpdir(), 'arch-rec-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj')
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  return { home, projects, archiveRoot, backupsRoot, src, fdir }
}
const envOf = (w: any, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, db })

describe('archiverReconcile', () => {
  it('清理 pending 版本及其 staging 目录', () => {
    const w = base(); const db = openDb(':memory:')
    const vid = db.insertArchiveVersion({ sessionId: 's1', kind: 'snapshot', projectPathAbs: w.src, sourceFolder: encodePath(w.src), sourceCwd: w.src, title: 't', jsonlSizeBytes: 1, sidecarBytes: 0, compressedBytes: 0, hasSidecar: false, subagentCount: 0, lineCount: 1 })
    const staging = join(w.archiveRoot, 's1', `.staging-${vid}`); mkdirSync(staging, { recursive: true })
    archiverReconcile(envOf(w, db))
    expect(db.getPendingArchiveVersions()).toHaveLength(0)
    expect(existsSync(staging)).toBe(false)
  })

  it('pending restore 处于 backup_done:清除半搬入残留 + 把备份搬回原位、置 failed', () => {
    const w = base(); const db = openDb(':memory:')
    const targetMain = join(w.fdir, 's1.jsonl')
    const rid = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: w.src, targetDirAbs: w.src, targetFolder: w.fdir })
    db.setRestoreBackupPath(rid, join(w.backupsRoot, `${rid}-s1`))
    db.setRestorePhase(rid, 'backup_done')
    // 备份区已存还原前现状
    mkdirSync(join(w.backupsRoot, `${rid}-s1`), { recursive: true })
    writeFileSync(join(w.backupsRoot, `${rid}-s1`, 's1.jsonl'), 'pre-restore state\n')
    // 目标位置有"半搬入"的版本残留(主文件 + 部分 sidecar),reconcile 必须先清除再搬回备份
    writeFileSync(targetMain, 'half-applied version\n')
    mkdirSync(join(w.fdir, 's1'), { recursive: true }); writeFileSync(join(w.fdir, 's1', 'leftover.txt'), 'half')
    archiverReconcile(envOf(w, db))
    expect(readFileSync(targetMain, 'utf8')).toBe('pre-restore state\n')
    expect(existsSync(join(w.fdir, 's1', 'leftover.txt'))).toBe(false)   // 半搬入残留被清除
    expect(db.getRestore(rid).status).toBe('failed')
  })

  it('pending restore 处于 commit_done:补记 done,不回滚目标内容', () => {
    const w = base(); const db = openDb(':memory:')
    const targetMain = join(w.fdir, 's1.jsonl')
    writeFileSync(targetMain, 'restored content\n')   // 已换入的还原结果
    const rid = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: w.src, targetDirAbs: w.src, targetFolder: w.fdir })
    db.setRestoreBackupPath(rid, join(w.backupsRoot, `${rid}-s1`))
    db.setRestorePhase(rid, 'commit_done')
    archiverReconcile(envOf(w, db))
    expect(db.getRestore(rid).status).toBe('done')
    expect(readFileSync(targetMain, 'utf8')).toBe('restored content\n')   // commit_done=已完成,不动内容
  })
})
