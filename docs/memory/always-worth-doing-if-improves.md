---
name: always-worth-doing-if-improves
description: "永远没有\"不值当\"——只要长远正确/是改善就值得做,别用成本或范围搪塞"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4af48063-5837-456a-908b-8225e6072d29
---

用户工作原则:**永远没有「不值当」**。只要一件事长远正确、是好的、是改善(有助于正确性、高性能、可维护性、可观测性等),就值得做。不要用「成本大」「范围大」「改 schema 迁移麻烦」为由把正确的改进降级为「可选/不阻塞/保留遗留」。

**Why:** 用户明确纠正了我——我在 zstd 升级后把 `gz_*` 命名遗留(语义已是 zst 却仍叫 gz)标为「改名要动 schema 列迁移、不值当」而保留。短期省事的妥协会累积成长期债务;长远正确的改进哪怕要动迁移、跨多文件,也该做。

**How to apply:** 评审/收尾时发现的正确改进(命名一致、schema 准确、消除遗留、补强测试、补可观测性等),默认**实施**而非记为 Minor/可选。需要 schema 迁移就写健壮迁移(如 SQLite `ALTER TABLE RENAME COLUMN` + `PRAGMA table_info` 检测);跨文件重命名就全量改干净。只有在「会破坏正确性/有真实风险且收益不清」时才暂缓,并说明真实风险,而不是用「不值当」搪塞。
