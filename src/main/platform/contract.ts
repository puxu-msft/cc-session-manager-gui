import type { ProjectMeta, SessionMeta } from '@shared/types'
import type { Db } from '../db/repository'
import type { CwdHostMap } from '../core/pathCodec'

// 运行时抽象契约。Electron 与(将来的)Electrobun 各自提供实现,核心装配只依赖这些接口。

// 用户数据目录解析。Electron=app.getPath('userData');Electrobun 自拼并逐平台复刻同一物理路径(spec §7 硬约束)。
export interface Paths {
  userData(): string
}

export interface ScanOutcome { projects: ProjectMeta[]; sessions: SessionMeta[]; aborted: boolean }
// cwdHostMap:把会话 cwd 映射到宿主可访问路径的描述符(异 namespace 源用,见 pathCodec.hostPathForCwd);
// 否则 existsSync 会对异 namespace 路径(Windows host 上的 /home/…、WSL 内的 C:\…)恒判不存在。
export interface ScanInput { projectsRoot: string; existingRows: unknown[]; cwdHostMap?: CwdHostMap }

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

// 应用版本自动更新宿主(Electron=electron-updater;Electrobun 不接,自带 bsdiff 机制)。
// 隔离 electron-updater 这个 Electron 专属依赖。事件经各自「主→渲染」通道推送:Electron 实现直接
// webContents.send('app:update', e)——因 autoUpdater 事件无调用方上下文,不能复用绑 event.sender 的
// BridgeContext.emit。Electrobun 入口不传此端口(Platform.updater 缺省即「无 Electron 更新」)。
export interface UpdaterHost {
  checkForUpdates(): void
  quitAndInstall(): void
}

// 一套运行时平台实现的集合,交给 bootstrap 装配。
export interface Platform {
  appHost: AppHost
  windowHost: WindowHost
  bridge: BridgeServer
  paths: Paths
  dbFactory: (file: string) => Db
  // 后台扫描运行器。可选:Electron 不传,ipc 层回退默认的 worker_threads 实现(行为不变);
  // Electrobun 传入基于独立预构建 worker bundle 的 worker_threads 实现(electrobun 打包不产独立 worker
  // chunk,故 worker 入口预构建成不含 electrobun 的 bundle 单独加载,避免框架顶层副作用抢占端口)。
  scanRunner?: ScanRunner
  // 应用版本自动更新宿主。可选:仅 Electron 传入(electron-updater);Electrobun 不传(自带 bsdiff)。
  updater?: UpdaterHost
}

// 预编译语句的最小抽象:run/get/all 同时支持命名参数对象(run({a:1}))与位置参数(run(1,2))两种调用风格。
export interface PreparedStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

// 运行时无关的 SQLite 驱动接口。db repository 仅依赖它;Electron=better-sqlite3,Electrobun=bun:sqlite。
export interface SqliteDriver {
  prepare(sql: string): PreparedStatement
  exec(sql: string): void
  pragma(source: string): void
  transaction<T>(fn: () => T): () => T
  close(): void
}
