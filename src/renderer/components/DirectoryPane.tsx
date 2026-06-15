export function DirectoryPane({ projects, selected, onPick }: { projects: any[]; selected: string | null; onPick: (p: string) => void }) {
  return (
    <div className="pane">
      <div className="pane-header">目录 / 项目 ({projects.length})</div>
      <ul className="list">
        {projects.map((p) => (
          <li key={p.project_path_abs} className={selected === p.project_path_abs ? 'row sel' : 'row'} onClick={() => onPick(p.project_path_abs)}>
            <div className="row-title">{p.project_path_abs}</div>
            <div className="row-sub">{p.session_count} 会话 · {(p.total_size_bytes/1e6).toFixed(1)}MB{p.exists_on_disk ? '' : ' · 路径已不存在'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
