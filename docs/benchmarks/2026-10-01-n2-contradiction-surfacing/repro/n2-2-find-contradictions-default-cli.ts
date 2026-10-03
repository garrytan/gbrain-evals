// N2-2 repro: `gbrain find-contradictions` with no --source gets the empty availability note,
// because the CLI context always carries sourceId 'default' (src/cli.ts:1515), while
// skills/correction-pipeline/SKILL.md:214 documents the bare command as reading the latest run.
// Run from the repo root (keyless): bun docs/benchmarks/2026-10-01-n2-contradiction-surfacing/repro/n2-2-find-contradictions-default-cli.ts
const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { find_contradictions } = await import(`${G}/ops/insights.ts`);
const run = { run_id: "r1", ran_at: "2026-10-01", report_json: { per_query: [{ contradictions: [{ kind: "cross_slug_chunks", severity: "medium", axis: "headcount", confidence: 0.9, a: { slug: "notes/a", chunk_id: 1, take_id: null }, b: { slug: "notes/b", chunk_id: 2, take_id: null }, resolution_kind: "manual_review", resolution_command: "# manual review" }] }] } };
const engine = { loadContradictionsTrend: async () => [run] };
for (const [label, ctx] of [["CLI default (sourceId default)", { remote: false, sourceId: "default" }], ["CLI --source __all__", { remote: false, sourceId: "__all__" }]] as const) {
  const r = await find_contradictions.handler({ engine, ...ctx } as never, {});
  console.log(label, "->", JSON.stringify(r));
}
