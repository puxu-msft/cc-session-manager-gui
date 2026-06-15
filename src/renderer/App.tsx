import { useEffect } from 'react'
import { useAppState } from './state'
import { DirectoryPane } from './components/DirectoryPane'
import { SessionPane } from './components/SessionPane'
import { FsBrowserPane } from './components/FsBrowserPane'
import { MoveBar } from './components/MoveBar'
import { ConfirmModal } from './components/ConfirmModal'
import './styles.css'

export function App() {
  const st = useAppState()
  useEffect(() => { st.loadIndex(); st.browse('') }, [])

  const toggle = (id: string, multi: boolean) => {
    const next = new Set(multi ? st.selectedSessions : [])
    if (st.selectedSessions.has(id) && multi) next.delete(id); else next.add(id)
    st.setSelectedSessions(next)
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
        <SessionPane sessions={st.sessions} selected={st.selectedSessions} onToggle={toggle} />
        <FsBrowserPane listing={st.fsListing} target={st.targetDir} onBrowse={st.browse} onPickTarget={st.setTargetDir} />
      </div>
      <MoveBar count={st.selectedSessions.size} target={st.targetDir} onMove={startMove} onRefresh={st.refresh} />
      {st.preview && <ConfirmModal preview={st.preview} onCancel={() => st.setPreview(null)} onConfirm={confirmMove} />}
    </div>
  )
}
