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

// zstd-napi 是 Node 原生模块(binding.node),经 core/tarPack 被拉进 bun bundle 会在加载期崩溃
// (dev-guide §5.5)。Phase 3 实测 Bun 1.3.14 内置 node:zlib 的 zstd 流式 API(标准 zstd 格式,
// 与 zstd-napi 跨运行时字节级互读已验证 GO),故把 bun bundle 里 zstd-napi 的解析目标换成
// zstdShim.ts —— 它用 node:zlib 实现等价的流式 CompressStream/DecompressStream,使 archive 通道
// 在 Electrobun 下真正可用,且与 Electron(zstd-napi)产物互读。core/tarPack.ts 零改动。
// 仅作用于 bun 侧;渲染层不 import 它。
const zstdShim: BunPlugin = {
  name: 'zstd-napi-shim',
  setup(build) {
    build.onResolve({ filter: /^zstd-napi$/ }, () => ({
      path: join(import.meta.dir, 'src', 'main', 'platform', 'electrobun', 'zstdShim.ts'),
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
      plugins: [sharedAlias, zstdShim],
    },
    views: {
      mainview: {
        entrypoint: 'src/renderer/main.electrobun.tsx',
        plugins: [sharedAlias],
      },
    },
    copy: {
      'src/renderer/index.electrobun.html': 'views/mainview/index.html',
      // 独立扫描 worker bundle(scripts/build-electrobun-worker.mjs 预构建产物,不含 electrobun)。
      // 拷到 Resources/app/bun/scanWorker.js,ElectrobunScanRunner 以 import.meta.dir + 'scanWorker.js' 定位。
      'build-worker/scanWorker.js': 'bun/scanWorker.js',
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig
