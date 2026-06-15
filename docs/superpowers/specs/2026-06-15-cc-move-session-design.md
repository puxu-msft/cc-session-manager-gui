# cc-move-session — 设计规格

**日期:** 2026-06-15
**状态:** 已批准,可进入实现计划

## 1. 目的

一个桌面 GUI 工具(Electron + React),用于**移动 Claude Code 会话**——把会话从一个工作目录迁移到另一个工作目录。"移动"会让会话被归档到目标目录对应的项目文件夹下,并保证在目标目录里打开/恢复时行为一致。工具同时维护一个可查询的 SQLite 索引(覆盖全部项目与会话),并为每一次移动保留可恢复的备份。

## 2. 背景:Claude Code 如何存储会话

以下结论均经只读审计在本机真实数据上验证。

- **项目文件夹:** `~/.claude/projects/<编码后的cwd>/`。文件夹名是绝对路径把**每个非字母数字字符替换成 `-`**:`encode(p) = p.replace(/[^a-zA-Z0-9]/g, '-')`。不做分隔符折叠;开头的 `/` 会变成开头的 `-`。例如 `/home/xp/.codex` → `-home-xp--codex`。**从文件夹名反解回路径是有损且有歧义的**(`/`、`.`、`_`、`-` 全都映射成 `-`)。→ 真实路径永远从会话文件内部的 `cwd` 字段读取,绝不从文件夹名反推。
- **会话文件:** `<sessionId>.jsonl`,每行一个 JSON 对象。
- **逐行 `cwd`:** `user`/`assistant`/`system`/`attachment` 行带顶层 `"cwd"`。其它行类型(`queue-operation`、`file-history-snapshot`、`ai-title`、`custom-title`、`last-prompt`、`mode`、`permission-mode`)**没有** `cwd`。**`cwd` 在一个会话内并非常量**——会话若 `cd` 进子目录或 `/tmp`/`~/.cache`,会累积多个不同 cwd(某个真实会话里有 22 个)。
- **嵌套 cwd:** `attachment.response.cwd` 是第二个嵌套的 cwd 字段,同样反映工作目录。
- **源路径还出现在消息正文/工具 I/O 中**(单会话数百到上千行):`tool_input.command`、`tool_response.stdout`、`<ide_opened_file>` 文本、`structuredPatch`、内嵌的 `transcript_path` 等。这些是**历史事实,绝不可改写**。
- **sidecar 子树 `<sessionId>/`**(较丰富的会话才有)包含:
  - `subagents/*.jsonl` — 子代理的完整转录,**含 `cwd`**(必须改写)。`subagents/*.meta.json` — 记 `agentType`/`description`/`toolUseId`,**无路径**(原样搬,绝不改写)。
  - `tool-results/*.txt` — 大工具输出的溢出存储(可达**数 MB**,某个有 1.4M token)。原样搬,绝不改写。
  - `hook-*-stdout.txt` — hook 捕获的 stdout。原样搬。
- **`memory/`** 在**项目文件夹层级**(与会话 jsonl 同级),被该项目的所有会话共享。它不随单个会话移动。它**可能是符号链接**(例如指向工作树)——要用 `lstat`,绝不跟随/复制。
- **`~/.claude.json`** 有一个以绝对路径为 key 的 `projects` 字典。每个项目值包含 `allowedTools`、`mcpServers`、`enabled/disabledMcpjsonServers`、`hasTrustDialogAccepted`,以及移动后会失效的状态:`lastSessionId`、`lastSessionMetrics`、`exampleFiles`、各类成本。该文件还有约 24 个无关的顶层 key(含 `userID`)必须保留。文件权限 `0600`,且每个活跃的 Claude Code 实例都会写它。
- **数据风险:** 会话 jsonl 可能含**损坏/不完整的行**(中断写入留下的 NUL 字节)。主 jsonl 可达 **100MB+**。→ 必须逐行流式处理,跳过/原样透传无法解析的行,绝不一次性 load 全部再解析。

**source of truth 永远是磁盘上的 jsonl。Claude Code 读文件,不读我们的数据库。**

## 3. 已确认的产品决策

