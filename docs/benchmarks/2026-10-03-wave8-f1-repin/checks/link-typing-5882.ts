// Fix wave 8 #5882: markdown link typing no longer uses the bundled packs' bare-word verb regexes.
// Builds the world-v1 index the way N9 and relational-ab do (import, then extract links and timeline),
// and scores every person-to-company works_at / invested_in / advises / founded edge against the world's
// _facts gold. Report-only: prints the counts for the gbrain under test (GBRAIN_ROOT) and exits 0 unless the run fails.
import { join } from 'node:path';
import { GbrainInlineAdapter } from '../../../../eval/runner/adapters/gbrain-inline.ts';
import { loadWorldCorpus } from '../../../../eval/runner/queries/relational.ts';
import { sanitizePage } from '../../../../eval/runner/types.ts';
import { GBRAIN_ROOT, GBRAIN_VERSION, keylessHome } from './lib.ts';

const h = keylessHome();
for (const k of Object.keys(process.env)) if (!(k in h.env)) delete process.env[k];
Object.assign(process.env, h.env);
const pages = loadWorldCorpus(join(import.meta.dir, '../../../../eval/data/world-v1'));
const gold: Record<string, Set<string>> = { works_at: new Set(), invested_in: new Set(), advises: new Set(), founded: new Set() };
for (const p of pages) {
  const f = p._facts;
  if (f?.type !== 'company') continue;
  for (const x of f.employees ?? []) gold.works_at!.add(`${x}>${p.slug}`);
  for (const x of f.founders ?? []) { gold.works_at!.add(`${x}>${p.slug}`); gold.founded!.add(`${x}>${p.slug}`); }
  for (const x of f.investors ?? []) gold.invested_in!.add(`${x}>${p.slug}`);
  for (const x of f.advisors ?? []) gold.advises!.add(`${x}>${p.slug}`);
}
const adapter = new GbrainInlineAdapter({ topK: 5, extract: true, embed: false, productRoot: GBRAIN_ROOT });
const state = await adapter.init(pages.map(sanitizePage), { name: 'w8f1-link-typing' });
const engine = adapter.engineOf(state);
const rows = await engine.executeRaw<{ src: string; dst: string; link_type: string; link_source: string | null }>(
  `SELECT a.slug AS src, b.slug AS dst, l.link_type, l.link_source FROM links l JOIN pages a ON a.id = l.from_page_id JOIN pages b ON b.id = l.to_page_id`);
await adapter.teardown(state);
h.cleanup();
const byType: Record<string, { edges: number; correct: number; wrong_type_but_related: number; unrelated: number; gold: number; gold_found: number }> = {};
const related = new Set([...Object.values(gold)].flatMap(s => [...s]));
for (const t of Object.keys(gold)) {
  const edges = rows.filter(r => r.link_type === t && r.src.startsWith('people/') && r.dst.startsWith('companies/'));
  const keys = new Set(edges.map(e => `${e.src}>${e.dst}`));
  byType[t] = {
    edges: keys.size,
    correct: [...keys].filter(k => gold[t]!.has(k)).length,
    wrong_type_but_related: [...keys].filter(k => !gold[t]!.has(k) && related.has(k)).length,
    unrelated: [...keys].filter(k => !related.has(k)).length,
    gold: gold[t]!.size,
    gold_found: [...gold[t]!].filter(k => keys.has(k)).length,
  };
}
const typeCounts: Record<string, number> = {};
for (const r of rows) typeCounts[r.link_type] = (typeCounts[r.link_type] ?? 0) + 1;
console.log(JSON.stringify({ check: 'link-typing-5882', gbrain_version: GBRAIN_VERSION, pages: pages.length, links: rows.length, by_type: byType, link_type_counts: typeCounts }, null, 2));
process.exit(0);
