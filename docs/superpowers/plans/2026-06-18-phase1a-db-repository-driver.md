# Phase 1a — DB repository over driver 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/main/db/db.ts` 拆成「领域 repository(运行时无关)+ `SqliteDriver` 抽象接口 + better-sqlite3 driver 实现」,移除 `.raw` 句柄泄漏,**行为零变更、现有测试全绿**,为后续 Electrobun 路径注入 bun:sqlite driver 打地基。

**Architecture:** repository 持有一个 `SqliteDriver`,所有 SQL 经接口表达;`openDb(file)` 保持对外签名不变(内部改为 `createRepository(new BetterSqliteDriver(file))`),所以全部现有 `import { openDb }` 调用点零改动。生产代码唯一的 `.raw` 用法(取全量 session 行)替换为 repository 具名方法;测试里的白盒 `.raw` 改用抽象 `driver` 接口。

**Tech Stack:** TypeScript、better-sqlite3、vitest。

**关联 spec:** `docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md` §9(repository over driver)、§5.3(移除 .raw)。这是 Phase 1 的第一个子计划;1b(contract/channels/bootstrap/Electron platform)、1c(目录迁移)、1d(测试迁 bun:test)后续另写。

**约束:** 本计划只动 `src/main/db/` 与两个 `.raw` 生产用点(`ipc.ts`、`refresh.ts` 及其测试),不碰 core/renderer/electron 入口。`openDb` 对外签名与返回对象的全部现有方法名/行为保持不变。

---

## File Structure

- **Create** `src/main/db/driver.ts` — `SqliteDriver`/`PreparedStatement` 接口 + `BetterSqliteDriver` 实现(唯一 import better-sqlite3 的文件)。
- **Create** `src/main/db/driver.test.ts` — driver 行为单测。
- **Modify** `src/main/db/db.ts` — `openDb` body 抽为 `createRepository(driver)`;`new Database`/`db.prepare`/`db.exec`/`db.pragma`/`db.transaction` 全部改走 driver;移除 `raw: db`,改暴露 `driver`;新增 `getAllSessionRows()`。
- **Modify** `src/main/db/db.test.ts` — 9 处 `db.raw.*` 改为 `db.driver.*` / `db.close()`。
- **Modify** `src/main/ipc.ts:71` — `env.db.raw.prepare('SELECT * FROM sessions').all()` → `env.db.getAllSessionRows()`。
- **Modify** `src/main/refresh.test.ts:16` — 同上改 `db.getAllSessionRows()`。

---

## Task 1: SqliteDriver 接口与 better-sqlite3 实现

**Files:**
- Create: `src/main/db/driver.ts`
- Create: `src/main/db/driver.test.ts`

- [ ] **Step 1: 写 driver(接口 + better-sqlite3 实现)**

创建 `src/main/db/driver.ts`:
```ts
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
  exec(sql: string): void              // 多语句脚本(建表 / ALTER)
  pragma(source: string): void         // 如 'journal_mode = WAL'
  transaction<T>(fn: () => T): () => T  // 返回可调用包装器(better-sqlite3 语义);闭包内可同步读 lastInsertRowid
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
```

- [ ] **Step 2: 写 driver 测试**

创建 `src/main/db/driver.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { BetterSqliteDriver } from './driver'

describe('BetterSqliteDriver', () => {
  it('exec 多语句 + prepare/run 位置参数 + lastInsertRowid', () => {
    const d = new BetterSqliteDriver(':memory:')
    d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); CREATE TABLE u (x INTEGER);')
    const r = d.prepare('INSERT INTO t (v) VALUES (?)').run('hello')
    expect(Number(r.lastInsertRowid)).toBe(1)
    expect((d.prepare('SELECT v FROM t WHERE id=?').get(1) as { v: string }).v).toBe('hello')
    d.close()
  })

  it('命名参数对象 + all 返回行数组', () => {
    const d = new BetterSqliteDriver(':memory:')
    d.exec('CREATE TABLE t (a TEXT, b TEXT)')
    d.prepare('INSERT INTO t (a,b) VALUES (@a,@b)').run({ a: '1', b: '2' })
    const rows = d.prepare('SELECT * FROM t').all() as { a: string; b: string }[]
    expect(rows).toEqual([{ a: '1', b: '2' }])
    d.close()
  })

  it('transaction(fn)() 包裹回调、返回结果、闭包内同步读 lastInsertRowid', () => {
    const d = new BetterSqliteDriver(':memory:')
    d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE c (tid INTEGER)')
    const tx = d.transaction(() => {
      const id = Number(d.prepare('INSERT INTO t DEFAULT VALUES').run().lastInsertRowid)
      d.prepare('INSERT INTO c (tid) VALUES (?)').run(id)
      return id
    })
    const id = tx()
    expect(id).toBe(1)
    expect((d.prepare('SELECT COUNT(*) AS n FROM c WHERE tid=?').get(id) as { n: number }).n).toBe(1)
    d.close()
  })

  it('pragma 与 PRAGMA table_info 可作查询返回列', () => {
    const d = new BetterSqliteDriver(':memory:')
    d.pragma('journal_mode = WAL') // 内存库下 pragma 不抛即可
    d.exec('CREATE TABLE t (a TEXT, b INTEGER)')
    const cols = (d.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['a', 'b'])
    d.close()
  })
})
```

