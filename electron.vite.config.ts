import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        external: ['better-sqlite3'],
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
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
  },
})
