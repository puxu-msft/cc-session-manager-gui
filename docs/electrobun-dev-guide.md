# Electrobun + Bun 双运行时 — 开发辅助 / 调试笔记

> 来源:Phase 0 Spike 实测(2026-06-18,WSL2+WSLg / Bun 1.3.14)。面向 Phase 1–3 实现者与后续维护者,记录 Electrobun 在本项目/本环境的踩坑、判据与解法,避免重复试错。
> 关联:`docs/superpowers/spike-results/2026-06-17-phase0.md`、`spike/`、`spike/electrobun-app/run-spike.sh`。

## 1. Electrobun 真实 API 速查(与官方文档/直觉的差异)

实测纠正了若干凭文档/直觉容易写错的点:

| 你可能会写 | 实际正确写法 | 现象 |
|---|---|---|
| `BrowserWindow.defineRPC(...)` | **`BrowserView.defineRPC(...)`** | 写 BrowserWindow 抛 `TypeError: not a function` |
| `import Electroview from 'electrobun/view'`(default) | **`import { Electroview } from 'electrobun/view'`**(命名) | default 导入拿到 undefined |
| `electrobun launch` | **`electrobun dev`** 或运行 build 产物 `build/dev-linux-x64/<app>/bin/launcher` | 无 `launch` 子命令 |
| preload + contextBridge 注入 `window.api` | **渲染侧 `new Electroview({ rpc })` 自行 adapter**;无 preload/contextBridge | — |
| `evaluateJavascriptWithResponse` 回读 DOM | 此版本返回 undefined,**不可靠** | 自动化校验改用 RPC 回传 |

- RPC schema 形态:`BrowserView.defineRPC({ maxRequestTime, handlers: { requests, messages } })`,共享类型 `{ bun: RPCSchema<...>, webview: RPCSchema<...> }`;request 项用 `{ params, response }`;message handler 支持 `"*"` 通配。
- 四向通信:浏览器↔Bun 各有 request(请求-响应)与 send(单向)。主→渲染推送用 `win.webview.rpc.send.<name>(payload)`。
- config 字段:`build.bun.entrypoint` + `build.views.<name>.entrypoint` + `build.copy`(静态资源→`views/`)+ 逐平台 `bundleCEF`(WSL 用 `false` 即可,native webkit 够用)。资源运行时用 `views://<name>/index.html` 引用。
- view 的 HTML 引用 **编译产物** `index.js`(源 `index.tsx`,由 Electrobun 内部 `Bun.build` 打包)。
- `electrobun --help` 不打印用法(只触发下载 CLI 二进制);子命令靠 `init`(交互式,19 模板)/源码确认。**`init` 交互式选择用管道喂值不可靠**,需手动或参考已生成模板。

## 2. WSL / WSLg 下起窗调试

**无法目视时,如何判定"起窗成功"(程序化判据):**
- 看到日志 `=== GTK EVENT LOOP STARTED ===`。
- 进程 spawn 出 `WebKitWebProcess` 和 `WebKitNetworkProcess` 子进程(`ps`/进程树可见)= WebKitGTK 真正初始化并加载 view。
- launcher 进程**存活满 timeout**(对照:初始化失败时 1 秒内 `exit 1`)。
- 用 `timeout 20 <launcher>` 包裹运行并捕获 stdout/stderr 做判断。

**常见非致命警告(WSLg 下可忽略,不阻塞窗口):**
- `libEGL warning: DRI3 error`、`X11 Error: GLXBadWindow (170)` —— WSLg 无 GPU 加速、回退软件渲染所致。对会话管理类 UI 无实质影响。

**截图困境(留证手段):**
- 本环境 `grim`/`gnome-screenshot`/`import`/`scrot`/`xwd` 多缺失;`xwd` 抓 X11 root 报 `BadMatch on X_GetImage`——因 GTK 窗口走 **Wayland** 后端、不在 XWayland root 上(WSLg 架构)。
- 故起窗成功的证据以 **RPC 回传 + 子进程 + GTK 日志** 程序化替代目视截图。

