/**
 * Temporal typed edges (P1, E3): ingestion to answer. After a correction is
 * written, does every surface an agent reads show the new employer as current
 * and the old one as ended?
 *
 * Preregistered text (gbrain docs/eval/decisions/p1-dev-2026-10-04): "A
 * correction written through stdio put_page (HTTP after remote bulk writes
 * land), then entity, context_pack, ambient turn context, compiled context and
 * query checked by string."
 *
 * Per seed world (eval/generators/temporal-edges-gen.ts), on in-memory PGLite
 * through operation handlers with a trusted local OperationContext:
 *   1. Every company page and every person who is not a target is written.
 *   2. Targets are the people whose ledger has a former employer and a current
 *      one. Each is first written stale: the stale_summary sentence names the
 *      latest former employer F as current and the timeline stops at joining F.
 *      The correction is then written through put_page (expected_revision from
 *      the stored snapshot): the same prose plus the dated move lines (tl_move,
 *      or tl_leave + tl_join) to the current employer C. The stale prose stays,
 *      so a surface passes only by flagging it. Both versions declare the name
 *      without its trailing period as an alias, so the ambient path can point
 *      at the person.
 *   3. Each surface is read for each target and checked by string:
 *        current_ok        "now: … works_at <C>" appears
 *        ended_ok          "ended: … works_at <F>" appears
 *        no_stale_current  no "now:" clause names F, and the surface either
 *                          flags F as ended or does not mention F at all
 *                          (an unflagged stale summary shows F as current)
 *        surface_ok        all three
 *      Surfaces:
 *        entity        the `entity` operation (entity card)
 *        context_pack  the `context_pack` operation for the person
 *        ambient       assembleTurnContext (turn mode, src/core/context/turn-context.ts)
 *                      for "Where does <name> work now?", the person's line only
 *        compiled      compileView (src/core/context/compile-view.ts), the person's
 *                      entry block only
 *        query         the `query` operation for "Where does <name> work now?"
 *      A surface missing from a build scores 0 with a reason; it is not an error.
 *
 * The HTTP transport arm is not run: remote bulk writes have not landed.
 * Report-only; the runner applies no gate. Hermetic: provider keys stripped,
 * keyword search, zero LLM.
 *
 * Usage: bun eval/runner/temporal-ingest-answer.ts [--seeds 3,5] [--phrasing A|A2|A3] [--output <dir>] [--gbrain <checkout>[@ref]] [--json] [--print-sample]
 *
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>.
 * The phrasing file lives outside the repository; every read appends a line to access-log.jsonl beside it, and the
 * receipt records only the phrasing file's SHA-256, never its text. --print-sample is refused in this mode.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import { appendAccessLog } from './sealed-confirmation-lib.ts';
import {
  DEV_SEEDS, PHRASING_A, PHRASING_A2, PHRASING_A3, PHRASING_SETS, TEMPORAL_EDGES_GENERATOR_VERSION, generateTemporalEdgesWorld, validatePhrasing,
  type PhrasingTemplates, type Stint, type TePage, type TePerson, type TemporalEdgesWorld,
} from '../generators/temporal-edges-gen.ts';

export const CATEGORY = 'temporal-ingest-answer';
export const SURFACES = ['entity', 'context_pack', 'ambient', 'compiled', 'query'] as const;
export type Surface = typeof SURFACES[number];
export const HTTP_ARM = 'http: not run (remote bulk writes not landed)';
const DEV_TEMPLATES: Record<(typeof PHRASING_SETS)[number], PhrasingTemplates> = { A: PHRASING_A, A2: PHRASING_A2, A3: PHRASING_A3 };

type Op = (name: string, params: Record<string, unknown>) => Promise<unknown>;
interface Engine { executeRaw(sql: string, params?: unknown[]): Promise<unknown[]> }
interface Sut { engine: Engine; op: Op; put(slug: string, content: string): Promise<void>; close(): Promise<void> }
export interface E3Row { probe_id: string; kind: string; cluster: string; seed: number; surface: Surface; [field: string]: unknown }

export interface E3Target { person: TePerson; former: Stint; current: Stint; stale: string; corrected: string }

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(name|company|slug|role|prev)\}/g, (_, k: string) => v[k] ?? '');
const short = (slug: string) => slug.split('/').pop()!;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The alias a target page declares: its name without the trailing period of the
 * initial ("Grace K"). Turn-context entity extraction drops that period, so
 * without the alias the ambient path never points at the person at all.
 */
