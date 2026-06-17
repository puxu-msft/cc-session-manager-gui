import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Electroview } from 'electrobun/view'
import type { SpikeRPC } from '../shared/rpc-schema'

// 渲染侧 adapter(对齐 spec §4 #4 / §8):把 Electroview RPC 包装成可调用对象。
// view 侧 handlers.messages.tick 接收 bun→view 的单向推送。
const ev = new Electroview<SpikeRPC>({
  rpc: Electroview.defineRPC<SpikeRPC>({
    handlers: {
      requests: {},
      messages: {
        tick: ({ at }) => {
          window.dispatchEvent(new CustomEvent('probe-tick', { detail: at }))
        },
      },
    },
  }),
})

function App() {
  const [reply, setReply] = useState('(未调用)')
  const [tick, setTick] = useState('(未收到)')

  useEffect(() => {
    const onTick = (e: Event) => setTick(String((e as CustomEvent).detail))
    window.addEventListener('probe-tick', onTick)
    return () => window.removeEventListener('probe-tick', onTick)
  }, [])

  // 自动触发一次 echo + send(无人工点击也能观测),同时保留按钮供人工复触。
  useEffect(() => {
    void callEchoAndSend()
  }, [])

  async function callEchoAndSend() {
    try {
      const r = await ev.rpc.request.echo({ text: 'hi' })
      setReply(JSON.stringify(r))
      // 把 echo 响应回传主进程,使请求-响应链路可在主终端纯自动观测(无需 DOM 回读/目视)
      ev.rpc.send.logFromView({ msg: 'hello-from-view', echoReply: JSON.stringify(r) })
    } catch (e) {
      setReply('echo failed: ' + String(e))
      ev.rpc.send.logFromView({ msg: 'hello-from-view (echo failed: ' + String(e) + ')' })
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1 id="probe-heading">RPC probe</h1>
      <button id="rpc-btn" onClick={() => void callEchoAndSend()}>
        call echo + send
      </button>
      <p id="rpc-reply">request reply: {reply}</p>
      <p id="rpc-tick">push tick: {tick}</p>
    </div>
  )
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<App />)
  console.log('[view] React 19 + Electroview RPC mounted')
}