1. **操作 = 移动**(源被删除)。支持多选会话。
2. **cwd 改写 = 前缀重定位。** 对每个结构化 cwd 字段(顶层 `cwd` 以及嵌套 `attachment.response.cwd`):若其值等于源根或在源根之下,则把前缀重定位到目标(`<源>/crates/x` → `<目标>/crates/x`)。源根之外的 cwd(`/tmp`、`~/.cache`、兄弟目录)保持不动。**消息正文与工具输出绝不改写。** `gitBranch` 绝不改写。
3. **整个 `<sessionId>/` 子树随会话移动**(subagents + tool-results + hooks)。`*.meta.json`、`tool-results`、`hooks` 原样搬;只有 `*.jsonl` 文件做 cwd 改写。
4. **`memory/` 绝不移动**(项目级;可能是符号链接)。
5. **活跃会话保护:** 若会话文件 mtime 在 N 秒内(默认 60),或被检测为正在写入,则拒绝移动,并明确提示用户先关闭它。
6. **恢复机制:保留回收区 + SQLite 紧凑记录:**
   - 需要改写的文件(主 jsonl + 子代理 jsonl):原始件 `rename` 进 `~/.claude/.cc-move-trash/<moveId>/`;改写版写入目标。
   - 不改写的 sidecar(tool-results/meta/hooks):从源 `rename` 到目标(不为大文件复制第二份)。
   - **回收区无限期保留——不做任何自动 GC。** UI 提供手动"清理"入口,并显示每次移动及总计的磁盘占用。
   - SQLite 存移动历史 + 元数据 + **每行 cwd 改动的紧凑记录**(行号、旧值、新值)。字节级恢复由回收区负责。小 jsonl(低于体积阈值)可额外存完整行快照。
7. **`~/.claude.json`:** 目标若无 `projects[<目标>]` 条目则自动创建,从源条目按**字段白名单**克隆(`allowedTools`、`mcpServers`、`enabled/disabledMcpjsonServers`、`hasTrustDialogAccepted`);重置/省略易失字段(`lastSessionId`、`lastSessionMetrics`、`exampleFiles`、成本)。采用读-改-写,加短锁,在原子 temp+rename 之前再读一次,只合并 `projects` 子树,保留所有其它 key。源条目保持不动。
8. **移动前确认/预览弹窗**列出:涉及会话、A→B、将改写多少个结构化 cwd 字段、涉及哪些 sidecar(含 tool-results 体积)、`.claude.json` 是否会新增条目、回收区备份体积。
9. **SQLite 索引覆盖全部项目/会话**(富元数据,但不含消息内容),手动刷新更新。移动操作会立即更新对应行。

## 4. 架构

**技术栈:** electron-vite(Vite + Electron + React + TypeScript);**better-sqlite3** 跑在**主**进程;渲染进程是纯 React,配 `contextIsolation` + preload IPC 桥。所有文件系统 / SQLite / 移动逻辑都在主进程。

### 主进程模块(小而专,可独立测试)

| 模块 | 职责 | 依赖 |
|---|---|---|
| `pathCodec` | `encode(absPath)` → 文件夹名(`[^a-zA-Z0-9]→-`)。前缀重定位辅助 `reRoot(cwd, srcRoot, dstRoot)`。按约定不支持反解(有损)。 | — |
| `jsonlScanner` | 流式读 `<id>.jsonl`;提取元数据(首条消息预览,优先级 `custom-title`>`ai-title`>首条用户消息;started/last 时间戳只取自消息行;message_count;line_count;gitBranch;version;entrypoint;isSidechain;distinct cwds;size;mtime)。跳过损坏行。检测 sidecar 子树及计数。 | — |
| `scanner` | 遍历 `~/.claude/projects/*`;每个会话调 `jsonlScanner`;按真实(首个)cwd 聚合;以 (size,mtime) 缓存跳过未变文件;产出索引 diff。 | jsonlScanner, db |
| `fsBrowser` | 为右栏列出任意路径的子目录(name、isDir、是否 git 仓库)。 | — |
| `cwdRewriter` | 给定源行 + (srcRoot,dstRoot),把每行解析为 JSON,按前缀规则重定位顶层 `cwd` 与嵌套 `attachment.response.cwd`,其余一切保持字节一致(含无 cwd 的行与损坏行)。输出改写后内容 + 每行改动记录。 | pathCodec |
| `mover` | 移动 + 暂存 + 提交 + reconcile + 回滚的核心(见 §5)。 | db, pathCodec, cwdRewriter, claudeJson |
| `claudeJson` | 读 / 原子合并写 `~/.claude.json` 的 projects 子树(白名单克隆、加锁、rename 前再读、保留其它 key)。 | — |
| `db` | better-sqlite3 schema + 迁移 + 查询。 | — |
| `ipc` | 经 preload 暴露给渲染层的类型化 IPC 处理器。 | 全部 |

