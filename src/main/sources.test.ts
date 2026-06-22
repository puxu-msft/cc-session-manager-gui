import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  winPathToWsl, detectSources,
  wslPathToUnc, wslAnchor, isValidDistroName, isCleanPosixAbs, buildWslSources, parseWslListVerbose,
  type WslProbe,
} from './sources'

describe('winPathToWsl', () => {
  it('C:\\Users\\foo → /mnt/c/Users/foo', () => {
    expect(winPathToWsl('C:\\Users\\foo')).toBe('/mnt/c/Users/foo')
  })
  it('小写盘符与正斜杠也能处理', () => {
    expect(winPathToWsl('D:/work/x')).toBe('/mnt/d/work/x')
  })
  it('非 Windows 路径返回 null', () => {
    expect(winPathToWsl('/home/xp')).toBeNull()
    expect(winPathToWsl('')).toBeNull()
  })
})

describe('detectSources', () => {
  it('始终包含本机源,projectsRoot 指向 ~/.claude/projects', () => {
    const s = detectSources()
    expect(s.length).toBeGreaterThanOrEqual(1)
    const local = s.find((x) => x.id === 'local')!
    expect(local.projectsRoot).toBe(join(homedir(), '.claude', 'projects'))
    expect(local.claudeJsonPath).toBe(join(homedir(), '.claude.json'))
    expect(local.trashRoot).toBe(join(homedir(), '.claude', '.cc-session-manager-trash'))
  })
  it('每个 source 含由 claudeHome 派生的 historyJsonlPath', () => {
    for (const s of detectSources()) {
      expect(s.historyJsonlPath).toMatch(/\.claude[\/\\]history\.jsonl$/)
      expect(s.historyJsonlPath.replace(/history\.jsonl$/, 'projects')).toBe(s.projectsRoot)
    }
  })
  it('本机源带 fsAnchor=claudeHome、claudeHomeCwd=homedir、osFamily=posix(非 win32)', () => {
    const local = detectSources().find((x) => x.id === 'local')!
    expect(local.fsAnchor).toBe(homedir())
    expect(local.claudeHomeCwd).toBe(homedir())
    expect(local.osFamily).toBe(process.platform === 'win32' ? 'windows' : 'posix')
  })
})

describe('isValidDistroName', () => {
  it('接受正常发行版名', () => {
    expect(isValidDistroName('Ubuntu-24.04')).toBe(true)
    expect(isValidDistroName('Debian')).toBe(true)
  })
  it('拒绝含分隔符/穿越/控制符/$/空白的名字(防 UNC 穿越)', () => {
    expect(isValidDistroName('Ubuntu\\..\\..\\c$')).toBe(false)
    expect(isValidDistroName('a/b')).toBe(false)
    expect(isValidDistroName('..')).toBe(false)
    expect(isValidDistroName(' Ubuntu')).toBe(false)
    expect(isValidDistroName('wsl$')).toBe(false)
    expect(isValidDistroName('a\x01b')).toBe(false)
    expect(isValidDistroName('')).toBe(false)
  })
})

describe('isCleanPosixAbs', () => {
  it('接受干净绝对 POSIX 路径', () => {
    expect(isCleanPosixAbs('/home/xp')).toBe(true)
    expect(isCleanPosixAbs('/root')).toBe(true)
  })
  it('拒绝相对/含穿越/盘符/反斜杠', () => {
    expect(isCleanPosixAbs('home/xp')).toBe(false)
    expect(isCleanPosixAbs('/home/../etc')).toBe(false)
    expect(isCleanPosixAbs('/C:/x')).toBe(false)
    expect(isCleanPosixAbs('/home\\xp')).toBe(false)
  })
})

