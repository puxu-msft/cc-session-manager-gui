# cc-move-session

把 Claude Code 会话从一个工作目录安全移动到另一个目录的桌面工具(Electron + React)。

## 它怎么工作

Claude Code 把每个会话存为 `~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl`,文件夹名是绝对路径的有损编码(每个非字母数字字符替换成 `-`,因此不可反解),会话的真实路径只来自文件内部的 `cwd` 字段。一次"移动"由四件事组成:改写**结构化 cwd 字段**(顶层 `cwd` 与嵌套 `attachment.response.cwd` 做前缀重定位:`<源>/x` → `<目标>/x`,源根之外的 cwd 与全部消息正文、工具输出绝不触碰)、搬移整个 `<sessionId>/` sidecar 子树(`subagents/*.jsonl` 改写 cwd,`*.meta.json`、`tool-results/`、`hooks/` 原样搬)、把原件移入回收区、并按需更新 `~/.claude.json` 的 `projects` 条目(从源条目按白名单克隆,易失字段重置)。每行 cwd 改动以紧凑记录写入 SQLite 索引,小文件还会额外保存改动行的完整快照。

数据源真相永远是磁盘上的 jsonl——Claude Code 只读磁盘 jsonl 而不读本工具的数据库,工具的职责是保证磁盘与索引一致。

## 开发

```bash
npm install              # 安装依赖;postinstall 会把原生模块按 Electron ABI 重建
npm run dev              # 启动 Electron 应用(electron-vite dev)
npm run build            # 生产构建(electron-vite build)
npm test                 # 单元/集成测试(见下方"测试运行时")
npm run test:coverage    # 带覆盖率运行
npm run e2e              # Electron 端到端冒烟(Playwright:验证 window.api/三栏/右栏加载)
npm run pack             # 打包为未压缩应用目录(release/linux-unpacked)
npm run dist             # 打包为可分发安装包(AppImage)
npm run rebuild          # 手动把原生模块重建为 Electron ABI
```

界面:左栏按路径聚合的项目(可过滤)、中栏会话(显式复选框、可过滤、可全选)、右栏完整目录浏览器(快捷根/路径输入/新建文件夹/`.`·`..` 导航)。底部刷新带进度;历史视图可撤销移动、查看回收区占用并手动清理。

## 数据源(WSL)

在 WSL 中运行时,程序会探测到两套 Claude Code 存储:**WSL (Linux)** 侧 `~/.claude/projects`,与 **Windows** 侧 `/mnt/c/Users/<用户>/.claude/projects`(经 `cmd.exe` 取 `%USERPROFILE%`,失败则扫描 `/mnt/c/Users`)。顶部数据源切换条可二选一;**两套使用各自独立的 sqlite 索引**(`index-local.db` / `index-windows.db`),互不混淆。非 WSL 环境只有本机一个源,切换条隐藏。

核心逻辑模块(`src/main/core/**`、`src/main/db/**`)可独立单元测试;UI 组件、IPC、Electron 运行时胶水层不通过测试覆盖。

### 原生模块与测试运行时

本工具用 `better-sqlite3`(原生模块)。Electron 自带的 Node 与系统 Node 的 ABI(`NODE_MODULE_VERSION`)不同,且 Electron 的 ABI 不对应任何独立发布的 Node 版本,无法靠升级系统 Node 对齐。因此本项目只保留**一份按 Electron ABI 编译**的 `better-sqlite3`,并让测试也跑在 **Electron 的 Node 运行时**上(`scripts/test-electron.mjs` 用 `ELECTRON_RUN_AS_NODE=1` 以 electron 二进制当 node 启动 vitest)。这样 app 与测试共用同一 ABI,无需在两套构建之间来回重建。

新克隆首次 `npm install` 时,`postinstall`(`electron-builder install-app-deps`)会为 Electron 重建 `better-sqlite3`;该模块没有现成的 Electron 预编译件,需本地编译(约 1~2 分钟,依赖 python3 / make / g++)。

WSL 注意:若从 Windows 经 `WSLENV` 泄漏了 `ELECTRON_RUN_AS_NODE=1`,会让 `npm run dev` 启动的 electron 以 node 模式运行而不弹窗;`dev` 脚本已在启动前清空该变量(注意须清空或 unset,设为 `0` 无效)。


## 安全提示(重要)

移动前请先关闭对应会话:工具会检测会话文件 mtime,疑似活跃(默认 60 秒内有写入)的会话会被**拒绝移动**,并提示先关闭它。这避免在 Claude Code 正在写入时破坏会话文件。

## 回收区 / 撤销

每次移动都会把原件 `rename` 到回收区 `~/.claude/.cc-move-trash/<moveId>/`,不做破坏性删除。回收区**默认不自动 GC**,无限期保留;可在"历史"视图里查看每次移动与总计的磁盘占用,手动**撤销**(把原件搬回源、清理目标、移除 `.claude.json` 新增条目)或手动清理。崩溃后重启会对处于 pending 状态的移动做 reconcile,判定补记 done 或回滚为 failed。

## 归档 / 还原

除移动外,可对会话做**快照**(留原件的备份版本)或**归档**(移除原件、收进归档库),同一会话形成多版本时间线;任意版本可**还原**到原位置——还原前会把现状整体搬入 `.cc-move-backups/<restoreId>-<sessionId>/` 作为安全网,可撤销。归档库 `.cc-move-archive/` 与备份区均无限期保留、可在「归档时间线」视图查看占用并手动清理。

## 文档

- 设计规格:[docs/superpowers/specs/2026-06-15-cc-move-session-design.md](docs/superpowers/specs/2026-06-15-cc-move-session-design.md)
- 实现计划:[docs/superpowers/plans/2026-06-15-cc-move-session.md](docs/superpowers/plans/2026-06-15-cc-move-session.md)
- 归档/还原设计:[docs/superpowers/specs/2026-06-17-session-archive-restore-design.md](docs/superpowers/specs/2026-06-17-session-archive-restore-design.md)
- 归档/还原实现计划:[docs/superpowers/plans/2026-06-17-session-archive-restore.md](docs/superpowers/plans/2026-06-17-session-archive-restore.md)
