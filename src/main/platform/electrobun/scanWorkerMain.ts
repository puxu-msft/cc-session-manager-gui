import { parentPort, workerData } from 'node:worker_threads'
import type { ProjectMeta, SessionMeta } from '@shared/types'
import { scanAll } from '../../core/scanner'
import { buildReuse, type SessionRowShape } from '../../db/rowMap'

// Electrobun(Bun)扫描 worker 的执行体。
//
// 背景:electrobun 的 build 只打包单一 bun.entrypoint(src/bun/index.ts),不会自动产出独立
// worker chunk。故采用「self-referential worker」:worker 入口复用同一个已打包的 bun bundle
// (index.js),由 node:worker_threads 的 isMainThread 区分线程角色 —— 主线程装配 app,worker
// 线程调用本函数跑扫描。所有依赖(scanner/rowMap)已在同一 bundle 内,无需额外定位 chunk。
// (Phase 0 验证 Bun 兼容 workerData/postMessage/terminate;Phase 3 验证 Bun 自引用 worker GO。)
//
// 与 Electron 的 src/main/scanWorker.ts 行为等价:进度经 postMessage('progress') 上报,
// 完成发 'done',异常发 'error';中断由主线程 worker.terminate() 实现(无需协作式标志)。
export interface ScanWorkerInput { projectsRoot: string; existingRows: SessionRowShape[] }

export async function runScanWorker(): Promise<void> {
  const { projectsRoot, existingRows } = workerData as ScanWorkerInput
  try {
    const result = await scanAll(projectsRoot, {
      reuse: buildReuse(existingRows),
      onProgress: (done, total, path) => parentPort!.postMessage({ type: 'progress', done, total, path }),
    })
    const projects: ProjectMeta[] = result.projects
    const sessions: SessionMeta[] = result.sessions
    parentPort!.postMessage({ type: 'done', projects, sessions })
  } catch (e) {
    parentPort!.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
