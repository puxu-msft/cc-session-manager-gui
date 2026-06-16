import { readFileSync } from 'node:fs'
import { readHistory } from './historyJsonl'
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
