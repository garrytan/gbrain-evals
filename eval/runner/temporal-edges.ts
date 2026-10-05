/**
 * Temporal typed edges (P1, E1), development split: does gbrain answer
 * "who works there now", "where did they work on date D" and "during year Y"
 * from linked notes whose employment changed over time?
 *
 * The world comes from eval/generators/temporal-edges-gen.ts (phrasing set A,
 * dev seeds 3 and 5). Pages are written through put_page on in-memory PGLite
 * in a shuffled order, then probed through gbrain's own graph operations and
 * context_pack. Gold comes from the ledger, never from gbrain. Every probe row
 * carries exactly one metric field so the decision kit pairs each family on
 * its own:
 *   now_precision / now_recall  get_backlinks(company), works_at rows vs current staff
 *   asof_exact                  get_links(person, works_at, as_of) equals the employers on that date
 *   during_f1                   get_links(person, works_at, during: year) set-F1
 *   live_recall                 default get_links still lists every current employer
 *   trap_ok                     advisor roles stay live; investments and alumni meetings
 *                               at a former employer do not reopen employment
 *   invariant                   a second brain written in reverse order, each person first
 *                               without a timeline, returns the same relationships and stints
 *   correction_ok               context_pack for a person whose summary names a former
 *                               employer flags that employment as ended and never as current
 *   correction_names_current    the same context_pack also names the current employer as
 *                               current (needs the new employer typed works_at; exploratory)
 * A build without temporal parameters answers with whatever its graph returns;
 * that is the comparison, not an error.
 *
 * Hermetic: provider keys stripped, PGLite in memory, zero LLM.
 *
 * Usage: bun eval/runner/temporal-edges.ts [--seeds 3,5] [--phrasing A|A2|A3] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 *   [--pack <pack.yaml>] [--single-value-pass]   (P3 E5: bind a test schema pack before any page; run one declared-only
 *   edge_contradictions pass before the probes and add sv_wrong_closures / sv_conflicts_closed rows)
 *   [--render relation-lines]   (P5 delta H7: a seeded half of the people state employment only as typed relation lines
 *   with @effective ranges; person probe rows gain `render` and a numeric `range_page` 0/1, and every person rendered as
 *   prose gets a `transitions_sig` row, a SHA-256 of that page's link_transitions rows, so two arms compare exactly)
 *   [--e5-probe]   (P5 delta H10: adds 36 probe people per seed with one long current stint and a later dated advisory
 *   line; needs --pack and --single-value-pass; rows e5_wrong_closures and e5_extra_works_at_starts per probe person)
 *
 * Arm config: GBRAIN_EVAL_CONFIG (eval/runner/eval-config.ts), for example
 * `line_grammar.effective_ranges=true`, is applied to both brains (scored and mirror) before any page or pack is
 * written, read back, and recorded in resolved_config.eval_config.
 *
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>.
 * The phrasing file lives outside the repository; every read appends a line to access-log.jsonl beside it, and the
 * receipt records only the phrasing file's SHA-256, never its text.
 */
import { join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  DEV_SEEDS, E5_PROBES_PER_SEED, RENDER_MODES, TEMPORAL_EDGES_GENERATOR_VERSION, currentEmployers, generateTemporalEdgesWorld, validatePhrasing,
  type PhrasingTemplates, type RenderMode, type TePage, type TePerson, type TemporalEdgesWorld,
} from '../generators/temporal-edges-gen.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { appendAccessLog } from './sealed-confirmation-lib.ts';
import { applyEvalConfig, evalConfigRecord, parseEvalConfig } from './eval-config.ts';

export const CATEGORY = 'temporal-edges';

type Op = (name: string, params: Record<string, unknown>) => Promise<unknown>;
interface Sut { op: Op; put(slug: string, content: string): Promise<void>; close(): Promise<void>; engine: SutEngine; configRecord: Record<string, unknown> }
interface SutEngine { setConfig(k: string, v: string): Promise<void>; getConfig(k: string): Promise<string | null>; executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> }
export interface TeRow { probe_id: string; kind: string; cluster: string; seed: number; [metric: string]: unknown }

