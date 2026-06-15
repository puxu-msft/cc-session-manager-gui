import { describe, it, expect } from 'vitest'
import { encodePath, reRoot } from './pathCodec'

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
