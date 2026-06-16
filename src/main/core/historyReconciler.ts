import { readFileSync } from 'node:fs'
import { readHistory, applyHistoryRewrite, type ApplyOp, type RewriteOp } from './historyJsonl'
import { findSessionFile } from './mover'
import type { Db } from '../db/db'

export interface ReconEnv { db: Db; projectsRoot: string; historyJsonlPath: string }
export interface PlanOp { sessionId: string; oldProject: string; newProject: string; lineNos: number[] }
export interface ReconcilePlan {
  ops: PlanOp[]
  orphans: Array<{ sessionId: string; project: string; lineNos: number[] }>
  ambiguous: Array<{ sessionId: string; projects: string[]; lineNos: number[] }>
  guard: { size: number; mtime: number }
}

// 取会话真实归属 cwd:优先 DB 主键点查;未命中回退文件系统读首个 cwd。定位不到返回 null。
function resolveCwd(env: ReconEnv, sid: string): string | null {
  const fromDb = env.db.getSessionCwd(sid)
  if (fromDb) return fromDb
  const found = findSessionFile(env.projectsRoot, sid)
  if (!found) return null
  return firstCwdOf(found.jsonl)
}

function firstCwdOf(jsonl: string): string | null {
  // 仅在 DB 未命中时的回退路径(正常对账前已 refresh,DB 命中,不走这里)。
  // 同步整读以保持 planReconcile 同步;若担心 100MB+ 会话 jsonl,可改为同步读取文件前缀字节再 split。
  for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line) continue
    try { const o = JSON.parse(line); if (typeof o.cwd === 'string') return o.cwd } catch { /* skip */ }
  }
  return null
}

// 默认对齐:以会话 jsonl 真实首个 cwd 为准,逐 sessionId 判定。
export function planReconcile(env: ReconEnv): ReconcilePlan {
  const h = readHistory(env.historyJsonlPath)
  const bySid = new Map<string, { projects: Map<string, number[]> }>()
  for (const rec of h.lines) {
    const p = rec.parsed
    if (!p || typeof p.sessionId !== 'string') continue
    const proj = typeof p.project === 'string' ? p.project : ''
    const e = bySid.get(p.sessionId) ?? bySid.set(p.sessionId, { projects: new Map() }).get(p.sessionId)!
    ;(e.projects.get(proj) ?? e.projects.set(proj, []).get(proj)!).push(rec.lineNo)
  }

  const plan: ReconcilePlan = { ops: [], orphans: [], ambiguous: [], guard: { size: h.size, mtime: h.mtime } }
  for (const [sid, { projects }] of bySid) {
    const distinct = [...projects.keys()]
    const allLines = distinct.flatMap((p) => projects.get(p)!)
    if (distinct.length > 1 || distinct.some((p) => p === '')) {
      plan.ambiguous.push({ sessionId: sid, projects: distinct, lineNos: allLines }); continue
    }
    const oldProject = distinct[0]
    const cwd = resolveCwd(env, sid)
    if (cwd === null) { plan.orphans.push({ sessionId: sid, project: oldProject, lineNos: allLines }); continue }
    if (cwd === oldProject) continue
    plan.ops.push({ sessionId: sid, oldProject, newProject: cwd, lineNos: allLines })
  }
  return plan
}

// 强制覆盖:把给定 sessionId 的行,按其行内实际旧 project 分组,全部对齐到 targetPath。
export function planForce(env: ReconEnv, sessionIds: string[], targetPath: string): ReconcilePlan {
  const want = new Set(sessionIds)
  const h = readHistory(env.historyJsonlPath)
  const groups = new Map<string, number[]>() // key: sid\0oldProject
  for (const rec of h.lines) {
    const p = rec.parsed
    if (!p || typeof p.sessionId !== 'string' || !want.has(p.sessionId)) continue
    const proj = typeof p.project === 'string' ? p.project : ''
    if (proj === targetPath) continue
    const k = p.sessionId + '\0' + proj
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(rec.lineNo)
  }
  const ops: PlanOp[] = [...groups].map(([k, lineNos]) => {
    const [sessionId, oldProject] = k.split('\0')
    return { sessionId, oldProject, newProject: targetPath, lineNos }
  })
  return { ops, orphans: [], ambiguous: [], guard: { size: h.size, mtime: h.mtime } }
}

// 执行 plan:对 ops 调原子改写(用 plan.guard 做并发检测),把每个聚合 RewriteOp 落一条 history_rewrites。
export function executeReconcile(env: ReconEnv, plan: ReconcilePlan, source: 'auto' | 'force'): RewriteOp[] {
  const applyOps: ApplyOp[] = plan.ops.map((o) => ({ sessionId: o.sessionId, oldProject: o.oldProject, newProject: o.newProject }))
  const result = applyHistoryRewrite(env.historyJsonlPath, applyOps, plan.guard)
  // 多 op 的记录持久化包进一个事务,保证 all-or-nothing(文件已原子改写;记录是 undo 依据,不可只落一半)
  env.db.transaction(() => {
    for (const op of result) {
      env.db.insertHistoryRewrite({ source, oldProject: op.oldProject, newProject: op.newProject, sessionIds: op.sessionIds, affectedLines: op.affectedLines })
    }
  })
  return result
}

// 撤销一条 history_rewrites:把该次涉及的会话中,当前 project 仍等于 new_project 的行改回 old_project。
// 复用 applyHistoryRewrite 的 (sessionId,行内 project===oldProject) 匹配 → 反向 op 的 oldProject 即记录的 new_project。
export function undoRewrite(env: ReconEnv, rewriteId: number): RewriteOp[] {
  const rec = env.db.getHistoryRewrite(rewriteId)
  if (!rec) throw new Error('对账记录不存在')
  const h = readHistory(env.historyJsonlPath)
  const ops: ApplyOp[] = (rec.session_ids as string[]).map((sid) => ({
    sessionId: sid, oldProject: rec.new_project, newProject: rec.old_project,
  }))
  return applyHistoryRewrite(env.historyJsonlPath, ops, { size: h.size, mtime: h.mtime })
}