### 渲染进程(React)

三栏 CSS-grid 布局 + 底部操作栏 + 弹窗。

- **左 — 目录面板:** 按真实 cwd 聚合的项目(树或列表),会话数、"含已移动会话"徽标。读 DB 的 `projects`/`sessions`。
- **中 — 会话面板:** 选中目录下的会话,**多选**。列:标题/预览、消息数、体积、最近活动、移动徽标。
- **右 — 文件系统浏览器:** 完整文件系统目录浏览,面包屑,**单选**目标。提示目标是否已是已知项目。
- **MoveBar:** `移动 N 个会话 → <目标>`(≥1 会话 + 选定目标才可点)→ **确认弹窗**(预览见 §3.8)→ 执行 → 进度 → 逐会话结果。
- **刷新:** 手动;重扫磁盘,与 `sessions` diff,显示 `+N / -M / ~K` 预览;扫描错误以非阻塞警告呈现(绝不静默)。
- **历史视图(次要):** 列出 `moves`,显示回收区磁盘占用,支持**撤销**(从回收区回滚一次已完成的移动)与**清理**(手动删除回收区)。

## 5. 移动算法(逐会话)

批处理语义:每个选中会话是一个**独立提交单元**(出错继续);汇总报告逐会话成功/失败。

预检(任何改动前,逐会话):
1. **活跃保护:** stat jsonl;mtime 在阈值内 → 拒绝并提示。
2. **冲突保护:** 目标文件夹已含 `<id>.jsonl` 或 `<id>/` → 阻止(绝不覆盖);在预览里报告冲突。
3. **编码碰撞保护:** 若 `encode(目标)` 文件夹已存在,且其会话的真实 cwd 与 `目标` 不同 → 阻止(有损编码碰撞)。
4. 计算 `srcRoot`(选中目录的真实路径)、`dstRoot`(目标)、`targetFolder = encode(dstRoot)`;目标文件夹不存在则创建。

提交(复制 → 校验 → 提交 → 最后删除;绝不先删源):
5. **快照/记录:** 开 `moves` 行(status=`pending`);记录元数据。
6. **改写 + 写入目标:** 把主 jsonl 流式过 `cwdRewriter`,改写版写入目标;每个 `subagents/*.jsonl` 同理。记录每行 cwd 改动。
7. **搬移不改写的 sidecar:** 把 `tool-results/`、`hooks`、`*.meta.json` 从源 `rename` 到目标。
8. **校验:** 确认目标文件存在、行数匹配、无写入错误。
9. **原始件暂存到回收区:** 把原始主 jsonl + 原始子代理 jsonl `rename` 进 `~/.claude/.cc-move-trash/<moveId>/`(保留相对布局)。
10. **更新 `.claude.json`** 按 §3.7;置 `claude_json_updated`。
11. **提交:** `moves.status=done`;更新 `sessions`/`projects` 索引行。

失败 / 崩溃处理:
- 第 11 步前任何错误 → **回滚**:从回收区/源恢复原始件,删除已写入的部分目标文件,标记 `moves.status=failed`。
- **启动 reconciler:** 启动时查 `moves.status=pending`;依据磁盘现状,要么完成、要么回滚;绝不留半移动状态的会话。

撤销(用户发起,针对 `done` 且回收区仍在的移动):
- 把目标 sidecar 搬回源;从回收区恢复原始件到源;删除目标的改写 jsonl;还原 `.claude.json` 改动;标记 `rolledback`。

