# cc-move-session — 项目协作指南

把 Claude Code 会话在不同工作目录间安全移动/快照/归档/还原的桌面工具(当前 Electron + React,正改造为 Electrobun+Bun 一等 / Electron 兼容的双运行时)。**项目说明、用法、完整文档目录见 [README.md](README.md)**;本文件只承载「与本用户协作的原则」「工程纪律」「本项目留档约定」,这些始终适用,不要每轮遗漏。

## 与本用户协作(始终适用)

- **语言**:回复一律用**中文**(即便用户用英文提问,也绝不用日语或英语——曾误用日语被当即纠正)。代码、命令、专有名词保持原文。文档、记忆、注释同样一律中文,且**不做因行宽产生的硬换行**:段落写成单行靠编辑器软换行,只在语义边界(段落/列表项/标题)换行;表格与代码块照常。
- **问题不是指令**:用户用疑问句问某事(「X 是什么」「为什么 Y」)时**只作答**,不要顺手把 X 执行了。超出明确要求的动作——尤其删除、提交、改动范围之外的东西——先停下确认,绝不擅自扩大授权。(教训:用户问「未消费的 summary 字段是什么」,我却擅自删了那两个字段并提交,被纠正「没让你删除」。)破坏性/对外操作同理需明确授权。
- **永远没有「不值当」**:只要一件事长远正确、是改善(有助于正确性、性能、可维护性、可观测性等),就值得做。不要用「成本大」「范围大」「改 schema 迁移麻烦」把正确的改进降级为「可选/不阻塞/保留遗留」。(教训:zstd 升级后我把语义已是 zst 却仍叫 `gz_*` 的命名遗留判为「改名要动 schema 列迁移、不值当」而保留——错。)需要迁移就写健壮迁移(如 SQLite `ALTER TABLE RENAME COLUMN` + `PRAGMA table_info` 检测存在性);跨文件重命名就全量改干净。只有在「会破坏正确性/有真实风险且收益不清」时才暂缓,并说明**真实风险**而非用「不值当」搪塞。评审/收尾时发现的正确改进,默认**实施**而非记为「Minor/可选」。

## 工程纪律

- **逻辑与 UI 分离**:业务逻辑必须从 UI/框架胶水(Electron 主进程、IPC handler、React 组件)中抽离成不依赖框架的纯函数,使其能脱离 UI 被单独、确定性测试。handler/组件只做「取参数 → 调纯函数 → 回传」的薄胶水。(本项目实例:刷新落库逻辑最初内联在 `ipcMain.handle('refresh:run')` 里、依赖 Electron event/app,无法端到端验证;抽成 `applyScanToIndex(db, scan, existing)` 这类纯函数后,可用真实依赖(内存 SQLite)写集成测试而不拉起 Electron/UI;生产代码与测试调用同一批函数,避免走样。)
- **验证要看真实信号**:验证 GUI / 交互 / Electron 应用**不能只看主进程是否启动、不能只凭「app 起来了」**,必须拿到渲染层 / 通信通道的**程序化证据**。无法目视时,让被测对象把结果回传到可观测通道(如 `useEffect` 触发一次 RPC、主进程终端打印带时间戳的结构化响应,即同时证明「渲染 + 交互 + 通信」)。关键 / CRITICAL 项由 controller(调度方)亲自重跑复核,不只信执行者回报。两个场景的**具体探针手法**见各自落地:Electron(看渲染层 console / `executeJavaScript('Object.keys(window.api)')`)记在记忆 `electron-preload-cjs-under-type-module`;Electrobun(RPC 回传 / GTK 日志 / 子进程树)记在 [docs/electrobun-dev-guide.md](docs/electrobun-dev-guide.md) §4。

## 本项目留档约定

- 设计/实现走三段式留档:`docs/superpowers/specs/`(设计规格,真相源)、`docs/superpowers/plans/`(实现计划)、`docs/superpowers/spike-results/`(探针/裁定结果)。重要改动经多方对抗审查 + 收敛裁决迭代(通用审查流程依用户全局规则,不在此重述)。完整文档目录见 README「## 文档」。
- **活文档 vs 冻结文档**:`docs/ARCHITECTURE.md`(当前架构)与 `docs/ROADMAP.md`(进度/路线图)是**活文档**,描述「现在是什么」——**改了架构或推进了阶段,必须同步更新它们**(否则会烂成过期的错误参考)。`docs/superpowers/{specs,plans,spike-results}` 是**冻结文档**,定格于撰写时记录「当时打算怎么做/裁定了什么」,不回头改;活文档描述现状并**链接**冻结 spec 讲缘由,不复制其内容。
- 调试踩坑与可迁移技术结论:跨项目通用的记在 `docs/memory/`(该目录是项目记忆的符号链接,受版本控制),索引见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md);本项目专属的实现细节写进 README / docs,不进记忆。
