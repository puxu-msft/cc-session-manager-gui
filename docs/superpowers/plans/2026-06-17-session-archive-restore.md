# 会话归档 / 还原 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cc-session-manager-gui(原 cc-move-session)上增加会话「快照 / 归档 / 还原」能力——把会话整棵子树字节级打包进独立归档库,支持多版本时间线与任意版本原位还原。

**Architecture:** 独立的第四类存储,完全不复用回收区或 mover。归档库 `.cc-move-archive/<sessionId>/<versionId>/` 存 `content.tar.gz` + `manifest.json`(逐文件 sha256);还原前把现状整体搬入 `.cc-move-backups/<restoreId>-<sessionId>/`。所有破坏性步骤走「staging → 校验 → 原子提交 → pending+reconcile」纪律,崩溃 reconcile 接入启动与切源。

**Tech Stack:** Electron + better-sqlite3(主进程)+ React(渲染);`tar`(node-tar)做流式打包;`node:crypto` 算 sha256;vitest 跑 Electron ABI 运行时。

**Spec:** [docs/superpowers/specs/2026-06-17-session-archive-restore-design.md](../specs/2026-06-17-session-archive-restore-design.md)

**测试命令惯例:** 跑单文件 `npm test -- <相对路径>`;跑全部 `npm test`。

---

## 文件结构

**新建:**
- `src/main/core/fsMove.ts` — `safeRename(from,to)`:`rename` 失败(EXDEV 跨挂载点)退化为递归 copy+delete。archiver 所有搬移走它。
- `src/main/core/tarPack.ts` — `sha256File` / `buildManifest` / `packTree` / `unpackTarGz` / `verifyAgainstManifest`。纯逻辑。
- `src/main/core/archiver.ts` — `snapshotSession` / `archiveSession` / `restoreVersion` / `undoRestore` / `deleteVersion` / `listVersions` / `archiveUsage` / `archiverReconcile`。核心。
- `src/main/core/fsMove.test.ts`、`tarPack.test.ts`、`archiver.snapshot.test.ts`、`archiver.archive.test.ts`、`archiver.restore.test.ts`、`archiver.reconcile.test.ts`
- `src/renderer/components/ArchiveTimelineView.tsx` — 独立「归档时间线」modal。

**修改:**
- `src/main/sources.ts`、`src/main/appState.ts`(派生链)
- `src/main/db/schema.ts`、`src/main/db/db.ts`(两表 + 读写方法)
- `src/main/ipc.ts`、`src/preload/index.ts`、`src/shared/types.ts`(IPC 接线 + 启动 reconcile)
- `src/renderer/components/MoveBar.tsx`、`src/renderer/App.tsx`、`src/renderer/state.ts`(按钮 + 视图)
- `package.json`(tar 依赖)

---

## Task 1: 引入 tar 依赖 + 派生链 + schema 两表

**Files:**
- Modify: `package.json`
- Modify: `src/main/sources.ts:7-15`(Source 接口)、`src/main/sources.ts:29-39`(sourceFromClaudeHome)
- Modify: `src/main/appState.ts:58`(Env 接口)、`src/main/appState.ts:61-64`(getEnv)
- Modify: `src/main/db/schema.ts`

- [ ] **Step 1: 安装 tar 与类型**

Run:
```bash
npm install tar@^7
```
Expected: `package.json` 的 dependencies 出现 `tar`(v7+),无安装错误。**勿装 `@types/tar`**——它对应 tar v6,与 v7 自带的类型声明冲突。

- [ ] **Step 2: Source 接口加两根**

修改 `src/main/sources.ts` 的 `Source` 接口,在 `historyJsonlPath` 后加两行:

```typescript
export interface Source {
  id: string
  label: string
  projectsRoot: string
  claudeJsonPath: string
  trashRoot: string
  historyJsonlPath: string
  archiveRoot: string
  backupsRoot: string
  exists: boolean
}
```

在 `sourceFromClaudeHome` 的返回对象里(`exists` 之前)加两行派生:

```typescript
    historyJsonlPath: join(claudeHome, '.claude', 'history.jsonl'),
    archiveRoot: join(claudeHome, '.claude', '.cc-move-archive'),
    backupsRoot: join(claudeHome, '.claude', '.cc-move-backups'),
    exists: existsSync(join(claudeHome, '.claude', 'projects')),
```

- [ ] **Step 3: Env 接口与 getEnv 透传两根**

修改 `src/main/appState.ts`。`Env` 接口改为:

```typescript
export interface Env { db: Db; projectsRoot: string; claudeJsonPath: string; trashRoot: string; historyJsonlPath: string; archiveRoot: string; backupsRoot: string }
```

`getEnv()` 返回对象加两字段:

```typescript
export function getEnv(): Env {
  const s = activeSource()
  return { db: dbFor(s.id), projectsRoot: s.projectsRoot, claudeJsonPath: s.claudeJsonPath, trashRoot: s.trashRoot, historyJsonlPath: s.historyJsonlPath, archiveRoot: s.archiveRoot, backupsRoot: s.backupsRoot }
}
```

- [ ] **Step 4: schema 加两表并 bump 版本**

修改 `src/main/db/schema.ts`:`SCHEMA_VERSION` 从 `1` 改为 `2`;在 `SCHEMA_SQL` 模板字符串末尾(`history_rewrite_sessions` 行之后)追加:

```sql
CREATE TABLE IF NOT EXISTS archive_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT, status TEXT,
  project_path_abs TEXT, source_folder TEXT, source_cwd TEXT, title TEXT,
  jsonl_size_bytes INTEGER, sidecar_bytes INTEGER, gz_total_bytes INTEGER,
  has_sidecar INTEGER, subagent_count INTEGER, line_count INTEGER, archived_at TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_archive_session ON archive_versions(session_id);
CREATE TABLE IF NOT EXISTS restores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER, session_id TEXT, source_cwd TEXT,
  target_dir_abs TEXT, target_folder TEXT, backup_path TEXT, phase TEXT, status TEXT, restored_at TEXT);
```

> 注:`openDb`(db.ts:14)每次启动都 `db.exec(SCHEMA_SQL)`,`CREATE TABLE IF NOT EXISTS` 对既有库幂等,无需手写迁移脚本。

并在 `src/main/db/db.ts` 的 `openDb` 里让既有库也回写版本号(现有逻辑只在 meta 空时 INSERT,既有库会停在旧版本)。把:

```typescript
  if (!ver) db.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(SCHEMA_VERSION)
```

改为:

```typescript
  if (!ver) db.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(SCHEMA_VERSION)
  else if (ver.schema_version !== SCHEMA_VERSION) db.prepare('UPDATE meta SET schema_version=?').run(SCHEMA_VERSION)
```

- [ ] **Step 5: 验证类型与既有测试不破**

