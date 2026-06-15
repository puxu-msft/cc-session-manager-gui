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
