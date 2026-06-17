import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePath } from './pathCodec'
import { detectChanges, type ExistingSessionRow } from './updates'

// 写一个会话文件并返回与之一致的索引行(模拟"已索引且未变")
function write(root: string, cwd: string, id: string, content: string): ExistingSessionRow {
  const fdir = join(root, encodePath(cwd))
  mkdirSync(fdir, { recursive: true })
  const p = join(fdir, `${id}.jsonl`)
  writeFileSync(p, content)
  const st = statSync(p)
  return { session_id: id, size_bytes: st.size, mtime: st.mtimeMs, project_path_abs: cwd }
}

describe('detectChanges', () => {
  it('已索引且未变 → 全 0、无受影响项目', () => {
    const root = mkdtempSync(join(tmpdir(), 'upd-'))
    const e1 = write(root, '/p', 's1', 'aaa')
    expect(detectChanges(root, [e1])).toEqual({ added: 0, changed: 0, removed: 0, changedProjects: [] })
    rmSync(root, { recursive: true, force: true })
  })

  it('磁盘有、索引无 → added(不归项目)', () => {
    const root = mkdtempSync(join(tmpdir(), 'upd-'))
    write(root, '/p', 's1', 'aaa')
    const r = detectChanges(root, [])
    expect(r.added).toBe(1)
    expect(r.changed).toBe(0)
    expect(r.changedProjects).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('size 变化 → changed,项目计入 changedProjects', () => {
    const root = mkdtempSync(join(tmpdir(), 'upd-'))
    const e1 = write(root, '/p', 's1', 'aaa')
    writeFileSync(join(root, encodePath('/p'), 's1.jsonl'), 'aaaaaa') // 变大
    const r = detectChanges(root, [e1])
    expect(r.changed).toBe(1)
    expect(r.added).toBe(0)
    expect(r.changedProjects).toEqual(['/p'])
    rmSync(root, { recursive: true, force: true })
  })

  it('索引有、磁盘无 → removed,项目计入', () => {
    const root = mkdtempSync(join(tmpdir(), 'upd-'))
    const ghost: ExistingSessionRow = { session_id: 'gone', size_bytes: 10, mtime: 1, project_path_abs: '/q' }
    const r = detectChanges(root, [ghost])
    expect(r.removed).toBe(1)
    expect(r.changedProjects).toEqual(['/q'])
    rmSync(root, { recursive: true, force: true })
  })

  it('projectsRoot 不存在 → 全 0', () => {
    expect(detectChanges('/no/such/dir', [])).toEqual({ added: 0, changed: 0, removed: 0, changedProjects: [] })
  })

  it('混合:1 未变 + 1 变 + 1 新 + 1 删', () => {
    const root = mkdtempSync(join(tmpdir(), 'upd-'))
    const stable = write(root, '/a', 's1', 'xx')
    const willChange = write(root, '/a', 's2', 'yy')
    writeFileSync(join(root, encodePath('/a'), 's2.jsonl'), 'yyyy') // s2 变
    write(root, '/b', 's3', 'zz') // s3 新增(索引无)
    const ghost: ExistingSessionRow = { session_id: 's4', size_bytes: 1, mtime: 1, project_path_abs: '/c' } // s4 删
    const r = detectChanges(root, [stable, willChange, ghost])
    expect(r).toEqual({ added: 1, changed: 1, removed: 1, changedProjects: expect.arrayContaining(['/a', '/c']) })
    expect(r.changedProjects.sort()).toEqual(['/a', '/c'])
    rmSync(root, { recursive: true, force: true })
  })
})
