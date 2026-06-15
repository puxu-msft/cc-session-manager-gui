export function MoveBar({ count, target, onMove, onRefresh }: { count: number; target: string | null; onMove: () => void; onRefresh: () => void }) {
  return (
    <div className="movebar">
      <button onClick={onRefresh}>刷新索引</button>
      <div className="spacer" />
      <button className="primary" disabled={count === 0 || !target} onClick={onMove}>
        移动 {count} 个会话 {target ? `→ ${target}` : ''}
      </button>
    </div>
  )
}
