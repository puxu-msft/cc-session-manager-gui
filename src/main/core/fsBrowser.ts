import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { FsListing } from '@shared/types'

export function listDir(path: string): FsListing {
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((e) => { try { return e.isDirectory() && !e.name.startsWith('.') } catch { return false } })
    .map((e) => {
      const p = join(path, e.name)
      let isGitRepo = false
      try { isGitRepo = existsSync(join(p, '.git')) } catch {}
      return { name: e.name, path: p, isDir: true, isGitRepo }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, entries }
}
