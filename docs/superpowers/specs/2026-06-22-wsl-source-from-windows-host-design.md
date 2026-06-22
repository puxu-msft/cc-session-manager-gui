# Windows host 检测运行中 WSL 并作为完整数据源接入 — 设计规格

**日期:** 2026-06-22
**状态:** 已批准(经两轮对抗审查收敛),可进入实现
**关联计划:** `docs/superpowers/plans/2026-06-22-wsl-source-from-windows-host.md`
**冻结说明:** 本文档定格设计决策与裁定缘由,不回头改。现状以 `docs/ARCHITECTURE.md` 为准并链接本文讲缘由。

## 1. 目的

本工具的多数据源探测([src/main/sources.ts](../../../src/main/sources.ts) `detectSources()`)原本只覆盖**一个方向**:进程运行在 WSL(Linux)内时,反向把 Windows 侧 `.claude`(经 `/mnt/c`)接为第二源。**缺失对称方向**:本工具作为 `.exe` 跑在 **Windows host** 上时对 WSL 一无所知,只返回 `local`(`C:\Users\xx\.claude`)。

本设计补齐该方向:Windows host 上**检测当前哪些 WSL 发行版已启动(running,而非仅已安装)**,对每个探测其内部 `~/.claude`,接入为**完整数据源**(可在该源**内部**移动 / 归档,与 `local` 同语义)。

## 2. 核心约束(用户明确)

移动与归档恢复必须 **Windows→Windows、Linux/Mac→Linux/Mac**,二者**默认不可切换**。不做跨平台搬迁、不翻译 cwd。在本设计里由 **fsAnchor 强不变量**承载(见 §5)。

## 3. 已验证的技术事实(真实 `wsl.exe` 探针)

- `wsl.exe --list --verbose` 输出 **UTF-16LE**(可能带 BOM `FF FE`,行尾 `\r\n`),含 `NAME / STATE / VERSION` 三列与 `*` 默认标记。`--quiet` 拿不到 STATE/VERSION,故枚举用 `--verbose`。
- `wsl.exe -d <distro> --exec sh -c 'echo $HOME'` 输出 **原样 UTF-8**(passthrough,无 `\0`),返回**默认登录用户**的 HOME(由 `/etc/wsl.conf [user] default` 或注册表 `DefaultUid` 决定,可能是 `root`)。
- 宿主侧访问 WSL 文件用 UNC:新式 `\\wsl.localhost\<distro>\home\<user>`(Win10 21H2+/Win11);旧 build 用 `\\wsl$\<distro>\...`。**WSL1 无 9P/UNC rootfs 视图,排除**。
- 两类命令编码不同(管理类 UTF-16LE / passthrough UTF-8),实现须分别处理。

## 4. 分阶段

- **Phase 1 — 异步探测 + 扫描(读)**:近乎复用现有 `Source`/`getEnv()`/per-source DB/scanner;读路径走 UNC。可在非 Windows 环境实现纯函数并单测,真机验证在 Windows host。
- **Phase 2 — WSL 活动源内移动 / 归档(写)**:以重设计的 Windows 真机 spike 为门槛,在「UNC 直接写」与「`wsl.exe --exec` 内部执行写」间裁定。

## 5. 关键设计决策与裁定缘由

### 5.1 Source 模型:osFamily + fsAnchor + claudeHomeCwd(三个正交不变量)
`Source` 新增三个**各自独立、不可互相推导**的字段,由 `localSource`/`buildWslSources` 显式产出:
- **`osFamily: 'windows' | 'posix'`** —— 回答「是不是同一 OS 家族(cwd 无需跨平台翻译)?」。**直接承载用户约束**「Windows→Windows、Linux/Mac→Linux/Mac 默认不可切」。**不可由 fsAnchor 推导**:Windows-反向源经 `/mnt/c/...` 访问(fsAnchor 字符串像 posix),但它装的是 **Windows 的 `.claude`、会话 cwd 是 `C:\…`**,osFamily 必须是 `windows`——靠解析 anchor 前缀去猜会猜错,故必须是显式字段。
- **`fsAnchor: string`** —— 回答「是不是同一物理文件系统?」。rename 技术安全(不跨 device);本机/`/mnt/c` 源=`claudeHome`、远程 WSL 源=`\\wsl.localhost\<distro>`。区分同族不同 share 的 `Ubuntu`↔`Debian`。
- **`claudeHomeCwd: string`** —— 会话 cwd 的 POSIX 根(本机=`homedir()`;WSL 源=probe 的 `/home/xp`)。供自引用守卫与 `reRoot` 比较(比的是会话 cwd,永远 POSIX,**绝不能用 UNC**)。

