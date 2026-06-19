import { existsSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 项目改名(cc-move-session → cc-session-manager-gui)后的一次性数据迁移。
// 启动时由 appState 幂等调用:把旧名下的用户数据搬到新名,使既有移动/归档/还原历史不丢。
//
// 改名涉及两处磁盘位置:
//   1. userData(`~/.config/<appName>/index-*.db`):随 app 名变化,需把旧 app 目录里的 index 库搬进新目录。
//   2. `~/.claude/.cc-move-{trash,archive,backups}`:数据目录改名,物理 rename + 重写库里存的绝对路径。
//
// 路径解析特性(决定迁移做法,见各处实测):
//   - trash:undoMove 由「当前 trashRoot + moveId」派生,不读库存的 trash_path → 只需 rename 目录。
//   - archive:版本文件由 archiveRoot 派生定位 → 只需 rename 目录。
//   - backups:undoRestore 读库存的绝对 backup_path → rename 目录后须重写库(见 db.rewriteDataRootPaths)。

export const OLD_APP_NAME = 'cc-move-session'

// 旧目录在、新目录不在 → 整体 rename。幂等(任一条件不满足即 no-op)。返回是否真的搬动。
export function migrateDir(oldPath: string, newPath: string): boolean {
  if (!existsSync(oldPath) || existsSync(newPath)) return false
  try { renameSync(oldPath, newPath); return true } catch { return false }
}

// userData 跨 app 名迁移:把旧 app 目录(与新目录同父、仅末级名不同)里的 index 库文件
// (index*.db 连 -wal/-shm)搬进新 userData;仅搬新目录尚不存在的,避免覆盖新数据。幂等。
export function migrateUserData(newUserData: string): void {
  const oldUserData = join(dirname(newUserData), OLD_APP_NAME)
  if (oldUserData === newUserData || !existsSync(oldUserData)) return
  let files: string[]
  try { files = readdirSync(oldUserData) } catch { return }
  for (const f of files) {
    if (!/^index.*\.db(-wal|-shm)?$/.test(f)) continue
    const dst = join(newUserData, f)
    if (existsSync(dst)) continue
    try { renameSync(join(oldUserData, f), dst) } catch { /* 单个失败不阻断其余 */ }
  }
}

// 最小 db 依赖(避免迁移模块反向依赖 repository 具体类型)。
interface DataPathRewriter {
  rewriteDataRootPaths(oldBackupsRoot: string, newBackupsRoot: string, oldTrashRoot: string, newTrashRoot: string): void
}

// 单个数据源的迁移:rename 三个 `.cc-move-*` 目录 → 新名,并重写库里存的绝对路径前缀(幂等)。
// `claudeDotDir` 为该源的 `<claudeHome>/.claude` 目录(= dirname(source.trashRoot))。
//
// 数据安全关键:只有当「旧目录已不在 + 新目录就位」(= 数据确实已搬到新名)时才重写库内绝对路径。
// 否则——rename 失败、被跳过(新目录已存在故不覆盖)、或 Windows 源 home 探测漂移——旧目录仍在原处,
// 此时保持库里旧路径不动,undoRestore 仍能在旧目录找到备份;绝不让库指向一个不存在的新目录。
export function migrateSourceData(claudeDotDir: string, db: DataPathRewriter): void {
  const oldTrash = join(claudeDotDir, '.cc-move-trash'), newTrash = join(claudeDotDir, '.cc-session-manager-trash')
  const oldArchive = join(claudeDotDir, '.cc-move-archive'), newArchive = join(claudeDotDir, '.cc-session-manager-archive')
  const oldBackups = join(claudeDotDir, '.cc-move-backups'), newBackups = join(claudeDotDir, '.cc-session-manager-backups')
  migrateDir(oldTrash, newTrash)
  migrateDir(oldArchive, newArchive)
  migrateDir(oldBackups, newBackups)
  // movedTo:数据已搬到新名 → 返回新前缀;否则返回旧前缀(old===new 时重写为 no-op)。
  const movedTo = (old: string, neu: string): string => (!existsSync(old) && existsSync(neu)) ? neu : old
  db.rewriteDataRootPaths(
    oldBackups, movedTo(oldBackups, newBackups),
    oldTrash, movedTo(oldTrash, newTrash),
  )
}
