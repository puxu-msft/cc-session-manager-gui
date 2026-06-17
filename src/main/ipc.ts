import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ProjectMeta } from '@shared/types'
import { ElectronScanRunner } from './platform/electron/scanRunner'
import { getEnv, listSources, getActiveSourceId, setActiveSourceId } from './appState'
import { applyScanToIndex } from './refresh'
import { listDir } from './core/fsBrowser'
import { trashUsage, purgeMove, purgeAllTrash } from './trash'
import { previewMove, executeMove, reconcile, undoMove } from './core/mover'
import { planReconcile, planForce, executeReconcile, undoRewrite } from './core/historyReconciler'
import { snapshotSession, archiveSession, restoreVersion, undoRestore, deleteVersion, listVersions, archiveUsage, archiverReconcile } from './core/archiver'

// 后台扫描运行器(Electron=worker_threads)。刷新可被新刷新抢占,退出/切源时被 terminate 中断。
const scanRunner = new ElectronScanRunner()
export function abortCurrentScan(): void {
  scanRunner.terminate()
}

export function registerIpc(): void {
  reconcile(getEnv()) // 启动时收尾当前活动源的 pending 移动
  archiverReconcile(getEnv()) // 启动时收尾当前活动源的 pending 归档/还原

  ipcMain.handle('sources:list', () => listSources().map((s) => ({ id: s.id, label: s.label, projectsRoot: s.projectsRoot, exists: s.exists })))
  ipcMain.handle('source:get', () => getActiveSourceId())
  ipcMain.handle('source:set', (_e, id: string) => {
    abortCurrentScan()
    const active = setActiveSourceId(id)
    const env = getEnv()
    reconcile(env)
    archiverReconcile(env) // 切源后收尾新活动源的 pending 归档/还原
    return { active, projects: env.db.getProjects() }
  })

  ipcMain.handle('index:get', () => ({ projects: getEnv().db.getProjects() }))
  ipcMain.handle('sessions:get', (_e, projectPathAbs: string) => getEnv().db.getSessions(projectPathAbs))

  ipcMain.handle('refresh:run', async (event: IpcMainInvokeEvent) => {
    const env = getEnv()
    const existing = env.db.getAllSessionRows()
    const { projects, sessions, aborted } = await scanRunner.run(
      { projectsRoot: env.projectsRoot, existingRows: existing },
      (done, total, path) => { if (!event.sender.isDestroyed()) event.sender.send('refresh:progress', { done, total, path }) },
    )
    if (aborted) {
      // 退出/切源时会先中断,在飞刷新走到这里读库可能抛 use-after-close,容错返回空。
      let current: ProjectMeta[] = []
      try { current = env.db.getProjects() } catch { /* DB 可能已关闭 */ }
      return { projects: current, diff: { added: [], removed: [], changed: [] }, aborted: true }
    }
    const diff = applyScanToIndex(env.db, { projects, sessions }, existing.map((r) => ({ session_id: r.session_id, size_bytes: r.size_bytes, mtime: r.mtime })))
    return { projects: env.db.getProjects(), diff, aborted: false }
  })

  ipcMain.handle('fs:list', (_e, path: string) => listDir(path || homedir()))
  ipcMain.handle('fs:mkdir', (_e, parent: string, name: string) => {
    const p = join(parent, name)
    mkdirSync(p, { recursive: true })
    return listDir(p)
  })
  ipcMain.handle('move:preview', (_e, ids: string[], target: string) => previewMove(ids, target, getEnv()))
  ipcMain.handle('move:execute', (_e, ids: string[], target: string) => executeMove(ids, target, getEnv()))
  ipcMain.handle('moves:list', () => getEnv().db.getMoves())
  ipcMain.handle('move:undo', (_e, moveId: number) => { const env = getEnv(); undoMove(moveId, env); return env.db.getMoves() })
  ipcMain.handle('trash:usage', () => trashUsage(getEnv().trashRoot))
  ipcMain.handle('trash:purge', (_e, moveId?: number) => {
    const env = getEnv()
    if (moveId == null) purgeAllTrash(env.trashRoot); else purgeMove(env.trashRoot, moveId)
    return { moves: env.db.getMoves(), usage: trashUsage(env.trashRoot) }
  })

  ipcMain.handle('history:plan', () => planReconcile(getEnv()))
  ipcMain.handle('history:reconcile', (_e, mode: 'auto' | 'force', sessionIds?: string[], target?: string) => {
    const env = getEnv()
    const plan = mode === 'force' ? planForce(env, sessionIds ?? [], target ?? '') : planReconcile(env)
    const result = executeReconcile(env, plan, mode)
    return { result, rewrites: env.db.getHistoryRewrites() }
  })
  ipcMain.handle('history:listRewrites', () => getEnv().db.getHistoryRewrites())
  ipcMain.handle('history:undoRewrite', (_e, id: number) => { const env = getEnv(); undoRewrite(env, id); return env.db.getHistoryRewrites() })

  ipcMain.handle('archive:snapshot', async (_e, sessionIds: string[]) => {
    const env = getEnv(); const out = []
    for (const id of sessionIds) out.push(await snapshotSession(id, env))
    return out
  })
  ipcMain.handle('archive:archive', async (_e, sessionIds: string[]) => {
    const env = getEnv(); const out = []
    for (const id of sessionIds) out.push(await archiveSession(id, env))
    return out
  })
  ipcMain.handle('archive:listVersions', (_e, sessionId: string) => listVersions(sessionId, getEnv()))
  ipcMain.handle('archive:allVersions', () => getEnv().db.getAllArchiveVersions())
  ipcMain.handle('archive:restore', (_e, versionId: number) => restoreVersion(versionId, getEnv()))
  ipcMain.handle('archive:undoRestore', (_e, restoreId: number) => { undoRestore(restoreId, getEnv()); return true })
  ipcMain.handle('archive:deleteVersion', (_e, versionId: number) => { deleteVersion(versionId, getEnv()); return true })
  ipcMain.handle('archive:usage', () => archiveUsage(getEnv()))
}