export const aliasFor = (p: TePerson) => p.name.replace(/\.$/, '');

/** The question every query-shaped surface asks. */
export const questionFor = (p: TePerson) => `Where does ${p.name} work now?`;

/** Dated join, move and leave lines for a run of stints, in the generator's timeline grammar. */
function timelineLines(stints: readonly Stint[], t: PhrasingTemplates, link: (slug: string) => string): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  stints.forEach((s, k) => {
    const prev = stints[k - 1];
    if (prev && prev.until === s.from) lines.push([s.from, fill(t.tl_move, { prev: link(prev.company), company: link(s.company), role: s.role })]);
    else lines.push([s.from, fill(t.tl_join, { company: link(s.company), role: s.role })]);
    const next = stints[k + 1];
    if (s.until && !(next && next.from === s.until)) lines.push([s.until, fill(t.tl_leave, { company: link(s.company) })]);
  });
  return lines;
}

/**
 * Split a world into the pages written first and the targets staged stale then
 * corrected. A target has a current stint and at least one former stint; F is
 * the latest former stint, whose company is never the current one.
 */
export function stageWorld(world: TemporalEdgesWorld, t: PhrasingTemplates): { base: TePage[]; targets: E3Target[] } {
  const name = new Map(world.companies.map(c => [c.slug, c.name]));
  const link = (slug: string) => `[${name.get(slug)}](../${slug}.md)`;
  const targets: E3Target[] = [];
  for (const p of world.people) {
    const ci = p.stints.findIndex(s => s.until === null);
    const fi = ci - 1;
    if (ci < 1 || p.stints[fi].company === p.stints[ci].company) continue;
    const former = p.stints[fi], current = p.stints[ci];
    const prose = [fill(t.stale_summary, { name: p.name, company: link(former.company), role: former.role })];
    for (const company of new Set(p.stints.slice(0, fi).map(s => s.company))) {
      if (company !== former.company && company !== current.company) prose.push(fill(t.former, { name: p.name, company: link(company) }));
    }
    const page = (lines: Array<[string, string]>) =>
      `---\ntype: person\ntitle: ${p.name}\naliases: [${aliasFor(p)}]\n---\n\n${prose.join(' ')}\n\n## Timeline\n\n${lines.map(([d, x]) => `- **${d}** | ${x}`).join('\n')}\n`;
    const staleStints = [...p.stints.slice(0, fi), { ...former, until: null }];
    targets.push({
      person: p, former, current,
      stale: page(timelineLines(staleStints, t, link)),
      corrected: page(timelineLines(p.stints.slice(0, ci + 1), t, link)),
    });
  }
  const targetSlugs = new Set(targets.map(x => x.person.slug));
  return { base: world.pages.filter(pg => !targetSlugs.has(pg.slug)), targets };
}

/** The string checks, applied to one surface's text for one target. */
export function checkSurface(text: string, target: Pick<E3Target, 'former' | 'current'>, formerTitle: string): { current_ok: number; ended_ok: number; no_stale_current: number; surface_ok: number } {
  const f = escape(short(target.former.company)), c = escape(short(target.current.company));
  const current_ok = Number(new RegExp(`now: [^;\\]]*works_at ${c}\\b`).test(text));
  const ended_ok = Number(new RegExp(`ended: [^;\\]]*works_at ${f}\\b`).test(text));
  const formerAsNow = new RegExp(`now: [^;\\]]*\\b${f}\\b`).test(text);
  const mentionsFormer = new RegExp(`\\b${f}\\b|\\b${escape(formerTitle)}\\b`).test(text);
  const no_stale_current = Number(!formerAsNow && (ended_ok === 1 || !mentionsFormer));
  return { current_ok, ended_ok, no_stale_current, surface_ok: Number(current_ok && ended_ok && no_stale_current) };
}

/** The ambient line that points at `slug`, or '' when the turn context did not surface it. */
export function ambientLine(text: string, slug: string): string {
  return text.split('\n').find(l => l.includes(`\`${slug}\``)) ?? '';
}

