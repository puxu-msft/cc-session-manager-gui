# cc-move-session

把 Claude Code 会话从一个工作目录安全移动到另一个目录的桌面工具(React;**双运行时**:Electron 与 Bun/Electrobun 并存,核心逻辑共用,构建期分流)。

## 它怎么工作

Claude Code 把每个会话存为 `~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl`,文件夹名是绝对路径的有损编码(每个非字母数字字符替换成 `-`,因此不可反解),会话的真实路径只来自文件内部的 `cwd` 字段。一次"移动"由四件事组成:改写**结构化 cwd 字段**(顶层 `cwd` 与嵌套 `attachment.response.cwd` 做前缀重定位:`<源>/x` → `<目标>/x`,源根之外的 cwd 与全部消息正文、工具输出绝不触碰)、搬移整个 `<sessionId>/` sidecar 子树(`subagents/*.jsonl` 改写 cwd,`*.meta.json`、`tool-results/`、`hooks/` 原样搬)、把原件移入回收区、并按需更新 `~/.claude.json` 的 `projects` 条目(从源条目按白名单克隆,易失字段重置)。每行 cwd 改动以紧凑记录写入 SQLite 索引,小文件还会额外保存改动行的完整快照。

数据源真相永远是磁盘上的 jsonl——Claude Code 只读磁盘 jsonl 而不读本工具的数据库,工具的职责是保证磁盘与索引一致。

## 开发

```bash
bun install              # 安装依赖(推荐;已实测正确触发 electron-builder 把 better-sqlite3 重建为 Electron ABI,bun.lock 为锁文件真相源)

# 默认运行时:Bun + Electrobun(需 Bun;Linux 需 appindicator 依赖,见 docs/electrobun-dev-guide.md)
npm run dev              # 启动应用(Electrobun:预构建扫描 worker + electrobun dev)
npm run build            # 生产构建(Electrobun:Bun.build 打包 + 预构建扫描 worker)

# 兼容运行时:Electron
npm run dev:electron     # 启动 Electron(electron-vite dev)
npm run build:electron   # Electron 生产构建(electron-vite build)
npm run pack             # Electron 打包为未压缩应用目录(release/linux-unpacked)
npm run dist             # Electron 打包为可分发安装包(AppImage)
npm run e2e              # Electron 端到端冒烟(Playwright:验证 window.api/三栏/右栏加载)

# 测试与维护
npm test                 # 单元/集成测试(Electron runner,见下方"测试运行时")
npm run test:bun         # 核心逻辑在 Bun 运行时的回归(bun:sqlite / fs / 路径探针)
npm run test:coverage    # 带覆盖率运行
npm run rebuild          # 手动把原生模块重建为 Electron ABI
```

### 双运行时(默认 Electrobun / 兼容 Electron)

核心逻辑(`src/main/core`、`src/main/db`、`src/renderer`)与装配(`src/main/app/bootstrap`、`src/main/platform/contract`)运行时无关,两套 platform 实现(`platform/electron`、`platform/electrobun`)经构建期分流并存:

- **Bun + Electrobun(默认,`npm run dev`/`build`)**:主进程 Bun + bun:sqlite + 系统 WebView,包体更小、启动更快,归档压缩经 `node:zlib` zstd 与 Electron 的 `.zst` 互读。
- **Electron(兼容,`:electron` 后缀命令)**:主进程 Node + better-sqlite3 + 捆绑 Chromium;可随时作为回退,测试/e2e 仍跑此路径。

实现细节、踩坑与打包分发清单见 `docs/electrobun-dev-guide.md`;架构设计与 1c/1d 决策见 `docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md`。

界面:左栏按路径聚合的项目(可过滤)、中栏会话(显式复选框、可过滤、可全选)、右栏完整目录浏览器(快捷根/路径输入/新建文件夹/`.`·`..` 导航)。底部刷新带进度与"检查更新"提醒、项目级单独刷新;历史视图可撤销移动、查看回收区占用并手动清理。

## 数据源(WSL)

在 WSL 中运行时,程序会探测到两套 Claude Code 存储:**WSL (Linux)** 侧 `~/.claude/projects`,与 **Windows** 侧 `/mnt/c/Users/<用户>/.claude/projects`(经 `cmd.exe` 取 `%USERPROFILE%`,失败则扫描 `/mnt/c/Users`)。顶部数据源切换条可二选一;**两套使用各自独立的 sqlite 索引**(`index-local.db` / `index-windows.db`),互不混淆。非 WSL 环境只有本机一个源,切换条隐藏。

核心逻辑模块(`src/main/core/**`、`src/main/db/**`)可独立单元测试;UI 组件、IPC、Electron 运行时胶水层不通过测试覆盖。

### 原生模块与测试运行时

本工具用 `better-sqlite3`(原生模块)。Electron 自带的 Node 与系统 Node 的 ABI(`NODE_MODULE_VERSION`)不同,且 Electron 的 ABI 不对应任何独立发布的 Node 版本,无法靠升级系统 Node 对齐。因此本项目只保留**一份按 Electron ABI 编译**的 `better-sqlite3`,并让测试也跑在 **Electron 的 Node 运行时**上(`scripts/test-electron.mjs` 用 `ELECTRON_RUN_AS_NODE=1` 以 electron 二进制当 node 启动 vitest)。这样 app 与测试共用同一 ABI,无需在两套构建之间来回重建。

