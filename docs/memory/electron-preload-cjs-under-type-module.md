---
name: electron-preload-cjs-under-type-module
description: "type:module 项目里 Electron preload 必须输出 .cjs,否则 window.api 全程 undefined;含 headless 桥接验证探针"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7f530cdf-dc1b-4af8-b161-31f258651177
---

在 `package.json` 为 `"type":"module"` 的 Electron(electron-vite)项目里,preload 脚本若以 **CJS 格式输出成 `.js`**,运行时会被当 ESM 解析并报 **`require is not defined in ES module scope`**,导致 **preload 整体加载失败 → `window.api`(contextBridge 暴露的 API)全程 undefined**。表现:UI 看似启动正常,但每个 `window.api.X` 调用在渲染层静默抛错,功能全不可用(如目录浏览卡"加载中"、刷新卡住无进展),而主进程日志一切正常。

**修复:** preload 输出为 `.cjs`(electron-vite:`build.rollupOptions.output = { format: 'cjs', entryFileNames: '[name].cjs' }`),并让 main 的 `webPreferences.preload` 指向 `index.cjs`。

**headless 下确认桥接完整的具体探针手法**(承「验证要看真实信号」原则,见 CLAUDE.md「工程纪律」):在 main 里临时 `win.webContents.on('console-message', …)` 把渲染层日志转发到主进程终端,或 `win.webContents.executeJavaScript('Object.keys(window.api||{})')` 直接探测桥接对象是否完整。只确认「app 启动了」会漏掉渲染层↔主进程桥断裂这类 bug。相邻坑见 [[wsl-electron-run-as-node-leak]]。