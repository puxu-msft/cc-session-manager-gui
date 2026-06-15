import { useEffect, useState } from 'react'

export function HistoryView({ onClose }: { onClose: () => void }) {
  const [moves, setMoves] = useState<any[]>([])
  const load = async () => setMoves(await window.api.listMoves())
  useEffect(() => { load() }, [])
  const undo = async (id: number) => { await window.api.undoMove(id); await load() }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>移动历史</h3>
        <table className="preview">
          <thead><tr><th>#</th><th>会话</th><th>源 → 目标</th><th>时间</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td><td>{m.session_id}</td>
                <td>{m.source_dir_abs} → {m.target_dir_abs}</td>
                <td>{m.moved_at}</td><td>{m.status}</td>
                <td>{m.status === 'done' && <button onClick={() => undo(m.id)}>撤销</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