/** The compiled-context entry block for `slug`, or '' when the file has no entry for it. */
export function compiledEntry(text: string, slug: string): string {
  return text.split(/\n\n(?=## )/).find(b => b.startsWith('## ') && b.split('\n')[0].endsWith(`(brain://${slug})`)) ?? '';
}

async function openSut(gut: GbrainUnderTest): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine & { connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>; readPageSnapshot(slug: string, o: { sourceId: string }): Promise<{ revision: unknown } | null> } }>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown> }> }>(gut, 'src/core/operations.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
  const byName = new Map(operations.map(o => [o.name, o]));
  const op: Op = async (name, params) => {
    const o = byName.get(name);
    if (!o) throw new MissingSurface(`gbrain has no operation ${name}`);
    return await o.handler(ctx, params);
  };
  return {
    engine, op,
    put: async (slug, content) => {
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await op('put_page', { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
    },
    close: () => engine.disconnect(),
  };
}

class MissingSurface extends Error {}

interface SurfaceRead { text: string; exploratory?: Record<string, number> }
type SurfaceReader = (t: E3Target) => Promise<SurfaceRead>;

/** One reader per surface; a build without the surface's entry point gets a reader that throws MissingSurface. */
async function surfaceReaders(gut: GbrainUnderTest, sut: Sut): Promise<Record<Surface, SurfaceReader>> {
  const optional = async <T>(subpath: string, name: string): Promise<T | null> => {
    try { return ((await importGbrain<Record<string, unknown>>(gut, subpath))[name] as T | undefined) ?? null; } catch { return null; }
  };
  const assembleTurnContext = await optional<(e: Engine, o: Record<string, unknown>) => Promise<{ text: string }>>('src/core/context/turn-context.ts', 'assembleTurnContext');
  const compileView = await optional<(i: Record<string, unknown>) => Promise<{ text: string }>>('src/core/context/compile-view.ts', 'compileView');
  let compiled: Promise<string> | null = null;
  return {
    entity: async t => ({ text: JSON.stringify(await sut.op('entity', { name: t.person.slug })) }),
    context_pack: async t => ({ text: JSON.stringify(await sut.op('context_pack', { entities: t.person.slug })) }),
    ambient: async t => {
      if (!assembleTurnContext) throw new MissingSurface('no assembleTurnContext in src/core/context/turn-context.ts');
      const r = await assembleTurnContext(sut.engine, { sourceId: 'default', window: [{ role: 'user', text: questionFor(t.person) }] });
      return { text: ambientLine(r.text, t.person.slug) };
    },
    compiled: async t => {
      if (!compileView) throw new MissingSurface('no compileView in src/core/context/compile-view.ts');
      compiled ??= compileView({
        engine: sut.engine, sourceId: 'default', target: 'agents', budget: 10_000_000,
        scanConfig: { allowlist: [], blocklistRe: null, patterns: [] },
      }).then(r => r.text);
      return { text: compiledEntry(await compiled, t.person.slug) };
    },
    query: async t => {
      const results = await sut.op('query', { query: questionFor(t.person) }) as Array<Record<string, unknown>>;
      return queryRead(results, t);
    },
  };
}

/**
 * The query rows about this person: its own page's chunks and the rows the
 * relationship arm reached from it. Exploratory: whether that arm returned the
 * current and the former employer (it carries no status, so neither is a check).
 */
export function queryRead(results: ReadonlyArray<Record<string, unknown>>, t: Pick<E3Target, 'person' | 'former' | 'current'>): SurfaceRead {
  const slug = t.person.slug;
  const own = results.filter(r => r.slug === slug || r.relational_seed === slug);
  const reached = (company: string) => Number(own.some(r => r.relational_seed === slug && r.slug === company));
  return { text: JSON.stringify(own), exploratory: { relational_current: reached(t.current.company), relational_former: reached(t.former.company) } };
}

export interface E3RunResult { worlds: TemporalEdgesWorld[]; rows: E3Row[]; acc: ProbeAccounting; harnessError: string | null; samples: Array<{ seed: number; person: string; surface: Surface; text: string }> }

export async function runTemporalIngestAnswer(opts: {
  gut: GbrainUnderTest; seeds?: readonly number[]; log?: (s: string) => void; phrasing?: string;
  sealedPhrasing?: { id: string; templates: PhrasingTemplates }; sample?: boolean;
}): Promise<E3RunResult> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const devPhrasing = (opts.phrasing ?? 'A') as (typeof PHRASING_SETS)[number];
    const templates = opts.sealedPhrasing ? validatePhrasing(opts.sealedPhrasing.templates) : DEV_TEMPLATES[devPhrasing];
    const worlds = (opts.seeds ?? DEV_SEEDS).map(seed => generateTemporalEdgesWorld({ seed, phrasing: opts.sealedPhrasing ? undefined : devPhrasing, sealedPhrasing: opts.sealedPhrasing }));
    const acc = new ProbeAccounting(0);
    const rows: E3Row[] = [];
    const samples: E3RunResult['samples'] = [];
    let harnessError: string | null = null;
    for (const world of worlds) {
      const seed = world.seed;
      const sut = await openSut(opts.gut);
      try {
        const { base, targets } = stageWorld(world, templates);
        log(`seed ${seed}: ${base.length} pages written first, ${targets.length} people staged stale then corrected`);
        for (const p of base) await sut.put(p.slug, p.content);
        for (const t of targets) await sut.put(t.person.slug, t.stale);
        for (const t of targets) await sut.put(t.person.slug, t.corrected);
        const readers = await surfaceReaders(opts.gut, sut);
        const title = new Map(world.companies.map(c => [c.slug, c.name]));
        for (const t of targets) {
          for (const surface of SURFACES) {
            const probe_id = `s${seed}:${surface}:${t.person.slug}`;
            const head = { probe_id, kind: 'correction', cluster: `s${seed}:${t.person.slug}`, seed, surface };
            try {
              const { text, exploratory } = await readers[surface](t);
              if (opts.sample && samples.length < SURFACES.length) samples.push({ seed, person: t.person.slug, surface, text });
              const m = checkSurface(text, t, title.get(t.former.company)!);
              rows.push({ ...head, ...m, ...exploratory, ...(text && text !== '[]' ? {} : { reason: `${surface} output has no entry for this person` }) });
              acc.score(probe_id, m.surface_ok);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              if (e instanceof MissingSurface) {
                rows.push({ ...head, current_ok: 0, ended_ok: 0, no_stale_current: 0, surface_ok: 0, reason: `surface not in this build: ${message}` });
                acc.score(probe_id, 0);
              } else {
                acc.error(probe_id, 'sut', message);
                rows.push({ ...head, current_ok: 0, ended_ok: 0, no_stale_current: 0, surface_ok: 0, error: message, error_origin: 'sut' });
              }
            }
          }
        }
      } catch (e) {
        harnessError = `seed ${seed}: ${e instanceof Error ? e.message : String(e)}`;
        acc.error(`s${seed}:seed`, 'harness', harnessError);
      } finally {
        await sut.close().catch(() => {});
      }
    }
    const planned = new ProbeAccounting(rows.length);
    planned.absorb(acc.toJSON());
    return { worlds, rows, acc: planned, harnessError, samples };
  });
}

