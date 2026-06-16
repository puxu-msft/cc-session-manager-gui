import { useEffect, useState } from 'react'
import { reconcileSummary, isLossyForce } from '../lib/reconcileView'

export function HistoryReconcileView({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [plan, setPlan] = useState<any>(null)
  const [rewrites, setRewrites] = useState<any[]>([])
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setErr(null)
    try {
      setPlan(await window.api.planHistory())
      setRewrites(await window.api.listHistoryRewrites())
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  useEffect(() => { load() }, [])

  const guard = async (fn: () => Promise<void>) => {
    setErr(null)
    try { await fn(); await load(); onChanged?.() } catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  const runAuto = () => guard(() => window.api.reconcileHistory('auto'))
  const runForce = (sid: string, projects: string[]) => {
    const target = (targets[sid] ?? '').trim()
    if (!target) return
    if (isLossyForce(projects) && !confirm(`会话 ${sid.slice(0, 8)} 在历史里有多个不同 project,强制并到单一路径后撤销将有损(无法精确还原各自旧值)。确认?`)) return
    return guard(() => window.api.reconcileHistory('force', [sid], target))
  }
  const undo = (id: number) => guard(() => window.api.undoHistoryRewrite(id))
  const setTgt = (sid: string, v: string) => setTargets((t) => ({ ...t, [sid]: v }))

  const s = plan ? reconcileSummary(plan) : null
  const manual = plan ? [
    ...plan.ambiguous.map((a: any) => ({ sessionId: a.sessionId, projects: a.projects, kind: isLossyForce(a.projects) ? '多值(force 有损)' : '含空串' })),
    ...plan.orphans.map((o: any) => ({ sessionId: o.sessionId, projects: [o.project], kind: '孤儿(会话不存在)' })),
  ] : []

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>History 对账</h3>
        {err && <p className="rec-err">{err}</p>}
        {s && (
          <div className="rec-summary">
            待对齐 <b>{s.opsLines}</b> 行({s.opsCount} 会话) · 需人工 <b>{s.manualLines}</b> 行
            <button className="primary" disabled={s.opsCount === 0} onClick={runAuto}>一键对齐</button>
          </div>
        )}
        {plan?.ops?.length > 0 && (
          <>
            <h4>待对齐(以会话真实 cwd 为准)</h4>
            <table className="preview">
              <thead><tr><th>会话</th><th>旧 project → 新</th><th>行数</th></tr></thead>
              <tbody>{plan.ops.map((o: any) => (
                <tr key={o.sessionId + o.oldProject}><td>{o.sessionId.slice(0, 8)}</td><td>{o.oldProject} → {o.newProject}</td><td>{o.lineNos.length}</td></tr>
              ))}</tbody>
            </table>
          </>
        )}
        {manual.length > 0 && (
          <>
            <h4>需人工处理(列出不动,可就地强制)</h4>
            <table className="preview">
              <thead><tr><th>会话</th><th>当前 project</th><th>类型</th><th>强制对齐到</th></tr></thead>
              <tbody>{manual.map((m) => (
                <tr key={m.sessionId}>
                  <td>{m.sessionId.slice(0, 8)}</td><td>{m.projects.join(' , ')}</td><td>{m.kind}</td>
                  <td className="rec-force">
                    <input value={targets[m.sessionId] ?? ''} placeholder="目标绝对路径" onChange={(e) => setTgt(m.sessionId, e.target.value)} />
                    <button onClick={() => runForce(m.sessionId, m.projects)}>强制</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
        <h4>对账记录</h4>
        <table className="preview">
          <thead><tr><th>#</th><th>来源</th><th>旧 → 新</th><th>行数</th><th>时间</th><th></th></tr></thead>
          <tbody>{rewrites.map((r: any) => (
            <tr key={r.id}><td>{r.id}</td><td>{r.source}</td><td>{r.old_project} → {r.new_project}</td><td>{r.affected_lines}</td><td>{r.rewritten_at}</td><td><button onClick={() => undo(r.id)}>撤销</button></td></tr>
          ))}</tbody>
        </table>
        <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
