// Electrobun(Bun)打包专用的 zstd-napi 占位实现。
//
// 背景:core/tarPack.ts 静态 import zstd-napi(Node 原生模块,带 build/Release/binding.node)。
// 它经 ipc.ts → archiver → tarPack 被拉进 bun 主进程 bundle,导致整个 bundle 在加载期就因
// 解析 binding.node 失败而崩溃(连窗口都起不来)。归档相关通道并非本里程碑(Phase 2)的核心验证项
// (核心是 sources/index/sessions/refresh),故此处用占位顶掉 zstd-napi,让 bundle 可加载、
// 核心通道可跑;仅当真正触发归档/快照(archive:*)时才抛出明确错误。
//
// TODO(Phase 3):用 Bun 原生 zstd(Bun.zstdCompressSync/DecompressSync)实现等价的流式
// CompressStream/DecompressStream,或将 tarPack 抽象为运行时无关的压缩接口经 Platform 注入,
// 使归档通道在 Electrobun 下也可用。
const NOT_SUPPORTED = 'archive (zstd) 暂未在 Electrobun 运行时下接通(Phase 3 TODO);请用 Electron 运行时执行归档/快照操作。'

export class CompressStream {
  setParameters(): void { throw new Error(NOT_SUPPORTED) }
  compress(): Uint8Array { throw new Error(NOT_SUPPORTED) }
  compressChunk(): Uint8Array { throw new Error(NOT_SUPPORTED) }
  flush(): Uint8Array { throw new Error(NOT_SUPPORTED) }
  end(): Uint8Array { throw new Error(NOT_SUPPORTED) }
}

export class DecompressStream {
  decompress(): Uint8Array { throw new Error(NOT_SUPPORTED) }
  decompressChunk(): Uint8Array { throw new Error(NOT_SUPPORTED) }
  flush(): Uint8Array { throw new Error(NOT_SUPPORTED) }
  end(): Uint8Array { throw new Error(NOT_SUPPORTED) }
}

export default { CompressStream, DecompressStream }
