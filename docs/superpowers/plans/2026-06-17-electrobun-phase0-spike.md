# Electrobun 双运行时 — Phase 0 Spike 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一组可运行探针验证 Electrobun + Bun 在本项目 WSL 环境下的 8 项关键可行性,产出每项 PASS/FAIL/FALLBACK 的 go/no-go 决策,作为是否投入 Phase 1–3 抽象层改造的止损闸门。

**Architecture:** 探针分两组。① 纯 Bun 探针(Task 2–6):在项目根用 `bun run` 跑,复用项目现有 `node_modules` 与真实源码(`schema.ts`/`fsMove.ts`/`tarPack.ts`),验证运行时级 API(bun:sqlite、node:worker_threads、zstd-napi、node:fs、路径)。② Electrobun 应用探针(Task 7–8):在隔离子工程 `spike/electrobun-app/` 用官方脚手架起最小应用,验证起窗、React 19 渲染、Bun.build 打包、RPC 双向通信。最后汇总决策(Task 9)。

**Tech Stack:** Bun、Electrobun CLI、bun:sqlite、node:worker_threads、zstd-napi、React 19、TypeScript。

**关联 spec:** `docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md`(§12 Phase 0 探针清单)。

**重要前提:** 本计划只覆盖 Phase 0。Phase 1–3 的详细计划在 Phase 0 结果出来后另写——因为 zstd-napi、worker、打包链的实测结果会实质决定后续 Compressor/ScanRunner/构建的形态,提前写会基于未验证假设。

---

## Task 1: 环境准备与 spike 骨架

**Files:**
- Create: `spike/.gitignore`
- Create: `spike/README.md`

- [ ] **Step 1: 确认 Bun 可用,记录版本**

Run:
```bash
bun --version || (echo "Bun 未安装,执行安装" && curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH" && bun --version)
```
Expected: 打印出 Bun 版本号(如 `1.x.x`)。记录该版本。

- [ ] **Step 2: 记录 Electrobun Linux 系统依赖现状(不强制现在装)**

Run:
```bash
dpkg -l | grep -E 'libwebkit2gtk-4.1|libgtk-3' || echo "缺 webkit2gtk-4.1 / gtk-3 开发库(Task 7 起窗前需:sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev)"
```
Expected: 打印已装列表,或打印缺失提示。记录结果(Task 7 会用到)。

- [ ] **Step 3: 创建 spike 目录骨架与忽略规则**

创建 `spike/.gitignore`:
```gitignore
node_modules/
electrobun-app/node_modules/
electrobun-app/build/
electrobun-app/dist/
*.tmp
```

创建 `spike/README.md`:
```markdown
# Phase 0 Spike

Electrobun 双运行时可行性验证探针。

- `probe-*.ts` — 纯 Bun 探针,在**项目根**运行:`bun run spike/probe-<name>.ts`
- `electrobun-app/` — 最小 Electrobun 应用探针(起窗/React/RPC/Bun.build)
- 结果汇总见 `docs/superpowers/spike-results/2026-06-17-phase0.md`

每个探针自打印 `PASS`/`FAIL` 并以退出码 0/1 表示成败。
```

- [ ] **Step 4: 提交骨架**

```bash
git add spike/.gitignore spike/README.md
git commit -m "chore(spike): Phase 0 探针骨架与忽略规则"
```

---

## Task 2: bun:sqlite 探针(覆盖 spec §9 driver 全部差异点)

**Files:**
- Create: `spike/probe-sqlite.ts`

- [ ] **Step 1: 写探针**

