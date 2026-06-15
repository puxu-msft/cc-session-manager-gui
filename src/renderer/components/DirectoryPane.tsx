import { useState } from 'react'

interface DirectoryPaneProps {
  projects: any[]
  selected: string | null
  onPick: (path: string) => void
}

// 左栏:按真实路径聚合的项目列表,带过滤框(按路径子串过滤)。
export function DirectoryPane({ projects, selected, onPick }: DirectoryPaneProps) {
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const shown = f ? projects.filter((p) => String(p.project_path_abs).toLowerCase().includes(f)) : projects
  return (
    <div className="pane">
      <div className="pane-header">目录 / 项目 ({shown.length}{f ? `/${projects.length}` : ''})</div>
      <input className="filter-input" value={filter} placeholder="过滤项目路径…" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      <ul className="list">
        {shown.map((p) => (
          <li key={p.project_path_abs} className={selected === p.project_path_abs ? 'row sel' : 'row'} onClick={() => onPick(p.project_path_abs)}>
            <div className="row-title">{p.project_path_abs}</div>
            <div className="row-sub">{p.session_count} 会话 · {(p.total_size_bytes / 1e6).toFixed(1)}MB{p.exists_on_disk ? '' : ' · 路径已不存在'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
