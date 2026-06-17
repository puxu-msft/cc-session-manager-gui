# 会话归档 / 还原 — 设计规格

**日期:** 2026-06-17
**状态:** 已批准,可进入实现计划
**前置:** 落地 [2026-06-15 主设计](2026-06-15-cc-move-session-design.md) §10「未来方向:全量历史归档与还原」。本文经一轮 subagent 对抗审查(数据安全 + 架构一致性两路)后定稿,核心纪律统一收敛到「照搬 mover 的 staging → 校验(含 checksum)→ 原子提交 → pending+reconcile → verbatim 回滚」。

## 1. 目的

在现有「移动会话」能力之外,增加对会话内容的**全量归档**与**任意时点还原**:

- **快照(snapshot):** 把某个会话当前的完整内容(`<id>.jsonl` + 同名 `<id>/` sidecar 子树)字节级打包进一个独立归档库,作为一个**版本**。原会话留在磁盘继续活动。纯备份。
- **归档(archive):** 同快照产出一个版本,然后把原会话从活动区移除,让会话列表清爽。归档库里那份带校验的版本包即其权威副本,需要时再还原。
- **还原(restore):** 选某会话的任一历史版本,把内容写回该版本记录的原路径;**覆盖前把会被触碰的现状文件/目录整体搬入一个备份区**,保证不丢数据、可撤销。

同一会话可多次快照/归档,形成多版本时间线;「任意时点还原」= 在该时间线里选任意版本写回。

## 2. 与主设计的关系:第四类存储,独立接入

主设计 §10 明确要求:「全量归档可作为**第四类存储独立接入,不必改动现有表/目录边界**」「mover 的暂存/提交/回滚/reconcile 与具体备份后端解耦」。

对抗审查发现的最严重缺陷,正是早期草案为「复用回收区 `.cc-move-trash/`」而违背了这条——会导致清空回收区时 `rmSync` 删掉归档的唯一副本、占用统计 id 串号、reconcile 生命周期互相破坏。**本设计据此把归档/还原做成完全独立的存储与状态机,不复用 trash 目录、不复用 moves 表、不与 mover 共享任何字节存储区。**

## 3. 已确认的产品决策

1. **三种操作:** 快照(留原件)、归档(移除原件)、还原(写回原位)。均支持在会话面板多选后批量执行;每个会话是独立提交单元,出错继续,汇总逐会话结果。
2. **快照与归档在归档库里产出形态完全一致的版本包**(还原逻辑唯一)。区别只在归档多一步:版本包 `complete` 且校验通过后,**删除** `projects/` 下的原件(归档库版本包即其归宿,这是「移动到归档库」而非破坏性删除)。
3. **不改写 cwd。** 快照/归档/还原都对内容做字节级处理——快照的意义就是「当时原样」。还原 v1 **只写回原 cwd 原位**,不支持改目标,不过 `cwdRewriter`。
4. **整棵子树随版本走:** `<id>.jsonl` + 整个 `<id>/`(subagents / tool-results / hooks / `*.meta.json`)。`memory/` 是项目级、可能是 symlink,**绝不归档**。
5. **还原 = 用版本子树整体替换目标子树**(见 §6),而非逐文件覆盖。目标子树里版本没有的多余文件,也一并搬入备份区,使备份区成为「还原前现状的完整镜像」,撤销才彻底。
6. **活跃会话保护:** 快照/归档/还原都复用 mover 的 `LIVE_MTIME_THRESHOLD_MS`(60s)护栏。快照另做「前后 stat 比对」防止读到撕裂内容(见 §5)。归档要不可逆地移除原件,门槛更严:活跃则拒绝。
7. **`.claude.json` 默认不触碰。** 归档/还原都不迁移 project、不改 cwd,故默认不动 `.claude.json`;归档令某 project 变空也**保留**其条目(与 mover「源条目保持不动」纪律一致)。还原后若目标 project 条目缺失,仅**警告**,v1 不自动重建(重建列入未来方向)。
8. **无限期保留 + 手动清理 + UI 显示占用:** 归档库与备份区沿用回收区同款取舍,UI 显示占用并提供手动删除版本 / 清理备份区入口。**不做自动 GC。**
9. **per-source 隔离:** WSL 双源(local / windows)各自独立的归档库、备份区与索引表,严格不串源(见 §4)。

