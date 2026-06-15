# cc-move-session 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Electron + React 桌面工具,把 Claude Code 会话从一个工作目录安全移动到另一个,并维护 SQLite 索引与可恢复的回收区备份。

**Architecture:** 主进程承载全部文件系统 / SQLite / 移动逻辑,渲染进程是纯 React(`contextIsolation` + preload IPC 桥)。纯逻辑模块(pathCodec / cwdRewriter / jsonlScanner)先以 vitest TDD;再实现 db / scanner / claudeJson / fsBrowser / mover;最后 IPC 与三栏 UI。

**Tech Stack:** electron-vite、React 18、TypeScript、better-sqlite3、vitest。

**规格来源:** [docs/superpowers/specs/2026-06-15-cc-move-session-design.md](../specs/2026-06-15-cc-move-session-design.md)

---

## 关键接口契约(贯穿全计划,务必保持一致)

```ts
// src/shared/types.ts
export interface SessionMeta {
  sessionId: string
  projectPathAbs: string     // = 该会话首个 cwd(权威项目根)
  folderName: string         // ~/.claude/projects 下编码目录名
  cwd: string                // 同 projectPathAbs(冗余便于查询)
  title: string              // customTitle > aiTitle > 首条用户消息(截断)
  firstMessagePreview: string
  startedAt: string | null   // 最早消息行时间戳(ISO)
  lastActivityAt: string | null
  messageCount: number       // user+assistant 行数
  lineCount: number          // 原始行数
  sizeBytes: number
  mtime: number              // epoch ms
  gitBranch: string | null
  claudeVersion: string | null
  entrypoint: string | null
  isSidechain: boolean
  distinctCwds: string[]     // 全部出现过的顶层 cwd 去重
  hasSidecar: boolean
  subagentCount: number
  toolResultsBytes: number
}

export interface ProjectMeta {
  projectPathAbs: string
  folderName: string
  existsOnDisk: boolean
  inClaudeJson: boolean
  sessionCount: number
  totalSizeBytes: number
  lastActivityAt: string | null
}

export interface CwdChange { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }

export interface MovePreviewItem {
  sessionId: string
  title: string
  srcRoot: string
  dstRoot: string
  structuralCwdFields: number     // 将改写的结构化 cwd 字段数
  sidecarBytes: number
  toolResultsBytes: number
  trashBackupBytes: number
  blocked: null | 'live' | 'collision' | 'encode-collision' | 'self-referential'
  blockReason?: string
}

export interface MovePreview {
  items: MovePreviewItem[]
  claudeJsonWillAddEntry: boolean
  targetPathAbs: string
}

export interface MoveResult {
  sessionId: string
  status: 'done' | 'failed' | 'skipped'
  moveId?: number
  error?: string
}

export interface FsEntry { name: string; path: string; isDir: boolean; isGitRepo: boolean }
export interface FsListing { path: string; parent: string | null; entries: FsEntry[] }
```

常量:`src/shared/constants.ts`
```ts
export const LIVE_MTIME_THRESHOLD_MS = 60_000          // 活跃会话判定
export const SNAPSHOT_LINE_SIZE_CAP_BYTES = 2_000_000  // 超过则不存 snapshot_lines,仅靠回收区
export const PROJECTS_ROOT = () => require('node:path').join(require('node:os').homedir(), '.claude', 'projects')
export const CLAUDE_JSON = () => require('node:path').join(require('node:os').homedir(), '.claude.json')
export const TRASH_ROOT = () => require('node:path').join(require('node:os').homedir(), '.claude', '.cc-move-trash')
export const CLAUDE_JSON_CLONE_ALLOWLIST = ['allowedTools','mcpServers','enabledMcpjsonServers','disabledMcpjsonServers','hasTrustDialogAccepted'] as const
```

---

## Task 0:项目脚手架

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/shared/types.ts`, `src/shared/constants.ts`

- [ ] **Step 1: 初始化依赖**

Run:
```bash
cd /home/xp/src/cc-move-session
npm init -y
npm i react react-dom better-sqlite3
npm i -D electron electron-vite electron-builder vite @vitejs/plugin-react typescript @types/react @types/react-dom @types/better-sqlite3 @types/node vitest
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "jsx": "react-jsx", "resolveJsonModule": true, "noUnusedLocals": true,
    "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 `electron.vite.config.ts`**

```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { build: { rollupOptions: { external: ['better-sqlite3'] } } },
  preload: {},
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
  },
})
```

- [ ] **Step 4: 写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: { '@shared': resolve('src/shared') } },
})
```

- [ ] **Step 5: 写 `src/shared/types.ts` 与 `src/shared/constants.ts`**(内容见上方"关键接口契约")

- [ ] **Step 6: 写最小可启动骨架**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}
app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

`src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('api', {})
```

`src/renderer/index.html`:
```html
<!doctype html><html><head><meta charset="utf-8"><title>cc-move-session</title></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>
```

`src/renderer/main.tsx`:
```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<App />)
```

`src/renderer/App.tsx`:
```tsx
import React from 'react'
export function App() { return <div>cc-move-session</div> }
```

- [ ] **Step 7: 配置 scripts 并验证启动**

`package.json` 加:
```json
"scripts": {
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "test": "vitest run",
  "test:watch": "vitest"
}
```
Run: `npm run test`(应为 0 测试通过)。手动 `npm run dev` 应弹出窗口显示 "cc-move-session"。

- [ ] **Step 8: Commit**
```bash
git add -A && git commit -m "chore: electron-vite + react + ts + vitest 脚手架"
```

---

## Task 1:pathCodec(编码与前缀重定位)

**Files:**
- Create: `src/main/core/pathCodec.ts`, `src/main/core/pathCodec.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/pathCodec.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { encodePath, reRoot } from './pathCodec'

describe('encodePath', () => {
  it('把非字母数字字符替换为 -,不折叠', () => {
    expect(encodePath('/home/xp/src/wmm-quiz')).toBe('-home-xp-src-wmm-quiz')
    expect(encodePath('/home/xp/.codex')).toBe('-home-xp--codex')   // / 和 . 各产生一个 -
    expect(encodePath('/home/xp/.claude')).toBe('-home-xp--claude')
  })
})

describe('reRoot', () => {
  const src = '/home/xp/refs/openvmm', dst = '/home/data/openvmm'
  it('等于源根 → 改成目标根', () => expect(reRoot(src, src, dst)).toBe(dst))
  it('源根之下 → 前缀重定位', () =>
    expect(reRoot(src + '/crates/x', src, dst)).toBe(dst + '/crates/x'))
  it('源根之外 → 原样保留', () => {
    expect(reRoot('/tmp', src, dst)).toBe('/tmp')
    expect(reRoot('/home/xp/.cache/y', src, dst)).toBe('/home/xp/.cache/y')
  })
  it('不把前缀相似但非子目录的当作命中', () =>
    expect(reRoot('/home/xp/refs/openvmm-extra', src, dst)).toBe('/home/xp/refs/openvmm-extra'))
})
```

- [ ] **Step 2: 运行,确认失败** — `npx vitest run src/main/core/pathCodec.test.ts`,预期 FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`src/main/core/pathCodec.ts`:
```ts
export function encodePath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-')
}

export function reRoot(cwd: string, srcRoot: string, dstRoot: string): string {
  if (cwd === srcRoot) return dstRoot
  const prefix = srcRoot.endsWith('/') ? srcRoot : srcRoot + '/'
  if (cwd.startsWith(prefix)) return dstRoot.replace(/\/$/, '') + '/' + cwd.slice(prefix.length)
  return cwd
}
```

- [ ] **Step 4: 运行,确认通过** — `npx vitest run src/main/core/pathCodec.test.ts`,预期 PASS。

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: pathCodec 编码与前缀重定位"`

---

## Task 2:cwdRewriter(仅改写结构化 cwd 字段)

