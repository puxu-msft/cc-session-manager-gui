import { BrowserWindow } from 'electrobun/bun'
import type { WindowHost } from '../contract'
import type { ElectrobunBridge } from './bridge'
import type { ProdRPC } from './rpcSchema'

// Electrobun 主窗口宿主:创建 BrowserWindow,装上 bridge 构建的 RPC,加载打包后的生产渲染层。
//
// 渲染层经 electrobun.config.ts 的 views.mainview 打包为 views://mainview/index.html
// (HTML 引用编译产物 index.js,内部由 Electrobun 的 Bun.build 打包 src/renderer/main.electrobun.tsx)。
// 创建后调用 bridge.attachWindow(win),使 ctx.emit 能经 win.webview.rpc.send 单向推送进度。
export class ElectrobunWindowHost implements WindowHost {
  constructor(private bridge: ElectrobunBridge) {}

  createMainWindow(): void {
    const rpc = this.bridge.buildRPC()
    const win = new BrowserWindow<ProdRPC>({
      title: 'cc-session-manager-gui',
      url: 'views://mainview/index.html',
      frame: { width: 1400, height: 900, x: 80, y: 60 },
      rpc,
    })
    this.bridge.attachWindow(win)
  }
}
