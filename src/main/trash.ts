import { readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TrashUsage } from '@shared/types'

// 递归计算目录占用字节数,坏条目跳过不抛。
function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(p)
      else if (e.isFile()) total += statSync(p).size
    } catch { /* 跳过不可读条目 */ }
  }
  return total
}

// 回收区占用:每个子目录以 moveId 命名,返回每条移动的备份占用与总占用。
export function trashUsage(trashRoot: string): TrashUsage {
  const byMove: Record<string, number> = {}
  let total = 0
  if (existsSync(trashRoot)) {
    for (const e of readdirSync(trashRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const sz = dirSize(join(trashRoot, e.name))
      byMove[e.name] = sz
      total += sz
    }
  }
  return { total, byMove }
}

// 清理某次移动的回收区备份(清理后该次移动不可再撤销)。
export function purgeMove(trashRoot: string, moveId: number | string): void {
  const dir = join(trashRoot, String(moveId))
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

// 清空整个回收区。
export function purgeAllTrash(trashRoot: string): void {
  if (!existsSync(trashRoot)) return
  for (const e of readdirSync(trashRoot, { withFileTypes: true })) {
    if (e.isDirectory()) rmSync(join(trashRoot, e.name), { recursive: true, force: true })
  }
}
