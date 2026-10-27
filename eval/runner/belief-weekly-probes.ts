/**
 * W11: sealed confirmation of gbrain W4 (weekly cited belief diff: `delta {beliefs: true}`, `gbrain beliefs changes`).
 *
 * This runs gbrain's own W4 acceptance probe (`test/belief-ledger-weekly-probes.test.ts`, gbrain #6866, v0.60.273.0) on
 * the build under test, with the generator from eval/generators/belief-weekly-gen.ts so that a custodian can supply a
 * fresh seed and fresh phrasing for every belief-changing line. Each seed gets a fresh activated managed brain on
 * in-memory PGLite (gbrain's own test helper), written through put_page; each week's belief diff comes from
 * beliefChanges over a recorded-time window, as in the probe.
 *
 * Checks, all deterministic (no model is called; the hermetic environment strips provider keys):
 *   set-F1           (kind, page, belief, change) reported against the generator's gold, link transitions excluded,
 *                    pooled over a seed's four weeks; W4's bar is >= 0.95
 *   before/after     every gold re-score (fact confidence, take weight) is reported as changed with its exact before
 *                    and after values, and nothing else is reported as re-scored
 *   cause            every reported change names op put_page (the only writer here) and the event type of the ledger
 *                    event its evidence points at
 *   evidence pointer every reported change's evidence names a ledger event of this source, on the change's page,
 *                    recorded inside the week, at the recorded_at it states
 *   tokens           the belief diff's tokens beside delta's page list for the same week (reported, never gated)
 *
 * Usage (dev): bun eval/runner/belief-weekly-probes.ts --gbrain <checkout>@<ref> [--seeds 20261016] --output <dir>
 * Custodian (held-out): --phrasing-file <custody file { id, templates }> --decision-id <id> --purpose <text>
 *   --seeds <fresh seeds> --output <custody dir> --work <custody dir> --preregistration <path>
 * The receipt stays in --output; verdict.json beside it is the aggregate the custodian publishes. Neither carries
 * a line of the phrasing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { attestPreregistration } from './prereg.ts';
import { custodyTemplatesInput } from './sealed-confirmation-lib.ts';
import {
  BELIEF_WEEKLY_GENERATOR_VERSION, DEV_SEEDS, OPS_PER_WEEK, PHRASING_W4, WEEKS, generateWeeklyWorld, titleOf, validateWeeklyPhrasing, weeklyGold,
  type PageState, type WeeklyGold,
} from '../generators/belief-weekly-gen.ts';

export const F1_BAR = 0.95;

/** The parts of a gbrain BeliefChange the checks read. */
export interface ChangeLike {
  kind: string; slug: string; change: string; subject: Record<string, unknown>;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  cause: { event: string; op: string | null };
  evidence: { event_id: number; recorded_at: string; slug: string };
}
/** The parts of a belief_events row the checks read. */
export interface EventLike { id: number; slug: string; event_type: string; recorded_at: string | Date }

export interface WeekScore {
  gold: number; reported: number; tp: number; fp: number; fn: number;
  rescored_gold: number; rescored_exact: number; rescored_wrong_or_missing: number; rescored_extra: number;
  checked: number; cause_ok: number; evidence_ok: number;
}

const iso = (t: string | Date) => new Date(t).toISOString();
export const changeKey = (c: ChangeLike) => {
  const belief = c.kind === 'page' ? '' : c.kind === 'link' ? String(c.subject.to) : String(c.subject.claim);
  return `${c.kind}|${c.slug}|${belief}|${c.change}`;
};

/** One week's checks: the reported diff against gold, and each reported change's cause and evidence against the ledger. */
export function scoreWeek(gold: WeeklyGold, changes: readonly ChangeLike[], events: readonly EventLike[], window: { since: string; until: string }): WeekScore {
  const scored = changes.filter(c => c.kind !== 'link_transition');
  const got = new Set(scored.map(changeKey));
  const tp = [...got].filter(k => gold.set.has(k)).length;
  const rescored = new Map(scored.filter(c => c.change === 'changed' && (c.kind === 'fact' || c.kind === 'take')).map(c => {
    const field = c.kind === 'fact' ? 'confidence' : 'weight';
    return [`${c.kind}|${c.slug}|${c.subject.claim}`, [Number(c.before?.[field]), Number(c.after?.[field])] as const];
  }));
  let exact = 0;
  for (const [k, [b, a]] of gold.values) { const r = rescored.get(k); if (r && r[0] === Number(b) && r[1] === Number(a)) exact++; }
  const byId = new Map(events.map(e => [Number(e.id), e]));
  const since = Date.parse(window.since), until = Date.parse(window.until);
  let causeOk = 0, evidenceOk = 0;
  for (const c of scored) {
    const ev = byId.get(Number(c.evidence.event_id));
    if (c.cause.op === 'put_page' && ev && c.cause.event === ev.event_type) causeOk++;
    const at = ev ? Date.parse(iso(ev.recorded_at)) : NaN;
    if (ev && ev.slug === c.evidence.slug && c.evidence.slug === c.slug && iso(ev.recorded_at) === c.evidence.recorded_at && at >= since && at <= until) evidenceOk++;
  }
  return {
    gold: gold.set.size, reported: got.size, tp, fp: got.size - tp, fn: gold.set.size - tp,
    rescored_gold: gold.values.size, rescored_exact: exact, rescored_wrong_or_missing: gold.values.size - exact,
    rescored_extra: [...rescored.keys()].filter(k => !gold.values.has(k)).length,
    checked: scored.length, cause_ok: causeOk, evidence_ok: evidenceOk,
  };
}

