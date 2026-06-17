import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db'
import Database from 'better-sqlite3'

describe('db', () => {
  it('建表并支持 project/session upsert 与查询', () => {
    const db = openDb(':memory:')
    db.upsertProject({ projectPathAbs: '/p', folderName: '-p', existsOnDisk: true, inClaudeJson: false, sessionCount: 1, totalSizeBytes: 10, lastActivityAt: 't' })
    db.upsertSession({ sessionId: 's1', projectPathAbs: '/p', folderName: '-p', cwd: '/p', title: 'T', firstMessagePreview: 'p', startedAt: 't', lastActivityAt: 't', messageCount: 2, lineCount: 3, sizeBytes: 10, mtime: 1, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: ['/p'], hasSidecar: false, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null })
    expect(db.getProjects().length).toBe(1)
    expect(db.getSessions('/p').map((s) => s.sessionId)).toEqual(['s1'])
  })
  it('move 生命周期', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    db.updateMoveStatus(id, 'done')
    expect(db.getMoves()[0].status).toBe('done')
  })

  it('deleteSession 删除指定会话', () => {
    const db = openDb(':memory:')
    db.upsertSession({ sessionId: 's1', projectPathAbs: '/p', folderName: '-p', cwd: '/p', title: 'T', firstMessagePreview: 'p', startedAt: 't', lastActivityAt: 't', messageCount: 2, lineCount: 3, sizeBytes: 10, mtime: 1, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: ['/p'], hasSidecar: false, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null })
    expect(db.getSessions('/p').length).toBe(1)
    db.deleteSession('s1')
    expect(db.getSessions('/p').length).toBe(0)
  })

  it('getPendingMoves 仅返回 pending,done 后不再出现', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    expect(db.getPendingMoves().map((m) => m.id)).toEqual([id])
    db.updateMoveStatus(id, 'done')
    expect(db.getPendingMoves()).toEqual([])
  })

  it('updateMoveStatus 的 COALESCE:未传 extra 字段时保留旧值', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    // 第一次写入完整 extra
    db.updateMoveStatus(id, 'done', { rewrittenFieldCount: 7, sidecarBytes: 123, claudeJsonUpdated: true, trashPath: '/trash/1' })
    // 第二次仅改 status,extra 缺省 → 旧值经 COALESCE(?, col) 保留
    db.updateMoveStatus(id, 'rolledback')
    const row = db.getMoves()[0]
    expect(row.status).toBe('rolledback')
    expect(row.rewritten_field_count).toBe(7)
    expect(row.sidecar_bytes).toBe(123)
    expect(row.claude_json_updated).toBe(1)
    expect(row.trash_path).toBe('/trash/1')
  })

  it('insertCwdChanges 与 insertSnapshotLines 在事务中写入', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    db.insertCwdChanges(id, [{ fileRel: 's1.jsonl', lineNo: 2, oldCwd: '/p', newCwd: '/q' }])
    db.insertSnapshotLines(id, [{ fileRel: 's1.jsonl', lineNo: 2, content: '{"cwd":"/p"}' }])
    const cwdRows = db.raw.prepare('SELECT * FROM cwd_changes WHERE move_id=?').all(id) as any[]
    const snapRows = db.raw.prepare('SELECT * FROM snapshot_lines WHERE move_id=?').all(id) as any[]
    expect(cwdRows.length).toBe(1)
    expect(cwdRows[0].new_cwd).toBe('/q')
    expect(snapRows.length).toBe(1)
    expect(snapRows[0].content).toBe('{"cwd":"/p"}')
  })

  it('transaction 包裹回调并返回其结果', () => {
    const db = openDb(':memory:')
    const out = db.transaction(() => {
      db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
      return 42
    })
    expect(out).toBe(42)
    expect(db.getMoves().length).toBe(1)
  })

  it('布尔字段相反取值都被正确编码(覆盖三元另一侧)', () => {
    const db = openDb(':memory:')
    db.upsertProject({ projectPathAbs: '/q', folderName: '-q', existsOnDisk: false, inClaudeJson: true, sessionCount: 0, totalSizeBytes: 0, lastActivityAt: null })
    db.upsertSession({ sessionId: 's9', projectPathAbs: '/q', folderName: '-q', cwd: '/q', title: 'T', firstMessagePreview: 'p', startedAt: null, lastActivityAt: null, messageCount: 0, lineCount: 0, sizeBytes: 0, mtime: 0, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: true, distinctCwds: ['/q'], hasSidecar: true, subagentCount: 1, toolResultsBytes: 0, movedFlag: true, lastMoveId: 5 })
    const p = db.getProjects().find((x) => x.project_path_abs === '/q')
    expect(p.exists_on_disk).toBe(0)
    expect(p.in_claude_json).toBe(1)
    const s = db.getSessions('/q')[0]
    expect(s.is_sidechain).toBe(1)
    expect(s.has_sidecar).toBe(1)
    expect(s.moved_flag).toBe(1)
  })

  it('insertMove 的 claudeJsonUpdated=true 被编码为 1', () => {
    const db = openDb(':memory:')
    db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: true })
    expect(db.getMoves()[0].claude_json_updated).toBe(1)
  })

  it('updateMoveStatus 仅更新 claudeJsonUpdated=false 经三元写入 0', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: true })
    db.updateMoveStatus(id, 'done', { claudeJsonUpdated: false })
    expect(db.getMoves()[0].claude_json_updated).toBe(0)
  })

  it('对已存在 meta 的文件库重开:schema 幂等、不重复插入 meta', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'db-')), 'idx.db')
    const a = openDb(file)
    a.upsertProject({ projectPathAbs: '/p', folderName: '-p', existsOnDisk: true, inClaudeJson: false, sessionCount: 1, totalSizeBytes: 10, lastActivityAt: 't' })
    a.raw.close()
    // 重开同一文件:meta 已存在 → 走 if(!ver) 的 false 分支,不再 INSERT
    const b = openDb(file)
    const metaRows = b.raw.prepare('SELECT * FROM meta').all() as any[]
    expect(metaRows.length).toBe(1)
    expect(b.getProjects().length).toBe(1)
    b.raw.close()
  })

  it('getSessionCwd 按主键返回 cwd,缺失返回 null', () => {
    const db = openDb(':memory:')
    db.upsertSession({ sessionId: 'sx', projectPathAbs: '/p', folderName: '-p', cwd: '/p',
      title: '', firstMessagePreview: '', startedAt: null, lastActivityAt: null,
      messageCount: 0, lineCount: 0, sizeBytes: 0, mtime: 0, gitBranch: null, claudeVersion: null,
      entrypoint: null, isSidechain: false, distinctCwds: [], hasSidecar: false, subagentCount: 0,
      toolResultsBytes: 0, movedFlag: false, lastMoveId: null } as any)
    expect(db.getSessionCwd('sx')).toBe('/p')
    expect(db.getSessionCwd('missing')).toBeNull()
  })

  it('insert/get HistoryRewrite 往返,含旁表 session 集合', () => {
    const db = openDb(':memory:')
    const id = db.insertHistoryRewrite({ source: 'auto', oldProject: '/a', newProject: '/b', sessionIds: ['s1', 's2'], affectedLines: 3 })
    const rec = db.getHistoryRewrite(id)
    expect(rec.old_project).toBe('/a')
    expect(rec.new_project).toBe('/b')
    expect(rec.affected_lines).toBe(3)
    expect(new Set(rec.session_ids)).toEqual(new Set(['s1', 's2']))
    const all = db.getHistoryRewrites()
    expect(all.map((r: any) => r.id)).toContain(id)
  })
})

