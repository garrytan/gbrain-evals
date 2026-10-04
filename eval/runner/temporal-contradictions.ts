/**
 * Temporal typed edges (P1, E2): does the dream `edge_contradictions` phase close
 * superseded employment correctly when the notes only say when each job started?
 *
 * The ledger comes from eval/generators/temporal-edges-gen.ts (same people and
 * stints as E1). Person pages are re-rendered with only dated "joined" timeline
 * lines (no leave or move lines, no frontmatter, no prose about employment), in
 * three sub-ledgers chosen by a hash of the person slug:
 *   dated         join lines in date order
 *   out_of_order  the same join lines in shuffled page order
 *   undated       no timeline; one undated present-tense prose line per employer,
 *                 so competing relationships have no start date
 * Arms per seed, each on a fresh in-memory PGLite brain:
 *   e1      the build as written, phase not run (the E1 arm on this ledger)
 *   <model> `dream.edge_contradictions.mode=apply` with `models.dream.edge_contradictions=<model>`,
 *           one phase run, repeated --runs times per model
 * Metrics per model run (custodian interpretations, fixed before any held-out run):
 *   wrong_closure_rate  applied closures whose person, per the ledger, still worked at the
 *                       ended employer on the close date, over applied closures (0 when none)
 *   late_closures       applied closures dated after the ledger's end of that job (reported)
 *   asof_exact          get_links(person, works_at, as_of) equals the ledger's employers, over
 *                       the dated and out-of-order people; compared with the e1 arm
 *   undated_closures    proposals on undated people that would close a relationship
 *                       (status proposed or applied); the gate needs 0 (judge-compatible pairs
 *                       are not closures and are reported)
 * Certification per model (preregistered): wrong closures <= 1% in every run, as-of at least
 * +0.10 over the e1 arm in every run, and 0 undated closures.
 *
 * Paid: the judge model is called through gbrain's own gateway; the run joins the eval budget
 * ledger (--paid --budget-usd N | --budget-run-id ID).
 *
 * Usage (dev): bun eval/runner/temporal-contradictions.ts --gbrain <checkout>@<sha> --models anthropic:claude-haiku-4-5
 *   [--runs 3] [--seeds 3,5] [--phrasing A|A2|A3] --output <dir> --paid --budget-usd N
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>,
 * exactly as temporal-edges.ts.
 */
import './budget-ledger.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { appendAccessLog } from './sealed-confirmation-lib.ts';
import {
  DEV_SEEDS, PHRASING_A, PHRASING_A2, PHRASING_A3, TEMPORAL_EDGES_GENERATOR_VERSION, employersAt, generateTemporalEdgesWorld, validatePhrasing,
  type PhrasingTemplates, type TePerson, type TemporalEdgesWorld,
} from '../generators/temporal-edges-gen.ts';

export type SubLedger = 'dated' | 'out_of_order' | 'undated';
const hashInt = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
export const subLedgerOf = (slug: string): SubLedger => { const k = hashInt(`e2:${slug}`) % 6; return k === 0 ? 'undated' : k <= 2 ? 'out_of_order' : 'dated'; };
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(name|company|slug|role|prev)\}/g, (_, k: string) => v[k] ?? '');

/** E2 page for one person: dated join lines only (or undated prose), per sub-ledger. */
export function renderE2Person(p: TePerson, companyName: (slug: string) => string, t: PhrasingTemplates): string {
  const link = (slug: string) => `[${companyName(slug)}](../${slug}.md)`;
  const kind = subLedgerOf(p.slug);
  const head = `---\ntype: person\ntitle: ${p.name}\n---\n\n`;
  if (kind === 'undated') {
    const seen = new Set<string>();
    const prose = p.stints.filter(s => !seen.has(s.company) && seen.add(s.company)).map(s => fill(t.current, { name: p.name, company: link(s.company), role: s.role }));
    return `${head}${prose.join(' ')}\n`;
  }
  const lines: Array<[string, string]> = p.stints.map(s => [s.from, fill(t.tl_join, { company: link(s.company), role: s.role })]);
  if (p.advises) lines.push([p.advises.from, fill(t.tl_advise, { company: link(p.advises.company) })]);
  lines.sort((a, b) => a[0].localeCompare(b[0]));
  if (kind === 'out_of_order') lines.sort((a, b) => hashInt(`${p.slug}:${a[0]}:${a[1]}`) - hashInt(`${p.slug}:${b[0]}:${b[1]}`));
  return `${head}${p.name}.\n\n## Timeline\n\n${lines.map(([d, x]) => `- **${d}** | ${x}`).join('\n')}\n`;
}

export interface Closure { person: string; ending: string; close_date: string; status: string }
/** Wrong: the ledger says the person still worked at the ended employer on the close date. Late: dated after that job ended. */
export function judgeClosure(p: TePerson, c: Closure): { wrong: boolean; late: boolean } {
  const wrong = employersAt(p, c.close_date).includes(c.ending);
  const lastEnd = p.stints.filter(s => s.company === c.ending && s.from < c.close_date && s.until !== null).map(s => s.until!).sort().pop();
  return { wrong, late: !wrong && lastEnd !== undefined && lastEnd < c.close_date };
}

