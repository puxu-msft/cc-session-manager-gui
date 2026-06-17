import { statSync, lstatSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Db } from '../db/db'
import { LIVE_MTIME_THRESHOLD_MS } from '@shared/constants'
import { findSessionFile } from './mover'
import { scanSessionFile } from './jsonlScanner'
import { buildManifest, packTree, type Manifest } from './tarPack'
import { unpackTarGz, rebuildSymlinks, verifyAgainstManifest } from './tarPack'
import { encodePath } from './pathCodec'
import { safeRename } from './fsMove'

export interface ArchiverEnv { projectsRoot: string; archiveRoot: string; backupsRoot: string; claudeJsonPath?: string; db: Db }
export interface ArchiveResult { sessionId: string; status: 'done' | 'skipped' | 'failed'; versionId?: number; error?: string }

// 会话子树的顶层条目恒为这两类:主 jsonl + 同名 sidecar 目录。rootsFor(打包)与 clearSessionEntries(清理)
// 必须对应同一集合——若未来顶层条目扩展,两处需同步修改。
function rootsFor(folder: string, sessionId: string): string[] {
  const roots = [`${sessionId}.jsonl`]
  if (existsSync(join(folder, sessionId))) roots.push(sessionId)
  return roots
}

// 删除目标文件夹下某会话的全部顶层条目(主 jsonl + sidecar 目录)。供 reconcile/undo 在搬回备份前清空目标,
// 避免半搬入的版本残留;与 rootsFor 对应同一条目集合。
function clearSessionEntries(folder: string, sessionId: string): void {
  try { rmSync(join(folder, `${sessionId}.jsonl`), { force: true }) } catch {}
  try { rmSync(join(folder, sessionId), { recursive: true, force: true }) } catch {}
}

// 递归字节统计:用 lstat 不跟随 symlink(归档/备份区可能含指向外部大目录的 symlink,跟随会爆量),symlink 计 0
function treeBytes(abs: string): number {
  const st = lstatSync(abs)
  if (st.isSymbolicLink()) return 0
  if (st.isDirectory()) return readdirSync(abs).reduce((a, e) => a + treeBytes(join(abs, e)), 0)
  return st.size
}

// 构建一个版本到 staging 并校验防撕裂,成功则原子换入正式版本目录并置 complete。
// kind 决定 archive 还是 snapshot;两者构建逻辑一致。
async function buildVersion(sessionId: string, kind: 'snapshot' | 'archive', env: ArchiverEnv): Promise<ArchiveResult> {
  const found = findSessionFile(env.projectsRoot, sessionId)
  if (!found) return { sessionId, status: 'skipped', error: '会话不存在' }
  const st0 = statSync(found.jsonl)
  if (Date.now() - st0.mtimeMs < LIVE_MTIME_THRESHOLD_MS) return { sessionId, status: 'skipped', error: '会话疑似活跃,请先关闭' }

  const meta = await scanSessionFile(found.jsonl)
  // 空 cwd 护栏(对齐 mover 的空 srcRoot 护栏):还原依赖原 cwd 定位写回目标,无 cwd 的版本永远还原不了,直接拒绝
  if (!meta.cwd) return { sessionId, status: 'skipped', error: '会话无 cwd,无法归档(将无法还原)' }
  const folderName = basename(found.folder)
  const sidecarDir = join(found.folder, sessionId)
  const hasSidecar = existsSync(sidecarDir)
  const sidecarBytes = hasSidecar ? treeBytes(sidecarDir) : 0

  const versionId = env.db.insertArchiveVersion({
    sessionId, kind, projectPathAbs: meta.cwd || '', sourceFolder: folderName, sourceCwd: meta.cwd || '',
    title: meta.title, jsonlSizeBytes: st0.size, sidecarBytes, gzTotalBytes: 0,
    hasSidecar, subagentCount: meta.subagentCount, lineCount: meta.lineCount,
  })

  const sessionArchiveDir = join(env.archiveRoot, sessionId)
  const staging = join(sessionArchiveDir, `.staging-${versionId}`)
  const finalDir = join(sessionArchiveDir, String(versionId))
  try {
    mkdirSync(staging, { recursive: true })
    const roots = rootsFor(found.folder, sessionId)
    const manifest = await buildManifest(found.folder, roots)
    const tgz = join(staging, 'content.tar.gz')
    await packTree(found.folder, roots, tgz)
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))

    // 防撕裂:重新 stat 主 jsonl 与 sidecar 子树,size/mtime 或 sidecar 字节变化说明快照期间被写
    const st1 = statSync(found.jsonl)
    const sidecarBytes1 = hasSidecar && existsSync(sidecarDir) ? treeBytes(sidecarDir) : 0
    if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs || sidecarBytes1 !== sidecarBytes) {
      rmSync(staging, { recursive: true, force: true }); env.db.deleteArchiveVersion(versionId)
      return { sessionId, status: 'skipped', error: '快照期间会话被写入,请稍后重试' }
    }
    const gzBytes = statSync(tgz).size
    env.db.setArchiveVersionGzBytes(versionId, gzBytes)
    renameSync(staging, finalDir)
    env.db.setArchiveVersionStatus(versionId, 'complete')
    return { sessionId, status: 'done', versionId }
  } catch (e: any) {
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.deleteArchiveVersion(versionId)
    return { sessionId, status: 'failed', error: String(e?.message ?? e) }
  }
}