Run: `npm test`
Expected: 全部既有测试通过(派生链字段是新增,不影响现有逻辑)。若有 TS 报错(如某处构造 Source/Env 字面量缺字段),补齐字段。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/sources.ts src/main/appState.ts src/main/db/schema.ts
git commit -m "feat: 归档派生链(Source/Env 加 archiveRoot/backupsRoot)+ schema 两表 + tar 依赖"
```

---

## Task 2: db 层 archive_versions / restores 读写方法

**Files:**
- Modify: `src/main/db/db.ts`(在 `transaction` 方法之前插入新方法)
- Test: `src/main/db/db.test.ts`(已存在,追加用例)

- [ ] **Step 1: 写失败测试**

在 `src/main/db/db.test.ts` 末尾追加以下两个 `describe` 块(复用文件已有的 `openDb` 与 vitest import,**勿重复 import**):

```typescript
describe('archive_versions / restores', () => {
  it('插入 pending 版本→置 complete→按会话列出→取单条', () => {
    const db = openDb(':memory:')
    const vid = db.insertArchiveVersion({
      sessionId: 's1', kind: 'snapshot', projectPathAbs: '/work/proj', sourceFolder: '-work-proj',
      sourceCwd: '/work/proj', title: 'hello', jsonlSizeBytes: 10, sidecarBytes: 0, gzTotalBytes: 5,
      hasSidecar: false, subagentCount: 0, lineCount: 2,
    })
    expect(vid).toBeGreaterThan(0)
    expect(db.getArchiveVersions('s1')[0].status).toBe('pending')
    db.setArchiveVersionStatus(vid, 'complete')
    expect(db.getArchiveVersion(vid).status).toBe('complete')
    expect(db.getArchiveVersion(vid).sessionId).toBe('s1')
    db.setArchiveVersionGzBytes(vid, 4096)
    expect(db.getArchiveVersion(vid).gzTotalBytes).toBe(4096)
    expect(db.getPendingArchiveVersions()).toHaveLength(0)
    db.deleteArchiveVersion(vid)
    expect(db.getArchiveVersions('s1')).toHaveLength(0)
  })

  it('还原记录:插入→回填 backupPath→推进 phase→置 done→列 pending', () => {
    const db = openDb(':memory:')
    const rid = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: '/work/proj', targetDirAbs: '/work/proj', targetFolder: '-work-proj' })
    db.setRestoreBackupPath(rid, `/b/${rid}-s1`)
    expect(db.getRestore(rid).backupPath).toBe(`/b/${rid}-s1`)
    expect(db.getPendingRestores()).toHaveLength(1)
    db.setRestorePhase(rid, 'backup_done')
    expect(db.getRestore(rid).phase).toBe('backup_done')
    db.setRestoreStatus(rid, 'done')
    expect(db.getPendingRestores()).toHaveLength(0)
    expect(db.getRestore(rid).status).toBe('done')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/db/db.test.ts`
Expected: FAIL —「db.insertArchiveVersion is not a function」。

- [ ] **Step 3: 实现 db 方法**

在 `src/main/db/db.ts` 的 `transaction<T>` 方法之前插入(沿用现有 snake_case 回填风格):

```typescript
    insertArchiveVersion(v: {
      sessionId: string; kind: 'snapshot' | 'archive'; projectPathAbs: string; sourceFolder: string
      sourceCwd: string; title: string; jsonlSizeBytes: number; sidecarBytes: number; gzTotalBytes: number
      hasSidecar: boolean; subagentCount: number; lineCount: number
    }): number {
      const r = db.prepare(`INSERT INTO archive_versions (session_id,kind,status,project_path_abs,source_folder,source_cwd,title,jsonl_size_bytes,sidecar_bytes,gz_total_bytes,has_sidecar,subagent_count,line_count,archived_at,note)
        VALUES (@sessionId,@kind,'pending',@projectPathAbs,@sourceFolder,@sourceCwd,@title,@jsonlSizeBytes,@sidecarBytes,@gzTotalBytes,@hasSidecar,@subagentCount,@lineCount,@now,'')`)
        .run({ ...v, hasSidecar: v.hasSidecar ? 1 : 0, now: now() })
      return Number(r.lastInsertRowid)
    },
    setArchiveVersionStatus(versionId: number, status: 'pending' | 'complete') {
      db.prepare('UPDATE archive_versions SET status=? WHERE version_id=?').run(status, versionId)
    },
    setArchiveVersionGzBytes(versionId: number, gzTotalBytes: number) {
      db.prepare('UPDATE archive_versions SET gz_total_bytes=? WHERE version_id=?').run(gzTotalBytes, versionId)
    },
    deleteArchiveVersion(versionId: number) { db.prepare('DELETE FROM archive_versions WHERE version_id=?').run(versionId) },
    getArchiveVersion(versionId: number): any {
      const r = db.prepare('SELECT * FROM archive_versions WHERE version_id=?').get(versionId) as any
      return r ? mapVersion(r) : null
    },
    getArchiveVersions(sessionId: string): any[] {
      return (db.prepare('SELECT * FROM archive_versions WHERE session_id=? ORDER BY version_id DESC').all(sessionId) as any[]).map(mapVersion)
    },
    getAllArchiveVersions(): any[] {
      return (db.prepare("SELECT * FROM archive_versions WHERE status='complete' ORDER BY version_id DESC").all() as any[]).map(mapVersion)
    },
    getPendingArchiveVersions(): any[] {
      return (db.prepare("SELECT * FROM archive_versions WHERE status='pending'").all() as any[]).map(mapVersion)
    },
    insertRestore(r: { versionId: number; sessionId: string; sourceCwd: string; targetDirAbs: string; targetFolder: string }): number {
      const row = db.prepare(`INSERT INTO restores (version_id,session_id,source_cwd,target_dir_abs,target_folder,backup_path,phase,status,restored_at)
        VALUES (@versionId,@sessionId,@sourceCwd,@targetDirAbs,@targetFolder,'',NULL,'pending',@now)`).run({ ...r, now: now() })
      return Number(row.lastInsertRowid)
    },
    setRestoreBackupPath(id: number, backupPath: string) {
      db.prepare('UPDATE restores SET backup_path=? WHERE id=?').run(backupPath, id)
    },
    setRestorePhase(id: number, phase: 'staging_done' | 'backup_done' | 'commit_done') {
      db.prepare('UPDATE restores SET phase=? WHERE id=?').run(phase, id)
    },
    setRestoreStatus(id: number, status: 'pending' | 'done' | 'failed' | 'undone') {
      db.prepare('UPDATE restores SET status=? WHERE id=?').run(status, id)
    },
    getRestore(id: number): any {
      const r = db.prepare('SELECT * FROM restores WHERE id=?').get(id) as any
      return r ? mapRestore(r) : null
    },
    getPendingRestores(): any[] {
      return (db.prepare("SELECT * FROM restores WHERE status='pending'").all() as any[]).map(mapRestore)
    },
```

并在 `openDb` 函数体顶部(`const now = ...` 之后)加两个映射辅助:

```typescript
  const mapVersion = (r: any) => ({ ...r, versionId: r.version_id, sessionId: r.session_id, projectPathAbs: r.project_path_abs, sourceFolder: r.source_folder, sourceCwd: r.source_cwd, jsonlSizeBytes: r.jsonl_size_bytes, sidecarBytes: r.sidecar_bytes, gzTotalBytes: r.gz_total_bytes, hasSidecar: !!r.has_sidecar, subagentCount: r.subagent_count, lineCount: r.line_count, archivedAt: r.archived_at })
  const mapRestore = (r: any) => ({ ...r, versionId: r.version_id, sessionId: r.session_id, sourceCwd: r.source_cwd, targetDirAbs: r.target_dir_abs, targetFolder: r.target_folder, backupPath: r.backup_path, restoredAt: r.restored_at })
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/db/db.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/db/db.ts src/main/db/db.test.ts
git commit -m "feat: db archive_versions/restores 读写方法"
```

---

## Task 3: fsMove.safeRename(跨文件系统退化)

**Files:**
- Create: `src/main/core/fsMove.ts`
- Test: `src/main/core/fsMove.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/fsMove.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRename } from './fsMove'

function tmp() { return mkdtempSync(join(tmpdir(), 'fsmove-')) }

describe('safeRename', () => {
  it('同 fs 下移动文件,内容保留、源消失', () => {
    const d = tmp()
    const from = join(d, 'a.txt'); writeFileSync(from, 'hello')
    const to = join(d, 'sub', 'b.txt')
    safeRename(from, to)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf8')).toBe('hello')
  })

  it('移动目录树,保留 symlink 不解引用', () => {
    const d = tmp()
    const from = join(d, 'tree'); mkdirSync(join(from, 'inner'), { recursive: true })
    writeFileSync(join(from, 'inner', 'f.txt'), 'x')
    symlinkSync('/nonexistent/target', join(from, 'link'))
    const to = join(d, 'moved')
    safeRename(from, to)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'inner', 'f.txt'), 'utf8')).toBe('x')
    expect(lstatSync(join(to, 'link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(to, 'link'))).toBe('/nonexistent/target')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/fsMove.test.ts`
Expected: FAIL —「safeRename is not a function」。

- [ ] **Step 3: 实现**

`src/main/core/fsMove.ts`:

```typescript
import { renameSync, mkdirSync, rmSync, readdirSync, lstatSync, copyFileSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'

// 递归复制(保留 symlink 不解引用),供跨文件系统退化使用
function copyRecursive(from: string, to: string): void {
  const st = lstatSync(from)
  if (st.isSymbolicLink()) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(readlinkSync(from), to); return }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const e of readdirSync(from)) copyRecursive(join(from, e), join(to, e))
    return
  }
  mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to)
}

// rename 优先;跨挂载点(EXDEV)退化为递归 copy + 删源,保留 symlink。to 的父目录自动创建。
export function safeRename(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try { renameSync(from, to); return } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
    copyRecursive(from, to)
    rmSync(from, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/fsMove.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/core/fsMove.ts src/main/core/fsMove.test.ts
git commit -m "feat: safeRename 跨文件系统退化(保留 symlink)"
```

---

## Task 4: tarPack(manifest 生成 / 打包 / 解包 / 校验)

**Files:**
- Create: `src/main/core/tarPack.ts`
- Test: `src/main/core/tarPack.test.ts`

- [ ] **Step 1: 写失败测试(含损坏行/symlink/字节恒等)**

`src/main/core/tarPack.ts` 测试要覆盖 spec §10 的关键 fixture:

```typescript
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/tarPack.test.ts`
Expected: FAIL —「buildManifest is not a function」。

- [ ] **Step 3: 实现**

`src/main/core/tarPack.ts`:

```typescript
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/tarPack.test.ts`
Expected: PASS(3 个用例)。

- [ ] **Step 5: Commit**

```bash
git add src/main/core/tarPack.ts src/main/core/tarPack.test.ts
git commit -m "feat: tarPack 打包/解包/manifest 校验(symlink 不解引用、字节恒等)"
```

---

## Task 5: archiver.snapshotSession(快照)

**Files:**
- Create: `src/main/core/archiver.ts`
- Test: `src/main/core/archiver.snapshot.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/archiver.snapshot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { snapshotSession } from './archiver'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'arch-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  const jsonl = join(fdir, 's1.jsonl')
  writeFileSync(jsonl, [
    JSON.stringify({ type: 'user', cwd: src, message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', cwd: src, message: { content: 'ok' } }),
  ].join('\n') + '\n')
  // sidecar
  mkdirSync(join(fdir, 's1', 'tool-results'), { recursive: true })
  writeFileSync(join(fdir, 's1', 'tool-results', 'r.txt'), 'big')
  const old = new Date(Date.now() - 600_000)
  utimesSync(jsonl, old, old)
  return { home, projects, archiveRoot, backupsRoot, src, fdir, jsonl }
}
const envOf = (w: ReturnType<typeof world>, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, claudeJsonPath: join(w.home, '.claude.json'), db })

describe('snapshotSession', () => {
  it('快照写出 complete 版本,原件不动', async () => {
    const w = world(); const db = openDb(':memory:')
    const res = await snapshotSession('s1', envOf(w, db))
    expect(res.status).toBe('done')
    const v = db.getArchiveVersion(res.versionId!)
    expect(v.status).toBe('complete')
    expect(v.kind).toBe('snapshot')
    expect(v.sourceCwd).toBe(w.src)
    // 原件仍在
    expect(existsSync(w.jsonl)).toBe(true)
    // 版本目录含 content.tar.gz + manifest.json
    const vdir = join(w.archiveRoot, 's1', String(res.versionId))
    expect(existsSync(join(vdir, 'content.tar.gz'))).toBe(true)
    expect(existsSync(join(vdir, 'manifest.json'))).toBe(true)
  })

  it('活跃会话(mtime 在阈值内)被拒绝', async () => {
    const w = world(); const db = openDb(':memory:')
    utimesSync(w.jsonl, new Date(), new Date())
    const res = await snapshotSession('s1', envOf(w, db))
    expect(res.status).toBe('skipped')
    expect(db.getArchiveVersions('s1')).toHaveLength(0)
  })

  it('无 cwd 的会话被拒绝归档(将无法还原)', async () => {
    const w = world(); const db = openDb(':memory:')
    writeFileSync(w.jsonl, JSON.stringify({ type: 'user', message: { content: 'no cwd here' } }) + '\n')
    const old = new Date(Date.now() - 600_000); utimesSync(w.jsonl, old, old)
    const res = await snapshotSession('s1', envOf(w, db))
    expect(res.status).toBe('skipped')
    expect(db.getArchiveVersions('s1')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/archiver.snapshot.test.ts`
Expected: FAIL —「snapshotSession is not a function」。

- [ ] **Step 3: 实现 archiver 基础 + snapshotSession**

`src/main/core/archiver.ts`(本任务先建文件 + snapshot;后续任务在同文件追加):

```typescript
import { statSync, lstatSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Db } from '../db/db'
import { LIVE_MTIME_THRESHOLD_MS } from '@shared/constants'
import { findSessionFile } from './mover'
import { scanSessionFile } from './jsonlScanner'
import { buildManifest, packTree, type Manifest } from './tarPack'
import { safeRename } from './fsMove'

export interface ArchiverEnv { projectsRoot: string; archiveRoot: string; backupsRoot: string; claudeJsonPath?: string; db: Db }
export interface ArchiveResult { sessionId: string; status: 'done' | 'skipped' | 'failed'; versionId?: number; error?: string }

// 会话子树的顶层条目恒为这两类:主 jsonl + 同名 sidecar 目录。rootsFor(打包)与 clearSessionEntries(清理)
// 必须对应同一集合——若未来顶层条目扩展,两处需同步修改。
function rootsFor(folder: string, sessionId: string): string[] {
  const roots = [`${sessionId}.jsonl`]
  if (existsSync(join(folder, sessionId))) roots.push(sessionId)
  return roots
}

// 删除目标文件夹下某会话的全部顶层条目(主 jsonl + sidecar 目录)。供 reconcile/undo 在搬回备份前清空目标,
// 避免半搬入的版本残留;与 rootsFor 对应同一条目集合。
function clearSessionEntries(folder: string, sessionId: string): void {
  try { rmSync(join(folder, `${sessionId}.jsonl`), { force: true }) } catch {}
  try { rmSync(join(folder, sessionId), { recursive: true, force: true }) } catch {}
}

// 递归字节统计:用 lstat 不跟随 symlink(归档/备份区可能含指向外部大目录的 symlink,跟随会爆量),symlink 计 0
function treeBytes(abs: string): number {
  const st = lstatSync(abs)
  if (st.isSymbolicLink()) return 0
  if (st.isDirectory()) return readdirSync(abs).reduce((a, e) => a + treeBytes(join(abs, e)), 0)
  return st.size
}

// 构建一个版本到 staging 并校验防撕裂,成功则原子换入正式版本目录并置 complete。
// kind 决定 archive 还是 snapshot;两者构建逻辑一致。
async function buildVersion(sessionId: string, kind: 'snapshot' | 'archive', env: ArchiverEnv): Promise<ArchiveResult> {
  const found = findSessionFile(env.projectsRoot, sessionId)
  if (!found) return { sessionId, status: 'skipped', error: '会话不存在' }
  const st0 = statSync(found.jsonl)
  if (Date.now() - st0.mtimeMs < LIVE_MTIME_THRESHOLD_MS) return { sessionId, status: 'skipped', error: '会话疑似活跃,请先关闭' }

  const meta = await scanSessionFile(found.jsonl)
  // 空 cwd 护栏(对齐 mover 的空 srcRoot 护栏):还原依赖原 cwd 定位写回目标,无 cwd 的版本永远还原不了,直接拒绝
  if (!meta.cwd) return { sessionId, status: 'skipped', error: '会话无 cwd,无法归档(将无法还原)' }
  const folderName = basename(found.folder)
  const sidecarDir = join(found.folder, sessionId)
  const hasSidecar = existsSync(sidecarDir)
  const sidecarBytes = hasSidecar ? treeBytes(sidecarDir) : 0

  const versionId = env.db.insertArchiveVersion({
    sessionId, kind, projectPathAbs: meta.cwd || '', sourceFolder: folderName, sourceCwd: meta.cwd || '',
    title: meta.title, jsonlSizeBytes: st0.size, sidecarBytes, gzTotalBytes: 0,
    hasSidecar, subagentCount: meta.subagentCount, lineCount: meta.lineCount,
  })

  const sessionArchiveDir = join(env.archiveRoot, sessionId)
  const staging = join(sessionArchiveDir, `.staging-${versionId}`)
  const finalDir = join(sessionArchiveDir, String(versionId))
  try {
    mkdirSync(staging, { recursive: true })
    const roots = rootsFor(found.folder, sessionId)
    const manifest = await buildManifest(found.folder, roots)
    const tgz = join(staging, 'content.tar.gz')
    await packTree(found.folder, roots, tgz)
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))

    // 防撕裂:重新 stat 主 jsonl 与 sidecar 子树,size/mtime 或 sidecar 字节变化说明快照期间被写
    const st1 = statSync(found.jsonl)
    const sidecarBytes1 = hasSidecar && existsSync(sidecarDir) ? treeBytes(sidecarDir) : 0
    if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs || sidecarBytes1 !== sidecarBytes) {
      rmSync(staging, { recursive: true, force: true }); env.db.deleteArchiveVersion(versionId)
      return { sessionId, status: 'skipped', error: '快照期间会话被写入,请稍后重试' }
    }
    const gzBytes = statSync(tgz).size
    env.db.setArchiveVersionGzBytes(versionId, gzBytes)
    renameSync(staging, finalDir)
    env.db.setArchiveVersionStatus(versionId, 'complete')
    return { sessionId, status: 'done', versionId }
  } catch (e: any) {
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.deleteArchiveVersion(versionId)
    return { sessionId, status: 'failed', error: String(e?.message ?? e) }
  }
}

export async function snapshotSession(sessionId: string, env: ArchiverEnv): Promise<ArchiveResult> {
  return buildVersion(sessionId, 'snapshot', env)
}
```

> `findSessionFile` 已在 `mover.ts:17` export;`folderName = basename(found.folder)` 即编码后的文件夹名(`encodePath(cwd)`)。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/archiver.snapshot.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/core/archiver.ts src/main/core/archiver.snapshot.test.ts
git commit -m "feat: archiver.snapshotSession(staging+manifest+防撕裂)"
```

---

## Task 6: archiver.archiveSession(归档:快照 + 移除原件)

**Files:**
- Modify: `src/main/core/archiver.ts`
- Test: `src/main/core/archiver.archive.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/archiver.archive.test.ts`(复用 Task 5 的 world/envOf,粘贴同样的两个辅助函数到本文件顶部):

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { archiveSession } from './archiver'

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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/archiver.archive.test.ts`
Expected: FAIL —「archiveSession is not a function」。

- [ ] **Step 3: 实现(在 archiver.ts 追加)**

```typescript
// 归档 = 构建 archive 版本(complete 且 gz 校验)后,删除 projects 下原件并从索引移除该会话。
// 删除原件前确认 content.tar.gz 字节数与表记录一致(不可逆操作前的完整性闸门)。
export async function archiveSession(sessionId: string, env: ArchiverEnv): Promise<ArchiveResult> {
  const found = findSessionFile(env.projectsRoot, sessionId)
  const built = await buildVersion(sessionId, 'archive', env)
  if (built.status !== 'done' || !built.versionId || !found) return built
  const v = env.db.getArchiveVersion(built.versionId)
  const tgz = join(env.archiveRoot, sessionId, String(built.versionId), 'content.tar.gz')
  if (!existsSync(tgz) || statSync(tgz).size !== v.gzTotalBytes) {
    return { sessionId, status: 'failed', versionId: built.versionId, error: '归档包完整性校验失败,原件保留' }
  }
  // 完整性通过 → 移除原件(jsonl + sidecar 目录)。删除失败则中止:保留原件、不删索引行,避免索引与磁盘漂移
  try {
    rmSync(found.jsonl, { force: true })
    const sidecar = join(found.folder, sessionId)
    if (existsSync(sidecar)) rmSync(sidecar, { recursive: true, force: true })
  } catch (e: any) {
    return { sessionId, status: 'failed', versionId: built.versionId, error: `归档版本已生成,但移除原件失败(原件保留): ${String(e?.message ?? e)}` }
  }
  env.db.deleteSession(sessionId)
  return built
}
```

> 删原件前后的重试语义:任一步在「删除原件」之前失败,原件原样未动,版本要么 pending(被 reconcile 清)要么 complete(成了一个普通 archive 版本,无害)。删原件失败 → 返回 failed、保留原件、不删 sessions 行;此时重试归档会**再建一个新 archive 版本**(原件仍在,不做版本去重,旧版本可手动删)。删原件已成功的会话重试时 `findSessionFile` 返回 null → 直接 skipped,不会重复归档。
>
> **完整性校验(对 spec §5 包级 `gz_sha256` 的有意偏离):** 真正的内容完整性由 manifest 逐条目 sha256(还原解包后逐文件校验,Task7)保证;归档删原件前的包级闸门只查 `content.tar.gz` 字节数 == `gzTotalBytes`。放弃 spec §5 的包级 `gz_sha256`——gzip 头含 mtime/OS 等非确定性字节,包级哈希不稳定且非必要。
>
> **projects 行去留(对照 spec §3.7):** 本计划全程不触碰 `.claude.json`——spec §3.7 的「保留条目」指 `.claude.json` 的 `projects[cwd]` 字典项,本计划满足。SQLite 的 `projects` 表是显示缓存,归档移走原件后交由下次 `refresh:run` 据实重算(该 project 若 `.claude.json` 仍有条目则保留,否则按既有 scanner 逻辑处理),archiver 不主动维护它。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/archiver.archive.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/core/archiver.ts src/main/core/archiver.archive.test.ts
git commit -m "feat: archiver.archiveSession(完整性闸门后移除原件 + 删索引行)"
```

---

## Task 7: archiver.restoreVersion(还原:整体替换 + 备份现状)

**Files:**
- Modify: `src/main/core/archiver.ts`
- Test: `src/main/core/archiver.restore.test.ts`

- [ ] **Step 1: 写失败测试(含整体替换 + 差集备份 + 编码碰撞预检)**

`src/main/core/archiver.restore.test.ts`:

```typescript
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
  writeFileSync(jsonl, 'v1 content\n')
  const old = new Date(Date.now() - 600_000); utimesSync(jsonl, old, old)
  return { home, projects, archiveRoot, backupsRoot, src, fdir, jsonl }
}
const envOf = (w: any, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, claudeJsonPath: join(w.home, '.claude.json'), db })

describe('restoreVersion', () => {
  it('还原旧版本:内容回到 v1,现状(v2 + 多余文件)整体进备份区', async () => {
    const w = world(); const db = openDb(':memory:')
    const snap = await snapshotSession('s1', envOf(w, db))   // 版本 = v1 内容
    // 会话演进为 v2,并新增一个版本里没有的 sidecar 文件
    writeFileSync(w.jsonl, 'v2 content longer\n')
    mkdirSync(join(w.fdir, 's1'), { recursive: true })
    writeFileSync(join(w.fdir, 's1', 'extra.txt'), 'only-in-current')
    const old = new Date(Date.now() - 600_000); utimesSync(w.jsonl, old, old)

    const res = await restoreVersion(snap.versionId!, envOf(w, db))
    expect(res.status).toBe('done')
    // 主 jsonl 回到 v1
    expect(readFileSync(w.jsonl, 'utf8')).toBe('v1 content\n')
    // 备份区含还原前现状的完整镜像:v2 主文件 + 多余 extra.txt
    const r = db.getRestore(res.restoreId!)
    expect(readFileSync(join(r.backupPath, 's1.jsonl'), 'utf8')).toBe('v2 content longer\n')
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/archiver.restore.test.ts`
Expected: FAIL —「restoreVersion is not a function」。

- [ ] **Step 3: 实现(在 archiver.ts 追加)**

以下两个 import 合并到 archiver.ts 顶部 import 区(`Manifest` 已在 Task 5 顶部 import,勿重复):

```typescript
import { unpackTarGz, rebuildSymlinks, verifyAgainstManifest } from './tarPack'
import { encodePath } from './pathCodec'

export interface RestoreResult { status: 'done' | 'skipped' | 'failed'; restoreId?: number; error?: string }

// 还原前的目标文件夹冲突 / 编码碰撞预检(对照 mover.previewMove 的三道规则:只 scan 一个代表样本,不全量扫)
async function restorePrecheck(targetFolder: string, sessionId: string, sourceCwd: string): Promise<string | null> {
  if (!existsSync(targetFolder)) return null
  if (!statSync(targetFolder).isDirectory()) return '目标文件夹路径被非目录文件占用'
  // 自身旧件:整体替换会备份它,通常放行;但若其真实 cwd 与本版本不同 → 疑似另一来源同 id,阻断(spec §6.3 第三道)
  const selfJsonl = join(targetFolder, `${sessionId}.jsonl`)
  if (existsSync(selfJsonl)) {
    const ms = await scanSessionFile(selfJsonl)
    if (ms.cwd && ms.cwd !== sourceCwd) return `目标处同 id 会话的 cwd(${ms.cwd})与版本不一致,疑似另一来源,已阻断`
  }
  // 编码碰撞:取一个非自身的代表 jsonl(对齐 mover.previewMove 只 scan 一个样本,避免对大目标全量 scan),cwd ≠ 目标则阻断
  const other = readdirSync(targetFolder).find((f) => f.endsWith('.jsonl') && f !== `${sessionId}.jsonl`)
  if (other) {
    const mo = await scanSessionFile(join(targetFolder, other))
    if (mo.cwd && mo.cwd !== sourceCwd) return `目标文件夹已被 ${mo.cwd} 占用(编码碰撞)`
  }
  return null
}

// 还原一个 complete 版本到其原 cwd 原位:staging 解包校验 → 备份现状(整体)→ 原子换入。
export async function restoreVersion(versionId: number, env: ArchiverEnv): Promise<RestoreResult> {
  const v = env.db.getArchiveVersion(versionId)
  if (!v || v.status !== 'complete') return { status: 'skipped', error: '版本不存在或未完成' }
  const sessionId = v.sessionId as string
  const sourceCwd = v.sourceCwd as string
  if (!sourceCwd) return { status: 'skipped', error: '版本缺少原 cwd,无法定位还原目标' }

  const targetFolder = join(env.projectsRoot, encodePath(sourceCwd))
  // 活跃保护:目标已有同 id 且活跃 → 拒绝
  const targetMain = join(targetFolder, `${sessionId}.jsonl`)
  if (existsSync(targetMain) && Date.now() - statSync(targetMain).mtimeMs < LIVE_MTIME_THRESHOLD_MS) {
    return { status: 'skipped', error: '目标会话疑似活跃,请先关闭' }
  }
  const block = await restorePrecheck(targetFolder, sessionId, sourceCwd)
  if (block) return { status: 'skipped', error: block }

  const vdir = join(env.archiveRoot, sessionId, String(versionId))
  const tgz = join(vdir, 'content.tar.gz')
  const manifest = JSON.parse(readFileSync(join(vdir, 'manifest.json'), 'utf8')) as Manifest
  if (!existsSync(tgz)) return { status: 'failed', error: '归档包缺失' }

  const restoreId = env.db.insertRestore({ versionId, sessionId, sourceCwd, targetDirAbs: sourceCwd, targetFolder })
  const backupPath = join(env.backupsRoot, `${restoreId}-${sessionId}`)
  // 立即回填真实 backupPath(用主键命名,杜绝占位串号);此刻 phase 仍为 NULL,
  // 若此前崩溃 reconcile 走"无 phase → 删 staging 置 failed"分支,不读 backup_path,安全。
  env.db.setRestoreBackupPath(restoreId, backupPath)
  const staging = join(env.archiveRoot, sessionId, `.restore-staging-${restoreId}`)
  try {
    // 1) staging 解包 + 重建 symlink + 校验
    mkdirSync(staging, { recursive: true })
    await unpackTarGz(tgz, staging)
    rebuildSymlinks(staging, manifest)   // symlink 不在 tar 里,依 manifest 手动重建
    const vr = await verifyAgainstManifest(staging, manifest)
    if (!vr.ok) { rmSync(staging, { recursive: true, force: true }); env.db.setRestoreStatus(restoreId, 'failed'); return { status: 'failed', restoreId, error: `校验失败: ${vr.mismatches.join(',')}` } }
    env.db.setRestorePhase(restoreId, 'staging_done')

    // 2) 备份现状(目标里所有现存条目整体搬入 backupPath;归档移走过则为空)
    mkdirSync(backupPath, { recursive: true })
    if (existsSync(targetMain)) safeRename(targetMain, join(backupPath, `${sessionId}.jsonl`))
    const targetSidecar = join(targetFolder, sessionId)
    if (existsSync(targetSidecar)) safeRename(targetSidecar, join(backupPath, sessionId))
    env.db.setRestorePhase(restoreId, 'backup_done')

    // 3) 换入:staging 内每个顶层条目搬到目标
    mkdirSync(targetFolder, { recursive: true })
    for (const e of readdirSync(staging)) safeRename(join(staging, e), join(targetFolder, e))
    rmSync(staging, { recursive: true, force: true })
    env.db.setRestorePhase(restoreId, 'commit_done')
    env.db.setRestoreStatus(restoreId, 'done')
    return { status: 'done', restoreId }
  } catch (e: any) {
    // 失败由 reconcile 兜底(按 phase),此处仅标 failed 并尽力清 staging
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.setRestoreStatus(restoreId, 'failed')
    return { status: 'failed', restoreId, error: String(e?.message ?? e) }
  }
}
```

> `encodePath` 从 `./pathCodec` 引入(与 mover 一致)。`backup_path` 经 `setRestoreBackupPath`(Task2)写入,不用 raw SQL;命名用 `restoreId` 主键,杜绝占位串号。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/archiver.restore.test.ts`
Expected: PASS(2 个用例)。

- [ ] **Step 5: Commit**

```bash
git add src/main/core/archiver.ts src/main/core/archiver.restore.test.ts
git commit -m "feat: archiver.restoreVersion(staging 校验+整体替换+差集备份+碰撞预检)"
```

---

## Task 8: undoRestore + deleteVersion + archiveUsage + listVersions

**Files:**
- Modify: `src/main/core/archiver.ts`
- Test: `src/main/core/archiver.restore.test.ts`(追加 undo 用例)

- [ ] **Step 1: 写失败测试(追加到 restore 测试文件)**

```typescript
import { undoRestore, deleteVersion, archiveUsage, listVersions } from './archiver'

describe('undoRestore / deleteVersion / usage', () => {
  it('撤销还原:目标恢复为还原前现状,无残留', async () => {
    const w = world(); const db = openDb(':memory:')
    const snap = await snapshotSession('s1', envOf(w, db))     // v1
    writeFileSync(w.jsonl, 'v2 content\n')
    mkdirSync(join(w.fdir, 's1'), { recursive: true }); writeFileSync(join(w.fdir, 's1', 'extra.txt'), 'cur')
    const old = new Date(Date.now() - 600_000); utimesSync(w.jsonl, old, old)
    const res = await restoreVersion(snap.versionId!, envOf(w, db))
    undoRestore(res.restoreId!, envOf(w, db))
    // 撤销后目标 = 还原前现状(v2 + extra.txt),v1 不再在原位
    expect(readFileSync(w.jsonl, 'utf8')).toBe('v2 content\n')
    expect(readFileSync(join(w.fdir, 's1', 'extra.txt'), 'utf8')).toBe('cur')
    expect(db.getRestore(res.restoreId!).status).toBe('undone')
  })

  it('deleteVersion 删除版本目录与表行;usage 统计占用', async () => {
    const w = world(); const db = openDb(':memory:')
    const snap = await snapshotSession('s1', envOf(w, db))
    expect(listVersions('s1', envOf(w, db))).toHaveLength(1)
    expect(archiveUsage(envOf(w, db)).total).toBeGreaterThan(0)
    deleteVersion(snap.versionId!, envOf(w, db))
    expect(listVersions('s1', envOf(w, db))).toHaveLength(0)
    expect(existsSync(join(w.archiveRoot, 's1', String(snap.versionId)))).toBe(false)
  })

  it('多版本:同会话两次快照产生两个独立 complete 版本', async () => {
    const w = world(); const db = openDb(':memory:')
    const v1 = await snapshotSession('s1', envOf(w, db))
    const v2 = await snapshotSession('s1', envOf(w, db))
    expect(v1.versionId).not.toBe(v2.versionId)
    expect(listVersions('s1', envOf(w, db))).toHaveLength(2)
    expect(existsSync(join(w.archiveRoot, 's1', String(v1.versionId)))).toBe(true)
    expect(existsSync(join(w.archiveRoot, 's1', String(v2.versionId)))).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/archiver.restore.test.ts`
Expected: FAIL —「undoRestore is not a function」。

- [ ] **Step 3: 实现(在 archiver.ts 追加)**

```typescript
// 撤销一次 done 还原:删目标当前内容 → 把 backupPath 现状整体搬回 → 置 undone
export function undoRestore(restoreId: number, env: ArchiverEnv): void {
  const r = env.db.getRestore(restoreId)
  if (!r || r.status !== 'done') throw new Error('该还原不可撤销')
  const targetFolder = r.targetFolder as string
  const sessionId = r.sessionId as string
  clearSessionEntries(targetFolder, sessionId)   // 删本次换入的内容(单点 helper,与 reconcile 一致)
  // 搬回备份(整体镜像)
  const bMain = join(r.backupPath, `${sessionId}.jsonl`)
  const bSidecar = join(r.backupPath, sessionId)
  if (existsSync(bMain)) safeRename(bMain, join(targetFolder, `${sessionId}.jsonl`))
  if (existsSync(bSidecar)) safeRename(bSidecar, join(targetFolder, sessionId))
  env.db.setRestoreStatus(restoreId, 'undone')
}

export function deleteVersion(versionId: number, env: ArchiverEnv): void {
  const v = env.db.getArchiveVersion(versionId)
  if (!v) return
  try { rmSync(join(env.archiveRoot, v.sessionId, String(versionId)), { recursive: true, force: true }) } catch {}
  env.db.deleteArchiveVersion(versionId)
}

export function listVersions(sessionId: string, env: ArchiverEnv): any[] {
  return env.db.getArchiveVersions(sessionId).filter((v: any) => v.status === 'complete')
}

// 归档库 + 备份区总占用,以及每个版本目录占用(按 versionId)
export function archiveUsage(env: ArchiverEnv): { total: number; backups: number; byVersion: Record<string, number> } {
  const byVersion: Record<string, number> = {}
  let total = 0, backups = 0
  const sizeOf = (abs: string): number => {
    if (!existsSync(abs)) return 0
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return 0          // 绝不跟随 symlink 统计外部目标
    return st.isDirectory() ? readdirSync(abs).reduce((a, e) => a + sizeOf(join(abs, e)), 0) : st.size
  }
  if (existsSync(env.archiveRoot)) for (const sid of readdirSync(env.archiveRoot)) {
    const sdir = join(env.archiveRoot, sid)
    if (!lstatSync(sdir).isDirectory()) continue
    for (const ver of readdirSync(sdir)) {
      if (ver.startsWith('.')) continue
      const s = sizeOf(join(sdir, ver)); byVersion[ver] = s; total += s
    }
  }
  if (existsSync(env.backupsRoot)) backups = sizeOf(env.backupsRoot)
  return { total, backups, byVersion }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/archiver.restore.test.ts`
Expected: PASS(全部 4 个用例)。

- [ ] **Step 5: Commit**

```bash
git add src/main/core/archiver.ts src/main/core/archiver.restore.test.ts
git commit -m "feat: archiver undoRestore/deleteVersion/listVersions/archiveUsage"
```

---

## Task 9: archiverReconcile(崩溃恢复)

**Files:**
- Modify: `src/main/core/archiver.ts`
- Test: `src/main/core/archiver.reconcile.test.ts`

- [ ] **Step 1: 写失败测试(模拟各 phase 崩溃残留)**

`src/main/core/archiver.reconcile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { encodePath } from './pathCodec'
import { archiverReconcile } from './archiver'

function base() {
  const home = mkdtempSync(join(tmpdir(), 'arch-rec-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const archiveRoot = join(home, '.claude', '.cc-move-archive'); mkdirSync(archiveRoot, { recursive: true })
  const backupsRoot = join(home, '.claude', '.cc-move-backups'); mkdirSync(backupsRoot, { recursive: true })
  const src = join(home, 'work', 'proj')
  const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
  return { home, projects, archiveRoot, backupsRoot, src, fdir }
}
const envOf = (w: any, db: any) => ({ projectsRoot: w.projects, archiveRoot: w.archiveRoot, backupsRoot: w.backupsRoot, db })

describe('archiverReconcile', () => {
  it('清理 pending 版本及其 staging 目录', () => {
    const w = base(); const db = openDb(':memory:')
    const vid = db.insertArchiveVersion({ sessionId: 's1', kind: 'snapshot', projectPathAbs: w.src, sourceFolder: encodePath(w.src), sourceCwd: w.src, title: 't', jsonlSizeBytes: 1, sidecarBytes: 0, gzTotalBytes: 0, hasSidecar: false, subagentCount: 0, lineCount: 1 })
    const staging = join(w.archiveRoot, 's1', `.staging-${vid}`); mkdirSync(staging, { recursive: true })
    archiverReconcile(envOf(w, db))
    expect(db.getPendingArchiveVersions()).toHaveLength(0)
    expect(existsSync(staging)).toBe(false)
  })

  it('pending restore 处于 backup_done:清除半搬入残留 + 把备份搬回原位、置 failed', () => {
    const w = base(); const db = openDb(':memory:')
    const targetMain = join(w.fdir, 's1.jsonl')
    const rid = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: w.src, targetDirAbs: w.src, targetFolder: w.fdir })
    db.setRestoreBackupPath(rid, join(w.backupsRoot, `${rid}-s1`))
    db.setRestorePhase(rid, 'backup_done')
    // 备份区已存还原前现状
    mkdirSync(join(w.backupsRoot, `${rid}-s1`), { recursive: true })
    writeFileSync(join(w.backupsRoot, `${rid}-s1`, 's1.jsonl'), 'pre-restore state\n')
    // 目标位置有"半搬入"的版本残留(主文件 + 部分 sidecar),reconcile 必须先清除再搬回备份
    writeFileSync(targetMain, 'half-applied version\n')
    mkdirSync(join(w.fdir, 's1'), { recursive: true }); writeFileSync(join(w.fdir, 's1', 'leftover.txt'), 'half')
    archiverReconcile(envOf(w, db))
    expect(readFileSync(targetMain, 'utf8')).toBe('pre-restore state\n')
    expect(existsSync(join(w.fdir, 's1', 'leftover.txt'))).toBe(false)   // 半搬入残留被清除
    expect(db.getRestore(rid).status).toBe('failed')
  })

  it('pending restore 处于 commit_done:补记 done,不回滚目标内容', () => {
    const w = base(); const db = openDb(':memory:')
    const targetMain = join(w.fdir, 's1.jsonl')
    writeFileSync(targetMain, 'restored content\n')   // 已换入的还原结果
    const rid = db.insertRestore({ versionId: 1, sessionId: 's1', sourceCwd: w.src, targetDirAbs: w.src, targetFolder: w.fdir })
    db.setRestoreBackupPath(rid, join(w.backupsRoot, `${rid}-s1`))
    db.setRestorePhase(rid, 'commit_done')
    archiverReconcile(envOf(w, db))
    expect(db.getRestore(rid).status).toBe('done')
    expect(readFileSync(targetMain, 'utf8')).toBe('restored content\n')   // commit_done=已完成,不动内容
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/main/core/archiver.reconcile.test.ts`
Expected: FAIL —「archiverReconcile is not a function」。

- [ ] **Step 3: 实现(在 archiver.ts 追加)**

```typescript
// 崩溃恢复:启动 / 切源时与 mover.reconcile 并列调用。
// - pending 版本:删除其 .staging-* 与行(原件从未被动,删除原件只在 complete 后)。
// - pending restore 按 phase:无/staging_done → 删 staging 置 failed;backup_done → 把备份搬回原位置 failed;commit_done → 补记 done。
export function archiverReconcile(env: ArchiverEnv): void {
  for (const v of env.db.getPendingArchiveVersions()) {
    const staging = join(env.archiveRoot, v.sessionId, `.staging-${v.versionId}`)
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.deleteArchiveVersion(v.versionId)
  }
  for (const r of env.db.getPendingRestores()) {
    const staging = join(env.archiveRoot, r.sessionId, `.restore-staging-${r.id}`)
    if (r.phase === 'commit_done') { env.db.setRestoreStatus(r.id, 'done'); continue }
    if (r.phase === 'backup_done') {
      // 清除半搬入的版本残留(单点 clearSessionEntries,与换入条目集合对应),再把备份现状搬回目标(前滚到"还原前")
      const targetFolder = r.targetFolder as string, sessionId = r.sessionId as string
      clearSessionEntries(targetFolder, sessionId)
      const bMain = join(r.backupPath, `${sessionId}.jsonl`), bSidecar = join(r.backupPath, sessionId)
      if (existsSync(bMain)) safeRename(bMain, join(targetFolder, `${sessionId}.jsonl`))
      if (existsSync(bSidecar)) safeRename(bSidecar, join(targetFolder, sessionId))
      try { rmSync(r.backupPath, { recursive: true, force: true }) } catch {}   // 备份已搬回,清掉空壳
    }
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    env.db.setRestoreStatus(r.id, 'failed')
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- src/main/core/archiver.reconcile.test.ts`
Expected: PASS(3 个用例)。

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 全部通过(含既有 mover/scanner/db 测试)。

- [ ] **Step 6: Commit**

```bash
git add src/main/core/archiver.ts src/main/core/archiver.reconcile.test.ts
git commit -m "feat: archiverReconcile 崩溃恢复(pending 版本清理 + restore 按 phase 前滚/回滚)"
```

---

## Task 10: 共享类型 + IPC + preload 接线 + 启动/切源 reconcile

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: 加共享类型**

在 `src/shared/types.ts` 的 `declare global` 之前追加:

```typescript
export interface ArchiveVersionInfo {
  versionId: number
  sessionId: string
  kind: 'snapshot' | 'archive'
  sourceCwd: string
  title: string
  jsonlSizeBytes: number
  sidecarBytes: number
  gzTotalBytes: number
  subagentCount: number
  lineCount: number
  archivedAt: string
}
export interface ArchiveActionResult { sessionId: string; status: 'done' | 'skipped' | 'failed'; versionId?: number; error?: string }
export interface RestoreActionResult { status: 'done' | 'skipped' | 'failed'; restoreId?: number; error?: string }
export interface ArchiveUsage { total: number; backups: number; byVersion: Record<string, number> }
```

- [ ] **Step 2: 接 IPC handlers + 启动 reconcile**

读 `src/main/ipc.ts`,在其 `registerIpc` 内现有 `reconcile(getEnv())` 调用旁,加 `archiverReconcile(getEnv())`;在 `source:set` 处理器内同样补一行 `archiverReconcile(getEnv())`。在 handler 注册区追加(沿用现有 `ipcMain.handle` 风格,getEnv() 提供 ArchiverEnv 所需的 projectsRoot/archiveRoot/backupsRoot/db/claudeJsonPath):

```typescript
import { snapshotSession, archiveSession, restoreVersion, undoRestore, deleteVersion, listVersions, archiveUsage, archiverReconcile } from './core/archiver'

  ipcMain.handle('archive:snapshot', async (_e, sessionIds: string[]) => {
    const env = getEnv(); const out = []
    for (const id of sessionIds) out.push(await snapshotSession(id, env))
    return out
  })
  ipcMain.handle('archive:archive', async (_e, sessionIds: string[]) => {
    const env = getEnv(); const out = []
    for (const id of sessionIds) out.push(await archiveSession(id, env))
    return out
  })
  ipcMain.handle('archive:listVersions', (_e, sessionId: string) => listVersions(sessionId, getEnv()))
  ipcMain.handle('archive:allVersions', () => getEnv().db.getAllArchiveVersions())
  ipcMain.handle('archive:restore', (_e, versionId: number) => restoreVersion(versionId, getEnv()))
  ipcMain.handle('archive:undoRestore', (_e, restoreId: number) => { undoRestore(restoreId, getEnv()); return true })
  ipcMain.handle('archive:deleteVersion', (_e, versionId: number) => { deleteVersion(versionId, getEnv()); return true })
  ipcMain.handle('archive:usage', () => archiveUsage(getEnv()))
```

> `getEnv()` 现返回含 `archiveRoot`/`backupsRoot`/`claudeJsonPath`/`db`/`projectsRoot` 的对象,正好满足 `ArchiverEnv`。`restoreVersion` 是 async,`ipcMain.handle` 直接返回其 Promise 即可。

- [ ] **Step 3: preload 暴露 api(复用现有 .cjs bundle,只扩 api 对象)**

在 `src/preload/index.ts` 的 `api` 对象里追加方法(沿用现有 `ipcRenderer.invoke` 风格):

```typescript
  archiveSnapshot: (ids: string[]) => ipcRenderer.invoke('archive:snapshot', ids),
  archiveArchive: (ids: string[]) => ipcRenderer.invoke('archive:archive', ids),
  archiveListVersions: (sessionId: string) => ipcRenderer.invoke('archive:listVersions', sessionId),
  archiveAllVersions: () => ipcRenderer.invoke('archive:allVersions'),
  archiveRestore: (versionId: number) => ipcRenderer.invoke('archive:restore', versionId),
  archiveUndoRestore: (restoreId: number) => ipcRenderer.invoke('archive:undoRestore', restoreId),
  archiveDeleteVersion: (versionId: number) => ipcRenderer.invoke('archive:deleteVersion', versionId),
  archiveUsage: () => ipcRenderer.invoke('archive:usage'),
```

- [ ] **Step 4: 构建验证(无单测,验证 tsc + 渲染层可见)**

Run: `npm run build`
Expected: 构建成功,无 TS 错误。手动验证点(记入提交说明):`npm run dev` 后渲染层 devtools console 执行 `window.api.archiveUsage()` 返回 `{total,backups,byVersion}`(对照记忆「验证要看渲染层 console」)。

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: 归档 IPC/preload/types 接线 + 启动与切源 archiverReconcile"
```

---

## Task 11: MoveBar 快照 / 归档按钮 + 确认预览

**Files:**
- Modify: `src/renderer/components/MoveBar.tsx`
- Modify: `src/renderer/App.tsx`(传入选中会话 + 处理回调)
- Modify: `src/renderer/state.ts`(若选中会话状态在此)

- [ ] **Step 1: 读现有 MoveBar/App/state,确认选中会话来源**

Run: `sed -n '1,60p' src/renderer/components/MoveBar.tsx && sed -n '1,40p' src/renderer/state.ts`
Expected: 看清 MoveBar 现有 props(选中 sessionIds、目标、onMove)与 state 形态,以便复用同款选中集合。

- [ ] **Step 2: 加「快照」「归档」按钮 + 确认弹窗**

在 MoveBar 现有「移动」按钮旁,加两个按钮。两者都在 ≥1 选中会话时可点。归档点击弹确认(强调「会移除原件」)。沿用现有 ConfirmModal 组件(`src/renderer/components/ConfirmModal.tsx`):

```tsx
// MoveBar.tsx — 在现有按钮组里追加(selectedIds: string[] 来自现有 props)
<button disabled={selectedIds.length === 0} onClick={() => onSnapshot(selectedIds)}>
  快照 {selectedIds.length || ''}
</button>
<button disabled={selectedIds.length === 0} onClick={() => onArchive(selectedIds)}>
  归档 {selectedIds.length || ''}
</button>
```

`onSnapshot` / `onArchive` 由 App 传入。App 中实现:

```tsx
// App.tsx
const onSnapshot = async (ids: string[]) => {
  const res = await window.api.archiveSnapshot(ids)
  // 复用现有的结果提示渠道(与 onMove 的结果展示一致);失败/skipped 非阻塞呈现
  setActionResults(res)
  await refresh()   // 复用现有刷新
}
const onArchive = (ids: string[]) => {
  setConfirm({
    title: '归档会话', body: `将归档 ${ids.length} 个会话并从活动列表移除原件(可在归档时间线还原)。`,
    onConfirm: async () => {
      const res = await window.api.archiveArchive(ids)
      setActionResults(res); await refresh()
    },
  })
}
```

> `setActionResults` / `setConfirm` / `refresh` 对应现有 App 状态与函数;若命名不同,套用现有同等机制(查看 App.tsx 现有 onMove 实现照搬其结果展示与刷新调用)。

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 4: E2E 冒烟(复用现有 Playwright)**

Run: `npm run e2e`
Expected: 现有冒烟仍通过(三栏 + window.api 可用)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/MoveBar.tsx src/renderer/App.tsx src/renderer/state.ts
git commit -m "feat: MoveBar 快照/归档按钮 + 归档确认预览"
```

---

## Task 12: 归档时间线视图(独立 modal)+ 入口接线

**Files:**
- Create: `src/renderer/components/ArchiveTimelineView.tsx`
- Modify: `src/renderer/App.tsx`(入口按钮 + modal 开关)
- Modify: `src/renderer/components/MoveBar.tsx`(加「归档」入口,与「历史」「对账」并列)

- [ ] **Step 1: 写 ArchiveTimelineView 组件**

`src/renderer/components/ArchiveTimelineView.tsx`(仿现有 `HistoryView.tsx` 的 modal 结构):

```tsx
import { useEffect, useState } from 'react'
import type { ArchiveVersionInfo, ArchiveUsage } from '@shared/types'

interface Props { onClose: () => void }

export function ArchiveTimelineView({ onClose }: Props) {
  const [versions, setVersions] = useState<ArchiveVersionInfo[]>([])
  const [usage, setUsage] = useState<ArchiveUsage>({ total: 0, backups: 0, byVersion: {} })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string>('')
  const [lastRestoreId, setLastRestoreId] = useState<number | null>(null)

  const load = async () => {
    setVersions(await window.api.archiveAllVersions())
    setUsage(await window.api.archiveUsage())
  }
  useEffect(() => { load() }, [])

  const fmt = (n: number) => `${(n / 1024).toFixed(1)} KB`

  const onRestore = async (versionId: number) => {
    setBusy(true)
    const r = await window.api.archiveRestore(versionId)
    if (r.status === 'done') { setLastRestoreId(r.restoreId ?? null); setMsg('已还原(原现状已搬入备份区,可撤销)') }
    else { setMsg(`未还原:${r.error ?? r.status}`) }
    setBusy(false); await load()
  }
  const onUndo = async () => {
    if (lastRestoreId == null) return
    setBusy(true)
    try { await window.api.archiveUndoRestore(lastRestoreId); setMsg('已撤销还原(目标恢复为还原前现状)') }
    catch (e) { setMsg(`撤销失败:${String(e)}`) }
    setLastRestoreId(null); setBusy(false); await load()
  }
  const onDelete = async (versionId: number) => {
    setBusy(true); await window.api.archiveDeleteVersion(versionId); setBusy(false); await load()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>归档时间线</h2>
          <span>归档库 {fmt(usage.total)} · 备份区 {fmt(usage.backups)}</span>
          <button onClick={onClose}>关闭</button>
        </header>
        {msg && <p className="notice">{msg} {lastRestoreId != null && <button disabled={busy} onClick={onUndo}>撤销刚才的还原</button>}</p>}
        <table>
          <thead><tr><th>会话</th><th>类型</th><th>标题</th><th>体积</th><th>时间</th><th></th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.versionId}>
                <td title={v.sessionId}>{v.sessionId.slice(0, 8)}</td>
                <td>{v.kind === 'archive' ? '归档' : '快照'}</td>
                <td>{v.title}</td>
                <td>{fmt(v.gzTotalBytes)}</td>
                <td>{v.archivedAt?.slice(0, 19).replace('T', ' ')}</td>
                <td>
                  <button disabled={busy} onClick={() => onRestore(v.versionId)}>还原</button>
                  <button disabled={busy} onClick={() => onDelete(v.versionId)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {versions.length === 0 && <p>暂无归档版本。</p>}
      </div>
    </div>
  )
}
```

> CSS 类名(`modal-backdrop`/`modal`/`notice`)沿用 `styles.css` 现有 modal 样式(HistoryReconcileView 已用同款);若类名不同,套现有 modal 类。

- [ ] **Step 2: App 接入入口与开关**

在 `App.tsx` 加状态与渲染(仿现有 History/Reconcile modal 开关):

```tsx
const [showArchive, setShowArchive] = useState(false)
// ...在 MoveBar 渲染处传入 onOpenArchive={() => setShowArchive(true)}
// ...在 modal 渲染区:
{showArchive && <ArchiveTimelineView onClose={() => setShowArchive(false)} />}
```

记得 `import { ArchiveTimelineView } from './components/ArchiveTimelineView'`。

- [ ] **Step 3: MoveBar 加「归档」入口**

在 MoveBar 现有「历史」「对账」按钮旁加:

```tsx
<button onClick={onOpenArchive}>归档</button>
```

`onOpenArchive` 经 props 从 App 传入(与现有 `onOpenHistory` 等同款）。

- [ ] **Step 4: 构建 + E2E 冒烟**

Run: `npm run build && npm run e2e`
Expected: 构建成功;现有冒烟通过。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ArchiveTimelineView.tsx src/renderer/App.tsx src/renderer/components/MoveBar.tsx
git commit -m "feat: 归档时间线 modal(还原/删除版本 + 占用显示)+ MoveBar 入口"
```

---

## Task 13: 文档更新(README + 主 spec §10 状态)

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-15-cc-move-session-design.md`(§10 标注已实现)

- [ ] **Step 1: 更新 README**

把 `README.md` 的「未来方向」段(`全量历史归档与还原仍在规划中`)改为「已实现」描述,并在「文档」段加链接:

```markdown
## 归档 / 还原

除移动外,可对会话做**快照**(留原件的备份版本)或**归档**(移除原件、收进归档库),同一会话形成多版本时间线;任意版本可**还原**到原位置——还原前会把现状整体搬入 `.cc-move-backups/<restoreId>-<sessionId>/` 作为安全网,可撤销。归档库 `.cc-move-archive/` 与备份区均无限期保留、可在「归档时间线」视图查看占用并手动清理。
```

并在文档列表追加:

```markdown
- 归档/还原设计:[docs/superpowers/specs/2026-06-17-session-archive-restore-design.md](docs/superpowers/specs/2026-06-17-session-archive-restore-design.md)
- 归档/还原实现计划:[docs/superpowers/plans/2026-06-17-session-archive-restore.md](docs/superpowers/plans/2026-06-17-session-archive-restore.md)
```

- [ ] **Step 2: 同步主 spec §10 状态**

在 `docs/superpowers/specs/2026-06-15-cc-move-session-design.md` 的 §10「未来方向」标题下加一行状态标注:

```markdown
> **状态(2026-06-17 更新):** 本节描述的「全量历史归档与还原」已落地为独立设计与实现,见 [2026-06-17-session-archive-restore-design.md](2026-06-17-session-archive-restore-design.md) 与对应实现计划。下文保留为当初的可扩展性约束记录。
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-06-15-cc-move-session-design.md
git commit -m "docs: README 增补归档/还原能力;主 spec §10 标注已实现"
```

---

## 自审清单(实现者在全部任务后核对)

- [ ] **全量回归:** `npm test` 全绿;`npm run build` 与 `npm run e2e` 通过。
- [ ] **spec 覆盖:** 三操作(快照/归档/还原 Task 5/6/7)、整体替换+差集备份(Task 7,含「版本含 sidecar」用例)、tar+manifest 校验与 symlink 不解引用(Task 4)、phase 化 reconcile 接入启动/切源(Task 9/10)、per-source 派生(Task 1)、编码碰撞+第三道预检(Task 7)、`.claude.json` 不触碰(本计划全程未改 claudeJson,符合 spec §3.7)、归属快照自给自足(Task 5 插入 source_cwd/title)。
- [ ] **对抗审查修订项已落实:** backup_path 主键命名无占位(Task 7)、reconcile 经 `clearSessionEntries` 清半搬入残留(Task 9)、sha256 全程流式不 readFileSync 大文件(Task 4)、`treeBytes`/`archiveUsage` 用 lstat 不跟随 symlink(Task 5/8)、防撕裂补查 sidecar(Task 5)、删原件失败返回 failed 不删索引(Task 6)、undoRestore 有 UI 入口(Task 12)。
- [ ] **手动验证(WSL):** 在两个数据源各做一次快照,确认归档/备份目录落在各源 `.claude` 下、两源版本互不串(Task 1 派生 + per-source DB)。
- [ ] **活跃保护:** 对刚写入的会话快照/归档被拒(Task 5/6 测试已覆盖);快照期间被写触发防撕裂作废(Task 5)。
