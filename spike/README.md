# Phase 0 Spike

Electrobun 双运行时可行性验证探针。

- `probe-*.ts` — 纯 Bun 探针,在**项目根**运行:`bun run spike/probe-<name>.ts`
- `electrobun-app/` — 最小 Electrobun 应用探针(起窗/React/RPC/Bun.build)
- 结果汇总见 `docs/superpowers/spike-results/2026-06-17-phase0.md`

每个探针自打印 `PASS`/`FAIL` 并以退出码 0/1 表示成败。
