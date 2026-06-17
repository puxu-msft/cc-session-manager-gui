# 双运行时(Electrobun 一等 / Electron 兼容)架构设计

- 状态:草案(待对抗审查迭代)
- 日期:2026-06-17
- 适用项目:cc-move-session

## 1. 背景与目标

本项目当前基于 Electron 42 + electron-vite + electron-builder,主进程跑在 Node,渲染层为 React 19,索引存储用 better-sqlite3,后台全量扫描放在 `node:worker_threads`。

目标:把 **Bun + Electrobun** 提升为一等支持并设为默认运行时,**Node + Electron** 降为兼容支持。二者通过构建期分流与一组抽象契约共存:默认走 Electrobun,除非用户或测试显式指定 Electron。

收益预期:更小包体(系统 webview,~14MB 量级)、更快启动、内置增量更新;并用 `bun:sqlite` 替换 better-sqlite3,从根上消除 native ABI rebuild 痛点。

## 2. 非目标(YAGNI)

- 不追求"同一份产物运行时自动切换运行时"(技术上不可行,见 §3)。
- 不在本期引入 Electrobun 的自更新、Tray、WebGPU 等增量能力;只覆盖现有功能对等所需的适配面。
- 不重写业务逻辑(core/);只做解耦与适配。
- 不为 Electrobun 路径在本期建成熟 e2e 体系(见 §10 测试策略)。

## 3. 关键技术约束

Electron 主进程运行于 Node,Electrobun 主进程运行于 Bun。`import 'electron'` 在 Bun 下、`import 'electrobun/bun'` 在 Node 下都会在**模块加载期**即失败;`bun:sqlite` 在 Node 中不存在。

因此双运行时只能是**构建期分流**:打包时选定 target(electrobun 默认 / electron 兼容),代码通过条件入口 + 模块解析选择具体实现,**运行期始终是单一运行时**。这是物理约束,不是设计偏好。

## 4. 平台耦合点清单(改造面)

| # | 耦合点 | 现文件 | Electron 写法 | Electrobun 对应 |
|---|---|---|---|---|
| 1 | app 生命周期 + 窗口 | `src/main/index.ts` | `app` / `BrowserWindow` / `loadFile` | `electrobun/bun` `BrowserWindow`/`BrowserView` + `views://` |
| 2 | 用户数据路径 | `src/main/appState.ts` | `app.getPath('userData')` | Paths API / 自拼 `~/.config` |
| 3 | Bridge 主侧 | `src/main/ipc.ts` | `ipcMain.handle` + `sender.send` | Events / RPC |
| 4 | Bridge 渲染侧 | `src/preload/index.ts` | `contextBridge` + `ipcRenderer` | Electroview |
| 5 | 数据库 | `src/main/db/db.ts` | better-sqlite3 | `bun:sqlite` |
| 6 | 后台扫描 worker | `src/main/scanWorker.ts` + `ipc.ts` | `node:worker_threads` | Bun Worker |
| 7 | 构建 / 打包 | `electron.vite.config.ts`、`package.json#build` | electron-vite + electron-builder | electrobun CLI + config |

**保持不变(代码主体)**:整个 `src/main/core/`、`src/shared/`、renderer 的 React 组件与 state,以及仅依赖 `node:fs/os/path` 的模块(sources/refresh/trash 等,Bun 兼容)。

## 5. 架构方针:两套地道实现为主,抽取共享组件辅助

窗口、传输、打包这些"运行时味道最重"的部分,两套各自用最地道写法;业务 handler、DB 领域逻辑、core、UI 抽为共享,只写一次。

### 5.1 共享组件(运行时无关,只写一次)

- `src/core/`、`src/shared/`:纯逻辑与类型常量,零运行时依赖(现状已是)。
- **集中式 typed channel 契约** `src/platform/channels.ts`:声明全部 IPC 通道的名字、参数、返回类型,以及**业务 handler 实现本体**(纯函数,仅依赖 `Env`/core,不触碰运行时)。两套 bridge 只负责把它接到各自传输层。
- **DB 领域 repository** `src/platform/db/repository.ts`:现 `db.ts` 的领域方法(upsertSession、insertMove、archive\* 等)保留为共享层,底层依赖 `SqliteDriver` 接口而非具体驱动。
- renderer/:React 组件全部共享;`window.api` 类型从 channel 契约推导。

### 5.2 各自地道实现(两套,独立写法)

