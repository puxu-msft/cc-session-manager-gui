import { BrowserView } from 'electrobun/bun'
import type { BridgeServer, BridgeContext } from '../contract'
import type { ProdRPC } from './rpcSchema'

type Handler = (ctx: BridgeContext, ...args: any[]) => unknown

// Electrobun 桥接:BridgeServer 的 RPC 实现。
//
// 流程:
//   1. registerIpc(bridge) 期间,每个 bridge.handle(channel, handler) 把 handler 收进 map。
//   2. buildRPC() 把 map 转成 BrowserView.defineRPC 的 handlers.requests:
//      每个 request handler 接收统一信封 { args },构造 ctx(ctx.emit 经持有的 win 引用
//      win.webview.rpc.send.<channel>(payload) 单向推送),调用原 handler,await 结果后包成 { result }。
//   3. window.ts 创建 BrowserWindow 后调用 bridge.attachWindow(win),使 ctx.emit 有处可发。
//
// 适配要点:contract 的 handler 签名是 (ctx, ...args);electrobun request handler 拿到的是单个
// params 对象。这里用 { args:[...] } 信封在两侧之间转换,使 26 通道机械接线、无需逐通道写适配。
export class ElectrobunBridge implements BridgeServer {
  private handlers = new Map<string, Handler>()
  private win: { webview?: { rpc?: { send: Record<string, (p: unknown) => void> } } } | null = null

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  // window 创建后注入 win 引用,供 ctx.emit 单向推送(主→渲染)。
  attachWindow(win: unknown): void {
    this.win = win as typeof this.win
  }

  private makeContext(): BridgeContext {
    return {
      emit: (channel, payload) => {
        const send = this.win?.webview?.rpc?.send
        // send 的 key 即 webview.messages 通道名(如 'refresh:progress')
        send?.[channel]?.(payload)
      },
    }
  }

  // 把收集到的 handler map 转成 defineRPC 实例,交给 BrowserWindow 的 rpc option。
  buildRPC() {
    const requests: Record<string, (params: { args?: unknown[] }) => Promise<{ result: unknown }>> = {}
    for (const [channel, handler] of this.handlers) {
      requests[channel] = async (params) => {
        const ctx = this.makeContext()
        const args = params?.args ?? []
        const result = await handler(ctx, ...args)
        return { result }
      }
    }
    return BrowserView.defineRPC<ProdRPC>({
      maxRequestTime: 60000, // 全量扫描可能较慢,放宽请求超时(refresh:run 同步段)
      handlers: {
        requests: requests as never,
        messages: {
          // 渲染层启动自检回传:打印到 bun stdout(转发至 launcher),作为无目视时的程序化判据。
          'view:probe': (p: { ok: boolean; sourcesCount: number; note: string }) => {
            console.log('[main] VIEW PROBE received:', JSON.stringify(p))
          },
        },
      },
    })
  }
}
