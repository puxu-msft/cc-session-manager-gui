import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, packTree, unpackTarGz, rebuildSymlinks, verifyAgainstManifest } from './tarPack'

function srcTree() {
  const d = mkdtempSync(join(tmpdir(), 'tarsrc-'))
  // 含 NUL 的损坏行,字节级保真目标
  writeFileSync(join(d, 's1.jsonl'), 'good line\n\x00broken\x00\nlast\n')
  mkdirSync(join(d, 's1', 'tool-results'), { recursive: true })
  writeFileSync(join(d, 's1', 'tool-results', 'big.txt'), 'X'.repeat(5000))
  writeFileSync(join(d, 's1', 'meta.json'), '{"a":1}')
  symlinkSync('/some/external/target', join(d, 's1', 'linky'))
  return d
}

describe('tarPack', () => {
  it('manifest 记录 file 的 sha256、symlink 的目标、不解引用', async () => {
    const d = srcTree()
    const m = await buildManifest(d, ['s1.jsonl', 's1'])
    const link = m.entries.find((e) => e.rel === 's1/linky')!
    expect(link.type).toBe('symlink')
    expect(link.linkTarget).toBe('/some/external/target')
    const jsonl = m.entries.find((e) => e.rel === 's1.jsonl')!
    expect(jsonl.type).toBe('file')
    expect(jsonl.size).toBe(readFileSync(join(d, 's1.jsonl')).length)
  })

  it('打包→解包后字节恒等(含损坏行)且 symlink 仍是 symlink', async () => {
    const d = srcTree()
    const out = mkdtempSync(join(tmpdir(), 'tarout-'))
    const tgz = join(out, 'content.tar.gz')
    const manifest = await buildManifest(d, ['s1.jsonl', 's1'])
    await packTree(d, ['s1.jsonl', 's1'], tgz)
    const dest = join(out, 'unpacked'); mkdirSync(dest)
    await unpackTarGz(tgz, dest)
    rebuildSymlinks(dest, manifest)
    expect(readFileSync(join(dest, 's1.jsonl'))).toEqual(readFileSync(join(d, 's1.jsonl')))
    expect(lstatSync(join(dest, 's1', 'linky')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dest, 's1', 'linky'))).toBe('/some/external/target')
    expect(await verifyAgainstManifest(dest, manifest)).toEqual({ ok: true, mismatches: [] })
  })

  it('校验失败时报告不匹配条目', async () => {
    const d = srcTree()
    const out = mkdtempSync(join(tmpdir(), 'tarout2-'))
    const tgz = join(out, 'content.tar.gz')
    const manifest = await buildManifest(d, ['s1.jsonl', 's1'])
    await packTree(d, ['s1.jsonl', 's1'], tgz)
    const dest = join(out, 'unpacked'); mkdirSync(dest)
    await unpackTarGz(tgz, dest)
    rebuildSymlinks(dest, manifest)
    writeFileSync(join(dest, 's1.jsonl'), 'tampered')
    const res = await verifyAgainstManifest(dest, manifest)
    expect(res.ok).toBe(false)
    expect(res.mismatches).toContain('s1.jsonl')
  })
})
