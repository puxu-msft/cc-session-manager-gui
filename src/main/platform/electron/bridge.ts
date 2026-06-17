import { ipcMain } from 'electron'
import type { BridgeServer, BridgeContext } from '../contract'

// Electron 桥接:ipcMain.handle 接线;ctx.emit 经发起调用的 webContents.sender 单向回推(绑定本次调用方)。
export class ElectronBridge implements BridgeServer {
  handle(channel: string, handler: (ctx: BridgeContext, ...args: any[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      const ctx: BridgeContext = {
        emit: (ch, payload) => { if (!event.sender.isDestroyed()) event.sender.send(ch, payload) },
      }
      return handler(ctx, ...args)
    })
  }
}
