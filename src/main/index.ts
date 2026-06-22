import { bootstrap } from './app/bootstrap'
import { ElectronAppHost } from './platform/electron/app'
import { ElectronWindowHost } from './platform/electron/window'
import { ElectronBridge } from './platform/electron/bridge'
import { ElectronUpdaterHost } from './platform/electron/updater'
import { electronPaths } from './platform/electron/paths'
import { openDb } from './db/db'

// Electron 入口:装配 Electron 平台实现并启动。
// (Electrobun 入口将以同样方式装配其各自实现,共享 bootstrap 与全部核心逻辑。)
const windowHost = new ElectronWindowHost()
bootstrap({
  appHost: new ElectronAppHost(),
  windowHost,
  bridge: new ElectronBridge(),
  paths: electronPaths,
  dbFactory: openDb,
  // electron-updater 自动更新(Electron 专属);需主窗口引用以推送 'app:update' 事件。
  updater: new ElectronUpdaterHost(windowHost),
})
