import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Paths } from '../contract'

const APP_NAME = 'cc-session-manager-gui'

// Electrobun 侧 userData 解析:逐平台复刻 Electron app.getPath('userData') 的物理路径(spec §7 硬约束),
// 使两运行时落在同一目录、共享同一套 index-<id>.db。Phase 0 probe-paths.ts 已实测对齐(Linux=~/.config/cc-session-manager-gui)。
function electrobunUserData(name: string): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name)
}

export const electrobunPaths: Paths = {
  userData: () => electrobunUserData(APP_NAME),
}
