import type { ElectrobunConfig } from 'electrobun'
import type { BunPlugin } from 'bun'
import { join } from 'node:path'

// Bun 打包不读取 tsconfig 的 paths(electrobun CLI 在 node_modules 内调 Bun.build,cwd 不同),
// 因此用一个解析插件把 @shared/* 映射到项目内 src/shared/*,使核心层的 '@shared/...' import 在
// 两运行时下都能解析(electron-vite 侧由 tsconfig paths 处理,这里给 Bun 侧补上等价规则)。
const sharedAlias: BunPlugin = {
  name: 'shared-alias',
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: join(import.meta.dir, 'src', 'shared', args.path.slice('@shared/'.length)) + '.ts',
    }))
  },
}

// zstd-napi 是 Node 原生模块(binding.node),经 core/tarPack 被拉进 bun bundle 会在加载期崩溃。
// 归档通道非本里程碑核心项,故在 bun(主进程)bundle 里把 zstd-napi 顶成占位实现(见 zstdStub.ts)。
// 仅作用于 bun 侧;渲染层不 import 它。
const zstdStub: BunPlugin = {
  name: 'zstd-napi-stub',
  setup(build) {
    build.onResolve({ filter: /^zstd-napi$/ }, () => ({
      path: join(import.meta.dir, 'src', 'main', 'platform', 'electrobun', 'zstdStub.ts'),
    }))
  },
}

// Electrobun 双运行时配置(Phase 2)。
// 与 Electron 路径完全平行:bun.entrypoint 装配 Bun 平台并启动;views.mainview 打包生产渲染层。
//   - bun.entrypoint:src/main/entry.electrobun.ts(装配 ElectrobunAppHost/WindowHost/Bridge + bun:sqlite)
//   - views.mainview.entrypoint:src/renderer/main.electrobun.tsx(注入 window.api adapter 后渲染生产 App)
//     Electrobun 内部 Bun.build 把它打包为 views/mainview/index.js,html 引用该产物。
//   - copy:把 view 的 html 拷到 views/mainview/index.html(html 引用编译产物 index.js)。
//   - bundleCEF:false —— WSL 系统 webkit2gtk-4.1 已装齐(Phase 0 实测起窗 OK)。
export default {
  app: {
    name: 'cc-move-session',
    identifier: 'com.local.cc-move-session',
    version: '0.1.0',
  },
  build: {
    bun: {
      // 入口 basename 必须为 index(launcher 硬编码加载 bun/index.js);装配逻辑在 src/bun/index.ts。
      entrypoint: 'src/bun/index.ts',
      plugins: [sharedAlias, zstdStub],
    },
    views: {
      mainview: {
        entrypoint: 'src/renderer/main.electrobun.tsx',
        plugins: [sharedAlias],
      },
    },
    copy: {
      'src/renderer/index.electrobun.html': 'views/mainview/index.html',
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig
