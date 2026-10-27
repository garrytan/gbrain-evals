/**
 * F2 scoped-policy frozen replay (patched scratch copy, see patch.diff). Imports the frozen calls' hit pages (rendered exactly as the Cat 40 gbrain arm renders
 * them) into an in-memory PGLite brain with gbrain's own importer, maps each recorded hit to its chunk by text,
 * and asks gbrain's own assembleEvidenceForHits for each delivery unit at one fixed budget. No provider calls.
 * Usage: GBRAIN_DIR=/workspace/gbrain bun replay.ts <M|dev> <world.json> <out.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const G = process.env.GBRAIN_DIR ?? join(import.meta.dir, 'gb-scoped');
const [setName, worldPath, outPath] = process.argv.slice(2);
const { createBenchmarkBrain } = await import(join(G, 'src/eval/longmemeval/harness.ts'));
const { importFromContent } = await import(join(G, 'src/core/import-file.ts'));
const { assembleEvidenceForHits, conversationSignal } = await import(join(G, 'src/core/search/evidence-delivery.ts'));

type Doc = { id: string; title: string; type: string; date: string; author: string; body: string; restricted?: boolean; derived_from?: string[] };
// Same bytes as gbrain-evals eval/generators/model-ladder-gen.ts renderDoc (unchanged since the M evals commit).
function renderDoc(d: Doc): string {
  const fm = [`title: ${JSON.stringify(d.title)}`, `type: ${d.type}`, `date: ${d.date}`, `author: ${JSON.stringify(d.author)}`];
  if (d.restricted) fm.push('access: finance', 'visibility: private');
  if (d.derived_from) fm.push(`derived_from: [${d.derived_from.map(x => JSON.stringify(x)).join(', ')}]`);
  return `---\n${fm.join('\n')}\n---\n${d.body}\n`;
}

const frozen = JSON.parse(readFileSync(join(import.meta.dir, '..', 'frozen.json'), 'utf8'))[setName];
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


const LONG = new Set<string>();
for (const slug of frozen.pages as string[]) {
  const d = docs.get(slug);
  if (d && renderDoc(d).length - renderDoc({ ...d, body: '' }).length >= 20000 && conversationSignal({ type: d.type, slug }) === null) LONG.add(slug);
}
const g = globalThis as any;
const VARIANTS: Array<{ name: string; unit: string; f2?: string; cap?: boolean }> = [
  { name: 'chunk', unit: 'chunk' }, { name: 'today', unit: 'auto' },
  ...['window', 'section', 'page'].flatMap(u => [{ name: `scoped-${u}`, unit: 'auto', f2: u }, { name: `scoped-${u}+cap`, unit: 'auto', f2: u, cap: true }]),
];
const lines: string[] = [];
let mapped = 0, unmapped = 0;
for (const B of [6000, 24000]) {
  await engine.setConfig('search.return_budget_conversation', String(B));
  for (const call of frozen.calls) {
    const hits: Array<{ source_id: string; slug: string; chunk_id: number }> = [];
    for (const h of call.hits) {
      const q = squash((h.chunk_text ?? '').replace(/…\s*\[truncated \d+ chars[^\]]*\]\s*$/, '').replace(/…$|\.\.\.$/, ''));
      const id = byText.get(`${h.slug}\u0000${h.chunk_text}`) ?? byText.get(`${h.slug}\u0001${squash(h.chunk_text)}`)
        ?? (q.length >= 16 ? ((bySlug.get(h.slug) ?? []).find(c => c.sq.startsWith(q)) ?? (bySlug.get(h.slug) ?? []).find(c => c.sq.includes(q) || q.includes(c.sq)))?.id : undefined);
      if (id === undefined) { unmapped++; continue; }
      mapped++;
      hits.push({ source_id: sourceId, slug: h.slug, chunk_id: id });
    }
    const hs = hits.slice(0, 50);
    for (const v of VARIANTS) {
      if (v.unit === 'chunk' && B !== 6000) continue;
      g.__f2Long = v.f2 ? (slug: string) => LONG.has(slug) : undefined;
      g.__f2Unit = v.f2; g.__f2CapTokens = v.cap ? Math.floor(B * 0.5) : undefined;
      const t = performance.now();
      const out = await assembleEvidenceForHits(engine, { hits: hs, return_unit: v.unit, caller: { remote: true, excludePrivate: false } });
      const ms = performance.now() - t;
      const results = out.results as Array<{ slug: string; chunk_text: string; delivered?: { unit: string; reason?: string; tokens?: number } }>;
      const total = results.reduce((n, r) => n + (r.chunk_text?.length ?? 0), 0);
      for (const [slug, dec] of Object.entries(call.deciding as Record<string, { sentences: string[]; len: number; item: number }>)) {
        const block = results.filter(r => r.slug === slug);
        const text = squash(block.map(r => r.chunk_text).join(' '));
        const firstHit = hs.findIndex(h => h.slug === slug);
        const earlier = v.f2 ? [...new Set(hs.slice(0, Math.max(0, firstHit)).map(h => h.slug))].filter(s => LONG.has(s) && s !== slug) : [];
        const earlierWidened = earlier.filter(s => results.some(r => r.slug === s && r.delivered && r.delivered.unit !== 'chunk'));
        lines.push(JSON.stringify({
          set: setName, B, variant: v.name, cell: call.cell, model: call.model, task: call.task, call: call.call, slug, item: dec.item, doc_len: dec.len,
          long_page: LONG.has(slug), partial_hit_list: call.partial_hit_list, in_hits: firstHit >= 0,
          delivered: [...new Set(block.map(r => `${r.delivered?.unit ?? 'none'}${r.delivered?.reason ? ':' + r.delivered.reason : ''}`))],
          covered: dec.sentences.some(s => text.includes(squash(s))), block_chars: block.reduce((n, r) => n + (r.chunk_text?.length ?? 0), 0),
          call_chars: total, earlier_long: earlier.length, earlier_widened: earlierWidened.length, ms: Math.round(ms),
        }));
      }
    }
  }
}
writeFileSync(outPath, lines.join('\n') + '\n');
console.error(`${setName}: long non-conversation pages ${LONG.size}; hits mapped ${mapped}, unmapped ${unmapped}; ${lines.length} rows`);
