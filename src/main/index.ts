import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpc, abortCurrentScan } from './ipc'
import { closeDb } from './appState'

function createWindow() {
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

app.whenReady().then(() => { registerIpc(); createWindow() })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
// 退出前优雅关停:中断进行中的扫描(否则长扫描会拖住退出)并关闭 DB 连接。
app.on('before-quit', () => {
  abortCurrentScan()
  closeDb()
})
