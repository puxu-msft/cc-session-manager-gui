import { isMainThread } from 'node:worker_threads'
import { runScanWorker } from '../main/platform/electrobun/scanWorkerMain'

// Electrobun 独立扫描 worker 入口。
//
// 为什么独立:若让 worker 复用主 bun bundle(self-referential),worker 线程会连带执行
// electrobun 框架顶层副作用(在 50000 端口起 RPC server),与主进程 server 端口冲突。
// 故把 worker 打成**不含 electrobun**的自包含 bundle(scripts/build-electrobun-worker.mjs 用
// Bun.build 产出,copy 进 Resources/app/bun/scanWorker.js),scanRunner 加载它。
//
// 本入口只 import scanWorkerMain(→ core/scanner + db/rowMap),零 electrobun 依赖。
// isMainThread 守卫只是防御性的:本文件仅作为 worker 入口被加载,正常不会在主线程执行。
if (!isMainThread) {
  void runScanWorker()
}
