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

declare global { interface Window { api: import('../preload/index').Api } }
