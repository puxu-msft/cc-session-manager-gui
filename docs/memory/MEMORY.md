# 记忆索引

- [中文且不硬换行](chinese-no-hard-wrap-docs.md) — 所有文档/记忆/注释用中文、不做行宽硬换行
- [始终用中文回复](reply-in-chinese.md) — 即使用户说英文也用中文,不用日语
- [问题不是指令](question-not-instruction.md) — 用户问"X 是什么"是提问,别擅自去做 X 或扩大范围
- [WSL Electron 不弹窗坑](wsl-electron-run-as-node-leak.md) — ELECTRON_RUN_AS_NODE 经 WSLENV 泄漏致 GUI 不启动,清空(非设0)即可
- [逻辑与 UI 分离](separate-logic-from-ui.md) — 核心逻辑抽成纯函数以便脱离 UI 单独测试
- [Electron preload 需 .cjs](electron-preload-cjs-under-type-module.md) — type:module 下 preload 输出 .js 致 window.api 全 undefined;验证要看渲染层 console
- [better-sqlite3 的 Electron ABI](better-sqlite3-electron-abi-npm-test.md) — npm test 用 Electron runner,native 模块要按 Electron ABI rebuild,NODE_MODULE_VERSION 报错是 ABI 非回归
- [永远没有"不值当"](always-worth-doing-if-improves.md) — 长远正确/是改善就值得做,别用成本或范围搪塞
