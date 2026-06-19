import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { reconcile } from './mover'

// reconcile 的判定不依赖真实会话扫描,只看磁盘上目标/源/回收区文件的存在性,
// 因此用最小世界 + 直接 insertMove 出 pending 行来覆盖两条终态分支。
function base() {
  const home = mkdtempSync(join(tmpdir(), 'home-rec-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const trash = join(home, '.claude', '.cc-session-manager-trash'); mkdirSync(trash, { recursive: true })
  const sourceFolder = join(projects, '-src'); mkdirSync(sourceFolder, { recursive: true })
  const targetFolder = join(projects, '-dst'); mkdirSync(targetFolder, { recursive: true })
  return { home, projects, trash, sourceFolder, targetFolder }
}

describe('reconcile', () => {
  it('目标已就位且源已消失 → 补记 done', () => {
    const w = base(); const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: w.sourceFolder, sourceCwd: '/p', targetDirAbs: '/q', targetFolder: w.targetFolder, trashPath: join(w.trash, '0'), claudeJsonUpdated: false })
    // 目标主文件存在、源主文件不存在 → done 分支
    writeFileSync(join(w.targetFolder, 's1.jsonl'), '{}')

    reconcile({ projectsRoot: w.projects, trashRoot: w.trash, db })

    expect(db.getMoves().find((m) => m.id === id).status).toBe('done')
    expect(db.getPendingMoves()).toEqual([])
  })

  it('目标缺失:把回收区备份搬回源、清理半成品目标、标记 failed', () => {
    const w = base(); const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's2', projectName: '/p', sourceDirAbs: '/p', sourceFolder: w.sourceFolder, sourceCwd: '/p', targetDirAbs: '/q', targetFolder: w.targetFolder, trashPath: join(w.trash, '0'), claudeJsonUpdated: false })
    // 回收区有备份、源缺失、目标主文件缺失(半成品搬移中断) → failed 分支:备份搬回源
    const trashDir = join(w.trash, String(id)); mkdirSync(trashDir, { recursive: true })
    writeFileSync(join(trashDir, 's2.jsonl'), '{"backup":true}')
    const targetMain = join(w.targetFolder, 's2.jsonl')
    const sourceMain = join(w.sourceFolder, 's2.jsonl')
    expect(existsSync(sourceMain)).toBe(false)
    expect(existsSync(targetMain)).toBe(false)

    reconcile({ projectsRoot: w.projects, trashRoot: w.trash, db })

    expect(db.getMoves().find((m) => m.id === id).status).toBe('failed')
    // 备份已搬回源
    expect(existsSync(sourceMain)).toBe(true)
    // 目标主文件仍不存在(rmSync 对不存在路径安全)
    expect(existsSync(targetMain)).toBe(false)
  })
})
