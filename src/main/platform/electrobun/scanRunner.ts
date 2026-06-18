import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '@shared/types'
import type { ScanRunner, ScanInput, ScanOutcome } from '../contract'

// Electrobun 侧扫描运行器:用 node:worker_threads 在独立线程跑全量扫描(对照 Electron 同名实现),
// terminate() 即为中断,长扫描不再阻塞 bun 主进程的其它 RPC。
//
// worker 入口定位:electrobun build 不产独立 worker chunk,故由 scripts/build-electrobun-worker.mjs
// 用 Bun.build 预构建一个**不含 electrobun**的自包含 scanWorker.js(避免 worker 线程连带起
// electrobun 的 RPC server 与主进程 50000 端口冲突),经 electrobun.config.ts 的 build.copy 拷到
// Resources/app/bun/scanWorker.js —— 即与本运行器打包后的 bun/index.js 同目录。运行时 import.meta.dir
// 指向 bun/ 目录,join 即得 worker 入口绝对路径。
//
// 进度经 onProgress 回调上报(与 IPC/bridge 解耦),由 ipc 层接到「主→渲染」进度通道。
const WORKER_ENTRY = join(import.meta.dir, 'scanWorker.js')

export class ElectrobunScanRunner implements ScanRunner {
  private currentWorker: Worker | null = null

  terminate(): void {
    this.currentWorker?.terminate()
    this.currentWorker = null
  }

  run(input: ScanInput, onProgress: (done: number, total: number, path: string) => void): Promise<ScanOutcome> {
    this.currentWorker?.terminate()
    return new Promise<ScanOutcome>((resolve, reject) => {
      let settled = false
      const w = new Worker(WORKER_ENTRY, {
        workerData: { projectsRoot: input.projectsRoot, existingRows: input.existingRows },
      })
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
