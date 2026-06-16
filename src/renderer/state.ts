import { useState, useCallback } from 'react'
import type { MovePreview, RefreshProgress, SourceInfo } from '@shared/types'
import { reconcileSummary } from './lib/reconcileView'

export function useAppState() {
  const [projects, setProjects] = useState<any[]>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [sessions, setSessions] = useState<any[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [fsPath, setFsPath] = useState<string>('')
  const [fsListing, setFsListing] = useState<any>(null)
  const [targetDir, setTargetDir] = useState<string | null>(null)
  const [preview, setPreview] = useState<MovePreview | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<RefreshProgress | null>(null)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [activeSource, setActiveSource] = useState<string>('')
  const [reconcilePending, setReconcilePending] = useState(0)

  const loadSources = useCallback(async () => {
    setSources(await window.api.listSources())
    setActiveSource(await window.api.getSource())
  }, [])
  const switchSource = useCallback(async (id: string) => {
    const r = await window.api.setSource(id)
    setActiveSource(r.active)
    setProjects(r.projects)
    setSelectedProject(null); setSessions([]); setSelectedSessions(new Set())
  }, [])

  const loadIndex = useCallback(async () => setProjects((await window.api.getIndex()).projects), [])
  const refresh = useCallback(async () => {
    setRefreshing(true)
    setProgress({ done: 0, total: 0, path: '' })
    const off = window.api.onRefreshProgress((p) => setProgress(p))
    try {
      const r = await window.api.refresh()
      setProjects(r.projects)
      return r.diff
    } finally {
      off()
      setRefreshing(false)
      setProgress(null)
    }
  }, [])
  const pickProject = useCallback(async (p: string) => { setSelectedProject(p); setSelectedSessions(new Set()); setSessions(await window.api.getSessions(p)) }, [])
  const browse = useCallback(async (p: string) => { const l = await window.api.listDir(p); setFsPath(l.path); setFsListing(l) }, [])
  const makeDir = useCallback(async (parent: string, name: string) => {
    const l = await window.api.makeDir(parent, name)
    setFsPath(l.path); setFsListing(l); setTargetDir(l.path)
  }, [])
  const loadReconcilePending = useCallback(async () => {
    try { const p = await window.api.planHistory(); setReconcilePending(reconcileSummary(p).opsLines) } catch { setReconcilePending(0) }
  }, [])

  return { projects, selectedProject, sessions, selectedSessions, setSelectedSessions, fsPath, fsListing, targetDir, setTargetDir, preview, setPreview, refreshing, progress, sources, activeSource, loadSources, switchSource, loadIndex, refresh, pickProject, browse, makeDir, reconcilePending, loadReconcilePending }
}
