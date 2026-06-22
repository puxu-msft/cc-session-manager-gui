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

## 真实 Windows 桌面验证(用户实测)

CI 只能验「打包链 + 产物结构」;以下功能项在真实 Windows 桌面手测。**用户实测:spike artifact 可正常启动运行**——便携 zip 解压后运行 Setup.exe 自解压、应用起窗成功。

| 项 | 说明 | 状态 |
|----|------|------|
| 起窗 | WebView2 运行期渲染(Win11 自带,旧系统需 Evergreen Runtime) | ✓ 可运行 |
| 渲染层 + window.api | 渲染挂载 + RPC 往返 | ✓ 可运行 |
| 全量扫描 | scanWorker 独立 bundle 加载 + 50000 端口规避 | 随使用持续确认 |
| zstd 归档 | zstdShim(Bun 内置 zstd Windows 版)跨运行时互读 | 随使用持续确认 |
| WSL 源探测 | `detectWslSourcesFromWindows`(`wsl --list` UTF-16LE) | 随使用持续确认 |
| 系统托盘 | Linux 用 libNativeWrapper.so appindicator;Windows 等价物 | 随使用持续确认 |

## 裁定

- **CI 打包链:GO** — electrobun 能在 windows-latest 成功打包出便携 zip + 自更新元数据,核心技术风险(项目从未在 windows 验证 electrobun 打包)已消除。
- **完整 GATE:GO** — 用户在真实 Windows 桌面实测 spike artifact 可正常启动运行;**放行 G1**(把默认发布切 electrobun)。扫描 / WSL 源探测 / 托盘 / zstd 等功能项随后续日常使用持续确认,非阻塞。

## Follow-up(用户提出)

- **Windows 默认产物应为真 portable,而非自解压 Setup**:electrobun win 默认产 `cc-session-manager-gui-Setup.zip`(内含自解压器 Setup.exe),解压后是安装器而非「解压即跑的目录」。用户期望默认 portable。需研究 electrobun 是否支持 portable 输出,或直接打包 `build/stable-win-x64/<app>/` 目录成 zip 绕过 self-extracting。后续单独处理。