export async function snapshotSession(sessionId: string, env: ArchiverEnv): Promise<ArchiveResult> {
  return buildVersion(sessionId, 'snapshot', env)
}

// 归档 = 构建 archive 版本(complete 且 gz 校验)后,删除 projects 下原件并从索引移除该会话。
// 删除原件前确认 content.tar.gz 字节数与表记录一致(不可逆操作前的完整性闸门)。
export async function archiveSession(sessionId: string, env: ArchiverEnv): Promise<ArchiveResult> {
  const found = findSessionFile(env.projectsRoot, sessionId)
  const built = await buildVersion(sessionId, 'archive', env)
  if (built.status !== 'done' || !built.versionId || !found) return built
  const v = env.db.getArchiveVersion(built.versionId)
  const tgz = join(env.archiveRoot, sessionId, String(built.versionId), 'content.tar.gz')
  if (!existsSync(tgz) || statSync(tgz).size !== v.gzTotalBytes) {
    return { sessionId, status: 'failed', versionId: built.versionId, error: '归档包完整性校验失败,原件保留' }
  }
  // 完整性通过 → 移除原件(jsonl + sidecar 目录)。删除失败则中止:保留原件、不删索引行,避免索引与磁盘漂移
  try {
    rmSync(found.jsonl, { force: true })
    const sidecar = join(found.folder, sessionId)
    if (existsSync(sidecar)) rmSync(sidecar, { recursive: true, force: true })
  } catch (e: any) {
    return { sessionId, status: 'failed', versionId: built.versionId, error: `归档版本已生成,但移除原件失败(原件保留): ${String(e?.message ?? e)}` }
  }
  env.db.deleteSession(sessionId)
  return built
}

export interface RestoreResult { status: 'done' | 'skipped' | 'failed'; restoreId?: number; error?: string }

// 还原前的目标文件夹冲突 / 编码碰撞预检(对照 mover.previewMove 的三道规则:只 scan 一个代表样本,不全量扫)
async function restorePrecheck(targetFolder: string, sessionId: string, sourceCwd: string): Promise<string | null> {
  if (!existsSync(targetFolder)) return null
  if (!statSync(targetFolder).isDirectory()) return '目标文件夹路径被非目录文件占用'
  // 自身旧件:整体替换会备份它,通常放行;但若其真实 cwd 与本版本不同 → 疑似另一来源同 id,阻断(spec §6.3 第三道)
  const selfJsonl = join(targetFolder, `${sessionId}.jsonl`)
  if (existsSync(selfJsonl)) {
    const ms = await scanSessionFile(selfJsonl)
    if (ms.cwd && ms.cwd !== sourceCwd) return `目标处同 id 会话的 cwd(${ms.cwd})与版本不一致,疑似另一来源,已阻断`
  }
  // 编码碰撞:取一个非自身的代表 jsonl(对齐 mover.previewMove 只 scan 一个样本,避免对大目标全量 scan),cwd ≠ 目标则阻断
  const other = readdirSync(targetFolder).find((f) => f.endsWith('.jsonl') && f !== `${sessionId}.jsonl`)
  if (other) {
    const mo = await scanSessionFile(join(targetFolder, other))
    if (mo.cwd && mo.cwd !== sourceCwd) return `目标文件夹已被 ${mo.cwd} 占用(编码碰撞)`
  }
  return null
}