- [ ] **Step 3: 运行 driver 测试,确认通过**

Run: `npm test -- src/main/db/driver.test.ts`
Expected: 4 个用例全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/main/db/driver.ts src/main/db/driver.test.ts
git commit -m "feat(db): 引入 SqliteDriver 抽象与 better-sqlite3 实现"
```

---

## Task 2: db.ts 改为 repository over driver(保持 openDb 签名与行为)

**Files:**
- Modify: `src/main/db/db.ts`

- [ ] **Step 1: 改造 db.ts 的顶部 import 与函数骨架**

把 `db.ts` 顶部的 `import Database from 'better-sqlite3'` 改为:
```ts
import { BetterSqliteDriver, type SqliteDriver } from './driver'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import type { SessionRowShape } from './rowMap'
```

把 `hasColumn` / `migrateSchema` 的参数类型从 `Database.Database` 改为 `SqliteDriver`,内部 `db.prepare`/`db.exec` 改为 `driver.prepare`/`driver.exec`:
```ts
function hasColumn(driver: SqliteDriver, table: string, col: string): boolean {
  return (driver.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)
}

function migrateSchema(driver: SqliteDriver, fromVersion: number): void {
  if (fromVersion < 3 && hasColumn(driver, 'archive_versions', 'gz_total_bytes') && !hasColumn(driver, 'archive_versions', 'compressed_bytes')) {
    driver.exec('ALTER TABLE archive_versions RENAME COLUMN gz_total_bytes TO compressed_bytes')
  }
}
```

- [ ] **Step 2: 把 `openDb` 拆成 `createRepository(driver)` + 薄 `openDb`**

将现有 `export function openDb(file: string) { const db = new Database(file); ... return { raw: db, ... } }` 改为:把整个函数体迁入 `createRepository(driver: SqliteDriver)`,并按下列**机械转换规则**替换 body 内每一处:
- `const db = new Database(file)` → 删除(driver 由参数传入)
- `db.pragma(...)` → `driver.pragma(...)`
- `db.exec(...)` → `driver.exec(...)`
- `db.prepare(...)` → `driver.prepare(...)`
- `db.transaction(...)` → `driver.transaction(...)`
- `migrateSchema(db, ...)` → `migrateSchema(driver, ...)`
- 返回对象里 `raw: db,` → `driver,`(暴露抽象接口而非具体句柄)
- `close() { db.close() }` → `close() { driver.close() }`

并在末尾新增薄封装与新方法。返回对象**新增**一个具名方法(供生产代码替代 `.raw` 取全量 session 行):
```ts
    // 全量 sessions 原始行(snake_case),供刷新时喂给扫描 worker 的增量复用;替代旧的 db.raw 直查。
    getAllSessionRows(): SessionRowShape[] {
      return driver.prepare('SELECT * FROM sessions').all() as SessionRowShape[]
    },
```

文件末尾的导出改为:
```ts
export function createRepository(driver: SqliteDriver) {
  driver.pragma('journal_mode = WAL')
  driver.exec(SCHEMA_SQL)
  const ver = driver.prepare('SELECT schema_version FROM meta LIMIT 1').get() as { schema_version: number } | undefined
  if (!ver) driver.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(SCHEMA_VERSION)
  else if (ver.schema_version !== SCHEMA_VERSION) {
    migrateSchema(driver, ver.schema_version)
    driver.prepare('UPDATE meta SET schema_version=?').run(SCHEMA_VERSION)
  }
  const now = () => new Date().toISOString()
  // ...(此处为原 openDb body 内 mapVersion/mapRestore 定义与 return { ... } 整块,按上方规则转换后照搬)...
}