**Files:**
- Create: `src/main/core/cwdRewriter.ts`, `src/main/core/cwdRewriter.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/cwdRewriter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { rewriteLine } from './cwdRewriter'

const SRC = '/home/xp/src/neighbors', DST = '/home/data/neighbors'

describe('rewriteLine', () => {
  it('改写顶层 cwd', () => {
    const { line, changes } = rewriteLine(JSON.stringify({ type: 'user', cwd: SRC }), SRC, DST)
    expect(JSON.parse(line).cwd).toBe(DST)
    expect(changes).toEqual([{ field: 'cwd', oldCwd: SRC, newCwd: DST }])
  })
  it('改写嵌套 attachment.response.cwd', () => {
    const obj = { type: 'attachment', cwd: SRC, attachment: { response: { cwd: SRC } } }
    const { line } = rewriteLine(JSON.stringify(obj), SRC, DST)
    const p = JSON.parse(line)
    expect(p.cwd).toBe(DST); expect(p.attachment.response.cwd).toBe(DST)
  })
  it('正文里的源路径绝不改写', () => {
    const obj = { type: 'user', cwd: SRC, message: { content: `opened ${SRC}/a.md` } }
    const { line } = rewriteLine(JSON.stringify(obj), SRC, DST)
    expect(JSON.parse(line).message.content).toBe(`opened ${SRC}/a.md`)  // 正文不动
  })
  it('项目外的 cwd 保留(/tmp)', () => {
    const { line, changes } = rewriteLine(JSON.stringify({ type: 'user', cwd: '/tmp' }), SRC, DST)
    expect(JSON.parse(line).cwd).toBe('/tmp'); expect(changes).toEqual([])
  })
  it('无 cwd 的行原样返回', () => {
    const raw = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' })
    expect(rewriteLine(raw, SRC, DST).line).toBe(raw)
  })
  it('损坏行(无法解析)字节级透传', () => {
    const bad = '{"type":"user"\x00 broken'
    expect(rewriteLine(bad, SRC, DST).line).toBe(bad)
  })
})
```

- [ ] **Step 2: 运行,确认失败** — `npx vitest run src/main/core/cwdRewriter.test.ts`,预期 FAIL。

- [ ] **Step 3: 实现**

`src/main/core/cwdRewriter.ts`:
```ts
import { reRoot } from './pathCodec'

export interface LineChange { field: string; oldCwd: string; newCwd: string }

export function rewriteLine(line: string, srcRoot: string, dstRoot: string): { line: string; changes: LineChange[] } {
  let obj: any
  try { obj = JSON.parse(line) } catch { return { line, changes: [] } }
  if (obj === null || typeof obj !== 'object') return { line, changes: [] }
  const changes: LineChange[] = []

  const apply = (holder: any, key: string, field: string) => {
    const v = holder?.[key]
    if (typeof v !== 'string') return
    const nv = reRoot(v, srcRoot, dstRoot)
    if (nv !== v) { holder[key] = nv; changes.push({ field, oldCwd: v, newCwd: nv }) }
  }
  apply(obj, 'cwd', 'cwd')
  if (obj.attachment && obj.attachment.response) apply(obj.attachment.response, 'cwd', 'attachment.response.cwd')

  if (changes.length === 0) return { line, changes: [] }
  return { line: JSON.stringify(obj), changes }
}
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: cwdRewriter 仅改写结构化 cwd 字段"`

---

## Task 3:jsonlScanner(流式提取会话元数据)

**Files:**
- Create: `src/main/core/jsonlScanner.ts`, `src/main/core/jsonlScanner.test.ts`, `src/main/core/fixtures/` 测试夹具

- [ ] **Step 1: 写夹具与失败测试**

`src/main/core/jsonlScanner.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessionFile } from './jsonlScanner'

let dir: string, file: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-'))
  file = join(dir, 'sess1.jsonl')
  const lines = [
    { type: 'queue-operation', operation: 'enqueue' },                       // 无 cwd / 无时间戳
    { type: 'user', cwd: '/p/root', timestamp: '2026-06-15T10:00:00.000Z', gitBranch: 'main', version: '2.1.0', entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: '第一条问题内容' } },
    { type: 'assistant', cwd: '/p/root', timestamp: '2026-06-15T10:01:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', cwd: '/p/root/sub', timestamp: '2026-06-15T10:02:00.000Z', message: { content: '在子目录' } },
    { type: 'custom-title', sessionId: 's', customTitle: '我的标题' },
  ]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
})

describe('scanSessionFile', () => {
  it('提取核心元数据', async () => {
    const m = await scanSessionFile(file)
    expect(m.cwd).toBe('/p/root')              // 首个 cwd 为项目根
    expect(m.title).toBe('我的标题')            // customTitle 优先
    expect(m.firstMessagePreview).toBe('第一条问题内容')
    expect(m.startedAt).toBe('2026-06-15T10:00:00.000Z')
    expect(m.lastActivityAt).toBe('2026-06-15T10:02:00.000Z')
    expect(m.messageCount).toBe(3)             // 2 user + 1 assistant
    expect(m.lineCount).toBe(5)
    expect(m.gitBranch).toBe('main')
    expect(m.claudeVersion).toBe('2.1.0')
    expect(m.entrypoint).toBe('cli')
    expect(m.distinctCwds.sort()).toEqual(['/p/root', '/p/root/sub'])
    expect(m.hasSidecar).toBe(false)
  })
})
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现**

`src/main/core/jsonlScanner.ts`:
```ts
import { createReadStream, statSync, existsSync, readdirSync, statSync as stat2 } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta } from '@shared/types'
import { encodePath } from './pathCodec'

function previewOf(content: any): string {
  if (typeof content === 'string') return content.slice(0, 200)
  if (Array.isArray(content)) {
    const t = content.find((c) => c?.type === 'text')?.text
    if (typeof t === 'string') return t.slice(0, 200)
  }
  return ''
}

function dirSizeBytes(dir: string): number {
  let total = 0
  if (!existsSync(dir)) return 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += dirSizeBytes(p)
    else if (e.isFile()) total += stat2(p).size
  }
  return total
}

export async function scanSessionFile(jsonlPath: string): Promise<SessionMeta> {
  const st = statSync(jsonlPath)
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, '')
  const sidecarDir = join(dirname(jsonlPath), sessionId)

  let lineCount = 0, messageCount = 0
  let firstCwd: string | null = null
  const distinct = new Set<string>()
  let startedAt: string | null = null, lastActivityAt: string | null = null
  let gitBranch: string | null = null, version: string | null = null, entrypoint: string | null = null
  let isSidechain = false
  let firstUserPreview = '', aiTitle: string | null = null, customTitle: string | null = null

  const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of rl) {
    lineCount++
    let o: any
    try { o = JSON.parse(raw) } catch { continue }   // 跳过损坏行
    if (!o || typeof o !== 'object') continue
    if (typeof o.cwd === 'string') { if (!firstCwd) firstCwd = o.cwd; distinct.add(o.cwd) }
    if (typeof o.timestamp === 'string') {
      if (!startedAt) startedAt = o.timestamp
      lastActivityAt = o.timestamp
    }
    if (o.type === 'user' || o.type === 'assistant') {
      messageCount++
      if (o.type === 'user' && !firstUserPreview && o.message) firstUserPreview = previewOf(o.message.content)
    }
    if (o.gitBranch && !gitBranch) gitBranch = o.gitBranch
    if (o.version && !version) version = o.version
    if (o.entrypoint && !entrypoint) entrypoint = o.entrypoint
    if (o.isSidechain) isSidechain = true
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle
  }

  const cwd = firstCwd ?? ''
  const subagentsDir = join(sidecarDir, 'subagents')
  const toolResultsDir = join(sidecarDir, 'tool-results')
  const hasSidecar = existsSync(sidecarDir)
  const subagentCount = existsSync(subagentsDir)
    ? readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl')).length : 0

  return {
    sessionId, projectPathAbs: cwd, folderName: encodePath(cwd), cwd,
    title: customTitle ?? aiTitle ?? firstUserPreview, firstMessagePreview: firstUserPreview,
    startedAt, lastActivityAt, messageCount, lineCount, sizeBytes: st.size, mtime: st.mtimeMs,
    gitBranch, claudeVersion: version, entrypoint, isSidechain,
    distinctCwds: [...distinct], hasSidecar, subagentCount, toolResultsBytes: dirSizeBytes(toolResultsDir),
  }
}
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: jsonlScanner 流式提取会话元数据"`

---

## Task 4:db(SQLite schema 与查询)

