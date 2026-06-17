import { statSync, lstatSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Db } from '../db/db'
import { LIVE_MTIME_THRESHOLD_MS } from '@shared/constants'
import { findSessionFile } from './mover'
import { scanSessionFile } from './jsonlScanner'
import { buildManifest, packTree, type Manifest } from './tarPack'
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