创建 `spike/probe-sqlite.ts`(import 项目真实 schema,逐条验证 §9 的多语句 exec / WAL / PRAGMA-as-query / 命名参数 / 位置参数 / transaction 闭包内 lastInsertRowid):
```ts
// 运行:bun run spike/probe-sqlite.ts(在项目根)
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_SQL, SCHEMA_VERSION } from '../src/main/db/schema'

let pass = true
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) pass = false
}

// strict:true 让命名参数绑定 key 不带前缀,贴近 better-sqlite3 习惯(spec §9.2)
const db = new Database(':memory:', { strict: true })

// 1) 多语句 exec(SCHEMA_SQL 是多条 CREATE 的脚本,spec §9.7)
try { db.exec(SCHEMA_SQL); check('multi-statement exec(SCHEMA_SQL)', true) }
catch (e) { check('multi-statement exec(SCHEMA_SQL)', false, String(e)) }

// 2) PRAGMA table_info 作为结果集查询返回行(spec §9.7,db.ts hasColumn 依赖)
try {
  const cols = db.query('PRAGMA table_info(sessions)').all() as { name: string }[]
  check('PRAGMA table_info as query', Array.isArray(cols) && cols.some((c) => c.name === 'session_id'), `cols=${cols.length}`)
} catch (e) { check('PRAGMA table_info as query', false, String(e)) }

// 3) 命名参数 @name + strict 绑定(对齐 db.ts upsert/insert 的 @xxx 写法)
try {
  db.query('INSERT INTO meta (schema_version) VALUES (@v)').run({ v: SCHEMA_VERSION })
  const got = db.query('SELECT schema_version FROM meta LIMIT 1').get() as { schema_version: number }
  check('named param @name (strict)', got?.schema_version === SCHEMA_VERSION, JSON.stringify(got))
} catch (e) { check('named param @name (strict)', false, String(e)) }

// 4) 位置参数 ?(对齐 db.ts insertCwdChanges)
try {
  db.query('INSERT INTO cwd_changes (move_id,file_rel,line_no,old_cwd,new_cwd) VALUES (?,?,?,?,?)').run(1, 'a.jsonl', 2, '/old', '/new')
  const got = db.query('SELECT new_cwd FROM cwd_changes WHERE move_id=?').get(1) as { new_cwd: string }
  check('positional params ?', got?.new_cwd === '/new')
} catch (e) { check('positional params ?', false, String(e)) }

// 5) transaction(fn)() 双重调用 + 闭包内同步读 lastInsertRowid(对齐 db.ts insertHistoryRewrite)
try {
  const insert = db.transaction(() => {
    const r = db.query('INSERT INTO history_rewrites (source,old_project,new_project,affected_lines,rewritten_at) VALUES (?,?,?,?,?)')
      .run('claude.json', '/old', '/new', 5, new Date().toISOString())
    const id = Number(r.lastInsertRowid)
    db.query('INSERT INTO history_rewrite_sessions (rewrite_id,session_id) VALUES (?,?)').run(id, 'sess-1')
    return id
  })
  const id = insert()
  const cnt = db.query('SELECT COUNT(*) AS c FROM history_rewrite_sessions WHERE rewrite_id=?').get(id) as { c: number }
  check('transaction(fn)() + closure lastInsertRowid', id > 0 && cnt?.c === 1, `id=${id}`)
} catch (e) { check('transaction(fn)() + closure lastInsertRowid', false, String(e)) }
db.close()

// 6) WAL 需文件库(内存库无 WAL):新建临时文件库,设 WAL 并回读
try {
  const f = join(mkdtempSync(join(tmpdir(), 'bsql-')), 'wal.db')
  const fdb = new Database(f, { strict: true })
  const mode = fdb.query('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
  check('PRAGMA journal_mode = WAL', mode?.journal_mode === 'wal', JSON.stringify(mode))
  fdb.close()
} catch (e) { check('PRAGMA journal_mode = WAL', false, String(e)) }

console.log(pass ? '\n=== bun:sqlite PROBE: ALL PASS ===' : '\n=== bun:sqlite PROBE: HAS FAIL ===')
process.exit(pass ? 0 : 1)
```

- [ ] **Step 2: 运行探针**

Run: `bun run spike/probe-sqlite.ts`
Expected: 6 行均 `PASS`,末尾 `=== bun:sqlite PROBE: ALL PASS ===`,退出码 0。任一 `FAIL` 记录具体错误(影响 spec §9 driver 可行性)。

- [ ] **Step 3: 提交**

```bash
git add spike/probe-sqlite.ts
git commit -m "test(spike): bun:sqlite 探针(WAL/命名+位置参数/事务闭包 rowid/PRAGMA-as-query/多语句 exec)"
```

