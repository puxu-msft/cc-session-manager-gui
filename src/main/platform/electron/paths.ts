import { app } from 'electron'
import type { Paths } from '../contract'

// Electron 用户数据路径:app.getPath('userData')(Linux 下为 ~/.config/<appName>)。
export const electronPaths: Paths = {
  userData: () => app.getPath('userData'),
}
