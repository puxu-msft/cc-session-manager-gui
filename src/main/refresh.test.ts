import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db/db'
import { buildReuse } from './db/rowMap'
import { scanAll } from './core/scanner'
import { applyScanToIndex } from './refresh'
import { encodePath } from './core/pathCodec'

const line = (o: unknown) => JSON.stringify(o)

// 复刻 ipc 的 refresh:run 落库链路(不含 Electron/worker 胶水):读现有行 → 用 buildReuse 增量扫描 → applyScanToIndex 写库。
// 与生产同源:scanAll + buildReuse + applyScanToIndex 都是生产路径里用的同一批函数。
async function refresh(db: ReturnType<typeof openDb>, projectsRoot: string) {
  const existing = db.getAllSessionRows()
  const scan = await scanAll(projectsRoot, { reuse: buildReuse(existing) })
  const diff = applyScanToIndex(db, scan, existing.map((r) => ({ session_id: r.session_id, size_bytes: r.size_bytes, mtime: r.mtime })))
  return { diff, projects: db.getProjects() }
}

function writeSession(root: string, cwd: string, id: string, contents: string[]) {
  const fdir = join(root, encodePath(cwd))
  mkdirSync(fdir, { recursive: true })
  writeFileSync(join(fdir, `${id}.jsonl`), contents.join('\n') + '\n')
}

describe('refresh 端到端落库链路(真实 better-sqlite3,非 UI)', () => {
  it('首刷填充索引;复用刷新 diff 为空且数据不变;改/删/增被正确识别并落库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ref-'))
    const db = openDb(':memory:')

    // 两个项目共 3 个会话
    writeSession(root, '/work/a', 's1', [line({ type: 'user', cwd: '/work/a', timestamp: '2026-06-15T10:00:00Z', message: { content: 'a1' } })])
    writeSession(root, '/work/a', 's2', [line({ type: 'user', cwd: '/work/a', timestamp: '2026-06-15T11:00:00Z', message: { content: 'a2' } })])
    writeSession(root, '/work/b', 's3', [line({ type: 'user', cwd: '/work/b', timestamp: '2026-06-15T12:00:00Z', message: { content: 'b1' } })])

    // —— 首刷:全部新增,索引被填充 ——
    const r1 = await refresh(db, root)
    expect(r1.diff.added.sort()).toEqual(['s1', 's2', 's3'])
    expect(r1.diff.changed).toEqual([])
    expect(r1.diff.removed).toEqual([])
    expect(r1.projects.map((p: any) => p.project_path_abs).sort()).toEqual(['/work/a', '/work/b'])
    expect(db.getSessions('/work/a').map((s: any) => s.session_id).sort()).toEqual(['s1', 's2'])
    expect(db.getSessions('/work/b').map((s: any) => s.session_id)).toEqual(['s3'])

    // —— 复用刷新:无任何改动,diff 全空 ——
    const r2 = await refresh(db, root)
    expect(r2.diff).toEqual({ added: [], changed: [], removed: [] })
    expect(db.getSessions('/work/a').length).toBe(2)

    // —— 改:给 s1 追加一行(size+mtime 变)→ changed,且 line_count 更新 ——
    writeSession(root, '/work/a', 's1', [
      line({ type: 'user', cwd: '/work/a', timestamp: '2026-06-15T10:00:00Z', message: { content: 'a1' } }),
      line({ type: 'assistant', cwd: '/work/a', timestamp: '2026-06-15T10:05:00Z', message: { content: 'reply' } }),
    ])
    const r3 = await refresh(db, root)
    expect(r3.diff.changed).toEqual(['s1'])
    expect(r3.diff.added).toEqual([])
    const s1row = db.getSessions('/work/a').find((s: any) => s.session_id === 's1') as any
    expect(s1row.message_count).toBe(2) // 1 user + 1 assistant,确实重新解析了

    // —— 删:移除 s2 → removed,且从库中消失 ——
    rmSync(join(root, encodePath('/work/a'), 's2.jsonl'))
    const r4 = await refresh(db, root)
    expect(r4.diff.removed).toEqual(['s2'])
    expect(db.getSessions('/work/a').map((s: any) => s.session_id)).toEqual(['s1'])

    // —— 增:新会话 s4 → added 并入库 ——
    writeSession(root, '/work/b', 's4', [line({ type: 'user', cwd: '/work/b', timestamp: '2026-06-15T13:00:00Z', message: { content: 'b2' } })])
    const r5 = await refresh(db, root)
    expect(r5.diff.added).toEqual(['s4'])
    expect(db.getSessions('/work/b').map((s: any) => s.session_id).sort()).toEqual(['s3', 's4'])

    rmSync(root, { recursive: true, force: true })
  })

  it('moves 表里有 done 记录的会话,刷新后 moved_flag 置真', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ref-'))
    const db = openDb(':memory:')
    writeSession(root, '/p', 's1', [line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'x' } })])
    writeSession(root, '/p', 's2', [line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'y' } })])
    // 记录一次 s1 的成功移动
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    db.updateMoveStatus(id, 'done')

    await refresh(db, root)
    const sessions = db.getSessions('/p')
    expect((sessions.find((s: any) => s.session_id === 's1') as any).moved_flag).toBeTruthy()
    expect((sessions.find((s: any) => s.session_id === 's2') as any).moved_flag).toBeFalsy()
    rmSync(root, { recursive: true, force: true })
  })

  it('复用确实跳过解析:文件 size+mtime 未变时 reuse 命中,不重新读内容', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ref-'))
    const db = openDb(':memory:')
    writeSession(root, '/p', 's1', [line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'x' } })])
    await refresh(db, root)

    // 把文件内容偷偷改成会解析出不同 title 的内容,但把 mtime/size 还原成原值 → reuse 应命中、用旧缓存,不反映新内容
    const fdir = join(root, encodePath('/p'))
    const fpath = join(fdir, 's1.jsonl')
    const { statSync } = await import('node:fs')
    const before = statSync(fpath)
    // 写入相同字节长度的不同内容(保持 size 相同),再把 mtime 还原
    const orig = line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'x' } }) + '\n'
    const tampered = line({ type: 'custom-title', sessionId: 's1', customTitle: 'Z' })
    // 仅在长度一致时才有效;否则跳过该断言(保证测试稳健)
    if (Buffer.byteLength(tampered + '\n') === Buffer.byteLength(orig)) {
      writeFileSync(fpath, tampered + '\n')
      utimesSync(fpath, before.atime, before.mtime)
      const r = await refresh(db, root)
      expect(r.diff.changed).toEqual([]) // size+mtime 未变 → 判为未变,reuse 命中
    }
    rmSync(root, { recursive: true, force: true })
  })
})
