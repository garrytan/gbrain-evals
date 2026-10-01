const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { runContradictionProbe } = await import(`${G}/eval-contradictions/runner.ts`);
const { shouldSkipForDateMismatch } = await import(`${G}/eval-contradictions/date-filter.ts`);
const { find_contradictions } = await import(`${G}/ops/insights.ts`);
const results = [
  { slug: "people/alice", page_id: 1, chunk_id: 11, chunk_text: "Alice is CFO of Acme.", score: 0.9, source_id: "default" },
  { slug: "companies/acme", page_id: 2, chunk_id: 21, chunk_text: "Acme's CFO is Bob.", score: 0.8, source_id: "default" },
  { slug: "notes/2024", page_id: 3, chunk_id: 31, chunk_text: "On 2024-01-05 Acme MRR was $50K.", score: 0.7, source_id: "default" },
  { slug: "notes/2026", page_id: 4, chunk_id: 41, chunk_text: "On 2026-03-01 Acme MRR was $2M.", score: 0.6, source_id: "default" },
];
const engine = { listActiveTakesForPages: async () => new Map(), executeRaw: async () => [] };
const offered: string[] = [];
const judgeFn = async (inp: any) => {
  offered.push(`${inp.a.slug}|${inp.b.slug}`);
  if (inp.a.slug === "companies/acme" && inp.b.slug === "notes/2024") throw new Error("simulated judge failure");
  const contra = inp.a.slug === "people/alice" && inp.b.slug === "companies/acme";
  return { verdict: { verdict: contra ? "contradiction" : "no_contradiction", severity: "high", axis: contra ? "CFO identity" : "", confidence: 0.9, resolution_kind: null }, usage: { inputTokens: 0, outputTokens: 0 } };
};
const out = await runContradictionProbe({ engine, queries: ["who is acme cfo"], judgeFn, searchFn: async () => results, noCache: true, topK: 4, yesOverride: true });
const pq = out.report.per_query[0];
console.log("pairs offered to judge:", offered.length, JSON.stringify(offered));
console.log("per_query:", JSON.stringify({ result_count: pq.result_count, pairs_skipped_by_date: pq.pairs_skipped_by_date, pairs_judged: pq.pairs_judged, findings: pq.contradictions.map((c: any) => [c.a.slug, c.b.slug, c.verdict, c.resolution_kind]) }));
console.log("judge error rows:", JSON.stringify(out.judgeErrorRows));
console.log("date filter (2024 vs 2026, no page dates):", JSON.stringify(shouldSkipForDateMismatch({ textA: results[2].chunk_text, textB: results[3].chunk_text })));
console.log("date filter (same texts, both page dates set):", JSON.stringify(shouldSkipForDateMismatch({ textA: results[2].chunk_text, textB: results[3].chunk_text, effectiveDateA: "2024-01-05", effectiveDateB: "2026-03-01" })));
const stubEngine = { loadContradictionsTrend: async () => [{ run_id: "r1", ran_at: "2026-10-01", report_json: { per_query: [] } }] };
for (const [label, ctx] of [["remote=true (stdio/HTTP)", { remote: true, sourceId: "default", engine: stubEngine }], ["remote=false, sourceId=default (CLI default)", { remote: false, sourceId: "default", engine: stubEngine }], ["remote=false, sourceId=__all__", { remote: false, sourceId: "__all__", engine: stubEngine }]] as const) {
  console.log("find_contradictions", label, "->", JSON.stringify(await find_contradictions.handler(ctx as any, {})));
}
