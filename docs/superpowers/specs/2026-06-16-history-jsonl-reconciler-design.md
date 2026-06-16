# history.jsonl 对账器 — 设计规格

**日期:** 2026-06-16
**状态:** 待用户复审(经 39-agent 审计 + 作者独立核实修订)
**关联:** 扩展主设计 `2026-06-15-cc-move-session-design.md`,新增一个独立子系统。

## 1. 目的

主工具移动会话后,会话 jsonl 的 cwd 被改写、`.claude.json` 被更新,但 `~/.claude/history.jsonl`(Claude Code 的输入框历史)里指向旧项目的行不会变,导致旧项目能误调出该会话的输入历史、新项目里却调不出。

本子系统是一个**独立、可重入的对账器**:以会话 jsonl 的真实 cwd 为准,把 history.jsonl 中 stale 的 `project` 字段对齐过来。move 流程不触碰 history;对账由用户在面板手动触发(或刷新/move 后以非阻塞徽标提示)。

## 2. 已确认的产品决策

1. **独立可重入对账器**,move 流程(executeMove/undoMove/reconcile)零改动。
2. **默认对齐会话 jsonl 真实首个 cwd**;额外支持手动指定路径强制覆盖。
3. **记录粒度 = 一次 `A→B` 改写操作一条**(含影响行数 + 受影响 sessionId),非行级。
4. **按 sessionId 精确过滤**,绝不误伤同 project 其他会话。

## 3. 背景事实(本机真实数据只读验证)

- `<claudeHome>/.claude/history.jsonl`:全局单文件、append-only、每行一个 JSON 对象,固定 5 键 `{ display, pastedContents, timestamp, project, sessionId }`。
- `project` = 绝对 cwd;`sessionId` = 会话 ID。CC 按当前 project 过滤输入历史。
- 它是输入框历史(含 slash 命令、取消的输入),与会话 jsonl 转录不互为超集、不可相互重建 → **必须改写,不能删后重生成**。
- `display`/`pastedContents` 可能内嵌绝对路径(历史事实,**绝不改写**)。
- **本机 15 行往返字节恒等**:CC 用 `JSON.stringify` 写出,各行已是规范 JSON。
- **append 的 POSIX 语义**:`O_APPEND` 写入原子、只落 EOF、多实例并发不交错 → 文件永远是完整行序列。

## 4. 多源约束

本项目是多数据源架构(`sources.ts`):WSL 下有"本机(Linux)"与"Windows(`/mnt/c/Users/.../.claude`)"两套独立存储,每源独立 `projectsRoot`/`claudeJsonPath`/`trashRoot`/DB(`index-<id>.db`),活动源决定 `getEnv()` 返回哪套。**每个源有自己的 history.jsonl**。

→ **history.jsonl 路径必须随活动源派生,禁止 `homedir()` 硬编码:**
- `Source` 接口增 `historyJsonlPath`,在 `sourceFromClaudeHome` 一处派生 `join(claudeHome, '.claude', 'history.jsonl')`。
- `Env` 接口增 `historyJsonlPath`,`getEnv()` 透传 `s.historyJsonlPath`。
- 所有对账入口从 `env.historyJsonlPath` 取;temp 文件用其 `dirname`。
- 对账是 **per-source**:活动源对账活动源的 history,用活动源的 `projectsRoot`/DB 判定。切到 Windows 源即对账 Windows 的 history,不被忽略、不跨源张冠李戴。

## 5. 模块边界

**`core/historyJsonl.ts`** — 底层原语(可注入路径,便于测试)
- `readHistory(path): { lines, size, mtime }`:流式逐行 `JSON.parse`,损坏行保留 raw;文件不存在返回空(不抛)。返回读取时刻 `size`/`mtime` 供并发检测。
- `applyHistoryRewrite(path, plan, guard): RewriteOp[]`:见 §7 写回算法。

**`core/historyReconciler.ts`** — 对账逻辑
- `planReconcile(env): ReconcilePlan`(默认对齐,见 §6)
- `planForce(env, sessionIds, targetPath): ReconcilePlan`(强制覆盖,跳过 jsonl 判定)
- `executeReconcile(env, plan): RewriteOp[]`(调 applyHistoryRewrite + 落 DB)
- `undoRewrite(env, rewriteId)`(按记录反向,见 §8)

```
ReconcilePlan = {
  ops:       Array<{ sessionId, oldProject, newProject, lineNos }>,  // 待改写
  orphans:   Array<{ sessionId, project, lineNos }>,                 // 找不到会话 jsonl,列出不动
  ambiguous: Array<{ sessionId, projects, lineNos }>,                // 多 project 值/空串,列出不动
}
RewriteOp = { oldProject, newProject, sessionIds, affectedLines }
```

