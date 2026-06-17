export const SCHEMA_VERSION = 2
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER);
CREATE TABLE IF NOT EXISTS projects (
  project_path_abs TEXT PRIMARY KEY, folder_name TEXT, exists_on_disk INTEGER, in_claude_json INTEGER,
  session_count INTEGER, total_size_bytes INTEGER, last_activity_at TEXT,
  first_indexed_at TEXT, last_indexed_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, project_path_abs TEXT, folder_name TEXT, cwd TEXT,
  title TEXT, first_message_preview TEXT, started_at TEXT, last_activity_at TEXT,
  message_count INTEGER, line_count INTEGER, size_bytes INTEGER, mtime REAL,
  git_branch TEXT, claude_version TEXT, entrypoint TEXT, is_sidechain INTEGER,
  has_sidecar INTEGER, subagent_count INTEGER, tool_results_bytes INTEGER,
  moved_flag INTEGER, last_move_id INTEGER, first_indexed_at TEXT, last_indexed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path_abs);
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, project_name TEXT,
  source_dir_abs TEXT, source_folder TEXT, source_cwd TEXT,
  target_dir_abs TEXT, target_folder TEXT, moved_at TEXT, status TEXT,
  rewritten_field_count INTEGER, sidecar_bytes INTEGER, trash_path TEXT, claude_json_updated INTEGER);
CREATE TABLE IF NOT EXISTS cwd_changes (move_id INTEGER, file_rel TEXT, line_no INTEGER, old_cwd TEXT, new_cwd TEXT);
CREATE TABLE IF NOT EXISTS snapshot_lines (move_id INTEGER, file_rel TEXT, line_no INTEGER, content TEXT);
CREATE TABLE IF NOT EXISTS history_rewrites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT,
  old_project TEXT, new_project TEXT, affected_lines INTEGER, rewritten_at TEXT);
CREATE TABLE IF NOT EXISTS history_rewrite_sessions (rewrite_id INTEGER, session_id TEXT);
CREATE TABLE IF NOT EXISTS archive_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT, status TEXT,
  project_path_abs TEXT, source_folder TEXT, source_cwd TEXT, title TEXT,
  jsonl_size_bytes INTEGER, sidecar_bytes INTEGER, gz_total_bytes INTEGER,
  has_sidecar INTEGER, subagent_count INTEGER, line_count INTEGER, archived_at TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_archive_session ON archive_versions(session_id);
CREATE TABLE IF NOT EXISTS restores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER, session_id TEXT, source_cwd TEXT,
  target_dir_abs TEXT, target_folder TEXT, backup_path TEXT, phase TEXT, status TEXT, restored_at TEXT);
`