## 3. appindicator 依赖链(起窗硬前置)

**症状**:起窗时 Electrobun 原生包装层 `libNativeWrapper.so` 加载失败。
**根因**:它硬链系统托盘库 `libayatana-appindicator3.so.1`(及 indicator3 / ido3 / dbusmenu-glib / dbusmenu-gtk3 链),WSL 最小镜像默认不带。
**解法**:
- 开发机(有 root):`sudo apt install libayatana-appindicator3-1`(连同依赖)。
- 无 root:`apt-get download <pkg>` → `dpkg-deb -x` 解包到本地池 → `LD_LIBRARY_PATH` 注入(连同 Electrobun 自带 `bin/libasar.so`)。完整脚本见 `spike/electrobun-app/run-spike.sh`。
- 打包 / CI:必须把该依赖链纳入运行环境清单,否则用户端起窗即失败。

## 4. 无法目视时的验证方法论(探针程序化证据)

> 本节是 CLAUDE.md「工程纪律 · 验证要看真实信号」原则在 Electrobun 场景的具体落地(抽象原则以 CLAUDE.md 为真相源,此处只给本场景做法)。

Phase 0 的核心经验:GUI/交互无法目视时,**让被测对象把结果回传到可观测通道**,用程序化信号替代肉眼:
- React 是否真在 WebKit 内渲染并交互 → 由 `useEffect` 触发一次 RPC `request`,主进程终端打印带时间戳的结构化响应(如 `pong:hi` + `ts`)即同时证明"渲染 + 交互 + 通信"三件事。
- worker/子进程是否真起 → 看 `postMessage` 回传 + 进程树。
- 每个探针自打印 `PASS`/`FAIL` 并以退出码 0/1 收口,便于串接与复跑。
- **controller 独立复核**:关键/CRITICAL 项(如 zstd-napi)由调度方亲自重跑一遍,不只信执行者回报。

## 5. bun:sqlite 迁移注意(Phase 1 driver 用)

- 用 `new Database(path, { strict: true })` 让命名参数绑定 key **不带前缀**,贴近 better-sqlite3 习惯;SQL 里 `@name` 占位仍可用。
- `.pragma()` 不存在 → 用 `db.query('PRAGMA ...').get()/.all()`;`PRAGMA table_info(...)` 可作结果集查询返回行(`hasColumn`/schema 迁移依赖此)。
- `db.exec(SCHEMA_SQL)` 支持多语句建表脚本。
- `db.transaction(fn)` 返回包装函数,`tx()` 调用;闭包内可同步读 `.run().lastInsertRowid`(`insertHistoryRewrite` 等依赖)。
- 文件库 `PRAGMA journal_mode = WAL` 返回 `{journal_mode:'wal'}`;macOS 系统 SQLite 的 `-wal/-shm` 不自动清,跨平台一致需 close 前 `wal_checkpoint(TRUNCATE)`(本环境 Linux 未触发)。
- boolean→0/1 转换**只在 repository 层**做,driver 透传,避免双重转换。

## 5.5 Bun.build 打包 native 模块(.node)会崩溃 —— 修正 Phase 0 认知

Phase 0 的 `probe-zstd.ts` 用 `bun run` 验证 `zstd-napi` 可用,但那是**外部 node_modules 加载**。生产 Electrobun 用 **`Bun.build` 把代码打进 bundle**,此时把 `.node`(N-API binding)模块打进 bundle 会在加载期崩溃。