`mover` 零改动。

## 6. 判定算法

对 history 中 distinct sessionId 逐个判定:

1. **取会话真实归属 cwd**:**优先查活动源 DB 的 `sessions.cwd`**(session_id 是主键,O(1) 点查;需在 db.ts 新增 `getSessionCwd`)。DB 未命中(可能未刷新)才回退 `findSessionFile`+流式读首个 cwd。对账前建议先 refresh 一次。
2. 会话定位不到 → 列入 **orphans**(列出不动)。会话首个 cwd 为空 → 跳过。
3. **逐行核对该 sessionId 全部 history 行的 project 分布**(planReconcile 本就逐行读 history,顺带统计 distinct project,零额外成本):
   - 所有行 project 同值,且 ≠ 会话归属 cwd → 列入 **ops**(`oldProject` = 该值)。
   - 行散落**多个不同 project 值**,或含**空串** → 列入 **ambiguous**,**与 orphans 同等对待:列出、不动**。本期不为其建逐条确认交互(YAGNI)。

**基准 = 会话归属 cwd**(与 scanner 用首个 cwd 聚合 project 同口径)。对账器不依赖 moves 表、不做子目录前缀重定位。

## 7. 写回算法

**并发安全靠"硬前置 + 检测并中止",不做流式合并。**

> 流式尾部合并能缩小丢行窗口,但无法零丢失(rename 前最后一跳消不掉;外部 append 不认我们的锁),徒增复杂度。与 `.claude.json`(claudeJson.ts 纯整文件 temp+rename、无合并)对称即可。

`applyHistoryRewrite(path, plan, guard)`:
1. 入参 `guard = { size, mtime }`(来自 plan 阶段的 readHistory)。
2. 重新 `readHistory(path)`,逐行:仅对 plan.ops 命中的 `(sessionId, 行内实际 oldProject)` 行,`JSON.parse → 改 project → JSON.stringify` 写入 temp(`<dirname>/.history.jsonl.tmp-<pid>`,0600);非目标行 / 损坏行 **raw 字节透传**。
3. 按 `(oldProject, newProject)` 聚合为 `RewriteOp[]`(聚合键含 oldProject → 同 sessionId 的 A/B 行自然分成两条 op,各自 old_project 精确)。
4. **rename 前重新 `stat`**:若 `size`/`mtime` ≠ `guard` → **中止 + 删 temp + 抛错**("history.jsonl 在对账期间被修改,请关闭所有 Claude 后重试"),**绝不覆盖**。
5. 通过则 `renameSync(temp, path)`(原子,同 claudeJson.ts:atomicWrite)。

**硬前置**:对账期间无运行中的 Claude(与主设计 §3.7 对 .claude.json 同款约定)。

**不变式**:
- 非目标行、损坏行 **字节级透传**。
- 目标行 **project 字段值改写正确;同行其余字段值/语义不变**(JSON 重序列化理论上可规范化空白/转义;真实 CC 数据已验证往返字节恒等,故风险为零,但保守只承诺"值/语义"——与 cwdRewriter.ts 对改动行的行为对称)。

## 8. DB 表

与现有 `cwd_changes`/`snapshot_lines` 旁表风格一致,**不用 JSON 数组列**:

```
history_rewrites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,                 -- 'auto' | 'force'
  old_project TEXT, new_project TEXT,
  affected_lines INTEGER, rewritten_at TEXT )

history_rewrite_sessions( rewrite_id INTEGER, session_id TEXT )   -- 旁表,该次 A→B 影响的会话集合
```

- 一次 `(old_project → new_project)` 聚合一条 `history_rewrites` + 若干 `history_rewrite_sessions`。
- **建表**:两表加入 `schema.ts` 的 `SCHEMA_SQL`,靠 `CREATE TABLE IF NOT EXISTS` 对既有库自动建表。**项目无迁移 runner,不写"schema_version 递增+迁移"**。
- **undo**(`undoRewrite`):按 rewriteId 取记录 + 旁表 session 集合 → 构造 plan:把这些 session 中**当前 project == new_project** 的行改回 `old_project`(加"当前值匹配"过滤,避免误改该会话之后又变成别的值的行)→ 复用 §7 写回(同样有并发检测)。
- undo 为**值级**而非字节级:history 就地改写、无回收区等价物,且决策 2.3 不要行级记录。真实数据往返字节恒等使值级与字节级实际等价。

## 9. DB / IPC / env 接线