---

## Task 3: node:worker_threads 探针(覆盖 spec §12 Phase 0.3)

**Files:**
- Create: `spike/probe-worker-child.ts`
- Create: `spike/probe-worker.ts`

- [ ] **Step 1: 写 worker 子线程脚本**

创建 `spike/probe-worker-child.ts`(复刻 scanWorker 的 workerData + parentPort.postMessage 模式,并保持存活以测 terminate):
```ts
import { parentPort, workerData } from 'node:worker_threads'
parentPort!.postMessage({ type: 'progress', n: (workerData as { n: number }).n })
// 保持存活,验证主线程 terminate() 能中断它
setInterval(() => {}, 1000)
```

- [ ] **Step 2: 写主线程探针**

创建 `spike/probe-worker.ts`:
```ts
// 运行:bun run spike/probe-worker.ts(在项目根)
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

let pass = true
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) pass = false }

const w = new Worker(join(import.meta.dir, 'probe-worker-child.ts'), { workerData: { n: 42 } })
const msg = await new Promise<{ type: string; n: number } | null>((resolve) => {
  const t = setTimeout(() => resolve(null), 3000)
  w.on('message', (m) => { clearTimeout(t); resolve(m) })
  w.on('error', () => { clearTimeout(t); resolve(null) })
})
check('workerData + parentPort.postMessage', msg?.type === 'progress' && msg?.n === 42, JSON.stringify(msg))

const start = Date.now()
await w.terminate()
check('terminate() returns (no hang)', Date.now() - start < 2000)

console.log(pass ? '\n=== worker_threads PROBE: ALL PASS ===' : '\n=== worker_threads PROBE: HAS FAIL (考虑改 Bun Worker fallback) ===')
process.exit(pass ? 0 : 1)
```

- [ ] **Step 3: 运行探针**

Run: `bun run spike/probe-worker.ts`
Expected: 两行 `PASS`,末尾 `ALL PASS`,退出码 0,进程不挂起。若 FAIL,记录并标记 spec §4 #6 需退 Bun 原生 Worker fallback。

- [ ] **Step 4: 提交**

```bash
git add spike/probe-worker.ts spike/probe-worker-child.ts
git commit -m "test(spike): node:worker_threads 在 Bun 的 workerData/postMessage/terminate 探针"
```

---

## Task 4: zstd-napi 探针(覆盖 spec §12 Phase 0.4,CRITICAL)

**Files:**
- Create: `spike/probe-zstd.ts`

- [ ] **Step 1: 写探针(复用项目真实 tarPack,触发 zstd-napi 高级参数)**

创建 `spike/probe-zstd.ts`:
```ts
// 运行:bun run spike/probe-zstd.ts(在项目根,复用根 node_modules 的 zstd-napi 与 tar)
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, packTree, unpackZst, verifyAgainstManifest } from '../src/main/core/tarPack'

const work = mkdtempSync(join(tmpdir(), 'zstd-probe-'))
const srcDir = join(work, 'src')
mkdirSync(srcDir)
writeFileSync(join(srcDir, 'a.jsonl'), 'x'.repeat(200000)) // 触发 LDM/多线程压缩路径
writeFileSync(join(srcDir, 'b.txt'), 'hello world')
symlinkSync('./b.txt', join(srcDir, 'b.link'))            // 验证 symlink 经 manifest 重建保真

const zst = join(work, 'out.zst')
try {
  const manifest = await buildManifest(work, ['src'])
  await packTree(work, ['src'], zst)        // 触发 CompressStream({level:19, LDM:true, nbWorkers:2})
  const dest = join(work, 'dest')
  mkdirSync(dest)
  await unpackZst(zst, dest)                 // DecompressStream
  // symlink 不在 tar 内,需按 manifest 重建后再校验(对齐 archiver 还原流程)
  const { rebuildSymlinks } = await import('../src/main/core/tarPack')
  rebuildSymlinks(dest, manifest)
  const v = await verifyAgainstManifest(dest, manifest)
  console.log(v.ok
    ? 'PASS zstd-napi roundtrip in Bun (level19 / LDM / nbWorkers2 / symlink 保真)'
    : `FAIL zstd-napi roundtrip  mismatches=${JSON.stringify(v.mismatches)}`)
  console.log(v.ok ? '\n=== zstd PROBE: PASS — Compressor 维持 zstd-napi ===' : '\n=== zstd PROBE: FAIL ===')
  process.exit(v.ok ? 0 : 1)
} catch (e) {
  console.log('FAIL zstd-napi 在 Bun 下加载或运行失败:', String(e))
  console.log('=> 触发 spec §7 Compressor fallback 决策:必须选 zstd 兼容格式(WASM/原生 zstd),禁止退化为异格式(gzip)')
  process.exit(1)
}
```

