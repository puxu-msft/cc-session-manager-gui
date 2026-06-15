import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { scanSessionFile } from './jsonlScanner'

// 遍历 ~/.claude/projects 全部项目文件夹,对每个 <id>.jsonl 调 scanSessionFile,按真实 cwd 聚合成 ProjectMeta。坏文件跳过不抛
export async function scanAll(projectsRoot: string): Promise<{ projects: ProjectMeta[]; sessions: SessionMeta[] }> {
  const sessions: SessionMeta[] = []
  if (!existsSync(projectsRoot)) return { projects: [], sessions: [] }
  for (const folder of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const fdir = join(projectsRoot, folder.name)
    for (const f of readdirSync(fdir)) {
      if (!f.endsWith('.jsonl')) continue
      try { sessions.push(await scanSessionFile(join(fdir, f))) } catch { /* 跳过坏文件 */ }
    }
  }
  const byProject = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    if (!s.cwd) continue
    ;(byProject.get(s.cwd) ?? byProject.set(s.cwd, []).get(s.cwd)!).push(s)
  }
  const projects: ProjectMeta[] = [...byProject.entries()].map(([cwd, ss]) => ({
    projectPathAbs: cwd, folderName: ss[0].folderName, existsOnDisk: existsSync(cwd), inClaudeJson: false,
    sessionCount: ss.length, totalSizeBytes: ss.reduce((a, s) => a + s.sizeBytes, 0),
    lastActivityAt: ss.map((s) => s.lastActivityAt).filter(Boolean).sort().pop() ?? null,
  }))
  return { projects, sessions }
}

export interface IndexDiff { added: string[]; removed: string[]; changed: string[] }

// 将新扫描结果与 DB 现有行做 diff:新增/移除/变化,变化以 size+mtime 判定
export function diffSessions(fresh: SessionMeta[], existing: { session_id: string; size_bytes: number; mtime: number }[]): IndexDiff {
  const byId = new Map(existing.map((e) => [e.session_id, e]))
  const freshIds = new Set(fresh.map((s) => s.sessionId))
  const added: string[] = [], changed: string[] = []
  for (const s of fresh) {
    const e = byId.get(s.sessionId)
    if (!e) added.push(s.sessionId)
    else if (e.size_bytes !== s.sizeBytes || e.mtime !== s.mtime) changed.push(s.sessionId)
  }
  const removed = existing.filter((e) => !freshIds.has(e.session_id)).map((e) => e.session_id)
  return { added, removed, changed }
}
