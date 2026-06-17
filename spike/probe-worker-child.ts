import { parentPort, workerData } from 'node:worker_threads'
parentPort!.postMessage({ type: 'progress', n: (workerData as { n: number }).n })
// 保持存活,验证主线程 terminate() 能中断它
setInterval(() => {}, 1000)
