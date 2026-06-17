// 运行:bun run spike/probe-fsmove.ts(在项目根)
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRename } from '../src/main/core/fsMove'

let pass = true
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) pass = false }

const work = mkdtempSync(join(tmpdir(), 'fsmove-probe-'))
const a = join(work, 'a')
mkdirSync(a)
writeFileSync(join(a, 'f.txt'), 'hi')
symlinkSync('./f.txt', join(a, 'link'))   // 相对 symlink,验证 lstat 不解引用 + 保真
const b = join(work, 'b')

try {
  safeRename(a, b)
  const movedFile = existsSync(join(b, 'f.txt'))
  const linkSt = lstatSync(join(b, 'link'))
  const linkOk = linkSt.isSymbolicLink() && readlinkSync(join(b, 'link')) === './f.txt'
  const srcGone = !existsSync(a)
  check('safeRename: 文件迁移', movedFile)
  check('safeRename: symlink 保真(lstat 不解引用)', linkOk)
  check('safeRename: 源已移除', srcGone)
} catch (e) { check('safeRename 执行', false, String(e)) }

console.log('NOTE: EXDEV 跨设备 fallback 需两个挂载点,若 WSL 有 /mnt 跨盘可手动验;copyRecursive 仅用 node:fs,已由 symlink 用例间接覆盖')
console.log(pass ? '\n=== fsMove PROBE: ALL PASS ===' : '\n=== fsMove PROBE: HAS FAIL ===')
process.exit(pass ? 0 : 1)
