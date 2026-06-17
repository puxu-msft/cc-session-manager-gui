import { BetterSqliteDriver } from './driver'
import { createRepository } from './repository'

// 对外签名不变:现有所有 import { openDb } 调用点零改动。Electron 路径用 better-sqlite3 驱动。
export function openDb(file: string) {
  return createRepository(new BetterSqliteDriver(file))
}

// re-export 领域层符号,保持 './db/db' 作为旧 import 入口不变(core/appState/测试均从这里取)。
export { createRepository } from './repository'
export type { Db, SessionRow, MoveInsert } from './repository'
