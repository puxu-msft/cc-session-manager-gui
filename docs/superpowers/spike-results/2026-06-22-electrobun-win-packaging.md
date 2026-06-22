# Spike: Electrobun Windows 打包链验证(G0 GATE)

- 日期:2026-06-22
- 触发:GitHub Actions `build` workflow,run [27953000822](https://github.com/puxu-msft/cc-session-manager-gui/actions/runs/27953000822),windows-latest
- 关联:发布架构重构「分层发布 + 双运行时默认切换」的第一个 GATE(详见实现计划)

## 背景:为什么要这个 spike

项目定位 Bun+Electrobun 默认、Node+Electron 兼容,但 CI 此前只构建 Electron(electron-builder)产物。要把默认发布切到 electrobun,前提是 electrobun 能在 windows-latest 上打包成功——而 `docs/ROADMAP.md` 明确把「Electrobun 在 Linux 之外的打包/分发」列为未完成、从未在 windows runner 验证。故设此 GATE:**不过不下走**(不推进 G1 把默认切 electrobun)。

electrobun build 只构建宿主平台(CLI `currentTarget` 写死宿主,`config.build.targets` 不被消费),所以 Windows 产物必须在 windows-latest 上跑,无法从 Linux 跨编译。

## 过程中修掉的真实跨平台 bug

首跑(run 27950311836)在 `Pre-build scan worker` 即失败:`scripts/build-electrobun-worker.mjs` 用 `import.meta.dir.replace(/\/scripts$/, '')` 取项目根,正则硬编码正斜杠;Windows 上 `import.meta.dir` 是反斜杠路径,匹配失败致 `root` 误指向 `scripts/` 自身 → `src/bun` 解析为 `scripts\src\bun` 而 FileNotFound。Linux 用正斜杠侥幸通过。修复:改用跨平台 `dirname(import.meta.dir)`(commit 63593dc)。**这正是 spike 的价值:本地 Linux 不暴露、windows runner 暴露。**

## CI 结果:GO(打包链)

| 步骤 | 结果 |
|------|------|
| Install dependencies (frozen lockfile) | ✓ |
| Pre-build scan worker | ✓(修复后) |
| Electrobun build (stable channel) | ✓ core/bun/WebView2 依赖下载链在 CI 网络通畅 |
| Assert artifacts | ✓ `stable-win-x64-*.zip` + `update.json` 存在 |
| Upload spike artifact | ✓ |
| dist (electron) job | 正确跳过(spike-ci push 不触发) |

### Windows 产物清单(electrobun stable)
- `cc-session-manager-gui-Setup.zip`(31.82 MB)— **便携分发件**,内含自解压器 `Setup.exe`(0.40 MB)+ 压缩的 `tar.zst`(31.81 MB)。注意:electrobun 的 win「便携 zip」不是「解压即跑的目录」,而是包了一个自解压安装 exe。
- `cc-session-manager-gui-Setup.tar.zst`(31.81 MB)— 全量自更新包。
- `update.json` — 自更新元数据(version/hash/platform/arch)。
- artifacts/ 加平台前缀后:`stable-win-x64-cc-session-manager-gui-Setup.zip`、`stable-win-x64-update.json`。

## 待真实 Windows 桌面验证(CI 无头验不了 → 完整 GATE 仍未 GO)

CI 只能验「打包链 + 产物结构」;以下功能项必须在真实 Windows 桌面手测,任一失败都可能推翻「默认切 electrobun」:

| 项 | 说明 | 状态 |
|----|------|------|
| 起窗 | WebView2 运行期渲染(Win11 自带,旧系统需 Evergreen Runtime) | ⏳ 待验 |
| 渲染层 + window.api | 渲染挂载 + RPC 往返(view:probe 探针回传) | ⏳ 待验 |
| 全量扫描 | scanWorker 独立 bundle 加载 + 50000 端口规避(仅 Linux 实测过) | ⏳ 待验 |
| zstd 归档 | zstdShim(Bun 内置 zstd Windows 版)跨运行时互读 | ⏳ 待验 |
| WSL 源探测 | `detectWslSourcesFromWindows`(`wsl --list` UTF-16LE) | ⏳ 待验 |
| 系统托盘 | Linux 用 libNativeWrapper.so appindicator;Windows 等价物未验 | ⏳ 待验 |

桌面验证手法:下载 run 的 `spike-electrobun-win-x64` artifact → 内含 `stable-win-x64-cc-session-manager-gui-Setup.zip` → 解压运行 `Setup.exe` 自解压安装 → 启动应用,逐项核对上表。

## 裁定

- **CI 打包链:GO** — electrobun 能在 windows-latest 成功打包出便携 zip + 自更新元数据,核心技术风险(项目从未在 windows 验证 electrobun 打包)已消除。
- **完整 GATE:待桌面验证** — 上表功能项 GO 后方可推进 G1(把 tag 默认发布切 electrobun)。NO-GO 则停在此排障。

## 备注:临时 CI 触发旁路

当前操作账号 token 缺 `workflow` scope,无法 `workflow_dispatch`。为在 windows runner 验证,临时用 `spike-ci` 分支 + 「push 该分支触发 spike」的旁路(仅存在于 `spike-ci` 分支的 workflow,main 保持 dispatch-only)。完整 GATE GO 后删除该分支与旁路。
