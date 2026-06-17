import { contextBridge, ipcRenderer } from 'electron'
import type { RefreshProgress } from '@shared/types'
const api = {
  listSources: () => ipcRenderer.invoke('sources:list'),
  getSource: () => ipcRenderer.invoke('source:get'),
  setSource: (id: string) => ipcRenderer.invoke('source:set', id),
  getIndex: () => ipcRenderer.invoke('index:get'),
  getSessions: (p: string) => ipcRenderer.invoke('sessions:get', p),
  refresh: () => ipcRenderer.invoke('refresh:run'),
  listDir: (p: string) => ipcRenderer.invoke('fs:list', p),
  makeDir: (parent: string, name: string) => ipcRenderer.invoke('fs:mkdir', parent, name),
  previewMove: (ids: string[], t: string) => ipcRenderer.invoke('move:preview', ids, t),
  executeMove: (ids: string[], t: string) => ipcRenderer.invoke('move:execute', ids, t),
  listMoves: () => ipcRenderer.invoke('moves:list'),
  undoMove: (id: number) => ipcRenderer.invoke('move:undo', id),
  trashUsage: () => ipcRenderer.invoke('trash:usage'),
  purgeTrash: (moveId?: number) => ipcRenderer.invoke('trash:purge', moveId),
  planHistory: () => ipcRenderer.invoke('history:plan'),
  reconcileHistory: (mode: 'auto' | 'force', sessionIds?: string[], target?: string) => ipcRenderer.invoke('history:reconcile', mode, sessionIds, target),
  listHistoryRewrites: () => ipcRenderer.invoke('history:listRewrites'),
  undoHistoryRewrite: (id: number) => ipcRenderer.invoke('history:undoRewrite', id),
  archiveSnapshot: (ids: string[]) => ipcRenderer.invoke('archive:snapshot', ids),
  archiveArchive: (ids: string[]) => ipcRenderer.invoke('archive:archive', ids),
  archiveListVersions: (sessionId: string) => ipcRenderer.invoke('archive:listVersions', sessionId),
  archiveAllVersions: () => ipcRenderer.invoke('archive:allVersions'),
  archiveRestore: (versionId: number) => ipcRenderer.invoke('archive:restore', versionId),
  archiveUndoRestore: (restoreId: number) => ipcRenderer.invoke('archive:undoRestore', restoreId),
  archiveDeleteVersion: (versionId: number) => ipcRenderer.invoke('archive:deleteVersion', versionId),
  archiveUsage: () => ipcRenderer.invoke('archive:usage'),
  // 订阅刷新进度;返回取消订阅函数。
  onRefreshProgress: (cb: (p: RefreshProgress) => void) => {
    const h = (_e: unknown, data: RefreshProgress) => cb(data)
    ipcRenderer.on('refresh:progress', h)
    return () => ipcRenderer.removeListener('refresh:progress', h)
  },
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api

// window.api 的全局类型声明随 api 定义本身放在这里(api 的真相源),
// 使 src/shared 不再反向依赖 preload;渲染层经全局声明取得类型。
declare global { interface Window { api: Api } }
