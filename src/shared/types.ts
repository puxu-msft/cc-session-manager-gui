export interface SessionMeta {
  sessionId: string
  projectPathAbs: string
  folderName: string
  cwd: string
  title: string
  firstMessagePreview: string
  startedAt: string | null
  lastActivityAt: string | null
  messageCount: number
  lineCount: number
  sizeBytes: number
  mtime: number
  gitBranch: string | null
  claudeVersion: string | null
  entrypoint: string | null
  isSidechain: boolean
  distinctCwds: string[]
  hasSidecar: boolean
  subagentCount: number
  toolResultsBytes: number
}

export interface ProjectMeta {
  projectPathAbs: string
  folderName: string
  existsOnDisk: boolean
  inClaudeJson: boolean
  sessionCount: number
  totalSizeBytes: number
  lastActivityAt: string | null
}

export interface CwdChange { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }

export interface MovePreviewItem {
  sessionId: string
  title: string
  srcRoot: string
  dstRoot: string
  structuralCwdFields: number
  sidecarBytes: number
  toolResultsBytes: number
  trashBackupBytes: number
  blocked: null | 'live' | 'collision' | 'encode-collision' | 'self-referential'
  blockReason?: string
}

export interface MovePreview {
  items: MovePreviewItem[]
  claudeJsonWillAddEntry: boolean
  targetPathAbs: string
}

export interface MoveResult {
  sessionId: string
  status: 'done' | 'failed' | 'skipped'
  moveId?: number
  error?: string
}

export interface FsEntry { name: string; path: string; isDir: boolean; isGitRepo: boolean }
export interface FsListing { path: string; parent: string | null; entries: FsEntry[]; home: string; error?: string }

// 刷新索引时的进度上报(主进程 → 渲染进程)
export interface RefreshProgress { done: number; total: number; path: string }

// 回收区占用:总字节 + 每条移动(以 moveId 为 key)的备份字节
export interface TrashUsage { total: number; byMove: Record<string, number> }

// 数据源(本机 / Windows)在渲染层的展示信息
export interface SourceInfo { id: string; label: string; projectsRoot: string; exists: boolean }

// 归档版本信息(快照/归档),供版本列表与还原 UI 使用
export interface ArchiveVersionInfo {
  versionId: number
  sessionId: string
  kind: 'snapshot' | 'archive'
  sourceCwd: string
  title: string
  jsonlSizeBytes: number
  sidecarBytes: number
  compressedBytes: number
  subagentCount: number
  lineCount: number
  archivedAt: string
}
export interface ArchiveActionResult { sessionId: string; status: 'done' | 'skipped' | 'failed'; versionId?: number; error?: string }
export interface RestoreActionResult { status: 'done' | 'skipped' | 'failed'; restoreId?: number; error?: string }
export interface ArchiveUsage { total: number; backups: number; byVersion: Record<string, number> }

declare global { interface Window { api: import('../preload/index').Api } }
