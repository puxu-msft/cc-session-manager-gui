import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { scanSessionFile } from './jsonlScanner'

// scanAll 的可选项:
// - reuse:给定 (sessionId, size, mtime),若该文件自上次索引未变则返回缓存的 SessionMeta,从而跳过昂贵的逐行流式解析;返回 null 则照常解析。
// - onProgress:每处理完一个文件回调 (已完成数, 总数, 当前文件路径),用于 UI 进度上报。
// - signal:AbortSignal,用于在退出或用户取消时中断进行中的扫描(在文件边界检查)。
export interface ScanOptions {
  reuse?: (sessionId: string, sizeBytes: number, mtime: number) => SessionMeta | null
  onProgress?: (done: number, total: number, path: string) => void
  signal?: AbortSignal
}

function abortError(): Error {
  const e = new Error('扫描已中断')
  e.name = 'AbortError'
  return e
}

// 遍历 ~/.claude/projects 全部项目文件夹,对每个 <id>.jsonl 提取元数据,按真实 cwd 聚合成 ProjectMeta。
// 先枚举全部文件以得到总数(便于进度),再逐个处理:能复用的跳过解析,坏文件跳过不抛,支持中断。
export async function scanAll(projectsRoot: string, opts: ScanOptions = {}): Promise<{ projects: ProjectMeta[]; sessions: SessionMeta[] }> {
  if (!existsSync(projectsRoot)) return { projects: [], sessions: [] }

  const files: string[] = []
  for (const folder of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const fdir = join(projectsRoot, folder.name)
    let entries: string[]
    try { entries = readdirSync(fdir) } catch { continue }
    for (const f of entries) if (f.endsWith('.jsonl')) files.push(join(fdir, f))
  }

  const total = files.length
  const sessions: SessionMeta[] = []
  let done = 0
  for (const path of files) {
    if (opts.signal?.aborted) throw abortError()
    try {
      let meta: SessionMeta | null = null
      if (opts.reuse) {
        const st = statSync(path)
        meta = opts.reuse(basename(path).replace(/\.jsonl$/, ''), st.size, st.mtimeMs)
      }
      if (!meta) meta = await scanSessionFile(path)
      sessions.push(meta)
    } catch { /* 跳过坏文件 */ }
    done++
    opts.onProgress?.(done, total, path)
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
