# 架构总览(活文档)

> **这是活文档**:描述代码**当前**的样子(基准 commit 见文末),改架构时应同步更新(留档约定见 [CLAUDE.md](../CLAUDE.md))。设计**缘由/取舍**不在此复述,见对应冻结 spec(`docs/superpowers/specs/`)。产品视角的「它怎么工作」见 [README](../README.md)。
>
> 双运行时已落地(v1.0.0):Bun + Electrobun 为默认,Node + Electron 为兼容回退,核心逻辑/渲染层/IPC 契约两者共用、经构建期分流并存。

## 一图速览

```
                     默认: Bun + Electrobun          兼容: Node + Electron
渲染层 (React,同一份)  src/bun/index.ts 入口           src/main/index.ts 入口
 App.tsx 三栏+视图       装配 Electrobun Platform        装配 Electron Platform
 state.ts / components/*          \                      /
        ▲ window.api               ▼                    ▼
        │ (Electron=preload.cjs;    app/bootstrap.ts(运行时无关装配,只写一次)
        │  Electrobun=Electroview     │ setPaths/setDbFactory/registerIpc/createWindow
        │  RPC adapter,同形)         ▼
        └──────────────── platform/contract.ts  七契约 + Platform 聚合
                          ├─ platform/electron/*    ipcMain·BrowserWindow·app·worker_threads·better-sqlite3
                          ├─ platform/electrobun/*  RPC·BrowserView·Bun·独立 worker·bun:sqlite·zstdShim
                          ├─ ipc · appState · refresh · trash · core/**   运行时无关核心
                          └─ db/**  repository(注入 SqliteDriver)
   shared/ (types · constants) 两端共享
```

核心思路:**renderer** 只展示交互,经 `window.api`(IPC 客户端契约)调主进程;主进程把**运行时无关的核心**(bootstrap 装配 + ipc + appState + core + db repository + 渲染层)与**平台专属实现**(`platform/electron/**`、`platform/electrobun/**`)分开,二者经 `platform/contract.ts` 的接口对接;两个入口(`src/main/index.ts` / `src/bun/index.ts`)各装配某一运行时的实现并调同一 `bootstrap`。

## 分层与模块职责

### 运行时契约与装配 `src/main/platform/` + `src/main/app/` + 两入口

- `platform/contract.ts` — **运行时抽象的真相源**,定义七个接口:`AppHost`(生命周期=Electron `app`)、`WindowHost`(建窗=`BrowserWindow`+preload / `BrowserView`;`ElectronWindowHost` 另暴露 `getMainWindow()` 供 updater 推事件)、`BridgeServer`(IPC 服务端;handler 签名 `(ctx, ...args)`,`ctx.emit` 单向回推)、`Paths`(`userData()`)、`ScanRunner`(后台扫描,进度走 `onProgress` 回调)、`SqliteDriver`(`prepare/exec/pragma/transaction/close`)、`UpdaterHost`(应用版本自动更新=Electron `electron-updater`;Electrobun 不传,自带 bsdiff 机制)。`Platform` 把一套实现聚合为 `{appHost, windowHost, bridge, paths, dbFactory, scanRunner?, updater?}`(`dbFactory:(file)=>Db` 由各运行时提供 DB 工厂;`scanRunner`/`updater` 可选——Electron 注入 updater 走 electron-updater,Electrobun 省略二者用默认/自带机制)。核心装配只依赖这些接口。
- `platform/electron/` — Electron 实现:`app.ts`(`ElectronAppHost`)、`window.ts`(`ElectronWindowHost`,preload 指向 `index.cjs`,暴露 `getMainWindow()`)、`bridge.ts`(`ElectronBridge`:`ipcMain.handle` + 经 `event.sender` 回推)、`paths.ts`(`electronPaths`=`app.getPath`)、`scanRunner.ts`(`ElectronScanRunner`:`worker_threads`)、`updater.ts`(`ElectronUpdaterHost`:隔离 `electron-updater`,事件转 `AppUpdateEvent` 经主窗口 `webContents.send('app:update')` 推送——autoUpdater 事件无调用方上下文故不复用绑 `event.sender` 的 `ctx.emit`;`checkForUpdates` 仅 `app.isPackaged` 生效)。
- `platform/electrobun/` — Electrobun/Bun 实现:`app.ts`/`window.ts`(`BrowserWindow`+`BrowserView`;建窗时取 `bridge.buildRPC()` 并 `attachWindow`,使 `ctx.emit` 经 `win.webview.rpc.send` 回推)、`bridge.ts`(`ElectrobunBridge`:`BrowserView.defineRPC`)、`paths.ts`(`electrobunPaths`,自拼复刻同一物理路径)、`scanRunner.ts`(`ElectrobunScanRunner`,加载独立预构建 worker bundle)、`sqliteDriver.ts`(`BunSqliteDriver`,`bun:sqlite` strict)、`zstdShim.ts`(`node:zlib` 的 zstd 流)、`rpcSchema.ts`(共享 RPC 类型)。
- `src/bun/` — Electrobun 侧源:`index.ts`(入口,basename 必须为 `index`——launcher 硬编码加载 `bun/index.js`)、`scanWorker.ts`(独立扫描 worker 源,预构建为不含 electrobun 的 bundle)。
- `app/bootstrap.ts` — **运行时无关装配**(只写一次):`setName` → `whenReady` 后 `setPaths`/`setDbFactory`/`registerIpc`/`createMainWindow` → `onWindowAllClosed`/`onBeforeQuit`(中断扫描 + 关库)。两入口各传入自己的 `Platform`。
- 入口 — `src/main/index.ts`(Electron:装 `ElectronAppHost/WindowHost/Bridge/electronPaths/openDb`)与 `src/bun/index.ts`(Electrobun:装 `Electrobun*` + `dbFactory`=bun:sqlite 包进共享 `createRepository` + `ElectrobunScanRunner`),除装配外无逻辑差异,共享 `bootstrap` 与全部核心。

