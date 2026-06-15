interface SessionPaneProps {
  sessions: any[]
  selected: Set<string>
  onToggle: (id: string) => void
  onToggleAll: () => void
}

// 中栏会话列表:每行显式复选框,单击整行即勾选/取消;表头复选框可全选/全不选(部分选中显示半选态)。
export function SessionPane({ sessions, selected, onToggle, onToggleAll }: SessionPaneProps) {
  const allChecked = sessions.length > 0 && selected.size === sessions.length
  const someChecked = selected.size > 0 && !allChecked
  return (
    <div className="pane">
      <div className="pane-header session-head">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => { if (el) el.indeterminate = someChecked }}
          onChange={onToggleAll}
          disabled={sessions.length === 0}
          title="全选 / 全不选"
        />
        <span>会话 ({sessions.length}) · 已选 {selected.size}</span>
      </div>
      <ul className="list">
        {sessions.map((s) => (
          <li
            key={s.session_id}
            className={selected.has(s.session_id) ? 'row sel sess-row' : 'row sess-row'}
            onClick={() => onToggle(s.session_id)}
          >
            <input type="checkbox" className="sess-check" checked={selected.has(s.session_id)} readOnly tabIndex={-1} />
            <div className="sess-body">
              <div className="row-title">{s.title || s.first_message_preview || s.session_id}</div>
              <div className="row-sub">{s.message_count} 条 · {(s.size_bytes / 1e6).toFixed(1)}MB · {s.last_activity_at ?? ''}{s.moved_flag ? ' · 已移动' : ''}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
