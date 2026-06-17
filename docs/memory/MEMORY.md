# 记忆索引

本目录(`docs/memory/`,项目记忆的符号链接,受版本控制)**只存跨项目可迁移的技术踩坑**。其余内容各有其主属地,本文件仅留单行指针、不复述:

- **协作原则 / 工程纪律**(用中文回复、问题≠指令、永远没有不值当、逻辑与 UI 分离、验证看真实信号)→ 见项目根 [CLAUDE.md](../../CLAUDE.md)(始终在上下文)。
- **项目说明 / 用法 / 完整文档目录 / 双运行时改造进度**(Bun+Electrobun 默认 / Electron 兼容,Phase 0 已裁定 go)→ 见 [README.md](../../README.md) 「## 文档」。

## 可迁移技术记忆

- [WSL Electron 不弹窗坑](wsl-electron-run-as-node-leak.md) — `ELECTRON_RUN_AS_NODE` 经 WSLENV 从 Windows 泄漏致 GUI 不启动,须清空(设 `0` 无效)
- [原生模块 ABI 必须匹配测试运行时](native-module-abi-test-runtime.md) — `NODE_MODULE_VERSION` 不匹配是 ABI 问题非代码回归,按测试运行时 rebuild,别在两套 ABI 间横跳
- [Electron preload 需 .cjs](electron-preload-cjs-under-type-module.md) — type:module 下 preload 输出 .js 致 window.api 全 undefined;含 headless 桥接验证探针