新克隆首次 `npm install` 时,`postinstall`(`electron-builder install-app-deps`)会为 Electron 重建 `better-sqlite3`;该模块没有现成的 Electron 预编译件,需本地编译(约 1~2 分钟,依赖 python3 / make / g++)。

判断 ABI 问题(非代码回归):若触达 DB 的测试**整片**报 `NODE_MODULE_VERSION <X> vs 146` 或 `Module did not self-register`,是 ABI 不匹配而非代码坏了——**重建即可,别改代码**:`npm run rebuild`,或点名重建 `npx @electron/rebuild -f -w better-sqlite3 -v <electron 版本>`。切勿用系统 node 的 `npm rebuild better-sqlite3`(会编成系统 ABI,让跑在 Electron 运行时的测试整片失败,并与 Electron ABI 来回横跳)。跨项目通用判据见 `docs/memory/native-module-abi-test-runtime.md`。

WSL 注意:若从 Windows 经 `WSLENV` 泄漏了 `ELECTRON_RUN_AS_NODE=1`,会让 `npm run dev` 启动的 electron 以 node 模式运行而不弹窗;`dev` 脚本已在启动前清空该变量(注意须清空或 unset,设为 `0` 无效)。


## 安全提示(重要)

移动前请先关闭对应会话:工具会检测会话文件 mtime,疑似活跃(默认 60 秒内有写入)的会话会被**拒绝移动**,并提示先关闭它。这避免在 Claude Code 正在写入时破坏会话文件。

## 回收区 / 撤销

每次移动都会把原件 `rename` 到回收区 `~/.claude/.cc-move-trash/<moveId>/`,不做破坏性删除。回收区**默认不自动 GC**,无限期保留;可在"历史"视图里查看每次移动与总计的磁盘占用,手动**撤销**(把原件搬回源、清理目标、移除 `.claude.json` 新增条目)或手动清理。崩溃后重启会对处于 pending 状态的移动做 reconcile,判定补记 done 或回滚为 failed。

## 归档 / 还原

除移动外,可对会话做**快照**(留原件的备份版本)或**归档**(移除原件、收进归档库),同一会话形成多版本时间线;任意版本可**还原**到原位置——还原前会把现状整体搬入 `.cc-move-backups/<restoreId>-<sessionId>/` 作为安全网,可撤销。归档库 `.cc-move-archive/` 与备份区均无限期保留、可在「归档时间线」视图查看占用并手动清理。

## 文档

本节是全项目文档目录。**活文档**随代码更新(当前状态的真相源);**冻结文档**(spec/plan/spike-results)定格于撰写时,记录设计意图与裁定,不随代码更新。

**活文档(当前状态)**
- 架构总览:[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 当前模块/数据流/数据模型/双运行时缝
- 路线图与进度:[docs/ROADMAP.md](docs/ROADMAP.md) — 已完成 / 进行中 / 下一步(「我们在哪」的单一来源)
- Electrobun 开发辅助 / 调试笔记:[docs/electrobun-dev-guide.md](docs/electrobun-dev-guide.md) — 真实 API 差异 / WSL 起窗判据 / appindicator 前置 / 验证方法论

**冻结:核心(移动 / 历史对账 / 归档还原)**
- 设计规格:[docs/superpowers/specs/2026-06-15-cc-move-session-design.md](docs/superpowers/specs/2026-06-15-cc-move-session-design.md)
- 实现计划:[docs/superpowers/plans/2026-06-15-cc-move-session.md](docs/superpowers/plans/2026-06-15-cc-move-session.md)
- 历史 JSONL 对账设计:[docs/superpowers/specs/2026-06-16-history-jsonl-reconciler-design.md](docs/superpowers/specs/2026-06-16-history-jsonl-reconciler-design.md)
- 历史 JSONL 对账实现计划:[docs/superpowers/plans/2026-06-16-history-jsonl-reconciler.md](docs/superpowers/plans/2026-06-16-history-jsonl-reconciler.md)
- 历史视图 UI 实现计划:[docs/superpowers/plans/2026-06-16-history-reconciler-ui.md](docs/superpowers/plans/2026-06-16-history-reconciler-ui.md)
- 归档/还原设计:[docs/superpowers/specs/2026-06-17-session-archive-restore-design.md](docs/superpowers/specs/2026-06-17-session-archive-restore-design.md)
- 归档/还原实现计划:[docs/superpowers/plans/2026-06-17-session-archive-restore.md](docs/superpowers/plans/2026-06-17-session-archive-restore.md)

**冻结:双运行时改造**(当前进度见上方 ROADMAP)
- 设计规格(Electrobun 一等 / Electron 兼容):[docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md](docs/superpowers/specs/2026-06-17-dual-runtime-electrobun-electron-design.md)
- Phase 0 Spike 计划:[docs/superpowers/plans/2026-06-17-electrobun-phase0-spike.md](docs/superpowers/plans/2026-06-17-electrobun-phase0-spike.md)
- Phase 0 结果与裁定(8/8 PASS,go):[docs/superpowers/spike-results/2026-06-17-phase0.md](docs/superpowers/spike-results/2026-06-17-phase0.md)

**相关工具(规划中)**
- 快照工具方案(独立 restic + zstd CLI,可被本项目复用):[docs/snapshot-plan.md](docs/snapshot-plan.md)

