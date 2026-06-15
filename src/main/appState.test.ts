import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyLocalDb } from './appState'

describe('migrateLegacyLocalDb', () => {
  it('旧 index.db(含 -wal/-shm)改名为 index-local.db,内容保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'))
    writeFileSync(join(dir, 'index.db'), 'DBDATA')
    writeFileSync(join(dir, 'index.db-wal'), 'WAL')
    writeFileSync(join(dir, 'index.db-shm'), 'SHM')

    migrateLegacyLocalDb(dir)

    expect(existsSync(join(dir, 'index.db'))).toBe(false)
    expect(readFileSync(join(dir, 'index-local.db'), 'utf8')).toBe('DBDATA')
    expect(readFileSync(join(dir, 'index-local.db-wal'), 'utf8')).toBe('WAL')
    expect(readFileSync(join(dir, 'index-local.db-shm'), 'utf8')).toBe('SHM')
  })

  it('若 index-local.db 已存在则不迁移(不覆盖)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'))
    writeFileSync(join(dir, 'index.db'), 'OLD')
    writeFileSync(join(dir, 'index-local.db'), 'NEW')

    migrateLegacyLocalDb(dir)

    expect(readFileSync(join(dir, 'index-local.db'), 'utf8')).toBe('NEW') // 未被覆盖
    expect(existsSync(join(dir, 'index.db'))).toBe(true) // 旧库原样保留
  })

  it('无旧库时是无操作', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'))
    mkdirSync(join(dir, 'x'))
    migrateLegacyLocalDb(dir)
    expect(existsSync(join(dir, 'index-local.db'))).toBe(false)
  })
})