describe('wslPathToUnc', () => {
  it('/home/xp → \\\\wsl.localhost\\<distro>\\home\\xp', () => {
    expect(wslPathToUnc('Ubuntu-24.04', '/home/xp')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\xp')
  })
  it('支持旧式 \\\\wsl$ 前缀', () => {
    expect(wslPathToUnc('Debian', '/root', '\\\\wsl$')).toBe('\\\\wsl$\\Debian\\root')
  })
  it('含空格的 home 段保留', () => {
    expect(wslPathToUnc('Ubuntu-24.04', '/home/my user')).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\my user')
  })
  it('非法 distro 或 posixPath 返回 null(穿越防护)', () => {
    expect(wslPathToUnc('a$b', '/home/xp')).toBeNull()
    expect(wslPathToUnc('Ubuntu', '/home/../etc')).toBeNull()
    expect(wslPathToUnc('Ubuntu', 'relative')).toBeNull()
  })
})

describe('wslAnchor', () => {
  it('产出 \\\\wsl.localhost\\<distro>', () => {
    expect(wslAnchor('Ubuntu-24.04')).toBe('\\\\wsl.localhost\\Ubuntu-24.04')
  })
  it('非法名返回 null', () => {
    expect(wslAnchor('a/b')).toBeNull()
  })
})

describe('buildWslSources', () => {
  const probe = (distro: string, home: string, exists: boolean): WslProbe => ({ distro, home, exists })

  it('为 exists 的发行版产出 UNC 源,字段三分正确', () => {
    const [s] = buildWslSources([probe('Ubuntu-24.04', '/home/xp', true)])
    expect(s.id).toMatch(/^wsl-Ubuntu-24\.04-[0-9a-f]{8}$/)   // id = wsl-<sanitize>-<hash>(恒带 hash 防漂移)
    expect(s.label).toBe('Ubuntu-24.04')            // label = 原名
    expect(s.fsAnchor).toBe('\\\\wsl.localhost\\Ubuntu-24.04')
    expect(s.claudeHomeCwd).toBe('/home/xp')        // POSIX 会话视角
    expect(s.osFamily).toBe('posix')                // WSL 源恒为 posix 家族
    expect(s.projectsRoot).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\xp\\.claude\\projects')
    expect(s.exists).toBe(true)
  })

  it('同一 distro 无论在 probes 中的位置/有无邻居,id 都恒定(防跨会话漂移)', () => {
    const a = buildWslSources([probe('Ubuntu(1)', '/home/a', true), probe('Ubuntu-1', '/home/b', true)])
    const b = buildWslSources([probe('Ubuntu-1', '/home/b', true), probe('Ubuntu(1)', '/home/a', true)])
    const idOf = (list: typeof a, label: string) => list.find((s) => s.label === label)!.id
    expect(idOf(a, 'Ubuntu(1)')).toBe(idOf(b, 'Ubuntu(1)'))   // 顺序变,id 不变
    expect(idOf(a, 'Ubuntu-1')).toBe(idOf(b, 'Ubuntu-1'))
  })

  it('exists=false 的发行版被过滤', () => {
    expect(buildWslSources([probe('Ubuntu', '/home/xp', false)])).toHaveLength(0)
  })

  it('含空格/括号的发行版名 sanitize 进 id、原名作 label', () => {
    const [s] = buildWslSources([probe('Ubuntu 22.04 (LTS)', '/home/xp', true)])
    expect(s.label).toBe('Ubuntu 22.04 (LTS)')
    expect(s.id).toMatch(/^wsl-Ubuntu-22\.04--LTS-/)  // 空格/括号→-,且因可能撞名带 hash 后缀
    expect(s.id).not.toMatch(/[ ()]/)                  // id 不含文件名不安全字符
  })

  it('sanitize 后撞 id 的不同发行版用确定性 hash 后缀去碰撞', () => {
    const sources = buildWslSources([
      probe('Ubuntu 1', '/home/a', true),
      probe('Ubuntu-1', '/home/b', true),
    ])
    expect(sources).toHaveLength(2)
    expect(new Set(sources.map((s) => s.id)).size).toBe(2)  // 两个不同 id,不共用 index 库
  })

  it('非法 distro 名/脏 home 被跳过', () => {
    expect(buildWslSources([probe('a$b', '/home/xp', true)])).toHaveLength(0)
    expect(buildWslSources([probe('Ubuntu', '/home/../etc', true)])).toHaveLength(0)
  })

  it('WSL 源也满足 historyJsonlPath 派生不变量(win32)', () => {
    const [s] = buildWslSources([probe('Ubuntu-24.04', '/home/xp', true)])
    expect(s.historyJsonlPath).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\xp\\.claude\\history.jsonl')
    expect(s.trashRoot).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\xp\\.claude\\.cc-session-manager-trash')
  })
})

describe('parseWslListVerbose', () => {
  it('解析标准三列 + * 默认标记', () => {
    const text = '  NAME            STATE     VERSION\r\n* Ubuntu-24.04    Running   2\r\n  Debian          Stopped   2\r\n'
    const rows = parseWslListVerbose(text)
    expect(rows).toEqual([
      { name: 'Ubuntu-24.04', state: 'Running', version: '2' },
      { name: 'Debian', state: 'Stopped', version: '2' },
    ])
  })
  it('含空格的发行版名从右解析正确(不漏源)', () => {
    const rows = parseWslListVerbose('* Ubuntu 22.04 LTS    Running   2\n')
    expect(rows).toEqual([{ name: 'Ubuntu 22.04 LTS', state: 'Running', version: '2' }])
  })
  it('跳过表头与空行', () => {
    expect(parseWslListVerbose('NAME STATE VERSION\n\n')).toEqual([])
  })
})