- 入口 + app 生命周期 + 窗口创建。
- bridge 传输实现。
- `Paths` 实现。
- `SqliteDriver` 实现(better-sqlite3 / bun:sqlite,在驱动层吸收命名参数与事务差异)。
- `ScanRunner` 实现(node:worker_threads / Bun Worker)。
- 构建打包配置。

## 6. 目录结构(目标)

```
src/
  core/                          共享纯逻辑(由 src/main/core 迁移)
  shared/                        共享类型/常量
  renderer/                      React UI(基本不变)
  platform/
    channels.ts                  通道契约 + handler 本体(共享)
    contract.ts                  抽象接口定义(见 §7)
    db/
      repository.ts              共享 DB 领域层(基于 SqliteDriver)
      schema.ts                  迁移自 db/schema.ts
    electron/
      entry.ts                   Electron 入口
      window.ts                  app 生命周期 + BrowserWindow
      bridge.ts                  ipcMain.handle + sender.send 接线
      preload.ts                 contextBridge 暴露 window.api
      sqliteDriver.ts            better-sqlite3 driver
      scanRunner.ts              worker_threads runner
      paths.ts                   app.getPath('userData')
    electrobun/
      entry.ts                   Electrobun 入口(默认)
      window.ts                  BrowserWindow/BrowserView + views://
      bridge.ts                  Events/RPC 接线
      electroview.ts             浏览器侧 API 注入
      sqliteDriver.ts            bun:sqlite driver
      scanRunner.ts              Bun Worker runner
      paths.ts                   ~/.config 自拼 / Paths API
  app/
    bootstrap.ts                 运行时无关装配:接收 platform 实现 → 注册 channel handler + core 启动收尾
```

> 注:现有 `src/main/*` 在 Phase 1 渐进迁移到上述布局;迁移期保留别名,保证 Electron 路径始终可构建可运行。

## 7. 抽象契约(`platform/contract.ts`)

以下为接口意图,签名在实现期细化;均为运行时无关定义。

- `Paths`:`userData(): string`。
- `SqliteDriver`:`prepare(sql): { run(params?), get(params?), all(params?) }`、`exec(sql)`、`transaction(fn)`、`pragma(s)`、`close()`。命名参数统一以 repository 约定的占位风格传入,由各 driver 适配到 better-sqlite3(`@name`)或 bun:sqlite(`$name`/`:name`)。
- `ScanRunner`:`run(input, onProgress): Promise<ScanOutcome>`、`terminate(): void`。语义需保留"未收到 done/error 即被中断 = aborted"。
- `WindowHost`:`createMainWindow(opts): void`,内部完成 renderer 加载与 bridge/preload 注入。
- `AppHost`:`whenReady(): Promise<void>`、`onAllWindowsClosed(cb)`、`onBeforeQuit(cb)`、`setName(name)`、`quit()`。
- `BridgeServer`:`handle(channel, fn)`、`emit(event, payload)`,由 `bootstrap` 用 channel 契约批量接线。

`bootstrap(platform)` 接收一组上述实现,完成:设置 app 名 → 启动时 reconcile(mover/archiver 的 pending 收尾)→ 注册全部 channel handler → 创建窗口 → 注册退出收尾(中断扫描 + 关闭 DB)。

## 8. Channel 契约(`platform/channels.ts`)

- 单一来源声明全部通道(现 30+ 个 `invoke` 通道 + `refresh:progress` 事件)。
- 每个通道携带:名字、参数类型、返回类型、handler 实现(纯函数,签名 `(env, ...args) => result`)。
- 渲染侧 `window.api` 的类型由该契约自动推导,避免 preload 与主侧漂移。
- 两套 bridge:Electron 把 handler 接到 `ipcMain.handle`、进度走 `sender.send`;Electrobun 接到其 Events/RPC、进度走其事件通道。
- 进度类事件(`onRefreshProgress`)抽象为"主→渲染单向事件",两套各自实现订阅/取消订阅。

## 9. DB:repository over driver

- 现 `openDb()` 拆为两层:领域 repository(共享)+ `SqliteDriver`(两套)。
- repository 持有 driver,所有 `db.prepare(...).run/get/all`、`db.transaction`、`db.pragma('journal_mode=WAL')`、`db.exec(SCHEMA_SQL)` 经由 driver 接口表达。
- 差异吸收点(driver 内部):命名参数占位符语法、`lastInsertRowid` 取值、`transaction` 包装、布尔→0/1 入库(现已在 repository 层手动转换,保持)。
- `appState.ts` 的多源 DB 管理(`index-<id>.db`、legacy 迁移)保留,仅把 `openDb` 换成"repository + 注入 driver"。

