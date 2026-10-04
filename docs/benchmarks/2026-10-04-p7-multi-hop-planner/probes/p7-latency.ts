// P7 latency gate probe: added p95 search latency, planner on vs off, keyless.
//   world-v1:  bun p7-latency.ts world  <gbrain> [pglite|postgres]
//   synthetic: bun p7-latency.ts synth  <gbrain> [pglite|postgres]   (~100k typed links)
const EVALS = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete process.env[k];
const [mode, ROOT = '../gbrain', engineKind = 'pglite'] = process.argv.slice(2);
const { hybridSearch } = await import(ROOT + '/src/core/search/hybrid.ts');

let rng = 42;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

async function makeEngine(): Promise<any> {
  if (engineKind === 'postgres') {
    const { PostgresEngine } = await import(ROOT + '/src/core/postgres-engine.ts');
    const e = new PostgresEngine();
    await e.connect({ database_url: process.env.DATABASE_URL });
    await e.executeRaw(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;`).catch(() => {});
    await e.initSchema();
    return e;
  }
  const { PGLiteEngine } = await import(ROOT + '/src/core/pglite-engine.ts');
  const e = new PGLiteEngine();
  await e.connect(process.env.SYNTH_DB ? { database_path: process.env.SYNTH_DB } : {});
  await e.initSchema();
  return e;
}

let engine: any; let cleanup = async () => {};
let queries: string[] = [];

if (mode === 'world') {
  const { GbrainInlineAdapter } = await import(EVALS + '/eval/runner/adapters/gbrain-inline.ts');
  const { loadWorldCorpus } = await import(EVALS + '/eval/runner/queries/relational.ts');
  const { sanitizePage } = await import(EVALS + '/eval/runner/types.ts');
  const pages = loadWorldCorpus(EVALS + '/eval/data/world-v1');
  const adapter = new GbrainInlineAdapter({ topK: 10, extract: true, embed: false, productRoot: ROOT } as any);
  const state = await adapter.init(pages.map(sanitizePage), { name: 'p7-lat' });
  engine = adapter.engineOf(state); cleanup = () => adapter.teardown(state);
  const people = pages.filter((p: any) => p._facts.type === 'person').map((p: any) => p._facts.name);
  const companies = pages.filter((p: any) => p._facts.type === 'company').map((p: any) => p._facts.name);
  for (let i = 0; i < 150; i++) {
    const a = pick(people), c = pick(companies);
    queries.push(pick([
      `Who founded the companies that ${a} invested in?`, `Who invested in the companies founded by ${a}?`,
      `Who else invested in the companies ${a} invested in?`, `Who invested in ${c}?`, `what does ${c} do`,
      `${a} background`, `notes about ${c} fundraising`,
    ]));
  }
} else {
  engine = await makeEngine(); cleanup = () => engine.disconnect();
  const NC = 2000, NP = 8000;
  const existing = await engine.executeRaw(`SELECT count(*)::int AS n FROM links`);
  if (existing[0].n < 100000) {
  const { importFromContent } = await import(ROOT + '/src/core/import-file.ts');
  const t0 = Date.now();
  for (let g = 1; g <= NC + NP; g++) {
    const company = g <= NC; const n = company ? g : g - NC;
    const slug = company ? `companies/zeta-example-${n}` : `people/pat-example-${n}`;
    const title = company ? `Zeta Example ${n}` : `Pat Example ${n}`;
    const body = company ? `${title} builds developer tools.` : `${title} works in tech.`;
    await importFromContent(engine, slug, `---\ntype: ${company ? 'company' : 'person'}\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n${body}\n`, { noEmbed: true });
  }
  console.error('pages in', Date.now() - t0, 'ms');
  // ~100k typed links: invested_in 10/person (80k), founded 2/company (4k), advises 2/person (16k).
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
    SELECT DISTINCT p.id, c.id, 'invested_in', '', 'markdown' FROM generate_series(1, ${NP}) pg CROSS JOIN generate_series(1, 10) k
    JOIN pages p ON p.slug = 'people/pat-example-' || pg
    JOIN pages c ON c.slug = 'companies/zeta-example-' || (1 + ((pg * 7919 + k * 104729) % ${NC}))`);
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
    SELECT DISTINCT c.id, p.id, 'founded', '', 'markdown' FROM generate_series(1, ${NC}) cg CROSS JOIN generate_series(1, 2) k
    JOIN pages c ON c.slug = 'companies/zeta-example-' || cg
    JOIN pages p ON p.slug = 'people/pat-example-' || (1 + ((cg * 31 + k * 4001) % ${NP}))`);
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
    SELECT DISTINCT p.id, c.id, 'advises', '', 'markdown' FROM generate_series(1, ${NP}) pg CROSS JOIN generate_series(1, 2) k
    JOIN pages p ON p.slug = 'people/pat-example-' || pg
    JOIN pages c ON c.slug = 'companies/zeta-example-' || (1 + ((pg * 613 + k * 7) % ${NC}))`);
  }
  const n = await engine.executeRaw(`SELECT count(*)::int AS n FROM links`);
  console.error('links', n[0].n);
  for (let i = 0; i < 150; i++) {
    const a = `Pat Example ${1 + Math.floor(rand() * NP)}`, c = `Zeta Example ${1 + Math.floor(rand() * NC)}`;
    queries.push(pick([
      `Who founded the companies that ${a} invested in?`, `Who invested in the companies founded by ${a}?`,
      `Who else invested in the companies ${a} invested in?`, `Who advises the companies ${a} invested in?`,
      `Who invested in ${c}?`, `what does ${c} do`, `${a} background`,
    ]));
  }
}