async function openSut(gut: GbrainUnderTest, evalConfig: Record<string, string>): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => { connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; readPageSnapshot(slug: string, o: { sourceId: string }): Promise<{ revision: unknown } | null> } }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const { KNOWN_CONFIG_KEYS } = await importGbrain<{ KNOWN_CONFIG_KEYS?: readonly string[] }>(gut, 'src/core/config.ts');
  const configRecord = evalConfigRecord(await applyEvalConfig(engine as unknown as SutEngine, evalConfig), KNOWN_CONFIG_KEYS ?? null);
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
  const byName = new Map(operations.map(o => [o.name, o]));
  return {
    op: async (name, params) => {
      const o = byName.get(name);
      if (!o) throw new Error(`gbrain has no operation ${name}`);
      return await o.handler(ctx, params);
    },
    put: async (slug, content) => {
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await byName.get('put_page')!.handler(ctx, { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
    },
    close: () => engine.disconnect(),
    engine: engine as unknown as SutEngine,
    configRecord,
  };
}

async function writePages(sut: Sut, pages: readonly TePage[]): Promise<void> {
  for (const p of pages) await sut.put(p.slug, p.content);
}

const setOf = (rows: unknown, field: 'to_slug' | 'from_slug', type = 'works_at') =>
  new Set((rows as Array<Record<string, unknown>>).filter(r => r.link_type === type).map(r => String(r[field])));
const f1 = (got: Set<string>, gold: readonly string[]) => {
  if (!got.size && !gold.length) return 1;
  const tp = gold.filter(g => got.has(g)).length;
  return tp === 0 ? 0 : (2 * tp) / (got.size + gold.length);
};
const short = (slug: string) => slug.split('/').pop()!;

/** H7: a stable SHA-256 over the page's link_transitions rows (the pages without ranges must match exactly across arms). */
async function transitionsSig(sut: Sut, slug: string): Promise<{ sig: string; n: number }> {
  const rows = await sut.engine.executeRaw<Record<string, unknown>>(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, lt.link_type, lt.kind, lt.occurred_on::text AS occurred_on, lt.date_precision, lt.producer, lt.line_hash
       FROM link_transitions lt JOIN pages o ON o.id = lt.origin_page_id JOIN pages f ON f.id = lt.from_page_id JOIN pages t ON t.id = lt.to_page_id
      WHERE o.slug = $1`, [slug]);
  const lines = rows.map(r => JSON.stringify([r.from_slug, r.to_slug, r.link_type, r.kind, r.occurred_on, r.date_precision, r.producer, r.line_hash])).sort();
  return { sig: createHash('sha256').update(lines.join('\n')).digest('hex'), n: lines.length };
}

async function probeWorld(world: TemporalEdgesWorld, sut: Sut, mirror: Sut, acc: ProbeAccounting, rows: TeRow[]): Promise<void> {
  const seed = world.seed;
  const ranged = world.range_people ? new Set(world.range_people) : null;
  const tagsFor = (person: string): Record<string, unknown> => ranged
    ? { render: ranged.has(person) ? 'relation_lines' : 'prose', range_page: Number(ranged.has(person)) } : {};
  const probe = async (id: string, kind: string, cluster: string, fn: () => Promise<Record<string, number>>, tags: Record<string, unknown> = {}) => {
    const probe_id = `s${seed}:${id}`;
    try {
      const metrics = await fn();
      rows.push({ probe_id, kind, cluster: `s${seed}:${cluster}`, seed, ...metrics, ...tags });
      acc.score(probe_id, Object.values(metrics)[0]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      acc.error(probe_id, 'sut', message);
      rows.push({ probe_id, kind, cluster: `s${seed}:${cluster}`, seed, error: message, error_origin: 'sut', ...tags });
    }
  };

  for (const c of world.companies) {
    const gold = world.people.filter(p => currentEmployers(p).includes(c.slug)).map(p => p.slug);
    const got = async () => setOf(await sut.op('get_backlinks', { slug: c.slug }), 'from_slug');
    await probe(`now-p:${c.slug}`, 'now', c.slug, async () => {
      const g = await got(); const tp = gold.filter(x => g.has(x)).length;
      return { now_precision: g.size ? tp / g.size : gold.length ? 0 : 1 };
    });
    await probe(`now-r:${c.slug}`, 'now', c.slug, async () => {
      const g = await got();
      return { now_recall: gold.length ? gold.filter(x => g.has(x)).length / gold.length : 1 };
    });
  }
  for (const a of world.asof_probes) {
    await probe(a.id, 'asof', a.person, async () => {
      const got = setOf(await sut.op('get_links', { slug: a.person, link_type: 'works_at', as_of: a.date }), 'to_slug');
      return { asof_exact: Number(got.size === a.gold.length && a.gold.every(g => got.has(g))) };
    }, tagsFor(a.person));
  }
  for (const d of world.during_probes) {
    await probe(d.id, 'during', d.person, async () => {
      const got = setOf(await sut.op('get_links', { slug: d.person, link_type: 'works_at', during: d.from.slice(0, 4) }), 'to_slug');
      return { during_f1: f1(got, d.gold) };
    }, tagsFor(d.person));
  }
  for (const p of world.people) {
    const tags = tagsFor(p.slug);
    const cur = currentEmployers(p);
    if (ranged && !ranged.has(p.slug)) {
      const probe_id = `s${seed}:transitions:${p.slug}`;
      try {
        const t = await transitionsSig(sut, p.slug);
        rows.push({ probe_id, kind: 'transitions', cluster: `s${seed}:${p.slug}`, seed, transitions_sig: t.sig, transitions_n: t.n, ...tags });
        acc.score(probe_id, 1);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        acc.error(probe_id, 'sut', message);
        rows.push({ probe_id, kind: 'transitions', cluster: `s${seed}:${p.slug}`, seed, error: message, error_origin: 'sut', ...tags });
      }
    }
    if (cur.length) {
      await probe(`live:${p.slug}`, 'live', p.slug, async () => {
        const got = setOf(await sut.op('get_links', { slug: p.slug }), 'to_slug');
        return { live_recall: cur.filter(c => got.has(c)).length / cur.length };
      }, tags);
    }
    if (p.advises) {
      const company = p.advises.company;
      await probe(`trap-advises:${p.slug}`, 'trap', p.slug, async () => ({
        trap_ok: Number(setOf(await sut.op('get_links', { slug: p.slug }), 'to_slug', 'advises').has(company)),
      }), tags);
    }
    for (const [label, t] of [['invest', p.invests_after_exit], ['alumni', p.alumni_meeting]] as const) {
      if (!t || cur.includes(t.company)) continue;
      await probe(`trap-${label}:${p.slug}`, 'trap', p.slug, async () => ({
        trap_ok: Number(!setOf(await sut.op('get_links', { slug: p.slug }), 'to_slug').has(t.company)),
      }), tags);
    }
    await probe(`invariant:${p.slug}`, 'invariant', p.slug, async () => {
      const view = async (s: Sut) => JSON.stringify([
        [...setOf(await s.op('get_links', { slug: p.slug }), 'to_slug')].sort(),
        (await s.op('get_links', { slug: p.slug, link_type: 'works_at', status: 'all' }) as Array<Record<string, unknown>>)
          .map(r => [r.to_slug, r.status ?? null, JSON.stringify(r.stints ?? null)]).sort(),
      ]);
      return { invariant: Number((await view(sut)) === (await view(mirror))) };
    }, tags);
    if (p.style === 'stale_summary' && p.stints.some(s => s.until !== null)) {
      const formerNamed = [...p.stints].reverse().find(s => s.until !== null)!.company;
      await probe(`correction:${p.slug}`, 'correction', p.slug, async () => {
        const text = JSON.stringify(await sut.op('context_pack', { entities: p.slug }));
        const flagsEnded = cur.includes(formerNamed) || new RegExp(`ended: [^;\\]]*works_at ${short(formerNamed)}`).test(text);
        const formerAsNow = !cur.includes(formerNamed) && new RegExp(`now: [^;\\]]*${short(formerNamed)}`).test(text);
        const namesCurrent = cur.every(c => new RegExp(`now: [^;\\]]*${short(c)}`).test(text));
        return { correction_ok: Number(flagsEnded && !formerAsNow), correction_names_current: Number(namesCurrent) };
      }, tags);
    }
  }
}

/** E5 (declared single-value relations): a test pack installed in the hermetic GBRAIN_HOME and bound before any page. */
export interface TePack { name: string; text: string }
async function installPack(gut: GbrainUnderTest, sut: Sut, pack: TePack): Promise<void> {
  if (!process.env.GBRAIN_HOME) throw new Error('--pack needs the hermetic GBRAIN_HOME');
  const { gbrainPath } = await importGbrain<{ gbrainPath: (...s: string[]) => string }>(gut, 'src/core/config.ts');
  const dir = gbrainPath('schema-packs', pack.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), pack.text);
  await sut.engine.setConfig('schema_pack', pack.name);
  const { loadActivePackForEngine } = await importGbrain<{ loadActivePackForEngine: (e: unknown, o: Record<string, unknown>) => Promise<{ manifest: { name: string } }> }>(gut, 'src/core/schema-pack/engine-resolution.ts');
  const active = await loadActivePackForEngine(sut.engine, { sourceId: 'default', remote: false });
  if (active.manifest.name !== pack.name) throw new Error(`--pack ${pack.name} is not the active pack after binding (active: ${active.manifest.name})`);
}

interface SvClosure { person: string; ending: string; close_date: string; status: string }
/**
 * One declared-only edge_contradictions pass (dream.single_value.mode=apply, dream.edge_contradictions.mode=off: no
 * model). Returns the declared-rule proposals and which live works_at relationships had no dated start, or shared a
 * dated start with another, before the pass.
 */
async function singleValuePass(gut: GbrainUnderTest, sut: Sut): Promise<{ closures: SvClosure[]; undated: Set<string>; sameDate: Set<string>; detail: string }> {
  const live = await sut.engine.executeRaw<{ person: string; target: string; last_start: unknown }>(
    `SELECT f.slug AS person, t.slug AS target, lr.last_start FROM link_relationships lr JOIN pages f ON f.id = lr.from_page_id JOIN pages t ON t.id = lr.to_page_id
      WHERE lr.scope = 'all' AND lr.link_type = 'works_at' AND lr.semantics = 'state' AND lr.valid_ranges @> CURRENT_DATE`);
  const key = (p: string, t: string) => `${p}\u0000${t}`;
  const undated = new Set(live.filter(r => r.last_start == null).map(r => key(r.person, r.target)));
  const byStart = new Map<string, string[]>();
  for (const r of live) if (r.last_start != null) { const k = `${r.person}\u0000${String(r.last_start).slice(0, 10)}`; byStart.set(k, [...(byStart.get(k) ?? []), r.target]); }
  const sameDate = new Set<string>();
  for (const [k, ts] of byStart) if (ts.length > 1) for (const t of ts) sameDate.add(key(k.split('\u0000')[0]!, t));
  await sut.engine.setConfig('dream.single_value.mode', 'apply');
  await sut.engine.setConfig('dream.edge_contradictions.mode', 'off');
  const { runPhaseEdgeContradictions } = await importGbrain<{ runPhaseEdgeContradictions: (e: unknown) => Promise<{ status: string; detail: string }> }>(gut, 'src/core/cycle/edge-contradictions.ts');
  const r = await runPhaseEdgeContradictions(sut.engine);
  const closures = await sut.engine.executeRaw<SvClosure>(
    `SELECT f.slug AS person, t.slug AS ending, p.close_date::text AS close_date, p.status FROM link_edge_proposals p
       JOIN pages f ON f.id = p.from_page_id LEFT JOIN pages t ON t.id = p.ending_to_page_id
      WHERE p.link_type = 'works_at' AND p.model = 'schema-pack:cardinality'`);
  return { closures, undated, sameDate, detail: `${r.status}: ${r.detail}` };
}

/** Wrong: the ledger says the ended employer is current, or the close date is not the start of the ledger's next stint. */
export function svClosureWrong(p: TePerson, ending: string, closeDate: string): boolean {
  if (currentEmployers(p).includes(ending)) return true;
  const k = [...p.stints.keys()].filter(i => p.stints[i]!.company === ending && p.stints[i]!.from < closeDate).pop();
  if (k === undefined) return true;
  const next = p.stints[k + 1];
  return !next || next.from !== closeDate;
}

export interface TeRunResult { worlds: TemporalEdgesWorld[]; rows: TeRow[]; acc: ProbeAccounting; harnessError: string | null; singleValue: Array<Record<string, unknown>> | null; evalConfig: Record<string, unknown> | null }

export async function runTemporalEdges(opts: { gut: GbrainUnderTest; seeds?: readonly number[]; log?: (s: string) => void; phrasing?: string; sealedPhrasing?: { id: string; templates: PhrasingTemplates }; pack?: TePack; singleValuePass?: boolean; render?: RenderMode; e5Probe?: boolean; evalConfig?: Record<string, string> }): Promise<TeRunResult> {
  if (opts.e5Probe && (!opts.pack || !opts.singleValuePass)) throw new Error('--e5-probe measures wrong closures with the single-value machinery: pass --pack eval/data/p3-single-value/works-at-one-per-from.yaml --single-value-pass');
  return withHermeticEnv('temporal-edges', async () => {
    const log = opts.log ?? (() => {});
    const worlds = (opts.seeds ?? DEV_SEEDS).map(seed => generateTemporalEdgesWorld({ seed, phrasing: opts.sealedPhrasing ? undefined : opts.phrasing, sealedPhrasing: opts.sealedPhrasing, render: opts.render, e5Probe: opts.e5Probe }));
    let evalConfig: Record<string, unknown> | null = null;
    const acc = new ProbeAccounting(0);
    const rows: TeRow[] = [];
    const svTotals: Array<Record<string, unknown>> = [];
    let harnessError: string | null = null;
    for (const world of worlds) {
      let sut: Sut | null = null;
      let mirror: Sut | null = null;
      try {
        sut = await openSut(opts.gut, opts.evalConfig ?? {});
        mirror = await openSut(opts.gut, opts.evalConfig ?? {});
        evalConfig ??= { scored: sut.configRecord, mirror: mirror.configRecord };
        if (opts.pack) { await installPack(opts.gut, sut, opts.pack); await installPack(opts.gut, mirror, opts.pack); }
        log(`seed ${world.seed}: ${world.people.length} people, ${world.companies.length} companies, ${world.pages.length} pages${world.range_people ? `, ${world.range_people.length} rendered as relation lines` : ''}${world.e5_probes ? `, ${world.e5_probes.length} E5 probe people` : ''}`);
        await writePages(sut, world.pages);
        const companies = world.pages.filter(p => p.slug.startsWith('companies/'));
        const people = world.pages.filter(p => p.slug.startsWith('people/'));
        await writePages(mirror, [...companies].reverse());
        await writePages(mirror, people.map(p => ({ slug: p.slug, content: p.content.replace(/## Timeline[\s\S]*$/, '') })));
        await writePages(mirror, [...people].reverse());
        if (opts.singleValuePass) {
          const sv = await singleValuePass(opts.gut, sut);
          await singleValuePass(opts.gut, mirror);
          log(`seed ${world.seed}: single-value pass ${sv.detail}`);
          const key = (p: string, t: string) => `${p}\u0000${t}`;
          const appliedFor = (slug: string) => sv.closures.filter(c => c.person === slug && c.status === 'applied' && c.ending && c.close_date);
          const push = (row: TeRow, metric: string) => { rows.push(row); acc.score(row.probe_id, row[metric] as number); };
          for (const p of world.people) {
            const applied = appliedFor(p.slug);
            push({ probe_id: `s${world.seed}:sv-wrong:${p.slug}`, kind: 'single_value', cluster: `s${world.seed}:${p.slug}`, seed: world.seed,
              sv_wrong_closures: applied.filter(c => svClosureWrong(p, c.ending, c.close_date.slice(0, 10))).length }, 'sv_wrong_closures');
            push({ probe_id: `s${world.seed}:sv-open:${p.slug}`, kind: 'single_value', cluster: `s${world.seed}:${p.slug}`, seed: world.seed,
              sv_conflicts_closed: applied.filter(c => sv.undated.has(key(p.slug, c.ending)) || sv.sameDate.has(key(p.slug, c.ending))).length }, 'sv_conflicts_closed');
          }
          if (world.e5_probes) {
            const starts = await sut.engine.executeRaw<{ person: string; n: number }>(
              `SELECT o.slug AS person, count(*)::int AS n FROM link_transitions lt JOIN pages o ON o.id = lt.origin_page_id
                WHERE lt.link_type = 'works_at' AND lt.kind = 'start' AND o.slug = ANY($1::text[]) GROUP BY o.slug`, [world.e5_probes.map(p => p.slug)]);
            for (const p of world.e5_probes) {
              const tags = { e5_form: p.e5.form, e5_target: p.e5.target };
              push({ probe_id: `s${world.seed}:e5-wrong:${p.slug}`, kind: 'e5', cluster: `s${world.seed}:${p.slug}`, seed: world.seed,
                e5_wrong_closures: appliedFor(p.slug).filter(c => svClosureWrong(p, c.ending, c.close_date.slice(0, 10))).length, ...tags }, 'e5_wrong_closures');
              push({ probe_id: `s${world.seed}:e5-starts:${p.slug}`, kind: 'e5', cluster: `s${world.seed}:${p.slug}`, seed: world.seed,
                e5_extra_works_at_starts: Math.max(0, Number(starts.find(r => r.person === p.slug)?.n ?? 0) - p.stints.length), ...tags }, 'e5_extra_works_at_starts');
            }
          }
          svTotals.push({ seed: world.seed, detail: sv.detail, applied: sv.closures.filter(c => c.status === 'applied').length,
            statuses: sv.closures.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {}),
            undated_live: sv.undated.size, same_date_live: sv.sameDate.size });
        }
        await probeWorld(world, sut, mirror, acc, rows);
      } catch (e) {
        harnessError = `seed ${world.seed}: ${e instanceof Error ? e.message : String(e)}`;
        acc.error(`s${world.seed}:seed`, 'harness', harnessError);
      } finally {
        await sut?.close().catch(() => {});
        await mirror?.close().catch(() => {});
      }
    }
    const planned = new ProbeAccounting(rows.length);
    planned.absorb(acc.toJSON());
    return { worlds, rows, acc: planned, harnessError, singleValue: opts.singleValuePass ? svTotals : null, evalConfig };
  });
}

export function summarize(rows: readonly TeRow[]): Record<string, { n: number; mean: number }> {
  const out: Record<string, { n: number; mean: number }> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (['probe_id', 'kind', 'cluster', 'seed', 'range_page', 'transitions_n'].includes(k) || typeof v !== 'number') continue;
      const s = (out[k] ??= { n: 0, mean: 0 });
      s.mean = (s.mean * s.n + v) / (s.n + 1); s.n++;
    }
  }
  return out;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seeds = (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  const phrasingFile = argValue(argv, '--phrasing-file');
  let sealedPhrasing: { id: string; templates: PhrasingTemplates } | undefined;
  let phrasingSha: string | null = null;
  if (phrasingFile) {
    const decisionId = argValue(argv, '--decision-id');
    const purpose = argValue(argv, '--purpose');
    if (!decisionId || !purpose) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before the phrasing file is read');
    const bytes = readFileSync(phrasingFile);
    phrasingSha = createHash('sha256').update(bytes).digest('hex');
    appendAccessLog(join(dirname(phrasingFile), 'access-log.jsonl'), { action: 'open', purpose, decision_id: decisionId, labels_sha256: phrasingSha, run_sha256: null });
    const parsed = JSON.parse(bytes.toString('utf8')) as { id: string; templates: unknown };
    sealedPhrasing = { id: parsed.id, templates: validatePhrasing(parsed.templates) };
  } else if (!seeds.every(s => DEV_SEEDS.includes(s))) {
    throw new Error(`only dev seeds ${DEV_SEEDS.join(', ')} run here; held-out seeds belong to the custodian`);
  }
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# temporal-edges (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const devPhrasing = argValue(argv, '--phrasing') ?? 'A';
  const packFile = argValue(argv, '--pack');
  const pack = packFile ? (() => { const text = readFileSync(packFile, 'utf8'); const name = /^name:\s*([A-Za-z0-9_-]+)\s*$/m.exec(text)?.[1]; if (!name) throw new Error('--pack file needs a top-level name:'); return { name, text }; })() : undefined;
  const singleValuePassFlag = argv.includes('--single-value-pass');
  const render = argValue(argv, '--render') as RenderMode | undefined;
  if (render !== undefined && !(RENDER_MODES as readonly string[]).includes(render)) throw new Error(`--render ${render}: use ${RENDER_MODES.join(' or ')}`);
  const e5Probe = argv.includes('--e5-probe');
  const evalConfig = parseEvalConfig();
  const r = await runTemporalEdges({ gut, seeds, log, phrasing: devPhrasing, sealedPhrasing, pack, singleValuePass: singleValuePassFlag, render, e5Probe, evalConfig });
  const a = r.acc.summary();
  const summary = summarize(r.rows);
  const byRender = r.worlds.some(w => w.range_people) ? {
    relation_lines: summarize(r.rows.filter(x => x.range_page === 1)),
    prose: summarize(r.rows.filter(x => x.range_page === 0)),
    transitions_rows: r.rows.filter(x => x.kind === 'transitions').length,
  } : null;
  const e5ByCell = e5Probe ? Object.fromEntries([...new Set(r.rows.filter(x => x.kind === 'e5').map(x => `${x.e5_form}/${x.e5_target}`))].sort().map(cell =>
    [cell, summarize(r.rows.filter(x => x.kind === 'e5' && `${x.e5_form}/${x.e5_target}` === cell))])) : null;
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, graph operations and context_pack only; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError ? 'error' : 'completed',
    ...(r.harnessError ? {} : { verdict: 'pass' as const }),
    n_total: a.n_total, n_scored: a.n_scored, completion_rate: a.completion_rate, errors: a.errors,
    publishable: a.publishable && !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default }',
      seeds, phrasing: sealedPhrasing ? `held-out set ${sealedPhrasing.id} (custody file sha256 ${phrasingSha})` : `${devPhrasing} (development)`, generator_version: TEMPORAL_EDGES_GENERATOR_VERSION,
      oracle: 'employment stints from the generator ledger; set arithmetic for now / as-of / during',
      gbrain_overlay: overlaySummary(gut),
      ...(pack ? { pack: { name: pack.name, sha256: createHash('sha256').update(pack.text).digest('hex') } } : {}),
      ...(singleValuePassFlag ? { single_value_pass: 'one edge_contradictions pass, dream.single_value.mode=apply, dream.edge_contradictions.mode=off (no model)' } : {}),
      render: render ?? 'prose',
      ...(render === 'relation-lines' ? { range_selection: 'people whose sha256(`${seed}:${slug}`) has an odd first byte; employment as typed relation lines with @effective ranges under ## Roles' } : {}),
      ...(e5Probe ? { e5_probe: `${E5_PROBES_PER_SEED} probe people per seed on dedicated probe companies: one long current stint and a later dated advisory line (forms tl_advise, became_advisor_at, took_advisory_role_with; target same or other)` } : {}),
      eval_config: r.evalConfig ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: evalConfig, applied: false },
    },
    hashes: Object.fromEntries(r.worlds.map(w => [`ledger_seed_${w.seed}`, w.fingerprint])),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { summary, ...(byRender ? { summary_by_render: byRender } : {}), ...(e5ByCell ? { e5_by_cell: e5ByCell } : {}), rows: r.rows, harness_error: r.harnessError, ...(r.singleValue ? { single_value: r.singleValue } : {}) },
  } as Receipt;
  writeReceipt(outPath, receipt);
  log('\n| metric | n | mean |\n|---|---|---|');
  for (const [k, v] of Object.entries(summary)) log(`| ${k} | ${v.n} | ${v.mean.toFixed(3)} |`);
  if (byRender) for (const [label, part] of [['relation lines', byRender.relation_lines], ['prose', byRender.prose]] as const) log(`${label}: ${Object.entries(part).map(([k, v]) => `${k} ${v.mean.toFixed(3)} (n ${v.n})`).join(', ')}`);
  if (e5ByCell) for (const [cell, part] of Object.entries(e5ByCell)) log(`e5 ${cell}: ${Object.entries(part).map(([k, v]) => `${k} ${(v.mean * v.n).toFixed(0)}/${v.n}`).join(', ')}`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
