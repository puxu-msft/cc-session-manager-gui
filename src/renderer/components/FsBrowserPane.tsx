export function FsBrowserPane({ listing, target, onBrowse, onPickTarget }: { listing: any; target: string | null; onBrowse: (p: string) => void; onPickTarget: (p: string) => void }) {
  if (!listing) return <div className="pane"><div className="pane-header">目标目录</div></div>
  return (
    <div className="pane">
      <div className="pane-header">目标目录</div>
      <div className="crumb">
        <button disabled={!listing.parent} onClick={() => listing.parent && onBrowse(listing.parent)}>⬆ 上级</button>
        <span className="path">{listing.path}</span>
        <button className={target === listing.path ? 'pick sel' : 'pick'} onClick={() => onPickTarget(listing.path)}>选为目标</button>
      </div>
      <ul className="list">
        {listing.entries.map((e: any) => (
          <li key={e.path} className="row" onDoubleClick={() => onBrowse(e.path)} onClick={() => onPickTarget(e.path)}>
            <div className="row-title">{e.isGitRepo ? '📦 ' : '📁 '}{e.name}{target === e.path ? '  ✓ 目标' : ''}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
