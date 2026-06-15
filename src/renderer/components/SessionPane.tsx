import { useState } from 'react'

interface SessionPaneProps {
  sessions: any[]
  selected: Set<string>
  onToggle: (id: string) => void
  onToggleAll: (ids: string[]) => void
}

// 中栏会话列表:过滤框(按标题/预览/id 过滤)、每行显式复选框(单击整行勾选)、表头复选框全选/全不选(作用于当前过滤结果)。
export function SessionPane({ sessions, selected, onToggle, onToggleAll }: SessionPaneProps) {
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const shown = f
    ? sessions.filter((s) => `${s.title ?? ''} ${s.first_message_preview ?? ''} ${s.session_id}`.toLowerCase().includes(f))
    : sessions
  const shownIds = shown.map((s) => s.session_id)
  const allChecked = shown.length > 0 && shownIds.every((id) => selected.has(id))
  const someChecked = shownIds.some((id) => selected.has(id)) && !allChecked

  return (
    <div className="pane">
      <div className="pane-header session-head">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => { if (el) el.indeterminate = someChecked }}
          onChange={() => onToggleAll(shownIds)}
          disabled={shown.length === 0}
          title="全选 / 全不选(当前过滤结果)"
        />
        <span>会话 ({shown.length}{f ? `/${sessions.length}` : ''}) · 已选 {selected.size}</span>
      </div>
      <input className="filter-input" value={filter} placeholder="过滤会话(标题/首条消息/id)…" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      <ul className="list">
        {shown.map((s) => (
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