**Files:**
- Create: `src/main/db/schema.ts`, `src/main/db/db.ts`, `src/main/db/db.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/db/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { openDb } from './db'

describe('db', () => {
  it('建表并支持 project/session upsert 与查询', () => {
    const db = openDb(':memory:')
    db.upsertProject({ projectPathAbs: '/p', folderName: '-p', existsOnDisk: true, inClaudeJson: false, sessionCount: 1, totalSizeBytes: 10, lastActivityAt: 't' })
    db.upsertSession({ sessionId: 's1', projectPathAbs: '/p', folderName: '-p', cwd: '/p', title: 'T', firstMessagePreview: 'p', startedAt: 't', lastActivityAt: 't', messageCount: 2, lineCount: 3, sizeBytes: 10, mtime: 1, gitBranch: null, claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: ['/p'], hasSidecar: false, subagentCount: 0, toolResultsBytes: 0, movedFlag: false, lastMoveId: null })
    expect(db.getProjects().length).toBe(1)
    expect(db.getSessions('/p').map((s) => s.sessionId)).toEqual(['s1'])
  })
  it('move 生命周期', () => {
    const db = openDb(':memory:')
    const id = db.insertMove({ sessionId: 's1', projectName: '/p', sourceDirAbs: '/p', sourceFolder: '-p', sourceCwd: '/p', targetDirAbs: '/q', targetFolder: '-q', trashPath: '/t', claudeJsonUpdated: false })
    db.updateMoveStatus(id, 'done')
    expect(db.getMoves()[0].status).toBe('done')
  })
})
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现 schema 与 db**

`src/main/db/schema.ts`:
```ts
export const SCHEMA_VERSION = 1
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER);
CREATE TABLE IF NOT EXISTS projects (
  project_path_abs TEXT PRIMARY KEY, folder_name TEXT, exists_on_disk INTEGER, in_claude_json INTEGER,
  session_count INTEGER, total_size_bytes INTEGER, last_activity_at TEXT,
  first_indexed_at TEXT, last_indexed_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, project_path_abs TEXT, folder_name TEXT, cwd TEXT,
  title TEXT, first_message_preview TEXT, started_at TEXT, last_activity_at TEXT,
  message_count INTEGER, line_count INTEGER, size_bytes INTEGER, mtime REAL,
  git_branch TEXT, claude_version TEXT, entrypoint TEXT, is_sidechain INTEGER,
  has_sidecar INTEGER, subagent_count INTEGER, tool_results_bytes INTEGER,
  moved_flag INTEGER, last_move_id INTEGER, first_indexed_at TEXT, last_indexed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path_abs);
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, project_name TEXT,
  source_dir_abs TEXT, source_folder TEXT, source_cwd TEXT,
  target_dir_abs TEXT, target_folder TEXT, moved_at TEXT, status TEXT,
  rewritten_field_count INTEGER, sidecar_bytes INTEGER, trash_path TEXT, claude_json_updated INTEGER);
CREATE TABLE IF NOT EXISTS cwd_changes (move_id INTEGER, file_rel TEXT, line_no INTEGER, old_cwd TEXT, new_cwd TEXT);
CREATE TABLE IF NOT EXISTS snapshot_lines (move_id INTEGER, file_rel TEXT, line_no INTEGER, content TEXT);
`
```

`src/main/db/db.ts`:
```ts
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import type { SessionMeta, ProjectMeta } from '@shared/types'

export interface SessionRow extends SessionMeta { movedFlag: boolean; lastMoveId: number | null }
export interface MoveInsert {
  sessionId: string; projectName: string; sourceDirAbs: string; sourceFolder: string; sourceCwd: string
  targetDirAbs: string; targetFolder: string; trashPath: string; claudeJsonUpdated: boolean
}

export function openDb(file: string) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  const ver = db.prepare('SELECT schema_version FROM meta LIMIT 1').get() as any
  if (!ver) db.prepare('INSERT INTO meta (schema_version) VALUES (?)').run(SCHEMA_VERSION)
  const now = () => new Date().toISOString()

  return {
    raw: db,
    upsertProject(p: ProjectMeta) {
      db.prepare(`INSERT INTO projects (project_path_abs,folder_name,exists_on_disk,in_claude_json,session_count,total_size_bytes,last_activity_at,first_indexed_at,last_indexed_at)
        VALUES (@projectPathAbs,@folderName,@existsOnDisk,@inClaudeJson,@sessionCount,@totalSizeBytes,@lastActivityAt,@now,@now)
        ON CONFLICT(project_path_abs) DO UPDATE SET folder_name=excluded.folder_name,exists_on_disk=excluded.exists_on_disk,in_claude_json=excluded.in_claude_json,session_count=excluded.session_count,total_size_bytes=excluded.total_size_bytes,last_activity_at=excluded.last_activity_at,last_indexed_at=excluded.last_indexed_at`)
        .run({ ...p, existsOnDisk: p.existsOnDisk ? 1 : 0, inClaudeJson: p.inClaudeJson ? 1 : 0, now: now() })
    },
    upsertSession(s: SessionRow) {
      db.prepare(`INSERT INTO sessions (session_id,project_path_abs,folder_name,cwd,title,first_message_preview,started_at,last_activity_at,message_count,line_count,size_bytes,mtime,git_branch,claude_version,entrypoint,is_sidechain,has_sidecar,subagent_count,tool_results_bytes,moved_flag,last_move_id,first_indexed_at,last_indexed_at)
        VALUES (@sessionId,@projectPathAbs,@folderName,@cwd,@title,@firstMessagePreview,@startedAt,@lastActivityAt,@messageCount,@lineCount,@sizeBytes,@mtime,@gitBranch,@claudeVersion,@entrypoint,@isSidechain,@hasSidecar,@subagentCount,@toolResultsBytes,@movedFlag,@lastMoveId,@now,@now)
        ON CONFLICT(session_id) DO UPDATE SET project_path_abs=excluded.project_path_abs,folder_name=excluded.folder_name,cwd=excluded.cwd,title=excluded.title,first_message_preview=excluded.first_message_preview,started_at=excluded.started_at,last_activity_at=excluded.last_activity_at,message_count=excluded.message_count,line_count=excluded.line_count,size_bytes=excluded.size_bytes,mtime=excluded.mtime,git_branch=excluded.git_branch,claude_version=excluded.claude_version,entrypoint=excluded.entrypoint,is_sidechain=excluded.is_sidechain,has_sidecar=excluded.has_sidecar,subagent_count=excluded.subagent_count,tool_results_bytes=excluded.tool_results_bytes,moved_flag=excluded.moved_flag,last_move_id=excluded.last_move_id,last_indexed_at=excluded.last_indexed_at`)
        .run({ ...s, isSidechain: s.isSidechain ? 1 : 0, hasSidecar: s.hasSidecar ? 1 : 0, movedFlag: s.movedFlag ? 1 : 0, now: now() })
    },
    deleteSession(id: string) { db.prepare('DELETE FROM sessions WHERE session_id=?').run(id) },
    getProjects(): any[] { return db.prepare('SELECT * FROM projects ORDER BY last_activity_at DESC').all() },
    getSessions(projectPathAbs: string): any[] {
      return db.prepare('SELECT * FROM sessions WHERE project_path_abs=? ORDER BY last_activity_at DESC').all(projectPathAbs)
    },
    insertMove(m: MoveInsert): number {
      const r = db.prepare(`INSERT INTO moves (session_id,project_name,source_dir_abs,source_folder,source_cwd,target_dir_abs,target_folder,moved_at,status,rewritten_field_count,sidecar_bytes,trash_path,claude_json_updated)
        VALUES (@sessionId,@projectName,@sourceDirAbs,@sourceFolder,@sourceCwd,@targetDirAbs,@targetFolder,@now,'pending',0,0,@trashPath,@claudeJsonUpdated)`)
        .run({ ...m, claudeJsonUpdated: m.claudeJsonUpdated ? 1 : 0, now: now() })
      return Number(r.lastInsertRowid)
    },
    updateMoveStatus(id: number, status: string, extra?: { rewrittenFieldCount?: number; sidecarBytes?: number; claudeJsonUpdated?: boolean }) {
      db.prepare('UPDATE moves SET status=?, rewritten_field_count=COALESCE(?,rewritten_field_count), sidecar_bytes=COALESCE(?,sidecar_bytes), claude_json_updated=COALESCE(?,claude_json_updated) WHERE id=?')
        .run(status, extra?.rewrittenFieldCount ?? null, extra?.sidecarBytes ?? null, extra?.claudeJsonUpdated == null ? null : extra.claudeJsonUpdated ? 1 : 0, id)
    },
    getMoves(): any[] { return db.prepare('SELECT * FROM moves ORDER BY id DESC').all() },
    getPendingMoves(): any[] { return db.prepare("SELECT * FROM moves WHERE status='pending'").all() },
    insertCwdChanges(moveId: number, rows: { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }[]) {
      const stmt = db.prepare('INSERT INTO cwd_changes (move_id,file_rel,line_no,old_cwd,new_cwd) VALUES (?,?,?,?,?)')
      const tx = db.transaction(() => rows.forEach((r) => stmt.run(moveId, r.fileRel, r.lineNo, r.oldCwd, r.newCwd)))
      tx()
    },
    insertSnapshotLines(moveId: number, rows: { fileRel: string; lineNo: number; content: string }[]) {
      const stmt = db.prepare('INSERT INTO snapshot_lines (move_id,file_rel,line_no,content) VALUES (?,?,?,?)')
      const tx = db.transaction(() => rows.forEach((r) => stmt.run(moveId, r.fileRel, r.lineNo, r.content)))
      tx()
    },
    transaction<T>(fn: () => T): T { return db.transaction(fn)() },
  }
}
export type Db = ReturnType<typeof openDb>
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: db SQLite schema 与查询层"`

---

## Task 5:scanner(扫描全部项目并 diff)