// 对外签名不变:现有所有 import { openDb } 调用点零改动。
export function openDb(file: string) {
  return createRepository(new BetterSqliteDriver(file))
}
export type Db = ReturnType<typeof createRepository>
```

> 注意:`createRepository` body 即原 `openDb` 的 `const now = ...` 起、到 `return { ... }` 止的全部领域方法,逐字保留,仅按 Step 2 规则替换 `db.*`→`driver.*` 与 `raw: db`→`driver`,并加入上面的 `getAllSessionRows`。不改任何 SQL 字符串、不改任何布尔→0/1 转换、不改方法名。

- [ ] **Step 3: 改 db.test.ts 的 9 处 .raw(白盒断言改用 driver 接口)**

在 `src/main/db/db.test.ts` 中做如下精确替换(行号以现状为参考):
- `const cwdRows = db.raw.prepare('SELECT * FROM cwd_changes WHERE move_id=?').all(id)` → `const cwdRows = db.driver.prepare('SELECT * FROM cwd_changes WHERE move_id=?').all(id)`
- `const snapRows = db.raw.prepare('SELECT * FROM snapshot_lines WHERE move_id=?').all(id)` → `db.driver.prepare(...)`(同样把 `db.raw` 换 `db.driver`)
- `a.raw.close()` → `a.close()`
- `const metaRows = b.raw.prepare('SELECT * FROM meta').all()` → `b.driver.prepare('SELECT * FROM meta').all()`
- `b.raw.close()` → `b.close()`
- `db.raw.prepare('PRAGMA table_info(archive_versions)').all()` → `db.driver.prepare('PRAGMA table_info(archive_versions)').all()`
- `db.raw.prepare('SELECT compressed_bytes FROM archive_versions WHERE session_id=?').get('s1')` → `db.driver.prepare(...).get('s1')`
- `db.raw.prepare('SELECT schema_version FROM meta').get()` → `db.driver.prepare(...).get()`
- 末尾 `db.raw.close()` → `db.close()`

(`import Database from 'better-sqlite3'` 在 db.test.ts 中保留——v2→v3 迁移用例需要它手建旧库 fixture。)

- [ ] **Step 4: 运行 db 测试,确认行为零变更**

Run: `npm test -- src/main/db/db.test.ts src/main/db/driver.test.ts`
Expected: 全部 PASS(db.test.ts 原有用例数不变、全绿,证明 repository 行为与重构前等价)。

- [ ] **Step 5: 提交**

```bash
git add src/main/db/db.ts src/main/db/db.test.ts
git commit -m "refactor(db): openDb 拆为 createRepository over SqliteDriver,移除 raw 句柄、新增 getAllSessionRows"
```

---

## Task 3: 移除生产代码的 .raw 用点

**Files:**
- Modify: `src/main/ipc.ts`(第 71 行附近 refresh:run handler)
- Modify: `src/main/refresh.test.ts`(第 16 行附近)

- [ ] **Step 1: 改 ipc.ts 的 refresh:run**

把 `src/main/ipc.ts` 中:
```ts
    const existing = env.db.raw.prepare('SELECT * FROM sessions').all() as any[]
```
替换为:
```ts
    const existing = env.db.getAllSessionRows()
```

- [ ] **Step 2: 改 refresh.test.ts**

把 `src/main/refresh.test.ts` 中:
```ts
  const existing = db.raw.prepare('SELECT * FROM sessions').all() as any[]
```
替换为:
```ts
  const existing = db.getAllSessionRows()
```

- [ ] **Step 3: 确认全仓再无生产 .raw 用点**

Run: `grep -rn '\.raw' src/main/ipc.ts src/main/refresh.ts src/main/refresh.test.ts; grep -rn 'db\.raw' src/ || echo "无 db.raw 残留"`
Expected: `ipc.ts`/`refresh.ts` 无 `.raw`;`refresh.test.ts` 已改为 `getAllSessionRows`;`db.raw` 全仓仅可能剩 db.test.ts 之外为 0(db.test.ts 已在 Task 2 改完,应也为 0)。若仍有残留,按相同方式替换。

- [ ] **Step 4: 提交**

```bash
git add src/main/ipc.ts src/main/refresh.test.ts
git commit -m "refactor(db): 生产代码改用 getAllSessionRows,消除 db.raw 泄漏"
```

---

## Task 4: 全量回归与构建验证

**Files:** 无(仅运行)

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全部测试 PASS(Electron test runner / vitest 套件全绿),测试总数不少于重构前。

- [ ] **Step 2: 构建验证(Electron 路径未破)**

Run: `npm run build`
Expected: electron-vite build 成功,无类型错误(`db.ts` 不再 import better-sqlite3,`driver.ts` external 已在 vite 配置 `external: ['better-sqlite3', 'zstd-napi']` 覆盖,无需改 vite 配置)。

- [ ] **Step 3: 确认无残留与提交（若 Step 1/2 触发了小修）**

若前两步全绿无改动,跳过提交。若有修复:
```bash
git add -A
git commit -m "test(db): Phase 1a 回归修复"
```

---

## 自检备注(spec 覆盖核对)

- spec §9「repository over driver」→ Task 1（driver 接口）+ Task 2（createRepository）。
- spec §5.3「移除 .raw 后门」→ Task 2（返回对象去 raw）+ Task 3（生产用点改具名方法)。
- spec §9「命名参数 @ 与位置参数 ? 两种风格」→ `PreparedStatement.run/get/all(...params)` 覆盖,driver.test.ts 两风格均测。
- spec §9「transaction(fn)() 闭包内同步 lastInsertRowid」→ driver.test.ts Step 2 第三个用例显式覆盖。
- 行为零变更由「db.test.ts 全绿 + openDb 签名不变 + SQL 字符串逐字保留」三重保证。
- **不在本计划**:bun:sqlite driver(Phase 2)、双 driver 参数化 fixture(引入 bun driver 时)、目录迁移(Phase 1c)。Task 2 已让 repository 仅依赖 `SqliteDriver` 接口,为它们留好注入点。
