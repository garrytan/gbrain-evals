/**
 * Alias-stack mechanism probe ($0, keyless brains, no reader): build each persona's base brain on a gbrain build, then
 * 1. call context_pack on each task's champion and company, as the readers' first call does, and record which
 *    correcting pages (handoff, reschedule, call note) are in the result;
 * 2. read the brain's derived names of 2 or 3 characters (page_aliases) and compare them with the codes the generator's
 *    pages declare for themselves ("Also called YAR in my notes"): which codes became aliases, and any alias on a page
 *    that did not declare it (a false alias);
 * 3. read the links into each task's company page from its correcting pages.
 *
 *   bun docs/benchmarks/2026-10-08-program-primary-hard/alias-stack/alias-probe.ts --gbrain <checkout> --ref <sha> --label <name> [--seeds a,b,...] [--gold gold.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_KNOBS, PPH_BASELINE_SEEDS, generateHardWorld, renderHardDoc, type HardPersona } from '../../../../eval/generators/program-primary-hard-gen.ts';
import { GbrainSlot, MeteringProxy } from '../../../../eval/runner/cat40/gbrain-arm.ts';
import { prepareBuild } from '../../../../eval/runner/lifecycle/builds.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ref = flag('--ref')!; const label = flag('--label')!;
const seeds = flag('--seeds')?.split(',').map(Number) ?? [...PPH_BASELINE_SEEDS];
const root = join(process.env.HOME!, '.capy/work/alias/probe');
mkdirSync(root, { recursive: true });
const world = generateHardWorld(seeds, DEFAULT_KNOBS);
const gold = JSON.parse(readFileSync(flag('--gold') ?? join(import.meta.dir, '..', 'root-cause', 'gold.json'), 'utf8'));
const proxy = new MeteringProxy({}); proxy.start();
const build = prepareBuild(flag('--gbrain')!, { label: `alias-probe-${label}`, ref, description: 'alias probe' }, join(root, 'builds'));

function sql(dir: string, q: string): any[] {
  const pglite = join(build.dir, 'node_modules/@electric-sql/pglite/dist');
  const script = `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)}); const db = await PGlite.create({ dataDir: ${JSON.stringify(join(dir, 'home', 'brain.pglite'))}, extensions: { vector, pg_trgm } }); const r = await db.query(${JSON.stringify(q)}); console.log(JSON.stringify(r.rows)); await db.close();`;
  return JSON.parse(execFileSync('bun', ['-e', script], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop()!);
}

const DECLARED_RE = /Also called (\S+) in my notes/;
const personas: any[] = [];
async function doPersona(p: HardPersona) {
  const slot = new GbrainSlot(`${p.id}-${label}`, join(root, 'slots'), build.dir, proxy.port, 'starter');
  if (!slot.hasSnapshot()) await slot.build({ docs: p.docs }, proxy, true, { render: renderHardDoc, embed: false });
  await slot.restore();
  const cards: any[] = [];
  for (const t of p.tasks) {
    const g = gold[t.id];
    const res = await slot.client!.call('context_pack', { entities: `${g.champion_slug},${g.company}` });
    cards.push({ task: t.id, chars: res.length, present: Object.fromEntries(Object.entries(g.docs as Record<string, string>).map(([k, d]) => [k, res.includes(d)])) });
  }
  await slot.stop();
  const declared = p.docs.flatMap(d => { const m = DECLARED_RE.exec(d.body); return m ? [{ slug: d.id, code: m[1] }] : []; });
  const short = sql(slot.dir, `select alias_text, alias_norm, slug, origin, case_sensitive from page_aliases where length(coalesce(alias_text, alias_norm)) <= 3 order by slug, alias_norm`);
  const isDeclared = (r: any) => declared.some(d => d.slug === r.slug && d.code === (r.alias_text ?? r.alias_norm));
  const codeOwners = new Map<string, string[]>();
  for (const d of declared) codeOwners.set(d.code, [...(codeOwners.get(d.code) ?? []), d.slug]);
  const taskLinks = p.tasks.map(t => {
    const g = gold[t.id];
    const companySlug = p.docs.find(d => d.type === 'company' && d.title === g.company)?.id;
    const docs = Object.values(g.docs as Record<string, string>).map(s => `'${s}'`).join(',');
    const rows = sql(slot.dir, `select p1.slug as from_slug, p2.slug as to_slug, l.link_type from links l join pages p1 on p1.id=l.from_page_id join pages p2 on p2.id=l.to_page_id where p1.slug in (${docs}) order by 1, 2`);
    return { task: t.id, company: companySlug, links: rows, call_note_links_company: rows.some(r => r.from_slug === g.docs.terms && r.to_slug === companySlug) };
  });
  personas.push({
    persona: p.id, cards, declared_codes: declared.length,
    short_aliases: short.map(r => ({ ...r, declared_by_this_page: isDeclared(r) })),
    declared_not_derived: declared.filter(d => !short.some(r => r.slug === d.slug && (r.alias_text ?? r.alias_norm) === d.code)),
    shared_codes: [...codeOwners].filter(([, v]) => v.length > 1).map(([code, slugs]) => ({ code, slugs })),
    task_links: taskLinks,
  });
  console.error(`[alias-probe] ${p.id}: ${short.length} short aliases, ${declared.length} declared codes`);
}
try {
  const q = [...world.personas];
  await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) await doPersona(q.shift()!); }));
} finally { proxy.stop(); }
personas.sort((a, b) => a.persona.localeCompare(b.persona));
const cards = personas.flatMap(p => p.cards);
const shorts = personas.flatMap(p => p.short_aliases);
const summary = {
  tasks: cards.length,
  card_has: Object.fromEntries(['contact', 'date', 'terms'].map(k => [k, cards.filter(c => c.present[k]).length])),
  declared_codes: personas.reduce((n, p) => n + p.declared_codes, 0),
  short_aliases: shorts.length,
  short_aliases_declared_by_their_page: shorts.filter(r => r.declared_by_this_page).length,
  false_short_aliases: shorts.filter(r => !r.declared_by_this_page),
  declared_not_derived: personas.reduce((n, p) => n + p.declared_not_derived.length, 0),
  shared_codes: personas.flatMap(p => p.shared_codes.map((s: any) => ({ persona: p.persona, ...s }))),
  call_note_links_company: personas.flatMap(p => p.task_links).filter(t => t.call_note_links_company).length,
};
writeFileSync(join(root, `${label}.json`), JSON.stringify({ gbrain: { ref, commit: build.commit, tree: build.tree, version: build.version }, seeds, summary, personas }, null, 1));
console.log(JSON.stringify(summary, null, 1));
