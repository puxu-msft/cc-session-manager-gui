import { parentPort, workerData } from 'node:worker_threads'
import { scanAll } from './core/scanner'
import { hostPathForCwd, type CwdHostMap } from './core/pathCodec'
import { buildReuse, type SessionRowShape } from './db/rowMap'

// 扫描 worker:把 ~/.claude/projects 的全量扫描(可能读取数 GB jsonl)放到独立线程,避免阻塞主进程与窗口。
// 入参经 workerData 传入:projectsRoot 与 DB 现有行(用于增量复用未变文件)。中断由主进程 worker.terminate() 实现。
interface WorkerInput { projectsRoot: string; existingRows: SessionRowShape[]; cwdHostMap?: CwdHostMap }

async function run(): Promise<void> {
  const { projectsRoot, existingRows, cwdHostMap } = workerData as WorkerInput
  const result = await scanAll(projectsRoot, {
    reuse: buildReuse(existingRows),
    onProgress: (done, total, path) => parentPort!.postMessage({ type: 'progress', done, total, path }),
    hostPath: (cwd) => hostPathForCwd(cwd, cwdHostMap),
  })
  parentPort!.postMessage({ type: 'done', projects: result.projects, sessions: result.sessions })
}

run().catch((e) => parentPort!.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
