# 路线图与进度(活文档)

> **这是活文档**:本项目「我们在哪、下一步什么」的**单一来源**,推进时随手更新(留档约定见 [CLAUDE.md](../CLAUDE.md))。逐条变更史看 `git log`(约定式提交),设计缘由看冻结 spec。状态口径:✅ 已完成 · 🚧 进行中 · 🔜 下一步 · 💡 想法/未定。

## 当前一句话

核心功能(移动 / 历史对账 / 归档还原)与**双运行时**(Bun+Electrobun 默认 / Node+Electron 兼容)均已落地并发布 **v1.0.0**;两运行时共用核心、经构建期分流、功能对等。项目已改名 **`cc-session-manager-gui`**(原 `cc-move-session`,反映其已从「移动」长成完整会话管理 GUI),旧数据自动迁移。后续主要是遗留实测、打磨与更宏大的蓝图。

## 🚧 Windows host 检测运行中的 WSL 作为数据源(2026-06-22)

补齐多源探测的对称方向:本工具作为 `.exe` 跑在 Windows host 上时,检测**当前运行中**的 WSL 发行版并接入为完整数据源(设计经两轮对抗审查收敛,见 `specs/2026-06-22-wsl-source-from-windows-host-design.md`)。约束:移动/归档恢复默认 Windows→Windows、Linux/Mac→Linux/Mac 不可跨切(由 `osFamily` 产品规则 + `fsAnchor` 技术安全双层承载)。

- ✅ **Phase 1 — 异步探测 + 扫描(读)**:`Source` 加三个正交不变量 `osFamily`(OS 家族,承载用户「Windows→Windows、posix→posix」规则)/ `fsAnchor`(物理文件系统身份,rename 技术安全)/ `claudeHomeCwd`(POSIX 会话视角);`sources.ts` 纯函数 `wslPathToUnc`/`buildWslSources`/`parseWslListVerbose`(三分:unc 原名 / id=`wsl-<base>-<hash>` 恒带原名 hash 防跨会话漂移 / label;distro/HOME 进 UNC 前结构白名单含零宽同形字符防穿越)+ 异步 wrapper(`wsl --list --verbose` UTF-16LE+BOM、WSL2-only、从右解析含空格名;`wsl --exec` UTF-8 探默认用户 HOME,回退枚举 `/home/*` 防 root 漏源;单次 + 聚合超时);探测**异步化**移出同步启动路径(防卡死),经 `sources:refresh` async request/response 并入(in-place,活动源消失则回落 activeId),前端挂载自动调 + win32 恒显「重新检测源」入口(`host:canDetectWsl`)+ 防重入;`Env` 投影 osFamily/fsAnchor/claudeHomeCwd。经两轮代码对抗审查收敛(id 漂移/含空格漏源/activeId 悬挂/osFamily 误删等修复)。纯函数注入式单测,全量 **164 测试通过、tsc 归零**。
- 🔜 **Phase 1 真机验证(Windows host)**:双运行时各验 `wsl.exe` spawn + UTF-16LE 解码(Bun+Windows 单列探针);WSL 源自动出现 + 切源扫描出真实会话;historyReconciler/scanWorker 在 UNC 上不冻结、可中断;默认用户=root 的最小读可行性。
  - ✅ 真机修复:切到 WSL 源时会话误报「路径已不存在」——根因 scanner 用会话 POSIX cwd 直接 `existsSync`,在 Windows host 恒 false。改为由 `cwdHostMapFor`(osFamily 驱动)产出 `CwdHostMap` 经 worker 把 cwd 映射到宿主可访问路径(`posixToUnc` / `winToMnt`)再判存在;**双向**(含 WSL 内切 Windows 源的 `C:\…`→`/mnt/c`)。纯函数单测 +6,全量 170 绿。
- 🔜 **Phase 2 — WSL 活动源内移动 / 归档(写)**:以重设计的 Windows 真机 spike 为门槛(rename 同 share 错误码矩阵 / symlink 读写 4 格 / root-owned ownership / 完整破坏序列);删除 mover 的 homedir 静默回退(env 必填);写后端 fs-facade 逐行覆盖 mover+archiver+fsMove+claudeJson+historyJsonl+tarPack 全部对源 fs 写(含 undo/恢复路径);跨源守卫双层(osFamily 同族 + fsAnchor 同 device)默认拒绝;自引用守卫/fsBrowser 锚点改 POSIX claudeHomeCwd。

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
- ✅ 工程化:包管理切 `bun`(`bun.lock` 单一锁真相源,移除 package-lock.json)、`test:bun` 回归入口、GitHub Actions Windows x64 构建(后重构为**分层发布**,见「Windows 分层发布 + 自动更新接入」段)、`tsc` 归零。
- ✅ 发布 **v1.0.0**。

