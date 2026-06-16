import { useEffect, useState } from 'react'
import { useAppState } from './state'
import { DirectoryPane } from './components/DirectoryPane'
import { SessionPane } from './components/SessionPane'
import { FsBrowserPane } from './components/FsBrowserPane'
import { MoveBar } from './components/MoveBar'
import { ConfirmModal } from './components/ConfirmModal'
import { HistoryView } from './components/HistoryView'
import { HistoryReconcileView } from './components/HistoryReconcileView'
import './styles.css'

export function App() {
  const st = useAppState()
  const [showHistory, setShowHistory] = useState(false)
  const [showReconcile, setShowReconcile] = useState(false)
  useEffect(() => { st.loadSources(); st.loadIndex(); st.browse(''); st.loadReconcilePending() }, [])

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

  return (
    <div className="app">
      {st.sources.length > 1 && (
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
          <span className="src-hint">各数据源使用独立索引</span>
        </div>
      )}
      <div className="cols">
        <DirectoryPane projects={st.projects} selected={st.selectedProject} onPick={st.pickProject} />
        <SessionPane sessions={st.sessions} selected={st.selectedSessions} onToggle={toggle} onToggleAll={toggleAll} />
        <FsBrowserPane listing={st.fsListing} target={st.targetDir} onBrowse={st.browse} onPickTarget={st.setTargetDir} onMakeDir={st.makeDir} />
      </div>
      <MoveBar count={st.selectedSessions.size} target={st.targetDir} refreshing={st.refreshing} progress={st.progress} onMove={startMove} onRefresh={st.refresh} onHistory={() => setShowHistory(true)} onReconcile={() => setShowReconcile(true)} reconcilePending={st.reconcilePending} />
      {st.preview && <ConfirmModal preview={st.preview} onCancel={() => st.setPreview(null)} onConfirm={confirmMove} />}
      {showHistory && <HistoryView onClose={() => setShowHistory(false)} />}
      {showReconcile && <HistoryReconcileView onClose={() => setShowReconcile(false)} onChanged={st.loadReconcilePending} />}
    </div>
  )
}
