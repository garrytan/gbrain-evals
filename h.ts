import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { runExtract } from 'gbrain/extract';
import { loadWorldV1, generateVariants } from './eval/runner/cat6-prose-scale.ts';
const pages = loadWorldV1();
const variants = generateVariants(pages, { kinds: ['prose_only_mention'], perKind: 50, baseSeed: 1000 });
const e: any = new PGLiteEngine(); await e.connect({}); await e.initSchema();
const t0 = Date.now();
const log = console.log; console.log = () => {};
for (const p of pages.filter(p => p.type === 'person' || p.type === 'company')) {
  await importFromContent(e, p.slug, `---\ntype: ${p.type}\ntitle: ${JSON.stringify(p.title)}\n---\n\n${p.content}\n`, { noEmbed: true });
}
const slugs: string[] = [];
for (const [i, v] of variants.entries()) { const s = `notes/cat6-prose-only-${String(i).padStart(3,'0')}`; slugs.push(s); await importFromContent(e, s, `---\ntype: note\ntitle: "Variant ${i}"\n---\n\n${v.content}\n`, { noEmbed: true }); }
const t1 = Date.now();
await runExtract(e, ['links', '--by-mention', '--source', 'db']);
console.log = log;
const rows = await e.executeRaw(`SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.link_source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug LIKE 'notes/cat6-prose-only-%'`, []);
let hit=0, typed=0;
variants.forEach((v, i) => { const want = v.goldDelta.must_extract[0]; const got = rows.filter((r: any) => r.from_slug === slugs[i] && r.to_slug === want.slug); if (got.length) hit++; if (got.some((r:any)=>r.link_type==='mentions')) typed++; });
console.log({ import_s: (t1-t0)/1000, extract_s: (Date.now()-t1)/1000, rows: rows.length, hit, typed, n: variants.length, sources: [...new Set(rows.map((r:any)=>r.link_source))] });
console.log(variants.slice(0,3).map(v=>v.goldDelta.must_extract[0]), rows.slice(0,3));
