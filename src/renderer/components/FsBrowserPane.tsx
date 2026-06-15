import { useState, useEffect } from 'react'
import type { FsListing } from '@shared/types'

interface FsBrowserPaneProps {
  listing: FsListing | null
  target: string | null
  onBrowse: (path: string) => void
  onPickTarget: (path: string) => void
}

// 完整的目录探索组件:快捷根(主目录/根)、可输入路径跳转、上级、当前路径面包屑、子目录列表(单击选为目标·双击进入)、
// 空目录与不可读目录的友好提示。控件始终可见,即使尚未加载到 listing 也不会出现空白面板。
export function FsBrowserPane({ listing, target, onBrowse, onPickTarget }: FsBrowserPaneProps) {
  const [input, setInput] = useState('')
  // 当导航到新目录时,把输入框同步成当前路径,便于查看/编辑后跳转。
  useEffect(() => { if (listing?.path) setInput(listing.path) }, [listing?.path])

  const home = listing?.home ?? ''
  const path = listing?.path ?? ''
  const entries = listing?.entries ?? []

  // 当前路径拆成可点击的面包屑段。
  const segments = path ? path.split('/').filter(Boolean) : []
  const crumbPath = (i: number) => '/' + segments.slice(0, i + 1).join('/')

  return (
    <div className="pane">
      <div className="pane-header">目标目录</div>

      <div className="fsbar">
        <div className="fsbar-row">
          {home && <button onClick={() => onBrowse(home)} title={home}>🏠 主目录</button>}
          <button onClick={() => onBrowse('/')}>/ 根目录</button>
          <button disabled={!listing?.parent} onClick={() => listing?.parent && onBrowse(listing.parent)}>↑ 上级</button>
        </div>
        <form
          className="fsbar-row"
          onSubmit={(e) => { e.preventDefault(); if (input.trim()) onBrowse(input.trim()) }}
        >
          <input
            className="path-input"
            value={input}
            placeholder="输入绝对路径后回车跳转,如 /home/xp/projects"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit">跳转</button>
        </form>
        <div className="crumb">
          <span className="crumb-seg" onClick={() => onBrowse('/')}>/</span>
          {segments.map((seg, i) => (
            <span key={i}>
              <span className="crumb-seg" onClick={() => onBrowse(crumbPath(i))}>{seg}</span>
              {i < segments.length - 1 && <span className="crumb-sep">/</span>}
            </span>
          ))}
        </div>
        <button
          className={target === path ? 'pick sel' : 'pick'}
          disabled={!path}
          onClick={() => path && onPickTarget(path)}
        >
          {target === path && path ? '✓ 已选为目标' : '选当前目录为目标'}
        </button>
      </div>

      {listing?.error ? (
        <div className="fs-empty">⚠ {listing.error}</div>
      ) : entries.length === 0 ? (
        <div className="fs-empty">{listing ? '此目录下没有子目录,可直接将当前目录选为目标。' : '加载中…'}</div>
      ) : (
        <ul className="list">
          {entries.map((e) => (
            <li
              key={e.path}
              className={target === e.path ? 'row sel' : 'row'}
              onClick={() => onPickTarget(e.path)}
              onDoubleClick={() => onBrowse(e.path)}
              title="单击选为目标,双击进入"
            >
              <div className="row-title">{e.isGitRepo ? '📦 ' : '📁 '}{e.name}{target === e.path ? '  ✓ 目标' : ''}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
