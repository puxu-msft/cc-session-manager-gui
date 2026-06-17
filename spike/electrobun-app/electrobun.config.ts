import type { ElectrobunConfig } from 'electrobun'

// config 字段以官方 hello-world 模板 + llms.txt API 参考为准。
// view 入口为 React 19 的 index.tsx,Electrobun 经 Bun.build 打包为 index.js。
// linux.bundleCEF 先取 false(系统 webkit2gtk-4.1 运行库已装齐),
// 若 WSLg 下 WebKitGTK 起窗失败,改 true 用内置 CEF 重试。
export default {
  app: {
    name: 'spike',
    identifier: 'dev.spike.probe',
    version: '0.0.1',
  },
  build: {
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    views: {
      mainview: {
        entrypoint: 'src/mainview/index.tsx',
      },
    },
    copy: {
      'src/mainview/index.html': 'views/mainview/index.html',
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig
