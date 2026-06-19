# 快照工具 最终方案(v3)

## 一句话定位
一个**独立的 Node/TS CLI**:对任意目录(首要对象 `~/.claude`,也能给 cc-session-manager-gui 自身用)做「分类别 restic 去重增量快照 + 可选 zstd 全量包」,声明式配置,不做加密/不做敏感数据处理(用户已明确放弃)。

## 决策依据(已敲定)
- **引擎:restic**(用户拍板)。去重(CDC,等效无限窗口跨文件/跨快照)、增量、保留策略、内建 zstd 压缩一站搞定。
- **不加密、不处理敏感数据**:砍掉 age / gitleaks / 字段掩码 / 双轨。restic 内部强制加密无法关闭,故用 `restic init --insecure-no-password` → **零口令、零密钥管理**,内部加密对用户透明,不构成负担。
- **独立形态**:自带 `package.json` 的小型 CLI 包,不依赖 Electron;日后可被 cc-session-manager-gui `import` 复用,也能反过来快照该项目。
- **压缩参数(实测结论)**:对会话 JSONL 这类长距离跨文件冗余,**zstd + 大窗口** 是最优,比率反超 xz 且解压快约 7×。
  - 564MB 真实样本:zstd-19 无long 60×;`--long=27` 71×;`--long=31` 73×;`-22 --ultra --long=31` **84×**;xz-9e 仅 71×。
  - restic 仓库:靠**去重 + `--compression max`**,跨文件冗余由去重解决,无需 `--long`。
  - 全量包那条腿:`zstd -19 --long=31 -T0`(甜点,73×,32 核近瞬时)默认;`-22 --ultra --long=31` 可选榨极限。解压需同带 `--long=31`。

## 双产物(融合)
1. **restic 仓库(主)**:去重 + 增量 + 保留。直接 backup 目录(不走 stdin,保留文件级去重)。还原 `restic restore`。
2. **可移植全量包(可选)**:`tar -cf - <清单> | zstd -19 --long=31 -T0 > <cat>-<ts>.tar.zst`。零依赖、`tar --zstd -xf` 直接解,用于离线/异地随手拷。

## 声明式分类配置
一份 `snapshot.config.(json|ts)` 定义:
```
{
  target: "~/.claude",            // 或任意目录;支持 WSL 双源(local / windows)
  resticRepo: "~/.claude-snapshots/restic",
  portableOut: "~/.claude-snapshots/portable",
  excludeBaseline: ".gitignore",  // 以目标内 .gitignore 为排除基线
  categories: [
    { name: "config",  include: ["rules","skills","CLAUDE*.md","AGENTS*.md","my","*.sh","settings*.json","config.json"], tag: "config" },
    { name: "history", include: ["projects","file-history","session-data"], tag: "history" },
    // plugins 默认排除,仅 installed_plugins.json + known_marketplaces.json
  ],
  exclude: ["plugins/!(installed_plugins.json|known_marketplaces.json)","cache","shell-snapshots","session-env","ide","*.log","backups",".git","<输出目录自身>"],
  retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
  portableLevel: 19   // 或 22
}
```
- 类别用 restic `--tag` 区分,各自 `--exclude`;一次 run 跑所有类别。
- WSL 双源:`detectSources()` 思路复用——可对 local / windows 各自快照。

## 模块结构(独立包 `tools/claude-snapshot/` 或独立 repo)
```
src/
  config.ts      // 读取+校验配置(zod),解析 target/排除基线
  categories.ts  // 类别 → restic argv / tar argv(含 --exclude、-h 不跟符号链接)
  exclude.ts     // 合并 .gitignore 基线 + 硬排除 + 输出目录自排除
  restic.ts      // 封装 init(--insecure-no-password)/backup/forget --prune/snapshots/restore;isAvailable()
  portable.ts    // tar→zstd --long=31 进程链(fd 重定向,数据不进 Node),原子 rename
  retention.ts   // 纯函数:portable 包 keep-last-N → 删除列表;restic 透传 forget --keep-*
  plan.ts        // 纯函数:config → 执行计划(预览:每类清单/预估)
  cli.ts         // 子命令 plan / backup / list / restore / prune
  types.ts
```
- 纯函数(config/categories/exclude/retention/plan)可 vitest 单测(临时夹具目录)。
- 副作用(restic/portable)集中在封装层;子进程编排,数据走 fd 不经 Node。

## CLI
```
claude-snapshot plan      # 干运行:列出每类清单/预估,不执行
claude-snapshot backup    # restic 各类别快照 (+ --portable 同时出 tar.zst)
claude-snapshot list      # restic snapshots / portable 包列表
claude-snapshot restore   # 还原指定快照
claude-snapshot prune     # forget --prune + portable keep-last-N
```
- 默认输出 `~/.claude-snapshots/`(在目标外,避免套娃;若落入目标内则运行时动态加 `--exclude`)。
- 输出目录 0700。

## 外部依赖
- 必需:`restic`(需装)、`tar`、`zstd`(已装)。`restic` 未装则 CLI 报错提示安装;`--portable` 仅需 tar+zstd。
- 砍掉:age、gitleaks(用户放弃安全处理)。

## 交付顺序(TDD)
1. types + config(zod 校验)+ exclude(合并 .gitignore)+ categories + plan + retention(+单测)。
2. restic 封装(init/backup/forget/snapshots/restore + isAvailable)。
3. portable 封装(tar→zstd --long=31 进程链,原子 rename)。
4. cli 五个子命令接线。
5. 集成测试:小夹具实跑 restic backup→restore 往返一致 + 增量第二次只增少量 + portable 包可解;真跑一次对 `~/.claude` 出快照。
6. README + 用法。

## 未来扩展
- 被 cc-session-manager-gui `import` 复用(已是独立包,直接依赖)。
- restic 后端扩展(SFTP/S3/rclone)异地。
- React UI:选源/类别 → 预览 → 快照 → 历史 → 还原。
- 若日后要安全:restic 加口令即恢复加密,gitleaks 作可选 hook。

## 已知取舍(用户已确认)
快照含明文凭证(历史 JSONL / settings.json token);因 `--insecure-no-password`,restic 仓库虽内部加密但无口令保护,任何人持仓库+restic 可读。用户明确接受此取舍,本机本地使用。
