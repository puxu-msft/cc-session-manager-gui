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

// 主→渲染单向推送通道(绑定本次调用方);对应 spec §8 的 emitProgress。
export interface BridgeContext {
  emit(channel: string, payload: unknown): void
}

// IPC 桥接服务端。Electron=ipcMain.handle + sender.send;Electrobun=RPC defineRPC。
// handler 签名 (ctx, ...args):ctx.emit 用于进度等单向推送,args 为渲染层调用参数。
export interface BridgeServer {
  handle(channel: string, handler: (ctx: BridgeContext, ...args: any[]) => unknown): void
}

// 应用生命周期宿主。Electron=app;Electrobun 提供等价实现。darwin 关窗语义由调用方(bootstrap)判定。
export interface AppHost {
  setName(name: string): void
  whenReady(): Promise<void>
  onWindowAllClosed(cb: () => void): void
  onBeforeQuit(cb: () => void): void
  quit(): void
}

// 主窗口宿主。Electron=BrowserWindow + preload;Electrobun=BrowserWindow/BrowserView + views://。
export interface WindowHost {
  createMainWindow(): void
}

// 一套运行时平台实现的集合,交给 bootstrap 装配。
export interface Platform {
  appHost: AppHost
  windowHost: WindowHost
  bridge: BridgeServer
  paths: Paths
}
