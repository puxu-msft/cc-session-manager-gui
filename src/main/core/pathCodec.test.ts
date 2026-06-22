import { describe, it, expect } from 'vitest'
import { encodePath, reRoot, hostPathForCwd, cwdHostMapFor } from './pathCodec'

describe('encodePath', () => {
  it('把非字母数字字符替换为 -,不折叠', () => {
    expect(encodePath('/home/xp/src/wmm-quiz')).toBe('-home-xp-src-wmm-quiz')
    expect(encodePath('/home/xp/.codex')).toBe('-home-xp--codex')   // / 和 . 各产生一个 -
    expect(encodePath('/home/xp/.claude')).toBe('-home-xp--claude')
  })
})

describe('reRoot', () => {
  const src = '/home/xp/refs/openvmm', dst = '/home/data/openvmm'
  it('等于源根 → 改成目标根', () => expect(reRoot(src, src, dst)).toBe(dst))
  it('源根之下 → 前缀重定位', () =>
    expect(reRoot(src + '/crates/x', src, dst)).toBe(dst + '/crates/x'))
  it('源根之外 → 原样保留', () => {
    expect(reRoot('/tmp', src, dst)).toBe('/tmp')
    expect(reRoot('/home/xp/.cache/y', src, dst)).toBe('/home/xp/.cache/y')
  })
  it('不把前缀相似但非子目录的当作命中', () =>
    expect(reRoot('/home/xp/refs/openvmm-extra', src, dst)).toBe('/home/xp/refs/openvmm-extra'))
})

describe('cwdHostMapFor', () => {
  it('同族 → identity', () => {
    expect(cwdHostMapFor(true, 'windows', 'C:\\Users\\xp')).toEqual({ kind: 'identity' })   // Windows host + 本机
    expect(cwdHostMapFor(false, 'posix', '/home/xp')).toEqual({ kind: 'identity' })          // posix host + 本机
  })
  it('posix 源在 Windows host → posixToUnc(anchor=fsAnchor)', () => {
    expect(cwdHostMapFor(true, 'posix', '\\\\wsl.localhost\\Ubuntu'))
      .toEqual({ kind: 'posixToUnc', anchor: '\\\\wsl.localhost\\Ubuntu' })
  })
  it('windows 源在 posix host → winToMnt', () => {
    expect(cwdHostMapFor(false, 'windows', '/mnt/c/Users/xp')).toEqual({ kind: 'winToMnt' })
  })
})

describe('hostPathForCwd', () => {
  it('identity / 缺省:原样返回', () => {
    expect(hostPathForCwd('/home/xp/proj')).toBe('/home/xp/proj')
    expect(hostPathForCwd('C:\\Users\\xp', { kind: 'identity' })).toBe('C:\\Users\\xp')
  })
  it('posixToUnc:POSIX cwd → UNC(修复 Windows 上 WSL 源误判路径不存在)', () => {
    const map = { kind: 'posixToUnc', anchor: '\\\\wsl.localhost\\Ubuntu-24.04' } as const
    expect(hostPathForCwd('/home/xp/proj', map)).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\xp\\proj')
    expect(hostPathForCwd('/mnt/c/Users/xp', map)).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\mnt\\c\\Users\\xp')
    expect(hostPathForCwd('C:\\x', map)).toBe('C:\\x')   // 非 POSIX 绝对路径不映射
  })
  it('winToMnt:Windows cwd → /mnt(修复 WSL 内 Windows 源误判路径不存在)', () => {
    const map = { kind: 'winToMnt' } as const
    expect(hostPathForCwd('C:\\Users\\xp\\proj', map)).toBe('/mnt/c/Users/xp/proj')
    expect(hostPathForCwd('D:/work/x', map)).toBe('/mnt/d/work/x')
    expect(hostPathForCwd('/home/xp', map)).toBe('/home/xp')   // 非 Windows 路径不映射
  })
})