- [ ] **Step 2: 运行探针**

Run: `bun run spike/probe-zstd.ts`
Expected: `PASS zstd-napi roundtrip in Bun ...`,退出码 0。
- 若 PASS:两运行时用同一 zstd-napi、同格式,spec §7 归档互读硬约束天然满足。
- 若 FAIL(N-API 无法加载或 nbWorkers 不工作):记录为 CRITICAL,转入 spec §7 Compressor WASM 选型,并在 Phase 1–3 计划中加"跨运行时 .zst 互读验证"子任务。

- [ ] **Step 3: 提交**

```bash
git add spike/probe-zstd.ts
git commit -m "test(spike): zstd-napi 在 Bun 的加载+高级参数往返+symlink 保真探针"
```

---

## Task 5: node:fs / safeRename 探针(覆盖 spec §12 Phase 0.5)

**Files:**
- Create: `spike/probe-fsmove.ts`

- [ ] **Step 1: 写探针(复用项目真实 safeRename)**

创建 `spike/probe-fsmove.ts`:
```ts
// 运行:bun run spike/probe-fsmove.ts(在项目根)
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRename } from '../src/main/core/fsMove'

let pass = true
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) pass = false }

const work = mkdtempSync(join(tmpdir(), 'fsmove-probe-'))
const a = join(work, 'a')
mkdirSync(a)
writeFileSync(join(a, 'f.txt'), 'hi')
symlinkSync('./f.txt', join(a, 'link'))   // 相对 symlink,验证 lstat 不解引用 + 保真
const b = join(work, 'b')

try {
  safeRename(a, b)
  const movedFile = existsSync(join(b, 'f.txt'))
  const linkSt = lstatSync(join(b, 'link'))
  const linkOk = linkSt.isSymbolicLink() && readlinkSync(join(b, 'link')) === './f.txt'
  const srcGone = !existsSync(a)
  check('safeRename: 文件迁移', movedFile)
  check('safeRename: symlink 保真(lstat 不解引用)', linkOk)
  check('safeRename: 源已移除', srcGone)
} catch (e) { check('safeRename 执行', false, String(e)) }

console.log('NOTE: EXDEV 跨设备 fallback 需两个挂载点,若 WSL 有 /mnt 跨盘可手动验;copyRecursive 仅用 node:fs,已由 symlink 用例间接覆盖')
console.log(pass ? '\n=== fsMove PROBE: ALL PASS ===' : '\n=== fsMove PROBE: HAS FAIL ===')
process.exit(pass ? 0 : 1)
```

- [ ] **Step 2: 运行探针**

Run: `bun run spike/probe-fsmove.ts`
Expected: 三行 `PASS`,退出码 0。FAIL 记录(影响 core 在 Bun 的 node:fs 同步语义假设)。

- [ ] **Step 3: 提交**

```bash
git add spike/probe-fsmove.ts
git commit -m "test(spike): safeRename/symlink/lstat 在 Bun 的 node:fs 同步语义探针"
```

---

## Task 6: Paths.userData 路径相等探针(覆盖 spec §12 Phase 0.6)

**Files:**
- Create: `spike/probe-paths.ts`

- [ ] **Step 1: 写 Electrobun 侧 userData 自拼实现 + 打印**