- 即:`bun run`(外部原生模块)≠ `Bun.build`(打进 bundle)。**N-API 原生模块不能进 Bun bundle。**
- 影响:`src/main/core/tarPack.ts` 依赖的 `zstd-napi` 在 electrobun 打包下不可用,归档/快照(`archive:*`)通道当前被 `zstdStub.ts` 顶掉、调用即抛错。
- **这推翻了"两运行时共用 zstd-napi、Compressor 抽象不必要"的判断**(spec §7 曾据 Phase 0 `bun run` 结论 YAGNI 掉 Compressor)。Phase 3 须二选一:
  1. **抽 `Compressor` 契约**(运行时无关),Electron 用 zstd-napi,Electrobun 用 Bun 原生 `Bun.zstdCompressSync`/`Bun.zstdDecompressSync`(或 external 标记 + 运行时从 node_modules 加载,但分发复杂)。**跨运行时归档须同格式可互读(.zst),不得用异格式。**
  2. 同理排查其它 native 依赖(better-sqlite3 已用 bun:sqlite 替代,无此问题)。
- 一般规则:**任何 `.node`/N-API 依赖在 Electrobun 侧都要有 Bun 原生替代或 external 方案**,不能假设 `bun run` 可用就等于打包可用。

## 6. 探针复跑

```bash
# 纯 Bun 探针(项目根)
bun run spike/probe-sqlite.ts
bun run spike/probe-worker.ts
bun run spike/probe-zstd.ts
bun run spike/probe-fsmove.ts
bun run spike/probe-paths.ts

# Electrobun 最小应用(需先满足 §3 appindicator 前置)
cd spike/electrobun-app && ./run-spike.sh   # 或 bunx electrobun build && 运行 build 产物 launcher
```

## 7. Phase 3 实现结论(运行时对等)

Phase 3 让 Electrobun 与 Electron 功能对等。三处关键解法与实测结论:

### 7.1 zstd:用 Bun 内置 node:zlib(标准格式,与 zstd-napi 互读)— GO

- 推翻 §5.5 的「需抽 Compressor 契约或 Bun.zstd*」担忧:Bun 1.3.14 内置 `node:zlib` 的 `createZstdCompress`/`createZstdDecompress`(Node 22.15+/23.8+ 的 zstd 流式),产出**标准 zstd 格式**。
- `src/main/platform/electrobun/zstdShim.ts` 用它实现与 zstd-napi 兼容的 `CompressStream`(构造接受 `{compressionLevel, enableLongDistanceMatching, nbWorkers}`)/`DecompressStream`,均为 node:stream Transform,可直接进 `core/tarPack.ts` 的 pipeline。`core/tarPack.ts` 零改动,仅 `electrobun.config.ts` 的 onResolve 把 `zstd-napi` 顶成 zstdShim。
- **跨运行时互读实测 GO(字节级一致、压缩产物等大)**:zstd-napi(Electron)压 → node:zlib(Electrobun)解 OK;反向 OK。
- 实现要点:node:zlib 的 zstd 流自带正确背压,**不要手工桥接背压**(易死锁);用「构造函数返回底层流对象替换 this」的方式包装,零额外背压代码。

### 7.2 扫描 worker:独立预构建 bundle(避免端口冲突)

- electrobun build 只打包单一 `bun.entrypoint`,不产独立 worker chunk。
- **self-referential worker(worker 复用主 bundle)实测 NO-GO**:worker 线程加载主 bundle 时会连带执行 electrobun 框架顶层副作用,在 **50000 端口起 RPC server**,与主进程 server 冲突(已用端口探针证实 worker 线程监听 50000)。
- **解法(GO)**:`scripts/build-electrobun-worker.mjs` 用 `Bun.build` 把 `src/bun/scanWorker.ts` 预构建成**不含 electrobun** 的自包含 `scanWorker.js`(~7KB,0 处 server 代码),经 `electrobun.config.ts` 的 `build.copy` 拷到 `Resources/app/bun/scanWorker.js`(与 index.js 同目录);`ElectrobunScanRunner` 以 `import.meta.dir + 'scanWorker.js'` 定位加载。`bun:build`/`bun:dev` 已串上 `bun:build:worker` 预构建步骤。
- 实测:独立 worker 完整扫真实 5.7GB/1338 jsonl,141 progress + done,13 projects/141 sessions,worker 不开 50000 端口。

