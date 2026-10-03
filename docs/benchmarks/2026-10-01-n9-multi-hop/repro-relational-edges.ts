/**
 * Minimal repros for N9-2, N9-3 and N9-4 (wave bug ledger): relationship
 * questions whose edges come from frontmatter or from a meeting page never
 * reach their answers through the relational arm.
 *
 * Keyless, in-memory PGLite, fictional pages only. Run from the repository root:
 *   env -u OPENAI_API_KEY GBRAIN_HOME=$(mktemp -d) bun docs/benchmarks/2026-10-01-n9-multi-hop/repro-relational-edges.ts [gbrain-root]
 * gbrain-root defaults to node_modules/gbrain (the pin, 3a284ae).
 *
 * N9-2: with the default schema pack, frontmatter fields that gbrain maps as
 *   incoming (company `investors:`, meeting `attendees:`) are stored with the
 *   page as the source (companies/x -> people/y), because pack mappings are
 *   built with direction 'outgoing' (src/core/link-extraction.ts
 *   extractFrontmatterLinks). The parser walks edges into the company or
 *   meeting, so "Who invested in X?" and "Who attended X?" find nothing.
 * N9-3: with the default schema pack, attendance links in a meeting page's
 *   body are stored meeting -> person: the pack's page-type-bound `attended`
 *   verb is returned before the canonical-attendance branch, so the edge is
 *   never oriented person -> meeting (orientCanonicalAttendance).
 * N9-4: the seed of "Who attended <meeting title>?" never resolves, because
 *   resolveEntitySlugWithSource only returns entity pages; the relational arm
 *   drops the fallback_slugify result and does not fire.
 */
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'node_modules/gbrain');
const { PGLiteEngine } = await import(join(root, 'src/core/pglite-engine.ts'));
const { importFromContent } = await import(join(root, 'src/core/import-file.ts'));
const { runExtract } = await import(join(root, 'src/commands/extract.ts'));
const { hybridSearch } = await import(join(root, 'src/core/search/hybrid.ts'));
const { parseRelationalQuery } = await import(join(root, 'src/core/search/relational-intent.ts'));
const { resolveEntitySlugWithSource } = await import(join(root, 'src/core/entities/resolve.ts'));

const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const quiet = console.log;
console.log = () => {};
const page = (type: string, title: string, body: string, fm = '') => `---\ntype: ${type}\ntitle: ${JSON.stringify(title)}\n${fm}---\n\n# ${title}\n\n${body}`;
await importFromContent(engine, 'people/alice-example', page('person', 'Alice Example', 'Alice Example is a founder.'), { noEmbed: true });
await importFromContent(engine, 'people/bob-example', page('person', 'Bob Example', 'Bob Example is an investor.'), { noEmbed: true });
await importFromContent(engine, 'meetings/board-acme-example', page('meeting', 'Acme Example Board Meeting',
  'Attendees: [Alice Example](people/alice-example), [Bob Example](people/bob-example).\n\nThe board reviewed the quarter.'), { noEmbed: true });
await importFromContent(engine, 'meetings/board-beta-example', page('meeting', 'Beta Example Board Meeting',
  'The board reviewed the quarter.', 'attendees: [people/alice-example, people/bob-example]\n'), { noEmbed: true });
await importFromContent(engine, 'companies/gamma-example', page('company', 'Gamma Example', 'Gamma Example builds tools.', 'investors: [people/bob-example]\n'), { noEmbed: true });
await runExtract(engine, ['links', '--source', 'db', '--include-frontmatter']);
console.log = quiet;

const edges = await engine.executeRaw(`SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.link_source FROM links l
  JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE l.link_type IN ('attended', 'invested_in') ORDER BY 1, 2`);
console.log('typed edges (from -> to, type, producer):');
for (const e of edges as Array<{ from_slug: string; to_slug: string; link_type: string; link_source: string }>) console.log(`  ${e.from_slug} -> ${e.to_slug} (${e.link_type}, ${e.link_source})`);
const inv = parseRelationalQuery('Who invested in Gamma Example?');
console.log(`contrast, frontmatter investors on a company page: parse ${JSON.stringify({ linkTypes: inv.linkTypes, direction: inv.direction })}, fanout ${JSON.stringify((await engine.relationalFanout(['companies/gamma-example'], { linkTypes: inv.linkTypes, direction: inv.direction, depth: 1, sourceId: 'default' })).map((r: { slug: string }) => r.slug))} (expected people/bob-example)`);

for (const meeting of ['meetings/board-acme-example', 'meetings/board-beta-example']) {
  const q = `Who attended ${meeting === 'meetings/board-acme-example' ? 'Acme' : 'Beta'} Example Board Meeting?`;
  const parsed = parseRelationalQuery(q);
  const fan = await engine.relationalFanout([meeting], { linkTypes: parsed.linkTypes, direction: parsed.direction, depth: 1, sourceId: 'default' });
  console.log(`\n${q}\n  parse: ${JSON.stringify({ seeds: parsed.seeds, linkTypes: parsed.linkTypes, direction: parsed.direction })}`);
  console.log(`  N9-2 fanout from ${meeting} with the parsed direction: ${JSON.stringify(fan.map((r: { slug: string }) => r.slug))} (expected both attendees)`);
  console.log(`  N9-3 seed resolution: ${JSON.stringify(await resolveEntitySlugWithSource(engine, 'default', parsed.seeds[0]))} (expected ${meeting})`);
  let meta: unknown;
  await hybridSearch(engine, q, { limit: 5, relationalRetrieval: true, expansion: false, autocut: false, adaptiveReturn: false, onRelationalMeta: (m: unknown) => { meta = m; } });
  console.log(`  relational arm: ${JSON.stringify(meta)} (expected fired: true)`);
}
await engine.disconnect();