export const EXPLORATORY = ['relational_current', 'relational_former'] as const;
export interface SurfaceSummary {
  n: number; errors: number; missing_surface: number; no_entry: number;
  current_ok: number; ended_ok: number; no_stale_current: number; surface_ok: number;
  exploratory?: Partial<Record<(typeof EXPLORATORY)[number], number>>;
}

/** Per-surface counts and means of each metric (exploratory query fields kept apart). */
export function summarize(rows: readonly E3Row[]): Partial<Record<Surface, SurfaceSummary>> {
  const out: Partial<Record<Surface, SurfaceSummary>> = {};
  for (const surface of SURFACES) {
    const rs = rows.filter(r => r.surface === surface);
    if (!rs.length) continue;
    const mean = (k: string) => rs.reduce((a, r) => a + Number(r[k] ?? 0), 0) / rs.length;
    const exploratory = EXPLORATORY.filter(k => rs.some(r => typeof r[k] === 'number'));
    out[surface] = {
      n: rs.length,
      errors: rs.filter(r => r.error).length,
      missing_surface: rs.filter(r => String(r.reason ?? '').startsWith('surface not in this build')).length,
      no_entry: rs.filter(r => String(r.reason ?? '').endsWith('has no entry for this person')).length,
      current_ok: mean('current_ok'), ended_ok: mean('ended_ok'), no_stale_current: mean('no_stale_current'), surface_ok: mean('surface_ok'),
      ...(exploratory.length ? { exploratory: Object.fromEntries(exploratory.map(k => [k, mean(k)])) } : {}),
    };
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
  const sample = argv.includes('--print-sample');
  let sealedPhrasing: { id: string; templates: PhrasingTemplates } | undefined;
  let phrasingSha: string | null = null;
  if (phrasingFile) {
    if (sample) throw new Error('--print-sample prints surface text and is refused in custodian mode');
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
  const devPhrasing = argValue(argv, '--phrasing') ?? 'A';
  if (!sealedPhrasing && !(PHRASING_SETS as readonly string[]).includes(devPhrasing)) {
    throw new Error(`phrasing set ${devPhrasing} is held out: development runs take ${PHRASING_SETS.join(', ')}; held-out phrasing reaches this runner only through --phrasing-file`);
  }
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# temporal-ingest-answer (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  const r = await runTemporalIngestAnswer({ gut, seeds, log, phrasing: devPhrasing, sealedPhrasing, sample });
  const a = r.acc.summary();
  const summary = summarize(r.rows);
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, keyword search, operation handlers and context assembly only; no model and no paid request'),
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
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default } (stdio-equivalent trusted local caller)',
      transports: { stdio: 'operation handlers in process', http: HTTP_ARM },
      gate: 'report-only',
      seeds, phrasing: sealedPhrasing ? `held-out set ${sealedPhrasing.id} (custody file sha256 ${phrasingSha})` : `${devPhrasing} (development)`, generator_version: TEMPORAL_EDGES_GENERATOR_VERSION,
      staging: 'companies and non-target people written first; each target (former and current employer in the ledger) written stale (stale_summary names the latest former employer, timeline stops at joining it), then corrected through put_page with expected_revision (same prose plus dated tl_move or tl_leave + tl_join lines)',
      surfaces: {
        entity: 'operation entity { name: <person slug> }, whole response',
        context_pack: 'operation context_pack { entities: <person slug> }, whole response',
        ambient: 'assembleTurnContext(engine, { sourceId: default, window: [user: "Where does <name> work now?"] }) turn mode, the line pointing at the person',
        compiled: 'compileView({ sourceId: default, budget: 10000000, empty scan config }), the person\'s entry block',
        query: 'operation query { query: "Where does <name> work now?" }, whole response',
      },
      checks: 'current_ok: "now: ... works_at <current>"; ended_ok: "ended: ... works_at <former>"; no_stale_current: no "now:" clause names the former employer and the text flags it ended or never mentions it; surface_ok: all three',
      oracle: 'employment stints from the generator ledger',
      gbrain_overlay: overlaySummary(gut),
    },
    hashes: Object.fromEntries(r.worlds.map(w => [`ledger_seed_${w.seed}`, w.fingerprint])),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { summary, rows: r.rows, harness_error: r.harnessError, http: HTTP_ARM },
  } as Receipt;
  writeReceipt(outPath, receipt);
  if (sample) for (const s of r.samples) log(`\n--- sample seed ${s.seed} ${s.person} ${s.surface} ---\n${s.text.slice(0, 2000)}`);
  log('\n| surface | n | current_ok | ended_ok | no_stale_current | surface_ok | no entry | errors | missing |\n|---|---|---|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(summary)) log(`| ${k} | ${v.n} | ${v.current_ok.toFixed(3)} | ${v.ended_ok.toFixed(3)} | ${v.no_stale_current.toFixed(3)} | ${v.surface_ok.toFixed(3)} | ${v.no_entry} | ${v.errors} | ${v.missing_surface} |`);
  for (const [k, v] of Object.entries(summary)) if (v.exploratory) log(`${k} exploratory: ${Object.entries(v.exploratory).map(([e, x]) => `${e} ${x.toFixed(3)}`).join(', ')}`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
