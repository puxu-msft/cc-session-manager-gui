---
name: better-sqlite3-electron-abi-npm-test
description: "npm test 用 Electron runner,better-sqlite3 必须编译成 Electron ABI,否则 NODE_MODULE_VERSION 不匹配整片失败"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 57880d5f-a5d5-4d0e-8a8d-8694e3458804
---

本项目 `npm test` = `node scripts/test-electron.mjs run`,在 **Electron(当前 42.4.0,ABI 146)** 下跑 vitest。`better-sqlite3` 是原生模块,必须为 Electron ABI 编译,否则所有触达 DB 的测试报 `NODE_MODULE_VERSION 137 vs 146` / `Module did not self-register` 整片失败(并非代码回归)。

**正确 rebuild(任选其一):**
- `npm run rebuild`(= `electron-builder install-app-deps`)
- `npx @electron/rebuild -f -w better-sqlite3 -v 42.4.0`

**陷阱:** 用 system node 的 `npm rebuild better-sqlite3` 会把它编译成 system ABI(137),让 `npm test` 整片失败;反之 Electron ABI 下 `npx vitest run`(裸 node)也会失败。两者会横跳。判断回归还是 ABI:看错误是不是 `NODE_MODULE_VERSION` —— 是就 rebuild,别改代码。参见 [[wsl-electron-run-as-node-leak]]。