if (process.env.DBG) { for (const q of queries.slice(0, 4)) { let m: any; const r = await hybridSearch(engine, q, { limit: 10, relationalRetrieval: true, relationalRetrievalDepth: 2, relationalPlanner: true, relationalChainSlots: 10, expansion: false, autocut: false, adaptiveReturn: false, onRelationalMeta: (x: any) => { m = x; } }); console.log(q, JSON.stringify(m), r.length); } }
const opts = (planner: boolean) => ({ limit: 10, relationalRetrieval: true, relationalRetrievalDepth: 2, relationalPlanner: planner, relationalChainSlots: 10, expansion: false, autocut: false, adaptiveReturn: false });
for (const q of queries.slice(0, 10)) { await hybridSearch(engine, q, opts(false)); await hybridSearch(engine, q, opts(true)); }
const off: number[] = [], on: number[] = [], delta: number[] = [];
let fired = 0;
for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const t: Record<string, number> = {};
  for (const planner of (i % 2 ? [true, false] : [false, true])) {
    const s = performance.now();
    let meta: any = null;
    await hybridSearch(engine, q, { ...opts(planner), onRelationalMeta: (m: any) => { meta = m; } });
    t[String(planner)] = performance.now() - s;
    if (planner && meta?.fired) fired++;
  }
  off.push(t.false); on.push(t.true); delta.push(t.true - t.false);
}
const byTpl: Record<string, number[]> = {};
for (let i = 0; i < queries.length; i++) { const k = queries[i].replace(/\d+/g, 'N').replace(/(Pat|Zeta) Example N/g, '$1'); (byTpl[k] ??= []).push(delta[i]); }
const p = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
console.log(JSON.stringify({ mode, engine: engineKind, n: queries.length, chain_fired: fired,
  p50_off: +p(off, 0.5).toFixed(1), p50_on: +p(on, 0.5).toFixed(1), p95_off: +p(off, 0.95).toFixed(1), p95_on: +p(on, 0.95).toFixed(1),
  added_p95: +(p(on, 0.95) - p(off, 0.95)).toFixed(1), p95_paired_delta: +p(delta, 0.95).toFixed(1) }));
for (const [k, v] of Object.entries(byTpl)) console.log('TPL', k.slice(0, 60).padEnd(60), 'n', v.length, 'p50', p(v, 0.5).toFixed(1), 'p95', p(v, 0.95).toFixed(1));
await cleanup();
