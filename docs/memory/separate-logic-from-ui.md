---
name: separate-logic-from-ui
description: "业务逻辑必须与 UI/框架胶水分离,以便不经 UI 单独测试"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7f530cdf-dc1b-4af8-b161-31f258651177
---

业务逻辑必须从 UI / 框架胶水(Electron 主进程、IPC handler、React 组件)中抽离成纯函数/模块,使其能脱离 UI 被单独、确定性地测试。

**Why:** 在 cc-move-session 里,刷新落库逻辑最初内联在 `ipcMain.handle('refresh:run')` 里、依赖 Electron 的 event/app,导致我只能验证零件、无法端到端验证整条链路,差点把"刷新是否真能用"蒙混过去。用户明确要求记住:逻辑与 UI 要分离,从而能单独测试。

**How to apply:** 写带副作用/编排的功能时,先把核心逻辑抽成不依赖框架的纯函数(如 `applyScanToIndex(db, scan, existing)`),让 handler/组件只做"取参数→调纯函数→回传"的薄胶水;然后对纯函数写集成测试(可用真实依赖如内存 SQLite,但不拉起 Electron/UI)。生产代码与测试调用同一批函数,避免走样。参见 [[chinese-no-hard-wrap-docs]] 同属本项目长期约定。