import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/core/**', 'src/main/db/**'],
      exclude: ['**/*.test.ts', 'src/main/db/schema.ts'],
    },
  },
  resolve: { alias: { '@shared': resolve('src/shared') } },
})
