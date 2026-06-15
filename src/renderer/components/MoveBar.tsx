import type { RefreshProgress } from '@shared/types'

interface MoveBarProps {
  count: number
  target: string | null
  refreshing?: boolean
  progress?: RefreshProgress | null
  onMove: () => void
  onRefresh: () => void
  onHistory?: () => void
}

export function MoveBar({ count, target, refreshing, progress, onMove, onRefresh, onHistory }: MoveBarProps) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div className="movebar">
      <button onClick={onRefresh} disabled={refreshing}>
        {refreshing ? `扫描中 ${progress?.done ?? 0}/${progress?.total ?? 0} (${pct}%)` : '刷新索引'}
      </button>
      {refreshing && <div className="progress"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>}
      {onHistory && <button onClick={onHistory} disabled={refreshing}>历史</button>}
      <div className="spacer" />
      <button className="primary" disabled={count === 0 || !target || refreshing} onClick={onMove}>
        移动 {count} 个会话 {target ? `→ ${target}` : ''}
      </button>
    </div>
  )
}
