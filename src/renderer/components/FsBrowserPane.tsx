import { useState, useEffect } from 'react'
import type { FsListing } from '@shared/types'

interface FsBrowserPaneProps {
  listing: FsListing | null
  target: string | null
  onBrowse: (path: string) => void
  onPickTarget: (path: string) => void
  onMakeDir: (parent: string, name: string) => void
}

// 目录探索组件:快捷根(主目录/根)、可输入路径跳转、新建文件夹、当前路径面包屑,以及子目录列表。
// 列表首两项为 .(当前目录,单击即选为目标)与 ..(上级,单击返回);其后是各子目录(单击选为目标·双击进入)。
export function FsBrowserPane({ listing, target, onBrowse, onPickTarget, onMakeDir }: FsBrowserPaneProps) {
  const [input, setInput] = useState('')
  const [newDirOpen, setNewDirOpen] = useState(false)
  const [newName, setNewName] = useState('')
  useEffect(() => { if (listing?.path) setInput(listing.path) }, [listing?.path])

  const home = listing?.home ?? ''
  const path = listing?.path ?? ''
  const entries = listing?.entries ?? []

  const segments = path ? path.split('/').filter(Boolean) : []
  const crumbPath = (i: number) => '/' + segments.slice(0, i + 1).join('/')

  const confirmNewDir = () => {
    const n = newName.trim()
    if (n && path) { onMakeDir(path, n); setNewDirOpen(false) }
  }

  return (
    <>
    <div className="pane">
      <div className="pane-header">目标目录</div>

      <div className="fsbar">
        <div className="fsbar-row">
          {home && <button onClick={() => onBrowse(home)} title={home}>🏠 主目录</button>}
          <button onClick={() => onBrowse('/')}>/ 根目录</button>
          <button disabled={!path} onClick={() => { setNewName(''); setNewDirOpen(true) }}>＋ 新建文件夹</button>
        </div>
        <form className="fsbar-row" onSubmit={(e) => { e.preventDefault(); if (input.trim()) onBrowse(input.trim()) }}>
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
      </div>

      {!listing ? (
        <div className="fs-empty">加载中…</div>
      ) : listing.error ? (
        <div className="fs-empty">⚠ {listing.error}</div>
      ) : (
        <ul className="list">
          <li
            className={target === path ? 'row sel' : 'row'}
            onClick={() => onPickTarget(path)}
            title="当前目录(单击选为目标)"
          >
            <div className="row-title">📂 . (当前目录){target === path ? '  ✓ 目标' : ''}</div>
          </li>
          {listing.parent && (
            <li className="row" onClick={() => onBrowse(listing.parent!)} title="返回上级目录">
              <div className="row-title">📁 .. (上级目录)</div>
            </li>
          )}
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

    {newDirOpen && (
      <div className="modal-backdrop" onClick={() => setNewDirOpen(false)}>
        <div className="modal small" onClick={(e) => e.stopPropagation()}>
          <h3>新建文件夹</h3>
          <div className="newdir-path">位置:{path}</div>
          <input
            className="path-input newdir-input"
            autoFocus
            value={newName}
            placeholder="文件夹名"
            spellCheck={false}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmNewDir(); if (e.key === 'Escape') setNewDirOpen(false) }}
          />
          <div className="modal-actions">
            <button onClick={() => setNewDirOpen(false)}>取消</button>
            <button className="primary" disabled={!newName.trim()} onClick={confirmNewDir}>确认</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
