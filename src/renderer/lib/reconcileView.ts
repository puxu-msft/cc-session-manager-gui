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