### 主进程编排层 `src/main/`(运行时无关胶水,薄)

- `ipc.ts` — **IPC 契约服务端**:`registerIpc(bridge: BridgeServer, runner?: ScanRunner, updater?: UpdaterHost)`,全部通道经注入的 `bridge.handle('<channel>', (ctx, …args) => …)` 注册(不依赖 electron);进度经 `ctx.emit('refresh:progress', …)`;`scanRunner` 可注入(默认 `ElectronScanRunner`);启动即 `reconcile`/`archiverReconcile` 收尾 pending。通道含 sources/index/sessions、`refresh:run`、`refresh:project`(单项目刷新)、`check:updates`(**会话数据**更新检测)、`app:update:install`(**应用版本**自动更新触发安装重启,经注入的 `updater`——与 check:updates 语义无关,命名空间区分)、move/trash/history/archive 各操作。
- `appState.ts` — 多源运行环境:`getEnv()` 返回当前活动源的 `Env`(独立 `Db` + 该源 projects/claude.json/trash/archive/backups 路径);每源一套 `index-<id>.db`;userData 路径经注入的 `Paths`(`setPaths`)、DB 创建经注入的 `dbFactory`(`setDbFactory`),**不再直接依赖 electron 或 better-sqlite3**;含旧单库 `index.db → index-local.db` 与项目改名(见 `migrateRename.ts`)两类一次性迁移。
- `sources.ts` — 数据源探测与模型:一个源=一套某家目录下的 `.claude`,带三个正交不变量 `osFamily`(OS 家族,承载「Windows→Windows、posix→posix」移动规则;不可由 anchor 推导——Windows-反向源经 `/mnt/c` 但 osFamily=windows)+ `fsAnchor`(物理文件系统身份:本机=claudeHome、远程 WSL=`\\wsl.localhost\<distro>`,rename 技术安全)+ `claudeHomeCwd`(POSIX 会话视角,供自引用守卫/reRoot)。两个方向:**WSL 内**反向探测 Windows 侧(经 `cmd.exe` 取 `%USERPROFILE%`/扫 `/mnt/c/Users`);**Windows host 上**(`detectWslSourcesFromWindows`,经 `sources:refresh` 异步触发,不在同步启动路径)枚举运行中的 WSL2 发行版(`wsl --list --verbose`,UTF-16LE)、`wsl --exec` 探默认用户 HOME(UTF-8,回退枚举 `/home/*` 防 root 漏源)、经 UNC `\\wsl.localhost` 读;`buildWslSources` 纯函数三分(unc 原名/id sanitized 恒带 hash 去碰撞/label)。设计见 `specs/2026-06-22-wsl-source-from-windows-host-design.md`。
- `refresh.ts` — `applyScanToIndex(db, scan, existing)`:刷新落库的**纯函数**(算 diff → 事务内 upsert/删除),供 IPC 与集成测试共用(逻辑与 UI 分离的范例)。
- `scanWorker.ts` — Electron 的 `worker_threads` 扫描线程入口(由 `ElectronScanRunner` 拉起);Electrobun 用独立预构建的 `src/bun/scanWorker.ts`。
- `trash.ts` — 回收区占用统计与单条/全部清理。
- `migrateRename.ts` — 项目改名(cc-move-session → cc-session-manager-gui)的一次性数据迁移:把旧 app 名 userData 里的 `index-*.db`、以及 `~/.claude/.cc-move-{trash,archive,backups}` 目录搬到新名,并重写库中存储的绝对 `backup_path`/`trash_path` 前缀(undoRestore 读 backup_path;trash/archive 路径由当前 root 派生,故主要靠目录 rename)。由 `appState.dbFor` 启动时按源幂等调用。

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
- `tarPack.ts` — 归档打包:`tar` + `zstd`(Electron 用 zstd-napi 流式 level19+多线程+LDM;Electrobun 经 onResolve 换 `zstdShim.ts`/node:zlib,产物标准 `.zst` 跨运行时互读;本文件两运行时零改动)。

