export function MoveBar({ count, target, onMove, onRefresh, onHistory }: { count: number; target: string | null; onMove: () => void; onRefresh: () => void; onHistory?: () => void }) {
  return (
    <div className="movebar">
      <button onClick={onRefresh}>刷新索引</button>
      {onHistory && <button onClick={onHistory}>历史</button>}
      <div className="spacer" />
      <button className="primary" disabled={count === 0 || !target} onClick={onMove}>
        移动 {count} 个会话 {target ? `→ ${target}` : ''}
      </button>
    </div>
  )
}
