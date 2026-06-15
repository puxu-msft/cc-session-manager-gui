import { join } from 'node:path'
import { homedir } from 'node:os'

export const LIVE_MTIME_THRESHOLD_MS = 60_000
export const SNAPSHOT_LINE_SIZE_CAP_BYTES = 2_000_000

export const PROJECTS_ROOT = () => join(homedir(), '.claude', 'projects')
export const CLAUDE_JSON = () => join(homedir(), '.claude.json')
export const TRASH_ROOT = () => join(homedir(), '.claude', '.cc-move-trash')

export const CLAUDE_JSON_CLONE_ALLOWLIST = [
  'allowedTools',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasTrustDialogAccepted',
] as const
