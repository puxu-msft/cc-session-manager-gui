import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { archiveSession, verifyVersionRestorable } from './archiver'
import { buildManifest, packTree } from './tarPack'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'arch2-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  writeFileSync(jsonl, JSON.stringify({ type: 'user', cwd: src, message: { content: 'hi' } }) + '\n')
  mkdirSync(join(fdir, 's1'), { recursive: true }); writeFileSync(join(fdir, 's1', 'meta.json'), '{}')
  const old = new Date(Date.now() - 600_000); utimesSync(jsonl, old, old)
  return { home, projects, archiveRoot, backupsRoot, src, fdir, jsonl }
}
const envOf = (w: any, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, claudeJsonPath: join(w.home, '.claude.json'), db })

describe('archiveSession', () => {
  it('归档后:版本 complete、原件从 projects 消失、sessions 行被删', async () => {
    const w = world(); const db = openDb(':memory:')
    db.upsertSession({ sessionId: 's1', projectPathAbs: w.src, folderName: encodePath(w.src), cwd: w.src, title: 't', firstMessagePreview: '', startedAt: null, lastActivityAt: null, messageCount: 1, lineCount: 1, sizeBytes: 10, mtime: 0, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: [w.src], hasSidecar: true, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null } as any)
    const res = await archiveSession('s1', envOf(w, db))
    expect(res.status).toBe('done')
    expect(db.getArchiveVersion(res.versionId!).kind).toBe('archive')
    expect(existsSync(w.jsonl)).toBe(false)
    expect(existsSync(join(w.fdir, 's1'))).toBe(false)
    expect(db.getSessions(w.src)).toHaveLength(0)
  })
})

// 删原件前"真正可还原"闸门(final review 加固)的直接单测:用 tarPack 造版本目录,
// 好包断言 ok=true;manifest 与 tar 内容不符的坏包断言 ok=false(原件应被保留)。
describe('verifyVersionRestorable', () => {
  // 造一个版本目录 <archiveRoot>/<sid>/<vid>/{content.tar.gz, manifest.json}
  function makeVersionDir(tamper: boolean) {
    const home = mkdtempSync(join(tmpdir(), 'verify-'))
    const archiveRoot = join(home, 'archive')
    const sessionId = 's1', versionId = 7
    const vdir = join(archiveRoot, sessionId, String(versionId))
    mkdirSync(vdir, { recursive: true })
    // 源树
    const src = join(home, 'src'); mkdirSync(join(src, sessionId), { recursive: true })
    writeFileSync(join(src, `${sessionId}.jsonl`), 'good line\n\x00broken\x00\nlast\n')
    writeFileSync(join(src, sessionId, 'meta.json'), '{"a":1}')
    return { archiveRoot, sessionId, versionId, vdir, src, tamper }
  }

  it('好包:解包+逐条目校验通过 → ok=true', async () => {
    const c = makeVersionDir(false)
    const roots = [`${c.sessionId}.jsonl`, c.sessionId]
    const manifest = await buildManifest(c.src, roots)
    await packTree(c.src, roots, join(c.vdir, 'content.tar.gz'))
    writeFileSync(join(c.vdir, 'manifest.json'), JSON.stringify(manifest))
    const res = await verifyVersionRestorable(c.archiveRoot, c.sessionId, c.versionId)
    expect(res).toEqual({ ok: true, mismatches: [] })
    // .verify-* 临时目录用后清掉
    expect(existsSync(join(c.archiveRoot, c.sessionId, `.verify-${c.versionId}`))).toBe(false)
  })

  it('坏包:manifest 与 tar 内容不符(篡改 sha256) → ok=false', async () => {
    const c = makeVersionDir(true)
    const roots = [`${c.sessionId}.jsonl`, c.sessionId]
    const manifest = await buildManifest(c.src, roots)
    await packTree(c.src, roots, join(c.vdir, 'content.tar.gz'))
    // 篡改主 jsonl 条目的 sha256,使解包内容与 manifest 不符
    const bad = {
      entries: manifest.entries.map((e) =>
        e.rel === `${c.sessionId}.jsonl` ? { ...e, sha256: 'deadbeef' } : e,
      ),
    }
    writeFileSync(join(c.vdir, 'manifest.json'), JSON.stringify(bad))
    const res = await verifyVersionRestorable(c.archiveRoot, c.sessionId, c.versionId)
    expect(res.ok).toBe(false)
    expect(res.mismatches).toContain(`${c.sessionId}.jsonl`)
  })

  it('包缺失:content.tar.gz 不存在 → ok=false', async () => {
    const c = makeVersionDir(false)
    writeFileSync(join(c.vdir, 'manifest.json'), JSON.stringify({ entries: [] }))
    const res = await verifyVersionRestorable(c.archiveRoot, c.sessionId, c.versionId)
    expect(res.ok).toBe(false)
  })

  it('manifest.json 损坏(非法 JSON)→ ok=false 且不抛异常', async () => {
    const c = makeVersionDir(false)
    const roots = [`${c.sessionId}.jsonl`, c.sessionId]
    await packTree(c.src, roots, join(c.vdir, 'content.tar.gz'))
    writeFileSync(join(c.vdir, 'manifest.json'), '{ not valid json')
    const res = await verifyVersionRestorable(c.archiveRoot, c.sessionId, c.versionId)
    expect(res.ok).toBe(false)
  })
})