## ✅ Windows 分层发布 + 自动更新接入(2026-06-22)

把 Windows 发布从「electron-builder 单一 electron 产物 + 聚合 artifact」重构为**双运行时分层发布**(默认 electrobun),并接入两套自动更新。架构见 [ARCHITECTURE.md](ARCHITECTURE.md)「发布与自动更新」,裁定见 `spike-results/2026-06-22-electrobun-win-packaging.md`。

- ✅ **spike GATE**:electrobun 从未在 windows runner 验证过(原 ROADMAP 遗留项)。spike CI 在 windows-latest 跑通 electrobun 打包链(并修掉 worker 预构建的跨平台路径 bug——`import.meta.dir.replace(/\/scripts$/,'')` 正则硬编码正斜杠,Windows 反斜杠路径不匹配致项目根误解析)、用户桌面实测 artifact 可启动运行 → GATE GO。
- ✅ **分层发布**(`.github/workflows/build-windows.yml` 4 job):基础版(tag `v*`)→ electrobun 便携 zip(无自更新);完整版(Release published)→ 默认仅 electrobun(zip+update.json);electron 退为手动覆盖(`workflow_dispatch runtime=electron/both`→nsis+zip+latest.yml)。端到端 tag 实测 Release 仅单一便携 zip、无 latest.yml/无聚合。
- ✅ **元数据不进聚合包**:删除旧 CI 把 `release/*`(exe/zip/blockmap/latest.yml)聚合成单一 artifact 的做法——分发件与更新元数据均走 Release 独立资产逐文件。
- ✅ **electron-updater 接入**:新增 `UpdaterHost` 契约 + `ElectronUpdaterHost` 隔离;`app:update` 事件链 + 顶部更新提示条「有新版/下载中/可安装」。electrobun 渲染适配器补 no-op 同形(自带 bsdiff 不接 electron-updater)。
- ✅ **electrobun 自更新**:`electrobun.config.ts` 补 `release.baseUrl` + `generatePatch:false`(纯全量)。
- ✅ **win.target 默认 zip**(去 nsis,完整版 electron CLI `--win nsis zip` 覆盖加回);**版本单一真相源**(electrobun.config `app.version` 取 `package.json`)。
- 🔜 follow-up:真 portable(非自解压 `Setup.zip`);electron-updater 下载/安装闭环双版本桌面验证;完整版 `release`/`electron-full` CI 路径端到端验证(本轮仅验证了 tag→electrobun-basic)。

## 🔜 下一步 / 遗留

- **Phase 0 遗留实测**(不阻塞):Electron 侧 `app.getPath('userData')` 运行时实测、EXDEV 跨设备 `rename` fallback 实测(需两挂载点)。
- **打磨**:Electrobun **Windows** 打包/分发已验证并落地分层发布(spike GATE GO,2026-06-22,见上段);**macOS** 打包/分发清单仍待(dev-guide §8 主覆盖 Linux/WSL)。

## 💡 想法 / 未定

- **更宏大的蓝图**(改名动因):项目定位从单一「移动会话」扩展为完整的 Claude Code 会话管理平台。新名 `cc-session-manager-gui` 的 `-gui` 已为未来非 GUI 前端(如 CLI / 服务化)共享同一套核心逻辑与数据层留口——数据目录刻意用 `cc-session-manager`(不带 `-gui`)。**具体蓝图待补**(方向确定后填入此处)。
- **独立快照工具**:对 `~/.claude` 等目录做 restic 去重增量 + 可选 zstd 全量包的独立 CLI(方案见 [snapshot-plan.md](snapshot-plan.md)),日后可被本项目复用。
- 远期:restic 后端扩展(SFTP/S3/rclone)异地;快照工具的 React UI。

## 关联文档

冻结的设计/计划/裁定见 README「## 文档」(spec / plan / spike-results);当前架构见 [ARCHITECTURE.md](ARCHITECTURE.md);Electrobun 调试踩坑见 [electrobun-dev-guide.md](electrobun-dev-guide.md)。
