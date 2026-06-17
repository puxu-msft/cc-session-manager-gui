import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { scanProject } from './scanner'
import { applyProjectScan } from '../refresh'

const line = (o: unknown) => JSON.stringify(o)
function writeSession(root: string, cwd: string, id: string, contents: string[]) {
  const fdir = join(root, encodePath(cwd))
  mkdirSync(fdir, { recursive: true })
  writeFileSync(join(fdir, `${id}.jsonl`), contents.join('\n') + '\n')
}

describe('scanProject + applyProjectScan(单项目刷新)', () => {
  it('只扫指定项目并落库,不影响其它项目', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'))
    const db = openDb(':memory:')
    writeSession(root, '/work/a', 's1', [line({ type: 'user', cwd: '/work/a', timestamp: '2026-06-15T10:00:00Z', message: { content: 'a1' } })])
    writeSession(root, '/work/b', 's2', [line({ type: 'user', cwd: '/work/b', timestamp: '2026-06-15T11:00:00Z', message: { content: 'b1' } })])

    const diffA = applyProjectScan(db, '/work/a', await scanProject(root, '/work/a'))
    expect(diffA.added).toEqual(['s1'])
    expect(db.getSessions('/work/a').map((s: any) => s.session_id)).toEqual(['s1'])
    expect(db.getSessions('/work/b')).toEqual([]) // b 未受影响(未扫)

    applyProjectScan(db, '/work/b', await scanProject(root, '/work/b'))
    expect(db.getSessions('/work/b').map((s: any) => s.session_id)).toEqual(['s2'])
    expect(db.getSessions('/work/a').map((s: any) => s.session_id)).toEqual(['s1']) // a 仍在

    rmSync(root, { recursive: true, force: true })
  })

  it('单刷识别该项目内的 增/改/删', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'))
    const db = openDb(':memory:')
    writeSession(root, '/p', 's1', [line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'x' } })])
    writeSession(root, '/p', 's2', [line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'y' } })])
    applyProjectScan(db, '/p', await scanProject(root, '/p'))
    expect(db.getSessions('/p').map((s: any) => s.session_id).sort()).toEqual(['s1', 's2'])

    rmSync(join(root, encodePath('/p'), 's2.jsonl')) // 删 s2
    writeSession(root, '/p', 's3', [line({ type: 'user', cwd: '/p', timestamp: 't', message: { content: 'z' } })]) // 增 s3
    const diff = applyProjectScan(db, '/p', await scanProject(root, '/p'))
    expect(diff.removed).toEqual(['s2'])
    expect(diff.added).toEqual(['s3'])
    expect(db.getSessions('/p').map((s: any) => s.session_id).sort()).toEqual(['s1', 's3'])

    rmSync(root, { recursive: true, force: true })
  })

  it('项目文件夹不存在 → 空结果,不抛', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'))
    const r = await scanProject(root, '/nope')
    expect(r).toEqual({ project: null, sessions: [] })
    rmSync(root, { recursive: true, force: true })
  })
})
