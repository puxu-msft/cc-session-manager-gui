# 路线图与进度(活文档)

> **这是活文档**:本项目「我们在哪、下一步什么」的**单一来源**,推进时随手更新(留档约定见 [CLAUDE.md](../CLAUDE.md))。逐条变更史看 `git log`(约定式提交),设计缘由看冻结 spec。状态口径:✅ 已完成 · 🚧 进行中 · 🔜 下一步 · 💡 想法/未定。

## 当前一句话

核心功能(移动 / 历史对账 / 归档还原)已可用;正进行**双运行时改造**(Electrobun+Bun 一等 / Electron 兼容),Phase 0 Spike 已裁定 **go**,**运行时解耦(抽缝)正活跃落地中**——六大平台契约已抽出、Electron 实现就位、`BunSqliteDriver` 已写,剩 Electrobun 各宿主实现 + 构建分流。

## ✅ 已完成(里程碑)

- **核心移动管线 + 三栏 UI**:有损路径编码与前缀重定位、只改结构化 cwd 字段、sidecar 子树搬移、claude.json 白名单克隆、预检/预览/执行/回滚/reconcile/撤销;移动历史与撤销视图。(14 任务 TDD;3 处数据安全缺陷已修)
- **刷新与性能**:增量刷新(跳过未变文件)+ 进度上报;全量扫描移出主进程到 `worker_threads`;优雅退出(中断扫描·关库);逻辑与 UI 分离重构(`applyScanToIndex` 纯函数 + 端到端集成测试)。
- **目录浏览器**:右栏完整目录浏览(快捷根/路径输入/面包屑/`.`·`..`/新建文件夹/容错)。
- **回收区 / 打包 / E2E**:回收区占用统计与手动清理;electron-builder 打包(AppImage)、better-sqlite3 从 asar 解包;Playwright E2E 冒烟(堵 preload 桥断裂类 bug);左/中栏搜索过滤。
- **运行时坑收口**:preload 打成 `.cjs` 修复 `window.api` 全 undefined;dev 启动前清空 `ELECTRON_RUN_AS_NODE`(WSL 不弹窗);原生模块 ABI 统一(better-sqlite3 单份 Electron ABI、测试经 electron-as-node)。
- **历史 JSONL 对账**:`history.jsonl` 项目引用的 auto/force 对账 + 撤销 + 视图。
- **归档 / 还原**:快照/归档/还原多版本时间线、还原前现状入 backups 安全网、崩溃 reconcile;归档压缩改 zstd-napi 流式(level 19 + 多线程 + LDM);`gz_*` 命名遗留改 `compressed_*`(schema v2→v3 迁移)。
- **数据层抽象缝**:`SqliteDriver` 接口落地,repository 不再直接依赖 better-sqlite3(为双运行时铺路)。
- **双运行时 Phase 0**:spec 经三方对抗审查 + 收敛裁决迭代至 v3;Phase 0 Spike 8/8 探针全 PASS,裁定 **go**(裁定见 `spike-results/2026-06-17-phase0.md`)。

## 🚧 进行中:运行时解耦(抽缝)

把 Electron 专属耦合抽到 `platform/contract.ts` 的运行时无关契约,核心装配只依赖接口(见 [ARCHITECTURE.md](ARCHITECTURE.md) 与双运行时 spec)。已落地(commit `3b83c86`→`9fd5868`):

- ✅ 六大契约抽出:`AppHost` / `WindowHost` / `BridgeServer` / `Paths` / `ScanRunner` / `SqliteDriver`(`platform/contract.ts`)。
- ✅ Electron 各宿主实现就位(`platform/electron/{app,window,bridge,paths,scanRunner}.ts`);`index.ts` 经 `app/bootstrap.ts` 装配,成薄入口。
- ✅ `repository.ts` 从 `db.ts` 拆出(只依赖 `SqliteDriver`);`appState`/`ipc` 摆脱 electron 直接依赖(Paths/BridgeServer 注入)。
- ✅ DB 工厂经 `Platform.dbFactory` 注入(Electron 注入 `openDb`,`appState` 摆脱 better-sqlite3 值依赖);共享 repository 已验证在 bun:sqlite 与 better-sqlite3 行为等价(spike)。
- ✅ `BunSqliteDriver`(`platform/electrobun/sqliteDriver.ts`,bun:sqlite)已写。

## 🔜 下一步

- **Electrobun 侧实现**:`AppHost` / `WindowHost` / `BridgeServer`(defineRPC)/ `ScanRunner`(Bun)实现 + Electrobun 入口(对应 `index.ts` 的 Electron 装配,提供 bun:sqlite 版 `dbFactory`)。
- **构建期运行时分流**:当前 `index.ts` 即写死的 Electron 入口;需按运行时选择装配哪套 `Platform` 实现集。
- **Phase 0 遗留实测**(不阻塞):Electron 侧 `app.getPath('userData')` 运行时实测、EXDEV 跨设备 `rename` fallback 实测(需两挂载点)。

## 💡 想法 / 未定

- **独立快照工具**:对 `~/.claude` 等目录做 restic 去重增量 + 可选 zstd 全量包的独立 CLI(方案见 [snapshot-plan.md](snapshot-plan.md)),日后可被本项目复用。
- 远期:restic 后端扩展(SFTP/S3/rclone)异地;快照工具的 React UI。

## 关联文档

冻结的设计/计划/裁定见 README「## 文档」(spec / plan / spike-results);当前架构见 [ARCHITECTURE.md](ARCHITECTURE.md);Electrobun 调试踩坑见 [electrobun-dev-guide.md](electrobun-dev-guide.md)。
