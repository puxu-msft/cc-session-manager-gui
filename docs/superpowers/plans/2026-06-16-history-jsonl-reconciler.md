# history.jsonl 对账器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 cc-move-session 增加一个独立、可重入的 history.jsonl 对账子系统:以会话 jsonl 真实 cwd 为准,把输入框历史里 stale 的 project 字段对齐过来,move 流程零改动。

**Architecture:** 两个纯逻辑模块 `historyJsonl`(底层原子读写原语)+ `historyReconciler`(判定/执行/撤销),经 db/sources/appState/ipc/preload 接线。并发安全靠"硬前置 + rename 前 size/mtime 检测中止",改写按 `(sessionId, 实际旧 project)` 分组以保证 undo 精确。本计划交付后端能力(含 IPC);UI 面板见后续计划。

**Tech Stack:** TypeScript、Node fs、better-sqlite3、Electron IPC、vitest。

**关联 spec:** `docs/superpowers/specs/2026-06-16-history-jsonl-reconciler-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/main/core/historyJsonl.ts` | readHistory + applyHistoryRewrite(原子写 + 并发检测) | 新建 |
| `src/main/core/historyJsonl.test.ts` | 上者单测 | 新建 |
| `src/main/core/historyReconciler.ts` | planReconcile / planForce / executeReconcile / undoRewrite | 新建 |
| `src/main/core/historyReconciler.test.ts` | 上者单测 | 新建 |
| `src/main/db/schema.ts` | 加 history_rewrites + history_rewrite_sessions 两表 | 改 |
| `src/main/db/db.ts` | getSessionCwd / insertHistoryRewrite / getHistoryRewrites / getHistoryRewrite | 改 |
| `src/main/db/db.test.ts` | 新 db 方法测试 | 改 |
| `src/main/sources.ts` | Source 增 historyJsonlPath | 改 |
| `src/main/sources.test.ts` | 断言新字段 | 改 |
| `src/main/appState.ts` | Env 增 historyJsonlPath + getEnv 透传 | 改 |
| `src/main/ipc.ts` | 注册 4 个 history:* handler | 改 |
| `src/preload/index.ts` | 暴露 4 个类型化方法 | 改 |

---

## Task 1: historyJsonl.readHistory

**Files:**
- Create: `src/main/core/historyJsonl.ts`
- Test: `src/main/core/historyJsonl.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistory } from './historyJsonl'

let dir: string
const histPath = () => join(dir, 'history.jsonl')
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('readHistory', () => {
  it('文件不存在返回空,不抛', () => {
    const r = readHistory(histPath())
    expect(r.lines).toEqual([])
    expect(r.size).toBe(0)
  })

  it('逐行解析,损坏行 parsed=null 但保留 raw', () => {
    writeFileSync(histPath(), '{"sessionId":"a","project":"/p"}\nNOT_JSON\n{"sessionId":"b","project":"/q"}\n')
    const r = readHistory(histPath())
    expect(r.lines).toHaveLength(3)
    expect(r.lines[0].parsed?.sessionId).toBe('a')
    expect(r.lines[1].parsed).toBeNull()
    expect(r.lines[1].raw).toBe('NOT_JSON')
    expect(r.lines[2].lineNo).toBe(3)
    expect(r.size).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/historyJsonl.test.ts`
Expected: FAIL — `readHistory is not a function` / 模块不存在。

- [ ] **Step 3: 实现 readHistory**

```ts
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface HistoryLine {
  display?: unknown; pastedContents?: unknown; timestamp?: unknown
  project?: string; sessionId?: string
}
export interface HistoryLineRec { raw: string; parsed: HistoryLine | null; lineNo: number }
export interface ReadHistory { lines: HistoryLineRec[]; size: number; mtime: number }

// 整文件读(history 有界)。损坏行保留 raw、parsed=null。文件不存在返回空,不抛。
// 末尾因 '\n' 产生的空段不计为一行。
export function readHistory(path: string): ReadHistory {
  if (!existsSync(path)) return { lines: [], size: 0, mtime: 0 }
  const st = statSync(path)
  const raws = readFileSync(path, 'utf8').split('\n')
  const lines: HistoryLineRec[] = []
  raws.forEach((raw, i) => {
    if (i === raws.length - 1 && raw === '') return
    let parsed: HistoryLine | null = null
    try { parsed = JSON.parse(raw) } catch { /* 损坏行 */ }
    lines.push({ raw, parsed, lineNo: i + 1 })
  })
  return { lines, size: st.size, mtime: st.mtimeMs }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/historyJsonl.test.ts`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/historyJsonl.ts src/main/core/historyJsonl.test.ts
