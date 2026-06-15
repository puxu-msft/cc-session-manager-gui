import { useEffect, useState } from 'react'
import type { TrashUsage } from '@shared/types'

const mb = (n: number) => (n / 1e6).toFixed(1) + 'MB'

export function HistoryView({ onClose }: { onClose: () => void }) {
  const [moves, setMoves] = useState<any[]>([])
  const [usage, setUsage] = useState<TrashUsage>({ total: 0, byMove: {} })

  const load = async () => {
    setMoves(await window.api.listMoves())
    setUsage(await window.api.trashUsage())
  }
  useEffect(() => { load() }, [])

  const undo = async (id: number) => { await window.api.undoMove(id); await load() }
  const purge = async (id: number) => {
    if (!confirm(`清理第 ${id} 次移动的回收区备份?清理后该次移动将无法撤销。`)) return
    const r = await window.api.purgeTrash(id); setMoves(r.moves); setUsage(r.usage)
  }
  const purgeAll = async () => {
    if (!confirm('清空整个回收区?所有移动都将无法再撤销。')) return
    const r = await window.api.purgeTrash(); setMoves(r.moves); setUsage(r.usage)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>移动历史</h3>
        <div className="trash-summary">
          回收区占用 <b>{mb(usage.total)}</b>(保留备份用于撤销,不会自动清理)
          <button className="danger" disabled={usage.total === 0} onClick={purgeAll}>清空回收区</button>
        </div>
        <table className="preview">
          <thead><tr><th>#</th><th>会话</th><th>源 → 目标</th><th>时间</th><th>状态</th><th>备份</th><th></th></tr></thead>
          <tbody>
            {moves.map((m) => {
              const bytes = usage.byMove[String(m.id)]
              return (
                <tr key={m.id}>
                  <td>{m.id}</td><td>{m.session_id}</td>
                  <td>{m.source_dir_abs} → {m.target_dir_abs}</td>
                  <td>{m.moved_at}</td><td>{m.status}</td>
                  <td>{bytes != null ? mb(bytes) : '—'}</td>
                  <td className="hist-actions">
                    {m.status === 'done' && bytes != null && <button onClick={() => undo(m.id)}>撤销</button>}
                    {bytes != null && <button className="danger" onClick={() => purge(m.id)}>清理</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
