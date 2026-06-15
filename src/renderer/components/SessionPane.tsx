export function SessionPane({ sessions, selected, onToggle }: { sessions: any[]; selected: Set<string>; onToggle: (id: string, multi: boolean) => void }) {
  return (
    <div className="pane">
      <div className="pane-header">会话 ({sessions.length}) · 已选 {selected.size}</div>
      <ul className="list">
        {sessions.map((s) => (
          <li key={s.session_id} className={selected.has(s.session_id) ? 'row sel' : 'row'} onClick={(e) => onToggle(s.session_id, e.ctrlKey || e.metaKey)}>
            <div className="row-title">{s.title || s.first_message_preview || s.session_id}</div>
            <div className="row-sub">{s.message_count} 条 · {(s.size_bytes/1e6).toFixed(1)}MB · {s.last_activity_at ?? ''}{s.moved_flag ? ' · 已移动' : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
