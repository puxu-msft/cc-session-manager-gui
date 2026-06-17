// 共享 RPC schema(对齐 spec §8 channel 模型:请求-响应 + 双向单向 + 结构化 payload)
// 形态依官方 ElectrobunRPCSchema = { bun: RPCSchema, webview: RPCSchema }:
//   - bun.requests    : view→bun 的请求-响应(等价 ipcMain.handle)
//   - bun.messages    : view→bun 的单向通知(bun 侧接收)
//   - webview.messages: bun→view 的单向推送(view 侧接收,等价 emitProgress)
import type { RPCSchema } from 'electrobun/bun'

export type SpikeRPC = {
  bun: RPCSchema<{
    requests: {
      echo: { params: { text: string }; response: { reply: string; ts: number } }
    }
    messages: {
      // msg:通用通知;echoReply:把 echo 请求-响应的结果回传主进程,便于纯自动观测请求链路
      logFromView: { msg: string; echoReply?: string }
    }
  }>
  webview: RPCSchema<{
    requests: Record<never, never>
    messages: {
      tick: { at: number }
    }
  }>
}
