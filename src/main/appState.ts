import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, renameSync } from 'node:fs'
import { openDb, type Db } from './db/db'
import { detectSources, type Source } from './sources'

// 每个数据源有独立的 sqlite 索引(index-<id>.db),互不混淆。活动源决定 getEnv() 返回哪套路径与 DB。
let sources: Source[] | null = null
let activeId: string | null = null
const dbs = new Map<string, Db>()

function userDataDir(): string {
  const d = app.getPath('userData')
  mkdirSync(d, { recursive: true })
  return d
}

export function listSources(): Source[] {
  if (!sources) sources = detectSources()
  return sources
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
    if (id === 'local') migrateLegacyLocalDb(userDataDir())
    db = openDb(join(userDataDir(), `index-${id}.db`)); dbs.set(id, db)
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

export interface Env { db: Db; projectsRoot: string; claudeJsonPath: string; trashRoot: string; historyJsonlPath: string; archiveRoot: string; backupsRoot: string }

// 返回当前活动源的运行环境(独立 DB + 该源的 projects/claude.json/trash 路径)。
export function getEnv(): Env {
  const s = activeSource()
  return { db: dbFor(s.id), projectsRoot: s.projectsRoot, claudeJsonPath: s.claudeJsonPath, trashRoot: s.trashRoot, historyJsonlPath: s.historyJsonlPath, archiveRoot: s.archiveRoot, backupsRoot: s.backupsRoot }
}

// 退出时关闭所有已打开的源 DB。
export function closeDb(): void {
  for (const db of dbs.values()) { try { db.close() } catch { /* 已关闭,忽略 */ } }
  dbs.clear()
}
