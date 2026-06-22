import { useState, useCallback, useRef, useEffect } from 'react'
import type { MovePreview, RefreshProgress, SourceInfo, UpdateSummary, AppUpdateEvent } from '@shared/types'
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
  const [updates, setUpdates] = useState<UpdateSummary | null>(null)
  // 应用版本自动更新事件(electron-updater;Electrobun 下适配器为 no-op,永不触发)。
  const [appUpdate, setAppUpdate] = useState<AppUpdateEvent | null>(null)
  useEffect(() => {
    const off = window.api.onUpdateEvent((e) => setAppUpdate(e))
    return () => { off() }
  }, [])
  const installUpdate = useCallback(() => window.api.installUpdate(), [])

  const loadSources = useCallback(async () => {
    setSources(await window.api.listSources())
    setActiveSource(await window.api.getSource())
  }, [])
  // 异步重探数据源(Windows host 枚举运行中的 WSL 发行版)。挂载时自动调一次 + 「重新检测源」按钮。
  const [detectingSources, setDetectingSources] = useState(false)
  const [canDetectWsl, setCanDetectWsl] = useState(false)
  const detectingRef = useRef(false)
  const refreshSources = useCallback(async () => {
    if (detectingRef.current) return // 防重入叠加(挂载自动调 + 手动按钮可能并发)
    detectingRef.current = true
    setDetectingSources(true)
    try {
      setSources(await window.api.refreshSources())
      // 活动源可能因目标发行版停机而消失,主进程已回落 activeId;同步前端高亮避免错位。
      setActiveSource(await window.api.getSource())
    } catch { /* wsl 不可用等,忽略,保留已有源 */ }
    finally { detectingRef.current = false; setDetectingSources(false) }
  }, [])
  const loadCanDetectWsl = useCallback(async () => {
    try { setCanDetectWsl(await window.api.canDetectWsl()) } catch { setCanDetectWsl(false) }
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
      setUpdates(null) // 全量刷新后清除更新提醒
      return r.diff
    } finally {
      off()
      setRefreshing(false)
      setProgress(null)
    }
  }, [])
  const pickProject = useCallback(async (p: string) => { setSelectedProject(p); setSelectedSessions(new Set()); setSessions(await window.api.getSessions(p)) }, [])
  // 轻量检查会话数据是否有更新(启动 + 手动按钮);结果驱动顶部提醒与项目 badge。
  const checkUpdates = useCallback(async () => { const u = await window.api.checkUpdates(); setUpdates(u); return u }, [])
  // 单项目刷新:只重扫该项目,刷新列表并清除其 badge;若正选中则同步会话列表。
  const refreshProject = useCallback(async (p: string) => {
    const r = await window.api.refreshProject(p)
    setProjects(r.projects)
    setUpdates((prev) => (prev ? { ...prev, changedProjects: prev.changedProjects.filter((x) => x !== p) } : prev))
    if (selectedProject === p) setSessions(await window.api.getSessions(p))
    return r.diff
  }, [selectedProject])
  const browse = useCallback(async (p: string) => { const l = await window.api.listDir(p); setFsPath(l.path); setFsListing(l) }, [])
  const makeDir = useCallback(async (parent: string, name: string) => {
    const l = await window.api.makeDir(parent, name)
    setFsPath(l.path); setFsListing(l); setTargetDir(l.path)
  }, [])
  const loadReconcilePending = useCallback(async () => {
    try { const p = await window.api.planHistory(); setReconcilePending(reconcileSummary(p).opsLines) } catch { setReconcilePending(0) }
  }, [])

  return { projects, selectedProject, sessions, selectedSessions, setSelectedSessions, fsPath, fsListing, targetDir, setTargetDir, preview, setPreview, refreshing, progress, sources, activeSource, loadSources, refreshSources, detectingSources, canDetectWsl, loadCanDetectWsl, switchSource, loadIndex, refresh, pickProject, browse, makeDir, reconcilePending, loadReconcilePending, updates, checkUpdates, refreshProject, appUpdate, installUpdate }
}
