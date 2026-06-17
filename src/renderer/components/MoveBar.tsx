import type { RefreshProgress, UpdateSummary } from '@shared/types'

interface MoveBarProps {
  count: number
  target: string | null
  refreshing?: boolean
  progress?: RefreshProgress | null
  onMove: () => void
  onRefresh: () => void
  onHistory?: () => void
  onReconcile?: () => void
  reconcilePending?: number
  onOpenArchive?: () => void
  onSnapshot?: () => void
  onArchive?: () => void
  updates?: UpdateSummary | null
  onCheckUpdates?: () => void
  selectedProject?: string | null
  onRefreshProject?: (p: string) => void
}

export function MoveBar({ count, target, refreshing, progress, onMove, onRefresh, onHistory, onReconcile, reconcilePending, onOpenArchive, onSnapshot, onArchive, updates, onCheckUpdates, selectedProject, onRefreshProject }: MoveBarProps) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const updateCount = updates ? updates.added + updates.changed + updates.removed : 0
  return (
    <div className="movebar">
      <button onClick={onRefresh} disabled={refreshing}>
        {refreshing ? `扫描中 ${progress?.done ?? 0}/${progress?.total ?? 0} (${pct}%)` : '刷新索引'}
      </button>
      {refreshing && <div className="progress"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>}
      {onCheckUpdates && <button onClick={onCheckUpdates} disabled={refreshing}>检查更新</button>}
      {selectedProject && onRefreshProject && (
        <button onClick={() => onRefreshProject(selectedProject)} disabled={refreshing} title={`仅重扫 ${selectedProject}`}>仅刷新此项目</button>
      )}
      {updateCount > 0 && updates && (
        <span className="update-notice" title="可点刷新索引做全量,或对有标记的项目单独刷新">
          检测到更新:{updates.added ? `新增 ${updates.added} ` : ''}{updates.changed ? `变更 ${updates.changed} ` : ''}{updates.removed ? `移除 ${updates.removed}` : ''}
        </span>
      )}
      {onHistory && <button onClick={onHistory} disabled={refreshing}>历史</button>}
      {onReconcile && (
        <button onClick={onReconcile} disabled={refreshing}>
          对账{reconcilePending ? <span className="badge">{reconcilePending}</span> : null}
        </button>
      )}
      {onOpenArchive && <button onClick={onOpenArchive} disabled={refreshing}>归档时间线</button>}
      <div className="spacer" />
      {onSnapshot && (
        <button disabled={count === 0 || refreshing} onClick={onSnapshot}>
          快照 {count || ''}
        </button>
      )}
      {onArchive && (
        <button disabled={count === 0 || refreshing} onClick={onArchive}>
          归档 {count || ''}
        </button>
      )}
      <button className="primary" disabled={count === 0 || !target || refreshing} onClick={onMove}>
        移动 {count} 个会话 {target ? `→ ${target}` : ''}
      </button>
    </div>
  )
}