git commit -m "feat: historyJsonl.readHistory 流式逐行读+损坏行透传+缺文件返回空"
```

---

## Task 2: historyJsonl.applyHistoryRewrite

**Files:**
- Modify: `src/main/core/historyJsonl.ts`
- Test: `src/main/core/historyJsonl.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
import { readFileSync } from 'node:fs'
import { statSync } from 'node:fs'
import { applyHistoryRewrite } from './historyJsonl'

describe('applyHistoryRewrite', () => {
  it('只改命中 (sessionId, oldProject) 的 project,非目标/损坏行字节透传', () => {
    const raw = '{"display":"x","project":"/a","sessionId":"s1"}\nBROKEN\n{"display":"y","project":"/keep","sessionId":"s2"}\n'
    writeFileSync(histPath(), raw)
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [{ sessionId: 's1', oldProject: '/a', newProject: '/b' }], { size: g.size, mtime: g.mtimeMs })
    const after = readFileSync(histPath(), 'utf8')
    expect(after).toContain('"project":"/b"')
    expect(after).toContain('BROKEN')                 // 损坏行透传
    expect(after).toContain('"project":"/keep"')      // 非命中会话不动
    expect(after.startsWith('{"display":"x"')).toBe(true) // 同行其余字段值不变
    expect(ops).toEqual([{ oldProject: '/a', newProject: '/b', sessionIds: ['s1'], affectedLines: 1 }])
  })

  it('同 sessionId 散落 A、B 两组各自聚合成一条 op', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s"}\n{"project":"/x","sessionId":"s"}\n')
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [
      { sessionId: 's', oldProject: '/a', newProject: '/c' },
      { sessionId: 's', oldProject: '/x', newProject: '/c' },
    ], { size: g.size, mtime: g.mtimeMs })
    expect(ops).toContainEqual({ oldProject: '/a', newProject: '/c', sessionIds: ['s'], affectedLines: 1 })
    expect(ops).toContainEqual({ oldProject: '/x', newProject: '/c', sessionIds: ['s'], affectedLines: 1 })
  })

  it('rename 前 size/mtime 与 guard 不符则中止,不覆盖原文件', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s1"}\n')
    const stale = { size: 999999, mtime: 1 } // 故意错的 guard
    expect(() => applyHistoryRewrite(histPath(), [{ sessionId: 's1', oldProject: '/a', newProject: '/b' }], stale))
      .toThrow(/对账期间被修改/)
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/a"') // 未被覆盖
  })

  it('无命中则不写、返回空', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s1"}\n')
    const g = statSync(histPath())
    const ops = applyHistoryRewrite(histPath(), [{ sessionId: 'nope', oldProject: '/z', newProject: '/b' }], { size: g.size, mtime: g.mtimeMs })
    expect(ops).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/historyJsonl.test.ts`
Expected: FAIL — `applyHistoryRewrite is not a function`。

- [ ] **Step 3: 实现 applyHistoryRewrite**

在 `historyJsonl.ts` 末尾追加:

```ts
export interface ApplyOp { sessionId: string; oldProject: string; newProject: string }
export interface RewriteOp { oldProject: string; newProject: string; sessionIds: string[]; affectedLines: number }

const SEP = ' '

// 原子改写:仅对命中 (sessionId, 行内实际 project===oldProject) 的行改 project 为 newProject。
// 非目标行 / 损坏行 raw 字节透传。rename 前重新 stat,与 guard 不符则中止不覆盖(并发检测)。
// 返回按 (oldProject,newProject) 聚合的 RewriteOp[](同 sessionId 多旧值自然分多条)。
export function applyHistoryRewrite(path: string, ops: ApplyOp[], guard: { size: number; mtime: number }): RewriteOp[] {
  if (!existsSync(path)) return []
  const want = new Map(ops.map((o) => [o.sessionId + SEP + o.oldProject, o.newProject]))
  const raws = readFileSync(path, 'utf8').split('\n')
  const agg = new Map<string, { sessionIds: Set<string>; lines: number }>()

  const out = raws.map((raw) => {
    if (raw === '') return raw
    let o: any
    try { o = JSON.parse(raw) } catch { return raw }
    if (!o || typeof o.project !== 'string' || typeof o.sessionId !== 'string') return raw
    const nv = want.get(o.sessionId + SEP + o.project)
    if (nv === undefined) return raw
    const ak = o.project + SEP + nv
    const a = agg.get(ak) ?? agg.set(ak, { sessionIds: new Set(), lines: 0 }).get(ak)!
    a.sessionIds.add(o.sessionId); a.lines++
    o.project = nv
    return JSON.stringify(o)
  })

  if (agg.size === 0) return []
  const tmp = join(dirname(path), `.history.jsonl.tmp-${process.pid}`)
  writeFileSync(tmp, out.join('\n'), { mode: 0o600 })
  const st = statSync(path)
  if (st.size !== guard.size || st.mtimeMs !== guard.mtime) {
    rmSync(tmp, { force: true })
    throw new Error('history.jsonl 在对账期间被修改,请关闭所有 Claude 后重试')
  }
  renameSync(tmp, path)
  return [...agg].map(([k, v]) => {
    const [oldProject, newProject] = k.split(SEP)
    return { oldProject, newProject, sessionIds: [...v.sessionIds], affectedLines: v.lines }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/historyJsonl.test.ts`
Expected: PASS（含 Task 1 共 6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/historyJsonl.ts src/main/core/historyJsonl.test.ts
git commit -m "feat: historyJsonl.applyHistoryRewrite 原子改写+按(sid,oldProject)分组+并发检测中止"
```

---

## Task 3: DB — schema 两表 + 4 个方法

**Files:**
- Modify: `src/main/db/schema.ts:22`（在 snapshot_lines 行后追加）
- Modify: `src/main/db/db.ts`（return 对象内加方法）
- Test: `src/main/db/db.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/db/db.test.ts` 末尾(最后一个 `})` 之前)追加:

```ts
  it('getSessionCwd 按主键返回 cwd,缺失返回 null', () => {
    const { db } = open()  // 复用本文件已有的 open() 帮助函数
    db.upsertSession({ sessionId: 'sx', projectPathAbs: '/p', folderName: '-p', cwd: '/p',
      title: '', firstMessagePreview: '', startedAt: null, lastActivityAt: null,
      messageCount: 0, lineCount: 0, sizeBytes: 0, mtime: 0, gitBranch: null, claudeVersion: null,
      entrypoint: null, isSidechain: false, distinctCwds: [], hasSidecar: false, subagentCount: 0,
      toolResultsBytes: 0, movedFlag: false, lastMoveId: null } as any)
    expect(db.getSessionCwd('sx')).toBe('/p')
    expect(db.getSessionCwd('missing')).toBeNull()
  })

  it('insert/get HistoryRewrite 往返,含旁表 session 集合', () => {
    const { db } = open()
    const id = db.insertHistoryRewrite({ source: 'auto', oldProject: '/a', newProject: '/b', sessionIds: ['s1', 's2'], affectedLines: 3 })
    const rec = db.getHistoryRewrite(id)
    expect(rec.old_project).toBe('/a')
    expect(rec.new_project).toBe('/b')
    expect(rec.affected_lines).toBe(3)
    expect(new Set(rec.session_ids)).toEqual(new Set(['s1', 's2']))
    const all = db.getHistoryRewrites()
    expect(all.map((r: any) => r.id)).toContain(id)
  })
```

> 若本测试文件没有 `open()` 帮助函数,改用文件顶部既有的 db 初始化方式(查看文件开头),并保持与既有用例一致。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/db/db.test.ts`
Expected: FAIL — `getSessionCwd is not a function` 等。

- [ ] **Step 3a: schema 加两表**

`src/main/db/schema.ts` 在 `snapshot_lines` 那行(第 22 行)之后、闭合反引号之前追加:

```sql
CREATE TABLE IF NOT EXISTS history_rewrites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT,
  old_project TEXT, new_project TEXT, affected_lines INTEGER, rewritten_at TEXT);
CREATE TABLE IF NOT EXISTS history_rewrite_sessions (rewrite_id INTEGER, session_id TEXT);
```

- [ ] **Step 3b: db.ts 加 4 个方法**

在 `src/main/db/db.ts` 的 return 对象内(`transaction` 那行之前)加:

```ts
    getSessionCwd(sessionId: string): string | null {
      const r = db.prepare('SELECT cwd FROM sessions WHERE session_id=?').get(sessionId) as { cwd: string } | undefined
      return r ? r.cwd : null
    },
    insertHistoryRewrite(op: { source: string; oldProject: string; newProject: string; sessionIds: string[]; affectedLines: number }): number {
      return this.transaction(() => {
        const r = db.prepare(`INSERT INTO history_rewrites (source,old_project,new_project,affected_lines,rewritten_at)
          VALUES (?,?,?,?,?)`).run(op.source, op.oldProject, op.newProject, op.affectedLines, new Date().toISOString())
        const id = Number(r.lastInsertRowid)
        const stmt = db.prepare('INSERT INTO history_rewrite_sessions (rewrite_id,session_id) VALUES (?,?)')
        op.sessionIds.forEach((s) => stmt.run(id, s))
        return id
      })
    },
    getHistoryRewrite(id: number): any {
      const row = db.prepare('SELECT * FROM history_rewrites WHERE id=?').get(id) as any
      if (!row) return null
      const sids = db.prepare('SELECT session_id FROM history_rewrite_sessions WHERE rewrite_id=?').all(id) as { session_id: string }[]
      return { ...row, session_ids: sids.map((s) => s.session_id) }
    },
    getHistoryRewrites(): any[] {
      return (db.prepare('SELECT * FROM history_rewrites ORDER BY id DESC').all() as any[]).map((row) => {
        const sids = db.prepare('SELECT session_id FROM history_rewrite_sessions WHERE rewrite_id=?').all(row.id) as { session_id: string }[]
        return { ...row, session_ids: sids.map((s) => s.session_id) }
      })
    },
```

> 注:`this.transaction` 引用同对象的 transaction 方法。若 lint 对 `this` 在对象字面量里有意见,改为内联 `db.transaction(() => { ... })()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/db/db.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/db/schema.ts src/main/db/db.ts src/main/db/db.test.ts
git commit -m "feat: DB 增 history_rewrites(+旁表)与 getSessionCwd/insert/get 方法"
```

---

## Task 4: sources/appState — historyJsonlPath 注入

**Files:**
- Modify: `src/main/sources.ts:7-14`（Source 接口）, `:28-37`（sourceFromClaudeHome）
- Modify: `src/main/appState.ts:58`（Env）, `:61-64`（getEnv）
- Test: `src/main/sources.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/sources.test.ts` 合适位置追加(参照文件内既有对 detectSources/sourceFromClaudeHome 的断言风格):

```ts
import { detectSources } from './sources'
it('每个 source 含由 claudeHome 派生的 historyJsonlPath', () => {
  for (const s of detectSources()) {
    expect(s.historyJsonlPath).toMatch(/\.claude[\/\\]history\.jsonl$/)
    // 与 projectsRoot 同源(同一 .claude 父目录)
    expect(s.historyJsonlPath.replace(/history\.jsonl$/, 'projects')).toBe(s.projectsRoot)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/sources.test.ts`
Expected: FAIL — `historyJsonlPath` undefined。

- [ ] **Step 3a: Source 接口加字段**

`src/main/sources.ts` 的 `Source` 接口(第 7-14 行)在 `trashRoot` 后加:

```ts
  historyJsonlPath: string
```

- [ ] **Step 3b: sourceFromClaudeHome 派生**

同文件 `sourceFromClaudeHome`(第 28-37 行)的返回对象内,`trashRoot` 行后加:

```ts
    historyJsonlPath: join(claudeHome, '.claude', 'history.jsonl'),
```

- [ ] **Step 3c: Env + getEnv 透传**

`src/main/appState.ts` 第 58 行 `Env` 接口改为:

```ts
export interface Env { db: Db; projectsRoot: string; claudeJsonPath: string; trashRoot: string; historyJsonlPath: string }
```

第 61-64 行 `getEnv` 的 return 改为:

```ts
  return { db: dbFor(s.id), projectsRoot: s.projectsRoot, claudeJsonPath: s.claudeJsonPath, trashRoot: s.trashRoot, historyJsonlPath: s.historyJsonlPath }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/sources.test.ts && npx tsc --noEmit`
Expected: 测试 PASS;tsc 无新错误。

- [ ] **Step 5: 提交**

```bash
git add src/main/sources.ts src/main/appState.ts src/main/sources.test.ts
git commit -m "feat: Source/Env 增 historyJsonlPath,随活动源派生(支持多源)"
```

---

## Task 5: historyReconciler — planReconcile

**Files:**
- Create: `src/main/core/historyReconciler.ts`
- Test: `src/main/core/historyReconciler.test.ts`

判定基准:优先 `env.db.getSessionCwd(sid)`;未命中回退 `findSessionFile(env.projectsRoot, sid)` + 流式读首个 cwd。逐行核对该 sid 全部行的 project 分布。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../db/db'
import { planReconcile } from './historyReconciler'

let dir: string, db: Db
const histPath = () => join(dir, 'history.jsonl')
const projectsRoot = () => join(dir, 'projects')
function env() { return { db, projectsRoot: projectsRoot(), historyJsonlPath: histPath() } as any }
// 在索引里登记一个会话的真实 cwd(模拟已 refresh)
function indexSession(sid: string, cwd: string) {
  db.upsertSession({ sessionId: sid, projectPathAbs: cwd, folderName: '-x', cwd, title: '', firstMessagePreview: '',
    startedAt: null, lastActivityAt: null, messageCount: 0, lineCount: 0, sizeBytes: 0, mtime: 0, gitBranch: null,
    claudeVersion: null, entrypoint: null, isSidechain: false, distinctCwds: [], hasSidecar: false, subagentCount: 0,
    toolResultsBytes: 0, movedFlag: false, lastMoveId: null } as any)
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rec-')); mkdirSync(projectsRoot(), { recursive: true }); db = openDb(join(dir, 'i.db')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('planReconcile', () => {
  it('history.project 与会话 cwd 不符 → ops', () => {
    indexSession('s1', '/new/p')
    writeFileSync(histPath(), '{"project":"/old/p","sessionId":"s1"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 's1', oldProject: '/old/p', newProject: '/new/p' }))
    expect(plan.orphans).toHaveLength(0)
    expect(plan.ambiguous).toHaveLength(0)
  })

  it('会话定位不到 → orphans(不动)', () => {
    writeFileSync(histPath(), '{"project":"/x","sessionId":"ghost"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toHaveLength(0)
    expect(plan.orphans).toContainEqual(expect.objectContaining({ sessionId: 'ghost', project: '/x' }))
  })

  it('同 sessionId 多 project → ambiguous(不动)', () => {
    indexSession('s2', '/c')
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s2"}\n{"project":"/b","sessionId":"s2"}\n')
    const plan = planReconcile(env())
    expect(plan.ops).toHaveLength(0)
    expect(plan.ambiguous).toContainEqual(expect.objectContaining({ sessionId: 's2' }))
  })

  it('已对齐则无 ops(幂等)', () => {
    indexSession('s3', '/p')
    writeFileSync(histPath(), '{"project":"/p","sessionId":"s3"}\n')
    expect(planReconcile(env()).ops).toHaveLength(0)
  })

  it('空串 project → ambiguous', () => {
    indexSession('s4', '/p')
    writeFileSync(histPath(), '{"project":"","sessionId":"s4"}\n')
    const plan = planReconcile(env())
    expect(plan.ambiguous).toContainEqual(expect.objectContaining({ sessionId: 's4' }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: FAIL — 模块/函数不存在。

- [ ] **Step 3: 实现 planReconcile**

```ts
import { readFileSync } from 'node:fs'
import { readHistory, applyHistoryRewrite, type ApplyOp, type RewriteOp } from './historyJsonl'
import { findSessionFile } from './mover'
import type { Db } from '../db/db'

export interface ReconEnv { db: Db; projectsRoot: string; historyJsonlPath: string }
export interface PlanOp { sessionId: string; oldProject: string; newProject: string; lineNos: number[] }
export interface ReconcilePlan {
  ops: PlanOp[]
  orphans: Array<{ sessionId: string; project: string; lineNos: number[] }>
  ambiguous: Array<{ sessionId: string; projects: string[]; lineNos: number[] }>
  guard: { size: number; mtime: number }
}

// 取会话真实归属 cwd:优先 DB 主键点查;未命中回退文件系统流式读首个 cwd。定位不到返回 null。
function resolveCwd(env: ReconEnv, sid: string): string | null {
  const fromDb = env.db.getSessionCwd(sid)
  if (fromDb) return fromDb
  const found = findSessionFile(env.projectsRoot, sid)
  if (!found) return null
  return firstCwdOf(found.jsonl)
}

function firstCwdOf(jsonl: string): string | null {
  // 仅在 DB 未命中时的回退路径(正常对账前已 refresh,DB 命中,不走这里)。
  // 同步整读以保持 planReconcile 同步;若担心 100MB+ 会话 jsonl,可改为同步读取文件前缀字节再 split。
  for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line) continue
    try { const o = JSON.parse(line); if (typeof o.cwd === 'string') return o.cwd } catch { /* skip */ }
  }
  return null
}

// 默认对齐:以会话 jsonl 真实首个 cwd 为准,逐 sessionId 判定。
export function planReconcile(env: ReconEnv): ReconcilePlan {
  const h = readHistory(env.historyJsonlPath)
  const bySid = new Map<string, { projects: Map<string, number[]> }>()
  for (const rec of h.lines) {
    const p = rec.parsed
    if (!p || typeof p.sessionId !== 'string') continue
    const proj = typeof p.project === 'string' ? p.project : ''
    const e = bySid.get(p.sessionId) ?? bySid.set(p.sessionId, { projects: new Map() }).get(p.sessionId)!
    ;(e.projects.get(proj) ?? e.projects.set(proj, []).get(proj)!).push(rec.lineNo)
  }

  const plan: ReconcilePlan = { ops: [], orphans: [], ambiguous: [], guard: { size: h.size, mtime: h.mtime } }
  for (const [sid, { projects }] of bySid) {
    const distinct = [...projects.keys()]
    const allLines = distinct.flatMap((p) => projects.get(p)!)
    // 多 project 值,或含空串 → ambiguous(列出不动)
    if (distinct.length > 1 || distinct.some((p) => p === '')) {
      plan.ambiguous.push({ sessionId: sid, projects: distinct, lineNos: allLines }); continue
    }
    const oldProject = distinct[0]
    const cwd = resolveCwd(env, sid)
    if (cwd === null) { plan.orphans.push({ sessionId: sid, project: oldProject, lineNos: allLines }); continue }
    if (cwd === oldProject) continue // 已对齐
    plan.ops.push({ sessionId: sid, oldProject, newProject: cwd, lineNos: allLines })
  }
  return plan
}
```

> 实现提示:`firstCwdOf` 是 DB 未命中时的回退,保持 planReconcile 同步。`resolveCwd` 正常路径走 `db.getSessionCwd`(同步主键点查),故对账前先 refresh 一次即可避免回退到整读 jsonl。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/historyReconciler.ts src/main/core/historyReconciler.test.ts
git commit -m "feat: historyReconciler.planReconcile 以 jsonl cwd 为准,多值/孤儿/空串分流"
```

---

## Task 6: historyReconciler — planForce

**Files:**
- Modify: `src/main/core/historyReconciler.ts`
- Test: `src/main/core/historyReconciler.test.ts`

强制覆盖:指定 sessionId 集合全部对齐到 targetPath,按实际旧 project 分组成 ops,不产生 orphans/ambiguous。

- [ ] **Step 1: 追加失败测试**

```ts
import { planForce } from './historyReconciler'
describe('planForce', () => {
  it('把指定会话的行按实际旧 project 分组,全部指向 targetPath', () => {
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s"}\n{"project":"/b","sessionId":"s"}\n{"project":"/z","sessionId":"other"}\n')
    const plan = planForce(env(), ['s'], '/target')
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 's', oldProject: '/a', newProject: '/target' }))
    expect(plan.ops).toContainEqual(expect.objectContaining({ sessionId: 's', oldProject: '/b', newProject: '/target' }))
    expect(plan.ops.some((o) => o.sessionId === 'other')).toBe(false) // 未指定的不动
  })
  it('已等于 targetPath 的行不产生 op', () => {
    writeFileSync(histPath(), '{"project":"/target","sessionId":"s"}\n')
    expect(planForce(env(), ['s'], '/target').ops).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: FAIL — `planForce is not a function`。

- [ ] **Step 3: 实现 planForce**

在 `historyReconciler.ts` 追加:

```ts
// 强制覆盖:把给定 sessionId 的行,按其行内实际旧 project 分组,全部对齐到 targetPath。
export function planForce(env: ReconEnv, sessionIds: string[], targetPath: string): ReconcilePlan {
  const want = new Set(sessionIds)
  const h = readHistory(env.historyJsonlPath)
  const groups = new Map<string, number[]>() // key: sid\0oldProject
  for (const rec of h.lines) {
    const p = rec.parsed
    if (!p || typeof p.sessionId !== 'string' || !want.has(p.sessionId)) continue
    const proj = typeof p.project === 'string' ? p.project : ''
    if (proj === targetPath) continue
    const k = p.sessionId + ' ' + proj
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(rec.lineNo)
  }
  const ops: PlanOp[] = [...groups].map(([k, lineNos]) => {
    const [sessionId, oldProject] = k.split(' ')
    return { sessionId, oldProject, newProject: targetPath, lineNos }
  })
  return { ops, orphans: [], ambiguous: [], guard: { size: h.size, mtime: h.mtime } }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/historyReconciler.ts src/main/core/historyReconciler.test.ts
git commit -m "feat: historyReconciler.planForce 强制覆盖到指定路径,按旧 project 分组"
```

---

## Task 7: historyReconciler — executeReconcile

**Files:**
- Modify: `src/main/core/historyReconciler.ts`
- Test: `src/main/core/historyReconciler.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
import { executeReconcile } from './historyReconciler'
import { readFileSync } from 'node:fs'
describe('executeReconcile', () => {
  it('执行 plan.ops 改写并落 DB 记录', () => {
    indexSession('s1', '/new')
    writeFileSync(histPath(), '{"project":"/old","sessionId":"s1"}\n')
    const plan = planReconcile(env())
    const ops = executeReconcile(env(), plan, 'auto')
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/new"')
    expect(ops).toContainEqual(expect.objectContaining({ oldProject: '/old', newProject: '/new', affectedLines: 1 }))
    const recs = db.getHistoryRewrites()
    expect(recs[0]).toMatchObject({ source: 'auto', old_project: '/old', new_project: '/new', affected_lines: 1 })
    expect(recs[0].session_ids).toContain('s1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: FAIL — `executeReconcile is not a function`。

- [ ] **Step 3: 实现 executeReconcile**

在 `historyReconciler.ts` 追加:

```ts
// 执行 plan:对 ops 调原子改写(用 plan.guard 做并发检测),把每个聚合 RewriteOp 落一条 history_rewrites。
export function executeReconcile(env: ReconEnv, plan: ReconcilePlan, source: 'auto' | 'force'): RewriteOp[] {
  const applyOps: ApplyOp[] = plan.ops.map((o) => ({ sessionId: o.sessionId, oldProject: o.oldProject, newProject: o.newProject }))
  const result = applyHistoryRewrite(env.historyJsonlPath, applyOps, plan.guard)
  for (const op of result) {
    env.db.insertHistoryRewrite({ source, oldProject: op.oldProject, newProject: op.newProject, sessionIds: op.sessionIds, affectedLines: op.affectedLines })
  }
  return result
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/historyReconciler.ts src/main/core/historyReconciler.test.ts
git commit -m "feat: historyReconciler.executeReconcile 原子改写+落 history_rewrites 记录"
```

---

## Task 8: historyReconciler — undoRewrite

**Files:**
- Modify: `src/main/core/historyReconciler.ts`
- Test: `src/main/core/historyReconciler.test.ts`

undo 复用 applyHistoryRewrite:传入反向 op `(sessionId, oldProject=记录 new_project, newProject=记录 old_project)`。apply 的"行内 project===oldProject"匹配天然实现"仅改当前仍等于 new_project 的行"。

- [ ] **Step 1: 追加失败测试**

```ts
import { undoRewrite } from './historyReconciler'
import { statSync } from 'node:fs'
describe('undoRewrite', () => {
  it('把记录的 new_project 行改回 old_project', () => {
    writeFileSync(histPath(), '{"project":"/new","sessionId":"s1"}\n')
    const id = db.insertHistoryRewrite({ source: 'auto', oldProject: '/old', newProject: '/new', sessionIds: ['s1'], affectedLines: 1 })
    undoRewrite(env(), id)
    expect(readFileSync(histPath(), 'utf8')).toContain('"project":"/old"')
  })

  it('auto→undo 往返:project 值复原(同 sessionId A/B 两组各自还原)', () => {
    indexSession('s', '/c')
    writeFileSync(histPath(), '{"project":"/a","sessionId":"s"}\n{"project":"/b","sessionId":"s"}\n')
    // 直接 force 把 A、B 都压到 /c,产生两条记录
    const fplan = planForce(env(), ['s'], '/c')
    executeReconcile(env(), fplan, 'force')
    expect(readFileSync(histPath(), 'utf8').match(/\/c/g)).toHaveLength(2)
    // 逆序 undo 两条记录,各自还原
    for (const rec of db.getHistoryRewrites()) undoRewrite(env(), rec.id)
    const after = readFileSync(histPath(), 'utf8')
    expect(after).toContain('"project":"/a"')
    expect(after).toContain('"project":"/b"')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: FAIL — `undoRewrite is not a function`。

- [ ] **Step 3: 实现 undoRewrite**

在 `historyReconciler.ts` 追加:

```ts
// 撤销一条 history_rewrites:把该次涉及的会话中,当前 project 仍等于 new_project 的行改回 old_project。
// 复用 applyHistoryRewrite 的 (sessionId,行内 project===oldProject) 匹配 → 反向 op 的 oldProject 即记录的 new_project。
export function undoRewrite(env: ReconEnv, rewriteId: number): RewriteOp[] {
  const rec = env.db.getHistoryRewrite(rewriteId)
  if (!rec) throw new Error('对账记录不存在')
  const h = readHistory(env.historyJsonlPath)
  const ops: ApplyOp[] = (rec.session_ids as string[]).map((sid) => ({
    sessionId: sid, oldProject: rec.new_project, newProject: rec.old_project,
  }))
  return applyHistoryRewrite(env.historyJsonlPath, ops, { size: h.size, mtime: h.mtime })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/historyReconciler.test.ts`
Expected: PASS（含前序共约 10 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/historyReconciler.ts src/main/core/historyReconciler.test.ts
git commit -m "feat: historyReconciler.undoRewrite 反向改写复原 project 值"
```

---

## Task 9: IPC + preload 接线

**Files:**
- Modify: `src/main/ipc.ts`（import + 4 个 handler）
- Modify: `src/preload/index.ts`（4 个方法）

此层靠现有 E2E 冒烟(Playwright)与手动验证覆盖,不强加 ipcMain 单测。

- [ ] **Step 1: ipc.ts 加 import 与 handler**

在 `src/main/ipc.ts` 顶部 import 区加:

```ts
import { planReconcile, planForce, executeReconcile, undoRewrite } from './core/historyReconciler'
```

在 `registerIpc()` 内、`trash:purge` handler 之后加:

```ts
  ipcMain.handle('history:plan', () => planReconcile(getEnv() as any))
  ipcMain.handle('history:reconcile', (_e, mode: 'auto' | 'force', sessionIds?: string[], target?: string) => {
    const env = getEnv() as any
    const plan = mode === 'force' ? planForce(env, sessionIds ?? [], target ?? '') : planReconcile(env)
    const result = executeReconcile(env, plan, mode)
    return { result, rewrites: env.db.getHistoryRewrites() }
  })
  ipcMain.handle('history:listRewrites', () => getEnv().db.getHistoryRewrites())
  ipcMain.handle('history:undoRewrite', (_e, id: number) => { const env = getEnv() as any; undoRewrite(env, id); return env.db.getHistoryRewrites() })
```

- [ ] **Step 2: preload 加方法**

在 `src/preload/index.ts` 的 `api` 对象内(`purgeTrash` 后)加:

```ts
  planHistory: () => ipcRenderer.invoke('history:plan'),
  reconcileHistory: (mode: 'auto' | 'force', sessionIds?: string[], target?: string) => ipcRenderer.invoke('history:reconcile', mode, sessionIds, target),
  listHistoryRewrites: () => ipcRenderer.invoke('history:listRewrites'),
  undoHistoryRewrite: (id: number) => ipcRenderer.invoke('history:undoRewrite', id),
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 无错;所有单测 PASS。

- [ ] **Step 4: 手动验证(Electron)**

```bash
npm run dev
```
在渲染层 DevTools console 执行:
```js
await window.api.planHistory()      // 应返回 { ops, orphans, ambiguous, guard }
```
Expected: 返回结构正确,ops/orphans/ambiguous 为数组;无报错。

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat: 接线 history:plan/reconcile/listRewrites/undoRewrite IPC + preload"
```

---

## 自检结果(作者对照 spec)

- **spec §4 多源**:Task 4 注入 historyJsonlPath。✓
- **spec §5 模块**:Task 1-2(historyJsonl)、Task 5-8(historyReconciler)。✓
- **spec §6 判定(DB 优先/orphan/ambiguous/空 cwd)**:Task 5。✓
- **spec §7 写回(分组/并发检测/字节透传)**:Task 2。✓
- **spec §8 DB 表 + undo 值匹配**:Task 3 + Task 8。✓
- **spec §9 接线**:Task 4(env)+ Task 3(db)+ Task 9(ipc/preload)。✓
- **spec §11 测试矩阵**:文件不存在(T1)、损坏行(T1/T2)、并发检测中止(T2)、多 project/空串 ambiguous(T5)、幂等(T5)、force(T6)、undo 分组往返(T8)。✓
- **未覆盖(留待 UI 后续计划)**:spec §10 UI 面板、self-referential 与多源 fixture 的端到端断言(逻辑层已由 resolveCwd/per-source env 保证,E2E 阶段补冒烟)。

类型一致性:`ApplyOp`/`RewriteOp`(historyJsonl)、`ReconEnv`/`PlanOp`/`ReconcilePlan`(historyReconciler)、db 方法名(`getSessionCwd`/`insertHistoryRewrite`/`getHistoryRewrite`/`getHistoryRewrites`)在各 Task 间一致。
