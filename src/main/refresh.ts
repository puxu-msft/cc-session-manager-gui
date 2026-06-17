import type { Db } from './db/db'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { diffSessions, type IndexDiff } from './core/scanner'

export interface ScanResult { projects: ProjectMeta[]; sessions: SessionMeta[] }
export interface ExistingRow { session_id: string; size_bytes: number; mtime: number }

// 刷新的落库逻辑:给定一次扫描结果与索引现有行,计算 diff 并在事务内 upsert 项目/会话、删除已消失的会话。
// 抽成纯函数(不依赖 Electron/IPC),供 ipc 的 refresh:run 与集成测试共用,避免测试与生产代码走样。
export function applyScanToIndex(db: Db, scan: ScanResult, existing: ExistingRow[]): IndexDiff {
  const diff = diffSessions(scan.sessions, existing)
  const movedIds = db.getMovedSessionIds()
  db.transaction(() => {
    for (const p of scan.projects) db.upsertProject(p)
    for (const s of scan.sessions) db.upsertSession({ ...s, movedFlag: movedIds.has(s.sessionId), lastMoveId: null })
    for (const id of diff.removed) db.deleteSession(id)
  })
  return diff
}

// 单项目落库:只 upsert 该项目与其会话,并删除该项目下已消失的会话(不触碰其它项目)。
// 供 ipc 的 refresh:project 与集成测试共用。
export function applyProjectScan(db: Db, projectPathAbs: string, scan: { project: ProjectMeta | null; sessions: SessionMeta[] }): IndexDiff {
  const existing = (db.getSessions(projectPathAbs) as { session_id: string; size_bytes: number; mtime: number }[])
    .map((r) => ({ session_id: r.session_id, size_bytes: r.size_bytes, mtime: r.mtime }))
  const diff = diffSessions(scan.sessions, existing)
  const movedIds = db.getMovedSessionIds()
  db.transaction(() => {
    if (scan.project) db.upsertProject(scan.project)
    for (const s of scan.sessions) db.upsertSession({ ...s, movedFlag: movedIds.has(s.sessionId), lastMoveId: null })
    for (const id of diff.removed) db.deleteSession(id)
  })
  return diff
}
