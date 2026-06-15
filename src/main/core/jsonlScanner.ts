import { createReadStream, statSync, existsSync, readdirSync, statSync as stat2 } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta } from '@shared/types'
import { encodePath } from './pathCodec'

// 从消息 content 提取预览文本:字符串直接截断,数组取首个 text 片段,其余返回空串
function previewOf(content: any): string {
  if (typeof content === 'string') return content.slice(0, 200)
  if (Array.isArray(content)) {
    const t = content.find((c) => c?.type === 'text')?.text
    if (typeof t === 'string') return t.slice(0, 200)
  }
  return ''
}

// 递归统计目录字节数,目录不存在时返回 0
function dirSizeBytes(dir: string): number {
  let total = 0
  if (!existsSync(dir)) return 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += dirSizeBytes(p)
    else if (e.isFile()) total += stat2(p).size
  }
  return total
}

// 流式逐行读取单个会话 jsonl,提取元数据。真实文件可达 100MB+,必须逐行,损坏行跳过
export async function scanSessionFile(jsonlPath: string): Promise<SessionMeta> {
  const st = statSync(jsonlPath)
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, '')
  const sidecarDir = join(dirname(jsonlPath), sessionId)

  let lineCount = 0, messageCount = 0
  let firstCwd: string | null = null
  const distinct = new Set<string>()
  let startedAt: string | null = null, lastActivityAt: string | null = null
  let gitBranch: string | null = null, version: string | null = null, entrypoint: string | null = null
  let isSidechain = false
  let firstUserPreview = '', aiTitle: string | null = null, customTitle: string | null = null

  const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of rl) {
    lineCount++
    let o: any
    try { o = JSON.parse(raw) } catch { continue }
    if (!o || typeof o !== 'object') continue
    if (typeof o.cwd === 'string') { if (!firstCwd) firstCwd = o.cwd; distinct.add(o.cwd) }
    if (typeof o.timestamp === 'string') {
      if (!startedAt) startedAt = o.timestamp
      lastActivityAt = o.timestamp
    }
    if (o.type === 'user' || o.type === 'assistant') {
      messageCount++
      if (o.type === 'user' && !firstUserPreview && o.message) firstUserPreview = previewOf(o.message.content)
    }
    if (o.gitBranch && !gitBranch) gitBranch = o.gitBranch
    if (o.version && !version) version = o.version
    if (o.entrypoint && !entrypoint) entrypoint = o.entrypoint
    if (o.isSidechain) isSidechain = true
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle
  }

  const cwd = firstCwd ?? ''
  const subagentsDir = join(sidecarDir, 'subagents')
  const toolResultsDir = join(sidecarDir, 'tool-results')
  const hasSidecar = existsSync(sidecarDir)
  const subagentCount = existsSync(subagentsDir)
    ? readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl')).length : 0

  return {
    sessionId, projectPathAbs: cwd, folderName: encodePath(cwd), cwd,
    title: customTitle ?? aiTitle ?? firstUserPreview, firstMessagePreview: firstUserPreview,
    startedAt, lastActivityAt, messageCount, lineCount, sizeBytes: st.size, mtime: st.mtimeMs,
    gitBranch, claudeVersion: version, entrypoint, isSidechain,
    distinctCwds: [...distinct], hasSidecar, subagentCount, toolResultsBytes: dirSizeBytes(toolResultsDir),
  }
}
