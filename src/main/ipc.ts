import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ProjectMeta } from '@shared/types'
import type { BridgeServer, ScanRunner, UpdaterHost } from './platform/contract'
import { ElectronScanRunner } from './platform/electron/scanRunner'
import { getEnv, listSources, refreshSources, getActiveSourceId, setActiveSourceId } from './appState'
import { applyScanToIndex, applyProjectScan } from './refresh'
import { scanProject } from './core/scanner'
import { hostPathForCwd, cwdHostMapFor } from './core/pathCodec'
import { detectChanges } from './core/updates'
import { listDir } from './core/fsBrowser'
import { trashUsage, purgeMove, purgeAllTrash } from './trash'
import { previewMove, executeMove, reconcile, undoMove } from './core/mover'
import { planReconcile, planForce, executeReconcile, undoRewrite } from './core/historyReconciler'
import { snapshotSession, archiveSession, restoreVersion, undoRestore, deleteVersion, listVersions, archiveUsage, archiverReconcile } from './core/archiver'

// 后台扫描运行器。默认 Electron worker_threads 实现;运行时可经 registerIpc(bridge, runner) 注入
// 其它实现(Electrobun 用进程内异步实现)。刷新可被新刷新抢占,退出/切源时被 terminate 中断。
let scanRunner: ScanRunner = new ElectronScanRunner()
export function abortCurrentScan(): void {
  scanRunner.terminate()
}

