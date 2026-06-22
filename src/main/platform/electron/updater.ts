import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdaterHost } from '../contract'
import type { AppUpdateEvent } from '@shared/types'
import type { ElectronWindowHost } from './window'

// electron-updater 是 CJS 包;在 type:module 的主进程(ESM)下用 default import 再解构,
// 避免具名 import 在 ESM↔CJS 互操作下取不到 autoUpdater。
const { autoUpdater } = electronUpdater

// Electron 应用版本自动更新宿主:把 electron-updater 这个 Electron 专属依赖隔离在本文件。
// 事件转成结构化 AppUpdateEvent,经主窗口 webContents.send('app:update', e) 推送到渲染层
// (autoUpdater 事件由其自身异步发出、无调用方上下文,故不复用绑 event.sender 的 BridgeContext.emit)。
export class ElectronUpdaterHost implements UpdaterHost {
  private wired = false

  constructor(private readonly windowHost: ElectronWindowHost) {}

  private send(e: AppUpdateEvent): void {
    const win = this.windowHost.getMainWindow()
    if (win && !win.webContents.isDestroyed()) win.webContents.send('app:update', e)
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.autoDownload = true
    autoUpdater.on('checking-for-update', () => this.send({ kind: 'checking' }))
    autoUpdater.on('update-available', (info) => this.send({ kind: 'available', version: info?.version }))
    autoUpdater.on('update-not-available', () => this.send({ kind: 'not-available' }))
    autoUpdater.on('download-progress', (p) => this.send({ kind: 'progress', percent: Math.round(p?.percent ?? 0) }))
    autoUpdater.on('update-downloaded', (info) => this.send({ kind: 'downloaded', version: info?.version }))
    autoUpdater.on('error', (err: unknown) => this.send({ kind: 'error', message: err instanceof Error ? err.message : String(err) }))
  }

  checkForUpdates(): void {
    // 仅打包后有意义:dev/未打包缺 app-update.yml,electron-updater 会报错。静默跳过开发态。
    if (!app.isPackaged) return
    this.wire()
    void autoUpdater.checkForUpdates()
  }

  quitAndInstall(): void {
    // 退出当前实例并安装已下载的更新(随后自动重启)。
    autoUpdater.quitAndInstall()
  }
}
