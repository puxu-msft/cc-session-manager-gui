import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// 索引现有行的最小形状(来自 db.getAllSessionRows;project_path_abs 用于把变化归到具体项目)。
export interface ExistingSessionRow { session_id: string; size_bytes: number; mtime: number; project_path_abs?: string }

// 轻量更新检测的结果:新增/变化/移除的会话计数,以及受影响的项目路径集合(供 UI 在项目旁显示 badge)。
// 注意:added(全新会话文件)无法在不解析 jsonl 的情况下定位其 cwd,故不计入 changedProjects——
// 全新项目在用户做一次全量刷新后才入列。changedProjects 仅覆盖 changed/removed(其 project_path_abs 已在索引中)。
export interface ChangeSummary { added: number; changed: number; removed: number; changedProjects: string[] }

// 轻量检测 ~/.claude/projects 相对索引的变化:只遍历目录 + stat(size/mtime),绝不解析 jsonl 内容。
// 与 diffSessions 同口径(size 或 mtime 变即视为 changed),但成本极低,适合启动时与"检查更新"按钮。
export function detectChanges(projectsRoot: string, existing: ExistingSessionRow[]): ChangeSummary {
  const byId = new Map(existing.map((e) => [e.session_id, e]))
  const seen = new Set<string>()
  const changedProjects = new Set<string>()
  let added = 0
  let changed = 0

  if (existsSync(projectsRoot)) {
    for (const folder of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue
      const fdir = join(projectsRoot, folder.name)
      let entries: string[]
      try { entries = readdirSync(fdir) } catch { continue }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue
        const id = basename(f, '.jsonl')
        seen.add(id)
        let st: ReturnType<typeof statSync>
        try { st = statSync(join(fdir, f)) } catch { continue }
        const e = byId.get(id)
        if (!e) {
          added++ // 全新文件;cwd 未知,不归项目
        } else if (e.size_bytes !== st.size || e.mtime !== st.mtimeMs) {
          changed++
          if (e.project_path_abs) changedProjects.add(e.project_path_abs)
        }
      }
    }
  }

  let removed = 0
  for (const e of existing) {
    if (!seen.has(e.session_id)) {
      removed++
      if (e.project_path_abs) changedProjects.add(e.project_path_abs)
    }
  }

  return { added, changed, removed, changedProjects: [...changedProjects] }
}
