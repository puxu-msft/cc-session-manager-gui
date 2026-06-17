import { Database } from 'bun:sqlite'
import type { SqliteDriver, PreparedStatement } from '../contract'

// Electrobun 侧 SQLite 驱动:bun:sqlite。strict 模式让命名参数绑定 key 不带前缀,贴近 better-sqlite3 习惯(SQL 里 @name 占位仍可用)。
// 行为差异已在 Phase 0 spike(probe-sqlite.ts)逐项验证:WAL/命名+位置参数/transaction(fn)()/PRAGMA-as-query/多语句 exec。
export class BunSqliteDriver implements SqliteDriver {
  private db: Database

  constructor(file: string) {
    this.db = new Database(file, { strict: true })
  }

  prepare(sql: string): PreparedStatement {
    const q = this.db.query(sql)
    return {
      run: (...params: unknown[]) => {
        const r = q.run(...(params as never[]))
        return { lastInsertRowid: r.lastInsertRowid, changes: r.changes }
      },
      get: (...params: unknown[]) => q.get(...(params as never[])),
      all: (...params: unknown[]) => q.all(...(params as never[])),
    }
  }

  exec(sql: string): void { this.db.exec(sql) }
  // bun:sqlite 无 .pragma() 方法,翻译为 run('PRAGMA ...')(Phase 0 已验证)。
  pragma(source: string): void { this.db.exec(`PRAGMA ${source}`) }
  transaction<T>(fn: () => T): () => T { return this.db.transaction(fn) }
  close(): void { this.db.close() }
}