- `db.ts` 新增:`getSessionCwd(sessionId)`(按主键查 cwd)、`insertHistoryRewrite(op)`、`getHistoryRewrites()`、`getHistoryRewrite(id)`(含旁表 session 集合)。沿用 moves 的命名 + rowMap snake_case 回填。
- `appState.ts`/`sources.ts`:`Source`/`Env` 增 `historyJsonlPath`;`sourceFromClaudeHome`/`getEnv` 透传。
- `ipc.ts`:按现有 `move:*` 模式注册 `history:plan`/`history:reconcile`/`history:listRewrites`/`history:undoRewrite`,经 `getEnv()` 注入。
- `preload/index.ts`:同步加 4 个类型化方法。

## 10. UI

历史视图旁加 **History 对账面板**:plan 预览(ops + orphans + ambiguous,后两者均只列出不动)、一键对齐(auto)、手动强制(选会话 + 指定路径)、记录列表 + 撤销。
**非阻塞提示**:刷新 / move 完成后做一次 `planReconcile`,徽标提示"history 有 N 行待对齐 / K 行需人工处理"(不自动改写)。

## 11. 测试(vitest,≥80%)

- `historyJsonl`:多 sessionId、损坏行透传、**文件不存在返回空不抛**、原子写、目标行 project 改写而同行其余字段值不变(区分"目标行内非 project 字段"与"非目标行字节级")、**rename 前并发(size/mtime)检测触发中止不覆盖**。
- `historyReconciler`:DB 命中 / 未命中回退;首 cwd≠project → ops;orphan 列出不动;空 cwd 跳过;**同 sessionId 多 project → ambiguous 不改**;**空 project 串 → ambiguous**;force 模式;**undo:不同 sessionId 各自精确还原;同 sessionId 多 project 强制并到共同 target 后 undo 有损(已知边界,见 §12,用显式测试锁定)**;连续两次 auto 第二次为空(幂等);**self-referential(cwd=claudeHome/.claude)正常对齐**;**多源 fixture:只作用活动源 history/projectsRoot**。

## 12. 设计依据与已知风险(审计结论摘要)

经 39-agent 多视角审计 + 作者独立核实,纳入以下结论:

- **多源路径**(A1,核实属实):history 路径随活动源注入,禁 homedir 硬编码。
- **并发丢行**(A2,核实属实):read-modify-write + 整文件 rename 会覆盖窗口内 append;改用硬前置 + rename 前 size/mtime 检测并中止,删除"对并发 append 安全"的原虚假承诺;不做流式合并(无法零丢失)。
- **性能**(A3,核实属实):db.ts 确无 by-id 查询,判定优先 `sessions.cwd` 主键点查,未命中回退 findSessionFile。
- **行级旧值**(C1,部分推测):改写按 `(sessionId, 实际旧 project)` 分组,undo 逐组精确。**"同 sessionId 多 project"边界本机未观测**(15 行/3 会话全单值),其是否发生取决于 CC 写 history 的语义(不在本仓库代码内,无法证实/证伪);故用 ambiguous 通道"列出不动"低成本防御,不假设其必然成立、也不为其建复杂交互。
- **force 多对一 undo 有损**(实现期发现,采方案 a=记录而非阻止):同一 sessionId 的多个不同 project 被 force 并到共同 target 时,正向已把多个旧值塌缩为同一值,值级 undo(按 sessionId+当前 project 匹配)无从区分各行原值,不可逆。`auto` 永不触发(多 project 走 ambiguous 不动);仅在用户**显式 force** 多 project 会话时发生,而 force 本就是破坏性覆盖。已用显式测试锁定该行为;不存行号修复(违反决策 2.3"不要行级记录")。**UI 后续应在 force 多 project 会话时提示"undo 有损"**(满足"绝不静默")。
- **承诺降级**(B1):字节级 → 值/语义级(真实数据往返字节恒等,风险为零,降级仅为保守)。
- **无迁移机制**(B2,核实属实):靠 `CREATE TABLE IF NOT EXISTS`。
- **旁表**(B3):`session_ids` 拆 `history_rewrite_sessions` 旁表,与既有风格一致。
- **被否决**:给 history 仿建行级 raw 快照(违反决策 2.3 且 snapshot_lines 实际只写不读、非 mover 真实恢复机制);流式合并;路径规范化;move 不碰 history 的 stale 窗口用户感知(已是决策取舍)。

## 13. 显式不做(YAGNI)

不改 display/pastedContents;不做子目录前缀重定位;不流式尾部合并;不碰 mover;不做 history 自动 GC;move 期间不自动改写(仅提示);不为 ambiguous 建逐条确认交互。
