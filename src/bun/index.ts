import { bootstrap } from '../main/app/bootstrap'
import { ElectrobunAppHost } from '../main/platform/electrobun/app'
import { ElectrobunWindowHost } from '../main/platform/electrobun/window'
import { ElectrobunBridge } from '../main/platform/electrobun/bridge'
import { ElectrobunScanRunner } from '../main/platform/electrobun/scanRunner'
import { electrobunPaths } from '../main/platform/electrobun/paths'
import { createRepository } from '../main/db/repository'
import { BunSqliteDriver } from '../main/platform/electrobun/sqliteDriver'

// Electrobun(Bun)入口。
//
// 重要:electrobun launcher 硬编码加载打包产物 bun/index.js(见 build 产物 main.js:ASAR 与 flat
// 两条路径都取 "bun/index.js"),故本文件 basename 必须为 index —— 放在 src/bun/index.ts(与官方
// hello-world 模板一致)。它只是装配入口,核心实现仍在 src/main/**(经 ../main/ 引入)。
//
// 与 Electron 入口(src/main/index.ts)同样调用通用 bootstrap,共享全部核心逻辑/IPC/渲染层:
//   - dbFactory:bun:sqlite 驱动包进共享 createRepository(Phase 0 spike 验证等价 better-sqlite3)。
//   - scanRunner:node:worker_threads 实现,worker 入口为独立打包的 bun/scanWorker.js
//     (不含 electrobun,避免端口冲突;见 scanRunner.ts / scripts/build-electrobun-worker.mjs)。
//   - windowHost 需 bridge 引用(创建窗口时取 bridge.buildRPC() 并 attachWindow)。
const bridge = new ElectrobunBridge()

try {
  bootstrap({
    appHost: new ElectrobunAppHost(),
    windowHost: new ElectrobunWindowHost(bridge),
    bridge,
    paths: electrobunPaths,
    dbFactory: (file: string) => createRepository(new BunSqliteDriver(file)),
    scanRunner: new ElectrobunScanRunner(),
  })
} catch (e) {
  console.error('[electrobun] bootstrap failed:', e instanceof Error ? (e.stack ?? e.message) : String(e))
}