**Files:**
- Create: `src/main/core/scanner.ts`, `src/main/core/scanner.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/scanner.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAll } from './scanner'

function fakeProjects() {
  const root = mkdtempSync(join(tmpdir(), 'ccp-'))
  const pdir = join(root, '-p-root'); mkdirSync(pdir)
  const line = (o: any) => JSON.stringify(o)
  writeFileSync(join(pdir, 's1.jsonl'),
    [line({ type: 'user', cwd: '/p/root', timestamp: '2026-06-15T10:00:00Z', message: { content: 'hi' } })].join('\n'))
  return root
}

describe('scanAll', () => {
  it('聚合出项目与会话', async () => {
    const root = fakeProjects()
    const { projects, sessions } = await scanAll(root)
    expect(sessions.map((s) => s.sessionId)).toEqual(['s1'])
    expect(projects.map((p) => p.projectPathAbs)).toEqual(['/p/root'])
    expect(projects[0].sessionCount).toBe(1)
  })
})
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现**

`src/main/core/scanner.ts`:
```ts
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta, ProjectMeta } from '@shared/types'
import { scanSessionFile } from './jsonlScanner'

export async function scanAll(projectsRoot: string): Promise<{ projects: ProjectMeta[]; sessions: SessionMeta[] }> {
  const sessions: SessionMeta[] = []
  if (!existsSync(projectsRoot)) return { projects: [], sessions: [] }
  for (const folder of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const fdir = join(projectsRoot, folder.name)
    for (const f of readdirSync(fdir)) {
      if (!f.endsWith('.jsonl')) continue
      try { sessions.push(await scanSessionFile(join(fdir, f))) } catch { /* 跳过坏文件 */ }
    }
  }
  const byProject = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    if (!s.cwd) continue
    ;(byProject.get(s.cwd) ?? byProject.set(s.cwd, []).get(s.cwd)!).push(s)
  }
  const projects: ProjectMeta[] = [...byProject.entries()].map(([cwd, ss]) => ({
    projectPathAbs: cwd, folderName: ss[0].folderName, existsOnDisk: existsSync(cwd), inClaudeJson: false,
    sessionCount: ss.length, totalSizeBytes: ss.reduce((a, s) => a + s.sizeBytes, 0),
    lastActivityAt: ss.map((s) => s.lastActivityAt).filter(Boolean).sort().pop() ?? null,
  }))
  return { projects, sessions }
}

export interface IndexDiff { added: string[]; removed: string[]; changed: string[] }
export function diffSessions(fresh: SessionMeta[], existing: { session_id: string; size_bytes: number; mtime: number }[]): IndexDiff {
  const byId = new Map(existing.map((e) => [e.session_id, e]))
  const freshIds = new Set(fresh.map((s) => s.sessionId))
  const added: string[] = [], changed: string[] = []
  for (const s of fresh) {
    const e = byId.get(s.sessionId)
    if (!e) added.push(s.sessionId)
    else if (e.size_bytes !== s.sizeBytes || e.mtime !== s.mtime) changed.push(s.sessionId)
  }
  const removed = existing.filter((e) => !freshIds.has(e.session_id)).map((e) => e.session_id)
  return { added, removed, changed }
}
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: scanner 扫描聚合与索引 diff"`

---

## Task 6:fsBrowser(右栏目录浏览)

**Files:**
- Create: `src/main/core/fsBrowser.ts`, `src/main/core/fsBrowser.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/fsBrowser.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDir } from './fsBrowser'

describe('listDir', () => {
  it('只返回子目录并标记 git 仓库', () => {
    const root = mkdtempSync(join(tmpdir(), 'fb-'))
    mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b')); mkdirSync(join(root, 'b', '.git'))
    writeFileSync(join(root, 'file.txt'), 'x')
    const r = listDir(root)
    expect(r.entries.map((e) => e.name).sort()).toEqual(['a', 'b'])     // 文件不列
    expect(r.entries.find((e) => e.name === 'b')!.isGitRepo).toBe(true)
    expect(r.parent).toBe(require('node:path').dirname(root))
  })
})
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现**

`src/main/core/fsBrowser.ts`:
```ts
import { readdirSync, existsSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { FsListing } from '@shared/types'

export function listDir(path: string): FsListing {
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((e) => { try { return e.isDirectory() && !e.name.startsWith('.') } catch { return false } })
    .map((e) => {
      const p = join(path, e.name)
      let isGitRepo = false
      try { isGitRepo = existsSync(join(p, '.git')) } catch {}
      return { name: e.name, path: p, isDir: true, isGitRepo }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, entries }
}
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: fsBrowser 目录浏览"`

---

## Task 7:claudeJson(白名单克隆 + 原子合并写)

**Files:**
- Create: `src/main/core/claudeJson.ts`, `src/main/core/claudeJson.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/core/claudeJson.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProjectEntry } from './claudeJson'

describe('ensureProjectEntry', () => {
  it('从源克隆白名单字段、重置易失字段、保留其它顶层 key', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({
      userID: 'keep-me',
      projects: { '/src': { allowedTools: ['Bash'], mcpServers: { x: 1 }, lastSessionId: 'old', lastCost: 9, hasTrustDialogAccepted: true } },
    }))
    const added = ensureProjectEntry(f, '/dst', '/src')
    expect(added).toBe(true)
    const j = JSON.parse(readFileSync(f, 'utf8'))
    expect(j.userID).toBe('keep-me')                       // 其它 key 保留
    expect(j.projects['/src']).toBeTruthy()                // 源不动
    expect(j.projects['/dst'].allowedTools).toEqual(['Bash'])
    expect(j.projects['/dst'].mcpServers).toEqual({ x: 1 })
    expect(j.projects['/dst'].hasTrustDialogAccepted).toBe(true)
    expect(j.projects['/dst'].lastSessionId).toBeUndefined()  // 易失字段不带过去
    expect(j.projects['/dst'].lastCost).toBeUndefined()
  })
  it('目标已存在则不覆盖,返回 false', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cj-')), '.claude.json')
    writeFileSync(f, JSON.stringify({ projects: { '/dst': { allowedTools: ['Existing'] } } }))
    expect(ensureProjectEntry(f, '/dst', '/src')).toBe(false)
    expect(JSON.parse(readFileSync(f, 'utf8')).projects['/dst'].allowedTools).toEqual(['Existing'])
  })
})
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现**

`src/main/core/claudeJson.ts`:
```ts
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_JSON_CLONE_ALLOWLIST } from '@shared/constants'

function atomicWrite(file: string, data: string) {
  const tmp = join(dirname(file), `.claude.json.tmp-${process.pid}`)
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
}

export function ensureProjectEntry(claudeJsonPath: string, targetPath: string, sourcePath: string): boolean {
  if (!existsSync(claudeJsonPath)) return false
  const json = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))   // rename 前即时读
  json.projects ??= {}
  if (json.projects[targetPath]) return false                    // 不覆盖
  const src = json.projects[sourcePath] ?? {}
  const cloned: Record<string, unknown> = {}
  for (const k of CLAUDE_JSON_CLONE_ALLOWLIST) if (k in src) cloned[k] = src[k]
  json.projects[targetPath] = cloned
  atomicWrite(claudeJsonPath, JSON.stringify(json, null, 2))
  return true
}

export function removeProjectEntry(claudeJsonPath: string, targetPath: string) {
  if (!existsSync(claudeJsonPath)) return
  const json = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
  if (json.projects?.[targetPath]) { delete json.projects[targetPath]; atomicWrite(claudeJsonPath, JSON.stringify(json, null, 2)) }
}
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: claudeJson 白名单克隆与原子写"`

---

## Task 8:mover — 预检与预览

**Files:**
- Create: `src/main/core/mover.ts`, `src/main/core/mover.preview.test.ts`

- [ ] **Step 1: 写失败测试(预检/预览)**

