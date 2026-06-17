import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '@shared/types'
import type { ScanRunner, ScanInput, ScanOutcome } from '../contract'

// Electron 侧扫描运行器:在独立线程(worker_threads)跑全量扫描,terminate() 即为中断。
// 进度经 onProgress 回调上报,不直接触碰 IPC sender —— 由 ipc 层把回调接到 event.sender.send。
export class ElectronScanRunner implements ScanRunner {
  private currentWorker: Worker | null = null

  terminate(): void {
    this.currentWorker?.terminate()
    this.currentWorker = null
  }

  run(input: ScanInput, onProgress: (done: number, total: number, path: string) => void): Promise<ScanOutcome> {
    this.currentWorker?.terminate()
    return new Promise<ScanOutcome>((resolve, reject) => {
      let settled = false
      const w = new Worker(join(__dirname, 'scanWorker.js'), { workerData: { projectsRoot: input.projectsRoot, existingRows: input.existingRows } })
      this.currentWorker = w
      w.on('message', (m: { type: string; done?: number; total?: number; path?: string; projects?: ProjectMeta[]; sessions?: SessionMeta[]; message?: string }) => {
        if (m.type === 'progress') {
          onProgress(m.done ?? 0, m.total ?? 0, m.path ?? '')
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
        if (this.currentWorker === w) this.currentWorker = null
        // 未收到 done/error 就退出 = 被 terminate 中断
        if (!settled) { settled = true; resolve({ projects: [], sessions: [], aborted: true }) }
      })
    })
  }
}
