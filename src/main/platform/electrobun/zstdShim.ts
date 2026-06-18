// Electrobun(Bun)运行时下 zstd-napi 的真实替代实现。
//
// 背景:core/tarPack.ts 静态 import zstd-napi 的 CompressStream/DecompressStream,把它们当
// node:stream Transform 直接插进 pipeline(tar.create → CompressStream → writeStream)。
// zstd-napi 是 N-API 原生模块(binding.node),进 Bun.build bundle 会在加载期崩溃(dev-guide §5.5)。
//
// 方案(Phase 3 实测 GO):Bun 1.3.14 内置 node:zlib 的 zstd 流式 API(createZstdCompress/
// createZstdDecompress,Node 22.15+/23.8+ 引入),产出**标准 zstd 格式**。跨运行时互读探针证实:
//   - zstd-napi(Electron)压的 .zst,本 shim(node:zlib)能解,字节级一致;
//   - 本 shim 压的 .zst,zstd-napi 能解,字节级一致;两端压缩产物大小相同。
// 故本 shim 与 zstd-napi 完全互读,electrobun.config.ts 把 zstd-napi 的解析目标换成本文件即可,
// core/tarPack.ts 零改动。
//
// 实现要点:node:zlib 的 createZstdCompress/createZstdDecompress 返回的就是合格的 node:stream
// Transform(内部已正确处理 backpressure)。故不自行桥接背压(易死锁),而是在构造函数内创建真实
// zstd 流并直接返回它 —— JS 构造函数返回对象会替换 this,使 `new CompressStream(params)` 得到的
// 就是底层 zstd Transform 本身,可零额外代码地进 pipeline,流式纪律由 node:zlib 保证。
import { createZstdCompress, createZstdDecompress, constants } from 'node:zlib'
import type { Transform } from 'node:stream'

// zstd-napi 的参数对象形状(core/tarPack 的 ZSTD_PARAMS 即此形状)。
export interface ZstdCompressParams {
  compressionLevel?: number
  enableLongDistanceMatching?: boolean
  nbWorkers?: number
}

// 把 zstd-napi 风格参数映射到 node:zlib zstd 的 params(以 ZSTD_c_* 常量为 key)。
// node:zlib 的 advanced 参数取整数:布尔→1/0。
function toZlibParams(p: ZstdCompressParams): Record<number, number> {
  const params: Record<number, number> = {}
  if (p.compressionLevel != null) params[constants.ZSTD_c_compressionLevel] = p.compressionLevel
  if (p.enableLongDistanceMatching != null) {
    params[constants.ZSTD_c_enableLongDistanceMatching] = p.enableLongDistanceMatching ? 1 : 0
  }
  if (p.nbWorkers != null) params[constants.ZSTD_c_nbWorkers] = p.nbWorkers
  return params
}

// 构造即返回底层 node:zlib zstd Transform(JS 构造函数返回对象替换 this)。
// 类型上声明为 Transform,使用方按 Transform 使用即可。
export class CompressStream {
  constructor(params: ZstdCompressParams = {}) {
    return createZstdCompress({ params: toZlibParams(params) }) as unknown as CompressStream
  }
}

export class DecompressStream {
  constructor() {
    return createZstdDecompress() as unknown as DecompressStream
  }
}

// 供需要直接拿底层流的场景(类型友好),与上面 class 等价。
export const _createCompress = (p: ZstdCompressParams = {}): Transform =>
  createZstdCompress({ params: toZlibParams(p) })
export const _createDecompress = (): Transform => createZstdDecompress()

export default { CompressStream, DecompressStream }
