/**
 * Loads one tier's fictional graph into a Postgres database with gbrain's own
 * schema (initSchema from the gbrain worktree in GB_ENGINE_DIR), then ANALYZE.
 * Pages get explicit ids 1..N so HydraDB vertex ids equal page ids.
 *
 * Usage: bun eval/runner/graph-backend/pg-load.ts <tier> <database_url | pglite:<dir>>
 * Prints one JSON line with load timings.
 */
import { generate, LINK_TYPES, SOURCES, slugOf, type Tier } from './generate.ts';

const [tier, url] = process.argv.slice(2) as [Tier, string];
const engineDir = process.env.GB_ENGINE_DIR;
if (!engineDir || !url) throw new Error('usage: GB_ENGINE_DIR=<gbrain worktree> bun pg-load.ts <tier> <database_url>');
const g = generate(tier);
let engine: any;
if (url.startsWith('pglite:')) {
  const { PGLiteEngine } = await import(`${engineDir}/src/core/pglite-engine.ts`);
  engine = new PGLiteEngine();
  await engine.connect({ database_path: url.slice('pglite:'.length) });
} else {
  const { PostgresEngine } = await import(`${engineDir}/src/core/postgres-engine.ts`);
  engine = new PostgresEngine();
  await engine.connect({ database_url: url });
}
const t0 = performance.now();
await engine.initSchema();
const tSchema = performance.now();
await engine.executeRaw('TRUNCATE pages, links RESTART IDENTITY CASCADE');
for (const s of SOURCES) await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [s]);
const CHUNK = 50_000;
for (let lo = 1; lo <= g.pages; lo += CHUNK) {
  const ids: number[] = [];
  const slugs: string[] = [];
  const srcs: string[] = [];
  for (let id = lo; id < Math.min(lo + CHUNK, g.pages + 1); id++) { ids.push(id); slugs.push(slugOf(id)); srcs.push(SOURCES[g.source[id]]); }
  await engine.executeRaw(`INSERT INTO pages (id, source_id, slug, type, title, compiled_truth, timeline, frontmatter)
    SELECT i, s, sl, 'note', sl, '', '', '{}'::jsonb FROM unnest($1::int[], $2::text[], $3::text[]) AS t(i, s, sl)`, [ids, srcs, slugs]);
}
await engine.executeRaw(`SELECT setval(pg_get_serial_sequence('pages', 'id'), $1::int)`, [g.pages]);
const tPages = performance.now();
const LCHUNK = 200_000;
for (let lo = 0; lo < g.from.length; lo += LCHUNK) {
  const hi = Math.min(lo + LCHUNK, g.from.length);
  const types = Array.from(g.type.subarray(lo, hi), t => LINK_TYPES[t]);
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
    SELECT f, t, lt, CASE WHEN lt = 'mentions' THEN 'mentions' ELSE 'markdown' END
    FROM unnest($1::int[], $2::int[], $3::text[]) AS e(f, t, lt)`, [Array.from(g.from.subarray(lo, hi)), Array.from(g.to.subarray(lo, hi)), types]); // gbrain-allow-direct-insert: benchmark fixture seeding a throwaway brain
}
const tLinks = performance.now();
await engine.executeRaw('VACUUM ANALYZE pages');
await engine.executeRaw('VACUUM ANALYZE links');
const tAnalyze = performance.now();
const [counts] = await engine.executeRaw(`SELECT (SELECT count(*) FROM pages)::int AS pages, (SELECT count(*) FROM links)::int AS links,
  pg_total_relation_size('pages')::bigint AS pages_bytes, pg_total_relation_size('links')::bigint AS links_bytes`);
await engine.disconnect();
console.log(JSON.stringify({
  tier, edgeSha256: g.edgeSha256, ...counts,
  pages_bytes: Number(counts.pages_bytes), links_bytes: Number(counts.links_bytes),
  ms: { schema: Math.round(tSchema - t0), pages: Math.round(tPages - tSchema), links: Math.round(tLinks - tPages), analyze: Math.round(tAnalyze - tLinks), total: Math.round(tAnalyze - t0) },
}));
