import { defineConfig } from '@playwright/test'

// Electron 端到端冒烟测试配置(不需要浏览器,只驱动 Electron 自身)。
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'list',
})