## 10. 测试策略

- **核心层**:core + repository + channel handler 用 bun:sqlite driver 跑 `bun test`(内存库),快且无 ABI 依赖。
- **Electron 兼容路径**:保留现有 Electron test runner(`scripts/test-electron.mjs`)作为兼容回归。
- **e2e**:本期 Playwright e2e 继续跑 Electron 路径;Electrobun 路径先做手动冒烟(起窗 + 一条关键流程),成熟 e2e 留待后续。
- 现有单测断言不依赖运行时的部分应能在两条路径下复用。

## 11. 构建与切换

- 默认 Electrobun:`bun dev` / `bun run build`(经 electrobun CLI + config)。
- 兼容 Electron:`npm run dev:electron` / `npm run build:electron`(electron-vite + electron-builder,沿用现配置)。
- 模块解析:两套 entry 分别静态 import 各自 platform;不使用运行时 `if` 选择 import。
- 测试矩阵:`bun test`(核心,默认)+ electron runner(兼容)。

## 12. 实现阶段(一个计划,7 面全覆盖,带 gate)

- **Phase 0 — WSL Spike(硬闸门)**:在 WSL2 装 Bun + Electrobun,跑 hello-world 确认 WSLg 下能起窗口;并以探针验证 `bun:sqlite` 基本读写、Bun Worker(或 node:worker_threads 兼容)可用。**任一关键项不通过则整个计划暂停**,先解决环境/兼容再继续。
- **Phase 1 — 解耦(不破坏 Electron)**:抽出 `contract.ts`、`channels.ts`、`db/repository.ts`;把 `appState`→electron、`db`→better-sqlite3 的直接依赖移到 Electron platform 实现;Electron 路径用新布局**全程跑通并通过现有测试/e2e**(回归保证)。
- **Phase 2 — Electrobun 实现**:补齐 electrobun/ 下全部 7 个适配面,Electrobun 路径端到端跑通核心流程(列表/扫描/移动/归档至少各一条)。
- **Phase 3 — 默认切换 + 收尾**:默认命令切到 Electrobun;整理脚本、测试矩阵、README/文档;Electron 保留为显式兼容路径。

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| WSL 下 Electrobun 起窗失败(webkit2gtk + WSLg) | 方案不可落地 | Phase 0 硬闸门先验证;失败即止损 |
| `node:worker_threads` 在 Bun 兼容不足 | 扫描中断/进度机制失效 | Phase 0 探针;不行则改 Bun Worker,ScanRunner 接口吸收差异 |
| bun:sqlite 与 better-sqlite3 语义差异(命名参数/事务/类型) | DB 行为不一致 | driver 层吸收 + 共享 repository 测试在两 driver 下都跑 |
| Electrobun beta 稳定性、文档薄、无成熟 e2e | 踩坑成本高 | e2e 暂走 Electron;Electrobun 先冒烟;关键 API 假设在 Phase 0/2 实测 |
| Electrobun RPC 能力是否覆盖 30+ 通道 + 单向事件 | bridge 抽象可能受限 | Phase 0 验证 RPC/Events 表达力;必要时调整 channel 契约形态 |
| React 经 `views://` 在系统 webview 渲染的兼容(React 19) | 渲染层异常 | Phase 0 起窗时即加载最小 React 页验证 |

## 14. 待验证的开放问题(供对抗审查攻击)

1. Electrobun 的 RPC/Events 是否支持请求-响应(invoke/handle 等价)+ 主动推送两种模式,且能携带结构化 payload?
2. Electrobun 是否有等价于 preload+contextBridge 的安全注入点,能稳定暴露 `window.api`?
3. Bun 对 `node:worker_threads` 的 `terminate()` 与 `workerData`/`postMessage` 兼容程度?
4. bun:sqlite 是否支持 WAL pragma、命名参数、`db.transaction`、与 better-sqlite3 等价的同步 API?
5. electrobun CLI 能否打包 React 渲染产物(配合既有 vite 构建,或需替换打包链)?
6. Electron 与 Electrobun 两套 `package.json` 字段/依赖是否会互相冲突(如 `type: module`、`main` 字段、bun 专有依赖)?
7. 多源 DB(`index-<id>.db`)与 userData 路径在 Electrobun 下的落点是否与 Electron 一致,避免用户数据分裂?
```