### 数据层 `src/main/db/`(repository 模式 + 注入式 driver)

- `db.ts` — **薄壳**:`openDb(file)` = `createRepository(new BetterSqliteDriver(file))`,即 Electron 入口经 `Platform.dbFactory` 注入的 DB 工厂;并 re-export `createRepository` 与 `Db`/`SessionRow`/`MoveInsert` 类型,保持旧 `import { openDb } from './db/db'` 调用点零改动。
- `repository.ts` — `createRepository(driver: SqliteDriver)`:领域 repository,**只依赖 `SqliteDriver` 接口、不得 import 任何具体驱动**;所有 SQL 与查询方法集中于此;含 `WAL`、按 `SCHEMA_VERSION` 的增量 schema 迁移(`hasColumn` 检测 + `ALTER TABLE RENAME COLUMN`)。
- `driver.ts` — `BetterSqliteDriver implements SqliteDriver`:**生产代码里唯一 import `better-sqlite3` 的地方**(对称地,`bun:sqlite` 只出现在 `platform/electrobun/sqliteDriver.ts`)。
- `schema.ts` — `SCHEMA_VERSION`(当前 3)与 `SCHEMA_SQL`(全表 DDL)。
- `rowMap.ts` — DB 行 ↔ 领域对象(`SessionRowShape`)映射;boolean↔0/1 转换只在此层做。

### preload / renderer / shared

