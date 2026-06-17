# 架构总览(活文档)

> **这是活文档**:描述代码**当前**的样子(基准 commit 见文末),改架构时应同步更新(留档约定见 [CLAUDE.md](../CLAUDE.md))。设计**缘由/取舍**不在此复述,见对应冻结 spec(`docs/superpowers/specs/`)。产品视角的「它怎么工作」见 [README](../README.md)。
>
> ⚠️ 运行时解耦重构正在活跃推进中(见 [ROADMAP.md](ROADMAP.md)),`src/main/platform/**` 仍在演进——发现本文与代码不符时,以代码为准并回来更新本文。

## 一图速览

```
渲染进程 (React)        preload 桥           主进程 (运行时无关核心 + 平台实现)
───────────────       ──────────        ─────────────────────────────────────────────
App.tsx 三栏+视图  ─► window.api ─► platform/electron/bridge(ipcMain)─► ipc.ts(BridgeServer)
 state.ts                (.cjs)        │                                   bridge.handle(ctx,…args)
 components/*               ▲          │ index.ts(薄入口)─► app/bootstrap.ts(运行时无关装配)
        ▲ refresh:progress  │          │   ├─ platform/contract.ts  六大运行时契约
        └────── ctx.emit ───┘          │   ├─ platform/electron/*   Electron 实现(已就位)
                                       │   └─ platform/electrobun/* Bun 实现(driver 已落,余待补)
   shared/ (types · constants)         ├─ appState(注入 Paths)/ refresh / scanWorker / trash
   两端共享                             ├─ core/**  纯业务逻辑(脱 UI 可测)
                                       └─ db/**    repository(注入 SqliteDriver)
```

核心思路:**renderer** 只展示交互,经 preload 的 `window.api`(IPC 客户端契约)调主进程;主进程把**运行时无关的核心**(bootstrap 装配 + ipc + appState + core + db repository)与**平台专属实现**(`platform/electron/**`、将来 `platform/electrobun/**`)分开,二者经 `platform/contract.ts` 的接口对接;`index.ts` 只负责装配某一运行时的实现并启动。

## 分层与模块职责

### 运行时契约与装配 `src/main/platform/` + `src/main/app/`

- `platform/contract.ts` — **运行时抽象的真相源**,定义六个接口:`AppHost`(生命周期=Electron `app`)、`WindowHost`(建窗=`BrowserWindow`+preload)、`BridgeServer`(IPC 服务端=`ipcMain.handle`+`sender.send`;handler 签名 `(ctx, ...args)`,`ctx.emit` 单向回推)、`Paths`(`userData()`=`app.getPath`)、`ScanRunner`(后台扫描=`worker_threads`,进度走 `onProgress` 回调)、`SqliteDriver`(`prepare/exec/pragma/transaction/close`)。`Platform` 把一套实现聚合为 `{appHost, windowHost, bridge, paths, dbFactory}` 交给 bootstrap(`dbFactory: (file)=>Db` 由各运行时提供其 DB 工厂)。核心装配只依赖这些接口。
- `platform/electron/` — Electron 实现:`app.ts`(`ElectronAppHost`)、`window.ts`(`ElectronWindowHost`,preload 指向 `index.cjs`)、`bridge.ts`(`ElectronBridge`:`ipcMain.handle` + 经 `event.sender` 回推)、`paths.ts`(`electronPaths`)、`scanRunner.ts`(`ElectronScanRunner`:worker_threads)。
- `platform/electrobun/` — Electrobun/Bun 实现:`sqliteDriver.ts`(`BunSqliteDriver`,`bun:sqlite`,strict 模式)**已写**;app/window/bridge/scanRunner 的 Electrobun 实现待补。
- `app/bootstrap.ts` — **运行时无关装配**(只写一次):`setName` → `whenReady` 后 `setPaths`/`setDbFactory`/`registerIpc`/`createMainWindow` → `onWindowAllClosed`/`onBeforeQuit`(中断扫描 + 关库)。Electron 与 Electrobun 各传入自己的 `Platform` 实现。
- `index.ts` — **薄入口**:装配 Electron 的 `Platform` 实现并调 `bootstrap(...)`。Electrobun 入口将以同样方式装配其实现,共享 bootstrap 与全部核心。

### 主进程编排层 `src/main/`(运行时无关胶水,薄)

