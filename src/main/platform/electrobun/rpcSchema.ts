import type { RPCSchema } from 'electrobun/bun'

// 生产通道的 Electrobun RPC schema。
//
// 形态对齐 ElectrobunRPCSchema = { bun: RPCSchema, webview: RPCSchema }:
//   - bun.requests   : view→bun 的请求-响应(等价 ipcMain.handle / window.api.*)
//   - webview.messages: bun→view 的单向推送(等价 sender.send / onRefreshProgress)
//
// 统一信封:每个 request 的 params 都是 { args: unknown[] }(渲染层调用参数原样打包),
// response 都是 { result: unknown }(主进程 handler 返回值原样回传)。这样 bridge 与渲染 adapter
// 都能用「单一通用形状」机械地把全部 26 个通道接上,无需为每通道写专属类型。
// 强类型由 src/preload 的 Api(window.api 形状)在渲染 adapter 边界保证。
type Req = { params: { args: unknown[] }; response: { result: unknown } }

// 全部 26 个通道(与 src/main/ipc.ts 注册的 bridge.handle 通道一一对应)。
// 本里程碑重点验证:sources:list / source:get / index:get / sessions:get / refresh:run(含进度)。
// 其余通道走同一信封,bridge 自动接线,可直接调用(非本次重点验证项)。
export type ProdRPC = {
  bun: RPCSchema<{
    requests: {
      'sources:list': Req
      'source:get': Req
      'source:set': Req
      'index:get': Req
      'sessions:get': Req
      'refresh:run': Req
      'fs:list': Req
      'fs:mkdir': Req
      'move:preview': Req
      'move:execute': Req
      'moves:list': Req
      'move:undo': Req
      'trash:usage': Req
      'trash:purge': Req
      'history:plan': Req
      'history:reconcile': Req
      'history:listRewrites': Req
      'history:undoRewrite': Req
      'archive:snapshot': Req
      'archive:archive': Req
      'archive:listVersions': Req
      'archive:allVersions': Req
      'archive:restore': Req
      'archive:undoRestore': Req
      'archive:deleteVersion': Req
      'archive:usage': Req
    }
    messages: {
      // 渲染层启动自检回传(view→bun 单向):证明「渲染挂载 + window.api 注入 + 核心通道 RPC 往返」
      // 三件事都成立。bun 侧 console 会转发到 launcher stdout,故这是无目视时的程序化判据(dev-guide §4)。
      'view:probe': { ok: boolean; sourcesCount: number; note: string }
    }
  }>
  webview: RPCSchema<{
    requests: Record<never, never>
    messages: {
      // 主→渲染进度推送(对应 ctx.emit('refresh:progress', ...) / window.api.onRefreshProgress)
      'refresh:progress': { done: number; total: number; path: string }
    }
  }>
}

// 渲染 adapter 与 bridge 都需要的通道清单(单一真相源,避免两处手抄漂移)。
export const PROD_CHANNELS = [
  'sources:list', 'source:get', 'source:set', 'index:get', 'sessions:get', 'refresh:run',
  'fs:list', 'fs:mkdir', 'move:preview', 'move:execute', 'moves:list', 'move:undo',
  'trash:usage', 'trash:purge', 'history:plan', 'history:reconcile', 'history:listRewrites',
  'history:undoRewrite', 'archive:snapshot', 'archive:archive', 'archive:listVersions',
  'archive:allVersions', 'archive:restore', 'archive:undoRestore', 'archive:deleteVersion',
  'archive:usage',
] as const