describe('archive_versions / restores', () => {
  it('插入 pending 版本→置 complete→按会话列出→取单条', () => {
    const db = openDb(':memory:')
    const vid = db.insertArchiveVersion({
      sessionId: 's1', kind: 'snapshot', projectPathAbs: '/work/proj', sourceFolder: '-work-proj',
      sourceCwd: '/work/proj', title: 'hello', jsonlSizeBytes: 10, sidecarBytes: 0, compressedBytes: 5,
      hasSidecar: false, subagentCount: 0, lineCount: 2,
    })
    expect(vid).toBeGreaterThan(0)
    expect(db.getArchiveVersions('s1')[0].status).toBe('pending')
    db.setArchiveVersionStatus(vid, 'complete')
    expect(db.getArchiveVersion(vid).status).toBe('complete')
    expect(db.getArchiveVersion(vid).sessionId).toBe('s1')
    db.setArchiveVersionCompressedBytes(vid, 4096)
    expect(db.getArchiveVersion(vid).compressedBytes).toBe(4096)
    expect(db.getPendingArchiveVersions()).toHaveLength(0)
    db.deleteArchiveVersion(vid)
    expect(db.getArchiveVersions('s1')).toHaveLength(0)
  })

  it('还原记录:插入→回填 backupPath→推进 phase→置 done→列 pending', () => {
    const db = openDb(':memory:')
    const rid = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: '/work/proj', targetDirAbs: '/work/proj', targetFolder: '-work-proj' })
    db.setRestoreBackupPath(rid, `/b/${rid}-s1`)
    expect(db.getRestore(rid).backupPath).toBe(`/b/${rid}-s1`)
    expect(db.getPendingRestores()).toHaveLength(1)
    db.setRestorePhase(rid, 'backup_done')
    expect(db.getRestore(rid).phase).toBe('backup_done')
    db.setRestoreStatus(rid, 'done')
    expect(db.getPendingRestores()).toHaveLength(0)
    expect(db.getRestore(rid).status).toBe('done')
  })

  it('schema v2→v3 迁移:archive_versions.gz_total_bytes 重命名为 compressed_bytes 且数据保留', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mig-')), 'old.db')
    // 手建一个 v2 库:archive_versions 用旧列名 gz_total_bytes
    const raw = new Database(file)
    raw.exec('CREATE TABLE meta (schema_version INTEGER)')
    raw.prepare('INSERT INTO meta (schema_version) VALUES (2)').run()
    raw.exec('CREATE TABLE archive_versions (version_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, gz_total_bytes INTEGER)')
    raw.prepare('INSERT INTO archive_versions (session_id, gz_total_bytes) VALUES (?,?)').run('s1', 999)
    raw.close()
    // openDb 触发 v2→v3 迁移
    const db = openDb(file)
    const cols = (db.raw.prepare('PRAGMA table_info(archive_versions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('compressed_bytes')
    expect(cols).not.toContain('gz_total_bytes')
    // 数据保留 + 版本号回写
    expect((db.raw.prepare('SELECT compressed_bytes FROM archive_versions WHERE session_id=?').get('s1') as any).compressed_bytes).toBe(999)
    expect((db.raw.prepare('SELECT schema_version FROM meta').get() as any).schema_version).toBe(3)
    db.raw.close()
  })
})
