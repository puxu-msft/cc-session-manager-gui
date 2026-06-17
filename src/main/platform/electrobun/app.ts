import { app } from 'electrobun/bun'
import type { AppHost } from '../contract'

// Electrobun 应用生命周期宿主。
//
// 与 Electron 的差异(以 electrobun 源码 api/bun/index.ts 的 app 对象为准):
//   - 无 setName:应用名/identifier 在 electrobun.config.ts 的 app 段声明(打包期),运行期不可改。
//     setName 在此为 no-op(bootstrap 仍会调用,语义由 config 承担)。
//   - 无 whenReady:bun 主进程在 native 层初始化后才执行,无需等待;立即 resolve。
//   - window-all-closed → quit:electrobun 原生层已按 buildConfig.runtime.exitOnLastWindowClosed
//     (默认 true)自动在最后一个窗口关闭时退出。onWindowAllClosed 在此为 best-effort no-op;
//     bootstrap 里 darwin 的「关窗不退出」语义在本里程碑(Linux)不触发。
//   - onBeforeQuit:electrobun 暴露 app.on(name, handler);用 'will-quit' 尽力挂接退出收尾
//     (中断在飞扫描 + 关库)。即使该事件名在本版本不触发,DB 关闭也会随进程退出由 OS 回收。
export class ElectrobunAppHost implements AppHost {
  private beforeQuit: (() => void) | null = null

  setName(_name: string): void {
    // no-op:见上,应用名由 electrobun.config.ts 决定。
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  onWindowAllClosed(_cb: () => void): void {
    // no-op:退出由 electrobun 原生 exitOnLastWindowClosed 处理。
  }

  onBeforeQuit(cb: () => void): void {
    this.beforeQuit = cb
    try {
      app.on('will-quit', () => cb())
    } catch {
      /* 事件名在本版本可能不存在;忽略,退出收尾退化为进程级 */
    }
  }

  quit(): void {
    this.beforeQuit?.()
    app.quit()
  }
}
