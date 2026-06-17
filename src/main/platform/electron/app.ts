import { app } from 'electron'
import type { AppHost } from '../contract'

// Electron 应用生命周期宿主。
export class ElectronAppHost implements AppHost {
  setName(name: string): void { app.setName(name) }
  whenReady(): Promise<void> { return app.whenReady().then(() => undefined) }
  onWindowAllClosed(cb: () => void): void { app.on('window-all-closed', cb) }
  onBeforeQuit(cb: () => void): void { app.on('before-quit', cb) }
  quit(): void { app.quit() }
}
