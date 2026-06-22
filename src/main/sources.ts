import { homedir } from 'node:os'
import { join, win32 as winPath } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

export type OsFamily = 'windows' | 'posix'

// 一个"数据源"对应一套 Claude Code 存储(某个家目录下的 .claude)。
// WSL 里通常有两套:WSL(Linux)侧与 Windows 侧;Windows host 上则是本机 + 各运行中 WSL 发行版。
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
  // 三个正交不变量(各回答不同问题,不可互相推导,见 spec §5.1):
  // osFamily — 「是不是同一 OS 家族(cwd 无需跨平台翻译)?」承载用户约束「Windows→Windows、posix→posix 默认不可切」。
  //   注意不可由 fsAnchor 推导:Windows-反向源经 /mnt/c 访问(anchor 像 posix)但装的是 Windows 的 .claude(cwd C:\…)→ osFamily=windows。
  osFamily: OsFamily
  // fsAnchor — 「是不是同一物理文件系统?」rename 技术安全(不跨 device);本机/挂载源=claudeHome、远程 WSL 源=\\wsl.localhost\<distro>。
  fsAnchor: string
  // claudeHomeCwd — 会话 cwd 的 POSIX 根:本机=homedir();WSL 源=probe 的 /home/xp。供自引用守卫与 reRoot(比的是会话 cwd,永远 POSIX,绝不用 UNC)。
  claudeHomeCwd: string
}

export function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try { return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8')) } catch { return false }
}

// Windows 路径(如 C:\Users\foo)→ WSL 挂载路径(/mnt/c/Users/foo)。无法识别返回 null。
export function winPathToWsl(winPathStr: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPathStr.trim())
  if (!m) return null
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

// WSL 发行版名的结构白名单:正常 distro 名不含路径分隔符/穿越段/控制符。
// distro 名是不可信输入(wsl --import 可起任意名),进 UNC share 段前必须校验,防穿越到宿主管理共享(如 \\wsl.localhost\c$)。
export function isValidDistroName(distro: string): boolean {
  if (!distro || distro !== distro.trim()) return false           // 前后空白
  if (/[\\/]/.test(distro)) return false                          // 路径分隔符
  if (distro.includes('..')) return false                         // 穿越段
  if (/[\x00-\x1f]/.test(distro)) return false                    // 控制符
  if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00a0]/.test(distro)) return false  // 零宽/方向控制/NBSP 同形混淆
  if (distro.includes('$')) return false                          // \\wsl$ 的 $,以及防注入
  return true
}

// POSIX 绝对路径校验:probeWslHome 返回值进 UNC 前须确认是干净的绝对 POSIX 路径(无 .. 段、无盘符、无反斜杠)。
export function isCleanPosixAbs(p: string): boolean {
  if (!/^\/[^\0\\]*$/.test(p)) return false                       // 须 / 开头,无 NUL/反斜杠
  if (/^\/[A-Za-z]:/.test(p)) return false                        // 形如 /C: 的盘符残留
  if (p.split('/').includes('..')) return false                   // 穿越段
  return true
}

// WSL 发行版 id 的 sanitize:进 index-<id>.db 文件名,只留文件名安全字符。
function sanitizeDistro(distro: string): string {
  return distro.replace(/[^A-Za-z0-9._-]/g, '-')
}

