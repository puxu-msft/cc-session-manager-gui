---
name: native-module-abi-test-runtime
description: "原生模块的 ABI 必须匹配跑测试的运行时;NODE_MODULE_VERSION 不匹配是 ABI 问题而非代码回归"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 57880d5f-a5d5-4d0e-8a8d-8694e3458804
---

通用诊断启发式(任何「原生模块 + 测试运行时与构建运行时不同」的场景):原生模块(如 better-sqlite3 等带 `.node` 二进制的包)必须为**实际运行它的那个运行时的 ABI** 编译。当测试不跑在系统 Node 上、而跑在另一运行时(典型:Electron 自带的 Node,其 ABI 不对应任何独立发布的 Node 版本)时,二者 ABI(`NODE_MODULE_VERSION`)不同,触达该模块的测试会整片报 `NODE_MODULE_VERSION X vs Y` / `Module did not self-register`。

**判据:看到 `NODE_MODULE_VERSION` 不匹配 = ABI 问题,不是代码回归 → 按测试运行时 rebuild 该模块,别去改代码。**

**横跳坑:** 用一个运行时 rebuild 会满足它、却破坏另一个。例:用系统 node 的 `npm rebuild <mod>` 编成系统 ABI,会让跑在 Electron 运行时的测试整片失败;反过来用 Electron ABI 编译后,裸 `node`/`npx vitest` 又会失败。所以必须固定「测试跑在哪个运行时」并只为该运行时保留一份编译,不要在两套 ABI 之间来回横跳。各项目具体的 rebuild 命令与运行时配置属实现细节,记在项目 README,不在此重复。相邻坑见 [[wsl-electron-run-as-node-leak]]。
