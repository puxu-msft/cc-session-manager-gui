import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { executeMove, undoMove } from './mover'
import { encodePath } from './pathCodec'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const trash = join(home, '.claude', '.cc-session-manager-trash'); mkdirSync(trash, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const dst = join(home, 'work', 'moved'); mkdirSync(dst, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  writeFileSync(jsonl, [
    JSON.stringify({ type: 'user', cwd: src, timestamp: '2026-06-15T10:00:00Z', message: { content: `opened ${src}/a.md` } }),
    JSON.stringify({ type: 'assistant', cwd: src, timestamp: '2026-06-15T10:01:00Z', message: { content: 'ok' } }),
  ].join('\n') + '\n')
  utimesSync(jsonl, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000))
  return { home, projects, trash, src, dst, fdir, jsonl }
}

describe('executeMove', () => {
  it('把会话搬到目标、改写 cwd、正文不动、原件进回收区', async () => {
    const w = world()
    const db = openDb(':memory:')
    const res = await executeMove(['s1'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: join(w.home, '.claude.json'), db })
    expect(res[0].status).toBe('done')

    const targetJsonl = join(w.projects, encodePath(w.dst), 's1.jsonl')
    expect(existsSync(targetJsonl)).toBe(true)
    expect(existsSync(w.jsonl)).toBe(false)

    const lines = readFileSync(targetJsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].cwd).toBe(w.dst)
    expect(lines[0].message.content).toBe(`opened ${w.src}/a.md`)

    const trashDir = join(w.trash, String(res[0].moveId))
    expect(readdirSync(trashDir, { recursive: true as any }).length).toBeGreaterThan(0)
  })

  it('找不到的会话 → skipped 不影响其它', async () => {
    const w = world(); const db = openDb(':memory:')
    const res = await executeMove(['nope'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: join(w.home, '.claude.json'), db })
    expect(res[0].status).toBe('skipped')
  })

  it('成功移动后 undoMove 把会话搬回源、移除 claude.json 条目、状态 rolledback', async () => {
    const w = world(); const db = openDb(':memory:')
    const claudeJsonPath = join(w.home, '.claude.json')
    // 预置 .claude.json,使 ensureProjectEntry 能写入目标条目
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [w.src]: { allowedTools: ['x'] } } }, null, 2))

    const res = await executeMove(['s1'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath, db })
    expect(res[0].status).toBe('done')
    const moveId = res[0].moveId!
    // 目标条目应已加入
    expect(JSON.parse(readFileSync(claudeJsonPath, 'utf8')).projects[w.dst]).toBeTruthy()

    undoMove(moveId, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath, db })

    // 会话回到源、目标已清空
    expect(existsSync(w.jsonl)).toBe(true)
    expect(existsSync(join(w.projects, encodePath(w.dst), 's1.jsonl'))).toBe(false)
    // 正文与 cwd 已还原(回收区备份是改写前原件)
    const back = readFileSync(w.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(back[0].cwd).toBe(w.src)
    // claude.json 目标条目被移除
    expect(JSON.parse(readFileSync(claudeJsonPath, 'utf8')).projects[w.dst]).toBeUndefined()
    // 状态 rolledback
    const m = db.getMoves().find((x) => x.id === moveId)
    expect(m.status).toBe('rolledback')
  })

  it('目标已被占用导致失败时,源文件仍在原位、状态 failed', async () => {
    const w = world(); const db = openDb(':memory:')
    // 预先在回收区放置只读冲突:用一个已存在的同名文件夹+只读文件让 renameSync 进回收区时失败
    // 更稳的触发:让目标主文件写入校验通过,但把 trashDir 下的目标名预置成目录,使 renameSync(found.jsonl, ...) 抛错
    const moveId0 = 1
    const trashDir = join(w.trash, String(moveId0))
    mkdirSync(join(trashDir, 's1.jsonl'), { recursive: true }) // 同名目录,使 renameSync 文件→该路径失败

    const res = await executeMove(['s1'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: join(w.home, '.claude.json'), db })
    expect(res[0].status).toBe('failed')
    // 源文件仍在原位
    expect(existsSync(w.jsonl)).toBe(true)
    const m = db.getMoves().find((x) => x.id === res[0].moveId)
    expect(m.status).toBe('failed')
  })
})