// POSIX 路径(WSL 内 /home/xp)→ 宿主 UNC 路径(\\wsl.localhost\<distro>\home\xp)。
// 用 path.win32 保证在任何 OS 下都产出一致的 UNC(本工具该分支只在 Windows host 跑,但单测在 Linux 也要确定性)。
// normalize 后断言前缀仍是 \\wsl.localhost\<single-segment>\,防 distro/posixPath 穿越。
export function wslPathToUnc(distro: string, posixPath: string, prefix = '\\\\wsl.localhost'): string | null {
  if (!isValidDistroName(distro)) return null
  if (!isCleanPosixAbs(posixPath)) return null
  const rel = posixPath.replace(/^\//, '').replace(/\/+$/, '').replace(/\//g, '\\')   // /home/xp/ → home\xp
  const base = `${prefix}\\${distro}`
  const unc = winPath.normalize(`${base}\\${rel}`)
  // 规范化后前缀必须仍指向该 distro 的 share,否则视为穿越,拒绝。
  if (!unc.startsWith(`${base}\\`) && unc !== base) return null
  return unc
}

// WSL 发行版根的 UNC anchor(\\wsl.localhost\<distro>)。
export function wslAnchor(distro: string, prefix = '\\\\wsl.localhost'): string | null {
  if (!isValidDistroName(distro)) return null
  return `${prefix}\\${distro}`
}

type Joiner = (...p: string[]) => string

// 由一个 claudeHome 根派生该源的全部子路径(用给定的 join:本机用 node:path 的 join,WSL 用 win32.join)。
function deriveClaudePaths(claudeHome: string, pjoin: Joiner): {
  projectsRoot: string; claudeJsonPath: string; trashRoot: string
  historyJsonlPath: string; archiveRoot: string; backupsRoot: string
} {
  return {
    projectsRoot: pjoin(claudeHome, '.claude', 'projects'),
    claudeJsonPath: pjoin(claudeHome, '.claude.json'),
    trashRoot: pjoin(claudeHome, '.claude', '.cc-session-manager-trash'),
    historyJsonlPath: pjoin(claudeHome, '.claude', 'history.jsonl'),
    archiveRoot: pjoin(claudeHome, '.claude', '.cc-session-manager-archive'),
    backupsRoot: pjoin(claudeHome, '.claude', '.cc-session-manager-backups'),
  }
}

interface SourceExtra { osFamily: OsFamily; fsAnchor: string; claudeHomeCwd: string; exists?: boolean }

function buildSource(
  id: string, label: string,
  paths: ReturnType<typeof deriveClaudePaths>,
  extra: SourceExtra,
): Source {
  return {
    id, label,
    ...paths,
    exists: extra.exists ?? existsSync(paths.projectsRoot),
    osFamily: extra.osFamily,
    fsAnchor: extra.fsAnchor,
    claudeHomeCwd: extra.claudeHomeCwd,
  }
}

// 本机/挂载源(claudeHome 是 OS 原生路径,用 OS 的 join 派生,existsSync 判存在)。
// osFamily 显式传入:本机 win32 源=windows、WSL/Linux/Mac 本机源=posix、Windows-反向源(经 /mnt/c)=windows。
function localSource(id: string, label: string, claudeHome: string, osFamily: OsFamily): Source {
  const paths = deriveClaudePaths(claudeHome, join)
  return buildSource(id, label, paths, { osFamily, fsAnchor: claudeHome, claudeHomeCwd: claudeHome })
}

// 一个已解析的 WSL 发行版探测结果:distro 原名 + 默认用户 POSIX home + 内部是否有 .claude/projects。
export interface WslProbe { distro: string; home: string; exists: boolean }

// 纯函数:把已解析的 WSL 探测结果构造成 Source[]。
// - 三分:unc 用原名、id=wsl-<sanitize>-<hash>、label=原名。
// - id 恒带原名 hash 后缀:保证「同一 distro 无论在 probes 中的位置/有无邻居,id 都恒定」
//   (避免「先到先占裸 id」依赖 --list 不稳顺序 → 跨会话 id 漂移 → index-<id>.db 错位丢历史)。
// - 仅产出 exists===true 的源(避免前端堆灰按钮)。
// - 路径全用 win32 派生(UNC)。
export function buildWslSources(probes: WslProbe[], prefix = '\\\\wsl.localhost'): Source[] {
  const out: Source[] = []
  const usedIds = new Set<string>()
  for (const { distro, home, exists } of probes) {
    if (!exists) continue
    if (!isValidDistroName(distro)) continue
    if (!isCleanPosixAbs(home)) continue
    const unc = wslPathToUnc(distro, home, prefix)
    const anchor = wslAnchor(distro, prefix)
    if (!unc || !anchor) continue

    // id 完全由原名确定性派生(base 仅为可读前缀,hash 保证唯一与稳定),与遍历顺序/邻居无关。
    const hash = createHash('sha256').update(distro).digest('hex').slice(0, 8)
    const base = sanitizeDistro(distro)
    const id = base ? `wsl-${base}-${hash}` : `wsl-${hash}`
    if (usedIds.has(id)) continue                                  // 真正同名 distro(重复探测)→跳过,不污染
    usedIds.add(id)

    const paths = deriveClaudePaths(unc, winPath.join)
    out.push(buildSource(id, distro, paths, { osFamily: 'posix', fsAnchor: anchor, claudeHomeCwd: home, exists: true }))
  }
  return out
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

// 同步探测:始终含本机(WSL 下标注 "WSL (Linux)");在 WSL 中且找到 Windows 侧 .claude 时再加 "Windows"。
// win32 下不在此探测 WSL(避免卡死启动),WSL 源经 detectWslSourcesFromWindows() 异步并入。
export function detectSources(): Source[] {
  const wsl = isWSL()
  // 本机源 osFamily:win32 host=windows;WSL/Linux/Mac=posix。
  const localFamily: OsFamily = process.platform === 'win32' ? 'windows' : 'posix'
  const sources: Source[] = [localSource('local', wsl ? 'WSL (Linux)' : '本机', homedir(), localFamily)]
  if (wsl) {
    const wh = windowsHome()
    // Windows-反向源经 /mnt/c 访问,但装的是 Windows 的 .claude(会话 cwd C:\…)→ osFamily=windows。
    if (wh) sources.push(localSource('windows', 'Windows', wh, 'windows'))
  }
  return sources
}

// ───────────────────────── 以下为 Windows host → WSL 异步探测(薄副作用 wrapper,不写单测,对齐 windowsHome 现状) ─────────────────────────

const WSL_EXE = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'wsl.exe') : 'wsl.exe'
const PROBE_TIMEOUT = 4000
const AGGREGATE_TIMEOUT = 8000
const MAX_DISTROS = 16
const TOOL_DISTRO = /^(docker-desktop|podman-machine|rancher-desktop)/i

function execFileAsync(file: string, args: string[], encoding: BufferEncoding | 'buffer', timeout: number): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    const opts = { encoding: encoding as BufferEncoding, timeout, windowsHide: true }
    execFile(file, args, opts, (err, stdout) => {
      if (err) reject(err); else resolve(stdout as unknown as Buffer | string)
    })
  })
}

