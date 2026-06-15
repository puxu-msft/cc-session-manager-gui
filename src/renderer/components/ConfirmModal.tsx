import type { MovePreview } from '@shared/types'
export function ConfirmModal({ preview, onCancel, onConfirm }: { preview: MovePreview; onCancel: () => void; onConfirm: () => void }) {
  const movable = preview.items.filter((i) => !i.blocked)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>确认移动 → {preview.targetPathAbs}</h3>
        <p>{preview.claudeJsonWillAddEntry ? '将为目标新增 ~/.claude.json projects 条目' : '目标已是已知项目'}</p>
        <table className="preview">
          <thead><tr><th>会话</th><th>cwd 改写</th><th>sidecar</th><th>回收区备份</th><th>状态</th></tr></thead>
          <tbody>
            {preview.items.map((i) => (
              <tr key={i.sessionId} className={i.blocked ? 'blocked' : ''}>
                <td>{i.title}</td><td>{i.structuralCwdFields}</td>
                <td>{(i.toolResultsBytes/1e6).toFixed(1)}MB</td>
                <td>{(i.trashBackupBytes/1e6).toFixed(1)}MB</td>
                <td>{i.blocked ? `⛔ ${i.blockReason}` : '✓ 可移动'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={movable.length === 0} onClick={onConfirm}>执行移动 {movable.length} 个</button>
        </div>
      </div>
    </div>
  )
}
