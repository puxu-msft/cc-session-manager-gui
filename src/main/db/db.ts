import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import type { SessionMeta, ProjectMeta } from '@shared/types'

export interface SessionRow extends SessionMeta { movedFlag: boolean; lastMoveId: number | null }
export interface MoveInsert {
  sessionId: string; projectName: string; sourceDirAbs: string; sourceFolder: string; sourceCwd: string
  targetDirAbs: string; targetFolder: string; trashPath: string; claudeJsonUpdated: boolean
}

export function openDb(file: string) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  const ver = db.prepare('SELECT schema_version FROM meta LIMIT 1').get() as any
  if (!ver) db.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(SCHEMA_VERSION)
  const now = () => new Date().toISOString()

  return {
    raw: db,
    upsertProject(p: ProjectMeta) {
      db.prepare(`INSERT INTO projects (project_path_abs,folder_name,exists_on_disk,in_claude_json,session_count,total_size_bytes,last_activity_at,first_indexed_at,last_indexed_at)
        VALUES (@projectPathAbs,@folderName,@existsOnDisk,@inClaudeJson,@sessionCount,@totalSizeBytes,@lastActivityAt,@now,@now)
        ON CONFLICT(project_path_abs) DO UPDATE SET folder_name=excluded.folder_name,exists_on_disk=excluded.exists_on_disk,in_claude_json=excluded.in_claude_json,session_count=excluded.session_count,total_size_bytes=excluded.total_size_bytes,last_activity_at=excluded.last_activity_at,last_indexed_at=excluded.last_indexed_at`)
        .run({ ...p, existsOnDisk: p.existsOnDisk ? 1 : 0, inClaudeJson: p.inClaudeJson ? 1 : 0, now: now() })
    },
    upsertSession(s: SessionRow) {
      const { distinctCwds, ...rest } = s
      db.prepare(`INSERT INTO sessions (session_id,project_path_abs,folder_name,cwd,title,first_message_preview,started_at,last_activity_at,message_count,line_count,size_bytes,mtime,git_branch,claude_version,entrypoint,is_sidechain,has_sidecar,subagent_count,tool_results_bytes,moved_flag,last_move_id,first_indexed_at,last_indexed_at)
        VALUES (@sessionId,@projectPathAbs,@folderName,@cwd,@title,@firstMessagePreview,@startedAt,@lastActivityAt,@messageCount,@lineCount,@sizeBytes,@mtime,@gitBranch,@claudeVersion,@entrypoint,@isSidechain,@hasSidecar,@subagentCount,@toolResultsBytes,@movedFlag,@lastMoveId,@now,@now)
        ON CONFLICT(session_id) DO UPDATE SET project_path_abs=excluded.project_path_abs,folder_name=excluded.folder_name,cwd=excluded.cwd,title=excluded.title,first_message_preview=excluded.first_message_preview,started_at=excluded.started_at,last_activity_at=excluded.last_activity_at,message_count=excluded.message_count,line_count=excluded.line_count,size_bytes=excluded.size_bytes,mtime=excluded.mtime,git_branch=excluded.git_branch,claude_version=excluded.claude_version,entrypoint=excluded.entrypoint,is_sidechain=excluded.is_sidechain,has_sidecar=excluded.has_sidecar,subagent_count=excluded.subagent_count,tool_results_bytes=excluded.tool_results_bytes,moved_flag=excluded.moved_flag,last_move_id=excluded.last_move_id,last_indexed_at=excluded.last_indexed_at`)
        .run({ ...rest, isSidechain: s.isSidechain ? 1 : 0, hasSidecar: s.hasSidecar ? 1 : 0, movedFlag: s.movedFlag ? 1 : 0, now: now() })
    },
    deleteSession(id: string) { db.prepare('DELETE FROM sessions WHERE session_id=?').run(id) },
    getProjects(): any[] { return db.prepare('SELECT * FROM projects ORDER BY last_activity_at DESC').all() },
    getSessions(projectPathAbs: string): any[] {
      return db.prepare('SELECT * FROM sessions WHERE project_path_abs=? ORDER BY last_activity_at DESC').all(projectPathAbs)
        .map((r: any) => ({ ...r, sessionId: r.session_id }))
    },
    insertMove(m: MoveInsert): number {
      const r = db.prepare(`INSERT INTO moves (session_id,project_name,source_dir_abs,source_folder,source_cwd,target_dir_abs,target_folder,moved_at,status,rewritten_field_count,sidecar_bytes,trash_path,claude_json_updated)
        VALUES (@sessionId,@projectName,@sourceDirAbs,@sourceFolder,@sourceCwd,@targetDirAbs,@targetFolder,@now,'pending',0,0,@trashPath,@claudeJsonUpdated)`)
        .run({ ...m, claudeJsonUpdated: m.claudeJsonUpdated ? 1 : 0, now: now() })
      return Number(r.lastInsertRowid)
    },
    updateMoveStatus(id: number, status: string, extra?: { rewrittenFieldCount?: number; sidecarBytes?: number; claudeJsonUpdated?: boolean; trashPath?: string }) {
      db.prepare('UPDATE moves SET status=?, rewritten_field_count=COALESCE(?,rewritten_field_count), sidecar_bytes=COALESCE(?,sidecar_bytes), claude_json_updated=COALESCE(?,claude_json_updated), trash_path=COALESCE(?,trash_path) WHERE id=?')
        .run(status, extra?.rewrittenFieldCount ?? null, extra?.sidecarBytes ?? null, extra?.claudeJsonUpdated == null ? null : extra.claudeJsonUpdated ? 1 : 0, extra?.trashPath ?? null, id)
    },
    getMoves(): any[] { return db.prepare('SELECT * FROM moves ORDER BY id DESC').all() },
    getPendingMoves(): any[] { return db.prepare("SELECT * FROM moves WHERE status='pending'").all() },
    insertCwdChanges(moveId: number, rows: { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }[]) {
      const stmt = db.prepare('INSERT INTO cwd_changes (move_id,file_rel,line_no,old_cwd,new_cwd) VALUES (?,?,?,?,?)')
      const tx = db.transaction(() => rows.forEach((r) => stmt.run(moveId, r.fileRel, r.lineNo, r.oldCwd, r.newCwd)))
      tx()
    },
    insertSnapshotLines(moveId: number, rows: { fileRel: string; lineNo: number; content: string }[]) {
      const stmt = db.prepare('INSERT INTO snapshot_lines (move_id,file_rel,line_no,content) VALUES (?,?,?,?)')
      const tx = db.transaction(() => rows.forEach((r) => stmt.run(moveId, r.fileRel, r.lineNo, r.content)))
      tx()
    },
    transaction<T>(fn: () => T): T { return db.transaction(fn)() },
    close() { db.close() },
  }
}
export type Db = ReturnType<typeof openDb>

