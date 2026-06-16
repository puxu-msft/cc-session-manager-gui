import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../db/db'
import { planReconcile, planForce, executeReconcile, undoRewrite } from './historyReconciler'

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

describe('planForce', () => {
  it('把指定会话的行按实际旧 project 分组,全部指向 targetPath', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s"}\n{"project":"/b","sessionId":"s"}\n{"project":"/z","sessionId":"other"}\n')
    const plan = planForce(env(), ['s'], '/target')
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 's', oldProject: '/a', newProject: '/target' }))
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 's', oldProject: '/b', newProject: '/target' }))
    expect(plan.ops.some((o) => o.sessionId === 'other')).toBe(false)
  })
  it('已等于 targetPath 的行不产生 op', () => {
    writeFileSync(histPath(), '{"project":"/target","sessionId":"s"}\n')
    expect(planForce(env(), ['s'], '/target').ops).toHaveLength(0)
  })
})

describe('executeReconcile', () => {
  it('执行 plan.ops 改写并落 DB 记录', () => {
    indexSession('s1', '/new')
    writeFileSync(histPath(), '{"project":"/old","sessionId":"s1"}\n')
    const plan = planReconcile(env())
    const ops = executeReconcile(env(), plan, 'auto')
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/new"')
    expect(ops).toContainEqual(expect.objectContaining({ oldProject: '/old', newProject: '/new', affectedLines: 1 }))
    const recs = db.getHistoryRewrites()
    expect(recs[0]).toMatchObject({ source: 'auto', old_project: '/old', new_project: '/new', affected_lines: 1 })
    expect(recs[0].session_ids).toContain('s1')
  })
})

describe('undoRewrite', () => {
  it('把记录的 new_project 行改回 old_project', () => {
    writeFileSync(histPath(), '{"project":"/new","sessionId":"s1"}\n')
    const id = db.insertHistoryRewrite({ source: 'auto', oldProject: '/old', newProject: '/new', sessionIds: ['s1'], affectedLines: 1 })
    undoRewrite(env(), id)
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/old"')
  })

  it('auto→undo 往返:project 值复原(A/B 两会话各自还原各自旧值)', () => {
    // 两个不同 sessionId 各持一个旧 project,一起强制对齐到 /c。
    // undo 按 (sessionId,行内 project===new_project) 匹配,故各自精确还原 —
    // 若复用同一 sessionId 把 /a、/b 都并到 /c,正向已把两个旧值塌缩成一个值,
    // 值级反向无从区分,不可逆(这是该撤销策略的固有边界)。
    indexSession('sa', '/c'); indexSession('sb', '/c')
    writeFileSync(histPath(), '{"project":"/a","sessionId":"sa"}\n{"project":"/b","sessionId":"sb"}\n')
    const fplan = planForce(env(), ['sa', 'sb'], '/c')
    executeReconcile(env(), fplan, 'force')
    expect(readFileSync(histPath(), 'utf8').match(/\/c/g)).toHaveLength(2)
    for (const rec of db.getHistoryRewrites()) undoRewrite(env(), rec.id)
    const after = readFileSync(histPath(), 'utf8')
    expect(after).toContain('"project":"/a"')
    expect(after).toContain('"project":"/b"')
  })

  it('已知边界:同一 sessionId 多 project 强制并到单一 target 后 undo 有损(锁定该行为)', () => {
    // force 把同一 sessionId 的 /a、/b 两行都并到 /c → 正向已把两个旧值塌缩成同一值。
    // 值级反向(按 sessionId+当前 project 匹配)无从区分原属 /a 还是 /b,故 undo 不可逆。
    // auto 永不触发此情形(多 project 会走 ambiguous 不动);仅在用户显式 force 多 project 会话时发生。
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s"}\n{"project":"/b","sessionId":"s"}\n')
    executeReconcile(env(), planForce(env(), ['s'], '/c'), 'force')
    expect(readFileSync(histPath(), 'utf8').match(/\/c/g)).toHaveLength(2)
    for (const rec of db.getHistoryRewrites()) undoRewrite(env(), rec.id)
    const projects = [...readFileSync(histPath(), 'utf8').matchAll(/"project":"([^"]*)"/g)].map((m) => m[1])
    expect(projects[0]).toBe(projects[1]) // 两行塌缩为同一值
    expect(projects.includes('/a') && projects.includes('/b')).toBe(false) // 无法同时还原 /a 与 /b
  })
})