// 还原一个 complete 版本到其原 cwd 原位:staging 解包校验 → 备份现状(整体)→ 原子换入。
export async function restoreVersion(versionId: number, env: ArchiverEnv): Promise<RestoreResult> {
  const v = env.db.getArchiveVersion(versionId)
  if (!v || v.status !== 'complete') return { status: 'skipped', error: '版本不存在或未完成' }
  const sessionId = v.sessionId as string
  const sourceCwd = v.sourceCwd as string
  if (!sourceCwd) return { status: 'skipped', error: '版本缺少原 cwd,无法定位还原目标' }

  const targetFolder = join(env.projectsRoot, encodePath(sourceCwd))
  // 活跃保护:目标已有同 id 且活跃 → 拒绝
  const targetMain = join(targetFolder, `${sessionId}.jsonl`)
  if (existsSync(targetMain) && Date.now() - statSync(targetMain).mtimeMs < LIVE_MTIME_THRESHOLD_MS) {
    return { status: 'skipped', error: '目标会话疑似活跃,请先关闭' }
  }
  const block = await restorePrecheck(targetFolder, sessionId, sourceCwd)
  if (block) return { status: 'skipped', error: block }

  const vdir = join(env.archiveRoot, sessionId, String(versionId))
  const tgz = join(vdir, 'content.tar.gz')
  const manifest = JSON.parse(readFileSync(join(vdir, 'manifest.json'), 'utf8')) as Manifest
  if (!existsSync(tgz)) return { status: 'failed', error: '归档包缺失' }

  const restoreId = env.db.insertRestore({ versionId, sessionId, sourceCwd, targetDirAbs: sourceCwd, targetFolder })
  const backupPath = join(env.backupsRoot, `${restoreId}-${sessionId}`)
  // 立即回填真实 backupPath(用主键命名,杜绝占位串号);此刻 phase 仍为 NULL,
  // 若此前崩溃 reconcile 走"无 phase → 删 staging 置 failed"分支,不读 backup_path,安全。
  env.db.setRestoreBackupPath(restoreId, backupPath)
  const staging = join(env.archiveRoot, sessionId, `.restore-staging-${restoreId}`)
  try {
    // 1) staging 解包 + 重建 symlink + 校验
    mkdirSync(staging, { recursive: true })
    await unpackTarGz(tgz, staging)
    rebuildSymlinks(staging, manifest)   // symlink 不在 tar 里,依 manifest 手动重建
    const vr = await verifyAgainstManifest(staging, manifest)
    if (!vr.ok) { rmSync(staging, { recursive: true, force: true }); env.db.setRestoreStatus(restoreId, 'failed'); return { status: 'failed', restoreId, error: `校验失败: ${vr.mismatches.join(',')}` } }
    env.db.setRestorePhase(restoreId, 'staging_done')

    // 2) 备份现状(目标里所有现存条目整体搬入 backupPath;归档移走过则为空)
    mkdirSync(backupPath, { recursive: true })
    if (existsSync(targetMain)) safeRename(targetMain, join(backupPath, `${sessionId}.jsonl`))
    const targetSidecar = join(targetFolder, sessionId)
    if (existsSync(targetSidecar)) safeRename(targetSidecar, join(backupPath, sessionId))
    env.db.setRestorePhase(restoreId, 'backup_done')

    // 3) 换入:staging 内每个顶层条目搬到目标
    mkdirSync(targetFolder, { recursive: true })
    for (const e of readdirSync(staging)) safeRename(join(staging, e), join(targetFolder, e))
    rmSync(staging, { recursive: true, force: true })
    env.db.setRestorePhase(restoreId, 'commit_done')
    env.db.setRestoreStatus(restoreId, 'done')
    return { status: 'done', restoreId }
  } catch (e: any) {
    // 失败由 reconcile 兜底(按 phase),此处仅标 failed 并尽力清 staging
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.setRestoreStatus(restoreId, 'failed')
    return { status: 'failed', restoreId, error: String(e?.message ?? e) }
  }
}

