import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessionFile } from './jsonlScanner'

let dir: string, file: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccm-'))
  file = join(dir, 'sess1.jsonl')
  const lines = [
    { type: 'queue-operation', operation: 'enqueue' },
    { type: 'user', cwd: '/p/root', timestamp: '2026-06-15T10:00:00.000Z', gitBranch: 'main', version: '2.1.0', entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: '第一条问题内容' } },
    { type: 'assistant', cwd: '/p/root', timestamp: '2026-06-15T10:01:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', cwd: '/p/root/sub', timestamp: '2026-06-15T10:02:00.000Z', message: { content: '在子目录' } },
    { type: 'custom-title', sessionId: 's', customTitle: '我的标题' },
  ]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
})

describe('scanSessionFile', () => {
  it('提取核心元数据', async () => {
    const m = await scanSessionFile(file)
    expect(m.cwd).toBe('/p/root')
    expect(m.title).toBe('我的标题')
    expect(m.firstMessagePreview).toBe('第一条问题内容')
    expect(m.startedAt).toBe('2026-06-15T10:00:00.000Z')
    expect(m.lastActivityAt).toBe('2026-06-15T10:02:00.000Z')
    expect(m.messageCount).toBe(3)
    expect(m.lineCount).toBe(5)
    expect(m.gitBranch).toBe('main')
    expect(m.claudeVersion).toBe('2.1.0')
    expect(m.entrypoint).toBe('cli')
    expect(m.distinctCwds.sort()).toEqual(['/p/root', '/p/root/sub'])
    expect(m.hasSidecar).toBe(false)
  })

  it('首条 user 消息为数组 content 时取首个 text 片段作预览', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ccm-arr-'))
    const f = join(d, 's-arr.jsonl')
    writeFileSync(f, [
      JSON.stringify({ type: 'user', cwd: '/x', timestamp: '2026-06-15T10:00:00Z', message: { content: [{ type: 'image' }, { type: 'text', text: '数组里的文本' }] } }),
    ].join('\n') + '\n')
    const m = await scanSessionFile(f)
    expect(m.firstMessagePreview).toBe('数组里的文本')
  })

  it('数组 content 无 text 片段时预览为空串', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ccm-notext-'))
    const f = join(d, 's-notext.jsonl')
    writeFileSync(f, [
      JSON.stringify({ type: 'user', cwd: '/x', timestamp: '2026-06-15T10:00:00Z', message: { content: [{ type: 'image' }] } }),
    ].join('\n') + '\n')
    const m = await scanSessionFile(f)
    expect(m.firstMessagePreview).toBe('')
  })

  it('ai-title 作标题来源,坏行被跳过', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ccm-ai-'))
    const f = join(d, 's-ai.jsonl')
    writeFileSync(f, [
      '{ 这是坏的 JSON 行',
      JSON.stringify({ type: 'user', cwd: '/x', timestamp: '2026-06-15T10:00:00Z', message: { content: '问题' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI 生成标题' }),
    ].join('\n') + '\n')
    const m = await scanSessionFile(f)
    expect(m.title).toBe('AI 生成标题')
    expect(m.firstMessagePreview).toBe('问题')
  })
})
