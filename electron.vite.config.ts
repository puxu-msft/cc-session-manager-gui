import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { external: ['better-sqlite3'] } },
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