创建 `spike/probe-paths.ts`:
```ts
// 运行:bun run spike/probe-paths.ts(在项目根)
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'cc-move-session'

// Electrobun 侧将采用的 userData 解析(逐平台复刻 Electron app.getPath('userData') 规则,spec §7 Paths 硬约束)
function electrobunUserData(name: string): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name)
}

const resolved = electrobunUserData(APP_NAME)
console.log('platform        =', process.platform)
console.log('electrobun userData =', resolved)
console.log('对照 Electron(Linux)预期 = ~/.config/cc-move-session(见 Step 2 实测)')
```

- [ ] **Step 2: 取 Electron 侧实测 userData 并比对**

Run(用现有 Electron 打印真实 userData,需 X/WSLg;若 Electron 无法起,退回已知约定):
```bash
ELECTRON_RUN_AS_NODE= node -e "try{const {app}=require('electron');app.setName('cc-move-session');app.whenReady().then(()=>{console.log('electron userData =',app.getPath('userData'));app.quit()})}catch(e){console.log('electron 无法直接取,Linux 约定为 '+require('os').homedir()+'/.config/cc-move-session')}" 2>/dev/null || echo "fallback: $HOME/.config/cc-move-session"
bun run spike/probe-paths.ts
```
Expected: 两路输出的 userData 字符串相等(Linux 下均为 `$HOME/.config/cc-move-session`)。记录是否相等——不等则 spec §7 Paths 硬约束实现需调整自拼规则。

- [ ] **Step 3: 提交**

```bash
git add spike/probe-paths.ts
git commit -m "test(spike): Electrobun userData 自拼与 Electron 路径相等探针"
```

---

## Task 7: 最小 Electrobun 应用 — 起窗 + React 19 + Bun.build(覆盖 spec §12 Phase 0.1 / 0.8)

**Files:**
- Create: `spike/electrobun-app/`(经官方脚手架生成,再改造)

> 本 Task 含人工目视确认(GUI 起窗),非纯自动化。Electrobun 的 config/CLI 以官方脚手架与 `--help` 实际产出为准;React/RPC 业务代码按下方给定。

- [ ] **Step 1: 安装 Electrobun 系统依赖(若 Task 1 Step 2 显示缺失)**

Run:
```bash
sudo apt-get update && sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev
```
Expected: 安装成功。若 WSL 无 sudo 权限,记录阻塞并与用户确认。

- [ ] **Step 2: 用官方脚手架生成最小应用并记录其结构**

Run:
```bash
mkdir -p spike/electrobun-app && cd spike/electrobun-app && bun init -y && bun add electrobun && bunx electrobun --help
```
Expected: 安装成功,打印 Electrobun CLI 可用子命令(预期含 init/build/dev/launch 之类)。**记录实际子命令名**,后续步骤以此为准。若有 `electrobun init` 脚手架,运行它取得可运行模板基线。

- [ ] **Step 3: 写 React 19 视图入口**

在 `spike/electrobun-app/` 安装 React 并创建视图。Run: `cd spike/electrobun-app && bun add react react-dom`

创建 `spike/electrobun-app/src/view/index.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import { useState } from 'react'

function App() {
  const [n, setN] = useState(0)
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1 id="probe-heading">Electrobun + React 19 OK</h1>
      <button id="probe-btn" onClick={() => setN((x) => x + 1)}>count: {n}</button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
```

创建 `spike/electrobun-app/src/view/index.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8" /><title>spike</title></head>
<body><div id="root"></div><script type="module" src="index.tsx"></script></body></html>
```

- [ ] **Step 4: 配置 Electrobun(主进程入口 + view 经 Bun.build 打包)**

创建/改写 `spike/electrobun-app/electrobun.config.ts`(以 Step 2 脚手架生成的字段为基准,确保 `build.views` 指向上面的 `index.tsx`,使 Electrobun 用 Bun.build 打包 React;config 字段名以官方模板为准):
```ts
// 形态参考(以官方脚手架实际字段为准):
// export default {
//   app: { name: 'spike', identifier: 'dev.spike.probe', version: '0.0.1' },
//   build: {
//     bun: { entrypoint: 'src/bun/index.ts' },
//     views: { main: { entrypoint: 'src/view/index.tsx' } },
//     copy: { 'src/view/index.html': 'views/main/index.html' },
//   },
// }
```

