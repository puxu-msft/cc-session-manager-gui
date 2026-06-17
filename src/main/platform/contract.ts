import type { ProjectMeta, SessionMeta } from '@shared/types'

// 运行时抽象契约。Electron 与(将来的)Electrobun 各自提供实现,核心装配只依赖这些接口。

// 用户数据目录解析。Electron=app.getPath('userData');Electrobun 自拼并逐平台复刻同一物理路径(spec §7 硬约束)。
export interface Paths {
  userData(): string
}

export interface ScanOutcome { projects: ProjectMeta[]; sessions: SessionMeta[]; aborted: boolean }
export interface ScanInput { projectsRoot: string; existingRows: unknown[] }

// 后台全量扫描运行器。Electron 用 node:worker_threads;Electrobun 将提供 Bun 实现。
// 进度经 onProgress 回调上报(与具体 IPC/bridge 解耦),由调用方接到各自的「主→渲染」通道,
// 对应 spec §8 的 emitProgress 模式:进度是与本次调用绑定的回调,而非全局事件。
export interface ScanRunner {
  run(input: ScanInput, onProgress: (done: number, total: number, path: string) => void): Promise<ScanOutcome>
  terminate(): void
}
