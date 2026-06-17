// 运行:bun run spike/probe-sqlite.ts(在项目根)
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_SQL, SCHEMA_VERSION } from '../src/main/db/schema'

let pass = true
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) pass = false
}

// strict:true 让命名参数绑定 key 不带前缀,贴近 better-sqlite3 习惯(spec §9.2)
const db = new Database(':memory:', { strict: true })

// 1) 多语句 exec(SCHEMA_SQL 是多条 CREATE 的脚本,spec §9.7)
try { db.exec(SCHEMA_SQL); check('multi-statement exec(SCHEMA_SQL)', true) }
catch (e) { check('multi-statement exec(SCHEMA_SQL)', false, String(e)) }

// 2) PRAGMA table_info 作为结果集查询返回行(spec §9.7,db.ts hasColumn 依赖)
try {
  const cols = db.query('PRAGMA table_info(sessions)').all() as { name: string }[]
  check('PRAGMA table_info as query', Array.isArray(cols) && cols.some((c) => c.name === 'session_id'), `cols=${cols.length}`)
} catch (e) { check('PRAGMA table_info as query', false, String(e)) }

// 3) 命名参数 @name + strict 绑定(对齐 db.ts upsert/insert 的 @xxx 写法)
try {
  db.query('INSERT INTO meta (schema_version) VALUES (@v)').run({ v: SCHEMA_VERSION })
  const got = db.query('SELECT schema_version FROM meta LIMIT 1').get() as { schema_version: number }
  check('named param @name (strict)', got?.schema_version === SCHEMA_VERSION, JSON.stringify(got))
} catch (e) { check('named param @name (strict)', false, String(e)) }

// 4) 位置参数 ?(对齐 db.ts insertCwdChanges)
try {
  db.query('INSERT INTO cwd_changes (move_id,file_rel,line_no,old_cwd,new_cwd) VALUES (?,?,?,?,?)').run(1, 'a.jsonl', 2, '/old', '/new')
  const got = db.query('SELECT new_cwd FROM cwd_changes WHERE move_id=?').get(1) as { new_cwd: string }
  check('positional params ?', got?.new_cwd === '/new')
} catch (e) { check('positional params ?', false, String(e)) }

// 5) transaction(fn)() 双重调用 + 闭包内同步读 lastInsertRowid(对齐 db.ts insertHistoryRewrite)
try {
  const insert = db.transaction(() => {
    const r = db.query('INSERT INTO history_rewrites (source,old_project,new_project,affected_lines,rewritten_at) VALUES (?,?,?,?,?)')
      .run('claude.json', '/old', '/new', 5, new Date().toISOString())
    const id = Number(r.lastInsertRowid)
    db.query('INSERT INTO history_rewrite_sessions (rewrite_id,session_id) VALUES (?,?)').run(id, 'sess-1')
    return id
  })
  const id = insert()
  const cnt = db.query('SELECT COUNT(*) AS c FROM history_rewrite_sessions WHERE rewrite_id=?').get(id) as { c: number }
  check('transaction(fn)() + closure lastInsertRowid', id > 0 && cnt?.c === 1, `id=${id}`)
} catch (e) { check('transaction(fn)() + closure lastInsertRowid', false, String(e)) }
db.close()

// 6) WAL 需文件库(内存库无 WAL):新建临时文件库,设 WAL 并回读
try {
  const f = join(mkdtempSync(join(tmpdir(), 'bsql-')), 'wal.db')
  const fdb = new Database(f, { strict: true })
  const mode = fdb.query('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
  check('PRAGMA journal_mode = WAL', mode?.journal_mode === 'wal', JSON.stringify(mode))
  fdb.close()
} catch (e) { check('PRAGMA journal_mode = WAL', false, String(e)) }

console.log(pass ? '\n=== bun:sqlite PROBE: ALL PASS ===' : '\n=== bun:sqlite PROBE: HAS FAIL ===')
process.exit(pass ? 0 : 1)