`src/main/core/mover.preview.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewMove } from './mover'

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const projects = join(home, '.claude', 'projects'); mkdirSync(projects, { recursive: true })
  const src = join(home, 'work', 'proj'); mkdirSync(src, { recursive: true })
  const dst = join(home, 'work', 'moved'); mkdirSync(dst, { recursive: true })
  const folder = join(projects, '-' + src.slice(1).replace(/[^a-zA-Z0-9]/g, '-'))   // 与 encodePath 对齐
  // 简化:用 encodePath 生成
  return { home, projects, src, dst }
}

describe('previewMove', () => {
  it('正常会话:统计将改写的 cwd 字段与回收区体积,无阻断', async () => {
    const { projects, src, dst } = setup()
    const { encodePath } = await import('./pathCodec')
    const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
    writeFileSync(join(fdir, 's1.jsonl'),
      [JSON.stringify({ type: 'user', cwd: src, timestamp: '2026-06-15T10:00:00Z', message: { content: 'hi' } }),
       JSON.stringify({ type: 'assistant', cwd: src, timestamp: '2026-06-15T10:01:00Z', message: { content: 'ok' } })].join('\n'))
    // 把 mtime 调老,避免被判活跃
    utimesSync(join(fdir, 's1.jsonl'), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000))
    const pv = await previewMove(['s1'], dst, { projectsRoot: projects })
    expect(pv.items[0].blocked).toBeNull()
    expect(pv.items[0].structuralCwdFields).toBe(2)
    expect(pv.items[0].srcRoot).toBe(src)
    expect(pv.claudeJsonWillAddEntry).toBe(true)   // 测试环境无 .claude.json → 视为将新增
  })

  it('活跃会话被标记 blocked=live', async () => {
    const { projects, src, dst } = setup()
    const { encodePath } = await import('./pathCodec')
    const fdir = join(projects, encodePath(src)); mkdirSync(fdir, { recursive: true })
    writeFileSync(join(fdir, 's2.jsonl'), JSON.stringify({ type: 'user', cwd: src, timestamp: 't', message: { content: 'hi' } }))
    // 刚写,mtime 是现在 → 活跃
    const pv = await previewMove(['s2'], dst, { projectsRoot: projects })
    expect(pv.items[0].blocked).toBe('live')
  })
}
)
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现 previewMove(及内部辅助)**

`src/main/core/mover.ts`(本任务只实现 preview 相关导出与辅助;execute 在 Task 9):
```ts
import { statSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { MovePreview, MovePreviewItem } from '@shared/types'
import { encodePath } from './pathCodec'
import { scanSessionFile } from './jsonlScanner'
import { LIVE_MTIME_THRESHOLD_MS, CLAUDE_JSON } from '@shared/constants'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { rewriteLine } from './cwdRewriter'
import { readFileSync } from 'node:fs'

export interface MoverEnv { projectsRoot: string; claudeJsonPath?: string }

function findSessionFile(projectsRoot: string, sessionId: string): { jsonl: string; folder: string } | null {
  for (const folder of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const jsonl = join(projectsRoot, folder.name, `${sessionId}.jsonl`)
    if (existsSync(jsonl)) return { jsonl, folder: join(projectsRoot, folder.name) }
  }
  return null
}

function sidecarBytes(folder: string, sessionId: string): { sidecar: number; toolResults: number } {
  const dir = join(folder, sessionId)
  if (!existsSync(dir)) return { sidecar: 0, toolResults: 0 }
  const sz = (d: string): number => existsSync(d)
    ? readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? sz(join(d, e.name)) : statSync(join(d, e.name)).size), 0) : 0
  return { sidecar: sz(dir), toolResults: sz(join(dir, 'tool-results')) }
}

