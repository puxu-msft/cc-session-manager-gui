import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, lstatSync, readlinkSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

export interface ManifestEntry {
  rel: string
  type: 'file' | 'dir' | 'symlink'
  size: number            // file: 字节数;symlink/dir: 0
  sha256: string          // file: 内容哈希;symlink: 目标字符串哈希;dir: ''
  linkTarget?: string     // 仅 symlink
}
export interface Manifest { entries: ManifestEntry[] }

export function sha256Buf(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex') }

// 流式算文件 sha256,绝不一次性把大文件读进内存(主 jsonl 可达 100MB+,对齐 mover/scanner 的流式纪律)
export async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(abs), h)
  return h.digest('hex')
}

// 遍历 cwd 下的若干顶层相对路径(文件或目录),用 lstat 不跟随 symlink,产出逐条目清单
export async function buildManifest(cwd: string, roots: string[]): Promise<Manifest> {
  const entries: ManifestEntry[] = []
  const walk = async (rel: string) => {
    const abs = join(cwd, rel)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs)
      entries.push({ rel, type: 'symlink', size: 0, sha256: sha256Buf(Buffer.from(target)), linkTarget: target })
    } else if (st.isDirectory()) {
      entries.push({ rel, type: 'dir', size: 0, sha256: '' })
      for (const e of readdirSync(abs).sort()) await walk(join(rel, e))
    } else {
      entries.push({ rel, type: 'file', size: st.size, sha256: await sha256File(abs) })
    }
  }
  for (const r of roots) await walk(r)
  return { entries }
}

// 流式 tar + gzip。symlink **不入 tar**——node-tar extract 默认丢弃指向外部/绝对路径的 symlink(防 tar-slip),
// 故用 filter 排除 symlink,改由 manifest 记录 + 解包后 rebuildSymlinks 手动重建,确保任意 symlink 字节级保真。
// portable 去除 owner/mtime 噪声(只改 tar header,不改文件内容字节,故内容 sha256 恒等)。
export async function packTree(cwd: string, roots: string[], outTarGz: string): Promise<void> {
  await tar.create({ gzip: true, file: outTarGz, cwd, portable: true, follow: false, filter: (_p, st) => !st.isSymbolicLink() }, roots)
}

export async function unpackTarGz(tarGz: string, destDir: string): Promise<void> {
  await tar.extract({ file: tarGz, cwd: destDir })
}

// 解包后依 manifest 重建所有 symlink 条目(它们不在 tar 里)。先清占位再 symlink,确保 readlink 与 manifest 恒等。
export function rebuildSymlinks(dir: string, manifest: Manifest): void {
  for (const e of manifest.entries) {
    if (e.type !== 'symlink' || e.linkTarget == null) continue
    const abs = join(dir, e.rel)
    try { rmSync(abs, { force: true }) } catch {}
    mkdirSync(dirname(abs), { recursive: true })
    symlinkSync(e.linkTarget, abs)
  }
}

// 解包目录按 manifest 逐条目校验:file 比 size+流式 sha256;symlink 比 readlink 目标;dir 比存在性
export async function verifyAgainstManifest(dir: string, manifest: Manifest): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = []
  for (const e of manifest.entries) {
    const abs = join(dir, e.rel)
    try {
      const st = lstatSync(abs)
      if (e.type === 'symlink') {
        if (!st.isSymbolicLink() || readlinkSync(abs) !== e.linkTarget) mismatches.push(e.rel)
      } else if (e.type === 'dir') {
        if (!st.isDirectory()) mismatches.push(e.rel)
      } else {
        if (st.size !== e.size || (await sha256File(abs)) !== e.sha256) mismatches.push(e.rel)
      }
    } catch { mismatches.push(e.rel) }
  }
  return { ok: mismatches.length === 0, mismatches }
}
