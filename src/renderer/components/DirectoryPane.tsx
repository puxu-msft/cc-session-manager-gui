import { useState } from 'react'

interface DirectoryPaneProps {
  projects: any[]
  selected: string | null
  onPick: (path: string) => void
  changedProjects?: string[]
  onRefreshProject?: (path: string) => void
}

// 左栏:按真实路径聚合的项目列表,带过滤框(按路径子串过滤)。
// 有变化的项目(changedProjects)高亮并显示 ● 标记 + 行内"仅刷新此项目"入口。
export function DirectoryPane({ projects, selected, onPick, changedProjects = [], onRefreshProject }: DirectoryPaneProps) {
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const shown = f ? projects.filter((p) => String(p.project_path_abs).toLowerCase().includes(f)) : projects
  const changed = new Set(changedProjects)
  return (
    <div className="pane">
      <div className="pane-header">目录 / 项目 ({shown.length}{f ? `/${projects.length}` : ''})</div>
      <input className="filter-input" value={filter} placeholder="过滤项目路径…" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      <ul className="list">
        {shown.map((p) => {
          const isChanged = changed.has(p.project_path_abs)
          const cls = (selected === p.project_path_abs ? 'row sel' : 'row') + (isChanged ? ' changed' : '')
          return (
            <li key={p.project_path_abs} className={cls} onClick={() => onPick(p.project_path_abs)}>
              <div className="row-title">
                {isChanged && <span className="change-dot" title="检测到该项目有更新">●</span>}
                {p.project_path_abs}
                {onRefreshProject && (
                  <button className="row-refresh" title="仅刷新此项目" onClick={(e) => { e.stopPropagation(); onRefreshProject(p.project_path_abs) }}>↻</button>
                )}
              </div>
              <div className="row-sub">{p.session_count} 会话 · {(p.total_size_bytes / 1e6).toFixed(1)}MB{p.exists_on_disk ? '' : ' · 路径已不存在'}</div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
