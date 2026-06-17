import { renameSync, mkdirSync, rmSync, readdirSync, lstatSync, copyFileSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 递归复制(保留 symlink 不解引用),供跨文件系统退化使用
function copyRecursive(from: string, to: string): void {
  const st = lstatSync(from)
  if (st.isSymbolicLink()) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(readlinkSync(from), to); return }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const e of readdirSync(from)) copyRecursive(join(from, e), join(to, e))
    return
  }
  mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to)
}

// rename 优先;跨挂载点(EXDEV)退化为递归 copy + 删源,保留 symlink。to 的父目录自动创建。
export function safeRename(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try { renameSync(from, to); return } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
    copyRecursive(from, to)
    rmSync(from, { recursive: true, force: true })
  }
}