- `preload/index.ts`(**Electron 专属**)— `contextBridge.exposeInMainWorld('api', …)` 暴露 `window.api`,逐方法 `ipcRenderer.invoke('<channel>')` + `onRefreshProgress` 订阅 + `onUpdateEvent`(订阅 `app:update`)/`installUpdate`(应用版本自动更新);`Api` 类型与 `window.api` 全局声明的真相源在此(shared 不反向依赖 preload;Electrobun 渲染入口构造同形对象对齐它,其 `onUpdateEvent`/`installUpdate` 为 no-op——electrobun 自带 bsdiff 不接 electron-updater)。**必须打成 `.cjs`**(见记忆 `docs/memory/electron-preload-cjs-under-type-module.md`)。
- `renderer/`(两运行时共用同一份 `App.tsx`/`state.ts`/组件)— 两个入口:`main.tsx`+`index.html`(Electron,经 preload 的 `window.api`)、`main.electrobun.tsx`+`index.electrobun.html`(Electrobun,把 `Electroview` 的 RPC 包成与 `window.api`(`Api` 形)**同形**的 adapter 挂到 `window.api`,使 App 零改动复用;含 `maxRequestTime:60000`)。`App.tsx` 编排三栏(`DirectoryPane` 项目 / `SessionPane` 会话 / `FsBrowserPane` 目标目录)+ `MoveBar` + `ConfirmModal` + `HistoryView`/`HistoryReconcileView`/`ArchiveTimelineView` 三视图;`state.ts` 的 `useAppState` 持客户端态(含订阅 `app:update` 的应用版本更新事件 `appUpdate` + `installUpdate`,顶部更新提示条「有新版/下载中/可安装」);`lib/reconcileView.ts` 视图纯逻辑。
- `shared/` — 两端共享契约:`types.ts`(`SessionMeta`/`ProjectMeta`/`MovePreview`/各 `*Result`/进度/`AppUpdateEvent`(应用版本自动更新事件)等 IPC 载荷类型)、`constants.ts`(活跃判定阈值 `LIVE_MTIME_THRESHOLD_MS`、快照行大小上限、各路径、claude.json 克隆白名单)。

## 数据模型(SQLite,每源一库 `index-<id>.db`)

schema v3,9 张表:`projects` / `sessions`(索引镜像;真相永远是磁盘 jsonl,库只保证与磁盘一致)、`moves` + `cwd_changes` + `snapshot_lines`(移动记录、每行 cwd 改动、小文件改动行完整快照)、`history_rewrites` + `history_rewrite_sessions`(history.jsonl 对账)、`archive_versions`(快照/归档版本,`compressed_bytes` 不绑压缩算法,由 v2 的 `gz_total_bytes` RENAME 迁移而来)、`restores`(还原记录,带 `phase` 用于崩溃恢复)。

## 构建与运行时分流

- **默认 Electrobun**:`npm run dev`/`build` → `bun run bun:dev`/`bun:build` → 先 `scripts/build-electrobun-worker.mjs` 预构建独立扫描 worker,再 `bunx electrobun dev/build`。
- **兼容 Electron**:`npm run dev:electron`/`build:electron`(electron-vite);`pack`/`dist`/`e2e` 仍走 Electron 路径。
- **`electrobun.config.ts`**:`bun.entrypoint=src/bun/index.ts`、`views.mainview.entrypoint=src/renderer/main.electrobun.tsx`、`copy`(html + 预构建 `scanWorker.js`);两个 `Bun.build` 插件——`sharedAlias`(把 `@shared/*` 解析到 `src/shared`,因 Bun.build 不读 tsconfig paths)、`zstdShim`(onResolve 把 `zstd-napi` 换成 `zstdShim.ts`,因 `.node` 原生模块进 Bun bundle 会崩);`release.baseUrl`(GitHub Release 资产基址,自更新拉 `<prefix>-update.json`)+ `generatePatch:false`(纯全量自更新);`app.version` 取自 `package.json`(版本单一真相源,消除手抄漂移)。
- **包管理**:`bun`(`bun.lock` 为锁真相源;`bun install` 实测正确触发 `electron-builder` 把 better-sqlite3 重建为 Electron ABI)。
- **测试**:`npm test` 跑 Electron runner(better-sqlite3 ABI,见 README「原生模块与测试运行时」);`npm run test:bun` 跑 Bun 运行时探针回归。
- 实测踩坑与打包分发清单见 [electrobun-dev-guide.md](electrobun-dev-guide.md)(§5.5 native 模块不能进 bundle、§7 Phase 3 三处解法、§8 Linux 分发清单)。

## 发布与自动更新(Windows,2026-06-22)

双运行时**分层发布**,默认 electrobun;Electron 退为手动覆盖。CI 见 `.github/workflows/build-windows.yml`(electrobun 不跨编译,Windows 产物须在 windows-latest 构建;设计/裁定见 `spike-results/2026-06-22-electrobun-win-packaging.md`)。触发 → 产物:

