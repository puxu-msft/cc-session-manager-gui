import { useEffect, useState } from 'react'
import type { ArchiveVersionInfo, ArchiveUsage, RestoreActionResult } from '@shared/types'

const mb = (n: number) => (n / 1e6).toFixed(1) + 'MB'

export function ArchiveTimelineView({ onClose }: { onClose: () => void }) {
  const [versions, setVersions] = useState<ArchiveVersionInfo[]>([])
  const [usage, setUsage] = useState<ArchiveUsage>({ total: 0, backups: 0, byVersion: {} })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string>('')
  const [lastRestoreId, setLastRestoreId] = useState<number | null>(null)

  const load = async () => {
    setVersions(await window.api.archiveAllVersions())
    setUsage(await window.api.archiveUsage())
  }
  useEffect(() => { load() }, [])

  const onRestore = async (versionId: number) => {
    setBusy(true)
    try {
      const r: RestoreActionResult = await window.api.archiveRestore(versionId)
      if (r.status === 'done') { setLastRestoreId(r.restoreId ?? null); setMsg('已还原(原现状已搬入备份区,可撤销)') }
      else { setLastRestoreId(null); setMsg(`未还原:${r.error ?? r.status}`) }
    } catch (e) { setLastRestoreId(null); setMsg(`还原失败:${String(e)}`) }
    setBusy(false); await load()
  }
  const onUndo = async () => {
    if (lastRestoreId == null) return
    setBusy(true)
    try { await window.api.archiveUndoRestore(lastRestoreId); setMsg('已撤销还原(目标恢复为还原前现状)') }
    catch (e) { setMsg(`撤销失败:${String(e)}`) }
    setLastRestoreId(null); setBusy(false); await load()
  }
  const onDelete = async (versionId: number) => {
    if (!confirm('删除该归档版本?删除后该版本无法再还原。')) return
    setBusy(true)
    try { await window.api.archiveDeleteVersion(versionId) } catch (e) { setMsg(`删除失败:${String(e)}`) }
    setBusy(false); await load()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>归档时间线</h3>
        <div className="trash-summary">
          归档库 <b>{mb(usage.total)}</b> · 备份区 <b>{mb(usage.backups)}</b>(无限期保留,可手动删除版本)
        </div>
        {msg && (
          <p className="notice">
            {msg}
            {lastRestoreId != null && <button disabled={busy} onClick={onUndo} style={{ marginLeft: 8 }}>撤销刚才的还原</button>}
          </p>
        )}
        <table className="preview">
          <thead><tr><th>会话</th><th>类型</th><th>标题</th><th>体积</th><th>时间</th><th></th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.versionId}>
                <td title={v.sessionId}>{v.sessionId.slice(0, 8)}</td>
                <td>{v.kind === 'archive' ? '归档' : '快照'}</td>
                <td title={v.sourceCwd}>{v.title}</td>
                <td>{mb(v.compressedBytes)}</td>
                <td>{v.archivedAt?.slice(0, 19).replace('T', ' ')}</td>
                <td className="hist-actions">
                  <button disabled={busy} onClick={() => onRestore(v.versionId)}>还原</button>
                  <button className="danger" disabled={busy} onClick={() => onDelete(v.versionId)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {versions.length === 0 && <p>暂无归档版本。</p>}
        <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
