// 运行:bun run spike/probe-zstd.ts(在项目根,复用根 node_modules 的 zstd-napi 与 tar)
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, packTree, unpackZst, verifyAgainstManifest } from '../src/main/core/tarPack'

const work = mkdtempSync(join(tmpdir(), 'zstd-probe-'))
const srcDir = join(work, 'src')
mkdirSync(srcDir)
writeFileSync(join(srcDir, 'a.jsonl'), 'x'.repeat(200000)) // 触发 LDM/多线程压缩路径
writeFileSync(join(srcDir, 'b.txt'), 'hello world')
symlinkSync('./b.txt', join(srcDir, 'b.link'))            // 验证 symlink 经 manifest 重建保真

const zst = join(work, 'out.zst')
try {
  const manifest = await buildManifest(work, ['src'])
  await packTree(work, ['src'], zst)        // 触发 CompressStream({level:19, LDM:true, nbWorkers:2})
  const dest = join(work, 'dest')
  mkdirSync(dest)
  await unpackZst(zst, dest)                 // DecompressStream
  // symlink 不在 tar 内,需按 manifest 重建后再校验(对齐 archiver 还原流程)
  const { rebuildSymlinks } = await import('../src/main/core/tarPack')
  rebuildSymlinks(dest, manifest)
  const v = await verifyAgainstManifest(dest, manifest)
  console.log(v.ok
    ? 'PASS zstd-napi roundtrip in Bun (level19 / LDM / nbWorkers2 / symlink 保真)'
    : `FAIL zstd-napi roundtrip  mismatches=${JSON.stringify(v.mismatches)}`)
  console.log(v.ok ? '\n=== zstd PROBE: PASS — Compressor 维持 zstd-napi ===' : '\n=== zstd PROBE: FAIL ===')
  process.exit(v.ok ? 0 : 1)
} catch (e) {
  console.log('FAIL zstd-napi 在 Bun 下加载或运行失败:', String(e))
  console.log('=> 触发 spec §7 Compressor fallback 决策:必须选 zstd 兼容格式(WASM/原生 zstd),禁止退化为异格式(gzip)')
  process.exit(1)
}