## 4. 存储布局与 per-source 派生

三个 `.cc-move-*` 磁盘区,职责互不重叠:

| 目录(每源各一份) | 用途 | 状态 |
|---|---|---|
| `<claudeHome>/.claude/.cc-move-trash/` | **移动**的原件备份 | 既有,本设计不碰 |
| `<claudeHome>/.claude/.cc-move-archive/<sessionId>/<versionId>/` | **归档库:** 每版本一个目录,内含 `content.tar.gz` + `manifest.json` | 新增 |
| `<claudeHome>/.claude/.cc-move-backups/<restoreId>-<sessionId>/` | **还原安全网:** 被还原触碰的现状文件/目录整体搬入,保留相对布局 | 新增 |

**派生链(关键,避免 history.jsonl 踩过的 `homedir()` 硬编码坑):**

- `Source` 接口(`src/main/sources.ts`)新增 `archiveRoot`、`backupsRoot`;在 `sourceFromClaudeHome` 一处派生:
  - `archiveRoot = join(claudeHome, '.claude', '.cc-move-archive')`
  - `backupsRoot = join(claudeHome, '.claude', '.cc-move-backups')`
- `Env` 接口(`src/main/appState.ts`)透传 `archiveRoot`、`backupsRoot`;`getEnv()` 从活动源填充。
- **所有 archiver 入口只从 `env.*` 取根,禁止 `homedir()` / `constants.ts` 硬编码。** `constants.ts` 不新增 `*_ROOT()` 风格的硬编码常量。
- 两张新表落在每源各自的 `index-<id>.db`(`appState.ts` 已按源开库),**天然隔离,不加 source 列**。
- 版本目录命名只用 `<sessionId>/<versionId>`;`versionId` 是该源 DB 内自增主键,跨源不可能碰撞(各自独立库)。

`versionId` / `restoreId` 命名一律用 DB 自增主键(字符串化),不用 datetime,杜绝「同秒撞目录」。

## 5. 数据模型(SQLite,新增两表)

`SCHEMA_VERSION` 由 1 升到 2;`SCHEMA_SQL` 追加两表(`CREATE TABLE IF NOT EXISTS`,对既有库幂等)。读方法沿用 `db.ts` 既有 **snake_case → camelCase 手工回填** 约定,IPC/types 暴露 camelCase。

```sql
CREATE TABLE IF NOT EXISTS archive_versions (
  version_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT,
  kind              TEXT,      -- snapshot | archive
  status            TEXT,      -- pending | complete   (只有 complete 可被还原;失败不留态,直接删行)
  -- 归属快照(自给自足,不依赖 sessions 行 join):
  project_path_abs  TEXT,
  source_folder     TEXT,      -- encode(cwd) 文件夹名
  source_cwd        TEXT,      -- 会话真实 cwd(还原写回的目标)
  title             TEXT,      -- 归档当时的展示标题
  -- 体积/计数(展示用;真正的还原校验以 manifest 为准):
  jsonl_size_bytes  INTEGER,
  sidecar_bytes     INTEGER,
  gz_total_bytes    INTEGER,
  has_sidecar       INTEGER,
  subagent_count    INTEGER,
  line_count        INTEGER,
  archived_at       TEXT,
  note              TEXT
);

CREATE TABLE IF NOT EXISTS restores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id    INTEGER,
  session_id    TEXT,
  -- 归属快照冗余(version 被删后仍可解释这次还原):
  source_cwd    TEXT,
  target_dir_abs   TEXT,       -- 写回的真实 cwd(= source_cwd,v1 不支持改目标)
  target_folder    TEXT,       -- encode(target_dir_abs)
  backup_path      TEXT,       -- <backupsRoot>/<id>-<sessionId>/
  phase            TEXT,       -- staging_done | backup_done | commit_done
  status           TEXT,       -- pending | done | failed | undone
  restored_at      TEXT
);
```

