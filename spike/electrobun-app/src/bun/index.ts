// Electrobun 主进程入口(Task 7:起窗 + 加载 React 19 view)
// 真实 API(官方 llms.txt 核查):BrowserWindow from 'electrobun/bun';url 用 views:// schema。
// 注:CLI 无 launch 子命令,起窗用 `electrobun dev` 或直接运行 build 产物的 bin/launcher。
import { BrowserWindow } from 'electrobun/bun'

const mainWindow = new BrowserWindow({
  title: 'Electrobun + React 19 spike',
  url: 'views://mainview/index.html',
  frame: {
    width: 900,
    height: 600,
    x: 100,
    y: 100,
  },
})

void mainWindow
console.log('[main] Electrobun spike app started (Task 7: window + React19)')
// 渲染证据:WSLg 下无截图工具,DOM 回读放到 Task 8(RPC 通道就绪后可靠)。
// Task 7 起窗证据 = WebKitWebProcess/WebKitNetworkProcess 子进程 + GTK 事件循环启动。
