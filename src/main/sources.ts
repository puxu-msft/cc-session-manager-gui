import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// 一个"数据源"对应一套 Claude Code 存储(某个家目录下的 .claude)。WSL 里通常有两套:WSL(Linux)侧与 Windows 侧。
export interface Source {
  id: string
  label: string
  projectsRoot: string
  claudeJsonPath: string
  trashRoot: string
  historyJsonlPath: string
  archiveRoot: string
  backupsRoot: string
  exists: boolean
}

export function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try { return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8')) } catch { return false }
}

// Windows 路径(如 C:\Users\foo)→ WSL 挂载路径(/mnt/c/Users/foo)。无法识别返回 null。
export function winPathToWsl(winPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath.trim())
  if (!m) return null
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

function sourceFromClaudeHome(id: string, label: string, claudeHome: string): Source {
  return {
    id,
    label,
    projectsRoot: join(claudeHome, '.claude', 'projects'),
    claudeJsonPath: join(claudeHome, '.claude.json'),
    trashRoot: join(claudeHome, '.claude', '.cc-move-trash'),
    historyJsonlPath: join(claudeHome, '.claude', 'history.jsonl'),
    archiveRoot: join(claudeHome, '.claude', '.cc-move-archive'),
    backupsRoot: join(claudeHome, '.claude', '.cc-move-backups'),
    exists: existsSync(join(claudeHome, '.claude', 'projects')),
  }
}

// 找到 Windows 用户家目录在 WSL 下的路径:优先 cmd.exe 取 %USERPROFILE%,失败则扫描 /mnt/c/Users。
function windowsHome(): string | null {
  try {
    const up = execFileSync('cmd.exe', ['/C', 'echo %USERPROFILE%'], { encoding: 'utf8', timeout: 5000 }).trim()
    const p = winPathToWsl(up)
    if (p && existsSync(join(p, '.claude', 'projects'))) return p
  } catch { /* cmd.exe 不可用,降级扫描 */ }
  const usersDir = '/mnt/c/Users'
  try {
    if (existsSync(usersDir)) {
      for (const u of readdirSync(usersDir)) {
        const p = join(usersDir, u)
        if (existsSync(join(p, '.claude', 'projects'))) return p
      }
    }
  } catch { /* 忽略 */ }
  return null
}

// 探测可用数据源:始终含本机(WSL 下标注为 "WSL (Linux)");在 WSL 中且找到 Windows 侧 .claude 时再加 "Windows"。
export function detectSources(): Source[] {
  const wsl = isWSL()
  const sources: Source[] = [sourceFromClaudeHome('local', wsl ? 'WSL (Linux)' : '本机', homedir())]
  if (wsl) {
    const wh = windowsHome()
    if (wh) sources.push(sourceFromClaudeHome('windows', 'Windows', wh))
  }
  return sources
}
