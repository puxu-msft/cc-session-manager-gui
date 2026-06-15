import { contextBridge, ipcRenderer } from 'electron'
import type { RefreshProgress } from '@shared/types'
const api = {
  getIndex: () => ipcRenderer.invoke('index:get'),
  getSessions: (p: string) => ipcRenderer.invoke('sessions:get', p),
  refresh: () => ipcRenderer.invoke('refresh:run'),
  listDir: (p: string) => ipcRenderer.invoke('fs:list', p),
  makeDir: (parent: string, name: string) => ipcRenderer.invoke('fs:mkdir', parent, name),
  previewMove: (ids: string[], t: string) => ipcRenderer.invoke('move:preview', ids, t),
  executeMove: (ids: string[], t: string) => ipcRenderer.invoke('move:execute', ids, t),
  listMoves: () => ipcRenderer.invoke('moves:list'),
  undoMove: (id: number) => ipcRenderer.invoke('move:undo', id),
  // 订阅刷新进度;返回取消订阅函数。
  onRefreshProgress: (cb: (p: RefreshProgress) => void) => {
    const h = (_e: unknown, data: RefreshProgress) => cb(data)
    ipcRenderer.on('refresh:progress', h)
    return () => ipcRenderer.removeListener('refresh:progress', h)
  },
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
