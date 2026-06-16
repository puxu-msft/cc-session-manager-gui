---
name: electron-preload-cjs-under-type-module
description: "type:module 项目里 Electron preload 必须输出 .cjs,否则 window.api 全程 undefined"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7f530cdf-dc1b-4af8-b161-31f258651177
---

在 `package.json` 为 `"type":"module"` 的 Electron(electron-vite)项目里,preload 脚本若以 **CJS 格式输出成 `.js`**,运行时会被当 ESM 解析并报 **`require is not defined in ES module scope`**,导致 **preload 整体加载失败 → `window.api`(contextBridge 暴露的 API)全程 undefined**。表现:UI 看似启动正常,但每个 `window.api.X` 调用在渲染层静默抛错,功能全不可用(如目录浏览卡"加载中"、刷新卡住无进展),而主进程日志一切正常。

**修复:** preload 输出为 `.cjs`(electron-vite:`build.rollupOptions.output = { format: 'cjs', entryFileNames: '[name].cjs' }`),并让 main 的 `webPreferences.preload` 指向 `index.cjs`。

**验证纪律(关键教训):** 验证 Electron 应用不能只看主进程是否启动——**必须看渲染层 console**。headless 下可在 main 里临时 `win.webContents.on('console-message', …)` 转发渲染层日志,或 `win.webContents.executeJavaScript('Object.keys(window.api||{})')` 探针确认桥接完整。只确认"app 启动了"会漏掉渲染层↔主进程桥断裂这类 bug。参见 [[separate-logic-from-ui]]、[[wsl-electron-run-as-node-leak]]。