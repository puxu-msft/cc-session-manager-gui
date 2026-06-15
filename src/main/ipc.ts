import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { getEnv } from './appState'
import { scanAll, diffSessions } from './core/scanner'
import { rowToSessionMeta } from './db/db'
import { listDir } from './core/fsBrowser'
import { previewMove, executeMove, reconcile, undoMove } from './core/mover'

// 进行中的扫描控制器:刷新可被新刷新抢占,退出时也会被中断,确保主进程不被长扫描卡住、退出不被阻塞。
let currentScan: AbortController | null = null
export function abortCurrentScan(): void {
  currentScan?.abort()
  currentScan = null
}

export function registerIpc(): void {
  const env = getEnv()
  reconcile(env as any)

  ipcMain.handle('index:get', () => ({ projects: env.db.getProjects() }))
  ipcMain.handle('sessions:get', (_e, projectPathAbs: string) => env.db.getSessions(projectPathAbs))

  ipcMain.handle('refresh:run', async (event: IpcMainInvokeEvent) => {
    currentScan?.abort()
    const ac = new AbortController()
    currentScan = ac
    const existing = env.db.raw.prepare('SELECT * FROM sessions').all() as any[]
    const byId = new Map(existing.map((r) => [r.session_id, r]))
    try {
      const { projects, sessions } = await scanAll(env.projectsRoot, {
        signal: ac.signal,
        // 未变文件(size+mtime 一致)直接复用 DB 里的元数据,跳过昂贵的逐行解析 → 二次刷新近乎瞬时。
        reuse: (id, size, mtime) => {
          const r = byId.get(id)
          return r && r.size_bytes === size && r.mtime === mtime ? rowToSessionMeta(r) : null
        },
        // 进度上报给渲染进程,避免长扫描时 UI 看起来卡死。
        onProgress: (done, total, path) => {
          if (!event.sender.isDestroyed()) event.sender.send('refresh:progress', { done, total, path })
        },
      })
      const diff = diffSessions(sessions, existing.map((r) => ({ session_id: r.session_id, size_bytes: r.size_bytes, mtime: r.mtime })))
      env.db.transaction(() => {
        for (const p of projects) env.db.upsertProject(p)
        for (const s of sessions) env.db.upsertSession({ ...s, movedFlag: false, lastMoveId: null })
        for (const id of diff.removed) env.db.deleteSession(id)
      })
      return { projects: env.db.getProjects(), diff, aborted: false }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return { projects: env.db.getProjects(), diff: { added: [], removed: [], changed: [] }, aborted: true }
      }
      throw e
    } finally {
      if (currentScan === ac) currentScan = null
    }
  })

  ipcMain.handle('fs:list', (_e, path: string) => listDir(path || homedir()))
  ipcMain.handle('move:preview', (_e, ids: string[], target: string) => previewMove(ids, target, env as any))
  ipcMain.handle('move:execute', (_e, ids: string[], target: string) => executeMove(ids, target, env as any))
  ipcMain.handle('moves:list', () => env.db.getMoves())
  ipcMain.handle('move:undo', (_e, moveId: number) => { undoMove(moveId, env as any); return env.db.getMoves() })
}
