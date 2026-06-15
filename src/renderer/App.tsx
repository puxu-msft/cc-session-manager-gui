import { useEffect, useState } from 'react'
import { useAppState } from './state'
import { DirectoryPane } from './components/DirectoryPane'
import { SessionPane } from './components/SessionPane'
import { FsBrowserPane } from './components/FsBrowserPane'
import { MoveBar } from './components/MoveBar'
import { ConfirmModal } from './components/ConfirmModal'
import { HistoryView } from './components/HistoryView'
import './styles.css'

export function App() {
  const st = useAppState()
  const [showHistory, setShowHistory] = useState(false)
  useEffect(() => { st.loadIndex(); st.browse('') }, [])

  const toggle = (id: string) => {
    const next = new Set(st.selectedSessions)
    if (next.has(id)) next.delete(id); else next.add(id)
    st.setSelectedSessions(next)
  }
  const toggleAll = () => {
    if (st.selectedSessions.size === st.sessions.length) st.setSelectedSessions(new Set())
    else st.setSelectedSessions(new Set(st.sessions.map((s) => s.session_id)))
  }
  const startMove = async () => st.setPreview(await window.api.previewMove([...st.selectedSessions], st.targetDir!))
  const confirmMove = async () => {
    await window.api.executeMove([...st.selectedSessions], st.targetDir!)
    st.setPreview(null); st.setSelectedSessions(new Set())
    await st.refresh(); if (st.selectedProject) st.pickProject(st.selectedProject)
  }

  return (
    <div className="app">
      <div className="cols">
        <DirectoryPane projects={st.projects} selected={st.selectedProject} onPick={st.pickProject} />
        <SessionPane sessions={st.sessions} selected={st.selectedSessions} onToggle={toggle} onToggleAll={toggleAll} />
        <FsBrowserPane listing={st.fsListing} target={st.targetDir} onBrowse={st.browse} onPickTarget={st.setTargetDir} />
      </div>
      <MoveBar count={st.selectedSessions.size} target={st.targetDir} refreshing={st.refreshing} progress={st.progress} onMove={startMove} onRefresh={st.refresh} onHistory={() => setShowHistory(true)} />
      {st.preview && <ConfirmModal preview={st.preview} onCancel={() => st.setPreview(null)} onConfirm={confirmMove} />}
      {showHistory && <HistoryView onClose={() => setShowHistory(false)} />}
    </div>
  )
}