### 7.3 渲染端 RPC 超时:必须设 maxRequestTime

- `Electroview.defineRPC` 的请求超时**默认仅 1000ms**,会让 `refresh:run`/`refresh:project`/`archive:*` 等长任务在 1s 后抛 `RPC request timed out`。
- `src/renderer/main.electrobun.tsx` 已设 `maxRequestTime: 60000`,与 bun 侧 `BrowserView.defineRPC` 对齐。

## 8. 打包 / 分发清单(Linux)

Electrobun build 产物结构:`build/<channel>-linux-x64/<app>/`,内含 `bin/`(launcher + bun + libNativeWrapper.so + libasar.so)、`lib/`、`Resources/app/`(bun/index.js + bun/scanWorker.js + views/)。

分发到用户端必须保证以下运行环境,否则起窗即失败:

1. **appindicator 依赖链(§3 的硬前置,起窗必需)** —— `libNativeWrapper.so` 硬链系统托盘库。用户端需安装或随包附带:
   - `libayatana-appindicator3.so.1`(及 `.1.0.0`)
   - `libayatana-indicator3.so.7`、`libayatana-ido3-0.4.so.0`
   - `libdbusmenu-glib.so.4`、`libdbusmenu-gtk3.so.4`
   - `libappindicator3.so.1`
   - 开发机:`sudo apt install libayatana-appindicator3-1`(自动拉齐依赖);无 root:`apt-get download` + `dpkg-deb -x` 解包到本地池 + `LD_LIBRARY_PATH` 注入(见 `spike/electrobun-app/run-spike.sh`)。
2. **webkit2gtk-4.1 + gtk-3 运行库** —— 本环境已装齐;最小镜像需补 `libwebkit2gtk-4.1-0`。
3. **scanWorker.js 必须随产物分发** —— 由 `bun:build:worker` 预构建并 copy 进 `Resources/app/bun/`,否则刷新功能(worker 扫描)在用户端不可用。CI 须在 `electrobun build` 前先跑 `bun run bun:build:worker`(`npm run bun:build` 已包含此顺序)。
4. **CI 打包顺序**:`npm run bun:build`(= `bun:build:worker` → `bunx electrobun build`)。CI 运行环境清单须纳入上述 appindicator + webkit2gtk 依赖链。

## 9. 实测起窗与全链路验证复跑

```bash
# 1. 构建(含 worker 预构建)
npm run bun:build

# 2. 清理可能残留的旧 bun 子进程(它们会占 50000 端口导致新实例 RPC 失败)
ps -ef | grep -E 'Resources/main.js|bin/launcher' | grep -v grep | awk '{print $2}' | xargs -r kill -9

# 3. 注入 appindicator 库池起窗(无目视,看 VIEW PROBE 回传)
BINDIR="$(pwd)/build/dev-linux-x64/cc-session-manager-gui-dev/bin"
setsid bash -c "LD_LIBRARY_PATH='/tmp/appind/libpool:$BINDIR' exec '$BINDIR/launcher'" > /tmp/eb.log 2>&1 < /dev/null &
sleep 50 && grep 'VIEW PROBE received' /tmp/eb.log
```

判据(程序化,WSLg 无法截图):日志含 `GTK EVENT LOOP STARTED`、spawn 出 `WebKitWeb/NetworkProcess` 子进程、`VIEW PROBE received: {ok:true, ...}`。Phase 3 实测全链路回传:`sourcesCount=2 | index.projects=14 | checkUpdates ... | refreshProject:ok | archive:snapshot status=done`(archive 经 zstd shim 真压缩真实 jsonl)。

**坑**:残留的旧 bun 子进程(`Resources/main.js`,parented 到非 launcher 的 PID)只杀 launcher 杀不掉,会一直占 50000 端口,导致新实例 RPC server 起不来、渲染连不上、VIEW PROBE 不回传。每次起窗前务必按上面第 2 步清干净。