创建 `spike/electrobun-app/src/bun/index.ts`(主进程:开窗加载 view;API 以 Task 2 事实核查确认的 electrobun/bun 为准):
```ts
import { BrowserWindow } from 'electrobun/bun'

const win = new BrowserWindow({
  title: 'spike',
  url: 'views://main/index.html',
  frame: { width: 900, height: 600, x: 100, y: 100 },
})
void win
```

- [ ] **Step 5: 构建并启动,人工确认起窗 + React 渲染**

Run(子命令名以 Step 2 实际输出为准,示例):
```bash
cd spike/electrobun-app && bunx electrobun build && bunx electrobun launch
```
Expected(人工目视):
- 窗口在 WSLg 下出现(若黑屏/不出窗 → 记录 WebKitGTK on WSL 失败,转 spec §13 评估 bundled CEF fallback;**这是 Phase 0 最关键的 go/no-go**)。
- 窗口显示标题 "Electrobun + React 19 OK" 与可点击 `count` 按钮,点击数字递增(证明 Bun.build 打包的 React 19 正常渲染与交互)。

记录:起窗成功/失败、是否需 CEF、Bun.build 打 React 是否成功。

- [ ] **Step 6: 提交**

```bash
git add spike/electrobun-app
git commit -m "test(spike): 最小 Electrobun 应用(起窗 + React19 + Bun.build)"
```

---

## Task 8: Electrobun RPC 探针 — 双向通信(覆盖 spec §12 Phase 0.7)

**Files:**
- Modify: `spike/electrobun-app/src/bun/index.ts`
- Modify: `spike/electrobun-app/src/view/index.tsx`

> 验证 spec §8 channel 模型可落地:请求-响应(invoke/handle 等价)+ 单向推送(进度等价)+ 结构化 payload。API 形态依 Task 2 事实核查确认:`defineRPC` + `rpc.request.*` + `rpc.send.*`。

- [ ] **Step 1: 主进程定义 RPC handlers(请求-响应 + 接收单向消息)**

改写 `spike/electrobun-app/src/bun/index.ts`(以官方 defineRPC API 实际签名为准,下为依文档形态):
```ts
import { BrowserWindow } from 'electrobun/bun'

// 请求-响应 handler(等价 ipcMain.handle):回显并加工结构化 payload
// 单向消息 handler(等价 renderer→main 通知)
const rpc = BrowserWindow.defineRPC({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      echo: async ({ text }: { text: string }) => ({ reply: `pong:${text}`, ts: Date.now() }),
    },
    messages: {
      logFromView: ({ msg }: { msg: string }) => { console.log('[main] got message:', msg) },
    },
  },
})

const win = new BrowserWindow({
  title: 'spike-rpc',
  url: 'views://main/index.html',
  frame: { width: 900, height: 600, x: 100, y: 100 },
  rpc,
})

// 主→渲染 单向推送(等价 refresh:progress emitProgress):延迟后发一条
setTimeout(() => { win.webview.rpc?.send.tick({ at: Date.now() }) }, 1500)
```

- [ ] **Step 2: 渲染侧构造 Electroview adapter,调用 RPC 并显示结果**

