import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { WindowHost } from '../contract'

// Electron 主窗口宿主:创建 BrowserWindow,注入 preload(.cjs),加载渲染层(dev 用 URL,打包用文件)。
export class ElectronWindowHost implements WindowHost {
  createMainWindow(): void {
    const win = new BrowserWindow({
      width: 1400,
      height: 900,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: false,
      },
    })
    if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
