import type { ProjectMeta, SessionMeta } from '@shared/types'
import type { ScanRunner, ScanInput, ScanOutcome } from '../contract'
import { scanAll } from '../../core/scanner'
import { buildReuse, type SessionRowShape } from '../../db/rowMap'

// Electrobun 侧扫描运行器。
//
// 设计取舍(本里程碑):Electron 用 node:worker_threads 在独立线程跑扫描,terminate() 即中断。
// 在 electrobun 下,worker 入口模块需作为独立产物被 Bun.build 打包并在运行时定位 —— 而 electrobun
// 的 build 只声明了 bun.entrypoint 与 views.*,不会自动产出独立 worker chunk。为不引入打包路径
// 的脆弱依赖,这里改为「进程内异步扫描 + 协作式中断」:scanAll 本就是 async 且支持 onProgress,
// 中断在每次 onProgress 时检查 aborted 标志并抛出 ABORT 信号提前结束(对照 worker.terminate())。
//
// 代价:扫描与主进程同线程,长扫描期间 bun 主进程的其它 RPC 会被阻塞在 await 之间的同步段。
// 对本里程碑(验证起窗 + 核心通道)可接受;TODO(Phase 3):改用 node:worker_threads(Phase 0 已验证
// Bun 兼容),worker 入口随 electrobun 打包产物定位(参考 import.meta.url + Bun 资源寻址)。
const ABORT = Symbol('scan-abort')

export class ElectrobunScanRunner implements ScanRunner {
  private aborted = false

  terminate(): void {
    this.aborted = true
  }

  async run(
    input: ScanInput,
    onProgress: (done: number, total: number, path: string) => void,
  ): Promise<ScanOutcome> {
    this.aborted = false
    const reuse = buildReuse(input.existingRows as SessionRowShape[])
    try {
      const result = await scanAll(input.projectsRoot, {
        reuse,
        onProgress: (done, total, path) => {
          if (this.aborted) throw ABORT
          onProgress(done, total, path)
        },
      })
      const projects: ProjectMeta[] = result.projects
      const sessions: SessionMeta[] = result.sessions
      return { projects, sessions, aborted: false }
    } catch (e) {
      if (e === ABORT) return { projects: [], sessions: [], aborted: true }
      throw e
    }
  }
}
