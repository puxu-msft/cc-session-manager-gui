import type { SessionMeta } from '@shared/types'

// sessions 表的一行(snake_case)→ SessionMeta。纯函数,无原生依赖,因此可被扫描 worker 复用。
// distinctCwds 不持久化,回填为 [cwd];它在索引聚合与移动逻辑中均不参与,缺省无副作用。
export interface SessionRowShape {
  session_id: string; project_path_abs: string; folder_name: string; cwd: string
  title: string; first_message_preview: string; started_at: string | null; last_activity_at: string | null
  message_count: number; line_count: number; size_bytes: number; mtime: number
  git_branch: string | null; claude_version: string | null; entrypoint: string | null
  is_sidechain: number; has_sidecar: number; subagent_count: number; tool_results_bytes: number
}

export function rowToSessionMeta(row: SessionRowShape): SessionMeta {
  return {
    sessionId: row.session_id, projectPathAbs: row.project_path_abs, folderName: row.folder_name, cwd: row.cwd,
    title: row.title, firstMessagePreview: row.first_message_preview, startedAt: row.started_at, lastActivityAt: row.last_activity_at,
    messageCount: row.message_count, lineCount: row.line_count, sizeBytes: row.size_bytes, mtime: row.mtime,
    gitBranch: row.git_branch, claudeVersion: row.claude_version, entrypoint: row.entrypoint, isSidechain: !!row.is_sidechain,
    distinctCwds: row.cwd ? [row.cwd] : [], hasSidecar: !!row.has_sidecar, subagentCount: row.subagent_count, toolResultsBytes: row.tool_results_bytes,
  }
}
