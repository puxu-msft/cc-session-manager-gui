---
name: wsl-electron-run-as-node-leak
description: WSL 下 Electron GUI 不弹窗的坑——ELECTRON_RUN_AS_NODE 经 WSLENV 从 Windows 泄漏进来
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7f530cdf-dc1b-4af8-b161-31f258651177
---

在本用户的 WSL2 环境里,`ELECTRON_RUN_AS_NODE=1` 会经 `WSLENV`(`ELECTRON_RUN_AS_NODE/w:...`)从 Windows 端(通常是 VS Code 注入)泄漏到所有 WSL 进程。它让 `electron` 以**纯 Node 模式**运行、**不弹 GUI 窗口**,表现为 `electron-vite dev` 构建完却没有窗口。

排查特征:`electron --version` 带该变量时打印的是内嵌 Node 版本(如 v24.x),清掉后才打印真实 electron 版本(如 v42.x)。

**修复:启动前清空该变量。**注意 `ELECTRON_RUN_AS_NODE=0` **无效**(electron 用 HasVar 判断,"0" 仍算已设);必须设为**空串**或真正 `unset`。npm 脚本里写 `"dev": "ELECTRON_RUN_AS_NODE= electron-vite dev"`(sh/WSL/mac 通用),或临时 `env -u ELECTRON_RUN_AS_NODE npm run dev`。

另一个相邻坑:agent 沙箱里的 `npm i` 可能因网络受限没下载 electron 二进制(`node_modules/electron/` 缺 `path.txt`/`dist/`),报 "Electron uninstall";在网络正常的真实 shell 里重跑安装即可拉到 ~217MB 二进制。WSLg 提供 `DISPLAY=:0` 图形支持,通常无需额外 X server。
