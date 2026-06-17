// 运行:bun run spike/probe-worker.ts(在项目根)
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

let pass = true
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) pass = false }

const w = new Worker(join(import.meta.dir, 'probe-worker-child.ts'), { workerData: { n: 42 } })
const msg = await new Promise<{ type: string; n: number } | null>((resolve) => {
  const t = setTimeout(() => resolve(null), 3000)
  w.on('message', (m) => { clearTimeout(t); resolve(m) })
  w.on('error', () => { clearTimeout(t); resolve(null) })
})
check('workerData + parentPort.postMessage', msg?.type === 'progress' && msg?.n === 42, JSON.stringify(msg))

const start = Date.now()
await w.terminate()
check('terminate() returns (no hang)', Date.now() - start < 2000)

console.log(pass ? '\n=== worker_threads PROBE: ALL PASS ===' : '\n=== worker_threads PROBE: HAS FAIL (考虑改 Bun Worker fallback) ===')
process.exit(pass ? 0 : 1)
