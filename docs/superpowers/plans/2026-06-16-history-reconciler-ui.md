# history.jsonl 对账器 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 给后端 history 对账子系统加一个独立 modal UI:plan 预览、一键对齐、面板内就地强制、记录列表+撤销、MoveBar 待对齐徽标,并在 force 多 project 会话时提示 undo 有损。

**Architecture:** 独立 `HistoryReconcileView` modal(参照既有 `HistoryView`),由 MoveBar 新增"对账"按钮(带徽标)触发。少量判定逻辑(摘要计数、force 是否有损)抽成纯函数 `lib/reconcileView.ts` 走 vitest TDD;组件本身靠 E2E 冒烟 + 手动验证(项目无 React 组件单测)。`window.api` 无类型声明(隐式 any),4 个后端 IPC 方法直接可调。

**Tech Stack:** React、既有 `window.api` 桥、vitest(纯函数)、Playwright(E2E)。

**关联:** spec `2026-06-16-history-jsonl-reconciler-design.md` §10/§137;后端已交付(planHistory/reconcileHistory/listHistoryRewrites/undoHistoryRewrite)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/renderer/lib/reconcileView.ts` | `reconcileSummary(plan)` + `isLossyForce(projects)` 纯函数 | 新建 |
| `src/renderer/lib/reconcileView.test.ts` | 上者单测 | 新建 |
| `src/renderer/components/HistoryReconcileView.tsx` | 对账 modal(预览/一键对齐/就地强制/记录+撤销) | 新建 |
| `src/renderer/state.ts` | 加 `reconcilePending` 计数 + `loadReconcilePending` | 改 |
| `src/renderer/App.tsx` | `showReconcile` state + 触发 + 徽标数据 | 改 |
| `src/renderer/components/MoveBar.tsx` | `onReconcile` + 待对齐徽标 | 改 |
| `src/renderer/styles.css` | `.badge`/`.rec-*` 样式 | 改 |
| `e2e/smoke.spec.ts` | 冒烟:打开对账 modal | 改 |

---

## Task U1: reconcileView 纯函数 + 测试

**Files:** Create `src/renderer/lib/reconcileView.ts`, `src/renderer/lib/reconcileView.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { reconcileSummary, isLossyForce } from './reconcileView'

describe('reconcileSummary', () => {
  it('统计 ops 会话数与行数、需人工行数', () => {
    const plan = {
      ops: [{ sessionId: 's1', lineNos: [1, 2] }],
      orphans: [{ sessionId: 'o1', lineNos: [3] }],
      ambiguous: [{ sessionId: 'a1', lineNos: [4, 5] }],
    }
    const s = reconcileSummary(plan as any)
    expect(s.opsCount).toBe(1)
    expect(s.opsLines).toBe(2)
    expect(s.manualLines).toBe(3) // orphan 1 + ambiguous 2
  })
})

