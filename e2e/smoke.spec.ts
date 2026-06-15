import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'

// 端到端冒烟:启动真实打包后的主进程,验证渲染层↔主进程桥(window.api)完整、三栏渲染、右栏真正加载到目录。
// 这一层专门覆盖单元测试照不到的 Electron/IPC/渲染集成——例如 preload 加载失败导致 window.api 全 undefined 这类 bug。
// 前置:先 `npm run build` 产出 out/。env 清空 ELECTRON_RUN_AS_NODE 避免 WSL 下以 node 模式启动;--no-sandbox 适配 WSL/CI。

const EXPECTED_API = [
  'getIndex', 'getSessions', 'refresh', 'listDir', 'makeDir',
  'previewMove', 'executeMove', 'listMoves', 'undoMove',
  'trashUsage', 'purgeTrash', 'onRefreshProgress',
]

let app: ElectronApplication

test.afterEach(async () => { await app?.close() })

test('启动:window.api 完整、三栏渲染、右栏加载目录', async () => {
  app = await electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  })
  const page = await app.firstWindow()

  // 1) preload 桥接完整:window.api 暴露了全部方法(这正是之前漏掉的 bug 的检测点)
  const keys = await page.evaluate(() => Object.keys((window as unknown as { api?: object }).api || {}))
  expect(keys).toEqual(expect.arrayContaining(EXPECTED_API))

  // 2) 三栏标题渲染
  await expect(page.locator('.pane-header', { hasText: '目录 / 项目' })).toBeVisible()
  await expect(page.locator('.pane-header', { hasText: '会话' })).toBeVisible()
  await expect(page.locator('.pane-header', { hasText: '目标目录' })).toBeVisible()

  // 3) 右栏不卡"加载中":真实拿到目录,出现 .(当前目录)行
  await expect(page.locator('.row-title', { hasText: '当前目录' }).first()).toBeVisible({ timeout: 15_000 })
})

test('WSL 下探测到本机+Windows 两个数据源,可切换', async () => {
  app = await electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  })
  const page = await app.firstWindow()

  const sources = await page.evaluate(() => (window as any).api.listSources())
  // 本机一定有;在 WSL 且 Windows 侧存在 .claude 时还会有 windows
  expect(sources.some((s: any) => s.id === 'local')).toBe(true)
  const hasWindows = sources.some((s: any) => s.id === 'windows')

  if (hasWindows) {
    // 源切换条出现两个按钮
    await expect(page.locator('.sourcebar .src')).toHaveCount(sources.length)
    // 切到 Windows,活动源变更
    await page.locator('.sourcebar .src', { hasText: 'Windows' }).click()
    await expect.poll(() => page.evaluate(() => (window as any).api.getSource())).toBe('windows')
  }
})