export function registerIpc(bridge: BridgeServer, runner?: ScanRunner, updater?: UpdaterHost): void {
  if (runner) scanRunner = runner
  reconcile(getEnv()) // 启动时收尾当前活动源的 pending 移动
  archiverReconcile(getEnv()) // 启动时收尾当前活动源的 pending 归档/还原

  const projectSource = (s: { id: string; label: string; projectsRoot: string; exists: boolean }) =>
    ({ id: s.id, label: s.label, projectsRoot: s.projectsRoot, exists: s.exists })
  bridge.handle('sources:list', () => listSources().map(projectSource))
  // 异步重探(Windows host 枚举运行中的 WSL 发行版并入)。前端挂载时自动调一次 + 「重新检测源」按钮。
  // async handler:await execFile 异步探测(不阻塞主进程 event loop),直接 request/response 返回完整列表。
  bridge.handle('sources:refresh', async () => (await refreshSources()).map(projectSource))
  // 宿主是否可能有 WSL(仅 win32)。供前端决定是否常驻显示「重新检测源」入口,
  // 避免「WSL 未运行时源条消失 → 想重探却无入口」。
  bridge.handle('host:canDetectWsl', () => process.platform === 'win32')
  bridge.handle('source:get', () => getActiveSourceId())
  bridge.handle('source:set', (_ctx, id: string) => {
    abortCurrentScan()
    const active = setActiveSourceId(id)
    const env = getEnv()
    reconcile(env)
    archiverReconcile(env) // 切源后收尾新活动源的 pending 归档/还原
    return { active, projects: env.db.getProjects() }
  })

  bridge.handle('index:get', () => ({ projects: getEnv().db.getProjects() }))
  bridge.handle('sessions:get', (_ctx, projectPathAbs: string) => getEnv().db.getSessions(projectPathAbs))

  bridge.handle('refresh:run', async (ctx) => {
    const env = getEnv()
    const existing = env.db.getAllSessionRows()
    const { projects, sessions, aborted } = await scanRunner.run(
      { projectsRoot: env.projectsRoot, existingRows: existing, cwdHostMap: cwdHostMapFor(process.platform === 'win32', env.osFamily, env.fsAnchor) },
      (done, total, path) => ctx.emit('refresh:progress', { done, total, path }),
    )
    if (aborted) {
      // 退出/切源时会先中断,在飞刷新走到这里读库可能抛 use-after-close,容错返回空。
      let current: ProjectMeta[] = []
      try { current = env.db.getProjects() } catch { /* DB 可能已关闭 */ }
      return { projects: current, diff: { added: [], removed: [], changed: [] }, aborted: true }
    }
    const diff = applyScanToIndex(env.db, { projects, sessions }, existing.map((r) => ({ session_id: r.session_id, size_bytes: r.size_bytes, mtime: r.mtime })))
    return { projects: env.db.getProjects(), diff, aborted: false }
  })

  // 轻量更新检测(启动 + "检查更新"按钮):只 stat 比对,不解析,返回变化计数与受影响项目。
  bridge.handle('check:updates', () => detectChanges(getEnv().projectsRoot, getEnv().db.getAllSessionRows()))
  // 单项目刷新:只重扫该项目文件夹并落库,返回最新项目列表与该项目的 diff。
  bridge.handle('refresh:project', async (_ctx, projectPathAbs: string) => {
    const env = getEnv()
    const scan = await scanProject(env.projectsRoot, projectPathAbs, { hostPath: (cwd) => hostPathForCwd(cwd, cwdHostMapFor(process.platform === 'win32', env.osFamily, env.fsAnchor)) })
    const diff = applyProjectScan(env.db, projectPathAbs, scan)
    return { project: scan.project, projects: env.db.getProjects(), diff }
  })

  bridge.handle('fs:list', (_ctx, path: string) => listDir(path || homedir()))
  bridge.handle('fs:mkdir', (_ctx, parent: string, name: string) => {
    const p = join(parent, name)
    mkdirSync(p, { recursive: true })
    return listDir(p)
  })
  bridge.handle('move:preview', (_ctx, ids: string[], target: string) => previewMove(ids, target, getEnv()))
  bridge.handle('move:execute', (_ctx, ids: string[], target: string) => executeMove(ids, target, getEnv()))
  bridge.handle('moves:list', () => getEnv().db.getMoves())
  bridge.handle('move:undo', (_ctx, moveId: number) => { const env = getEnv(); undoMove(moveId, env); return env.db.getMoves() })
  bridge.handle('trash:usage', () => trashUsage(getEnv().trashRoot))
  bridge.handle('trash:purge', (_ctx, moveId?: number) => {
    const env = getEnv()
    if (moveId == null) purgeAllTrash(env.trashRoot); else purgeMove(env.trashRoot, moveId)
    return { moves: env.db.getMoves(), usage: trashUsage(env.trashRoot) }
  })

  bridge.handle('history:plan', () => planReconcile(getEnv()))
  bridge.handle('history:reconcile', (_ctx, mode: 'auto' | 'force', sessionIds?: string[], target?: string) => {
    const env = getEnv()
    const plan = mode === 'force' ? planForce(env, sessionIds ?? [], target ?? '') : planReconcile(env)
    const result = executeReconcile(env, plan, mode)
    return { result, rewrites: env.db.getHistoryRewrites() }
  })
  bridge.handle('history:listRewrites', () => getEnv().db.getHistoryRewrites())
  bridge.handle('history:undoRewrite', (_ctx, id: number) => { const env = getEnv(); undoRewrite(env, id); return env.db.getHistoryRewrites() })

  bridge.handle('archive:snapshot', async (_ctx, sessionIds: string[]) => {
    const env = getEnv(); const out = []
    for (const id of sessionIds) out.push(await snapshotSession(id, env))
    return out
  })
  bridge.handle('archive:archive', async (_ctx, sessionIds: string[]) => {
    const env = getEnv(); const out = []
    for (const id of sessionIds) out.push(await archiveSession(id, env))
    return out
  })
  bridge.handle('archive:listVersions', (_ctx, sessionId: string) => listVersions(sessionId, getEnv()))
  bridge.handle('archive:allVersions', () => getEnv().db.getAllArchiveVersions())
  bridge.handle('archive:restore', (_ctx, versionId: number) => restoreVersion(versionId, getEnv()))
  bridge.handle('archive:undoRestore', (_ctx, restoreId: number) => { undoRestore(restoreId, getEnv()); return true })
  bridge.handle('archive:deleteVersion', (_ctx, versionId: number) => { deleteVersion(versionId, getEnv()); return true })
  bridge.handle('archive:usage', () => archiveUsage(getEnv()))

  // 应用版本自动更新(electron-updater):触发安装已下载更新并重启。
  // 注意:这是「应用程序版本」更新,与上方 check:updates(会话数据变更检测)无关。
  // Electrobun 不传 updater(自带 bsdiff 自更新),此 handler 即 no-op。
  bridge.handle('app:update:install', () => { updater?.quitAndInstall(); return true })
}