// 撤销一次 done 还原:删目标当前内容 → 把 backupPath 现状整体搬回 → 置 undone
export function undoRestore(restoreId: number, env: ArchiverEnv): void {
  const r = env.db.getRestore(restoreId)
  if (!r || r.status !== 'done') throw new Error('该还原不可撤销')
  const targetFolder = r.targetFolder as string
  const sessionId = r.sessionId as string
  clearSessionEntries(targetFolder, sessionId)   // 删本次换入的内容(单点 helper,与 reconcile 一致)
  // 搬回备份(整体镜像)
  const bMain = join(r.backupPath, `${sessionId}.jsonl`)
  const bSidecar = join(r.backupPath, sessionId)
  if (existsSync(bMain)) safeRename(bMain, join(targetFolder, `${sessionId}.jsonl`))
  if (existsSync(bSidecar)) safeRename(bSidecar, join(targetFolder, sessionId))
  env.db.setRestoreStatus(restoreId, 'undone')
}

export function deleteVersion(versionId: number, env: ArchiverEnv): void {
  const v = env.db.getArchiveVersion(versionId)
  if (!v) return
  try { rmSync(join(env.archiveRoot, v.sessionId, String(versionId)), { recursive: true, force: true }) } catch {}
  env.db.deleteArchiveVersion(versionId)
}

export function listVersions(sessionId: string, env: ArchiverEnv): any[] {
  return env.db.getArchiveVersions(sessionId).filter((v: any) => v.status === 'complete')
}

// 归档库 + 备份区总占用,以及每个版本目录占用(按 versionId)
export function archiveUsage(env: ArchiverEnv): { total: number; backups: number; byVersion: Record<string, number> } {
  const byVersion: Record<string, number> = {}
  let total = 0, backups = 0
  const sizeOf = (abs: string): number => {
    if (!existsSync(abs)) return 0
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return 0          // 绝不跟随 symlink 统计外部目标
    return st.isDirectory() ? readdirSync(abs).reduce((a, e) => a + sizeOf(join(abs, e)), 0) : st.size
  }
  if (existsSync(env.archiveRoot)) for (const sid of readdirSync(env.archiveRoot)) {
    const sdir = join(env.archiveRoot, sid)
    if (!lstatSync(sdir).isDirectory()) continue
    for (const ver of readdirSync(sdir)) {
      if (ver.startsWith('.')) continue
      const s = sizeOf(join(sdir, ver)); byVersion[ver] = s; total += s
    }
  }
  if (existsSync(env.backupsRoot)) backups = sizeOf(env.backupsRoot)
  return { total, backups, byVersion }
}

// 崩溃恢复:启动 / 切源时与 mover.reconcile 并列调用。
// - pending 版本:删除其 .staging-* 与行(原件从未被动,删除原件只在 complete 后)。
// - pending restore 按 phase:无/staging_done → 删 staging 置 failed;backup_done → 把备份搬回原位置 failed;commit_done → 补记 done。
export function archiverReconcile(env: ArchiverEnv): void {
  for (const v of env.db.getPendingArchiveVersions()) {
    const staging = join(env.archiveRoot, v.sessionId, `.staging-${v.versionId}`)
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.deleteArchiveVersion(v.versionId)
  }
  for (const r of env.db.getPendingRestores()) {
    const staging = join(env.archiveRoot, r.sessionId, `.restore-staging-${r.id}`)
    if (r.phase === 'commit_done') { env.db.setRestoreStatus(r.id, 'done'); continue }
    if (r.phase === 'backup_done') {
      // 清除半搬入的版本残留(单点 clearSessionEntries,与换入条目集合对应),再把备份现状搬回目标(前滚到"还原前")
      const targetFolder = r.targetFolder as string, sessionId = r.sessionId as string
      clearSessionEntries(targetFolder, sessionId)
      const bMain = join(r.backupPath, `${sessionId}.jsonl`), bSidecar = join(r.backupPath, sessionId)
      if (existsSync(bMain)) safeRename(bMain, join(targetFolder, `${sessionId}.jsonl`))
      if (existsSync(bSidecar)) safeRename(bSidecar, join(targetFolder, sessionId))
      try { rmSync(r.backupPath, { recursive: true, force: true }) } catch {}   // 备份已搬回,清掉空壳
    }
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.setRestoreStatus(r.id, 'failed')
  }
}