| 触发 | job | 产物 | 发布 |
|---|---|---|---|
| `workflow_dispatch tier=spike` | `spike` | electrobun 便携 zip | 仅 CI 自检,不发布 |
| push tag `v*` | `electrobun-basic` | 便携 zip(**无**自更新元数据) | `gh release` 逐文件 |
| Release published | `electrobun-full`(默认仅此) | zip + `tar.zst` + `update.json` | `gh release` 逐文件 |
| `workflow_dispatch runtime=electron/both` | `electron-full`(仅手动) | nsis + zip + `latest.yml` + blockmap | electron-builder `--publish always` |

- **自动更新两套**:Electron=`electron-updater`(`platform/electron/updater.ts`,读 `latest.yml`,事件经 `app:update` 推渲染层);Electrobun=自带 bsdiff/全量(`electrobun.config.ts` 的 `release.baseUrl` + `update.json`,当前 `generatePatch:false` 纯全量)。
- **元数据不进聚合包**:分发件只走 Release 资产逐文件上传,更新元数据(`update.json`/`latest.yml`/blockmap)一律独立文件,绝不放进任何聚合压缩包(纠正了旧 CI 把 `release/*` 聚合成单一 artifact 的痛点)。
- **win.target 默认仅 zip**:`package.json` `build.win.target` 去 nsis;完整版 electron 路径 CLI `--win nsis zip` 覆盖加回。
- 待办(follow-up):electrobun win 默认产自解压 `Setup.zip` 而非真 portable,后续改为解压即跑的目录 zip。

## 贯穿全局的约定

- **磁盘 jsonl 为唯一真相**:Claude Code 只读磁盘 jsonl 不读本库;工具职责是保证磁盘与索引一致。
- **运行时无关核心 + 平台实现分离**:核心(bootstrap/ipc/appState/core/repository/渲染层)只依赖 `platform/contract.ts` 接口;两运行时各注入实现;具体 `better-sqlite3`/`bun:sqlite`/`ipcMain`/`BrowserWindow`/`app`/`worker_threads`/`zstd-napi` 都被关在各自的 `platform/<runtime>/` 实现里。
- **逻辑与 UI 分离**:编排/副作用在 main + core 纯函数;handler/组件只做薄胶水,核心逻辑用真实依赖(内存 SQLite)脱 UI 测试(见 CLAUDE.md 工程纪律)。
- **多源隔离**:每数据源独立 DB 与独立回收/归档/备份区。
- **崩溃恢复 = pending + reconcile**:移动/归档/还原先记 `pending`,启动与切源时 `reconcile` 判定补记 done 或回滚 failed。
- **非破坏性**:移动入回收区、还原前现状入 backups、归档库与备份区**默认不自动 GC**,均可撤销/手动清理。
- **不阻塞主进程**:全量扫描在独立 worker;刷新可被新刷新/切源/退出抢占(`terminate`)。

## 关键文件 → 主题(配套 spec)

| 主题 | 代码 | 冻结 spec |
|---|---|---|
| 移动管线 | `core/{pathCodec,cwdRewriter,jsonlScanner,scanner,mover,claudeJson,fsMove}.ts` | `specs/2026-06-15-cc-move-session-design.md` |
| 历史 JSONL 对账 | `core/{historyJsonl,historyReconciler}.ts` | `specs/2026-06-16-history-jsonl-reconciler-design.md` |
| 归档/还原 | `core/{archiver,tarPack}.ts` | `specs/2026-06-17-session-archive-restore-design.md` |
| 双运行时(契约/实现/分流) | `platform/contract.ts`、`platform/{electron,electrobun}/**`、`src/bun/**`、`app/bootstrap.ts`、`db/{repository,driver}.ts`、`electrobun.config.ts` | `specs/2026-06-17-dual-runtime-electrobun-electron-design.md` + [electrobun-dev-guide.md](electrobun-dev-guide.md) |
| 多源 / WSL | `main/{appState,sources}.ts` | README「## 数据源(WSL)」 + `specs/2026-06-22-wsl-source-from-windows-host-design.md` |

---

> 基准:v1.0.0 双运行时已落地 + 改名 `cc-session-manager-gui`(原 `cc-move-session`,2026-06-19,含数据迁移)+ Windows 分层发布(默认 electrobun)与双自动更新接入(electron-updater / electrobun release,2026-06-22)。
