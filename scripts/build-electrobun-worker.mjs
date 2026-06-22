// 预构建 Electrobun 扫描 worker 的独立自包含 bundle。
//
// 背景:electrobun build 只打包单一 bun.entrypoint(src/bun/index.ts),不产独立 worker chunk。
// 若 worker 复用主 bundle(self-referential),worker 线程会连带起 electrobun 的 RPC server,
// 与主进程在 50000 端口冲突。故在此用 Bun.build 把 src/bun/scanWorker.ts 单独打成不含 electrobun
// 的自包含 bundle,由 electrobun.config.ts 的 build.copy 拷进 Resources/app/bun/scanWorker.js。
// ElectrobunScanRunner 在运行时以 import.meta.dir + 'scanWorker.js' 定位并加载它。
//
// alias:与 electrobun.config.ts 同规则,把 @shared/* 映射到 src/shared/*(Bun.build 不读 tsconfig paths)。
import { join, dirname } from 'node:path'

// 项目根 = scripts/ 的父目录。用 dirname 跨平台取父目录,勿用正则去尾(Windows 路径分隔符为反斜杠,
// 硬编码 /scripts$ 的正则在 Windows 上不匹配 → root 误指向 scripts/ 自身,致 src/bun 解析失败)。
const root = dirname(import.meta.dir)

const sharedAlias = {
  name: 'shared-alias',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: join(root, 'src', 'shared', args.path.slice('@shared/'.length)) + '.ts',
    }))
  },
}

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'bun', 'scanWorker.ts')],
  outdir: join(root, 'build-worker'),
  target: 'bun',
  naming: 'scanWorker.js',
  plugins: [sharedAlias],
})

if (!result.success) {
  console.error('[build-worker] FAILED')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log('[build-worker] OK ->', join(root, 'build-worker', 'scanWorker.js'))