export interface SeedResult {
  seed: number; weeks: Array<WeekScore & { page_list_pages: number; page_list_tokens: number; belief_diff_tokens: number }>;
  f1: number; precision: number; recall: number; error?: string;
}

const sum = (xs: readonly WeekScore[], k: keyof WeekScore) => xs.reduce((s, w) => s + w[k], 0);
export function f1Of(weeks: readonly WeekScore[]) {
  const tp = sum(weeks, 'tp'), fp = sum(weeks, 'fp'), fn = sum(weeks, 'fn');
  const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
  return { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

/** The preregistered gates over every seed. A seed with a harness error makes the run invalid, never a pass. */
export function gatesOf(seeds: readonly SeedResult[]) {
  const weeks = seeds.flatMap(s => s.weeks);
  const valid = seeds.length > 0 && seeds.every(s => !s.error);
  const gates = {
    set_f1: { rule: `set-F1 >= ${F1_BAR} for every seed (four weeks pooled)`, by_seed: Object.fromEntries(seeds.map(s => [String(s.seed), Number(s.f1.toFixed(4))])), pass: valid && seeds.every(s => s.f1 >= F1_BAR) },
    before_after: { rule: 'every gold re-score reported as changed with its exact before and after, and no other re-score reported', gold: sum(weeks, 'rescored_gold'), exact: sum(weeks, 'rescored_exact'),
      wrong_or_missing: sum(weeks, 'rescored_wrong_or_missing'), extra: sum(weeks, 'rescored_extra'), pass: valid && sum(weeks, 'rescored_wrong_or_missing') === 0 && sum(weeks, 'rescored_extra') === 0 },
    cause: { rule: 'every reported change names op put_page and the event type of the ledger event its evidence points at', checked: sum(weeks, 'checked'), correct: sum(weeks, 'cause_ok'), pass: valid && sum(weeks, 'cause_ok') === sum(weeks, 'checked') },
    evidence_pointer: { rule: 'every reported change points at a ledger event on its page, recorded inside the week at the stated time', checked: sum(weeks, 'checked'), correct: sum(weeks, 'evidence_ok'), pass: valid && sum(weeks, 'evidence_ok') === sum(weeks, 'checked') },
  };
  const pass = Object.values(gates).every(g => g.pass);
  return { valid, pass, gates };
}

function argOf(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main() {
  const argv = process.argv.slice(2);
  const seeds = (argOf(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(s => Number(s.trim()));
  if (!seeds.length || seeds.some(s => !Number.isSafeInteger(s) || s < 0)) throw new Error('--seeds needs a comma-separated list of non-negative integers');
  const work = argOf(argv, '--work');
  if (argOf(argv, '--phrasing-file') && work) { mkdirSync(resolve(work), { recursive: true }); process.env.TMPDIR = resolve(work); }
  const custody = custodyTemplatesInput(argv, seeds, DEV_SEEDS, { needsWork: true });
  if (custody && seeds.some(s => (DEV_SEEDS as readonly number[]).includes(s))) throw new Error(`dev seed ${DEV_SEEDS.join(', ')} is not held-out material; the custodian picks fresh seeds`);
  const phrasing = custody ? validateWeeklyPhrasing(custody.parsed.templates) : PHRASING_W4;
  const outArg = argOf(argv, '--output');
  if (!custody && !outArg) throw new Error('--output <dir> is required');
  const output = custody ? custody.roots.output : resolve(outArg!);
  mkdirSync(output, { recursive: true });
  const preregistration = argOf(argv, '--preregistration');
  if (custody && !preregistration) throw new Error('custodian mode needs --preregistration <path>, attested before the first page is written');
  const attestation = preregistration ? attestPreregistration(preregistration) : null;
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const worlds = seeds.map(seed => generateWeeklyWorld(seed, phrasing));
  const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dir, encoding: 'utf8' }).trim();

  const results = await withHermeticEnv('belief-weekly-probes', async () => {
    const { beliefBrain, beliefPage } = await importGbrain<any>(gut, 'test/helpers/belief-ledger.ts');
    const { beliefChanges, renderBeliefChange } = await importGbrain<any>(gut, 'src/core/belief/changes.ts');
    const { operationsByName } = await importGbrain<any>(gut, 'src/core/operations.ts');
    const { estimateTokens } = await importGbrain<any>(gut, 'src/core/search/token-budget.ts');
    const render = (slug: string, p: PageState) => beliefPage({ title: titleOf(slug), facts: [...p.facts].map(([claim, confidence]) => ({ claim, confidence })),
      takes: [...p.takes].map(([claim, weight]) => ({ claim, weight })), links: [...p.links] });
    const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
    const out: SeedResult[] = [];
    for (const world of worlds) {
      const row: SeedResult = { seed: world.seed, weeks: [], f1: 0, precision: 0, recall: 0 };
      try {
        await beliefBrain(async (b: any) => {
          const at = async () => { await pause(25); const t = iso((await b.engine.executeRaw('SELECT clock_timestamp() AS t'))[0].t); await pause(25); return t; };
          for (const w of world.initial) await b.put(w.slug, render(w.slug, w.state));
          for (const week of world.weeks) {
            const since = await at();
            for (const w of week.writes) await b.put(w.slug, render(w.slug, w.state));
            const until = await at();
            const diff = await beliefChanges(b.engine, { sourceId: b.sourceId, since, until, remote: false, limit: 10_000 });
            const score = scoreWeek(weeklyGold(week.start, week.end), diff.changes, await b.events(), { since, until });
            await pause(2_200);
            const delta = await operationsByName.delta.handler(b.ctx, { since });
            row.weeks.push({ ...score, page_list_pages: delta.pages.length, page_list_tokens: estimateTokens(delta.text),
              belief_diff_tokens: estimateTokens(diff.changes.map(renderBeliefChange).join('\n')) });
          }
        }, { managed: true });
        Object.assign(row, f1Of(row.weeks));
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      out.push(row);
      process.stderr.write(`[belief-weekly] seed ${world.seed}: f1 ${row.f1.toFixed(4)}${row.error ? `, error ${row.error}` : ''}\n`);
    }
    return out;
  });

  const { valid, pass, gates } = gatesOf(results);
  const build = gut.overlay?.build.commit ?? null;
  const material = custody ? `phrasing set ${custody.parsed.id} (custody file sha256 ${custody.sha256})` : 'development phrasing W4 (the probe\'s own lines)';
  const tokens = results.map(s => ({ seed: s.seed, weeks: s.weeks.map(w => ({ page_list_pages: w.page_list_pages, page_list_tokens: w.page_list_tokens, belief_diff_tokens: w.belief_diff_tokens })) }));
  const verdict = {
    decision_id: argOf(argv, '--decision-id') ?? null,
    stage: custody ? 'held-out' : 'development',
    preregistration: attestation ? `${attestation.preregistration} (gbrain-evals ${attestation.preregistration_commit})` : null,
    verdict: !valid ? 'invalid: a harness error voids the run' : pass ? 'pass' : 'fail',
    build, build_version: gut.version, gbrain_under_test: overlaySummary(gut),
    harness: `gbrain-evals ${harnessCommit} (belief-weekly-probes, ${BELIEF_WEEKLY_GENERATOR_VERSION})`,
    engine: 'pglite (in-memory, activated managed brain)',
    held_out_material: material, material_sha256: custody?.sha256 ?? null,
    seeds, weeks_per_seed: WEEKS, edits_per_week: OPS_PER_WEEK,
    gates,
    tokens_reported: { note: 'reported, never gated: the belief diff beside delta\'s page list for the same week', by_seed: tokens },
    cost: { usd: 0, model_calls: 0 },
    harness_errors: results.filter(s => s.error).map(s => ({ seed: s.seed, error: custody ? 'recorded in the custody receipt (an error message can quote a held-out line)' : s.error })),
    attestation,
  };
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ category: 'belief-weekly-probes', ...verdict, seed_results: results }, null, 2) + '\n');
  writeFileSync(join(output, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: verdict.verdict, gates }, null, 2));
}

if (import.meta.main) await main();
