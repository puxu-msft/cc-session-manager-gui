import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_JSON_CLONE_ALLOWLIST } from '@shared/constants'

function atomicWrite(file: string, data: string) {
  const tmp = join(dirname(file), `.claude.json.tmp-${process.pid}`)
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
}

export function ensureProjectEntry(claudeJsonPath: string, targetPath: string, sourcePath: string): boolean {
  if (!existsSync(claudeJsonPath)) return false
  const json = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
  json.projects ??= {}
  if (json.projects[targetPath]) return false
  const src = json.projects[sourcePath] ?? {}
  const cloned: Record<string, unknown> = {}
  for (const k of CLAUDE_JSON_CLONE_ALLOWLIST) if (k in src) cloned[k] = src[k]
  json.projects[targetPath] = cloned
  atomicWrite(claudeJsonPath, JSON.stringify(json, null, 2))
  return true
}

export function removeProjectEntry(claudeJsonPath: string, targetPath: string) {
  if (!existsSync(claudeJsonPath)) return
  const json = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
  if (json.projects?.[targetPath]) { delete json.projects[targetPath]; atomicWrite(claudeJsonPath, JSON.stringify(json, null, 2)) }
}
