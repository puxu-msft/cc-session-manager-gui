# 路线图与进度(活文档)

> **这是活文档**:本项目「我们在哪、下一步什么」的**单一来源**,推进时随手更新(留档约定见 [CLAUDE.md](../CLAUDE.md))。逐条变更史看 `git log`(约定式提交),设计缘由看冻结 spec。状态口径:✅ 已完成 · 🚧 进行中 · 🔜 下一步 · 💡 想法/未定。

## 当前一句话

核心功能(移动 / 历史对账 / 归档还原)与**双运行时**(Bun+Electrobun 默认 / Node+Electron 兼容)均已落地并发布 **v1.0.0**;两运行时共用核心、经构建期分流、功能对等。项目已改名 **`cc-session-manager-gui`**(原 `cc-move-session`,反映其已从「移动」长成完整会话管理 GUI),旧数据自动迁移。后续主要是遗留实测、打磨与更宏大的蓝图。

## ✅ 改名 cc-session-manager-gui(2026-06-19)

旧名 `cc-move-session` 只描述「移动」,已不符;统一更名 `cc-session-manager-gui` 并附**自动数据迁移**(下次启动幂等执行,既有移动/归档/还原历史不丢):

- ✅ 产品身份全改:package.json(name/appId/productName/desc)、electrobun.config(app.name/identifier + version 对齐 1.0.0)、app 名(userData → `~/.config/cc-session-manager-gui`)、窗口标题、文档。
- ✅ 磁盘数据目录改名 + 迁移:`~/.claude/.cc-move-{trash,archive,backups}` → `.cc-session-manager-*`;`migrateRename.ts` 启动时搬旧 userData 的 index 库、rename 三目录、重写库内绝对 `backup_path`/`trash_path`(TDD,5 测)。
- ✅ 全套测试 141 通过、tsc 归零。
- 冻结 spec/plan/spike-results 的日期文件名保留;正文项目名按需更新,历史代码/实测路径保留为史实。

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

## ✅ 双运行时改造(已完成,v1.0.0)

把 Electron 专属耦合抽到 `platform/contract.ts` 运行时无关契约,Bun+Electrobun 与 Node+Electron 经构建期分流并存、功能对等(架构见 [ARCHITECTURE.md](ARCHITECTURE.md),实测踩坑见 [electrobun-dev-guide.md](electrobun-dev-guide.md))。

- ✅ 六大契约 + 注入式装配:`AppHost`/`WindowHost`/`BridgeServer`/`Paths`/`ScanRunner`/`SqliteDriver`;`app/bootstrap.ts` 只写一次,两入口(`src/main/index.ts` / `src/bun/index.ts`)各装配自己的 `Platform`。`repository.ts` 从 `db.ts` 拆出只依赖 `SqliteDriver`;DB 工厂经 `Platform.dbFactory` 注入。
- ✅ 两侧实现齐全:Electron(`platform/electron/*`)+ Electrobun(`platform/electrobun/*`:app/window/bridge/paths/scanRunner/sqliteDriver/zstdShim/rpcSchema)+ `src/bun/{index,scanWorker}.ts`。
- ✅ 渲染层两运行时共用同一份 App:`main.electrobun.tsx` 把 Electroview RPC 包成与 `window.api` 同形的 adapter,App/state/组件零改动复用。
- ✅ Phase 3 运行时对等三处解法(dev-guide §7):zstd 用 `node:zlib` shim(标准 `.zst`,与 zstd-napi 跨运行时字节级互读)、扫描 worker 用独立预构建 bundle(避免 electrobun 抢占 50000 端口)、渲染端 RPC `maxRequestTime` 设 60s。
- ✅ 构建期分流:`npm run dev`/`build`=Electrobun(默认),`:electron` 后缀=Electron(兼容);`electrobun.config.ts` 经 `sharedAlias`/`zstdShim` 两插件解决 `@shared` 解析与 native 模块不进 bundle。
- ✅ 工程化:包管理切 `bun`(`bun.lock` 单一锁真相源,移除 package-lock.json)、`test:bun` 回归入口、GitHub Actions Windows x64 构建 + tag 触发草稿 Release、`tsc` 归零。
- ✅ 发布 **v1.0.0**。

## 🔜 下一步 / 遗留

- **Phase 0 遗留实测**(不阻塞):Electron 侧 `app.getPath('userData')` 运行时实测、EXDEV 跨设备 `rename` fallback 实测(需两挂载点)。
- **打磨**:Electrobun 在 Linux 之外的打包/分发清单(当前 dev-guide §8 主覆盖 Linux/WSL)。

## 💡 想法 / 未定

- **更宏大的蓝图**(改名动因):项目定位从单一「移动会话」扩展为完整的 Claude Code 会话管理平台。新名 `cc-session-manager-gui` 的 `-gui` 已为未来非 GUI 前端(如 CLI / 服务化)共享同一套核心逻辑与数据层留口——数据目录刻意用 `cc-session-manager`(不带 `-gui`)。**具体蓝图待补**(方向确定后填入此处)。
- **独立快照工具**:对 `~/.claude` 等目录做 restic 去重增量 + 可选 zstd 全量包的独立 CLI(方案见 [snapshot-plan.md](snapshot-plan.md)),日后可被本项目复用。
- 远期:restic 后端扩展(SFTP/S3/rclone)异地;快照工具的 React UI。

## 关联文档

冻结的设计/计划/裁定见 README「## 文档」(spec / plan / spike-results);当前架构见 [ARCHITECTURE.md](ARCHITECTURE.md);Electrobun 调试踩坑见 [electrobun-dev-guide.md](electrobun-dev-guide.md)。
