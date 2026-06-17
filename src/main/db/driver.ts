import Database from 'better-sqlite3'

// 预编译语句的最小抽象:run/get/all 同时支持命名参数对象(run({a:1}))与位置参数(run(1,2))两种调用风格。
export interface PreparedStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

// 运行时无关的 SQLite 驱动接口。repository 仅依赖它,具体实现(better-sqlite3 / 将来 bun:sqlite)在各自运行时提供。
export interface SqliteDriver {
  prepare(sql: string): PreparedStatement
  exec(sql: string): void
  pragma(source: string): void
  transaction<T>(fn: () => T): () => T
  close(): void
}

// better-sqlite3 实现。这是本文件之外唯一应出现 better-sqlite3 的地方;repository 不再直接依赖它。
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
