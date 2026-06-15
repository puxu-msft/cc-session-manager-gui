import { statSync, existsSync, readdirSync, createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { MovePreview, MovePreviewItem } from '@shared/types'
import { encodePath } from './pathCodec'
import { scanSessionFile } from './jsonlScanner'
import { rewriteLine } from './cwdRewriter'
import { LIVE_MTIME_THRESHOLD_MS, CLAUDE_JSON } from '@shared/constants'

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
      const someJsonl = readdirSync(targetFolder).find((f) => f.endsWith('.jsonl'))
      if (someJsonl) { const m2 = await scanSessionFile(join(targetFolder, someJsonl)); if (m2.cwd && m2.cwd !== targetPath) { blocked = 'encode-collision'; blockReason = `目标文件夹已被 ${m2.cwd} 占用` } }
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
