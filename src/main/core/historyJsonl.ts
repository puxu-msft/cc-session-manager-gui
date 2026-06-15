import { existsSync, readFileSync, statSync } from 'node:fs'

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
