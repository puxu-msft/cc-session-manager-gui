import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { snapshotSession, restoreVersion } from './archiver'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'arch3-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  // 偏离 plan:fixture 必须含 cwd,否则会被 Task 5 的「空 cwd 护栏」拒绝快照(详见任务报告)
  const v1line = JSON.stringify({ type: 'user', cwd: src, message: { content: 'v1' } }) + '\n'
  writeFileSync(jsonl, v1line)
  const old = new Date(Date.now() - 600_000); utimesSync(jsonl, old, old)
  return { home, projects, archiveRoot, backupsRoot, src, fdir, jsonl, v1line }
}
const envOf = (w: any, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, claudeJsonPath: join(w.home, '.claude.json'), db })

describe('restoreVersion', () => {
  it('还原旧版本:内容回到 v1,现状(v2 + 多余文件)整体进备份区', async () => {
    const w = world(); const db = openDb(':memory:')
    const snap = await snapshotSession('s1', envOf(w, db))   // 版本 = v1 内容
    // 会话演进为 v2,并新增一个版本里没有的 sidecar 文件
    const v2line = JSON.stringify({ type: 'user', cwd: w.src, message: { content: 'v2 content longer' } }) + '\n'
    writeFileSync(w.jsonl, v2line)
    mkdirSync(join(w.fdir, 's1'), { recursive: true })
    writeFileSync(join(w.fdir, 's1', 'extra.txt'), 'only-in-current')
    const old = new Date(Date.now() - 600_000); utimesSync(w.jsonl, old, old)

    const res = await restoreVersion(snap.versionId!, envOf(w, db))
    expect(res.status).toBe('done')
    // 主 jsonl 回到 v1
    expect(readFileSync(w.jsonl, 'utf8')).toBe(w.v1line)
    // 备份区含还原前现状的完整镜像:v2 主文件 + 多余 extra.txt
    const r = db.getRestore(res.restoreId!)
    expect(readFileSync(join(r.backupPath, 's1.jsonl'), 'utf8')).toBe(v2line)
    expect(readFileSync(join(r.backupPath, 's1', 'extra.txt'), 'utf8')).toBe('only-in-current')
    // 还原后目标里不应残留 extra.txt(整体替换,版本里没有它)
    expect(existsSync(join(w.fdir, 's1', 'extra.txt'))).toBe(false)
  })

  it('版本含 sidecar:用版本 sidecar 整体替换现状,现状改动与多余文件进备份', async () => {
    const w = world(); const db = openDb(':memory:')
    // 快照时已有 sidecar keep.txt
    mkdirSync(join(w.fdir, 's1'), { recursive: true })
    writeFileSync(join(w.fdir, 's1', 'keep.txt'), 'v1-keep')
    const old = new Date(Date.now() - 600_000); utimesSync(w.jsonl, old, old)
    const snap = await snapshotSession('s1', envOf(w, db))
    // 演进:keep.txt 改内容 + 新增 extra.txt
    writeFileSync(join(w.fdir, 's1', 'keep.txt'), 'v2-keep-changed')
    writeFileSync(join(w.fdir, 's1', 'extra.txt'), 'only-current')
    utimesSync(w.jsonl, old, old)
    const res = await restoreVersion(snap.versionId!, envOf(w, db))
    expect(res.status).toBe('done')
    // 目标 sidecar 回到版本内容:keep.txt 复原、extra.txt 不残留
    expect(readFileSync(join(w.fdir, 's1', 'keep.txt'), 'utf8')).toBe('v1-keep')
    expect(existsSync(join(w.fdir, 's1', 'extra.txt'))).toBe(false)
    // 备份区是还原前现状完整镜像
    const r = db.getRestore(res.restoreId!)
    expect(readFileSync(join(r.backupPath, 's1', 'keep.txt'), 'utf8')).toBe('v2-keep-changed')
    expect(readFileSync(join(r.backupPath, 's1', 'extra.txt'), 'utf8')).toBe('only-current')
  })

  it('编码碰撞:目标文件夹被不同真实 cwd 占用 → 阻断', async () => {
    const w = world(); const db = openDb(':memory:')
    const snap = await snapshotSession('s1', envOf(w, db))
    // 归档移走原件后,目标 folder 被另一真实 cwd 的会话占用
    const otherJsonl = join(w.fdir, 'other.jsonl')
    writeFileSync(otherJsonl, JSON.stringify({ type: 'user', cwd: '/different/cwd', message: {} }) + '\n')
    rmSync(w.jsonl)   // 删掉 s1 原件,模拟"已归档"
    const res = await restoreVersion(snap.versionId!, envOf(w, db))
    expect(res.status).toBe('skipped')
    expect(res.error).toMatch(/占用|碰撞/)
  })
})
