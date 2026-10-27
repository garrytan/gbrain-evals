/**
 * F2 scoped policy on every recorded agent search call, each on its real budget path (see DECISION-RULE.md). Imports the frozen calls' hit pages (rendered exactly as the Cat 40 gbrain arm renders
 * them) into an in-memory PGLite brain with gbrain's own importer, maps each recorded hit to its chunk by text,
 * and asks gbrain's own assembleEvidenceForHits for each delivery unit at one fixed budget. No provider calls.
 * Usage: GBRAIN_DIR=/workspace/gbrain bun replay.ts <M|dev> <world.json> <out.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const G = process.env.GBRAIN_DIR ?? join(import.meta.dir, '..', 'scoped', 'gb-scoped');
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

const frozen = JSON.parse(readFileSync(join(import.meta.dir, 'calls_all.json'), 'utf8'))[setName];
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
const lines: string[] = [];
let mapped = 0, unmapped = 0;
const mapHits = (call: any) => {
  const hits: Array<{ source_id: string; slug: string; chunk_id: number }> = [];
  for (const h of call.hits) {
    const q = squash((h.chunk_text ?? '').replace(/…\s*\[truncated \d+ chars[^\]]*\]\s*$/, '').replace(/…$|\.\.\.$/, ''));
    const id = byText.get(`${h.slug}\u0000${h.chunk_text}`) ?? byText.get(`${h.slug}\u0001${squash(h.chunk_text)}`)
      ?? (q.length >= 16 ? ((bySlug.get(h.slug) ?? []).find(c => c.sq.startsWith(q)) ?? (bySlug.get(h.slug) ?? []).find(c => c.sq.includes(q) || q.includes(c.sq)))?.id : undefined);
    if (id === undefined) { unmapped++; continue; }
    mapped++; hits.push({ source_id: sourceId, slug: h.slug, chunk_id: id });
  }
  return hits.slice(0, 50);
};
for (const call of frozen.calls) {
  const hs = mapHits(call);
  if (hs.length === 0) { lines.push(JSON.stringify({ cell: call.cell, family: call.family, model: call.model, call: call.call, path: call.path, recorded_chars: call.recorded_chars, empty: true })); continue; }
  const hasLong = hs.some(h => LONG.has(h.slug));
  const run = async (variant: string, f2?: string) => {
    g.__f2Long = f2 ? (slug: string) => LONG.has(slug) : undefined; g.__f2Unit = f2; g.__f2CapTokens = undefined;
    const input: any = { hits: hs, caller: { remote: true, excludePrivate: false } };
    if (variant === 'chunk') input.return_unit = 'chunk';
    else if (call.path === 'explicit') { input.return_unit = call.return_unit; if (call.token_budget) input.budget_tokens = call.token_budget; }
    else if (call.path === 'legacy') input.return_unit = 'chunk';
    else if (call.path === 'cap') { input.return_unit = 'auto'; input.budget_tokens = call.token_budget; }
    else input.return_unit = 'auto';
    const out = await assembleEvidenceForHits(engine, input);
    return out.results as Array<{ slug: string; chunk_text: string }>;
  };
  const rec: any = { cell: call.cell, family: call.family, model: call.model, call: call.call, path: call.path, recorded_chars: call.recorded_chars,
                     has_long: hasLong, partial: call.partial, chars: {}, covered: {} };
  const variants: Array<[string, string | undefined]> = [['today', undefined], ['window', 'window'], ['section', 'section'], ['page', 'page']];
  if (Object.keys(call.deciding).length) variants.push(['chunk', undefined]);
  let todayChars = 0;
  for (const [name, f2] of variants) {
    if (name !== 'today' && name !== 'chunk' && (!hasLong || call.path === 'explicit' || call.path === 'legacy')) { rec.chars[name] = todayChars; if (Object.keys(call.deciding).length) rec.covered[name] = rec.covered.today; continue; }
    const res = await run(name, f2);
    const chars = res.reduce((n, r) => n + (r.chunk_text?.length ?? 0), 0);
    if (name === 'today') todayChars = chars;
    rec.chars[name] = chars;
    if (Object.keys(call.deciding).length) {
      rec.covered[name] = {};
      for (const [slug, dec] of Object.entries(call.deciding as Record<string, { sentences: string[]; len: number }>)) {
        const text = squash(res.filter(r => r.slug === slug).map(r => r.chunk_text).join(' '));
        rec.covered[name][slug] = { long: dec.len >= 20000, covered: dec.sentences.some(s => text.includes(squash(s))) };
      }
    }
  }
  lines.push(JSON.stringify(rec));
}
writeFileSync(outPath, lines.join('\n') + '\n');
console.error(`${setName}: long pages ${LONG.size}; hits mapped ${mapped}, unmapped ${unmapped}; ${lines.length} calls`);