## 6. SQLite schema

```
projects(
  project_path_abs PK, folder_name, exists_on_disk, in_claude_json,
  session_count, total_size_bytes, last_activity_at,
  first_indexed_at, last_indexed_at )

sessions(
  session_id PK, project_path_abs, folder_name, cwd,
  title, first_message_preview, started_at, last_activity_at,
  message_count, line_count, size_bytes, mtime,
  git_branch, claude_version, entrypoint, is_sidechain,
  has_sidecar, subagent_count, tool_results_bytes,
  moved_flag, last_move_id, first_indexed_at, last_indexed_at )

moves(
  id PK, session_id, project_name,
  source_dir_abs, source_folder, source_cwd,
  target_dir_abs, target_folder,
  moved_at, status,                 -- pending|done|failed|rolledback
  rewritten_field_count, sidecar_bytes, trash_path, claude_json_updated )

cwd_changes(move_id, file_rel, line_no, old_cwd, new_cwd)  -- 紧凑改写记录

snapshot_lines(move_id, file_rel, line_no, content)        -- 仅小 jsonl(低于阈值)

meta(schema_version)
```

`sessions`/`projects` 是显示缓存。mover 在改动前**始终重新校验**目标文件(size+mtime),移动本身绝不信任 DB。

## 7. 错误处理与边界情形

- 流式处理 + 跳过损坏(NUL)行;改写时对这些行字节级原样透传。
- SQLite `snapshot_lines` 设体积上限;大文件只靠回收区。
- 跨文件系统目标:`rename` 跨挂载点可能失败 → 退化为 copy+delete,沿用同样的"先校验后删"纪律。
- `memory/` 符号链接:用 `lstat`,绝不跟随或移动。
- 自引用的 `~/.claude` 项目(cwd 就是数据目录):警告;仅在显式确认后允许,因为改写可能触及工具自身的存储路径。
- `.claude.json` 并发写者:加锁 + rename 前再读 + 只合并 `projects`。与"拒绝活跃会话"一致(建议移动期间无运行中的 Claude)。
- 刷新扫描错误必须呈现,绝不静默吞掉。

## 8. 测试

- **vitest。** 纯模块 + fixture:`pathCodec`(对真实文件夹名做快照测试,含开头 `-` 与 `--`)、`cwdRewriter`(fixture 让源路径同时出现在 cwd 字段与消息正文——断言正文不动、前缀已重定位、`/tmp` cwd 保留、损坏行透传)、`jsonlScanner`(多 cwd、无 cwd 行类型、缺时间戳、标题优先级)。
- **mover** 集成测试,跑在临时假 `~/.claude` 树上:happy path、多会话批处理含一例失败、冲突阻止、活跃会话拒绝、移动中途崩溃 reconciler、从回收区撤销、跨文件系统退化。
- 目标覆盖率 ≥80%。

## 9. 不在 v1 范围(YAGNI)

- `fs.watch` 实时同步(仅手动刷新)。
- 复制(非破坏性副本)模式。
- 超出 cwd 重定位的会话内容编辑。
- 回收区自动 GC(仅在用户显式请求时手动清理)。
- 全量历史归档与还原(见 §10,属于未来方向)。

## 10. 未来方向(暂不实现,但需保持可扩展)

用户已明确:当前先交付上述移动 + 索引 + 回收区能力,**未来会增加"全量历史归档与还原"**——即不仅备份"被移动过"的会话,而是对全部会话内容做归档,并支持任意时点还原。

为不阻断该方向,v1 设计需保持以下可扩展点:

- **SQLite 与回收区分离的存储边界**保持清晰:索引(元数据)、移动历史(`moves`)、字节级备份(回收区)三者解耦,未来"全量归档"可作为第四类存储独立接入,不必改动现有表。
- `snapshot_lines` 的体积阈值与"内容存哪里"的策略集中在一处(`db` + `mover`),未来切换到全量归档时只改这一层。
- `mover` 的"暂存/提交/回滚/reconcile"流程与具体备份后端(回收区 vs 归档库)解耦,便于未来加归档后端。
- 不在 v1 引入会破坏上述边界的捷径(例如把大文件内容硬塞进现有表)。