interface Brain {
  engine: { setConfig(k: string, v: string): Promise<void>; executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]>; disconnect(): Promise<void> };
  op(name: string, params: Record<string, unknown>): Promise<unknown>;
}

async function openBrain(gut: GbrainUnderTest, world: TemporalEdgesWorld, t: PhrasingTemplates): Promise<Brain> {
  const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<any>(gut, 'src/core/operations.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default' };
  const byName = new Map<string, any>(operations.map((o: any) => [o.name, o]));
  const op = async (name: string, params: Record<string, unknown>) => {
    const o = byName.get(name);
    if (!o) throw new Error(`gbrain has no operation ${name}`);
    return await o.handler(ctx, params);
  };
  const name = (slug: string) => world.companies.find(c => c.slug === slug)!.name;
  for (const c of world.companies) await op('put_page', { slug: c.slug, content: `---\ntype: company\ntitle: ${c.name}\n---\n\n${c.name} is a company.\n` });
  const order = [...world.people].sort((a, b) => hashInt(`order:${world.seed}:${a.slug}`) - hashInt(`order:${world.seed}:${b.slug}`));
  for (const p of order) await op('put_page', { slug: p.slug, content: renderE2Person(p, name, t) });
  return { engine, op };
}

async function asofExact(brain: Brain, world: TemporalEdgesWorld): Promise<{ n: number; exact: number }> {
  let n = 0, exact = 0;
  for (const a of world.asof_probes) {
    if (subLedgerOf(a.person) === 'undated') continue;
    const rows = await brain.op('get_links', { slug: a.person, link_type: 'works_at', as_of: a.date }) as Array<Record<string, unknown>>;
    const got = new Set(rows.filter(r => r.link_type === 'works_at').map(r => String(r.to_slug)));
    n++;
    if (got.size === a.gold.length && a.gold.every(g => got.has(g))) exact++;
  }
  return { n, exact };
}

