// Electrobun 主进程(Task 8:RPC 双向通信)
// 真实 API(源码核查 node_modules/electrobun/dist/api/bun):
//   defineRPC 是 BrowserView 的静态方法(BrowserWindow 上无此静态方法 —— 实测修正);
//   BrowserWindow 接受 rpc option;主→渲染推送用 win.webview.rpc.send.<name>(...)
import { BrowserWindow, BrowserView } from 'electrobun/bun'
import type { SpikeRPC } from '../shared/rpc-schema'

// 请求-响应 handler(等价 ipcMain.handle):回显并加工结构化 payload。
// 单向消息 handler(view→bun 通知):打印到主进程终端,作为可自动观测信号。
const rpc = BrowserView.defineRPC<SpikeRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      echo: ({ text }) => ({ reply: `pong:${text}`, ts: Date.now() }),
    },
    messages: {
      logFromView: ({ msg, echoReply }) => {
        console.log('[main] got message:', msg)
        // echoReply 存在即证明 view→bun 请求-响应链路打通(view 已拿到 echo 结构化响应)
        if (echoReply) console.log('[main] view received echo response:', echoReply)
      },
    },
  },
})

const win = new BrowserWindow<SpikeRPC>({
  title: 'spike-rpc',
  url: 'views://mainview/index.html',
  frame: { width: 900, height: 600, x: 100, y: 100 },
  rpc,
})

console.log('[main] spike-rpc app started (Task 8: bidirectional RPC)')

// 主→渲染 单向推送(等价 refresh:progress emitProgress):延迟后发一条 tick。
setTimeout(() => {
  win.webview?.rpc?.send.tick({ at: Date.now() })
  console.log('[main] sent tick to view')
}, 1500)
