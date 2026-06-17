# 双运行时(Electrobun 一等 / Electron 兼容)架构设计 v2

- 状态:草案 v2(已经过一轮三方对抗审查迭代)
- 日期:2026-06-17
- 适用项目:cc-move-session
- 变更要点(相对 v1):新增 zstd-napi 适配面与 Phase 0 探针;更正打包链(Bun.build 而非 vite)、window.api 注入模型(无 preload)、userData 路径(无 API、须自拼对齐);更正 core/ 非"运行时无关"的定性;handler 签名引入进度发射器;新增成功标准与回滚条款。

## 1. 背景与目标

本项目当前基于 Electron 42 + electron-vite + electron-builder,主进程跑在 Node,渲染层 React 19,索引存储用 better-sqlite3,归档压缩用 zstd-napi,后台全量扫描放在 `node:worker_threads`。

目标:把 **Bun + Electrobun** 提升为一等支持并设为默认运行时,**Node + Electron** 降为**长期兼容/回退**支持。二者通过构建期分流与一组抽象契约共存:默认走 Electrobun,除非用户或测试显式指定 Electron。

定位表态:本期采用"**Electrobun 默认 + Electron 长期兼容回退**",不设 Electron 删除日期;但 Electron 路径必须始终保持可用、可一键设回默认(见 §16 回滚条款)。这是双运行时架构的价值兜底。

收益预期(均为待实测验收的假设,见 §15):更小包体(系统 webview,官网宣称 ~14MB)、更快启动(官网宣称 <50ms);并用 `bun:sqlite` 替换 better-sqlite3,消除 sqlite 维度的 native ABI rebuild 痛点。

## 2. 非目标(YAGNI)

