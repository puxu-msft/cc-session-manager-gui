// 运行:bun run spike/probe-paths.ts(在项目根)
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'cc-session-manager-gui'

// Electrobun 侧将采用的 userData 解析(逐平台复刻 Electron app.getPath('userData') 规则,spec §7 Paths 硬约束)
function electrobunUserData(name: string): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name)
}

const resolved = electrobunUserData(APP_NAME)
console.log('platform        =', process.platform)
console.log('electrobun userData =', resolved)
console.log('对照 Electron(Linux)预期 = ~/.config/cc-session-manager-gui(见 Step 2 实测)')