// 把 sessions 表的一行(snake_case)还原成 SessionMeta,用于增量扫描时复用未变文件的缓存元数据(跳过重新解析)。
// distinctCwds 不持久化,这里回填为 [cwd];它在索引聚合与移动逻辑中均不参与,缺省无副作用。
export function rowToSessionMeta(row: {
  session_id: string; project_path_abs: string; folder_name: string; cwd: string
  title: string; first_message_preview: string; started_at: string | null; last_activity_at: string | null
  message_count: number; line_count: number; size_bytes: number; mtime: number
  git_branch: string | null; claude_version: string | null; entrypoint: string | null
  is_sidechain: number; has_sidecar: number; subagent_count: number; tool_results_bytes: number
}): SessionMeta {
  return {
    sessionId: row.session_id, projectPathAbs: row.project_path_abs, folderName: row.folder_name, cwd: row.cwd,
    title: row.title, firstMessagePreview: row.first_message_preview, startedAt: row.started_at, lastActivityAt: row.last_activity_at,
    messageCount: row.message_count, lineCount: row.line_count, sizeBytes: row.size_bytes, mtime: row.mtime,
    gitBranch: row.git_branch, claudeVersion: row.claude_version, entrypoint: row.entrypoint, isSidechain: !!row.is_sidechain,
    distinctCwds: row.cwd ? [row.cwd] : [], hasSidecar: !!row.has_sidecar, subagentCount: row.subagent_count, toolResultsBytes: row.tool_results_bytes,
  }
}
