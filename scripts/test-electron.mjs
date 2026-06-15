// 用 Electron 自带的 Node 运行时(NODE_MODULE_VERSION 146)来跑 vitest。
// 这样原生模块 better-sqlite3 只需保留一份按 Electron ABI 编译的构建,既能被 Electron app 加载,也能被测试加载,无需在两套 ABI 之间来回重建。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron') // electron 包默认导出其可执行文件的绝对路径

// vitest 的 package exports 不暴露 vitest.mjs 子路径,故经 package.json 定位包目录后取 CLI 入口;失败则按本仓库布局兜底。
let vitestBin
try {
  vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
} catch {
  vitestBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'vitest', 'vitest.mjs')
}

const res = spawnSync(electronPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(res.status ?? 1)