- `ipc.ts` — **IPC 契约服务端**:`registerIpc(bridge: BridgeServer)`,全部通道经注入的 `bridge.handle('<channel>', (ctx, …args) => …)` 注册(不再直接依赖 electron);进度经 `ctx.emit('refresh:progress', …)`;启动即 `reconcile`/`archiverReconcile` 收尾 pending;持一个 `ElectronScanRunner` 跑扫描、`terminate()` 即中断。
- `appState.ts` — 多源运行环境:`getEnv()` 返回当前活动源的 `Env`(独立 `Db` + 该源 projects/claude.json/trash/archive/backups 路径);每源一套 `index-<id>.db`;userData 路径经注入的 `Paths`(`setPaths`)、DB 创建经注入的 `dbFactory`(`setDbFactory`,Electron 注入 `openDb`),**不再直接依赖 electron 或 better-sqlite3**;含旧单库 `index.db → index-local.db` 一次性迁移。
- `sources.ts` — 数据源探测:一个源=一套某家目录下的 `.claude`;WSL 下探测 Linux 侧 + Windows 侧(经 `cmd.exe` 取 `%USERPROFILE%`,失败则扫 `/mnt/c/Users`)两套,各自独立。
- `refresh.ts` — `applyScanToIndex(db, scan, existing)`:刷新落库的**纯函数**(算 diff → 事务内 upsert/删除),供 IPC 与集成测试共用(逻辑与 UI 分离的范例)。
- `scanWorker.ts` — `worker_threads` 扫描线程入口(由 `ElectronScanRunner` 拉起)。
- `trash.ts` — 回收区占用统计与单条/全部清理。

### 核心业务逻辑 `src/main/core/`(纯函数,不依赖 Electron/IPC,独立单测)

- `pathCodec.ts` — 项目文件夹名(绝对路径的有损编码)与前缀重定位;真实路径只来自 jsonl 内 `cwd`。
- `jsonlScanner.ts` — 流式解析会话 `.jsonl` 提取 `SessionMeta`(标题/预览/计数/sidecar 等)。
- `scanner.ts` — 扫描聚合为项目/会话 + 计算索引 `diff`(增量刷新依据)。
- `cwdRewriter.ts` — **只改写结构化 cwd 字段**(顶层 `cwd` 与嵌套 `attachment.response.cwd` 做 `<源>/x → <目标>/x` 前缀重定位),消息正文/工具输出绝不触碰。
- `fsMove.ts` — 安全文件迁移:`rename` 入回收区、搬 `<sessionId>/` sidecar 子树(subagents 改写 cwd,其余原样)、symlink 保真。
- `claudeJson.ts` — 按白名单(`CLAUDE_JSON_CLONE_ALLOWLIST`)克隆 `~/.claude.json` 的 `projects` 条目并原子写。
- `mover.ts` — 移动管线:`previewMove`(预检:活跃/碰撞/自指阻断)、`executeMove`、`reconcile`(崩溃后收尾 pending)、`undoMove`(撤销)。
- `historyJsonl.ts` / `historyReconciler.ts` — `history.jsonl` 项目引用对账:`planReconcile`/`planForce` → `executeReconcile` → `undoRewrite`。
- `archiver.ts` — 快照/归档/还原:`snapshotSession`/`archiveSession`/`restoreVersion`/`undoRestore`/`deleteVersion`/`listVersions`/`archiveUsage`/`archiverReconcile`(同会话多版本时间线;还原前现状入 backups 安全网)。
- `tarPack.ts` — 归档打包:`tar` + `zstd`(zstd-napi 流式,level 19 + 多线程 + LDM)。

### 数据层 `src/main/db/`(repository 模式 + 注入式 driver)

- `db.ts` — **薄壳**:`openDb(file)` = `createRepository(new BetterSqliteDriver(file))`,即 Electron 入口经 `Platform.dbFactory` 注入的 DB 工厂;并 re-export `createRepository` 与 `Db`/`SessionRow`/`MoveInsert` 类型,保持旧 `import { openDb } from './db/db'` 调用点零改动。
- `repository.ts` — `createRepository(driver: SqliteDriver)`:领域 repository,**只依赖 `SqliteDriver` 接口、不得 import 任何具体驱动**;所有 SQL 与查询方法集中于此;含 `WAL`、按 `SCHEMA_VERSION` 的增量 schema 迁移(`hasColumn` 检测 + `ALTER TABLE RENAME COLUMN`)。
- `driver.ts` — `BetterSqliteDriver implements SqliteDriver`:**生产代码里唯一 import `better-sqlite3` 的地方**(对称地,`bun:sqlite` 只出现在 `platform/electrobun/sqliteDriver.ts`)。
- `schema.ts` — `SCHEMA_VERSION`(当前 3)与 `SCHEMA_SQL`(全表 DDL)。
- `rowMap.ts` — DB 行 ↔ 领域对象(`SessionRowShape`)映射;boolean↔0/1 转换只在此层做。

### preload / renderer / shared