改写 `spike/electrobun-app/src/view/index.tsx`(验证 renderer 内 adapter 暴露同形调用,对齐 spec §4 #4):
```tsx
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import Electroview from 'electrobun/view'

// 渲染侧 adapter:把 Electroview RPC 包装成 window.api 同形对象(spec §4 #4 / §8)
const ev = new Electroview({
  rpc: Electroview.defineRPC({
    handlers: {
      requests: {},
      messages: { tick: ({ at }: { at: number }) => { window.dispatchEvent(new CustomEvent('probe-tick', { detail: at })) } },
    },
  }),
})

function App() {
  const [reply, setReply] = useState('(未调用)')
  const [tick, setTick] = useState('(未收到)')
  useEffect(() => {
    const h = (e: Event) => setTick(String((e as CustomEvent).detail))
    window.addEventListener('probe-tick', h)
    return () => window.removeEventListener('probe-tick', h)
  }, [])
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1>RPC probe</h1>
      <button id="rpc-btn" onClick={async () => {
        const r = await ev.rpc.request.echo({ text: 'hi' })
        setReply(JSON.stringify(r))
        ev.rpc.send.logFromView({ msg: 'hello-from-view' })
      }}>call echo + send</button>
      <p id="rpc-reply">request reply: {reply}</p>
      <p id="rpc-tick">push tick: {tick}</p>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 3: 构建启动并人工验证三种通信**

Run: `cd spike/electrobun-app && bunx electrobun build && bunx electrobun launch`
Expected(人工目视):
- 启动 ~1.5s 后 `push tick:` 出现时间戳(主→渲染单向推送成功)。
- 点击按钮后 `request reply:` 显示 `{"reply":"pong:hi","ts":...}`(请求-响应 + 结构化 payload 成功)。
- 主进程终端打印 `[main] got message: hello-from-view`(渲染→主单向成功)。

记录三项是否全通。任一失败 → spec §8 channel 模型需调整(如长任务超时改 send 模式、或 adapter 形态变更)。

- [ ] **Step 4: 提交**

```bash
git add spike/electrobun-app/src
git commit -m "test(spike): Electrobun RPC 双向通信探针(request/响应 + 双向单向 + 结构化 payload)"
```

---

## Task 9: 汇总 Phase 0 决策并裁定 go/no-go

**Files:**
- Create: `docs/superpowers/spike-results/2026-06-17-phase0.md`

- [ ] **Step 1: 汇总 8 项探针结果**

收集 Task 2–8 的实际输出(PASS/FAIL/FALLBACK + 关键数据/错误),填入决策表。

创建 `docs/superpowers/spike-results/2026-06-17-phase0.md`:
```markdown
# Phase 0 Spike 结果(2026-06-17)

Bun 版本:<填> / Electrobun 版本:<填> / 平台:WSL2

| # | 探针 | 结果 | 关键数据 / 备注 |
|---|---|---|---|
| 0.1 | Electrobun 起窗(WSLg/WebKitGTK) | PASS/FAIL | 是否需 CEF fallback |
| 0.2 | bun:sqlite(§9 全差异点) | PASS/FAIL | |
| 0.3 | node:worker_threads | PASS/FAIL | 是否需 Bun Worker fallback |
| 0.4 | zstd-napi 在 Bun(高级参数往返) | PASS/FAIL | 失败则 Compressor WASM 选型 |
| 0.5 | safeRename/node:fs 同步语义 | PASS/FAIL | |
| 0.6 | userData 路径相等 | PASS/FAIL | |
| 0.7 | Electrobun RPC 双向 | PASS/FAIL | |
| 0.8 | Bun.build 打 React 19 | PASS/FAIL | |

## 裁定
- 阻断项(0.1 起窗、0.4 压缩):<是否全有可行路径>
- go/no-go:<进入 Phase 1 / 转 fallback 评估 / 止损>
- 对 spec 的回写:<需更新的节,如 §7 Compressor 选型、§4 #6 worker 方案>
```

- [ ] **Step 2: 据结果回写 spec(若有 fallback 选型确定)**

若 0.4/0.3/0.1 触发 fallback,编辑 `docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md` 对应节,把"待定/fallback"改为实测确定的方案。

- [ ] **Step 3: 提交决策**

```bash
git add docs/superpowers/spike-results/2026-06-17-phase0.md docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md
git commit -m "docs(spike): Phase 0 决策汇总与 go/no-go 裁定"
```

- [ ] **Step 4: 决定下一步**

- 全绿或阻断项均有可行 fallback → 编写 Phase 1–3 详细实现计划(基于本次实测的确定方案)。
- 阻断项无解(WSL 起窗 + CEF 均失败,或压缩无兼容格式)→ 触发 spec §16 止损,Electron 维持默认,记录结论。

---

## 自检备注(spec 覆盖核对)

本计划覆盖 spec §12 Phase 0 的全部 8 个探针项:0.1(Task 7)、0.2(Task 2)、0.3(Task 3)、0.4(Task 4)、0.5(Task 5)、0.6(Task 6)、0.7(Task 8)、0.8(Task 7)。Phase 1–3 不在本计划范围,待 Phase 0 裁定后另写。
