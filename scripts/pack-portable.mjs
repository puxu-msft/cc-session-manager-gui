// 从 electrobun stable 全量包 tar.zst 还原真应用目录,打成 portable zip(解压即跑)。
//
// 背景:`electrobun build --env=stable` 会把真应用目录删掉、换成自解压 Setup 壳(electrobun 无产
// portable 的开关)。但真目录内容被 tar 进了 `artifacts/<prefix>-<app>.tar.zst`(与全量更新包同源)。
// 本脚本从该 tar.zst 还原真目录并打成 portable zip——解压到任意位置双击 `bin/launcher.exe` 即可运行
// (launcher 相对 execPath 定位,无注册表/绝对安装路径依赖;唯一外部依赖 WebView2 Runtime,Setup 版亦然)。
//
// 跨平台:zstd 解压用 Bun 内置 node:zlib(`createZstdDecompress`,与 `platform/electrobun/zstdShim.ts`
// 同源,产物标准 zstd);tar 解包用 `tar` 库;zip 打包用系统命令(Windows=`Compress-Archive`,其它=`zip`)。
//
// 用法:
//   bun run scripts/pack-portable.mjs [artifactsDir]
// 默认 artifactsDir=artifacts。自动找其中唯一 `*.tar.zst`,输出同目录 `<同名>-portable.zip`
// (如 stable-win-x64-cc-session-manager-gui.tar.zst → stable-win-x64-cc-session-manager-gui-portable.zip)。
import { createReadStream, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { extract } from 'tar'

const artifactsDir = process.argv[2] || 'artifacts'
if (!existsSync(artifactsDir)) {
  console.error(`[pack-portable] 目录不存在: ${artifactsDir}(应先跑 electrobun build --env=stable)`)
  process.exit(1)
}

// 找唯一 tar.zst(electrobun stable 全量包)。
const zsts = readdirSync(artifactsDir).filter((f) => f.endsWith('.tar.zst'))
if (zsts.length !== 1) {
  console.error(`[pack-portable] 期望 ${artifactsDir} 下唯一 *.tar.zst,实得 ${zsts.length}: ${zsts.join(', ')}`)
  process.exit(1)
}
const tarZst = join(artifactsDir, zsts[0])
const outZip = resolve(join(artifactsDir, zsts[0].replace(/\.tar\.zst$/, '-portable.zip')))

const stage = mkdtempSync(join(tmpdir(), 'portable-'))
try {
  // 1. tar.zst → zstd 解压 → tar 解包到 stage/
  await pipeline(createReadStream(tarZst), createZstdDecompress(), extract({ cwd: stage }))

  // 2. 真目录 = stage 下唯一顶层目录(electrobun tar 顶层为 <appFileName>/)。
  const tops = readdirSync(stage, { withFileTypes: true }).filter((d) => d.isDirectory())
  if (tops.length !== 1) {
    console.error(`[pack-portable] 期望解出唯一顶层目录,实得 ${tops.length}: ${tops.map((t) => t.name).join(', ')}`)
    process.exit(1)
  }
  const appDir = join(stage, tops[0].name)

  // 3. 打 zip:根为 appDir 内容(解压即见 bin/ Resources/,无多余目录层)。
  rmSync(outZip, { force: true })
  const isWin = process.platform === 'win32'
  const r = isWin
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${outZip}' -Force`], { stdio: 'inherit' })
    : spawnSync('bash', ['-c', `cd '${appDir}' && zip -qr '${outZip}' .`], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[pack-portable] zip 失败(status=${r.status})`)
    process.exit(1)
  }
  console.log(`[pack-portable] OK -> ${outZip}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
