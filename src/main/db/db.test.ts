import { describe, it, expect } from 'vitest'
import { openDb } from './db'

describe('db', () => {
  it('建表并支持 project/session upsert 与查询', () => {
    const db = openDb(':memory:')
    db.upsertProject({ projectPathAbs: '/p', folderName: '-p', existsOnDisk: true, inClaudeJson: false, sessionCount: 1, totalSizeBytes: 10, lastActivityAt: 't' })
    db.upsertSession({ sessionId: 's1', projectPathAbs: '/p', folderName: '-p', cwd: '/p', title: 'T', firstMessagePreview: 'p', startedAt: 't', lastActivityAt: 't', messageCount: 2, lineCount: 3, sizeBytes: 10, mtime: 1, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: ['/p'], hasSidecar: false, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null })
    expect(db.getProjects().length).toBe(1)
    expect(db.getSessions('/p').map((s) => s.sessionId)).toEqual(['s1'])
  })
  it('move 生命周期', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    db.updateMoveStatus(id, 'done')
    expect(db.getMoves()[0].status).toBe('done')
  })
})
