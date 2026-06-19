import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import type { SessionRowShape } from './rowMap'
import type { SqliteDriver } from '../platform/contract'

// 领域 repository(运行时无关):只依赖 SqliteDriver 接口,Electron 与 Electrobun 各注入自己的驱动。
// 本文件不得 import 任何具体驱动(better-sqlite3 / bun:sqlite),保证两运行时可共用。

export interface SessionRow extends SessionMeta { movedFlag: boolean; lastMoveId: number | null }
export interface MoveInsert {
  sessionId: string; projectName: string; sourceDirAbs: string; sourceFolder: string; sourceCwd: string
  targetDirAbs: string; targetFolder: string; trashPath: string; claudeJsonUpdated: boolean
}

function hasColumn(driver: SqliteDriver, table: string, col: string): boolean {
  return (driver.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)
}

// 既有库的增量 schema 迁移(新库由 SCHEMA_SQL 直接建成最新结构,既有库走这里逐版本演进)。
function migrateSchema(driver: SqliteDriver, fromVersion: number): void {
  // v2 → v3:archive_versions.gz_total_bytes 重命名为 compressed_bytes
  //（语义是版本包压缩后字节数,不绑定具体压缩算法——压缩后端已从 gzip 换为 zstd)
  if (fromVersion < 3 && hasColumn(driver, 'archive_versions', 'gz_total_bytes') && !hasColumn(driver, 'archive_versions', 'compressed_bytes')) {
    driver.exec('ALTER TABLE archive_versions RENAME COLUMN gz_total_bytes TO compressed_bytes')
  }
}