- 不追求"同一份产物运行时自动切换运行时"(技术上不可行,见 §3)。
- 不在本期引入 Electrobun 的自更新、Tray、WebGPU 等增量能力;只覆盖现有功能对等所需的适配面。
- 不重写业务逻辑(core/);只做解耦与适配。
- 不为 Electrobun 路径在本期建成熟 e2e 体系(见 §10)。
- **不主张"彻底消除 native 痛点"**:本期仅消除 sqlite 维度;zstd-napi 仍是 native,其在 Bun 下的去留是独立适配面(见 §4 #8、§13)。

## 3. 关键技术约束

Electron 主进程运行于 Node,Electrobun 主进程运行于 Bun。`import 'electron'` 在 Bun 下、`import 'electrobun/bun'` 在 Node 下都会在**模块加载期**即失败;`bun:sqlite` 是 Bun 内置虚拟模块,在 Node 中不存在。

因此双运行时只能是**构建期分流**:打包时选定 target(electrobun 默认 / electron 兼容),代码通过条件入口 + 模块解析选择具体实现,**运行期始终是单一运行时**。这是物理约束。

配套要求:两套 entry 静态分流、绝不在同进程同时 import 对端运行时模块;打包时须把对端运行时模块标记为 external/排除,避免 bundler 在构建期解析到不可用模块(tree-shaking 不保证剔除干净)。

## 4. 平台耦合点清单(改造面)

| # | 耦合点 | 现文件 | Electron 写法 | Electrobun 对应 |
|---|---|---|---|---|
| 1 | app 生命周期 + 窗口 | `src/main/index.ts` | `app` / `BrowserWindow` / `loadFile` | `electrobun/bun` `BrowserWindow`/`BrowserView` + `views://` |
| 2 | 用户数据路径 | `src/main/appState.ts` | `app.getPath('userData')` | **无 userData API,须用 `node:os` 自拼并逐平台复刻 Electron 解析规则** |
| 3 | Bridge 主侧 | `src/main/ipc.ts` | `ipcMain.handle` + `sender.send` | Events / RPC(`defineRPC`,四向:request/send 双模式) |
| 4 | Bridge 渲染侧 | `src/preload/index.ts` | `contextBridge` + `ipcRenderer` | **无 preload/contextBridge;renderer entry 内构造 `Electroview` 并自行 adapter 成同形 `window.api`** |
| 5 | 数据库 | `src/main/db/db.ts` | better-sqlite3 | `bun:sqlite` |
| 6 | 后台扫描 worker | `src/main/scanWorker.ts` + `ipc.ts` | `node:worker_threads` | **优先复用 `node:worker_threads`(Bun 已兼容 workerData/parentPort/terminate);Bun 原生 Worker 作 fallback** |
| 7 | 构建 / 打包 | `electron.vite.config.ts`、`package.json#build` | electron-vite + electron-builder | **electrobun CLI(内部 `Bun.build`,非 vite)+ electron-builder 仍归 Electron 侧** |
| 8 | **压缩(归档)** | `src/main/core/tarPack.ts` → `archiver.ts` | `zstd-napi`(native N-API) | **未知:Bun 能否加载该 N-API;否则改 `Bun.gzip`/zstd WASM,经 `Compressor` 契约抽象** |

**对 core/ 的更正定性**:`src/main/core/` **不是**"运行时无关、零依赖"。它依赖 `node:fs/os/path` 同步子集(如 `archiver.ts`/`mover.ts` 的 `statSync`/`lstatSync`/`renameSync`/`rmSync`)以及 `Db` 的具体形状。Bun 对这些同步 API 的语义对等(尤其 `renameSync` 跨设备、`lstatSync` 对 symlink、原子 rename)是**待 Phase 0 验证**的假设,不能默认"保持不变"。

**确实基本不变**:`src/shared/`(但需先拆 §6 所述对 preload 的反向依赖)、renderer 的 React 组件与 state、仅依赖 `node:fs/os/path` 的轻量模块(sources/refresh/trash);它们随 core 一并接受 Phase 0 的 node:fs 语义验证。

## 5. 架构方针:两套地道实现为主,抽取共享组件辅助

窗口、传输、打包、压缩这些"运行时味道最重"的部分,两套各自用最地道写法;业务 handler、DB 领域逻辑、core、UI 抽为共享,只写一次。

### 5.1 共享组件(只写一次)

- `src/core/`、`src/shared/`:业务逻辑与类型常量。
- **集中式 typed channel 契约** `src/platform/channels.ts`:声明全部 IPC 通道的名字、参数、返回类型,以及**业务 handler 实现本体**。handler 签名为 `(ctx, ...args)`,`ctx` 至少含 `{ env, emitProgress }`,由 bridge 在每次调用时注入(见 §8)。
- **DB 领域 repository** `src/platform/db/repository.ts`:现 `db.ts` 领域方法保留为共享层,底层依赖 `SqliteDriver` 接口。
- renderer/:React 组件全部共享;`window.api` 的**类型**从 channel 契约推导(两套**注入机制**不同,见 §4 #4)。

### 5.2 各自地道实现(两套)

入口+生命周期+窗口、bridge 传输、`Paths`、`SqliteDriver`、`ScanRunner`、`Compressor`、构建打包配置。

### 5.3 防漂移强制规则(新增)

为防止"两套地道"退化成"两套各写"或共享层被某运行时绑架:

- 共享层文件(`core/`、`shared/`、`platform/channels.ts`、`platform/db/repository.ts`)**禁止 import** 任何 `electron`、`electrobun/*`、`better-sqlite3`、`bun:*` 模块,以 import 边界检查在 CI 强制。
- **移除 `Db.raw` 后门**:现 `db.ts` 暴露 `raw: db`(better-sqlite3 原始句柄),且 `ipc.ts` 的 `refresh:run` 直接 `env.db.raw.prepare('SELECT * FROM sessions')`。bun:sqlite 无等价 raw,故该用法须收敛为 repository 的具名方法,共享层不得出现 `.raw`。

## 6. 目录结构(目标)

```
src/
  core/                          业务逻辑(由 src/main/core 迁移;依赖 node:fs 同步子集 + repository 接口)
  shared/                        类型/常量(先拆除对 preload 的反向依赖)
  renderer/                      React UI(基本不变)
  platform/
    channels.ts                  通道契约 + handler 本体(共享)
    contract.ts                  抽象接口(见 §7)
    db/
      repository.ts              共享 DB 领域层(基于 SqliteDriver)
      schema.ts
    electron/  { entry, window, bridge, preload(.cjs), sqliteDriver, scanRunner, compressor, paths }
    electrobun/{ entry, window, bridge, electroview-adapter, sqliteDriver, scanRunner, compressor, paths }
  app/
    bootstrap.ts                 运行时无关装配
```

**迁移期与打包约定(必须显式处理,否则只在运行时炸)**:
- `src/shared/types.ts` 现有 `Window.api` 类型 `import('../preload/index').Api` 是 shared→preload 的反向硬依赖,**Phase 1 第一步先拆**:`window.api` 类型改由 channel 契约推导。
- `__dirname` 相对加载:`ipc.ts` 的 `new Worker(join(__dirname,'scanWorker.js'))`、`index.ts` 的 preload/renderer 路径。Bun/ESM 下无 `__dirname`,用 `import.meta.dir`/`import.meta.url`;Electrobun 的 worker 加载与 `views://` 资源定位是另一套。
- preload 产物扩展名:Electron + `type:module` 下 preload 必须输出 `.cjs`(项目已有此踩坑记录)。两套对 `type` 字段诉求可能不同,构建期分别处理。
- `@shared` 别名当前在 4 处声明(tsconfig + 三处 vite + vitest);目录迁移需同步,且 `src/main/*` 内部全为相对 import,会大面积位移。别名迁移作为 Phase 1 的独立可回归步骤。

## 7. 抽象契约(`platform/contract.ts`)

- `Paths`:`userData(): string`。**硬约束:两套实现必须返回同一物理目录**(Linux `~/.config/<name>`、macOS `~/Library/Application Support/<name>`、Windows `%APPDATA%/<name>`),Electrobun 侧自拼并字节级对齐 Electron `app.getPath('userData')`;Phase 0/2 加路径相等断言。
- `SqliteDriver`:`prepare(sql)` 返回的 statement 须同时支持**命名参数(`@name`)与位置参数(`?` 数组)两种调用风格**(repository 现状混用);`exec(sql)`、`transaction(fn)`(须支持 better-sqlite3 式 `transaction(fn)()` 双重调用 + 闭包内同步读 `lastInsertRowid`)、`pragma(s)`(bun:sqlite 内部翻译为 `run("PRAGMA …")`)、`close()`。boolean→0/1 转换**只在 repository 层发生,driver 透传**(避免双重转换)。
- `ScanRunner`:`run(input, onProgress): Promise<ScanOutcome>`、`terminate()`;保留"未收到 done/error 即被中断 = aborted"语义。
- `Compressor`:`compressStream()` / `decompressStream()`(对齐现 `tarPack.ts` 的 zstd 流式用法);两套实现:Electron=zstd-napi,Electrobun=Bun 原生或 WASM(Phase 0 定夺)。
- `WindowHost`:`createMainWindow(opts)` 仅负责窗口生命周期与 renderer 加载;**bridge/注入接线不塞进此接口**,收敛到 `BridgeServer` + bootstrap,避免职责对半泄漏。
- `AppHost`:`whenReady()`、`onAllWindowsClosed(cb)`(darwin 分支归属在此接口内明确)、`onBeforeQuit(cb)`、`setName(name)`、`quit()`。
- `BridgeServer`:`handle(channel, fn)`、`emit(event, payload)`;为每次 invoke 注入与本次调用绑定的 `emitProgress`。

`bootstrap(platform)`:设 app 名 → 启动 reconcile(mover/archiver pending 收尾)→ 注册全部 channel handler → 创建窗口 → 注册退出收尾(中断扫描 + 关闭 DB)。注:"注册通道"与"启动 reconcile"的时序须保持(现 `registerIpc` 先 reconcile 再注册)。

## 8. Channel 契约(`platform/channels.ts`)

- 单一来源声明全部通道(现 30+ `invoke` 通道 + `refresh:progress` 事件)。
- handler 签名 `(ctx, ...args) => result | Promise<result>`,`ctx = { env, emitProgress }`。**`refresh:progress` 不建模为全局单向事件,而是与本次 `refresh:run` 调用绑定的 `emitProgress` 回调**——它源于 `worker.postMessage → 主进程 → 发起方 sender`,穿透三层且绑定调用方。Electron 经 `event.sender.send` 实现 `emitProgress`,Electrobun 经其 RPC `send` 实现。
- 渲染侧 `window.api` 类型由契约推导。
- Electrobun RPC 注意:`defineRPC` 的 `maxRequestTime` 是 RPC 级超时(示例 5000ms);**逐通道核对最长耗时**,长任务(扫描类)用"立即返回 + emitProgress 推进度"模式,避免被请求超时截断。

## 9. DB:repository over driver

现 `openDb()` 拆为领域 repository(共享)+ `SqliteDriver`(两套)。**driver 层须吸收的 better-sqlite3 ↔ bun:sqlite 差异**:

1. `.pragma()` 不存在于 bun:sqlite → 翻译为 `run("PRAGMA …")`(WAL: `run("PRAGMA journal_mode = WAL")`)。
2. 命名参数:bun:sqlite 支持 `$/:/@`,但默认绑定 key 需带前缀;建议 `new Database(path, { strict: true })` 使绑定 key 不带前缀、贴近 better-sqlite3 习惯。同时支持位置参数 `?` 数组(repository 混用)。
3. `transaction(fn)()` 双重调用 + 闭包内同步读 `lastInsertRowid`(`insertHistoryRewrite`/`insertArchiveVersion` 依赖):须逐一核对 bun:sqlite 事务语义。
4. `lastInsertRowid` 经 `.run()` 返回(两库同名,`Number(...)` 收口)。
5. macOS 用系统 SQLite,WAL `-wal/-shm` sidecar 不自动清;若要跨平台一致,close 前 `PRAGMA wal_checkpoint(TRUNCATE)` + 关闭 persist-wal。
6. `safeIntegers` 默认 false(大整数截断风险,评估 rowid/时间戳)。
- `appState.ts` 多源 DB 管理(`index-<id>.db`、`migrateLegacyLocalDb`)保留,仅把 `openDb` 换成"repository + 注入 driver"。
- **Phase 1 前置**:先消除 `ipc.ts` 中反复出现的 `getEnv() as any`,否则 `Db` 变接口后类型回归不可信。

## 10. 测试策略

- **repository 单测参数化跑两个 driver**(同一套用例,driver 作为 fixture):这是双 driver 的核心回归保险,verify §9 的差异吸收。
- **vitest → bun:test 决策**:现 24 个 `*.test.ts` 均 `from 'vitest'`,bun test 用 `bun:test`,import 源不同、`vi.*` 与 bun `mock/spyOn` 不一致。本期决策:**核心层/repository 测试统一迁到 `bun:test`**(放弃 vitest 复用),Electron 侧若需断言走兼容路径;不假设"无缝复用"。该迁移工作量(24 文件 import + 可能的 mock 改写)记入 Phase 1。
- **Electron 兼容路径**:保留现有 `scripts/test-electron.mjs`(better-sqlite3,Electron ABI)作为兼容回归;迁移 db import 结构时警惕扰动该脆弱 ABI 平衡(`NODE_MODULE_VERSION` 踩坑)。
- **e2e**:本期 Playwright e2e 继续跑 Electron 路径;Electrobun 路径先手动冒烟。

## 11. 构建与切换

- 默认 Electrobun:`bun dev` / `bun run build`,经 electrobun CLI;**renderer 用 `Bun.build` 打包,不复用 vite**——React 19 + 现有 vite 插件链(别名/CSS/资源)迁到 Bun bundler 的等价性须 Phase 0 验证。静态资源经 electrobun config `build.copy` 映射,运行时 `views://` 引用。
- 兼容 Electron:`npm run dev:electron` / `npm run build:electron`,沿用 electron-vite + electron-builder。
- 模块解析:两套 entry 静态 import 各自 platform;打包标记对端运行时模块为 external。
- **包管理双轨**:Electrobun 侧用 `bun install`、Electron 侧 native(better-sqlite3/zstd-napi)依赖 `npm`/electron-builder 的 ABI 处理;明确各自包管理器,避免交叉污染 node_modules / lockfile 双写摩擦。
- 测试矩阵:`bun test`(核心)+ electron runner(兼容)。

## 12. 实现阶段(一个计划,8 面全覆盖,带 gate)

- **Phase 0 — Spike 硬闸门(WSL 实测,全绿才继续)**。探针项:
  1. 起窗 + 加载最小 React 19 页(WebKitGTK;若 WSLg 起窗失败,评估 Electrobun bundled CEF 作为 fallback,而非直接止损)。
  2. `bun:sqlite`:WAL pragma、命名参数、`transaction(fn)()` 闭包内 `lastInsertRowid`、prepare/run/get/all。
  3. `node:worker_threads` 在 Bun 全链路(workerData/parentPort.postMessage/terminate);失败才退原生 Bun Worker。
  4. **`zstd-napi` 在 Bun 下 require + 压缩/解压往返**;失败则定 `Compressor` 替代方案(Bun.gzip/zstd WASM)。
  5. `node:fs` 同步语义对等(`renameSync` 跨设备、`lstatSync` symlink、原子 rename)。
  6. `Paths.userData()` 两运行时解析路径相等。
  7. Electrobun RPC 最小证据:invoke/handle(request)+ 单向 push(send)+ 结构化 payload。
  8. `Bun.build` 打包最小 React 页可在 Electrobun 渲染。
- **Phase 1 — 解耦(不破坏 Electron)**:① 拆 `shared/types.ts` 对 preload 的反向依赖;② 别名迁移(4 处)保持 Electron green;③ 消除 `getEnv() as any`;④ 抽 `contract.ts`/`channels.ts`(handler 改 `(ctx,...args)`)/`db/repository.ts`(移除 `.raw`)/`Compressor`;⑤ Electron platform 实现就位;⑥ Electron 路径全程跑通并通过现有测试/e2e。**接口冻结门**:contract 须基于 Phase 0 实测对照 Electrobun API 走查一遍并标注,再进 Phase 2。
- **Phase 2 — Electrobun 实现**:补齐 electrobun/ 全部 8 面;列表/扫描/移动/归档/还原五条流程端到端冒烟通过;repository 测试在 bun:sqlite driver 下 100% 通过。
- **Phase 3 — 默认切换 + 收尾**:满足 §15 门槛后默认命令切 Electrobun;脚本、测试矩阵、README/文档;Electron 保留为显式兼容回退。

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| WSL 下 WebKitGTK 起窗失败 | 方案不可落地 | Phase 0 硬闸门;失败先评估 bundled CEF fallback,再决定止损 |
| **zstd-napi N-API 在 Bun 不可用** | archive 功能缺失,违背功能对等 | Phase 0 必测;不行则 `Compressor` 改 Bun.gzip/zstd WASM(注意归档格式兼容/迁移) |
| **打包链非 vite(Bun.build)** | renderer 打包要重做,插件链等价性未知 | Phase 0 用 Bun.build 打 React 验证;插件能力缺口逐项补 |
| `node:fs` 同步语义在 Bun 不对等 | 移动/归档原子性/symlink 行为异常 | Phase 0 探针;差异在 core 边界吸收 |
| bun:sqlite 与 better-sqlite3 语义差异 | DB 行为不一致 | driver 吸收(§9 六点)+ repository 测试双 driver 跑 |
| window.api 无 preload 注入 | bridge 渲染侧实现机制不同 | renderer 内 Electroview adapter 包装成同形 api;契约层写明不对称 |
| userData 无 API、落点分裂 | 两运行时用户数据割裂 | Paths 硬约束 + 路径相等断言 |
| **双运行时长期维护/认知负担** | 每个新功能成本近翻倍 | 严格限定"两套"只到 §5.2 七项 + Compressor;防漂移 import 边界 CI 检查 |
| 包管理/lockfile 双轨 | native 安装摩擦 | §11 明确各自包管理器 |
| **Electrobun 弃坑/beta 关键 bug** | 默认运行时不可靠 | §16 回滚:Electron 随时可设回默认 |
| Electrobun 版本定位 | — | 实为 1.18.x 发行版(保留 beta 通道),API 较稳但 Linux/WSL 实战样本少 |
| RPC 表达力 | (已证实成立,降级) | `defineRPC` 四向 + 结构化 payload 原生支持;仅需核 `maxRequestTime` 对长通道 |

## 14. 开放问题(经一轮核查后的剩余未知,留待实测)

1. **WSL/WSLg 下 WebKitGTK 能否起窗**(官方文档零提及)——Phase 0.1。
2. **zstd-napi N-API 在 Bun 能否加载**——Phase 0.4。
3. **Bun.build 对 React 19 + 现有 vite 插件链的等价性**——Phase 0.8。
4. Electrobun RPC `maxRequestTime` 能否逐通道覆盖(文档只见 RPC 级)。
5. bun:sqlite `transaction(fn)()` 闭包内同步 `lastInsertRowid` 的精确语义——Phase 0.2。
6. `node:fs` 同步 API 跨设备 rename/symlink 在 Bun 的精确行为——Phase 0.5。

> 已在审查中证实/证伪、不再是开放问题的:RPC 四向支持(成立)、worker_threads 兼容(成立,优先复用)、bun:sqlite 功能齐全(成立,吸收差异)、无 preload/无 userData API(证伪 v1 假设,已并入 §4/§7)、打包用 Bun.build 非 vite(证伪,已并入 §11)。

## 15. 成功标准(可度量)

- **Phase 0 通过** = §12 八个探针项全绿(任一阻断项失败即止损或转 fallback 评估)。
- **Phase 2 通过** = 五条核心流程在 Electrobun 下手动冒烟通过 + repository 测试在 bun:sqlite driver 下 100% 通过 + 两运行时 userData 路径实测相等。
- **Phase 3 切默认前置** = 包体实测达 §1 预期数量级、冷启动实测达预期数量级、**Electron 回归 0 失败**、防漂移 import 边界检查 0 违规。

## 16. 回滚 / 止损条款

- Electron 路径在所有阶段必须保持 green、可一键设回默认(改默认命令 + 文档),此路径须随时可用。
- 触发回退(Electrobun 降级为兼容、Electron 升回默认)的条件:Phase 0 阻断项无 fallback 可解、或 Electrobun 在达成功能对等前出现不可绕过的关键缺陷。
- 回退动作定义为:默认 `dev`/`build` 命令指回 electron-vite 链 + README 标注,不需要代码层回滚(因构建期分流,两套始终并存)。
