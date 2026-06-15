import { statSync, existsSync, readdirSync, createReadStream, readFileSync, mkdirSync, renameSync, createWriteStream, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { MovePreview, MovePreviewItem, MoveResult } from '@shared/types'
import { encodePath } from './pathCodec'
import { scanSessionFile } from './jsonlScanner'
import { rewriteLine } from './cwdRewriter'
import { ensureProjectEntry, removeProjectEntry } from './claudeJson'
import { LIVE_MTIME_THRESHOLD_MS, CLAUDE_JSON, SNAPSHOT_LINE_SIZE_CAP_BYTES, TRASH_ROOT } from '@shared/constants'
import type { Db } from '../db/db'

// 移动运行环境:projectsRoot 为 ~/.claude/projects;claudeJsonPath 可注入以便测试,缺省取 CLAUDE_JSON()
export interface MoverEnv { projectsRoot: string; claudeJsonPath?: string }

// 在 projectsRoot 下逐文件夹查找指定会话的 jsonl,返回 jsonl 路径与所在文件夹;未找到返回 null
export function findSessionFile(projectsRoot: string, sessionId: string): { jsonl: string; folder: string } | null {
  for (const folder of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const jsonl = join(projectsRoot, folder.name, `${sessionId}.jsonl`)
    if (existsSync(jsonl)) return { jsonl, folder: join(projectsRoot, folder.name) }
  }
  return null
}

// 递归统计会话 sidecar 目录及其 tool-results 子目录的字节数,目录不存在时计 0
function sidecarBytes(folder: string, sessionId: string): { sidecar: number; toolResults: number } {
  const dir = join(folder, sessionId)
  if (!existsSync(dir)) return { sidecar: 0, toolResults: 0 }
  const sz = (d: string): number => existsSync(d)
    ? readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? sz(join(d, e.name)) : statSync(join(d, e.name)).size), 0) : 0
  return { sidecar: sz(dir), toolResults: sz(join(dir, 'tool-results')) }
}

