import { useEffect, useState } from 'react'
import type { ArchiveActionResult } from '@shared/types'
import { useAppState } from './state'
import { DirectoryPane } from './components/DirectoryPane'
import { SessionPane } from './components/SessionPane'
import { FsBrowserPane } from './components/FsBrowserPane'
import { MoveBar } from './components/MoveBar'
import { ConfirmModal } from './components/ConfirmModal'
import { HistoryView } from './components/HistoryView'
import { HistoryReconcileView } from './components/HistoryReconcileView'
import { ArchiveTimelineView } from './components/ArchiveTimelineView'
import './styles.css'

// 把归档/快照批量结果汇总成一句非阻塞提示(对齐 HistoryReconcileView 的 msg 文本反馈)
function summarizeArchiveResults(label: string, res: ArchiveActionResult[]): string {
  const done = res.filter((r) => r.status === 'done').length
  const skipped = res.filter((r) => r.status === 'skipped')
  const failed = res.filter((r) => r.status === 'failed')
  const parts = [`${label}:成功 ${done}`]
  if (skipped.length) parts.push(`跳过 ${skipped.length}`)
  if (failed.length) parts.push(`失败 ${failed.length}`)
  const firstErr = (skipped[0] ?? failed[0])?.error
  return parts.join(' · ') + (firstErr ? `(${firstErr})` : '')
}

export function App() {
  const st = useAppState()
  const [showHistory, setShowHistory] = useState(false)
  const [showReconcile, setShowReconcile] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  useEffect(() => { st.loadCanDetectWsl(); st.loadSources().then(() => st.refreshSources()); st.loadIndex(); st.browse(''); st.loadReconcilePending(); st.checkUpdates() }, [])

  const toggle = (id: string) => {
    const next = new Set(st.selectedSessions)
    if (next.has(id)) next.delete(id); else next.add(id)
    st.setSelectedSessions(next)
  }
  const toggleAll = (ids: string[]) => {
    const allSelected = ids.length > 0 && ids.every((id) => st.selectedSessions.has(id))
    const next = new Set(st.selectedSessions)
    if (allSelected) ids.forEach((id) => next.delete(id))
    else ids.forEach((id) => next.add(id))
    st.setSelectedSessions(next)
  }
  const startMove = async () => st.setPreview(await window.api.previewMove([...st.selectedSessions], st.targetDir!))
  const confirmMove = async () => {
    await window.api.executeMove([...st.selectedSessions], st.targetDir!)
    st.setPreview(null); st.setSelectedSessions(new Set())
    await st.refresh(); st.loadReconcilePending(); if (st.selectedProject) st.pickProject(st.selectedProject)
  }
  // 归档操作后的索引刷新序列,照搬 confirmMove(清选中 + refresh + 对账 + 重载当前 project)
  const refreshAfterArchive = async () => {
    st.setSelectedSessions(new Set())
    await st.refresh(); st.loadReconcilePending(); if (st.selectedProject) st.pickProject(st.selectedProject)
  }
  const onSnapshot = async () => {
    const ids = [...st.selectedSessions]
    if (ids.length === 0) return
    setActionMsg(null)
    const res = await window.api.archiveSnapshot(ids)
    setActionMsg(summarizeArchiveResults('快照', res))
    await refreshAfterArchive()
  }
  const onArchive = async () => {
    const ids = [...st.selectedSessions]
    if (ids.length === 0) return
    // ConfirmModal 强绑 MovePreview 无法复用;沿用代码库现有的原生 confirm 轻确认(HistoryReconcileView 同款),强调会移除原件
    if (!confirm(`将归档 ${ids.length} 个会话:从活动列表移除原件并收进归档库(可在归档时间线还原)。确认?`)) return
    setActionMsg(null)
    const res = await window.api.archiveArchive(ids)
    setActionMsg(summarizeArchiveResults('归档', res))
    await refreshAfterArchive()
  }

  return (
    <div className="app">
      {st.appUpdate && ['available', 'progress', 'downloaded', 'error'].includes(st.appUpdate.kind) && (
        <p className="notice updatebar">
          {st.appUpdate.kind === 'available' && `发现新版本 ${st.appUpdate.version ?? ''},正在后台下载…`}
          {st.appUpdate.kind === 'progress' && `下载更新中… ${st.appUpdate.percent ?? 0}%`}
          {st.appUpdate.kind === 'downloaded' && (
            <>新版本 {st.appUpdate.version ?? ''} 已就绪。<button className="src" onClick={() => st.installUpdate()}>安装并重启</button></>
          )}
          {st.appUpdate.kind === 'error' && `应用更新失败:${st.appUpdate.message ?? ''}`}
        </p>
      )}
      {(st.canDetectWsl || st.sources.length > 1 || st.detectingSources) && (
        <div className="sourcebar">
          <span className="src-label">数据源</span>
          {st.sources.map((s) => (
            <button
              key={s.id}
              className={s.id === st.activeSource ? 'src sel' : 'src'}
              disabled={!s.exists || st.refreshing}
              onClick={async () => { await st.switchSource(s.id); st.loadReconcilePending() }}
              title={s.projectsRoot + (s.exists ? '' : '(不存在)')}
            >
              {s.label}{s.exists ? '' : '(无)'}
            </button>
          ))}
          {st.canDetectWsl && (
            <button
              className="src-refresh"
              disabled={st.detectingSources || st.refreshing}
              onClick={() => st.refreshSources()}
              title="重新检测运行中的 WSL 发行版"
            >
              {st.detectingSources ? '检测中…' : '重新检测源'}
            </button>
          )}
          <span className="src-hint">各数据源使用独立索引</span>
        </div>
      )}
      <div className="cols">
        <DirectoryPane projects={st.projects} selected={st.selectedProject} onPick={st.pickProject} changedProjects={st.updates?.changedProjects ?? []} onRefreshProject={st.refreshProject} />
        <SessionPane sessions={st.sessions} selected={st.selectedSessions} onToggle={toggle} onToggleAll={toggleAll} />
        <FsBrowserPane listing={st.fsListing} target={st.targetDir} onBrowse={st.browse} onPickTarget={st.setTargetDir} onMakeDir={st.makeDir} />
      </div>
      <MoveBar count={st.selectedSessions.size} target={st.targetDir} refreshing={st.refreshing} progress={st.progress} onMove={startMove} onRefresh={st.refresh} onHistory={() => setShowHistory(true)} onReconcile={() => setShowReconcile(true)} reconcilePending={st.reconcilePending} onSnapshot={onSnapshot} onArchive={onArchive} onOpenArchive={() => setShowArchive(true)} updates={st.updates} onCheckUpdates={st.checkUpdates} selectedProject={st.selectedProject} onRefreshProject={st.refreshProject} />
      {actionMsg && <p className="notice" onClick={() => setActionMsg(null)}>{actionMsg}</p>}
      {st.preview && <ConfirmModal preview={st.preview} onCancel={() => st.setPreview(null)} onConfirm={confirmMove} />}
      {showHistory && <HistoryView onClose={() => setShowHistory(false)} />}
      {showReconcile && <HistoryReconcileView onClose={() => setShowReconcile(false)} onChanged={st.loadReconcilePending} />}
      {showArchive && <ArchiveTimelineView onClose={() => setShowArchive(false)} />}
    </div>
  )
}