// 解析 `wsl --list --verbose` 的输出(已解码去 BOM)为 {name,state,version}[]。
// 纯函数,可单测。关键:NAME 列允许空格(如 "Ubuntu 22.04 LTS"),--verbose 是定宽空格填充,
// 故**从右解析**:末两段为 STATE/VERSION,其余拼回 NAME(三段固定正则会把多词名整行漏掉)。
export function parseWslListVerbose(text: string): { name: string; state: string; version: string }[] {
  const out: { name: string; state: string; version: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/﻿/g, '').replace(/\0/g, '').replace(/^\*/, '').trim()
    if (!line || /^NAME\s+STATE\s+VERSION/i.test(line)) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const version = parts[parts.length - 1]
    const state = parts[parts.length - 2]
    const name = parts.slice(0, parts.length - 2).join(' ')
    out.push({ name, state, version })
  }
  return out
}

// 枚举运行中的 WSL2 发行版(`wsl --list --verbose`,UTF-16LE+可能 BOM)。失败返 []。
export async function listRunningWslDistros(): Promise<string[]> {
  let text: string
  try {
    const buf = (await execFileAsync(WSL_EXE, ['--list', '--verbose'], 'buffer', PROBE_TIMEOUT)) as Buffer
    text = buf.toString('utf16le').replace(/^﻿/, '')
  } catch { return [] }
  const out: string[] = []
  for (const { name, state, version } of parseWslListVerbose(text)) {
    if (state !== 'Running' || version !== '2') continue           // 仅运行中的 WSL2(WSL1 无 UNC rootfs)
    if (!isValidDistroName(name)) continue
    if (TOOL_DISTRO.test(name)) continue                           // 工具发行版:性能优化跳过(正确性由 exists 兜底)
    out.push(name)
    if (out.length >= MAX_DISTROS) break
  }
  return out
}

// 探测单个发行版:默认用户 HOME + 内部 .claude/projects 是否存在(一次 wsl --exec 拿全,passthrough UTF-8)。
// 默认 HOME 无 .claude 时回退枚举 /home/* 取存在者(防默认用户=root 漏掉人类用户的源)。
export async function probeWslDistro(distro: string): Promise<WslProbe | null> {
  if (!isValidDistroName(distro)) return null
  // 一次调用:打印 HOME,再对 HOME 与各 /home/* 逐一报告哪个含 .claude/projects。
  const script =
    'printf "HOME=%s\\n" "$HOME"; ' +
    'for d in "$HOME" /home/*; do [ -d "$d/.claude/projects" ] && printf "HIT=%s\\n" "$d"; done'
  let text: string
  try {
    text = (await execFileAsync(WSL_EXE, ['-d', distro, '--exec', 'sh', '-c', script], 'utf8', PROBE_TIMEOUT)) as string
  } catch { return null }
  let home = ''
  const hits: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const h = /^HOME=(.*)$/.exec(line); if (h) home = h[1].trim()
    const x = /^HIT=(.*)$/.exec(line); if (x) hits.push(x[1].trim())
  }
  // 默认 HOME 落在 /mnt/*(家目录设在 Windows 盘)→ 属 Windows 源域,跳过。
  if (home.startsWith('/mnt/')) return null
  if (!isCleanPosixAbs(home)) return null
  // 优先默认 HOME;否则取第一个含 .claude/projects 的 /home/* 用户(回退防漏源)。
  if (hits.includes(home)) return { distro, home, exists: true }
  const fallback = hits.find((h) => h.startsWith('/home/') && isCleanPosixAbs(h))
  if (fallback) return { distro, home: fallback, exists: true }
  return { distro, home, exists: false }
}

// 编排:Windows host 上枚举 running WSL2 → 并发探测(带聚合超时兜底)→ 构造 Source[]。仅产出 exists 的源。
export async function detectWslSourcesFromWindows(): Promise<Source[]> {
  if (process.platform !== 'win32') return []
  const distros = await listRunningWslDistros()
  // 聚合超时:即便个别 probe 的单次 timeout 退化,整体探测也不超过该预算,避免拖住前端刷新。
  const budget = new Promise<(WslProbe | null)[]>((resolve) => setTimeout(() => resolve(distros.map(() => null)), AGGREGATE_TIMEOUT))
  const all = Promise.all(distros.map((d) => probeWslDistro(d).catch(() => null)))
  const probes: (WslProbe | null)[] = await Promise.race([all, budget])
  return buildWslSources(probes.filter((p): p is WslProbe => p != null))
}
