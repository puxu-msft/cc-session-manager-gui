import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../db/db'
import { planReconcile } from './historyReconciler'

let dir: string, db: Db
const histPath = () => join(dir, 'history.jsonl')
const projectsRoot = () => join(dir, 'projects')
function env() { return { db, projectsRoot: projectsRoot(), historyJsonlPath: histPath() } as any }
function indexSession(sid: string, cwd: string) {
  db.upsertSession({ sessionId: sid, projectPathAbs: cwd, folderName: '-x', cwd, title: '', firstMessagePreview: '',
    startedAt: null, lastActivityAt: null, messageCount: 0, lineCount: 0, sizeBytes: 0, mtime: 0, gitBranch: null,
    claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: [], hasSidecar: false, subagentCount: 0,
    toolResultsBytes: 0, movedFlag: false, lastMoveId: null } as any)
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rec-')); mkdirSync(projectsRoot(), { recursive: true }); db = openDb(join(dir, 'i.db')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('planReconcile', () => {
  it('history.project 与会话 cwd 不符 → ops', () => {
    indexSession('s1', '/new/p')
    writeFileSync(histPath(), '{"project":"/old/p","sessionId":"s1"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 's1', oldProject: '/old/p', newProject: '/new/p' }))
    expect(plan.orphans).toHaveLength(0)
    expect(plan.ambiguous).toHaveLength(0)
  })

  it('会话定位不到 → orphans(不动)', () => {
    writeFileSync(histPath(), '{"project":"/x","sessionId":"ghost"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toHaveLength(0)
    expect(plan.ambiguous).toHaveLength(0)
    expect(plan.orphans).toContainEqual(expect.objectContaining({ sessionId: 'ghost', project: '/x' }))
  })

  it('DB 未命中 → 回退 findSessionFile + firstCwdOf 读首个 cwd', () => {
    // 不 indexSession,迫使 resolveCwd 走文件系统回退
    mkdirSync(join(projectsRoot(), '-resolved'), { recursive: true })
    writeFileSync(join(projectsRoot(), '-resolved', 'sx.jsonl'), '{"type":"user","cwd":"/resolved","sessionId":"sx"}\n')
    writeFileSync(histPath(), '{"project":"/old","sessionId":"sx"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 'sx', oldProject: '/old', newProject: '/resolved' }))
  })

  it('回退定位到 jsonl 但其中无 cwd → orphans', () => {
    mkdirSync(join(projectsRoot(), '-nocwd'), { recursive: true })
    writeFileSync(join(projectsRoot(), '-nocwd', 'sy.jsonl'), '{"type":"summary","sessionId":"sy"}\n')
    writeFileSync(histPath(), '{"project":"/old","sessionId":"sy"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toHaveLength(0)
    expect(plan.orphans).toContainEqual(expect.objectContaining({ sessionId: 'sy', project: '/old' }))
  })

  it('同 sessionId 多 project → ambiguous(不动)', () => {
    indexSession('s2', '/c')
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s2"}\n{"project":"/b","sessionId":"s2"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toHaveLength(0)
    expect(plan.orphans).toHaveLength(0)
    expect(plan.ambiguous).toContainEqual(expect.objectContaining({ sessionId: 's2', projects: ['/a', '/b'] }))
  })

  it('已对齐则无 ops(幂等)', () => {
    indexSession('s3', '/p')
    writeFileSync(histPath(), '{"project":"/p","sessionId":"s3"}\n')
    expect(planReconcile(env()).ops).toHaveLength(0)
  })

  it('空串 project → ambiguous', () => {
    indexSession('s4', '/p')
    writeFileSync(histPath(), '{"project":"","sessionId":"s4"}\n')
    const plan = planReconcile(env())
    expect(plan.ambiguous).toContainEqual(expect.objectContaining({ sessionId: 's4' }))
  })
})
