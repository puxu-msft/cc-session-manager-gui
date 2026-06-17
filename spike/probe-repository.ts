// 运行:bun run spike/probe-repository.ts(在项目根)
// 验证:共享 createRepository 在 bun:sqlite 驱动下行为与 better-sqlite3 等价(Phase 2 DB / 1d 双 driver 核心)。
import { BunSqliteDriver } from '../src/main/platform/electrobun/sqliteDriver'
import { createRepository } from '../src/main/db/repository'

let pass = true
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) pass = false
}

const db = createRepository(new BunSqliteDriver(':memory:'))

// 1) upsert project/session(命名参数 @name + 布尔→0/1)
db.upsertProject({ projectPathAbs: '/p', folderName: '-p', existsOnDisk: true, inClaudeJson: false, sessionCount: 1, totalSizeBytes: 10, lastActivityAt: 't' })
db.upsertSession({ sessionId: 's1', projectPathAbs: '/p', folderName: '-p', cwd: '/p', title: 'T', firstMessagePreview: 'p', startedAt: 't', lastActivityAt: 't', messageCount: 2, lineCount: 3, sizeBytes: 10, mtime: 1, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: ['/p'], hasSidecar: false, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null })
check('upsert + getProjects', db.getProjects().length === 1)
check('getSessions 映射 sessionId', db.getSessions('/p')[0]?.sessionId === 's1')

// 2) move 生命周期(位置参数 ? + COALESCE + lastInsertRowid)
const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
db.updateMoveStatus(id, 'done')
check('move lifecycle + claude_json_updated=0', db.getMoves()[0]?.status === 'done' && db.getMoves()[0]?.claude_json_updated === 0, `id=${id}`)

// 3) transaction(fn)() 闭包内同步 lastInsertRowid + 旁表
const rid = db.insertHistoryRewrite({ source: 'auto', oldProject: '/a', newProject: '/b', sessionIds: ['s1', 's2'], affectedLines: 3 })
const rec = db.getHistoryRewrite(rid)
check('history rewrite 事务 + 旁表 sids', rec?.old_project === '/a' && new Set(rec?.session_ids).size === 2, `rid=${rid}`)

// 4) archive version(pending→complete,compressed_bytes 映射)
const vid = db.insertArchiveVersion({ sessionId: 's1', kind: 'snapshot', projectPathAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', title: 'h', jsonlSizeBytes: 10, sidecarBytes: 0, compressedBytes: 5, hasSidecar: false, subagentCount: 0, lineCount: 2 })
db.setArchiveVersionStatus(vid, 'complete')
const av = db.getArchiveVersion(vid)
check('archive version status/compressedBytes', av?.status === 'complete' && av?.compressedBytes === 5)

// 5) 布尔反向取值编码
db.upsertProject({ projectPathAbs: '/q', folderName: '-q', existsOnDisk: false, inClaudeJson: true, sessionCount: 0, totalSizeBytes: 0, lastActivityAt: null })
const q = db.getProjects().find((x: any) => x.project_path_abs === '/q')
check('boolean 0/1 编码', q?.exists_on_disk === 0 && q?.in_claude_json === 1)

db.close()
console.log(pass ? '\n=== repository on bun:sqlite: ALL PASS(与 better-sqlite3 行为等价)===' : '\n=== repository on bun:sqlite: HAS FAIL ===')
process.exit(pass ? 0 : 1)
