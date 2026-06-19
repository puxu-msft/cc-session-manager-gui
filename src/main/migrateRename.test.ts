import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db/db'
import { migrateDir, migrateUserData, migrateSourceData, OLD_APP_NAME } from './migrateRename'

describe('migrateDir', () => {
  it('旧在新无 → rename,返回 true;再跑 no-op', () => {
    const root = mkdtempSync(join(tmpdir(), 'mig-'))
    const oldP = join(root, '.cc-move-trash'); mkdirSync(join(oldP, '3'), { recursive: true })
    const newP = join(root, '.cc-session-manager-trash')
    expect(migrateDir(oldP, newP)).toBe(true)
    expect(existsSync(newP) && !existsSync(oldP)).toBe(true)
    expect(existsSync(join(newP, '3'))).toBe(true)      // 子目录随之搬动
    expect(migrateDir(oldP, newP)).toBe(false)          // 幂等
  })

  it('新已存在 → 不搬(不覆盖),返回 false', () => {
    const root = mkdtempSync(join(tmpdir(), 'mig-'))
    const oldP = join(root, '.cc-move-trash'); mkdirSync(oldP, { recursive: true })
    const newP = join(root, '.cc-session-manager-trash'); mkdirSync(newP, { recursive: true })
    expect(migrateDir(oldP, newP)).toBe(false)
    expect(existsSync(oldP)).toBe(true)                 // 旧目录保留,未被吞
  })
})

describe('migrateUserData', () => {
  it('把旧 app 目录的 index 库搬进新 userData;仅搬新目录尚无的', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cfg-'))
    const oldDir = join(parent, OLD_APP_NAME); mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'index-local.db'), 'L')
    writeFileSync(join(oldDir, 'index-local.db-wal'), 'W')
    writeFileSync(join(oldDir, 'index-windows.db'), 'WIN')
    writeFileSync(join(oldDir, 'unrelated.txt'), 'x')   // 非 index 库,不搬
    const newDir = join(parent, 'cc-session-manager-gui'); mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'index-windows.db'), 'NEWWIN')  // 新已有 → 不覆盖

    migrateUserData(newDir)

    expect(readdirSync(newDir).sort()).toEqual(['index-local.db', 'index-local.db-wal', 'index-windows.db'])
    expect(existsSync(join(newDir, 'index-local.db'))).toBe(true)
    expect(existsSync(join(oldDir, 'index-local.db'))).toBe(false)         // 已搬走
    expect(existsSync(join(oldDir, 'index-windows.db'))).toBe(true)        // 新已有,旧留存(未覆盖)
    expect(existsSync(join(oldDir, 'unrelated.txt'))).toBe(true)           // 非库文件不动
  })

  it('旧 app 目录不存在 → no-op', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cfg-'))
    const newDir = join(parent, 'cc-session-manager-gui'); mkdirSync(newDir, { recursive: true })
    expect(() => migrateUserData(newDir)).not.toThrow()
    expect(readdirSync(newDir)).toEqual([])
  })

  it('legacy 单库 index.db(无后缀)也搬(供 migrateLegacyLocalDb 接力)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cfg-'))
    const oldDir = join(parent, OLD_APP_NAME); mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'index.db'), 'OLD')
    const newDir = join(parent, 'cc-session-manager-gui'); mkdirSync(newDir, { recursive: true })
    migrateUserData(newDir)
    expect(existsSync(join(newDir, 'index.db'))).toBe(true)
    expect(existsSync(join(oldDir, 'index.db'))).toBe(false)
  })
})

describe('migrateSourceData', () => {
  it('rename 三目录 + 重写 backup_path(undoRestore 读它);trash_path 顺手改;幂等', () => {
    const home = mkdtempSync(join(tmpdir(), 'src-'))
    const dot = join(home, '.claude'); mkdirSync(dot, { recursive: true })
    mkdirSync(join(dot, '.cc-move-trash', '7'), { recursive: true })
    mkdirSync(join(dot, '.cc-move-archive'), { recursive: true })
    mkdirSync(join(dot, '.cc-move-backups', '4-s1'), { recursive: true })

    const db = openDb(':memory:')
    // 一条 done 移动,trash_path 存旧绝对路径
    const moveId = db.insertMove({ sessionId: 's1', projectName: 'p', sourceDirAbs: '/x', sourceFolder: '/x/f', sourceCwd: '/x', targetDirAbs: '/y', targetFolder: '/y/f', trashPath: join(dot, '.cc-move-trash', '0'), claudeJsonUpdated: false })
    db.updateMoveStatus(moveId, 'done', { trashPath: join(dot, '.cc-move-trash', String(moveId)) })
    // 一条 done 还原,backup_path 存旧绝对路径
    const restoreId = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: '/x', targetDirAbs: '/y', targetFolder: '/y/f' })
    db.setRestoreBackupPath(restoreId, join(dot, '.cc-move-backups', '4-s1'))

    migrateSourceData(dot, db)

    // 目录已 rename
    expect(existsSync(join(dot, '.cc-session-manager-trash', '7'))).toBe(true)
    expect(existsSync(join(dot, '.cc-session-manager-archive'))).toBe(true)
    expect(existsSync(join(dot, '.cc-session-manager-backups', '4-s1'))).toBe(true)
    expect(existsSync(join(dot, '.cc-move-trash'))).toBe(false)
    // 库内绝对路径前缀已重写
    expect(db.getRestore(restoreId).backupPath).toBe(join(dot, '.cc-session-manager-backups', '4-s1'))
    expect(db.getMoves().find((m: any) => m.id === moveId).trash_path).toBe(join(dot, '.cc-session-manager-trash', String(moveId)))

    // 幂等:再跑不报错、值不变
    migrateSourceData(dot, db)
    expect(db.getRestore(restoreId).backupPath).toBe(join(dot, '.cc-session-manager-backups', '4-s1'))
  })

  it('rename 被跳过(新 backups 已存在)→ 旧目录保留、库不重写(undoRestore 仍走旧路径,不丢)', () => {
    const home = mkdtempSync(join(tmpdir(), 'src-'))
    const dot = join(home, '.claude'); mkdirSync(dot, { recursive: true })
    mkdirSync(join(dot, '.cc-move-backups', '4-s1'), { recursive: true })
    mkdirSync(join(dot, '.cc-session-manager-backups'), { recursive: true })  // 新已存在 → migrateDir 不覆盖、旧保留

    const db = openDb(':memory:')
    const restoreId = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: '/x', targetDirAbs: '/y', targetFolder: '/y/f' })
    const oldBackup = join(dot, '.cc-move-backups', '4-s1')
    db.setRestoreBackupPath(restoreId, oldBackup)

    migrateSourceData(dot, db)

    expect(existsSync(join(dot, '.cc-move-backups', '4-s1'))).toBe(true)      // 旧目录未被吞
    expect(db.getRestore(restoreId).backupPath).toBe(oldBackup)              // 库保持旧路径(备份仍在旧目录,可还原)
  })
})
