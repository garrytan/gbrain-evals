// N2-1 repro: an undated page reaches the contradiction judge with its recorded-time
// fallback date instead of "(date unknown)", and the date pre-filter never skips.
// Run keyless from the repo root:
//   env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u VOYAGE_API_KEY -u JEV_TYPESAFE_API_KEY GBRAIN_HOME=$(mktemp -d) \
//     bun docs/benchmarks/2026-10-01-n2-contradiction-surfacing/repro/n2-1-undated-page-gets-a-date.ts
const G = new URL("../../../../node_modules/gbrain/src/core", import.meta.url).pathname;
const { PGLiteEngine } = await import(`${G}/pglite-engine.ts`);
const { operations } = await import(`${G}/operations.ts`);
const { runContradictionProbe } = await import(`${G}/eval-contradictions/runner.ts`);
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const ctx = { engine, config: { engine: "pglite", database_path: ":memory:" }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: "default" };
const put = (slug: string, content: string) => operations.find((o: { name: string }) => o.name === "put_page")!.handler(ctx, { slug, content });
await put("notes/a", "---\ntype: note\ntitle: A\n---\nAs of March 1, 2025: Acme Example headcount is 45 people.\n");
await put("notes/b", "---\ntype: note\ntitle: B\n---\nAs of September 1, 2025: Acme Example headcount is now 90 people.\n");
const seen: unknown[] = [];
const out = await runContradictionProbe({ engine, queries: ["What is the headcount of Acme Example?"], noCache: true, yesOverride: true,
  judgeFn: async (i: { a: { slug: string; effective_date: string | null }; b: { slug: string; effective_date: string | null } }) => {
    seen.push([i.a.slug, i.a.effective_date, i.b.slug, i.b.effective_date]);
    return { verdict: { verdict: "no_contradiction", severity: "info", axis: "", confidence: 1, resolution_kind: null }, usage: { inputTokens: 0, outputTokens: 0 } };
  } });
console.log("dates the judge received (expected null for both undated pages):", JSON.stringify(seen));
console.log("pairs skipped by the date filter (expected 1: both texts carry dates 184 days apart):", out.report.per_query[0].pairs_skipped_by_date);
await engine.disconnect();
