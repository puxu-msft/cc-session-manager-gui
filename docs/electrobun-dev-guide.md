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