**裁定缘由(经代码审查中一次错误的「砍掉 osFamily」后修正)**:审查曾以「osFamily 既不决定写后端(由 anchor 类型决定)、又不做 anchor 守卫,故冗余」为由砍掉它——此推断有误。「不决定后端」≠「冗余」:三字段回答三个不同问题。`Ubuntu→Debian` 是**同 osFamily(posix,cwd `/home/…` 无需翻译,语义合法)但异 fsAnchor(异 share,技术上跨 device 需 copy 而非 rename)**——正是这个例子证明二者不能合并。**osFamily = 语义兼容(产品规则),fsAnchor = 技术安全(rename 不跨 device)**,两层防线各司其职。

### 5.2 移动/归档守卫:osFamily(产品规则)+ fsAnchor(技术安全)双层,当前定位诚实
- **osFamily 层**:跨源移动/恢复默认要求**同 osFamily**(承载用户「Windows↔posix 不可切」)。这是用户规则的直接表达。
- **fsAnchor 层**:rename 要求**同 fsAnchor**(同 device);异 fsAnchor 但同 osFamily(如 Ubuntu→Debian)在语义上合法,技术上须降级为 copy+unlink。
- **诚实定位**:当前「单源内移动」目标恒在 `env.projectsRoot` 内([mover.ts:127](../../../src/main/core/mover.ts)),两层守卫**结构性恒真**——现阶段真正的隔离是「`getEnv()` 只返回活动源一套 `projectsRoot`」。两守卫是**为 Phase 2.B(`wsl.exe` 写)及未来任何跨源写路径预留的默认拒绝防线**,不得宣称当前就挡 Ubuntu↔Debian 或 Windows↔posix 互串。

### 5.3 三分严格(unc 原名 / id sanitized / label)
每个 distro 三个派生物严格分开,实现期易错配,签名须标注:
- **UNC 路径用原始 distro 名**(sanitize 会指向不存在的 share → 漏源)。
- **id = `wsl-<sanitize(原始名)>-<sha256(原始名).slice(0,8)>`**,sanitize=`replace(/[^A-Za-z0-9._-]/g,'-')`(进 `index-<id>.db` 文件名,[appState.ts:55](../../../src/main/appState.ts))。**id 恒带原名 hash 后缀**:保证「同一 distro 无论在探测结果中的位置/有无邻居,id 都恒定」。**裁定缘由(经代码审查修订)**:曾用「先到先占裸 id、撞名者才加 hash」,但裸 id 归属依赖 `wsl --list` 不稳顺序 → 同一 distro 跨会话拿到不同 id → `index-<id>.db` 错位丢移动历史/快照,反而违反本红线。恒带 hash 彻底消除顺序依赖(sanitize 空串→纯 hash)。**禁用下标/枚举序去重**。
- **label = 原始名**(纯文本展示安全)。

### 5.4 异步探测 + async request/response(不走广播)
- **卡死根因**:`listSources()` 缓存一次且首触发在同步启动路径([ipc.ts:26](../../../src/main/ipc.ts) `reconcile(getEnv())`);N×(`wsl --exec` 数百 ms~秒 + UNC `existsSync` 9P **不可超时**)串行会冻结主进程。
- **裁定(同步路径)**:`detectSources()` 同步只返回 `local`(本机几个 `existsSync`,廉价);**win32 下不在同步路径探测 WSL**。`getEnv()`/`reconcile` 启动路径绝不触发 WSL 探测。
- **裁定(通知机制,经审查修订)**:实测 `BridgeContext.emit` **绑定本次调用方**([contract.ts:23](../../../src/main/platform/contract.ts)、Electron `event.sender`、Electrobun 静态 `rpcSchema`),**无 handler 之外的自发广播**。新增 `sources:changed` 推送须改两套 runtime contract,成本高。**改用 async request/response**:`sources:refresh` 做成 **async handler**,由前端调用(有 ctx/调用方),内部 `await` execFile 异步探测(不阻塞主进程 event loop,单次 timeout + 总预算 ≤16 distro + 聚合超时),**直接返回完整源列表**;探到的 WSL 源 **in-place 并入** appState 缓存(不整体重赋值,否则 activeId/`dbs` Map 失配)。前端**挂载时 useEffect 自动调一次** + 「重新检测源」按钮再调,即得「自动出现 + 可手动重探」UX。**不需要广播、不碰 contract/bridge/rpcSchema**,比推送方案 KISS。