async function countStructuralCwd(jsonl: string, srcRoot: string, dstRoot: string): Promise<number> {
  let count = 0
  const rl = createInterface({ input: createReadStream(jsonl, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of rl) count += rewriteLine(raw, srcRoot, dstRoot).changes.length
  // 子代理 jsonl
  const sub = join(jsonl.replace(/\.jsonl$/, ''), 'subagents')
  if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) {
    const rl2 = createInterface({ input: createReadStream(join(sub, f), { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const raw of rl2) count += rewriteLine(raw, srcRoot, dstRoot).changes.length
  }
  return count
}

function claudeJsonHasEntry(claudeJsonPath: string, targetPath: string): boolean {
  if (!existsSync(claudeJsonPath)) return false
  try { return !!JSON.parse(readFileSync(claudeJsonPath, 'utf8')).projects?.[targetPath] } catch { return false }
}

export async function previewMove(sessionIds: string[], targetPath: string, env: MoverEnv): Promise<MovePreview> {
  const claudeJsonPath = env.claudeJsonPath ?? CLAUDE_JSON()
  const items: MovePreviewItem[] = []
  for (const sessionId of sessionIds) {
    const found = findSessionFile(env.projectsRoot, sessionId)
    if (!found) { items.push({ sessionId, title: sessionId, srcRoot: '', dstRoot: targetPath, structuralCwdFields: 0, sidecarBytes: 0, toolResultsBytes: 0, trashBackupBytes: 0, blocked: 'collision', blockReason: '源会话不存在' }); continue }
    const meta = await scanSessionFile(found.jsonl)
    const srcRoot = meta.cwd
    const st = statSync(found.jsonl)
    let blocked: MovePreviewItem['blocked'] = null, blockReason: string | undefined

    if (Date.now() - st.mtimeMs < LIVE_MTIME_THRESHOLD_MS) { blocked = 'live'; blockReason = '会话疑似活跃,请先关闭' }
    const targetFolder = join(env.projectsRoot, encodePath(targetPath))
    if (!blocked && (existsSync(join(targetFolder, `${sessionId}.jsonl`)) || existsSync(join(targetFolder, sessionId)))) { blocked = 'collision'; blockReason = '目标已存在同会话' }
    if (!blocked && existsSync(targetFolder)) {
      // 编码碰撞:目标文件夹已存在但真实 cwd 不同
      const someJsonl = readdirSync(targetFolder).find((f) => f.endsWith('.jsonl'))
      if (someJsonl) { const m2 = await scanSessionFile(join(targetFolder, someJsonl)); if (m2.cwd && m2.cwd !== targetPath) { blocked = 'encode-collision'; blockReason = `目标文件夹已被 ${m2.cwd} 占用` } }
    }
    if (!blocked && srcRoot === join(require('node:os').homedir(), '.claude')) { blocked = 'self-referential'; blockReason = '自引用 ~/.claude,需显式确认' }

    const sc = sidecarBytes(found.folder, sessionId)
    const fields = blocked ? 0 : await countStructuralCwd(found.jsonl, srcRoot, targetPath)
    const trashBackup = blocked ? 0 : st.size + // 主 jsonl 原件进回收区
      (existsSync(join(found.folder, sessionId, 'subagents')) ? readdirSync(join(found.folder, sessionId, 'subagents')).filter((f) => f.endsWith('.jsonl')).reduce((a, f) => a + statSync(join(found.folder, sessionId, 'subagents', f)).size, 0) : 0)
    items.push({ sessionId, title: meta.title, srcRoot, dstRoot: targetPath, structuralCwdFields: fields, sidecarBytes: sc.sidecar, toolResultsBytes: sc.toolResults, trashBackupBytes: trashBackup, blocked, blockReason })
  }
  return { items, claudeJsonWillAddEntry: !claudeJsonHasEntry(claudeJsonPath, targetPath), targetPathAbs: targetPath }
}
```

- [ ] **Step 4: 运行,确认通过** — 预期 PASS。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: mover 预检与预览"`

---

## Task 9:mover — 执行、回滚、reconcile、undo

**Files:**
- Modify: `src/main/core/mover.ts`
- Create: `src/main/core/mover.execute.test.ts`

- [ ] **Step 1: 写失败测试(执行 happy path + 文件落位 + 回收区 + cwd 改写)**

`src/main/core/mover.execute.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/db'
import { executeMove } from './mover'
import { encodePath } from './pathCodec'

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
    expect(existsSync(w.jsonl)).toBe(false)                       // 源已移走

    const lines = readFileSync(targetJsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].cwd).toBe(w.dst)                              // cwd 改写
    expect(lines[0].message.content).toBe(`opened ${w.src}/a.md`) // 正文不动

    const trashDir = join(w.trash, String(res[0].moveId))
    expect(readdirSync(trashDir, { recursive: true as any }).length).toBeGreaterThan(0)  // 原件在回收区
  })
})
```

- [ ] **Step 2: 运行,确认失败** — 预期 FAIL。

- [ ] **Step 3: 实现 executeMove / rollback / reconcile / undoMove**

在 `src/main/core/mover.ts` 追加:
```ts
import { mkdirSync, renameSync, createWriteStream, rmSync } from 'node:fs'
import type { MoveResult } from '@shared/types'
import { ensureProjectEntry, removeProjectEntry } from './claudeJson'
import { SNAPSHOT_LINE_SIZE_CAP_BYTES, TRASH_ROOT } from '@shared/constants'
import type { Db } from '../db/db'

export interface ExecEnv extends MoverEnv { trashRoot?: string; db: Db }

async function rewriteFileToTarget(srcFile: string, dstFile: string, fileRel: string, srcRoot: string, dstRoot: string) {
  mkdirSync(require('node:path').dirname(dstFile), { recursive: true })
  const out = createWriteStream(dstFile, { encoding: 'utf8' })
  const changes: { fileRel: string; lineNo: number; oldCwd: string; newCwd: string }[] = []
  const snapshot: { fileRel: string; lineNo: number; content: string }[] = []
  const small = statSync(srcFile).size <= SNAPSHOT_LINE_SIZE_CAP_BYTES
  const rl = createInterface({ input: createReadStream(srcFile, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const raw of rl) {
    n++
    const r = rewriteLine(raw, srcRoot, dstRoot)
    for (const c of r.changes) changes.push({ fileRel, lineNo: n, oldCwd: c.oldCwd, newCwd: c.newCwd })
    if (small && r.changes.length) snapshot.push({ fileRel, lineNo: n, content: raw })
    out.write(r.line + '\n')
  }
  await new Promise<void>((res, rej) => out.end((e: any) => (e ? rej(e) : res())))
  return { changes, snapshot }
}

export async function executeMove(sessionIds: string[], targetPath: string, env: ExecEnv): Promise<MoveResult[]> {
  const trashRoot = env.trashRoot ?? TRASH_ROOT()
  const claudeJsonPath = env.claudeJsonPath ?? CLAUDE_JSON()
  const results: MoveResult[] = []
  const pv = await previewMove(sessionIds, targetPath, env)

  for (const item of pv.items) {
    if (item.blocked) { results.push({ sessionId: item.sessionId, status: 'skipped', error: item.blockReason }); continue }
    const found = findSessionFile(env.projectsRoot, item.sessionId)!
    const srcRoot = item.srcRoot
    const targetFolder = join(env.projectsRoot, encodePath(targetPath))
    const moveId = env.db.insertMove({ sessionId: item.sessionId, projectName: srcRoot, sourceDirAbs: srcRoot, sourceFolder: found.folder, sourceCwd: srcRoot, targetDirAbs: targetPath, targetFolder, trashPath: join(trashRoot, '0'), claudeJsonUpdated: false })
    const trashDir = join(trashRoot, String(moveId))
    const written: string[] = []
    try {
      mkdirSync(targetFolder, { recursive: true }); mkdirSync(trashDir, { recursive: true })
      const allChanges: any[] = [], allSnap: any[] = []

      // 1) 主 jsonl 改写到目标
      const mainTarget = join(targetFolder, `${item.sessionId}.jsonl`)
      const r1 = await rewriteFileToTarget(found.jsonl, mainTarget, `${item.sessionId}.jsonl`, srcRoot, targetPath)
      written.push(mainTarget); allChanges.push(...r1.changes); allSnap.push(...r1.snapshot)

      // 2) 子代理 jsonl 改写;其余 sidecar 原样搬
      const srcSidecar = join(found.folder, item.sessionId)
      const dstSidecar = join(targetFolder, item.sessionId)
      if (existsSync(srcSidecar)) {
        const subSrc = join(srcSidecar, 'subagents')
        if (existsSync(subSrc)) for (const f of readdirSync(subSrc)) {
          const sp = join(subSrc, f), dp = join(dstSidecar, 'subagents', f)
          if (f.endsWith('.jsonl')) { const r = await rewriteFileToTarget(sp, dp, `${item.sessionId}/subagents/${f}`, srcRoot, targetPath); written.push(dp); allChanges.push(...r.changes); allSnap.push(...r.snapshot) }
          else { mkdirSync(require('node:path').dirname(dp), { recursive: true }); renameSync(sp, dp) }  // meta 原样搬
        }
        for (const sub of ['tool-results', 'hooks']) {
          const d = join(srcSidecar, sub)
          if (existsSync(d)) { mkdirSync(dstSidecar, { recursive: true }); renameSync(d, join(dstSidecar, sub)) }
        }
        // 其余散落文件
        for (const e of readdirSync(srcSidecar, { withFileTypes: true })) if (e.isFile()) renameSync(join(srcSidecar, e.name), (mkdirSync(dstSidecar, { recursive: true }), join(dstSidecar, e.name)))
      }

      // 3) 校验目标主文件存在
      if (!existsSync(mainTarget)) throw new Error('目标写入校验失败')

      // 4) 原始件移入回收区(主 jsonl + 原 sidecar 残余)
      renameSync(found.jsonl, join(trashDir, `${item.sessionId}.jsonl`))
      if (existsSync(srcSidecar)) renameSync(srcSidecar, join(trashDir, item.sessionId))

      // 5) 记录变更/快照、更新 .claude.json、提交
      env.db.insertCwdChanges(moveId, allChanges)
      if (allSnap.length) env.db.insertSnapshotLines(moveId, allSnap)
      const added = ensureProjectEntry(claudeJsonPath, targetPath, srcRoot)
      env.db.updateMoveStatus(moveId, 'done', { rewrittenFieldCount: allChanges.length, sidecarBytes: item.sidecarBytes, claudeJsonUpdated: added })
      results.push({ sessionId: item.sessionId, status: 'done', moveId })
    } catch (e: any) {
      // 回滚:删除已写入的目标文件;原件若已入回收区则搬回
      for (const w of written) try { rmSync(w, { force: true }) } catch {}
      try { rmSync(join(targetFolder, item.sessionId), { recursive: true, force: true }) } catch {}
      const trashedMain = join(trashDir, `${item.sessionId}.jsonl`)
      if (existsSync(trashedMain) && !existsSync(found.jsonl)) renameSync(trashedMain, found.jsonl)
      const trashedSidecar = join(trashDir, item.sessionId)
      if (existsSync(trashedSidecar) && !existsSync(join(found.folder, item.sessionId))) renameSync(trashedSidecar, join(found.folder, item.sessionId))
      env.db.updateMoveStatus(moveId, 'failed')
      results.push({ sessionId: item.sessionId, status: 'failed', moveId, error: String(e?.message ?? e) })
    }
  }
  return results
}

// 启动 reconcile:pending 的移动按磁盘现状收尾
export function reconcile(env: ExecEnv) {
  for (const m of env.db.getPendingMoves()) {
    const targetMain = join(m.target_folder, `${m.session_id}.jsonl`)
    const trashedMain = join(env.trashRoot ?? TRASH_ROOT(), String(m.id), `${m.session_id}.jsonl`)
    const sourceMain = join(m.source_folder, `${m.session_id}.jsonl`)
    if (existsSync(targetMain) && !existsSync(sourceMain)) env.db.updateMoveStatus(m.id, 'done')         // 目标已就位
    else { if (existsSync(trashedMain) && !existsSync(sourceMain)) renameSync(trashedMain, sourceMain); try { rmSync(targetMain, { force: true }) } catch {}; env.db.updateMoveStatus(m.id, 'failed') }
  }
}

// 用户撤销一次已完成的移动(回收区仍在)
export function undoMove(moveId: number, env: ExecEnv) {
  const m = env.db.getMoves().find((x) => x.id === moveId)
  if (!m || m.status !== 'done') throw new Error('该移动不可撤销')
  const trashDir = join(env.trashRoot ?? TRASH_ROOT(), String(moveId))
  const sourceMain = join(m.source_folder, `${m.session_id}.jsonl`)
  const targetMain = join(m.target_folder, `${m.session_id}.jsonl`)
  const trashedMain = join(trashDir, `${m.session_id}.jsonl`)
  if (!existsSync(trashedMain)) throw new Error('回收区备份缺失,无法撤销')
  // 删目标改写件、搬回原件
  try { rmSync(targetMain, { force: true }) } catch {}
  try { rmSync(join(m.target_folder, m.session_id), { recursive: true, force: true }) } catch {}
  mkdirSync(m.source_folder, { recursive: true })
  renameSync(trashedMain, sourceMain)
  const trashedSidecar = join(trashDir, m.session_id)
  if (existsSync(trashedSidecar)) renameSync(trashedSidecar, join(m.source_folder, m.session_id))
  if (m.claude_json_updated) removeProjectEntry(env.claudeJsonPath ?? CLAUDE_JSON(), m.target_dir_abs)
  env.db.updateMoveStatus(moveId, 'rolledback')
}
```

- [ ] **Step 4: 运行,确认通过** — `npx vitest run src/main/core/mover.execute.test.ts`,预期 PASS。

- [ ] **Step 5: 补一个回滚测试**

在 `mover.execute.test.ts` 追加:模拟目标文件夹只读或 sidecar 写入抛错时,断言源文件仍在原位、`moves.status='failed'`。(用 monkeypatch:把 `dst` 设为一个无写权限路径触发异常,或对一个不存在的 sessionId 调用 → skipped。)
```ts
it('找不到的会话 → skipped 不影响其它', async () => {
  const w = world(); const db = openDb(':memory:')
  const res = await executeMove(['nope'], w.dst, { projectsRoot: w.projects, trashRoot: w.trash, claudeJsonPath: join(w.home, '.claude.json'), db })
  expect(res[0].status).toBe('skipped')
})
```
运行确认 PASS。

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: mover 执行/回滚/reconcile/undo"`

---

## Task 10:IPC 与 preload 桥

**Files:**
- Create: `src/main/ipc.ts`, `src/main/appState.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`(加 `window.api` 接口)

- [ ] **Step 1: 实现 appState(单例 db 路径 + env)**

`src/main/appState.ts`:
```ts
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openDb, type Db } from './db/db'
import { PROJECTS_ROOT, CLAUDE_JSON, TRASH_ROOT } from '@shared/constants'

let db: Db
export function getEnv() {
  if (!db) {
    const dir = app.getPath('userData'); mkdirSync(dir, { recursive: true })
    db = openDb(join(dir, 'index.db'))
  }
  return { db, projectsRoot: PROJECTS_ROOT(), claudeJsonPath: CLAUDE_JSON(), trashRoot: TRASH_ROOT() }
}
```

- [ ] **Step 2: 实现 ipc 注册**

`src/main/ipc.ts`:
```ts
import { ipcMain } from 'electron'
import { homedir } from 'node:os'
import { getEnv } from './appState'
import { scanAll, diffSessions } from './core/scanner'
import { listDir } from './core/fsBrowser'
import { previewMove, executeMove, reconcile, undoMove } from './core/mover'

export function registerIpc() {
  const env = getEnv()
  reconcile(env as any)   // 启动收尾

  ipcMain.handle('index:get', () => ({ projects: env.db.getProjects(), }))
  ipcMain.handle('sessions:get', (_e, projectPathAbs: string) => env.db.getSessions(projectPathAbs))
  ipcMain.handle('refresh:run', async () => {
    const { projects, sessions } = await scanAll(env.projectsRoot)
    const existing = env.db.raw.prepare('SELECT session_id,size_bytes,mtime FROM sessions').all() as any[]
    const diff = diffSessions(sessions, existing)
    env.db.transaction(() => {
      for (const p of projects) env.db.upsertProject(p)
      for (const s of sessions) env.db.upsertSession({ ...s, movedFlag: false, lastMoveId: null })
      for (const id of diff.removed) env.db.deleteSession(id)
    })
    return { projects: env.db.getProjects(), diff }
  })
  ipcMain.handle('fs:list', (_e, path: string) => listDir(path || homedir()))
  ipcMain.handle('move:preview', (_e, ids: string[], target: string) => previewMove(ids, target, env as any))
  ipcMain.handle('move:execute', (_e, ids: string[], target: string) => executeMove(ids, target, env as any))
  ipcMain.handle('moves:list', () => env.db.getMoves())
  ipcMain.handle('move:undo', (_e, moveId: number) => { undoMove(moveId, env as any); return env.db.getMoves() })
}
```

- [ ] **Step 3: preload 暴露 typed api**

`src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron'
const api = {
  getIndex: () => ipcRenderer.invoke('index:get'),
  getSessions: (p: string) => ipcRenderer.invoke('sessions:get', p),
  refresh: () => ipcRenderer.invoke('refresh:run'),
  listDir: (p: string) => ipcRenderer.invoke('fs:list', p),
  previewMove: (ids: string[], t: string) => ipcRenderer.invoke('move:preview', ids, t),
  executeMove: (ids: string[], t: string) => ipcRenderer.invoke('move:execute', ids, t),
  listMoves: () => ipcRenderer.invoke('moves:list'),
  undoMove: (id: number) => ipcRenderer.invoke('move:undo', id),
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
```

在 `src/shared/types.ts` 末尾加:
```ts
declare global { interface Window { api: import('../preload/index').Api } }
```

- [ ] **Step 4: 在 main 注册**

`src/main/index.ts` 的 `app.whenReady().then(...)` 改为先 `registerIpc()` 再 `createWindow()`:
```ts
import { registerIpc } from './ipc'
app.whenReady().then(() => { registerIpc(); createWindow() })
```

- [ ] **Step 5: 冒烟验证** — `npm run dev` 不报错;在 DevTools 控制台执行 `await window.api.refresh()` 应返回 `{projects, diff}` 且能看到真实项目。

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: IPC 与 preload 桥,启动 reconcile + 刷新索引"`

---

## Task 11:渲染层三栏 UI

**Files:**
- Create: `src/renderer/state.ts`, `src/renderer/components/DirectoryPane.tsx`, `SessionPane.tsx`, `FsBrowserPane.tsx`, `MoveBar.tsx`, `ConfirmModal.tsx`, `src/renderer/styles.css`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: 全局状态(轻量,用 React state + 简单 store)**

`src/renderer/state.ts`:
```ts
import { useState, useCallback } from 'react'
import type { ProjectMeta, MovePreview } from '@shared/types'

export function useAppState() {
  const [projects, setProjects] = useState<any[]>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [sessions, setSessions] = useState<any[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [fsPath, setFsPath] = useState<string>('')
  const [fsListing, setFsListing] = useState<any>(null)
  const [targetDir, setTargetDir] = useState<string | null>(null)
  const [preview, setPreview] = useState<MovePreview | null>(null)

  const loadIndex = useCallback(async () => setProjects((await window.api.getIndex()).projects), [])
  const refresh = useCallback(async () => { const r = await window.api.refresh(); setProjects(r.projects); return r.diff }, [])
  const pickProject = useCallback(async (p: string) => { setSelectedProject(p); setSelectedSessions(new Set()); setSessions(await window.api.getSessions(p)) }, [])
  const browse = useCallback(async (p: string) => { const l = await window.api.listDir(p); setFsPath(l.path); setFsListing(l) }, [])

  return { projects, selectedProject, sessions, selectedSessions, setSelectedSessions, fsPath, fsListing, targetDir, setTargetDir, preview, setPreview, loadIndex, refresh, pickProject, browse }
}
```

- [ ] **Step 2: 三个面板组件**

`DirectoryPane.tsx`:
```tsx
import React from 'react'
export function DirectoryPane({ projects, selected, onPick }: { projects: any[]; selected: string | null; onPick: (p: string) => void }) {
  return (
    <div className="pane">
      <div className="pane-header">目录 / 项目 ({projects.length})</div>
      <ul className="list">
        {projects.map((p) => (
          <li key={p.project_path_abs} className={selected === p.project_path_abs ? 'row sel' : 'row'} onClick={() => onPick(p.project_path_abs)}>
            <div className="row-title">{p.project_path_abs}</div>
            <div className="row-sub">{p.session_count} 会话 · {(p.total_size_bytes/1e6).toFixed(1)}MB{p.exists_on_disk ? '' : ' · 路径已不存在'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

`SessionPane.tsx`:
```tsx
import React from 'react'
export function SessionPane({ sessions, selected, onToggle }: { sessions: any[]; selected: Set<string>; onToggle: (id: string, multi: boolean) => void }) {
  return (
    <div className="pane">
      <div className="pane-header">会话 ({sessions.length}) · 已选 {selected.size}</div>
      <ul className="list">
        {sessions.map((s) => (
          <li key={s.session_id} className={selected.has(s.session_id) ? 'row sel' : 'row'} onClick={(e) => onToggle(s.session_id, e.ctrlKey || e.metaKey)}>
            <div className="row-title">{s.title || s.first_message_preview || s.session_id}</div>
            <div className="row-sub">{s.message_count} 条 · {(s.size_bytes/1e6).toFixed(1)}MB · {s.last_activity_at ?? ''}{s.moved_flag ? ' · 已移动' : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

`FsBrowserPane.tsx`:
```tsx
import React from 'react'
export function FsBrowserPane({ listing, target, onBrowse, onPickTarget }: { listing: any; target: string | null; onBrowse: (p: string) => void; onPickTarget: (p: string) => void }) {
  if (!listing) return <div className="pane"><div className="pane-header">目标目录</div></div>
  return (
    <div className="pane">
      <div className="pane-header">目标目录</div>
      <div className="crumb">
        <button disabled={!listing.parent} onClick={() => listing.parent && onBrowse(listing.parent)}>⬆ 上级</button>
        <span className="path">{listing.path}</span>
        <button className={target === listing.path ? 'pick sel' : 'pick'} onClick={() => onPickTarget(listing.path)}>选为目标</button>
      </div>
      <ul className="list">
        {listing.entries.map((e: any) => (
          <li key={e.path} className="row" onDoubleClick={() => onBrowse(e.path)} onClick={() => onPickTarget(e.path)}>
            <div className="row-title">{e.isGitRepo ? '📦 ' : '📁 '}{e.name}{target === e.path ? '  ✓ 目标' : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 3: MoveBar 与 ConfirmModal**

`MoveBar.tsx`:
```tsx
import React from 'react'
export function MoveBar({ count, target, onMove, onRefresh }: { count: number; target: string | null; onMove: () => void; onRefresh: () => void }) {
  return (
    <div className="movebar">
      <button onClick={onRefresh}>刷新索引</button>
      <div className="spacer" />
      <button className="primary" disabled={count === 0 || !target} onClick={onMove}>
        移动 {count} 个会话 {target ? `→ ${target}` : ''}
      </button>
    </div>
  )
}
```

`ConfirmModal.tsx`:
```tsx
import React from 'react'
import type { MovePreview } from '@shared/types'
export function ConfirmModal({ preview, onCancel, onConfirm }: { preview: MovePreview; onCancel: () => void; onConfirm: () => void }) {
  const movable = preview.items.filter((i) => !i.blocked)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>确认移动 → {preview.targetPathAbs}</h3>
        <p>{preview.claudeJsonWillAddEntry ? '将为目标新增 ~/.claude.json projects 条目' : '目标已是已知项目'}</p>
        <table className="preview">
          <thead><tr><th>会话</th><th>cwd 改写</th><th>sidecar</th><th>回收区备份</th><th>状态</th></tr></thead>
          <tbody>
            {preview.items.map((i) => (
              <tr key={i.sessionId} className={i.blocked ? 'blocked' : ''}>
                <td>{i.title}</td><td>{i.structuralCwdFields}</td>
                <td>{(i.toolResultsBytes/1e6).toFixed(1)}MB</td>
                <td>{(i.trashBackupBytes/1e6).toFixed(1)}MB</td>
                <td>{i.blocked ? `⛔ ${i.blockReason}` : '✓ 可移动'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={movable.length === 0} onClick={onConfirm}>执行移动 {movable.length} 个</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 组装 App + 样式**

`src/renderer/App.tsx`:
```tsx
import React, { useEffect } from 'react'
import { useAppState } from './state'
import { DirectoryPane } from './components/DirectoryPane'
import { SessionPane } from './components/SessionPane'
import { FsBrowserPane } from './components/FsBrowserPane'
import { MoveBar } from './components/MoveBar'
import { ConfirmModal } from './components/ConfirmModal'
import './styles.css'

export function App() {
  const st = useAppState()
  useEffect(() => { st.loadIndex(); st.browse('') }, [])

  const toggle = (id: string, multi: boolean) => {
    const next = new Set(multi ? st.selectedSessions : [])
    if (st.selectedSessions.has(id) && multi) next.delete(id); else next.add(id)
    st.setSelectedSessions(next)
  }
  const startMove = async () => st.setPreview(await window.api.previewMove([...st.selectedSessions], st.targetDir!))
  const confirmMove = async () => {
    await window.api.executeMove([...st.selectedSessions], st.targetDir!)
    st.setPreview(null); st.setSelectedSessions(new Set())
    await st.refresh(); if (st.selectedProject) st.pickProject(st.selectedProject)
  }

  return (
    <div className="app">
      <div className="cols">
        <DirectoryPane projects={st.projects} selected={st.selectedProject} onPick={st.pickProject} />
        <SessionPane sessions={st.sessions} selected={st.selectedSessions} onToggle={toggle} />
        <FsBrowserPane listing={st.fsListing} target={st.targetDir} onBrowse={st.browse} onPickTarget={st.setTargetDir} />
      </div>
      <MoveBar count={st.selectedSessions.size} target={st.targetDir} onMove={startMove} onRefresh={st.refresh} />
      {st.preview && <ConfirmModal preview={st.preview} onCancel={() => st.setPreview(null)} onConfirm={confirmMove} />}
    </div>
  )
}
```

`src/renderer/styles.css`(精简,够用即可):
```css
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
body, .app { margin: 0; height: 100vh; display: flex; flex-direction: column; }
.cols { flex: 1; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; background: #ddd; min-height: 0; }
.pane { background: #fff; display: flex; flex-direction: column; min-height: 0; }
.pane-header { padding: 8px 12px; font-weight: 600; border-bottom: 1px solid #eee; background: #fafafa; }
.list { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
.row { padding: 8px 12px; border-bottom: 1px solid #f2f2f2; cursor: pointer; }
.row:hover { background: #f7f9ff; }
.row.sel { background: #e6efff; }
.row-title { font-size: 13px; }
.row-sub { font-size: 11px; color: #888; margin-top: 2px; }
.crumb { display: flex; gap: 8px; align-items: center; padding: 6px 12px; border-bottom: 1px solid #eee; font-size: 12px; }
.crumb .path { flex: 1; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick.sel { background: #2563eb; color: #fff; }
.movebar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid #eee; background: #fafafa; }
.movebar .spacer { flex: 1; }
button.primary { background: #2563eb; color: #fff; border: 0; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
button.primary:disabled { background: #b9c6e6; cursor: not-allowed; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
.modal { background: #fff; border-radius: 10px; padding: 20px; width: 680px; max-height: 80vh; overflow: auto; }
.preview { width: 100%; border-collapse: collapse; font-size: 12px; margin: 12px 0; }
.preview th, .preview td { border: 1px solid #eee; padding: 6px; text-align: left; }
.preview tr.blocked { color: #b00; background: #fff5f5; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 5: 手动端到端验证(不破坏真实数据)**

先用一个**临时假 HOME** 跑,避免动到真实会话:
```bash
# 准备一个隔离的假数据目录后,用 HOME 覆盖启动(macOS/Linux)
HOME=/tmp/cc-fake-home npm run dev
```
在假环境里造 1~2 个会话,验证:左栏出现项目 → 中栏多选会话 → 右栏浏览并选目标 → 点"移动" → 确认弹窗显示预览 → 执行 → 刷新后会话出现在新目录、源消失、回收区有备份。

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: 三栏 UI(目录/会话/目标)+ 移动确认弹窗"`

---

## Task 12:历史与撤销视图

**Files:**
- Create: `src/renderer/components/HistoryView.tsx`
- Modify: `src/renderer/App.tsx`(加一个"历史"开关)

- [ ] **Step 1: 实现 HistoryView**

`HistoryView.tsx`:
```tsx
import React, { useEffect, useState } from 'react'
export function HistoryView({ onClose }: { onClose: () => void }) {
  const [moves, setMoves] = useState<any[]>([])
  const load = async () => setMoves(await window.api.listMoves())
  useEffect(() => { load() }, [])
  const undo = async (id: number) => { await window.api.undoMove(id); await load() }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>移动历史</h3>
        <table className="preview">
          <thead><tr><th>#</th><th>会话</th><th>源 → 目标</th><th>时间</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td><td>{m.session_id}</td>
                <td>{m.source_dir_abs} → {m.target_dir_abs}</td>
                <td>{m.moved_at}</td><td>{m.status}</td>
                <td>{m.status === 'done' && <button onClick={() => undo(m.id)}>撤销</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 MoveBar/App 加入口**

`App.tsx` 加 `const [showHistory, setShowHistory] = useState(false)`,MoveBar 旁加按钮 `<button onClick={() => setShowHistory(true)}>历史</button>`,并在末尾渲染 `{showHistory && <HistoryView onClose={() => setShowHistory(false)} />}`。

- [ ] **Step 3: 手动验证** — 假环境里移动后打开历史,执行撤销,确认会话回到源目录、回收区记录、状态变 `rolledback`。

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: 移动历史与撤销视图"`

---

## Task 13:收尾与文档

- [ ] **Step 1: 全量测试 + 覆盖率**

Run: `npx vitest run --coverage`(需要时 `npm i -D @vitest/coverage-v8`)。确认核心模块(pathCodec / cwdRewriter / jsonlScanner / mover / claudeJson / db)覆盖率 ≥80%。缺口补测试。

- [ ] **Step 2: 写 README**

`README.md`:用中文、不硬换行,说明用途、`npm run dev`/`build`、移动语义(前缀重定位)、回收区位置 `~/.claude/.cc-move-trash`(不自动 GC)、"移动前请关闭对应会话"的安全提示、以及"全量历史归档与还原"为未来方向。

- [ ] **Step 3: Commit** — `git add -A && git commit -m "test: 覆盖率收口 + docs: README"`

---

## 自检对照(规格覆盖)

- 三栏 UI(左目录/中会话多选/右目录浏览)→ Task 11 ✓
- 前缀重定位 cwd、正文不改写 → Task 2 + Task 9 ✓
- 整 `<id>/` 子树(subagents 改写 / tool-results·meta·hooks 原样搬)→ Task 9 ✓
- `memory/` 不移动(scanner 不递归会话 sidecar 之外,mover 只动 `<id>.jsonl` + `<id>/`)→ Task 9 ✓(memory 不在移动集合内)
- 活跃会话拒绝、目标冲突、编码碰撞、自引用阻断 → Task 8 预检 ✓
- copy→校验→提交→后删 + 启动 reconcile + pending 收尾 → Task 9 ✓
- 回收区保留不 GC、撤销 → Task 9 + Task 12 ✓
- `.claude.json` 白名单克隆 + 重置易失 + 原子合并保留其它 key → Task 7 ✓
- SQLite 全量索引(元数据)+ 移动历史 + cwd_changes + 小文件 snapshot_lines → Task 4/5/9 ✓
- 手动刷新 + diff 预览 → Task 10 `refresh:run` + Task 11(diff 可在 UI 提示)✓
- 流式 + 跳过坏行 + 大文件不进 SQLite(体积阈值)→ Task 3/9 ✓
- vitest ≥80% → Task 13 ✓
- 未来方向(全量历史归档与还原)保持可扩展 → 存储边界解耦,见规格 §10 ✓
