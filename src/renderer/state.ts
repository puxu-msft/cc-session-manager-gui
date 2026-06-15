import { useState, useCallback } from 'react'
import type { MovePreview } from '@shared/types'

export function useAppState() {
  const [projects, setProjects] = useState<any[]>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [sessions, setSessions] = useState<any[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [fsPath, setFsPath] = useState<string>('')
  const [fsListing, setFsListing] = useState<any>(null)
  const [targetDir, setTargetDir] = useState<string | null>(null)
  const [preview, setPreview] = useState<MovePreview | null>(null)

  const loadIndex = useCallback(async () => setProjects((await window.api.getIndex()).projects), [])
  const refresh = useCallback(async () => { const r = await window.api.refresh(); setProjects(r.projects); return r.diff }, [])
  const pickProject = useCallback(async (p: string) => { setSelectedProject(p); setSelectedSessions(new Set()); setSessions(await window.api.getSessions(p)) }, [])
  const browse = useCallback(async (p: string) => { const l = await window.api.listDir(p); setFsPath(l.path); setFsListing(l) }, [])

  return { projects, selectedProject, sessions, selectedSessions, setSelectedSessions, fsPath, fsListing, targetDir, setTargetDir, preview, setPreview, loadIndex, refresh, pickProject, browse }
}
