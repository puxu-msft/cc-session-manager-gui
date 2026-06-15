import { existsSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface HistoryLine {
  display?: unknown; pastedContents?: unknown; timestamp?: unknown
  project?: string; sessionId?: string
}
export interface HistoryLineRec { raw: string; parsed: HistoryLine | null; lineNo: number }
export interface ReadHistory { lines: HistoryLineRec[]; size: number; mtime: number }

// 整文件读(history 有界)。损坏行保留 raw、parsed=null。文件不存在返回空,不抛。
// 末尾因 '\n' 产生的空段不计为一行。
export function readHistory(path: string): ReadHistory {
  if (!existsSync(path)) return { lines: [], size: 0, mtime: 0 }
  const st = statSync(path)
  const raws = readFileSync(path, 'utf8').split('\n')
  const lines: HistoryLineRec[] = []
  raws.forEach((raw, i) => {
    if (i === raws.length - 1 && raw === '') return
    let parsed: HistoryLine | null = null
    try { parsed = JSON.parse(raw) } catch { /* 损坏行 */ }
    lines.push({ raw, parsed, lineNo: i + 1 })
  })
  return { lines, size: st.size, mtime: st.mtimeMs }
}

export interface ApplyOp { sessionId: string; oldProject: string; newProject: string }
export interface RewriteOp { oldProject: string; newProject: string; sessionIds: string[]; affectedLines: number }

const SEP = '\0' // NUL:POSIX/Windows 路径都不可能含它,作 (sessionId,project) 拼接键的无歧义分隔符;仅用于内存 Map,绝不写入文件

// 原子改写:仅对命中 (sessionId, 行内实际 project===oldProject) 的行改 project 为 newProject。
// 非目标行 / 损坏行 raw 字节透传。rename 前重新 stat,与 guard 不符则中止不覆盖(并发检测)。
// 返回按 (oldProject,newProject) 聚合的 RewriteOp[](同 sessionId 多旧值自然分多条)。
export function applyHistoryRewrite(path: string, ops: ApplyOp[], guard: { size: number; mtime: number }): RewriteOp[] {
  if (!existsSync(path)) return []
  const want = new Map(ops.map((o) => [o.sessionId + SEP + o.oldProject, o.newProject]))
  const raws = readFileSync(path, 'utf8').split('\n')
  const agg = new Map<string, { sessionIds: Set<string>; lines: number }>()

  const out = raws.map((raw) => {
    if (raw === '') return raw
    let o: any
    try { o = JSON.parse(raw) } catch { return raw }
    if (!o || typeof o.project !== 'string' || typeof o.sessionId !== 'string') return raw
    const nv = want.get(o.sessionId + SEP + o.project)
    if (nv === undefined) return raw
    const ak = o.project + SEP + nv
    const a = agg.get(ak) ?? agg.set(ak, { sessionIds: new Set(), lines: 0 }).get(ak)!
    a.sessionIds.add(o.sessionId); a.lines++
    o.project = nv
    return JSON.stringify(o)
  })

  if (agg.size === 0) return []
  const tmp = join(dirname(path), `.history.jsonl.tmp-${process.pid}`)
  writeFileSync(tmp, out.join('\n'), { mode: 0o600 })
  const st = statSync(path)
  if (st.size !== guard.size || st.mtimeMs !== guard.mtime) {
    rmSync(tmp, { force: true })
    throw new Error('history.jsonl 在对账期间被修改,请关闭所有 Claude 后重试')
  }
  renameSync(tmp, path)
  return [...agg].map(([k, v]) => {
    const [oldProject, newProject] = k.split(SEP)
    return { oldProject, newProject, sessionIds: [...v.sessionIds], affectedLines: v.lines }
  })
}
