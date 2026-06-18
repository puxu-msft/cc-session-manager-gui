import { createRoot } from 'react-dom/client'
import { Electroview } from 'electrobun/view'
import type { RefreshProgress } from '@shared/types'
import { App } from './App'
import './styles.css'

// Electrobun 渲染入口。
//
// 职责:把 Electroview 的 RPC 包装成与 Electron preload 的 window.api(Api 形状)**同形**的对象,
// 挂到 window.api,使生产 React App(src/renderer/App.tsx + state.ts)在两运行时下零改动复用。
//   - 每个方法把位置参数打包成统一信封 { args:[...] } 发 request,再从 { result } 取回返回值。
//   - onRefreshProgress 经 webview 单向 message 'refresh:progress' 接收(等价 Electron 的 ipcRenderer.on)。
//
// 强类型:window.api 的 Api 类型由 src/preload 全局声明提供(declare global Window.api),
// 此处构造的对象在结构上对齐它。

type ProgressCb = (p: RefreshProgress) => void
const progressListeners = new Set<ProgressCb>()

const ev = new Electroview({
  rpc: Electroview.defineRPC({
    handlers: {
      requests: {},
      messages: {
        // 主→渲染进度推送(对应 ctx.emit('refresh:progress', ...))
        'refresh:progress': (p: RefreshProgress) => {
          for (const cb of progressListeners) cb(p)
        },
      },
    },
  }),
})

// 通用调用:发 request 信封 { args },取回 { result }。
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await (ev.rpc.request as Record<string, (p: { args: unknown[] }) => Promise<{ result: unknown }>>)[channel]({ args })) as { result: T }
  return res.result
}

// 与 src/preload/index.ts 的 api 一一对应(同名同参同返回)。
const api = {
  listSources: () => call('sources:list'),
  getSource: () => call('source:get'),
  setSource: (id: string) => call('source:set', id),
  getIndex: () => call('index:get'),
  getSessions: (p: string) => call('sessions:get', p),
  refresh: () => call('refresh:run'),
  checkUpdates: () => call('check:updates'),
  refreshProject: (p: string) => call('refresh:project', p),
  listDir: (p: string) => call('fs:list', p),
  makeDir: (parent: string, name: string) => call('fs:mkdir', parent, name),
  previewMove: (ids: string[], t: string) => call('move:preview', ids, t),
  executeMove: (ids: string[], t: string) => call('move:execute', ids, t),
  listMoves: () => call('moves:list'),
  undoMove: (id: number) => call('move:undo', id),
  trashUsage: () => call('trash:usage'),
  purgeTrash: (moveId?: number) => call('trash:purge', moveId),
  planHistory: () => call('history:plan'),
  reconcileHistory: (mode: 'auto' | 'force', sessionIds?: string[], target?: string) => call('history:reconcile', mode, sessionIds, target),
  listHistoryRewrites: () => call('history:listRewrites'),
  undoHistoryRewrite: (id: number) => call('history:undoRewrite', id),
  archiveSnapshot: (ids: string[]) => call('archive:snapshot', ids),
  archiveArchive: (ids: string[]) => call('archive:archive', ids),
  archiveListVersions: (sessionId: string) => call('archive:listVersions', sessionId),
  archiveAllVersions: () => call('archive:allVersions'),
  archiveRestore: (versionId: number) => call('archive:restore', versionId),
  archiveUndoRestore: (restoreId: number) => call('archive:undoRestore', restoreId),
  archiveDeleteVersion: (versionId: number) => call('archive:deleteVersion', versionId),
  archiveUsage: () => call('archive:usage'),
  // 订阅刷新进度;返回取消订阅函数(等价 Electron 的 ipcRenderer.on/removeListener)。
  onRefreshProgress: (cb: ProgressCb) => {
    progressListeners.add(cb)
    return () => progressListeners.delete(cb)
  },
}

// 注入 window.api(替代 Electron 的 contextBridge.exposeInMainWorld)。
;(window as unknown as { api: typeof api }).api = api

// 探针:渲染挂载即跑核心通道并把结果回传主进程(无目视时的程序化证据,见 dev-guide §4)。
// 证明三件事:渲染挂载成功 + window.api 注入成功 + 核心通道 RPC 往返成功。
console.log('[view] electrobun renderer mounted; window.api injected')
void (async () => {
  try {
    const sources = await api.listSources()
    const idx = await api.getIndex()
    const note = `index.projects=${Array.isArray(idx?.projects) ? idx.projects.length : '?'}`
    ;(ev.rpc.send as { 'view:probe': (p: unknown) => void })['view:probe']({
      ok: true,
      sourcesCount: Array.isArray(sources) ? sources.length : -1,
      note,
    })
  } catch (e) {
    ;(ev.rpc.send as { 'view:probe': (p: unknown) => void })['view:probe']({
      ok: false,
      sourcesCount: -1,
      note: 'probe failed: ' + String(e),
    })
  }
})()

const rootEl = document.getElementById('root')
if (rootEl) createRoot(rootEl).render(<App />)
