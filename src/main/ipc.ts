import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { getEnv } from './appState'
import { diffSessions } from './core/scanner'
import { listDir } from './core/fsBrowser'
import { previewMove, executeMove, reconcile, undoMove } from './core/mover'

// 进行中的扫描 worker:刷新可被新刷新抢占,退出时也会被终止,确保主进程不被长扫描卡住、退出不被阻塞。
let currentWorker: Worker | null = null
export function abortCurrentScan(): void {
  currentWorker?.terminate()
  currentWorker = null
}

interface ScanOutcome { projects: ProjectMeta[]; sessions: SessionMeta[]; aborted: boolean }

// 在独立线程跑全量扫描;通过 worker 消息转发进度,terminate() 即为中断。
function runScanWorker(projectsRoot: string, existingRows: unknown[], event: IpcMainInvokeEvent): Promise<ScanOutcome> {
  currentWorker?.terminate()
  return new Promise<ScanOutcome>((resolve, reject) => {
    let settled = false
    const w = new Worker(join(__dirname, 'scanWorker.js'), { workerData: { projectsRoot, existingRows } })
    currentWorker = w
    w.on('message', (m: { type: string; done?: number; total?: number; path?: string; projects?: ProjectMeta[]; sessions?: SessionMeta[]; message?: string }) => {
      if (m.type === 'progress') {
        if (!event.sender.isDestroyed()) event.sender.send('refresh:progress', { done: m.done, total: m.total, path: m.path })
      } else if (m.type === 'done') {
        settled = true
        resolve({ projects: m.projects ?? [], sessions: m.sessions ?? [], aborted: false })
      } else if (m.type === 'error') {
        settled = true
        reject(new Error(m.message ?? '扫描失败'))
      }
    })
    w.on('error', (e) => { settled = true; reject(e) })
    w.on('exit', () => {
      if (currentWorker === w) currentWorker = null
      // 未收到 done/error 就退出 = 被 terminate 中断
      if (!settled) { settled = true; resolve({ projects: [], sessions: [], aborted: true }) }
    })
  })
}

export function registerIpc(): void {
  const env = getEnv()
  reconcile(env as any)

  ipcMain.handle('index:get', () => ({ projects: env.db.getProjects() }))
  ipcMain.handle('sessions:get', (_e, projectPathAbs: string) => env.db.getSessions(projectPathAbs))

  ipcMain.handle('refresh:run', async (event: IpcMainInvokeEvent) => {
    const existing = env.db.raw.prepare('SELECT * FROM sessions').all() as any[]
    const { projects, sessions, aborted } = await runScanWorker(env.projectsRoot, existing, event)
    if (aborted) {
      return { projects: env.db.getProjects(), diff: { added: [], removed: [], changed: [] }, aborted: true }
    }
    const diff = diffSessions(sessions, existing.map((r) => ({ session_id: r.session_id, size_bytes: r.size_bytes, mtime: r.mtime })))
    env.db.transaction(() => {
      for (const p of projects) env.db.upsertProject(p)
      for (const s of sessions) env.db.upsertSession({ ...s, movedFlag: false, lastMoveId: null })
      for (const id of diff.removed) env.db.deleteSession(id)
    })
    return { projects: env.db.getProjects(), diff, aborted: false }
  })

  ipcMain.handle('fs:list', (_e, path: string) => listDir(path || homedir()))
  ipcMain.handle('move:preview', (_e, ids: string[], target: string) => previewMove(ids, target, env as any))
  ipcMain.handle('move:execute', (_e, ids: string[], target: string) => executeMove(ids, target, env as any))
  ipcMain.handle('moves:list', () => env.db.getMoves())
  ipcMain.handle('move:undo', (_e, moveId: number) => { undoMove(moveId, env as any); return env.db.getMoves() })
}