**版本包结构** `<archiveRoot>/<sessionId>/<versionId>/`:

- `content.tar.gz` — 整棵会话子树流式 tar + gzip。用 tar **不跟随 symlink**(`follow:false`):symlink 仅以「链接类型 + 目标字符串」入档,绝不解引用其内容。损坏行(NUL/截断)字节级原样入档。
- `manifest.json` — 逐条目记录:相对路径、类型(`file` / `dir` / `symlink`)、原始字节数、内容 `sha256`(symlink 记目标字符串的 sha256);外加包级 `gz_sha256`。还原时据此逐条目校验。

## 6. 算法

### 6.1 快照(snapshot)

1. **活跃保护:** stat `<id>.jsonl`,mtime 在 60s 内 → 拒绝并提示先关闭会话。
2. **开 pending 版本行:** 插 `archive_versions(kind=snapshot, status=pending)`,得 `versionId`。
3. **构建到 staging:** 在 `<archiveRoot>/<sessionId>/.staging-<versionId>/` 流式 tar+gzip 整棵子树,边写边算每条目 sha256 → `manifest.json`;`fsync`。
4. **防撕裂校验:** 重新 stat `<id>.jsonl` 与子树关键文件,若 size/mtime 较步骤 1 有变 → 判定「快照期间被写」,**删 staging 与该 pending 版本行**,提示重试。
5. **提交:** staging 目录 `rename` 到正式 `<versionId>/`;置 `status=complete`。原件不动。

### 6.2 归档(archive)

1~5 同快照,但 `kind=archive`,且步骤 1 活跃则**直接拒绝**(不可逆操作不冒险)。
6. **移除原件:** 版本 `complete`,且包文件完整性校验(`content.tar.gz` 存在、字节数与 `manifest` 的 `gz_sha256` 一致)通过后,删除 `projects/<source_folder>/<id>.jsonl` 与 `<id>/` 子树。
7. **更新索引:** 删/标记该 `sessions` 行(归档会话从活动列表消失;归属信息已冗余在 `archive_versions`,时间线不依赖该行存活)。

> 任一步在「删除原件」之前失败:原件原样未动,版本要么 pending(被 reconcile 清)要么 complete(成了一个普通 archive 版本,无害)。删原件失败则返回 failed、保留原件;此时重试归档会再建一个新 archive 版本(不做版本去重,旧版本可手动删)。删原件已成功的会话重试时因原件不存在直接 skipped。

### 6.3 还原(restore) — 原子的「整体替换」

前置预检(复用 mover 三道,见 `mover.ts`):
- **版本可用:** 目标版本 `status=complete`;`manifest.json` 与 `content.tar.gz` 存在。
- **活跃保护:** 目标位置若已存在同 id 会话且活跃 → 拒绝。
- **冲突 / 编码碰撞:** 目标文件夹 `encode(source_cwd)` 内若已有**不同真实 cwd** 的会话 → 阻断(有损编码碰撞);若已有同 id 但属另一来源 → 阻断。

