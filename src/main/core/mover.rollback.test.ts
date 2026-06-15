import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { executeMove } from './mover'
import { encodePath } from './pathCodec'

// 构造带完整 sidecar(verbatim 文件 + subagent jsonl + meta)的会话世界
function world() {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const trash = join(home, '.claude', '.cc-move-trash'); mkdirSync(trash, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const dst = join(home, 'work', 'moved'); mkdirSync(dst, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  writeFileSync(jsonl, [
    JSON.stringify({ type: 'user', cwd: src, timestamp: '2026-06-15T10:00:00Z', message: { content: `opened ${src}/a.md` } }),
    JSON.stringify({ type: 'assistant', cwd: src, timestamp: '2026-06-15T10:01:00Z', message: { content: 'ok' } }),
  ].join('\n') + '\n')
  utimesSync(jsonl, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000))

  // sidecar:subagent jsonl(会被改写)+ meta(verbatim)+ tool-results + hooks + 顶层散落文件
  const sidecar = join(fdir, 's1')
  mkdirSync(join(sidecar, 'subagents'), { recursive: true })
  writeFileSync(join(sidecar, 'subagents', 'agent-x.jsonl'),
    JSON.stringify({ type: 'user', cwd: src, timestamp: 't', message: { content: 'sub' } }) + '\n')
  writeFileSync(join(sidecar, 'subagents', 'agent-x.meta.json'), JSON.stringify({ name: 'agent-x' }))
  mkdirSync(join(sidecar, 'tool-results'), { recursive: true })
  writeFileSync(join(sidecar, 'tool-results', 'r.txt'), 'tool-result-payload')
  mkdirSync(join(sidecar, 'hooks'), { recursive: true })
  writeFileSync(join(sidecar, 'hooks', 'h.txt'), 'hook-payload')
  writeFileSync(join(sidecar, 'stray.bin'), 'stray-payload')

  return { home, projects, trash, src, dst, fdir, jsonl, sidecar }
}

describe('executeMove 回滚保护 verbatim sidecar (BUG 1)', () => {
  it('源→回收区步骤抛错时,verbatim sidecar 文件全部回到源、无残留目标、状态 failed', async () => {
    const w = world(); const db = openDb(':memory:')
    // 第一个 move 的 id 必为 1;预置 <trash>/1/s1.jsonl 为目录,使 renameSync(源主文件→回收区)抛 EISDIR/ENOTEMPTY
    const trashDir = join(w.trash, '1')
    mkdirSync(join(trashDir, 's1.jsonl'), { recursive: true })

    const res = await executeMove(['s1'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: join(w.home, '.claude.json'), db })
    expect(res[0].status).toBe('failed')

    // 所有 verbatim sidecar 文件必须回到源(可恢复)
    expect(existsSync(join(w.sidecar, 'tool-results', 'r.txt'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'hooks', 'h.txt'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'stray.bin'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'subagents', 'agent-x.jsonl'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'subagents', 'agent-x.meta.json'))).toBe(true)
    // 主文件仍在源
    expect(existsSync(w.jsonl)).toBe(true)

    // 不留半成品目标 sidecar
    expect(existsSync(join(w.projects, encodePath(w.dst), 's1'))).toBe(false)

    const m = db.getMoves().find((x) => x.id === res[0].moveId)
    expect(m.status).toBe('failed')
  })
})

describe('executeMove 回滚保护 已入回收区的源会话 (BUG 失败发生在源入回收区之后)', () => {
  it('ensureProjectEntry 抛错时,源主文件+完整 sidecar(subagents+meta+verbatim)全部还原、回收区清空、状态 failed', async () => {
    const w = world(); const db = openDb(':memory:')
    // 让 ~/.claude.json 路径是一个目录:existsSync 为真但 readFileSync(dir) 抛 EISDIR,
    // 使 ensureProjectEntry 在源主文件与源 sidecar 已搬入回收区之后才抛错(step 6 失败窗口)
    const claudeJsonDir = join(w.home, '.claude.json'); mkdirSync(claudeJsonDir, { recursive: true })

    const res = await executeMove(['s1'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: claudeJsonDir, db })
    expect(res[0].status).toBe('failed')

    // 源会话必须完整还原:主文件 + 全部 sidecar 内容(含 subagent jsonl + meta + verbatim)
    expect(existsSync(w.jsonl)).toBe(true)
    expect(existsSync(join(w.sidecar, 'subagents', 'agent-x.jsonl'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'subagents', 'agent-x.meta.json'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'tool-results', 'r.txt'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'hooks', 'h.txt'))).toBe(true)
    expect(existsSync(join(w.sidecar, 'stray.bin'))).toBe(true)

    // 目标 sidecar 不留半成品
    expect(existsSync(join(w.projects, encodePath(w.dst), 's1'))).toBe(false)

    // 回收区本次 move 已清空:不得有遗留的 subagent jsonl/meta 被孤立在回收区
    const trashDir = join(w.trash, String(res[0].moveId))
    expect(existsSync(join(trashDir, 's1'))).toBe(false)
    expect(existsSync(join(trashDir, 's1.jsonl'))).toBe(false)

    const m = db.getMoves().find((x) => x.id === res[0].moveId)
    expect(m.status).toBe('failed')
  })
})

describe('previewMove 容错非目录目标 (BUG 2)', () => {
  it('目标编码文件夹路径被普通文件占用时不抛错,返回结果且源不动', async () => {
    const w = world(); const db = openDb(':memory:')
    // 在 projects/<encodePath(dst)> 处放一个文件(而非目录)
    const targetFolderPath = join(w.projects, encodePath(w.dst))
    writeFileSync(targetFolderPath, 'i-am-a-file-not-a-dir')

    const res = await executeMove(['s1'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: join(w.home, '.claude.json'), db })
    // 不抛错、整批返回一个结果
    expect(res).toHaveLength(1)
    expect(['skipped', 'failed']).toContain(res[0].status)
    // 源文件未动
    expect(existsSync(w.jsonl)).toBe(true)
    expect(existsSync(join(w.sidecar, 'tool-results', 'r.txt'))).toBe(true)
  })
})