### 5.5 漏源防御:默认用户可能是 root
`echo $HOME` 给默认用户。服务器型镜像默认 root → `/root/.claude`,而人类用户 `.claude` 在 `/home/xp` 会被静默漏掉。**裁定**:默认 HOME 无 `.claude/projects` 时,回退枚举 `/home/*` 取存在者;HOME 落 `/mnt/*`(家目录在 Windows 盘)→ 跳过记日志(属 Windows 源域,接入违反「不跨平台」)。

### 5.5b 会话 cwd 的「宿主可访问路径」映射(真机发现的读正确性 bug)
扫描时 `existsOnDisk` 用 `existsSync(cwd)` 判存在,但 `cwd` 是**会话所属 OS 的 namespace 路径**,在异 namespace 宿主上恒判不存在 → UI 误报「路径已不存在」。两个对称实例:Windows host 上 WSL 源的 POSIX cwd `/home/…`;WSL 内 Windows 源的 cwd `C:\…`。**裁定**:由 `cwdHostMapFor(hostIsWindows, osFamily, fsAnchor)`(纯函数,**用 osFamily 判别**——再次印证 osFamily 不可由 anchor 推导)产出可序列化映射描述符 `CwdHostMap`(`identity` / `posixToUnc` / `winToMnt`),经 `ScanInput.cwdHostMap` 传入扫描 worker,`hostPathForCwd(cwd, map)` 把 cwd 映射到宿主可访问路径(`/home/x`→`\\wsl.localhost\<distro>\home\x`;`C:\x`→`/mnt/c/x`)再 `existsSync`。本机源 `identity` 保持原行为。

### 5.6 安全:distro/HOME 进 UNC 前结构校验
distro 名是不可信输入(WSL 名允许空格/括号/Unicode,`wsl --import` 可起任意名)。`execFileSync` 不过 shell,**命令注入面安全**(distro 作单个 argv);风险在 **UNC 路径段**:`Ubuntu\..\..\..\c$` 经 `path.win32.normalize` 可穿越到宿主管理共享。**裁定**:distro 进 UNC 前过结构白名单(拒 `\` `/` `..` `$` 控制符/前后空白/可疑 Unicode);`probeWslHome` 返回值校验为绝对 POSIX(无 `..`/盘符);`wslPathToUnc` `normalize` 后断言前缀仍 `\\wsl.localhost\<single-segment>\`。

### 5.7 删除 homedir 静默回退(独立鲁棒化)
[mover.ts](../../../src/main/core/mover.ts) 多处 `?? CLAUDE_JSON()`/`?? TRASH_ROOT()`(行 57/116-117/206/217/228)在 env 字段缺失时静默回退到宿主 `homedir()` → 远程源可能写穿本机 `C:\Users\xx\.claude`,正中「默认不可切换」红线。**裁定:删除回退,env 必填、缺失即抛(fail fast)。** archiver/historyReconciler 实测无此类回退。

### 5.8 写后端 fs-facade 覆盖**全部对源 fs 写**
Phase 2 写后端不是「两入口补丁」,须 facade 化 mover + archiver + fsMove **及崩溃恢复/undo 路径**的全部裸 fs 调用,且**含三条首轮漏列**:`claudeJson.ts`(atomicWrite 改源 `.claude.json`)、`historyJsonl.ts`(rename 改源 `history.jsonl`)、`tarPack.ts`(pack/unpack 写 `archiveRoot`)。否则正向写换后端、恢复路径仍经 UNC 不可靠。

### 5.9 reRoot 铁律 + spike 矩阵化
- `reRoot`/cwd 改写只吃 POSIX `/home/xp/...`;`env.projectsRoot`(UNC,供 I/O)与 `targetPath`(POSIX,供 encode/改写)严格不混用。
- spike 须矩阵化:复现 `executeMove` 完整破坏序列(mkdir→rewrite→rename→trash);rename 失败码(`safeRename` 仅 EXDEV 退化,9P 可能 EPERM/EINVAL/EACCES);symlink 读/写 4 格矩阵;含 root-owned 文件 ownership/mode 保真。

## 6. 留档边界
- 本 spec(冻结)= 设计真相源;实现计划在 `plans/`;spike 裁定在 `spike-results/`(不重复进 memory)。
- 活文档 `docs/ARCHITECTURE.md`(数据源章节)/`docs/ROADMAP.md` 描述现状并链接本文。
- `docs/memory/` 仅收可迁移抽象:wsl.exe 管理命令 UTF-16LE+BOM / passthrough UTF-8;UNC 9P 写行为与 EXDEV/非 EXDEV 退化;WSL1 无 UNC rootfs。
