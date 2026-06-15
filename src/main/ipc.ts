import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { getEnv, listSources, getActiveSourceId, setActiveSourceId } from './appState'
import { applyScanToIndex } from './refresh'
import { listDir } from './core/fsBrowser'
import { trashUsage, purgeMove, purgeAllTrash } from './trash'
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
  reconcile(getEnv() as any) // 启动时收尾当前活动源的 pending 移动

  ipcMain.handle('sources:list', () => listSources().map((s) => ({ id: s.id, label: s.label, projectsRoot: s.projectsRoot, exists: s.exists })))
  ipcMain.handle('source:get', () => getActiveSourceId())
  ipcMain.handle('source:set', (_e, id: string) => {
    abortCurrentScan()
    const active = setActiveSourceId(id)
    const env = getEnv()
    reconcile(env as any)
    return { active, projects: env.db.getProjects() }
  })

  ipcMain.handle('index:get', () => ({ projects: getEnv().db.getProjects() }))
  ipcMain.handle('sessions:get', (_e, projectPathAbs: string) => getEnv().db.getSessions(projectPathAbs))

  ipcMain.handle('refresh:run', async (event: IpcMainInvokeEvent) => {
    const env = getEnv()
    const existing = env.db.raw.prepare('SELECT * FROM sessions').all() as any[]
    const { projects, sessions, aborted } = await runScanWorker(env.projectsRoot, existing, event)
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
  ipcMain.handle('move:preview', (_e, ids: string[], target: string) => previewMove(ids, target, getEnv() as any))
  ipcMain.handle('move:execute', (_e, ids: string[], target: string) => executeMove(ids, target, getEnv() as any))
  ipcMain.handle('moves:list', () => getEnv().db.getMoves())
  ipcMain.handle('move:undo', (_e, moveId: number) => { const env = getEnv(); undoMove(moveId, env as any); return env.db.getMoves() })
  ipcMain.handle('trash:usage', () => trashUsage(getEnv().trashRoot))
  ipcMain.handle('trash:purge', (_e, moveId?: number) => {
    const env = getEnv()
    if (moveId == null) purgeAllTrash(env.trashRoot); else purgeMove(env.trashRoot, moveId)
    return { moves: env.db.getMoves(), usage: trashUsage(env.trashRoot) }
  })
}