describe('isLossyForce', () => {
  it('去掉空串后多个不同 project → 有损', () => {
    expect(isLossyForce(['/a', '/b'])).toBe(true)
  })
  it('单个 project 或仅含空串 → 不有损', () => {
    expect(isLossyForce(['/a'])).toBe(false)
    expect(isLossyForce(['/a', ''])).toBe(false)
    expect(isLossyForce([''])).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/renderer/lib/reconcileView.test.ts` — 模块缺失。

- [ ] **Step 3: 实现**

```ts
// 对账 plan 的展示用摘要:待对齐(ops)会话数/行数,需人工(orphan+ambiguous)行数。
export function reconcileSummary(plan: { ops: any[]; orphans: any[]; ambiguous: any[] }) {
  const opsLines = plan.ops.reduce((a, o) => a + (o.lineNos?.length ?? 0), 0)
  const manualLines = [...plan.orphans, ...plan.ambiguous].reduce((a, x) => a + (x.lineNos?.length ?? 0), 0)
  return { opsCount: plan.ops.length, opsLines, orphanCount: plan.orphans.length, ambiguousCount: plan.ambiguous.length, manualLines }
}

// 强制对齐某会话是否会导致 undo 有损:去掉空串后仍有多个不同 project,
// 说明正向会把多个旧值塌缩成一个,值级 undo 不可逆(见 spec §12)。
export function isLossyForce(projects: string[]): boolean {
  return new Set(projects.filter((p) => p !== '')).size > 1
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run src/renderer/lib/reconcileView.test.ts` 全绿;`npx tsc --noEmit` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/lib/reconcileView.ts src/renderer/lib/reconcileView.test.ts
git commit -m "feat: 对账视图纯函数 reconcileSummary/isLossyForce + 单测"
```

---

## Task U2: HistoryReconcileView 组件

**Files:** Create `src/renderer/components/HistoryReconcileView.tsx`

- [ ] **Step 1: 实现组件**(无 React 单测;靠 tsc + 后续 E2E/手动)

```tsx
import { useEffect, useState } from 'react'
import { reconcileSummary, isLossyForce } from '../lib/reconcileView'

export function HistoryReconcileView({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [plan, setPlan] = useState<any>(null)
  const [rewrites, setRewrites] = useState<any[]>([])
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setErr(null)
    try {
      setPlan(await window.api.planHistory())
      setRewrites(await window.api.listHistoryRewrites())
    } catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  useEffect(() => { load() }, [])

  const guard = async (fn: () => Promise<void>) => {
    setErr(null)
    try { await fn(); await load(); onChanged?.() } catch (e: any) { setErr(String(e?.message ?? e)) }
  }
  const runAuto = () => guard(() => window.api.reconcileHistory('auto'))
  const runForce = (sid: string, projects: string[]) => {
    const target = (targets[sid] ?? '').trim()
    if (!target) return
    if (isLossyForce(projects) && !confirm(`会话 ${sid.slice(0, 8)} 在历史里有多个不同 project,强制并到单一路径后撤销将有损(无法精确还原各自旧值)。确认?`)) return
    return guard(() => window.api.reconcileHistory('force', [sid], target))
  }
  const undo = (id: number) => guard(() => window.api.undoHistoryRewrite(id))
  const setTgt = (sid: string, v: string) => setTargets((t) => ({ ...t, [sid]: v }))

  const s = plan ? reconcileSummary(plan) : null
  const manual = plan ? [
    ...plan.ambiguous.map((a: any) => ({ sessionId: a.sessionId, projects: a.projects, kind: isLossyForce(a.projects) ? '多值(force 有损)' : '含空串' })),
    ...plan.orphans.map((o: any) => ({ sessionId: o.sessionId, projects: [o.project], kind: '孤儿(会话不存在)' })),
  ] : []

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>History 对账</h3>
        {err && <p className="rec-err">{err}</p>}
        {s && (
          <div className="rec-summary">
            待对齐 <b>{s.opsLines}</b> 行({s.opsCount} 会话) · 需人工 <b>{s.manualLines}</b> 行
            <button className="primary" disabled={s.opsCount === 0} onClick={runAuto}>一键对齐</button>
          </div>
        )}
        {plan?.ops?.length > 0 && (
          <>
            <h4>待对齐(以会话真实 cwd 为准)</h4>
            <table className="preview">
              <thead><tr><th>会话</th><th>旧 project → 新</th><th>行数</th></tr></thead>
              <tbody>{plan.ops.map((o: any) => (
                <tr key={o.sessionId + o.oldProject}><td>{o.sessionId.slice(0, 8)}</td><td>{o.oldProject} → {o.newProject}</td><td>{o.lineNos.length}</td></tr>
              ))}</tbody>
            </table>
          </>
        )}
        {manual.length > 0 && (
          <>
            <h4>需人工处理(列出不动,可就地强制)</h4>
            <table className="preview">
              <thead><tr><th>会话</th><th>当前 project</th><th>类型</th><th>强制对齐到</th></tr></thead>
              <tbody>{manual.map((m) => (
                <tr key={m.sessionId}>
                  <td>{m.sessionId.slice(0, 8)}</td><td>{m.projects.join(' , ')}</td><td>{m.kind}</td>
                  <td className="rec-force">
                    <input value={targets[m.sessionId] ?? ''} placeholder="目标绝对路径" onChange={(e) => setTgt(m.sessionId, e.target.value)} />
                    <button onClick={() => runForce(m.sessionId, m.projects)}>强制</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
        <h4>对账记录</h4>
        <table className="preview">
          <thead><tr><th>#</th><th>来源</th><th>旧 → 新</th><th>行数</th><th>时间</th><th></th></tr></thead>
          <tbody>{rewrites.map((r: any) => (
            <tr key={r.id}><td>{r.id}</td><td>{r.source}</td><td>{r.old_project} → {r.new_project}</td><td>{r.affected_lines}</td><td>{r.rewritten_at}</td><td><button onClick={() => undo(r.id)}>撤销</button></td></tr>
          ))}</tbody>
        </table>
        <div className="modal-actions"><button onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: tsc** — `npx tsc --noEmit` 干净。
- [ ] **Step 3: 提交**

```bash
git add src/renderer/components/HistoryReconcileView.tsx
git commit -m "feat: HistoryReconcileView 对账 modal(预览/一键对齐/就地强制/记录撤销)"
```

---

## Task U3: state + App + MoveBar 接线(徽标 + 触发)

**Files:** Modify `src/renderer/state.ts`, `src/renderer/App.tsx`, `src/renderer/components/MoveBar.tsx`

- [ ] **Step 1: state.ts** — 在 `useAppState` 内加状态与方法,并加入返回对象:

```ts
// 在其它 useState 附近:
const [reconcilePending, setReconcilePending] = useState(0)
// 在其它 useCallback 附近:
const loadReconcilePending = useCallback(async () => {
  try { const p = await window.api.planHistory(); setReconcilePending(p.ops.length) } catch { setReconcilePending(0) }
}, [])
```
并把 `reconcilePending, loadReconcilePending` 加进 `return { ... }`。

- [ ] **Step 2: MoveBar.tsx** — 加 props 与按钮(在 `onHistory` 按钮旁):

```ts
// MoveBarProps 增:
  onReconcile?: () => void
  reconcilePending?: number
```
```tsx
// 解构参数增 onReconcile, reconcilePending;在“历史”按钮之后加:
{onReconcile && (
  <button onClick={onReconcile} disabled={refreshing}>
    对账{reconcilePending ? <span className="badge">{reconcilePending}</span> : null}
  </button>
)}
```

- [ ] **Step 3: App.tsx** — 引入组件、加 state、接线:

```tsx
import { HistoryReconcileView } from './components/HistoryReconcileView'
// 组件内:
const [showReconcile, setShowReconcile] = useState(false)
// useEffect 里追加(与 loadIndex 同处):
useEffect(() => { st.loadSources(); st.loadIndex(); st.browse(''); st.loadReconcilePending() }, [])
// confirmMove 末尾追加一次刷新待对齐数:
//   await st.refresh(); st.loadReconcilePending(); if (...) ...
// MoveBar 增 props:
//   onReconcile={() => setShowReconcile(true)} reconcilePending={st.reconcilePending}
// 在 HistoryView 渲染附近加:
{showReconcile && <HistoryReconcileView onClose={() => setShowReconcile(false)} onChanged={st.loadReconcilePending} />}
```

- [ ] **Step 4: 验证** — `npx tsc --noEmit` 干净;`npm test` 全绿(不应有回归)。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/state.ts src/renderer/App.tsx src/renderer/components/MoveBar.tsx
git commit -m "feat: MoveBar 对账按钮+待对齐徽标,App/state 接线"
```

---

## Task U4: 样式

**Files:** Modify `src/renderer/styles.css`

- [ ] **Step 1: 追加样式**(文件末尾)

```css
.badge { display: inline-block; min-width: 16px; margin-left: 6px; padding: 0 5px; background: #2563eb; color: #fff; border-radius: 8px; font-size: 11px; line-height: 16px; text-align: center; }
.rec-summary { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.rec-summary .primary { margin-left: auto; }
.rec-force { display: flex; gap: 6px; }
.rec-force input { flex: 1; padding: 3px 6px; border: 1px solid #ddd; border-radius: 5px; font-size: 12px; }
.rec-err { color: #b00020; background: #fff5f5; border: 1px solid #f0b3b3; padding: 6px 8px; border-radius: 5px; font-size: 12px; }
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/styles.css
git commit -m "feat: 对账面板徽标与就地强制样式"
```

---

## Task U5: E2E 冒烟 + 手动验证

**Files:** Modify `e2e/smoke.spec.ts`

- [ ] **Step 1: 读现有 `e2e/smoke.spec.ts`** 了解其打开 app、定位元素的方式(getByText/getByRole)。

- [ ] **Step 2: 追加冒烟用例**(适配现有写法):点击"对账"按钮 → 断言出现标题"History 对账" → 点"关闭" → 断言 modal 消失。示意:

```ts
test('对账 modal 可打开关闭', async () => {
  await page.getByRole('button', { name: /对账/ }).click()
  await expect(page.getByText('History 对账')).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByText('History 对账')).toHaveCount(0)
})
```
注:具体 page 获取方式跟随文件现有 fixture(可能是 `electronApp`/`window`)。若现有用例用 `window` 变量,沿用之。

- [ ] **Step 3: 跑 E2E** — `npm run e2e`(会先 build)。若 headless WSL 下 Electron 无法启动而失败,记录为环境限制,改为手动验证清单并在报告中说明;不要为环境问题改源码。

- [ ] **Step 4: 手动验证清单**(报告中确认或标注无法执行的原因):
  - MoveBar 出现"对账"按钮;有待对齐时显示徽标数。
  - 点开 modal:显示 plan 预览三区(待对齐/需人工/记录)。
  - "一键对齐"对 ops 生效后,记录列表出现新行,徽标归零/减少。
  - 对多 project 会话就地"强制"弹出"undo 有损"确认。
  - 记录"撤销"生效。

- [ ] **Step 5: 提交**

```bash
git add e2e/smoke.spec.ts
git commit -m "test: 对账 modal 打开关闭 E2E 冒烟"
```

---

## 自检(对照 spec §10/§137)

- §10 plan 预览(ops/orphans/ambiguous 后两者列出不动):U2 三区表格。✓
- §10 一键对齐(auto):U2 runAuto。✓
- §10 手动强制(选会话+指定路径):U2 就地 input + 强制按钮。✓
- §10 记录列表+撤销:U2 记录表 + undo。✓
- §10 非阻塞徽标(刷新/move 后 planReconcile 提示待对齐数):U3 reconcilePending + 徽标,App 在初始化/move 后刷新。✓
- §137 force 多 project 提示 undo 有损:U2 isLossyForce + confirm。✓(满足"绝不静默")

类型一致性:`reconcileSummary`/`isLossyForce`(U1)被 U2 消费;`reconcilePending`/`loadReconcilePending`(U3 state)被 App/MoveBar 消费;`onReconcile`/`reconcilePending`(MoveBar props)与 App 传参一致。
