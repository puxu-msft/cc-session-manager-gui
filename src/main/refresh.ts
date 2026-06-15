import type { Db } from './db/db'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { diffSessions, type IndexDiff } from './core/scanner'

export interface ScanResult { projects: ProjectMeta[]; sessions: SessionMeta[] }
export interface ExistingRow { session_id: string; size_bytes: number; mtime: number }

// 刷新的落库逻辑:给定一次扫描结果与索引现有行,计算 diff 并在事务内 upsert 项目/会话、删除已消失的会话。
// 抽成纯函数(不依赖 Electron/IPC),供 ipc 的 refresh:run 与集成测试共用,避免测试与生产代码走样。
export function applyScanToIndex(db: Db, scan: ScanResult, existing: ExistingRow[]): IndexDiff {
  const diff = diffSessions(scan.sessions, existing)
  db.transaction(() => {
    for (const p of scan.projects) db.upsertProject(p)
    for (const s of scan.sessions) db.upsertSession({ ...s, movedFlag: false, lastMoveId: null })
    for (const id of diff.removed) db.deleteSession(id)
  })
  return diff
}