提交(staging → 备份现状 → 原子换入,全程 `restores` 记 `phase`):
1. 插 `restores(status=pending, phase=null)`,得 `restoreId`;`backup_path = <backupsRoot>/<restoreId>-<sessionId>/`。
2. **staging:** 解压 `content.tar.gz` 到 `<archiveRoot>/<sessionId>/.restore-staging-<restoreId>/`;逐条目按 `manifest` 校验 sha256 与字节数。任一不符 → **中止,不触碰目标、不建备份**,置 `failed`。校验通过 → `phase=staging_done`。
3. **备份现状(整体替换的关键):** 把目标 `<id>.jsonl` 与整个 `<id>/` 子树里**所有现存条目**(= 当前磁盘全集,不只是版本里有的)`rename` 进 `backup_path`,保留相对布局。归档移除过原件时此处可能为空。完成 → `phase=backup_done`。
4. **换入:** staging 目录内容 `rename` 到目标位置。完成 → `phase=commit_done`;`status=done`。

崩溃 reconcile(见 §7):依 `phase` 精确前滚或回滚,保证「备份区里的现状永远可无损搬回」。

### 6.4 撤销还原(undo restore)

针对 `status=done` 的 restore:删除目标(本次换入的内容)→ 把 `backup_path` 里的现状 `rename` 回原位 → 置 `status=undone`。因步骤 6.3.3 备份的是**完整现状镜像**,撤销可完整复原(无残留)。

### 6.5 撤销归档(undo archive)

「撤销归档」不是独立的字节操作,而是**对该 archive 版本执行一次 restore**(§6.3),把内容写回原位。不依赖任何 trash 副本。

### 6.6 跨文件系统

所有 `rename`(staging→正式、现状→备份、staging→目标、撤销搬回)复用 mover 同款封装:`rename` 失败(EXDEV)→ 退化为 copy+delete,沿用「先校验后删」纪律。

## 7. 崩溃恢复(reconcile)

新增 `archiverReconcile(env)`,在 `registerIpc` 启动时与 `source:set` 切源时,与现有 `mover.reconcile` **并列调用**。

- **pending 版本(snapshot/archive):** 删除其 `.staging-*` 目录与 `pending` 行;原件从未被动过(删除原件只在 complete 后),无损。
- **pending restore,按 phase:**
  - 无 phase / `staging_done`:目标尚未被动 → 删 `.restore-staging-*`,置 `failed`。
  - `backup_done`(现状已搬进备份、尚未换入):把 `backup_path` 搬回原位(前滚到「还原前」),删 staging,置 `failed`。
  - `commit_done`:实际已完成,补记 `status=done`。
- **孤儿目录:** 启动时清理 `<archiveRoot>` 下无对应 complete 版本行的 `.staging-*` / `.restore-staging-*`。

不变量:**任何时刻,要么目标位置是完整的旧内容,要么备份区持有完整旧内容可搬回;绝不存在「旧的没了、新的半截」的终态。**

## 8. 架构与模块

技术栈不变(electron-vite + better-sqlite3 主进程 + React 渲染 + preload 桥)。新增/改动:

| 模块 | 职责 | 备注 |
|---|---|---|
| `src/main/core/archiver.ts` | snapshot / archive / restore / undoRestore / reconcile 核心 | 纯逻辑,跑临时假 `~/.claude` 单测;**不复用 mover,不改写 cwd** |
| `src/main/core/tarPack.ts`(或内联) | 流式 tar+gzip 打包 / 解包 + manifest 生成校验 | 用成熟 tar 库(`follow:false`);symlink 不解引用 |
| `src/main/sources.ts` | `Source` 加 `archiveRoot` / `backupsRoot` | 一处派生 |
| `src/main/appState.ts` | `Env` 透传两根;`getEnv()` 填充 | — |
| `src/main/db/schema.ts` + `db.ts` | `SCHEMA_VERSION→2`;两表 SQL + snake_case 回填读写方法 | 沿用 `history_rewrites` 同款 rowMap 风格 |
| `src/main/ipc.ts` + `src/preload/index.ts` + `src/shared/types.ts` | 新增 `archive:snapshot` / `archive:archive` / `archive:listVersions` / `archive:restore` / `archive:undoRestore` / `archive:deleteVersion` / `archive:usage` 等类型化通道 | **复用现有 preload bundle(.cjs),只扩 `api` 对象**;验证以渲染层 console 调到 `window.api.archive*` 为准 |
| 渲染层 | 会话面板操作栏加「快照」「归档」按钮(各带确认预览);新增**独立**「归档时间线」modal | 见 §9 |

