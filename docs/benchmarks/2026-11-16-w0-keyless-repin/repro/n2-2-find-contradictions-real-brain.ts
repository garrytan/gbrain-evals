// N2-2 at a build whose source-scoped find_contradictions re-reads each stored finding live (gbrain #6784, v0.60.250.0,
// src/core/eval-contradictions/scoped-read.ts): the published repro's stand-in engine has no database, so this copy stores
// one finding about two real chunks in an in-memory PGLite brain and asks as the CLI does, with no --source (sourceId
// default) and with __all__.
// Keyless. Run from the repo root: bun docs/benchmarks/2026-11-16-w0-keyless-repin/repro/n2-2-find-contradictions-real-brain.ts
// GBRAIN_REPO=<checkout> measures another gbrain; the default is node_modules/gbrain.
import { join, resolve } from 'node:path';
const root = resolve(process.env.GBRAIN_REPO ?? new URL('../../../../node_modules/gbrain', import.meta.url).pathname);
const { PGLiteEngine } = await import(join(root, 'src/core/pglite-engine.ts'));
const { importFromContent } = await import(join(root, 'src/core/import-file.ts'));
const { find_contradictions } = await import(join(root, 'src/core/ops/insights.ts'));
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${body}\n`;
await importFromContent(engine, 'notes/a', page('A', 'Acme has 40 employees.'), { noEmbed: true });
await importFromContent(engine, 'notes/b', page('B', 'Acme has 400 employees.'), { noEmbed: true });
const chunks = await engine.executeRaw(`SELECT cc.id, cc.chunk_text, p.slug FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug, cc.id`);
const side = (slug: string) => { const c = chunks.find((r: { slug: string }) => r.slug === slug); return { slug, chunk_id: Number(c.id), take_id: null, text: c.chunk_text }; };
const finding = { kind: 'cross_slug_chunks', severity: 'medium', axis: 'headcount', confidence: 0.9, a: side('notes/a'), b: side('notes/b'), resolution_kind: 'manual_review', resolution_command: '# manual review' };
await engine.writeContradictionsRun({
  run_id: '2026-11-16T00:00:00.000Z', judge_model: 'none', prompt_version: 'repro', queries_evaluated: 1, queries_with_contradiction: 1,
  total_contradictions_flagged: 1, wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0, cost_usd_total: 0, duration_ms: 0,
  source_tier_breakdown: {}, report_json: { per_query: [{ contradictions: [finding] }] },
});
for (const [label, ctx] of [['CLI default (sourceId default)', { remote: false, sourceId: 'default' }], ['CLI --source __all__', { remote: false, sourceId: '__all__' }]] as const) {
  const r = await find_contradictions.handler({ engine, ...ctx } as never, {});
  const found = (r.contradictions ?? []).map((c: { a: { slug: string }; b: { slug: string } }) => `${c.a.slug}~${c.b.slug}`);
  console.log(label, '->', JSON.stringify({ findings: found, note: r.note ?? null, total_visible: r.total_visible ?? null, total_in_run: r.total_in_run ?? null }));
}
await engine.disconnect();