export interface ModelRun {
  model: string; run: number; seed: number; phase_status: string; phase_detail: string; totals: Record<string, number>;
  applied: number; wrong: number; late: number; undated_closures: number; statuses: Record<string, number>;
  asof_n: number; asof_exact: number; error?: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const output = resolve(one('--output') ?? 'eval/reports/temporal-contradictions');
  const models = (one('--models') ?? 'anthropic:claude-haiku-4-5').split(',');
  const runs = Number(one('--runs') ?? 3);
  const seeds = (one('--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  mkdirSync(output, { recursive: true });

  const phrasingFile = one('--phrasing-file');
  let sealed: { id: string; templates: PhrasingTemplates } | undefined;
  let phrasingSha: string | null = null;
  if (phrasingFile) {
    const decisionId = one('--decision-id'), purpose = one('--purpose');
    if (!decisionId || !purpose) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before the phrasing file is read');
    const bytes = readFileSync(phrasingFile);
    phrasingSha = createHash('sha256').update(bytes).digest('hex');
    appendAccessLog(join(dirname(phrasingFile), 'access-log.jsonl'), { action: 'open', purpose, decision_id: decisionId, labels_sha256: phrasingSha, run_sha256: null });
    const parsed = JSON.parse(bytes.toString('utf8'));
    sealed = { id: parsed.id, templates: validatePhrasing(parsed.templates) };
  } else if (seeds.some(s => !(DEV_SEEDS as readonly number[]).includes(s))) {
    throw new Error(`only dev seeds ${DEV_SEEDS.join(', ')} run here; held-out seeds belong to the custodian`);
  }
  const devPhrasing = one('--phrasing') ?? 'A';
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const keys = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  const paid = startPaidRun('temporal-contradictions', { ...budgetOptionsFrom(argv), estimateUsd: 0.3 * models.length * runs });

  const result = await withHermeticEnv('temporal-contradictions', async () => {
    Object.assign(process.env, keys);
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { runPhaseEdgeContradictions } = await importGbrain<any>(gut, 'src/core/cycle/edge-contradictions.ts');
    const worlds = seeds.map(seed => generateTemporalEdgesWorld({ seed, phrasing: sealed ? undefined : devPhrasing, sealedPhrasing: sealed }));
    const e1: Array<{ seed: number; asof_n: number; asof_exact: number }> = [];
    const modelRuns: ModelRun[] = [];
    for (const world of worlds) {
      const t = sealed ? sealed.templates : DEV_TEMPLATES[devPhrasing as keyof typeof DEV_TEMPLATES];
      if (!t) throw new Error(`unknown development phrasing ${devPhrasing}`);
      const base = await openBrain(gut, world, t);
      const a = await asofExact(base, world);
      e1.push({ seed: world.seed, asof_n: a.n, asof_exact: a.exact });
      await base.engine.disconnect();
      for (const model of models) for (let run = 1; run <= runs; run++) {
        gateway.configureGateway({ chat_model: model, env: { ...keys } });
        const brain = await openBrain(gut, world, t);
        const row: ModelRun = { model, run, seed: world.seed, phase_status: '', phase_detail: '', totals: {}, applied: 0, wrong: 0, late: 0, undated_closures: 0, statuses: {}, asof_n: 0, asof_exact: 0 };
        try {
          await brain.engine.setConfig('dream.edge_contradictions.mode', 'apply');
          await brain.engine.setConfig('models.dream.edge_contradictions', model);
          await brain.engine.setConfig('dream.edge_contradictions.max_subjects', '1000');
          await brain.engine.setConfig('dream.edge_contradictions.max_usd', '10');
          const r = await runPhaseEdgeContradictions(brain.engine);
          row.phase_status = r.status; row.phase_detail = r.detail; row.totals = r.totals ?? {};
          const props = await brain.engine.executeRaw<{ person: string; ending: string | null; close_date: string | null; status: string }>(
            `SELECT f.slug AS person, t.slug AS ending, p.close_date::text AS close_date, p.status
               FROM link_edge_proposals p JOIN pages f ON f.id = p.from_page_id LEFT JOIN pages t ON t.id = p.ending_to_page_id
              WHERE p.link_type = 'works_at'`);
          for (const p of props) {
            row.statuses[p.status] = (row.statuses[p.status] ?? 0) + 1;
            const person = world.people.find(x => x.slug === p.person);
            if (!person) continue;
            if (subLedgerOf(person.slug) === 'undated' && (p.status === 'proposed' || p.status === 'applied')) row.undated_closures++;
            if (p.status !== 'applied' || !p.ending || !p.close_date) continue;
            row.applied++;
            const j = judgeClosure(person, { person: p.person, ending: p.ending, close_date: p.close_date.slice(0, 10), status: p.status });
            if (j.wrong) row.wrong++;
            if (j.late) row.late++;
          }
          const a2 = await asofExact(brain, world);
          row.asof_n = a2.n; row.asof_exact = a2.exact;
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e);
        } finally {
          await brain.engine.disconnect().catch(() => {});
        }
        modelRuns.push(row);
        process.stderr.write(`[e2] seed ${world.seed} ${model} run ${run}: ${row.phase_status} applied ${row.applied}, wrong ${row.wrong}, as-of ${row.asof_exact}/${row.asof_n}${row.error ? `, error ${row.error}` : ''}\n`);
      }
    }
    return { e1, modelRuns };
  });

  const e1Rate = result.e1.reduce((s, r) => s + r.asof_exact, 0) / Math.max(1, result.e1.reduce((s, r) => s + r.asof_n, 0));
  const certification: Record<string, unknown> = {};
  for (const model of models) {
    const perRun = Array.from({ length: runs }, (_, i) => {
      const rs = result.modelRuns.filter(r => r.model === model && r.run === i + 1);
      const applied = rs.reduce((s, r) => s + r.applied, 0), wrong = rs.reduce((s, r) => s + r.wrong, 0);
      const asof = rs.reduce((s, r) => s + r.asof_exact, 0) / Math.max(1, rs.reduce((s, r) => s + r.asof_n, 0));
      return { run: i + 1, applied, wrong, late: rs.reduce((s, r) => s + r.late, 0), wrong_closure_rate: applied ? wrong / applied : 0,
        asof_exact: asof, asof_delta_vs_e1: asof - e1Rate, undated_closures: rs.reduce((s, r) => s + r.undated_closures, 0),
        judge_errors: rs.reduce((s, r) => s + (r.totals.errors ?? 0), 0), harness_errors: rs.filter(r => r.error).length };
    });
    const valid = perRun.every(r => r.harness_errors === 0);
    certification[model] = {
      certified: valid && perRun.every(r => r.wrong_closure_rate <= 0.01 && r.asof_delta_vs_e1 >= 0.10 && r.undated_closures === 0),
      status: valid ? undefined : 'invalid: harness errors void this model', runs: perRun,
    };
  }
  const costSummary = paid.run.close();
  paid.guard.uninstall();
  const out = {
    category: 'temporal-contradictions', generator_version: TEMPORAL_EDGES_GENERATOR_VERSION, gbrain: gut.overlay?.build.commit ?? gut.version, seeds, runs, models,
    phrasing: sealed ? `held-out set ${sealed.id} (custody file sha256 ${phrasingSha})` : `${devPhrasing} (development)`,
    e1_asof_exact: e1Rate, e1: result.e1, certification, model_runs: result.modelRuns, cost: receiptCost(costSummary),
  };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ e1_asof_exact: e1Rate, certification }, null, 2));
}

const DEV_TEMPLATES = { A: PHRASING_A, A2: PHRASING_A2, A3: PHRASING_A3 } as const;

if (import.meta.main) await main();