`archiver` 自带独立的 staging/commit/rollback/reconcile 状态机,与 mover 的 trash 生命周期零交叉。

## 9. UI / 信息架构

- **会话面板操作栏:** 在「移动」旁加 **快照**、**归档** 两个按钮(≥1 选中会话才可点)。各弹**确认预览**:涉及会话、版本体积估算、是否含 sidecar(及 tool-results 体积)、**归档会移除原件**的醒目提示。
- **归档时间线(独立 modal):** 按会话列出其全部 complete 版本(时间、kind、体积、note);每版本可 **还原** / **删除该版本**。顶部显示归档库总占用 + 备份区占用 + 手动清理入口。
- **入口分组:** 现有 MoveBar 已有「历史」「对账」两个次要入口;新增「归档」入口避免按钮泛滥——与「历史」并列为同一组次要入口(具体分组在实现期定,不与现有冲突即可)。
- 归档/还原后**立即更新索引行**并刷新受影响列表;扫描/操作错误非阻塞呈现,绝不静默。

## 10. 测试

vitest,跑 Electron ABI 运行时(`scripts/test-electron.mjs`),在临时假 `~/.claude` 树上。`archiver` 集成测试 fixture **必须覆盖**(对照主设计 §8 的 mover fixture 同源):

- **happy path:** 快照→归档→还原→撤销还原,断言字节恒等(还原后 `<id>.jsonl` 与原始逐字节相同)。
- **损坏行:** 含 NUL/截断行的 jsonl,打包→还原后**字节恒等**(不修复、不丢弃)。
- **symlink:** 子树内 symlink 不被解引用(manifest 记为 symlink + 目标字符串;还原重建为 symlink,不写入目标内容)。
- **大 sidecar:** 多 MB tool-results 只入档一次,不复制两份。
- **多版本:** 同会话多次快照,时间线含多个 complete 版本,各自独立可还原。
- **整体替换 / 差集备份:** 还原旧版本时,目标里版本没有的多余文件被搬入备份区;撤销后完整复原、无残留。
- **崩溃 reconcile:** 在 §7 每个 phase 注入崩溃,断言要么旧内容完整、要么可从备份完整搬回。
- **活跃拒绝:** mtime 在阈值内的会话被拒绝快照/归档;快照期间被写触发防撕裂作废。
- **编码碰撞预检:** 还原写回时目标文件夹被不同真实 cwd 占用 → 阻断。
- **多源隔离:** 归档只作用于活动源;两源相同 sessionId 各自独立、互不串档。

目标覆盖率 ≥80%(核心逻辑层)。UI / IPC / Electron 胶水不计入。

## 11. 不在本期范围(YAGNI)

- 自动定时 / 文件变化触发的后台快照(仅手动)。
- 内容寻址去重 / 增量存储(手动低频,版本包各自完整;列入未来优化)。
- 还原到**非原位**目标(需引入 cwdRewriter;v1 只回原位)。
- 归档/还原对 `.claude.json` 的自动重建(仅警告)。
- 归档库 / 备份区自动 GC(仅手动清理)。

## 12. 未来方向(保持可扩展)

- 版本包格式集中在 `tarPack` 一层,未来切换到去重 / 增量存储只改这一层,`archive_versions` 表与 reconcile 状态机不变。
- 主设计 §10 关于「`snapshot_lines` 体积阈值与内容存哪里的策略集中在 db+mover 一处」的可扩展点保持:归档作为被调用的全量后端接入,不另起一套阈值。
- 还原到非原位 + cwd 改写,可在 v2 复用现有 `cwdRewriter` 与其逐行改动记录机制。
