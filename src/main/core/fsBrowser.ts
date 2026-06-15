import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { FsListing, FsEntry } from '@shared/types'

// 列出某目录下的子目录(隐藏点目录、过滤文件),标记是否 git 仓库。
// 不可读目录(权限不足/不存在)不抛错,返回空列表 + error,供 UI 友好提示而非崩溃。
export function listDir(path: string): FsListing {
  const parent = dirname(path)
  const base: Omit<FsListing, 'entries' | 'error'> = {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
  }
  let dirents
  try {
    dirents = readdirSync(path, { withFileTypes: true })
  } catch {
    return { ...base, entries: [], error: '无法读取该目录(权限不足或路径不存在)' }
  }
  const entries: FsEntry[] = dirents
    .filter((e) => { try { return e.isDirectory() && !e.name.startsWith('.') } catch { return false } })
    .map((e) => {
      const p = join(path, e.name)
      let isGitRepo = false
      try { isGitRepo = existsSync(join(p, '.git')) } catch {}
      return { name: e.name, path: p, isDir: true, isGitRepo }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ...base, entries }
}
