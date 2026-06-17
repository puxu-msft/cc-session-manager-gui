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
    d.pragma('journal_mode = WAL')
    d.exec('CREATE TABLE t (a TEXT, b INTEGER)')
    const cols = (d.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['a', 'b'])
    d.close()
  })
})
