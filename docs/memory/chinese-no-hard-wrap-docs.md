---
name: chinese-no-hard-wrap-docs
description: 用户要求所有文档/记忆/注释用中文书写，且不做因行宽产生的硬换行
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7f530cdf-dc1b-4af8-b161-31f258651177
---

写给本用户的所有文档、记忆、代码注释,一律用**中文**,并且**不要做因行宽产生的硬换行**——段落写成单行,靠编辑器软换行,不要在固定列宽处插入换行符。

**Why:** 用户在 cc-move-session 项目里明确指出此为"未来编写所有文档、记忆、注释的原则"。硬换行会让 Markdown 段落在编辑器里出现难看的断行,也不利于 diff。

**How to apply:** Markdown 段落、记忆正文、注释都写成连续单行;仅在真正的语义边界(段落之间、列表项、标题)换行。表格与代码块照常。语言默认中文,除非用户另行要求。