// 流式统计将被改写的结构化 cwd 字段数:主 jsonl 加上 subagents 子目录下的每个 jsonl,逐行累加 rewriteLine 的改动数
async function countStructuralCwd(jsonl: string, srcRoot: string, dstRoot: string): Promise<number> {
  let count = 0
  const rl = createInterface({ input: createReadStream(jsonl, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of rl) count += rewriteLine(raw, srcRoot, dstRoot).changes.length
  const sub = join(jsonl.replace(/\.jsonl$/, ''), 'subagents')
  if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) {
    const rl2 = createInterface({ input: createReadStream(join(sub, f), { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const raw of rl2) count += rewriteLine(raw, srcRoot, dstRoot).changes.length
  }
  return count
}

// 判断 .claude.json 是否已存在目标路径条目;文件缺失或解析失败均按"不存在"处理
function claudeJsonHasEntry(claudeJsonPath: string, targetPath: string): boolean {
  if (!existsSync(claudeJsonPath)) return false
  try { return !!JSON.parse(readFileSync(claudeJsonPath, 'utf8')).projects?.[targetPath] } catch { return false }
}

// 逐会话预检并汇总成 MovePreview:检测 live/collision/encode-collision/self-referential 阻断,
// 统计将改写的结构化 cwd 字段数、sidecar/tool-results 体积、回收区备份体积,供确认弹窗展示
export async function previewMove(sessionIds: string[], targetPath: string, env: MoverEnv): Promise<MovePreview> {
  const claudeJsonPath = env.claudeJsonPath ?? CLAUDE_JSON()
  const items: MovePreviewItem[] = []
  for (const sessionId of sessionIds) {
    const found = findSessionFile(env.projectsRoot, sessionId)
    if (!found) { items.push({ sessionId, title: sessionId, srcRoot: '', dstRoot: targetPath, structuralCwdFields: 0, sidecarBytes: 0, toolResultsBytes: 0, trashBackupBytes: 0, blocked: 'collision', blockReason: '源会话不存在' }); continue }
    const meta = await scanSessionFile(found.jsonl)
    const srcRoot = meta.cwd
    const st = statSync(found.jsonl)
    let blocked: MovePreviewItem['blocked'] = null, blockReason: string | undefined

    if (Date.now() - st.mtimeMs < LIVE_MTIME_THRESHOLD_MS) { blocked = 'live'; blockReason = '会话疑似活跃,请先关闭' }
    const targetFolder = join(env.projectsRoot, encodePath(targetPath))
    if (!blocked && (existsSync(join(targetFolder, `${sessionId}.jsonl`)) || existsSync(join(targetFolder, sessionId)))) { blocked = 'collision'; blockReason = '目标已存在同会话' }
    if (!blocked && existsSync(targetFolder)) {
      // 目标编码路径被普通文件占用属编码冲突,直接阻断而非让 readdirSync 抛 ENOTDIR 炸穿整批
      if (!statSync(targetFolder).isDirectory()) { blocked = 'encode-collision'; blockReason = '目标文件夹路径被非目录文件占用' }
      else {
        const someJsonl = readdirSync(targetFolder).find((f) => f.endsWith('.jsonl'))
        if (someJsonl) { const m2 = await scanSessionFile(join(targetFolder, someJsonl)); if (m2.cwd && m2.cwd !== targetPath) { blocked = 'encode-collision'; blockReason = `目标文件夹已被 ${m2.cwd} 占用` } }
      }
    }
    if (!blocked && srcRoot === join(homedir(), '.claude')) { blocked = 'self-referential'; blockReason = '自引用 ~/.claude,需显式确认' }

    const sc = sidecarBytes(found.folder, sessionId)
    const fields = blocked ? 0 : await countStructuralCwd(found.jsonl, srcRoot, targetPath)
    const trashBackup = blocked ? 0 : st.size +
      (existsSync(join(found.folder, sessionId, 'subagents')) ? readdirSync(join(found.folder, sessionId, 'subagents')).filter((f) => f.endsWith('.jsonl')).reduce((a, f) => a + statSync(join(found.folder, sessionId, 'subagents', f)).size, 0) : 0)
    items.push({ sessionId, title: meta.title, srcRoot, dstRoot: targetPath, structuralCwdFields: fields, sidecarBytes: sc.sidecar, toolResultsBytes: sc.toolResults, trashBackupBytes: trashBackup, blocked, blockReason })
  }
  return { items, claudeJsonWillAddEntry: !claudeJsonHasEntry(claudeJsonPath, targetPath), targetPathAbs: targetPath }
}

// 执行环境:在 MoverEnv 基础上注入回收区根与 db
export interface ExecEnv extends MoverEnv { trashRoot?: string; db: Db }

// 流式把源 jsonl 改写后写入目标:逐行经 rewriteLine 改写结构化 cwd 字段,正文绝不触碰;
// 收集改动明细;小文件(<=快照体积上限)对发生改动的行额外保存原始内容作为快照
async function rewriteFileToTarget(srcFile: string, dstFile: string, fileRel: string, srcRoot: string, dstRoot: string) {
  mkdirSync(dirname(dstFile), { recursive: true })
  const out = createWriteStream(dstFile, { encoding: 'utf8' })
  const changes: { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }[] = []
  const snapshot: { fileRel: string; lineNo: number; content: string }[] = []
  const small = statSync(srcFile).size <= SNAPSHOT_LINE_SIZE_CAP_BYTES
  const rl = createInterface({ input: createReadStream(srcFile, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const raw of rl) {
    n++
    const r = rewriteLine(raw, srcRoot, dstRoot)
    for (const c of r.changes) changes.push({ fileRel, lineNo: n, oldCwd: c.oldCwd, newCwd: c.newCwd })
    if (small && r.changes.length) snapshot.push({ fileRel, lineNo: n, content: raw })
    out.write(r.line + '\n')
  }
  await new Promise<void>((res, rej) => out.end((e: any) => (e ? rej(e) : res())))
  return { changes, snapshot }
}

// 执行移动:对每个会话,先写目标并校验 → 再把原件移入回收区(后删源)→ 最后更新 db 与 .claude.json;
// 任意环节抛错则回滚已写目标并把回收区备份搬回源,标记 failed。绝不先删源。
export async function executeMove(sessionIds: string[], targetPath: string, env: ExecEnv): Promise<MoveResult[]> {
  const trashRoot = env.trashRoot ?? TRASH_ROOT()
  const claudeJsonPath = env.claudeJsonPath ?? CLAUDE_JSON()
  const results: MoveResult[] = []
  const pv = await previewMove(sessionIds, targetPath, env)

  for (const item of pv.items) {
    if (item.blocked) { results.push({ sessionId: item.sessionId, status: 'skipped', error: item.blockReason }); continue }
    const found = findSessionFile(env.projectsRoot, item.sessionId)!
    const srcRoot = item.srcRoot
    // 空 srcRoot 护栏:无 cwd 的会话不可改写(否则 reRoot 空前缀会损坏所有绝对路径)
    if (!srcRoot) { results.push({ sessionId: item.sessionId, status: 'skipped', error: '会话无 cwd,跳过' }); continue }
    const targetFolder = join(env.projectsRoot, encodePath(targetPath))
    const moveId = env.db.insertMove({ sessionId: item.sessionId, projectName: srcRoot, sourceDirAbs: srcRoot, sourceFolder: found.folder, sourceCwd: srcRoot, targetDirAbs: targetPath, targetFolder, trashPath: join(trashRoot, '0'), claudeJsonUpdated: false })
    const trashDir = join(trashRoot, String(moveId))
    const written: string[] = []
    // 记录每一次破坏性的 verbatim 源→目标 rename(meta/tool-results/hooks/散落文件),
    // 这些文件不进回收区(避免大文件复制两份),回滚时需逐个从目标搬回源
    const movedVerbatim: { from: string; to: string }[] = []
    try {
      mkdirSync(targetFolder, { recursive: true }); mkdirSync(trashDir, { recursive: true })
      const allChanges: any[] = [], allSnap: any[] = []

      const mainTarget = join(targetFolder, `${item.sessionId}.jsonl`)
      const r1 = await rewriteFileToTarget(found.jsonl, mainTarget, `${item.sessionId}.jsonl`, srcRoot, targetPath)
      written.push(mainTarget); allChanges.push(...r1.changes); allSnap.push(...r1.snapshot)

      const srcSidecar = join(found.folder, item.sessionId)
      const dstSidecar = join(targetFolder, item.sessionId)
      // subagent jsonl 为改写写入(原件留在源,稍后随 srcSidecar 整体进回收区);verbatim 文件先不动
      if (existsSync(srcSidecar)) {
        const subSrc = join(srcSidecar, 'subagents')
        if (existsSync(subSrc)) for (const f of readdirSync(subSrc)) if (f.endsWith('.jsonl')) {
          const sp = join(subSrc, f), dp = join(dstSidecar, 'subagents', f)
          const r = await rewriteFileToTarget(sp, dp, `${item.sessionId}/subagents/${f}`, srcRoot, targetPath); written.push(dp); allChanges.push(...r.changes); allSnap.push(...r.snapshot)
        }
      }

      // 先校验目标主文件写入,再进行任何破坏性的源→目标搬移(绝不在目标校验前移动源 verbatim 文件)
      if (!existsSync(mainTarget)) throw new Error('目标写入校验失败')

      // verbatim 源→目标搬移:subagents 下的非 jsonl(meta 等)+ tool-results/hooks 子目录 + 顶层散落文件
      if (existsSync(srcSidecar)) {
        const subSrc = join(srcSidecar, 'subagents')
        if (existsSync(subSrc)) for (const f of readdirSync(subSrc)) if (!f.endsWith('.jsonl')) {
          const sp = join(subSrc, f), dp = join(dstSidecar, 'subagents', f)
          mkdirSync(dirname(dp), { recursive: true }); renameSync(sp, dp); movedVerbatim.push({ from: sp, to: dp })
        }
        for (const sub of ['tool-results', 'hooks']) {
          const d = join(srcSidecar, sub)
          if (existsSync(d)) { mkdirSync(dstSidecar, { recursive: true }); const to = join(dstSidecar, sub); renameSync(d, to); movedVerbatim.push({ from: d, to }) }
        }
        for (const e of readdirSync(srcSidecar, { withFileTypes: true })) if (e.isFile()) { mkdirSync(dstSidecar, { recursive: true }); const from = join(srcSidecar, e.name), to = join(dstSidecar, e.name); renameSync(from, to); movedVerbatim.push({ from, to }) }
      }

      renameSync(found.jsonl, join(trashDir, `${item.sessionId}.jsonl`))
      if (existsSync(srcSidecar)) renameSync(srcSidecar, join(trashDir, item.sessionId))

      env.db.insertCwdChanges(moveId, allChanges)
      if (allSnap.length) env.db.insertSnapshotLines(moveId, allSnap)
      const added = ensureProjectEntry(claudeJsonPath, targetPath, srcRoot)
      env.db.updateMoveStatus(moveId, 'done', { rewrittenFieldCount: allChanges.length, sidecarBytes: item.sidecarBytes, claudeJsonUpdated: added, trashPath: trashDir })
      results.push({ sessionId: item.sessionId, status: 'done', moveId })
    } catch (e: any) {
      // 先把已搬到目标的 verbatim 文件搬回源(它们是 move 而非 copy,目标是唯一副本),
      // 必须在 rmSync 目标 sidecar 前完成,否则唯一副本被删除导致数据丢失
      for (const mv of movedVerbatim) {
        try { if (existsSync(mv.to) && !existsSync(mv.from)) { mkdirSync(dirname(mv.from), { recursive: true }); renameSync(mv.to, mv.from) } } catch {}
      }
      for (const w of written) try { rmSync(w, { force: true }) } catch {}
      try { rmSync(join(targetFolder, item.sessionId), { recursive: true, force: true }) } catch {}
      const trashedMain = join(trashDir, `${item.sessionId}.jsonl`)
      if (existsSync(trashedMain) && !existsSync(found.jsonl)) renameSync(trashedMain, found.jsonl)
      const trashedSidecar = join(trashDir, item.sessionId)
      if (existsSync(trashedSidecar) && !existsSync(join(found.folder, item.sessionId))) renameSync(trashedSidecar, join(found.folder, item.sessionId))
      env.db.updateMoveStatus(moveId, 'failed')
      results.push({ sessionId: item.sessionId, status: 'failed', moveId, error: String(e?.message ?? e) })
    }
  }
  return results
}

// 崩溃恢复:对仍处于 pending 的移动判定终态——目标已就位且源已消失则补记 done;
// 否则把回收区备份搬回源、清理半成品目标,标记 failed
export function reconcile(env: ExecEnv) {
  for (const m of env.db.getPendingMoves()) {
    const targetMain = join(m.target_folder, `${m.session_id}.jsonl`)
    const trashedMain = join(env.trashRoot ?? TRASH_ROOT(), String(m.id), `${m.session_id}.jsonl`)
    const sourceMain = join(m.source_folder, `${m.session_id}.jsonl`)
    if (existsSync(targetMain) && !existsSync(sourceMain)) env.db.updateMoveStatus(m.id, 'done')
    else { if (existsSync(trashedMain) && !existsSync(sourceMain)) renameSync(trashedMain, sourceMain); try { rmSync(targetMain, { force: true }) } catch {}; env.db.updateMoveStatus(m.id, 'failed') }
  }
}

// 撤销已完成的移动:清理目标 → 把回收区原件搬回源 → 移除 .claude.json 目标条目 → 标记 rolledback
export function undoMove(moveId: number, env: ExecEnv) {
  const m = env.db.getMoves().find((x) => x.id === moveId)
  if (!m || m.status !== 'done') throw new Error('该移动不可撤销')
  const trashDir = join(env.trashRoot ?? TRASH_ROOT(), String(moveId))
  const sourceMain = join(m.source_folder, `${m.session_id}.jsonl`)
  const targetMain = join(m.target_folder, `${m.session_id}.jsonl`)
  const trashedMain = join(trashDir, `${m.session_id}.jsonl`)
  if (!existsSync(trashedMain)) throw new Error('回收区备份缺失,无法撤销')
  try { rmSync(targetMain, { force: true }) } catch {}
  try { rmSync(join(m.target_folder, m.session_id), { recursive: true, force: true }) } catch {}
  mkdirSync(m.source_folder, { recursive: true })
  renameSync(trashedMain, sourceMain)
  const trashedSidecar = join(trashDir, m.session_id)
  if (existsSync(trashedSidecar)) renameSync(trashedSidecar, join(m.source_folder, m.session_id))
  if (m.claude_json_updated) removeProjectEntry(env.claudeJsonPath ?? CLAUDE_JSON(), m.target_dir_abs)
  env.db.updateMoveStatus(moveId, 'rolledback')
}
