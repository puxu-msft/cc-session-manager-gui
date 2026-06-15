import { ipcMain } from 'electron'
import { homedir } from 'node:os'
import { getEnv } from './appState'
import { scanAll, diffSessions } from './core/scanner'
import { listDir } from './core/fsBrowser'
import { previewMove, executeMove, reconcile, undoMove } from './core/mover'

export function registerIpc() {
  const env = getEnv()
  reconcile(env as any)

  ipcMain.handle('index:get', () => ({ projects: env.db.getProjects() }))
  ipcMain.handle('sessions:get', (_e, projectPathAbs: string) => env.db.getSessions(projectPathAbs))
  ipcMain.handle('refresh:run', async () => {
    const { projects, sessions } = await scanAll(env.projectsRoot)
    const existing = env.db.raw.prepare('SELECT session_id,size_bytes,mtime FROM sessions').all() as any[]
    const diff = diffSessions(sessions, existing)
    env.db.transaction(() => {
      for (const p of projects) env.db.upsertProject(p)
      for (const s of sessions) env.db.upsertSession({ ...s, movedFlag: false, lastMoveId: null })
      for (const id of diff.removed) env.db.deleteSession(id)
    })
    return { projects: env.db.getProjects(), diff }
  })
  ipcMain.handle('fs:list', (_e, path: string) => listDir(path || homedir()))
  ipcMain.handle('move:preview', (_e, ids: string[], target: string) => previewMove(ids, target, env as any))
  ipcMain.handle('move:execute', (_e, ids: string[], target: string) => executeMove(ids, target, env as any))
  ipcMain.handle('moves:list', () => env.db.getMoves())
  ipcMain.handle('move:undo', (_e, moveId: number) => { undoMove(moveId, env as any); return env.db.getMoves() })
}
