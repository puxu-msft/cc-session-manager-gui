# 实现计划:Windows host 检测运行中 WSL 作为完整数据源

**日期:** 2026-06-22
**设计真相源(冻结 spec):** `docs/superpowers/specs/2026-06-22-wsl-source-from-windows-host-design.md`
**完整规划与对抗审查收敛过程:** 见会话计划文件(两轮四/二方对抗审查)。本文件定格实现切分。

## Phase 1 — 异步探测 + 扫描(读) ✅ 已实现(纯函数单测在非 Windows 跑绿;真机验证待 Windows host)

落点全部在既有抽象内,下游 scanner/getEnv/per-source DB 复用:

1. **Source 模型**([src/main/sources.ts](../../../src/main/sources.ts)):新增三个正交不变量 `osFamily`(OS 家族,承载用户移动规则)+ `fsAnchor`(物理文件系统身份,rename 安全)+ `claudeHomeCwd`(POSIX 会话视角);`localSource`/`buildWslSources` 统一产出;`deriveClaudePaths(claudeHome, join)` 按 path 实现派生(本机 OS join / WSL win32.join)。
2. **纯函数**(注入式可测):`wslPathToUnc(distro, posixPath, prefix)`(win32,normalize 后断言前缀防穿越)、`wslAnchor`、`isValidDistroName`(拒 `\` `/` `..` `$` 控制符/空白)、`isCleanPosixAbs`、`buildWslSources(probes, prefix)`(三分:unc 原名 / id=`wsl-<sanitize>` 确定性 hash 去碰撞 / label 原名;仅产 exists)。
3. **异步薄 wrapper**(不写单测,对齐 `windowsHome` 现状):`listRunningWslDistros`(`wsl --list --verbose`,buffer→utf16le→去 BOM/剔 \0→仅 Running+VERSION 2→白名单+工具发行版跳过)、`probeWslDistro`(`wsl --exec sh -c` 一次拿 HOME + `/home/*` 命中,UTF-8;`/mnt/*` HOME 跳过;回退取 `/home/*` 防 root 漏源)、`detectWslSourcesFromWindows`(win32 守卫,并发探测)。
4. **同步路径不卡死**:`detectSources()` 同步只返回 local;WSL 经 [appState.refreshSources()](../../../src/main/appState.ts) 异步 in-place 并入(移除旧 `wsl-*` 再 push,不重赋值)。
5. **async request/response(不走广播)**:[ipc.ts](../../../src/main/ipc.ts) `sources:refresh` async handler await 探测返回完整列表;两套 preload([preload/index.ts](../../../src/preload/index.ts)、[main.electrobun.tsx](../../../src/renderer/main.electrobun.tsx))加 `refreshSources`;[state.ts](../../../src/renderer/state.ts) `refreshSources`+`detectingSources`;[App.tsx](../../../src/renderer/App.tsx) 挂载自动调 + 源条「重新检测源」按钮。
6. **Env 投影**:`Env` 接口 + `getEnv()` 投影 osFamily/fsAnchor/claudeHomeCwd(守卫取值,Phase 2 用)。
7. **测试**:[sources.test.ts](../../../src/main/sources.test.ts) 注入式 17 条(校验/wslPathToUnc 穿越/buildWslSources 去碰撞/exists 过滤/派生不变量);全量 160 通过、tsc 归零。

### Phase 1 真机验证(待 Windows host,我在 WSL 内无法跑)
双运行时各验 `wsl.exe` spawn + UTF-16LE 解码(Bun+Windows 单列探针,必要时给 `%SystemRoot%\System32\wsl.exe` 全路径);WSL 源自动出现 + 切源扫描真实会话;historyReconciler 同步整读 / scanWorker 在 UNC 上不冻结、可 terminate;默认用户=root 经 UNC 读 `/root/.claude` 的最小可行性。

## Phase 2 — WSL 活动源内移动 / 归档(写) 🔜 待 Windows 真机 spike

1. **spike → spike-results**(矩阵化):复现 `executeMove` 完整破坏序列;rename 同 share 错误码(`safeRename` 仅 EXDEV 退化,9P 或 EPERM/EINVAL/EACCES);symlink 读/写 4 格;含 root-owned ownership/mode 保真。
2. **删 homedir 静默回退**:[mover.ts](../../../src/main/core/mover.ts) 行 57/116-117/206/217/228 的 `?? CLAUDE_JSON()`/`?? TRASH_ROOT()` 改 env 必填即抛。
3. **写后端 fs-facade 逐行覆盖**全部对源 fs 写:mover + archiver + fsMove + **claudeJson.ts + historyJsonl.ts + tarPack.ts**(含 reconcile/undo/恢复路径)。按 fsAnchor 类型注入(本机 node fs / 远程视 spike 走 UNC 直写或 `wsl --exec`)。
4. **跨源守卫双层**:`executeMove`/`restoreVersion` 及恢复路径校验目标**同 osFamily**(产品规则)**且同 fsAnchor**(rename 技术安全),默认拒绝(当前单源内恒真,为 2.B/未来防线);自引用守卫([mover.ts:78](../../../src/main/core/mover.ts))与 [fsBrowser.ts:13](../../../src/main/core/fsBrowser.ts) 锚点改 POSIX `claudeHomeCwd`。
5. **测试回归**:`mover.preview.test.ts` 4 例补 `claudeJsonPath`(env 必填化);`mover.{execute,preview,reconcile,rollback}` / `archiver.*` 补 fsAnchor 字段 + 跨 anchor 拒绝用例。