- `preload/index.ts` — `contextBridge.exposeInMainWorld('api', …)` 暴露 `window.api`,逐方法 `ipcRenderer.invoke('<channel>')` + `onRefreshProgress` 订阅;`Api` 类型与 `window.api` 全局声明的真相源都在此(shared 不反向依赖 preload)。**必须打成 `.cjs`**(见记忆 `docs/memory/electron-preload-cjs-under-type-module.md`)。
- `renderer/` — React:`main.tsx` 挂载;`App.tsx` 编排三栏(`DirectoryPane` 项目 / `SessionPane` 会话 / `FsBrowserPane` 目标目录)+ `MoveBar` + `ConfirmModal` + `HistoryView`/`HistoryReconcileView`/`ArchiveTimelineView` 三视图;`state.ts` 的 `useAppState` 持客户端态;`lib/reconcileView.ts` 视图纯逻辑。
- `shared/` — 两端共享契约:`types.ts`(`SessionMeta`/`ProjectMeta`/`MovePreview`/各 `*Result`/进度等 IPC 载荷类型)、`constants.ts`(活跃判定阈值 `LIVE_MTIME_THRESHOLD_MS`、快照行大小上限、各路径、claude.json 克隆白名单)。

## 数据模型(SQLite,每源一库 `index-<id>.db`)

schema v3,9 张表:`projects` / `sessions`(索引镜像;真相永远是磁盘 jsonl,库只保证与磁盘一致)、`moves` + `cwd_changes` + `snapshot_lines`(移动记录、每行 cwd 改动、小文件改动行完整快照)、`history_rewrites` + `history_rewrite_sessions`(history.jsonl 对账)、`archive_versions`(快照/归档版本,`compressed_bytes` 不绑压缩算法,由 v2 的 `gz_total_bytes` RENAME 迁移而来)、`restores`(还原记录,带 `phase` 用于崩溃恢复)。

## 贯穿全局的约定

- **磁盘 jsonl 为唯一真相**:Claude Code 只读磁盘 jsonl 不读本库;工具职责是保证磁盘与索引一致。
- **运行时无关核心 + 平台实现分离**:核心(bootstrap/ipc/appState/core/repository)只依赖 `platform/contract.ts` 接口;Electron/Electrobun 各注入实现;具体 `better-sqlite3`/`bun:sqlite`/`ipcMain`/`BrowserWindow`/`app`/`worker_threads` 都被关在各自的 `platform/<runtime>/` 实现里。
- **逻辑与 UI 分离**:编排/副作用在 main + core 纯函数;handler/组件只做薄胶水,核心逻辑用真实依赖(内存 SQLite)脱 UI 测试(见 CLAUDE.md 工程纪律)。
- **多源隔离**:每数据源独立 DB 与独立回收/归档/备份区。
- **崩溃恢复 = pending + reconcile**:移动/归档/还原先记 `pending`,启动与切源时 `reconcile` 判定补记 done 或回滚 failed。
- **非破坏性**:移动入回收区、还原前现状入 backups、归档库与备份区**默认不自动 GC**,均可撤销/手动清理。
- **不阻塞主进程**:全量扫描在 worker;刷新可被新刷新/切源/退出抢占(`terminate`)。

## 双运行时改造现状

抽象缝**已落地**:`AppHost`/`WindowHost`/`BridgeServer`/`Paths`/`ScanRunner`/`SqliteDriver` 六契约定义于 `platform/contract.ts`,Electron 侧实现全部就位,`index.ts` 经 `bootstrap` 装配 `Platform`(含 `dbFactory`);`BunSqliteDriver`(bun:sqlite)已写,DB 工厂也已注入化(`Platform.dbFactory`,Electron 入口注入 `openDb`/better-sqlite3)。**尚未做**:Electrobun 侧 `AppHost`/`WindowHost`/`BridgeServer`/`ScanRunner` 实现与入口(提供 bun:sqlite 版 `dbFactory`)、构建期运行时分流(按运行时选择装配哪套 `Platform`;当前 `index.ts` 即写死的 Electron 入口)。进度与下一步见 [ROADMAP.md](ROADMAP.md);设计见双运行时 spec。

## 关键文件 → 主题(配套 spec)

| 主题 | 代码 | 冻结 spec |
|---|---|---|
| 移动管线 | `core/{pathCodec,cwdRewriter,jsonlScanner,scanner,mover,claudeJson,fsMove}.ts` | `specs/2026-06-15-cc-move-session-design.md` |
| 历史 JSONL 对账 | `core/{historyJsonl,historyReconciler}.ts` | `specs/2026-06-16-history-jsonl-reconciler-design.md` |
| 归档/还原 | `core/{archiver,tarPack}.ts` | `specs/2026-06-17-session-archive-restore-design.md` |
| 运行时契约 / 双运行时 | `platform/contract.ts`、`platform/{electron,electrobun}/**`、`app/bootstrap.ts`、`db/{repository,driver}.ts` | `specs/2026-06-17-dual-runtime-electrobun-electron-design.md` |
| 多源 / WSL | `main/{appState,sources}.ts` | README「## 数据源(WSL)」 |

---

> 基准:对准至 `29c9113`(2026-06-18,运行时解耦重构进行中,`platform/**` 仍可能有在途改动)。
