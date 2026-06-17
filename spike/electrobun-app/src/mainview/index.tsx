import { createRoot } from 'react-dom/client'
import { useState } from 'react'

function App() {
  const [n, setN] = useState(0)
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1 id="probe-heading">Electrobun + React 19 OK</h1>
      <button id="probe-btn" onClick={() => setN((x) => x + 1)}>
        count: {n}
      </button>
    </div>
  )
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<App />)
  console.log('[view] React 19 mounted')
}
