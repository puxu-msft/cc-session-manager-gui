import { registerIpc, abortCurrentScan } from '../ipc'
import { setPaths, closeDb } from '../appState'
import type { Platform } from '../platform/contract'

const APP_NAME = 'cc-move-session'

// 运行时无关的应用装配:设应用名 → whenReady 后注入 Paths、注册 IPC、创建窗口 → 注册退出收尾。
// Electron 与 Electrobun 各自提供 Platform 实现,这段装配只写一次。
export function bootstrap(platform: Platform): void {
  // setName 必须在首次访问 userData 之前(确保落在 ~/.config/cc-move-session 而非回退名)。
  platform.appHost.setName(APP_NAME)
  void platform.appHost.whenReady().then(() => {
    setPaths(platform.paths)
    registerIpc(platform.bridge)
    platform.windowHost.createMainWindow()
  })
  platform.appHost.onWindowAllClosed(() => {
    if (process.platform !== 'darwin') platform.appHost.quit()
  })
  // 退出前优雅关停:中断进行中的扫描(否则长扫描会拖住退出)并关闭 DB 连接。
  platform.appHost.onBeforeQuit(() => {
    abortCurrentScan()
    closeDb()
  })
}
