import { join, dirname } from 'node:path'
import { mkdirSync, existsSync, renameSync } from 'node:fs'
import type { Db } from './db/db'
import { detectSources, detectWslSourcesFromWindows, type Source } from './sources'
import type { Paths } from './platform/contract'
import { migrateUserData, migrateSourceData } from './migrateRename'

// 每个数据源有独立的 sqlite 索引(index-<id>.db),互不混淆。活动源决定 getEnv() 返回哪套路径与 DB。
let sources: Source[] | null = null
let activeId: string | null = null
const dbs = new Map<string, Db>()

// 用户数据目录由运行时注入(Electron=app.getPath('userData');Electrobun 自拼),appState 不再直接依赖 electron。
let injectedPaths: Paths | null = null
export function setPaths(p: Paths): void { injectedPaths = p }

// DB 创建由运行时注入(Electron=better-sqlite3;Electrobun=bun:sqlite),appState 不绑定具体驱动。
let dbFactory: ((file: string) => Db) | null = null
export function setDbFactory(f: (file: string) => Db): void { dbFactory = f }

function userDataDir(): string {
  if (!injectedPaths) throw new Error('appState: paths 未初始化(应在启动时 setPaths)')
  const d = injectedPaths.userData()
  mkdirSync(d, { recursive: true })
  return d
}

export function listSources(): Source[] {
  if (!sources) sources = detectSources()
  return sources
}

// 异步重探数据源:Windows host 上枚举运行中的 WSL 发行版并 in-place 并入缓存(不整体重赋值,
// 否则 activeId/dbs Map 失配)。由前端经 sources:refresh 调用(挂载时 + 手动按钮),不在同步启动路径触发。
export async function refreshSources(): Promise<Source[]> {
  const arr = listSources() // 确保 local 缓存已初始化
  if (process.platform === 'win32') {
    let wsl: Source[] = []
    try { wsl = await detectWslSourcesFromWindows() } catch { wsl = [] }
    // in-place:先移除旧的 wsl-* 源,再并入最新探测结果;保留 local,不重建数组。
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].id.startsWith('wsl-')) arr.splice(i, 1)
    arr.push(...wsl)
    // 活动源可能是一个本次已消失的 wsl-* 源:回落到 local,避免 activeId 悬挂致
    // getActiveSourceId() 与 activeSource() 失配(前端高亮错位 + getEnv 静默打在错误源上)。
    if (activeId && !arr.some((s) => s.id === activeId)) activeId = arr[0].id
  }
  return arr
}

export function getActiveSourceId(): string {
  if (!activeId) activeId = listSources()[0].id
  return activeId
}

export function setActiveSourceId(id: string): string {
  if (listSources().some((s) => s.id === id)) activeId = id
  return getActiveSourceId()
}

function activeSource(): Source {
  const id = getActiveSourceId()
  return listSources().find((s) => s.id === id) ?? listSources()[0]
}

function dbFor(id: string): Db {
  let db = dbs.get(id)
  if (!db) {
    if (!dbFactory) throw new Error('appState: dbFactory 未初始化(应在启动时 setDbFactory)')
    const dir = userDataDir()
    migrateUserData(dir)        // 改名迁移:把旧 app 名 userData 里的 index 库搬进新目录(幂等)
    if (id === 'local') migrateLegacyLocalDb(dir)
    db = dbFactory(join(dir, `index-${id}.db`)); dbs.set(id, db)
    const src = listSources().find((s) => s.id === id)
    if (src) migrateSourceData(dirname(src.trashRoot), db)   // 改名迁移:.cc-move-* 目录 rename + 库内绝对路径重写(幂等)
  }
  return db
}

// 一次性迁移:旧版用单个 index.db(对应本机源)。若新库 index-local.db 尚不存在而旧库在,
// 则把 index.db(连同 -wal/-shm)改名继承,保留移动历史/撤销/快照,不丢数据。
export function migrateLegacyLocalDb(dir: string): void {
  const target = join(dir, 'index-local.db')
  if (existsSync(target)) return
  for (const suf of ['', '-wal', '-shm']) {
    const legacy = join(dir, 'index.db' + suf)
    if (existsSync(legacy)) { try { renameSync(legacy, target + suf) } catch { /* 忽略 */ } }
  }
}

export interface Env { db: Db; projectsRoot: string; claudeJsonPath: string; trashRoot: string; historyJsonlPath: string; archiveRoot: string; backupsRoot: string; osFamily: Source['osFamily']; fsAnchor: string; claudeHomeCwd: string }

// 返回当前活动源的运行环境(独立 DB + 该源的 projects/claude.json/trash 路径 + osFamily/fsAnchor/claudeHomeCwd 守卫锚点)。
export function getEnv(): Env {
  const s = activeSource()
  return { db: dbFor(s.id), projectsRoot: s.projectsRoot, claudeJsonPath: s.claudeJsonPath, trashRoot: s.trashRoot, historyJsonlPath: s.historyJsonlPath, archiveRoot: s.archiveRoot, backupsRoot: s.backupsRoot, osFamily: s.osFamily, fsAnchor: s.fsAnchor, claudeHomeCwd: s.claudeHomeCwd }
}

// 退出时关闭所有已打开的源 DB。
export function closeDb(): void {
  for (const db of dbs.values()) { try { db.close() } catch { /* 已关闭,忽略 */ } }
  dbs.clear()
}
