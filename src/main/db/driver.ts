import Database from 'better-sqlite3'
import type { SqliteDriver, PreparedStatement } from '../platform/contract'

// better-sqlite3 实现。这是 repository 之外唯一应出现 better-sqlite3 的地方。
export class BetterSqliteDriver implements SqliteDriver {
  private db: Database.Database
  constructor(file: string) {
    this.db = new Database(file)
  }
  prepare(sql: string): PreparedStatement {
    return this.db.prepare(sql)
  }
  exec(sql: string): void {
    this.db.exec(sql)
  }
  pragma(source: string): void {
    this.db.pragma(source)
  }
  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn)
  }
  close(): void {
    this.db.close()
  }
}