export function createRepository(driver: SqliteDriver) {
  driver.pragma('journal_mode = WAL')
  driver.exec(SCHEMA_SQL)
  const ver = driver.prepare('SELECT schema_version FROM meta LIMIT 1').get() as any
  if (!ver) driver.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(SCHEMA_VERSION)
  else if (ver.schema_version !== SCHEMA_VERSION) {
    migrateSchema(driver, ver.schema_version)
    driver.prepare('UPDATE meta SET schema_version=?').run(SCHEMA_VERSION)
  }
  const now = () => new Date().toISOString()
  const mapVersion = (r: any) => ({ ...r, versionId: r.version_id, sessionId: r.session_id, projectPathAbs: r.project_path_abs, sourceFolder: r.source_folder, sourceCwd: r.source_cwd, jsonlSizeBytes: r.jsonl_size_bytes, sidecarBytes: r.sidecar_bytes, compressedBytes: r.compressed_bytes, hasSidecar: !!r.has_sidecar, subagentCount: r.subagent_count, lineCount: r.line_count, archivedAt: r.archived_at })
  const mapRestore = (r: any) => ({ ...r, versionId: r.version_id, sessionId: r.session_id, sourceCwd: r.source_cwd, targetDirAbs: r.target_dir_abs, targetFolder: r.target_folder, backupPath: r.backup_path, restoredAt: r.restored_at })

  return {
    driver,
    upsertProject(p: ProjectMeta) {
      driver.prepare(`INSERT INTO projects (project_path_abs,folder_name,exists_on_disk,in_claude_json,session_count,total_size_bytes,last_activity_at,first_indexed_at,last_indexed_at)
        VALUES (@projectPathAbs,@folderName,@existsOnDisk,@inClaudeJson,@sessionCount,@totalSizeBytes,@lastActivityAt,@now,@now)
        ON CONFLICT(project_path_abs) DO UPDATE SET folder_name=excluded.folder_name,exists_on_disk=excluded.exists_on_disk,in_claude_json=excluded.in_claude_json,session_count=excluded.session_count,total_size_bytes=excluded.total_size_bytes,last_activity_at=excluded.last_activity_at,last_indexed_at=excluded.last_indexed_at`)
        .run({ ...p, existsOnDisk: p.existsOnDisk ? 1 : 0, inClaudeJson: p.inClaudeJson ? 1 : 0, now: now() })
    },
    upsertSession(s: SessionRow) {
      const { distinctCwds, ...rest } = s
      driver.prepare(`INSERT INTO sessions (session_id,project_path_abs,folder_name,cwd,title,first_message_preview,started_at,last_activity_at,message_count,line_count,size_bytes,mtime,git_branch,claude_version,entrypoint,is_sidechain,has_sidecar,subagent_count,tool_results_bytes,moved_flag,last_move_id,first_indexed_at,last_indexed_at)
        VALUES (@sessionId,@projectPathAbs,@folderName,@cwd,@title,@firstMessagePreview,@startedAt,@lastActivityAt,@messageCount,@lineCount,@sizeBytes,@mtime,@gitBranch,@claudeVersion,@entrypoint,@isSidechain,@hasSidecar,@subagentCount,@toolResultsBytes,@movedFlag,@lastMoveId,@now,@now)
        ON CONFLICT(session_id) DO UPDATE SET project_path_abs=excluded.project_path_abs,folder_name=excluded.folder_name,cwd=excluded.cwd,title=excluded.title,first_message_preview=excluded.first_message_preview,started_at=excluded.started_at,last_activity_at=excluded.last_activity_at,message_count=excluded.message_count,line_count=excluded.line_count,size_bytes=excluded.size_bytes,mtime=excluded.mtime,git_branch=excluded.git_branch,claude_version=excluded.claude_version,entrypoint=excluded.entrypoint,is_sidechain=excluded.is_sidechain,has_sidecar=excluded.has_sidecar,subagent_count=excluded.subagent_count,tool_results_bytes=excluded.tool_results_bytes,moved_flag=excluded.moved_flag,last_move_id=excluded.last_move_id,last_indexed_at=excluded.last_indexed_at`)
        .run({ ...rest, isSidechain: s.isSidechain ? 1 : 0, hasSidecar: s.hasSidecar ? 1 : 0, movedFlag: s.movedFlag ? 1 : 0, now: now() })
    },
    deleteSession(id: string) { driver.prepare('DELETE FROM sessions WHERE session_id=?').run(id) },
    getProjects(): any[] { return driver.prepare('SELECT * FROM projects ORDER BY last_activity_at DESC').all() },
    getSessions(projectPathAbs: string): any[] {
      return driver.prepare('SELECT * FROM sessions WHERE project_path_abs=? ORDER BY last_activity_at DESC').all(projectPathAbs)
        .map((r: any) => ({ ...r, sessionId: r.session_id }))
    },
    // 全量 sessions 原始行(snake_case),供刷新时喂给扫描 worker 的增量复用;替代旧的 db.raw 直查。
    getAllSessionRows(): SessionRowShape[] {
      return driver.prepare('SELECT * FROM sessions').all() as SessionRowShape[]
    },
    insertMove(m: MoveInsert): number {
      const r = driver.prepare(`INSERT INTO moves (session_id,project_name,source_dir_abs,source_folder,source_cwd,target_dir_abs,target_folder,moved_at,status,rewritten_field_count,sidecar_bytes,trash_path,claude_json_updated)
        VALUES (@sessionId,@projectName,@sourceDirAbs,@sourceFolder,@sourceCwd,@targetDirAbs,@targetFolder,@now,'pending',0,0,@trashPath,@claudeJsonUpdated)`)
        .run({ ...m, claudeJsonUpdated: m.claudeJsonUpdated ? 1 : 0, now: now() })
      return Number(r.lastInsertRowid)
    },
    updateMoveStatus(id: number, status: string, extra?: { rewrittenFieldCount?: number; sidecarBytes?: number; claudeJsonUpdated?: boolean; trashPath?: string }) {
      driver.prepare('UPDATE moves SET status=?, rewritten_field_count=COALESCE(?,rewritten_field_count), sidecar_bytes=COALESCE(?,sidecar_bytes), claude_json_updated=COALESCE(?,claude_json_updated), trash_path=COALESCE(?,trash_path) WHERE id=?')
        .run(status, extra?.rewrittenFieldCount ?? null, extra?.sidecarBytes ?? null, extra?.claudeJsonUpdated == null ? null : extra.claudeJsonUpdated ? 1 : 0, extra?.trashPath ?? null, id)
    },
    getMoves(): any[] { return driver.prepare('SELECT * FROM moves ORDER BY id DESC').all() },
    // 已成功移动(且未回滚)的会话 id 集合,用于在索引里标记"已移动"。
    getMovedSessionIds(): Set<string> {
      const rows = driver.prepare("SELECT DISTINCT session_id FROM moves WHERE status='done'").all() as { session_id: string }[]
      return new Set(rows.map((r) => r.session_id))
    },
    getPendingMoves(): any[] { return driver.prepare("SELECT * FROM moves WHERE status='pending'").all() },
    insertCwdChanges(moveId: number, rows: { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }[]) {
      const stmt = driver.prepare('INSERT INTO cwd_changes (move_id,file_rel,line_no,old_cwd,new_cwd) VALUES (?,?,?,?,?)')
      const tx = driver.transaction(() => rows.forEach((r) => stmt.run(moveId, r.fileRel, r.lineNo, r.oldCwd, r.newCwd)))
      tx()
    },
    insertSnapshotLines(moveId: number, rows: { fileRel: string; lineNo: number; content: string }[]) {
      const stmt = driver.prepare('INSERT INTO snapshot_lines (move_id,file_rel,line_no,content) VALUES (?,?,?,?)')
      const tx = driver.transaction(() => rows.forEach((r) => stmt.run(moveId, r.fileRel, r.lineNo, r.content)))
      tx()
    },
    // 按主键返回会话 cwd,缺失返回 null
    getSessionCwd(sessionId: string): string | null {
      const r = driver.prepare('SELECT cwd FROM sessions WHERE session_id=?').get(sessionId) as { cwd: string } | undefined
      return r ? r.cwd : null
    },
    // 原子写入一条 history 改写记录及其涉及的会话旁表
    insertHistoryRewrite(op: { source: string; oldProject: string; newProject: string; sessionIds: string[]; affectedLines: number }): number {
      return driver.transaction(() => {
        const r = driver.prepare(`INSERT INTO history_rewrites (source,old_project,new_project,affected_lines,rewritten_at)
          VALUES (?,?,?,?,?)`).run(op.source, op.oldProject, op.newProject, op.affectedLines, new Date().toISOString())
        const id = Number(r.lastInsertRowid)
        const stmt = driver.prepare('INSERT INTO history_rewrite_sessions (rewrite_id,session_id) VALUES (?,?)')
        op.sessionIds.forEach((s) => stmt.run(id, s))
        return id
      })()
    },
    getHistoryRewrite(id: number): any {
      const row = driver.prepare('SELECT * FROM history_rewrites WHERE id=?').get(id) as any
      if (!row) return null
      const sids = driver.prepare('SELECT session_id FROM history_rewrite_sessions WHERE rewrite_id=?').all(id) as { session_id: string }[]
      return { ...row, session_ids: sids.map((s) => s.session_id) }
    },
    getHistoryRewrites(): any[] {
      return (driver.prepare('SELECT * FROM history_rewrites ORDER BY id DESC').all() as any[]).map((row) => {
        const sids = driver.prepare('SELECT session_id FROM history_rewrite_sessions WHERE rewrite_id=?').all(row.id) as { session_id: string }[]
        return { ...row, session_ids: sids.map((s) => s.session_id) }
      })
    },
    insertArchiveVersion(v: {
      sessionId: string; kind: 'snapshot' | 'archive'; projectPathAbs: string; sourceFolder: string
      sourceCwd: string; title: string; jsonlSizeBytes: number; sidecarBytes: number; compressedBytes: number
      hasSidecar: boolean; subagentCount: number; lineCount: number
    }): number {
      const r = driver.prepare(`INSERT INTO archive_versions (session_id,kind,status,project_path_abs,source_folder,source_cwd,title,jsonl_size_bytes,sidecar_bytes,compressed_bytes,has_sidecar,subagent_count,line_count,archived_at,note)
        VALUES (@sessionId,@kind,'pending',@projectPathAbs,@sourceFolder,@sourceCwd,@title,@jsonlSizeBytes,@sidecarBytes,@compressedBytes,@hasSidecar,@subagentCount,@lineCount,@now,'')`)
        .run({ ...v, hasSidecar: v.hasSidecar ? 1 : 0, now: now() })
      return Number(r.lastInsertRowid)
    },
    setArchiveVersionStatus(versionId: number, status: 'pending' | 'complete') {
      driver.prepare('UPDATE archive_versions SET status=? WHERE version_id=?').run(status, versionId)
    },
    setArchiveVersionCompressedBytes(versionId: number, compressedBytes: number) {
      driver.prepare('UPDATE archive_versions SET compressed_bytes=? WHERE version_id=?').run(compressedBytes, versionId)
    },
    deleteArchiveVersion(versionId: number) { driver.prepare('DELETE FROM archive_versions WHERE version_id=?').run(versionId) },
    getArchiveVersion(versionId: number): any {
      const r = driver.prepare('SELECT * FROM archive_versions WHERE version_id=?').get(versionId) as any
      return r ? mapVersion(r) : null
    },
    getArchiveVersions(sessionId: string): any[] {
      return (driver.prepare('SELECT * FROM archive_versions WHERE session_id=? ORDER BY version_id DESC').all(sessionId) as any[]).map(mapVersion)
    },
    getAllArchiveVersions(): any[] {
      return (driver.prepare("SELECT * FROM archive_versions WHERE status='complete' ORDER BY version_id DESC").all() as any[]).map(mapVersion)
    },
    getPendingArchiveVersions(): any[] {
      return (driver.prepare("SELECT * FROM archive_versions WHERE status='pending'").all() as any[]).map(mapVersion)
    },
    insertRestore(r: { versionId: number; sessionId: string; sourceCwd: string; targetDirAbs: string; targetFolder: string }): number {
      const row = driver.prepare(`INSERT INTO restores (version_id,session_id,source_cwd,target_dir_abs,target_folder,backup_path,phase,status,restored_at)
        VALUES (@versionId,@sessionId,@sourceCwd,@targetDirAbs,@targetFolder,'',NULL,'pending',@now)`).run({ ...r, now: now() })
      return Number(row.lastInsertRowid)
    },
    setRestoreBackupPath(id: number, backupPath: string) {
      driver.prepare('UPDATE restores SET backup_path=? WHERE id=?').run(backupPath, id)
    },
    setRestorePhase(id: number, phase: 'staging_done' | 'backup_done' | 'commit_done') {
      driver.prepare('UPDATE restores SET phase=? WHERE id=?').run(phase, id)
    },
    setRestoreStatus(id: number, status: 'pending' | 'done' | 'failed' | 'undone') {
      driver.prepare('UPDATE restores SET status=? WHERE id=?').run(status, id)
    },
    getRestore(id: number): any {
      const r = driver.prepare('SELECT * FROM restores WHERE id=?').get(id) as any
      return r ? mapRestore(r) : null
    },
    getPendingRestores(): any[] {
      return (driver.prepare("SELECT * FROM restores WHERE status='pending'").all() as any[]).map(mapRestore)
    },
    // 数据根目录改名后,重写库中存储的绝对路径前缀(前缀锚定,幂等:旧前缀不在则不命中)。
    // backup_path 必须改——undoRestore 读它定位备份;trash_path 顺手改以保持库整洁——undoMove 实际
    // 由「当前 trashRoot + moveId」派生、并不读它,但留旧路径在库里会误导。
    // 用 substr 前缀锚定而非无锚 REPLACE:杜绝路径中段恰含旧前缀串时的误替换;old===new 时为 no-op。
    rewriteDataRootPaths(oldBackupsRoot: string, newBackupsRoot: string, oldTrashRoot: string, newTrashRoot: string) {
      driver.prepare('UPDATE restores SET backup_path = @new || substr(backup_path, length(@old)+1) WHERE substr(backup_path, 1, length(@old)) = @old')
        .run({ old: oldBackupsRoot, new: newBackupsRoot })
      driver.prepare('UPDATE moves SET trash_path = @new || substr(trash_path, length(@old)+1) WHERE substr(trash_path, 1, length(@old)) = @old')
        .run({ old: oldTrashRoot, new: newTrashRoot })
    },
    transaction<T>(fn: () => T): T { return driver.transaction(fn)() },
    close() { driver.close() },
  }
}

export type Db = ReturnType<typeof createRepository>
