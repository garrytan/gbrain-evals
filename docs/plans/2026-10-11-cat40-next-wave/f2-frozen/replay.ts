/**
 * F2 free frozen-hit replay. Imports the frozen calls' hit pages (rendered exactly as the Cat 40 gbrain arm renders
 * them) into an in-memory PGLite brain with gbrain's own importer, maps each recorded hit to its chunk by text,
 * and asks gbrain's own assembleEvidenceForHits for each delivery unit at one fixed budget. No provider calls.
 * Usage: GBRAIN_DIR=/workspace/gbrain bun replay.ts <M|dev> <world.json> <out.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const G = process.env.GBRAIN_DIR ?? '/workspace/gbrain';
const [setName, worldPath, outPath] = process.argv.slice(2);
const { createBenchmarkBrain } = await import(join(G, 'src/eval/longmemeval/harness.ts'));
const { importFromContent } = await import(join(G, 'src/core/import-file.ts'));
const { assembleEvidenceForHits } = await import(join(G, 'src/core/search/evidence-delivery.ts'));

type Doc = { id: string; title: string; type: string; date: string; author: string; body: string; restricted?: boolean; derived_from?: string[] };
// Same bytes as gbrain-evals eval/generators/model-ladder-gen.ts renderDoc (unchanged since the M evals commit).
function renderDoc(d: Doc): string {
  const fm = [`title: ${JSON.stringify(d.title)}`, `type: ${d.type}`, `date: ${d.date}`, `author: ${JSON.stringify(d.author)}`];
  if (d.restricted) fm.push('access: finance', 'visibility: private');
  if (d.derived_from) fm.push(`derived_from: [${d.derived_from.map(x => JSON.stringify(x)).join(', ')}]`);
  return `---\n${fm.join('\n')}\n---\n${d.body}\n`;
}

const frozen = JSON.parse(readFileSync(join(import.meta.dir, 'frozen.json'), 'utf8'))[setName];
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const docs = new Map<string, Doc>(world.docs.map((d: Doc) => [d.id, d]));
const engine = await createBenchmarkBrain();
const t0 = Date.now();
let imported = 0;
for (const slug of frozen.pages as string[]) {
  const d = docs.get(slug);
  if (!d) continue;
  await importFromContent(engine, slug, renderDoc(d), { noEmbed: true });
  imported++;
}
const src = (await engine.executeRaw(`SELECT DISTINCT source_id FROM pages LIMIT 2`)) as Array<{ source_id: string }>;
const sourceId = src[0]?.source_id ?? 'default';
const chunkRows = (await engine.executeRaw(`SELECT c.id, c.chunk_index, c.chunk_text, p.slug FROM content_chunks c JOIN pages p ON p.id = c.page_id`)) as Array<{ id: number; chunk_index: number; chunk_text: string; slug: string }>;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const byText = new Map<string, number>();
for (const r of chunkRows) { byText.set(`${r.slug}\u0000${r.chunk_text}`, Number(r.id)); byText.set(`${r.slug}\u0001${squash(r.chunk_text)}`, Number(r.id)); }
const bySlug = new Map<string, Array<{ id: number; sq: string }>>();
for (const r of chunkRows) { const a = bySlug.get(r.slug) ?? []; a.push({ id: Number(r.id), sq: squash(r.chunk_text) }); bySlug.set(r.slug, a); }
let fuzzy = 0, ambiguous = 0;
console.error(`${setName}: imported ${imported} pages in ${Date.now() - t0} ms; ${chunkRows.length} chunks; source ${sourceId}`);

const UNITS = ['chunk', 'window', 'section', 'page'] as const;
const BUDGET = 6000;
const lines: string[] = [];
let mapped = 0, unmapped = 0;
for (const call of frozen.calls) {
  const hits: Array<{ source_id: string; slug: string; chunk_id: number }> = [];
  for (const h of call.hits) {
    const q = squash((h.chunk_text ?? '').replace(/…\s*\[truncated \d+ chars[^\]]*\]\s*$/, '').replace(/…$|\.\.\.$/, ''));
    const id = byText.get(`${h.slug}\u0000${h.chunk_text}`) ?? byText.get(`${h.slug}\u0001${squash(h.chunk_text)}`)
      ?? (() => {
        if (q.length < 16) return undefined;
        const cs = bySlug.get(h.slug) ?? [];
        const starts = cs.filter(c => c.sq.startsWith(q));
        if (starts.length > 1) ambiguous++;
        return (starts[0] ?? cs.find(c => c.sq.includes(q) || q.includes(c.sq)))?.id;
      })();
    if (id !== undefined && byText.get(`${h.slug}\u0000${h.chunk_text}`) === undefined && byText.get(`${h.slug}\u0001${squash(h.chunk_text)}`) === undefined) fuzzy++;
    if (id === undefined) { unmapped++; continue; }
    mapped++;
    hits.push({ source_id: sourceId, slug: h.slug, chunk_id: id });
  }
  for (const cond of ['shared', 'isolated'] as const) {
    const groups = cond === 'shared' ? [hits.slice(0, 50)] : Object.keys(call.deciding).map(s => hits.filter(h => h.slug === s));
    for (const hs of groups) {
      if (hs.length === 0) continue;
      for (const unit of UNITS) {
        const t = performance.now();
        const out = await assembleEvidenceForHits(engine, { hits: hs, return_unit: unit, budget_tokens: BUDGET, caller: { remote: true, excludePrivate: false } });
        const ms = performance.now() - t;
        const results = out.results as Array<{ slug: string; chunk_text: string; delivered?: { unit: string; truncated?: boolean } }>;
        const total = results.reduce((n, r) => n + (r.chunk_text?.length ?? 0), 0);
        for (const [slug, dec] of Object.entries(call.deciding as Record<string, { sentences: string[]; len: number; item: number }>)) {
          if (cond === 'isolated' && hs[0].slug !== slug) continue;
          const block = results.filter(r => r.slug === slug);
          const text = squash(block.map(r => r.chunk_text).join(' '));
          lines.push(JSON.stringify({
            set: setName, cond, unit, cell: call.cell, model: call.model, task: call.task, call: call.call, slug, item: dec.item, doc_len: dec.len,
            partial_hit_list: call.partial_hit_list, recorded_has_sentence: call.recorded_has_sentence[slug],
            in_hits: hs.some(h => h.slug === slug), delivered_units: [...new Set(block.map(r => r.delivered?.unit ?? 'none'))],
            covered: dec.sentences.some(s => text.includes(squash(s))), block_chars: block.reduce((n, r) => n + (r.chunk_text?.length ?? 0), 0),
            call_chars: total, rows: results.length, ms: Math.round(ms), unresolved: out.unresolved.length,
          }));
        }
      }
    }
  }
}
writeFileSync(outPath, lines.join('\n') + '\n');
console.error(`${setName}: hits mapped ${mapped} (${fuzzy} by containment, ${ambiguous} ambiguous prefix), unmapped ${unmapped}; ${lines.length} rows`);
await engine.disconnect?.();
