// 把绝对路径编码成 ~/.claude/projects 下的文件夹名:每个非字母数字字符替换成 -,不折叠连续分隔符
export function encodePath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-')
}

// 前缀重定位:会话移动时把 cwd 从源根改写到目标根,源根之外的 cwd 原样保留
export function reRoot(cwd: string, srcRoot: string, dstRoot: string): string {
  if (cwd === srcRoot) return dstRoot
  const prefix = srcRoot.endsWith('/') ? srcRoot : srcRoot + '/'
  if (cwd.startsWith(prefix)) return dstRoot.replace(/\/$/, '') + '/' + cwd.slice(prefix.length)
  return cwd
}

// 把会话 cwd 映射到「宿主可访问」物理路径的描述符(可序列化,传给扫描 worker)。
// - identity:源与宿主同 OS 家族,cwd 已是宿主原生路径,无需映射。
// - posixToUnc:posix 源跑在 Windows host(WSL 数据源),POSIX cwd → \\wsl.localhost\<distro>\…。
// - winToMnt:windows 源跑在 posix host(WSL 内访问 Windows 侧),C:\… → /mnt/c/…。
export type CwdHostMap =
  | { kind: 'identity' }
  | { kind: 'posixToUnc'; anchor: string }
  | { kind: 'winToMnt' }

// 由「宿主是否 Windows + 源 osFamily + 源 fsAnchor」推出映射方式(纯函数)。
// 关键:用 osFamily 而非解析 fsAnchor 字符串来判别——这正是 osFamily 不可由 fsAnchor 推导的体现。
export function cwdHostMapFor(hostIsWindows: boolean, osFamily: 'windows' | 'posix', fsAnchor: string): CwdHostMap {
  const hostFamily: 'windows' | 'posix' = hostIsWindows ? 'windows' : 'posix'
  if (osFamily === hostFamily) return { kind: 'identity' }       // 同族:cwd 即宿主原生路径
  if (osFamily === 'posix') return { kind: 'posixToUnc', anchor: fsAnchor }  // WSL 源在 Windows host
  return { kind: 'winToMnt' }                                    // Windows 源在 posix host
}

// 按描述符把单个 cwd 映射到宿主可访问路径,供 existsSync 判存在。非可映射的输入原样返回。
export function hostPathForCwd(cwd: string, map?: CwdHostMap): string {
  if (!map || map.kind === 'identity') return cwd
  if (map.kind === 'posixToUnc') {
    if (!cwd.startsWith('/')) return cwd
    return map.anchor + '\\' + cwd.slice(1).replace(/\//g, '\\')
  }
  // winToMnt:C:\Users\xp → /mnt/c/Users/xp(镜像 sources.winPathToWsl,此处内联以保持 core 不依赖 sources)。
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(cwd.trim())
  if (!m) return cwd
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}


