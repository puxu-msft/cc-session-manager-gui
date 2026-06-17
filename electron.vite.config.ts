import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'zstd-napi'],
        // 除主进程入口外,额外打包扫描 worker 为同目录下的 scanWorker.js,供 worker_threads 加载。
        input: {
          index: resolve('src/main/index.ts'),
          scanWorker: resolve('src/main/scanWorker.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // 项目是 "type":"module",.js 会被当 ESM 解析,而 preload 是 CJS(用 require)。
        // 故输出为 .cjs,让运行时无歧义按 CommonJS 加载,避免 "require is not defined in ES module scope"。
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
  },
})
