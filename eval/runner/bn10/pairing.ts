/**
 * BEAM-10M newest release (GST-3139), custody only. The Q1 and F6 directories are their published receipt
 * trees with the private campaign.json and per-cell logs restored. --rejudged is the paid custody tool's
 * judgments.ndjson: standard Q1 JudgmentRecords for the ORIGINAL F6 P/A and Q1 whole/file Opus answer IDs (a Q1 answer
 * whose ID an F6 answer with another text also uses takes rejudge-systems.ts's root-qualified ID, sha256(`q1|<id>`)),
 * judged by openai:gpt-6.1-sol, replicate 0, under the frontier instrument and PER_READER_JUDGE_SETTINGS.
 * Pass the F6 particle add-on's P re-read separately and one --reread root per current arm. --root takes the
 * original BN10 cell output roots (including runs/ for the fences and proxy meters), one per shard if sharded.
 *
 *   bun eval/runner/bn10/pairing.ts freeze --f6 <receipt> --q1 <receipt> --rejudged <file> --out <freeze.json>
 *   bun eval/runner/bn10/pairing.ts report --f6 <receipt> --q1 <receipt> --rejudged <file> --frozen <freeze.json>
 *     --root <cell out>... --reread <particle out>... --f6-reread <F6 particle P out> --measured YYYY-MM-DD
 *     --bridge-status passed|descriptive [--left-out p|a0|whole=<pilot check 1–4>] --out <report.json>
 *     [--cost-out <private cost table.json>]
 *
 * Both modes require GBRAIN_EVALS_CUSTODY_LOG. Freeze reads no current cell and records only the two SDDs
 * under each view. The report is aggregate-only and contains no dollars. The optional, separate private
 * first table reports costs from the proxy meters at list price, never from estimates or judges.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { PASS_THRESHOLD } from '../memory-qa/instruments.ts';
import { HARNESS_FAILURES, NOT_APPLICABLE, PRODUCT_FAILURES } from '../memory-qa/outcomes.ts';
import { answerId, judgmentKey, sha256, type AnswerRecord, type JudgmentRecord } from '../memory-qa/records.ts';
import { custodyGate, frontierInstrumentId, type MeterLine } from '../q1/cell.ts';
import { BN10_CONFIGURATION, generateBN10Cells, OPUS, PARTICLE, SOL } from '../q1/cells/bn10.ts';
import { ALL_SETS, BN10_ASSUMPTIONS, frontierJudgeOf, PER_READER_JUDGE_SETTINGS, policyKey } from '../q1/cells/definitions.ts';
import { F6_FILE_AGENT_CONFIG_SHA256, seedNumber } from '../q1/particle-addon-report.ts';
import { rereadCellId, REREAD_RECEIPT_SCHEMA } from '../q1/reread-cell.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError } from '../q1/scoreboard-errors.ts';
import { CAMPAIGN_SCHEMA, CLUSTER_RETAINED_SHARE, MIN_COVERAGE, type CampaignManifest } from '../scoreboard.ts';
import { clusteredPairedDelta, type PairedItem } from '../stats/paired.ts';
import { measureFences } from './fence-share.ts';

const FRONT = ['bun', 'eval/runner/bn10/pairing.ts'];
const REPAIR = { next: 'report' as const, user_message: 'Check the named inputs on the custody host; see the usage in pairing.ts.' };
const bad = (message: string) => refuse({ code: 'PREFLIGHT_FAILED', message, why: 'the report uses only the preregistered receipts and frozen S1 schedule', fix: REPAIR });
const SEED = 'beam10m-newest';
const OPTS = { seed: seedNumber(SEED), draws: 10_000 };
const BRIDGE = 'openai:gpt-4.1-mini';
const VIEWS = ['frontier', 'bridge'] as const;
type View = typeof VIEWS[number];
const READERS = [OPUS, PARTICLE, SOL] as const;
type Reader = typeof READERS[number];
const ARMS = ['p', 'a0', 'whole'] as const;
type Arm = typeof ARMS[number];
const ABILITIES = ['abstention', 'contradiction_resolution', 'event_ordering', 'information_extraction', 'instruction_following',
  'knowledge_update', 'multi_session_reasoning', 'preference_following', 'summarization', 'temporal_reasoning'] as const;
const F6 = 's1.gbrain-defaults.f6-master';
const Q1 = 's1.gbrain-defaults.shipped-defaults';
const FILE_AGENT = 's1.baseline-file-agent.baseline.whole-agent';
const MIN_CLUSTERS = 9;
const SDD_FACTOR = 2.80;
const FREEZE_SCHEMA = 'gbrain-evals/bn10-sdd/v1';
const def = generateBN10Cells()[0]!;

interface Question { question_id: string; conversation: string }
type Reason = 'missing_row' | 'reader_error' | 'judge_error' | 'harness_invalid' | 'budget_not_run' | 'does_not_fit';
type Value = { value: number; productFailure?: string } | { value: null; reason: Reason };
type Series = ReadonlyMap<string, Value>;
interface Receipt {
  schema: string; cell_id: string; set: string; run_status: string; keyless?: boolean; config_sha256?: string;
  instrument: { id: string; sha256: string; judge: string };
  source?: { arm_cell_id: string; config_sha256?: string; config_sha256s?: string[] };
  realizations?: Array<{ conversation: string; degraded: boolean | null }>;
}
interface Cell { receipts: Receipt[]; answers: AnswerRecord[]; judgments: JudgmentRecord[] }

const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const exists = (path: string) => existsSync(path) || existsSync(path + '.gz');
function rows<T>(path: string): T[] {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : gunzipSync(readFileSync(path + '.gz')).toString('utf8');
  return text.split('\n').filter(x => x.trim()).map(x => JSON.parse(x) as T);
}

function unique<T>(items: readonly T[], key: (x: T) => string): T[] {
  const indexed = new Map<string, T>();
  for (const x of items) {
    const id = key(x);
    if (indexed.has(id) && JSON.stringify(indexed.get(id)) !== JSON.stringify(x)) throw bad('conflicting records under one key');
    indexed.set(id, x);
  }
  return [...indexed.values()];
}

function cell(roots: readonly string[], id: string, required = true): Cell {
  const dirs = roots.map(r => join(r, 'cells', id)).filter(p => existsSync(join(p, 'receipt.json')));
  if (!dirs.length && required) throw bad(`missing receipt for ${id}`);
  const receipts = dirs.map(d => json<Receipt>(join(d, 'receipt.json')));
  const instrument = receipts[0]?.instrument;
  if (receipts.some(r => r.cell_id !== id || r.set !== 'S1' || r.keyless === true || !['complete', 'partial', 'invalid'].includes(r.run_status) || r.instrument?.judge !== BRIDGE
    || r.instrument.id !== instrument?.id || r.instrument.sha256 !== instrument?.sha256)) throw bad(`wrong receipt identity, judge, or keyless marker for ${id}`);
  const good = dirs.filter((_, i) => receipts[i]!.run_status !== 'invalid');
  const answers = unique(good.flatMap(d => rows<AnswerRecord>(join(d, 'answers.ndjson'))), a => a.answer_id);
  if (answers.some(a => a.cell_id !== id || a.answer_id !== answerId(id, a.question_id, a.reader, a.replicate))) throw bad(`invalid stored answer identity for ${id}`);
  return { receipts, answers, judgments: unique(good.flatMap(d => rows<JudgmentRecord>(join(d, 'judgments.ndjson'))), judgmentKey) };
}

function checkReread(live: Cell, replay: Cell, id: string) {
  const configs = live.receipts.map(r => r.config_sha256);
  if (replay.receipts.some(r => r.schema !== REREAD_RECEIPT_SCHEMA || r.keyless !== false || r.source?.arm_cell_id !== id
    || !configs.every(c => c && [r.source?.config_sha256, ...(r.source?.config_sha256s ?? [])].includes(c))
    || r.instrument.sha256 !== live.receipts[0]?.instrument.sha256)) throw bad(`unverified particle-1 re-read of ${id}`);
  const liveAnswers = new Map(live.answers.filter(a => a.reader === OPUS && a.replicate === 0).map(a => [a.question_id, a]));
  if (replay.answers.some(a => a.reader !== PARTICLE
    || (liveAnswers.get(a.question_id)?.context_sha256 && liveAnswers.get(a.question_id)?.context_sha256 !== a.context_sha256))) throw bad(`particle-1 re-read does not match the frozen contexts of ${id}`);
}

function schedule(campaign: CampaignManifest, id: string) {
  const set = campaign.sets?.find(s => s.id === 'S1');
  const excluded = new Set(set?.exclusions.map(e => e.question_id));
  const ordered = set?.scheduled.filter(q => !excluded.has(q.question_id)).sort((a, b) => a.question_id.localeCompare(b.question_id));
  if (campaign.schema !== CAMPAIGN_SCHEMA || campaign.campaign_id !== id || !ordered
    || excluded.size !== ALL_SETS.S1.exclusions.length || ALL_SETS.S1.exclusions.some(e => !excluded.has(e.question_id))
    || ordered.length !== ALL_SETS.S1.questions - excluded.size || new Set(ordered.map(q => q.question_id)).size !== ordered.length
    || new Set(ordered.map(q => q.conversation)).size !== ALL_SETS.S1.conversations) throw bad(`wrong or incomplete sealed schedule for ${id}`);
  return { questions: ordered, excluded: excluded.size, set: set! };
}

function scores(c: Cell, reader: Reader, view: View, questions: readonly Question[], rejudged?: readonly JudgmentRecord[]): Series {
  const instrument = c.receipts[0]?.instrument;
  const judge = view === 'frontier' ? frontierJudgeOf(reader) : BRIDGE;
  const instrumentId = view === 'frontier' && instrument ? frontierInstrumentId(instrument.id, judge) : instrument?.id;
  const judgments = new Map((rejudged ?? c.judgments).filter(j => j.judge === judge && j.instrument_id === instrumentId
    && j.instrument_sha256 === instrument?.sha256 && j.judge_replicate === 0
    && (view === 'bridge' || (j.settings?.effort === PER_READER_JUDGE_SETTINGS.effort
      && j.settings.max_tokens === PER_READER_JUDGE_SETTINGS.max_tokens))).map(j => [j.answer_id, j]));
  const answers = new Map(c.answers.filter(a => a.reader === reader && a.replicate === 0).map(a => [a.question_id, a]));
  const invalid = c.receipts.some(r => r.run_status === 'invalid');
  return new Map(questions.map((q): [string, Value] => {
    if (invalid) return [q.question_id, { value: null, reason: 'harness_invalid' }];
    const a = answers.get(q.question_id);
    if (!a) return [q.question_id, { value: null, reason: 'missing_row' }];
    if (a.conversation !== q.conversation) throw bad('an answer names a different conversation from the frozen schedule');
    if (PRODUCT_FAILURES.has(a.outcome)) return [q.question_id, { value: 0, productFailure: a.outcome }];
    if (HARNESS_FAILURES.has(a.outcome) || NOT_APPLICABLE.has(a.outcome)) return [q.question_id, { value: null, reason: a.outcome as Reason }];
    const j = judgments.get(a.answer_id);
    if (j?.outcome !== 'scored' || !j.parse_ok || j.score === null || !Number.isFinite(j.score) || j.score < 0 || j.score > 1)
      return [q.question_id, { value: null, reason: 'judge_error' }];
    return [q.question_id, { value: 100 * j.score }];
  }));
}

const byView = <T>(fn: (view: View) => T): Record<View, T> => ({ frontier: fn('frontier'), bridge: fn('bridge') });
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]) => xs.length ? sum(xs) / xs.length : null;
const count = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const missing: Value = { value: null, reason: 'missing_row' };

export function compare(questions: readonly Question[], lhs: Series, rhs?: Series, iid = false) {
  const pairs: PairedItem[] = [];
  const convs = new Map<string, { paired: number; scheduled: number }>();
  const drops = { lhs: {}, rhs: {} } as Record<'lhs' | 'rhs', Record<string, number>>;
  const productFailures = { lhs: {}, rhs: {} } as Record<'lhs' | 'rhs', Record<string, number>>;
  for (const q of questions) {
    const c = convs.get(q.conversation) ?? { paired: 0, scheduled: 0 };
    c.scheduled++;
    convs.set(q.conversation, c);
    const b = lhs.get(q.question_id) ?? missing;
    const a: Value = rhs ? rhs.get(q.question_id) ?? missing : { value: 0 };
    if (a.value === null) count(drops.rhs, a.reason);
    else if (a.productFailure) count(productFailures.rhs, a.productFailure);
    if (b.value === null) count(drops.lhs, b.reason);
    else if (b.productFailure) count(productFailures.lhs, b.productFailure);
    if (a.value === null || b.value === null) continue;
    pairs.push({ id: q.question_id, cluster: q.conversation, a: a.value, b: b.value });
    c.paired++;
  }
  const stats = pairs.length ? clusteredPairedDelta(pairs, OPTS) : null;
  const dropped = questions.length - pairs.length;
  const total = sum(pairs.map(p => p.b - p.a));
  const retained = [...convs.values()].filter(c => c.paired >= CLUSTER_RETAINED_SHARE * c.scheduled).length;
  const coverage = questions.length ? pairs.length / questions.length : 0;
  return { mean_points: stats?.delta ?? null, ci95_points: stats?.ci95 ?? null, se_cluster_points: stats?.se_cluster ?? null,
    ...(iid ? { question_ci95_points: pairs.length ? clusteredPairedDelta(pairs.map(p => ({ ...p, cluster: p.id })), OPTS).ci95 : null } : {}),
    ...(rhs ? { lhs_mean_points: stats?.mean_b ?? null, rhs_mean_points: stats?.mean_a ?? null } : {}),
    scheduled: questions.length, scored: pairs.length, dropped, drops, product_failures: productFailures, coverage,
    conversations_scheduled: convs.size, conversations_retained: retained, complete_for_claim: coverage >= MIN_COVERAGE && retained >= MIN_CLUSTERS,
    worst_case_points: questions.length ? (total - (rhs ? 100 * dropped : 0)) / questions.length : null,
    best_case_points: questions.length ? (total + 100 * dropped) / questions.length : null };
}

type Comparison = ReturnType<typeof compare>;
type Sdds = Record<'primary' | 'whole_vs_file', Record<View, number>>;

export function primaryOutcome(p: Pick<Comparison, 'mean_points' | 'ci95_points' | 'complete_for_claim'>, sdd: number, descriptive = false) {
  if (!p.complete_for_claim || p.mean_points === null || !p.ci95_points) return { code: 'incomplete', text: 'Coverage is insufficient for a regression claim.' } as const;
  if (p.mean_points <= -sdd) return { code: 'regression', text: descriptive
    ? 'The descriptive bridge crosses the regression threshold; it does not decide the outcome.'
    : 'Arm P regressed. Publish the drop and send maintainers the failure counts, ability split and measured fence share. The fences are a suspect, not a proven cause.' } as const;
  if (p.ci95_points[1] < 0) return { code: 'measured_drop_below_sdd', text: 'A drop was measured, but it is smaller than this test was sized to detect. Send maintainers the same aggregates as a note.' } as const;
  return { code: 'no_regression_claim', text: 'No regression is claimed; report what the 95% interval allows.' } as const;
}

export function wholeOutcome(p: Pick<Comparison, 'ci95_points' | 'complete_for_claim'>, sdd: number) {
  if (!p.complete_for_claim || !p.ci95_points) return 'Coverage is insufficient to update the comparison claim.';
  if (p.ci95_points[1] < 0) return 'Keep the file-agent comparison under “where gbrain loses” with the new paired interval.';
  if (p.ci95_points[0] > 0) return 'Remove the file-agent comparison from “where gbrain loses”. Do not rank the systems.';
  return `The two systems could not be told apart at this sample size. The smallest detectable difference was ${sdd} points. Do not rank the systems.`;
}

function stored(f6Root: string, q1Root: string, rejudgedPath: string, freeze: boolean) {
  const f6 = schedule(json(join(f6Root, 'campaign.json')), 'q1-scoreboard-f6-current-master');
  const q1 = schedule(json(join(q1Root, 'campaign.json')), 'q1-scoreboard');
  if (JSON.stringify(q1.questions) !== JSON.stringify(f6.questions)) throw bad('the F6 and Q1 S1 schedules do not match');
  const p = cell([f6Root], F6 + '.p'), a = cell([f6Root], F6 + '.a');
  const f6Text = new Map([p, a, cell([f6Root], Q1 + '.whole-default', false), cell([f6Root], FILE_AGENT, false)]
    .flatMap(c => c.answers.map(x => [x.answer_id, x.text] as const)));
  const qualify = (c: Cell): Cell => {
    const moved = new Map(c.answers.filter(x => f6Text.has(x.answer_id) && f6Text.get(x.answer_id) !== x.text).map(x => [x.answer_id, sha256(`q1|${x.answer_id}`)]));
    return { ...c, answers: c.answers.map(x => ({ ...x, answer_id: moved.get(x.answer_id) ?? x.answer_id })),
      judgments: c.judgments.map(j => ({ ...j, answer_id: moved.get(j.answer_id) ?? j.answer_id })) };
  };
  const whole = qualify(cell([q1Root], Q1 + '.whole-default')), file = qualify(cell([q1Root], FILE_AGENT));
  const instrument = p.receipts[0]!.instrument;
  if ([a, whole, file].some(c => c.receipts.some(r => r.instrument.id !== instrument.id || r.instrument.sha256 !== instrument.sha256)))
    throw bad('the four stored answer sets used different scoring instruments');
  const allowed = new Set([p, a, whole, file].flatMap(c => c.answers.filter(x => x.reader === OPUS && x.replicate === 0).map(x => x.answer_id)));
  const rejudged = unique(rows<JudgmentRecord>(rejudgedPath), judgmentKey);
  if (rejudged.some(j => !allowed.has(j.answer_id) || j.judge !== frontierJudgeOf(OPUS) || j.judge_replicate !== 0
    || j.instrument_id !== frontierInstrumentId(instrument.id, j.judge) || j.instrument_sha256 !== instrument.sha256
    || j.settings?.effort !== PER_READER_JUDGE_SETTINGS.effort || j.settings.max_tokens !== PER_READER_JUDGE_SETTINGS.max_tokens))
    throw bad('the re-judgment log contains a judgment outside the four pinned Opus sets');
  const questions = q1.questions;
  const storedScores = (c: Cell) => byView(view => scores(c, OPUS, view, questions, view === 'frontier' ? rejudged : undefined));
  const prior = { p: storedScores(p), a: storedScores(a), whole: storedScores(whole), file: storedScores(file) };
  const threshold = (lhs: Record<View, Series>, rhs: Record<View, Series>) => byView(view => {
    const d = compare(questions, lhs[view], rhs[view]);
    if (!d.complete_for_claim || d.se_cluster_points === null) throw bad(`not enough scored stored pairs to freeze the ${view} SDD`);
    return SDD_FACTOR * d.se_cluster_points;
  });
  const sdds: Sdds = { primary: threshold(prior.p, prior.a), whole_vs_file: threshold(prior.whole, prior.file) };
  const frozen = { schema: FREEZE_SCHEMA, seed: SEED, resamples: OPTS.draws, sdd_points: sdds };
  if (freeze) return { frozen } as const;
  const degraded = new Set(f6.set.sensitivity?.find(x => x.id === 'f6-s1-gbrain-degraded-ingest')?.question_ids ?? []);
  for (const a of p.answers) if (a.outcome === 'ingest_degraded') degraded.add(a.question_id);
  const f6file = cell([f6Root], FILE_AGENT);
  if (f6file.receipts.some(r => r.config_sha256 !== F6_FILE_AGENT_CONFIG_SHA256))
    throw bad('the F6 file-agent sensitivity needs the F6 rerun, not the Q1 file-agent row');
  return { frozen, prior, questions, excluded: q1.excluded, degraded, f6p: p, f6a0: cell([f6Root], F6 + '.a0'),
    q1a0: cell([q1Root], Q1 + '.component-b8000'), f6file };
}

function cohorts(questions: readonly Question[], newScores: Record<Arm, Record<Reader, Record<View, Series>>>,
  prior: NonNullable<ReturnType<typeof stored>['prior']>, bridges: Record<string, Series>) {
  const p = newScores.p[OPUS], whole = newScores.whole[OPUS], a0 = newScores.a0[OPUS].bridge;
  const combined = (arm: Arm, readers: readonly Reader[], view: View) => new Map(questions.map(q => {
    const values = readers.map(r => newScores[arm][r][view].get(q.question_id) ?? missing);
    return [q.question_id, values.find(v => v.value === null) ?? { value: mean(values.map(v => v.value!))! }];
  }));
  const rowsFor = (readers: readonly Reader[]) => ARMS.flatMap(arm => readers.map(reader => {
    const v = newScores[arm][reader];
    const both = questions.filter(q => v.frontier.get(q.question_id)?.value != null && v.bridge.get(q.question_id)?.value != null).length;
    return { arm, reader, both_views_scored: both, complete_both_views: both === questions.length && both > 0,
      scores: byView(view => compare(questions, v[view])) };
  }));
  return {
    first_table: rowsFor([OPUS, PARTICLE]), sol: rowsFor([SOL]),
    reader_means: Object.fromEntries(ARMS.map(arm => [arm, {
      opus_plus_sol: byView(v => compare(questions, combined(arm, [OPUS, SOL], v))),
      all_three: byView(v => compare(questions, combined(arm, READERS, v))),
    }])),
    primary: byView(v => compare(questions, p[v], prior.p[v], true)),
    secondary: {
      whole_vs_file: byView(v => compare(questions, whole[v], prior.file[v])),
      whole_vs_f6_file_rerun: compare(questions, whole.bridge, bridges.f6file!),
      whole_vs_q1_whole: byView(v => compare(questions, whole[v], prior.whole[v])),
      a0_vs_q1_8000: compare(questions, a0, bridges.q1a0!),
      a0_vs_f6_a0: compare(questions, a0, bridges.f6a0!),
      particle_p_vs_f6_particle_p: compare(questions, newScores.p[PARTICLE].bridge, bridges.f6particle!),
    },
    ability: Object.fromEntries(ABILITIES.map(ability => [ability, byView(v => compare(
      questions.filter(q => q.question_id.startsWith(`${q.conversation}:${ability}:`)), p[v], prior.p[v],
    ))])),
  };
}

function privateCosts(roots: string[], live: Record<Arm, Cell>, replays: Record<Arm, Cell>, replayRoots: string[],
  report: ReturnType<typeof cohorts>, questions: readonly Question[]) {
  const metersAt = (p: string) => exists(p) ? rows<MeterLine>(p) : [];
  const liveMeters = [...new Set(roots)].flatMap(r => metersAt(join(r, 'runs', def.id, 'meters.ndjson')));
  const cost = (meters: MeterLine[]) => meters.length && meters.every(m => m.unpriced === 0 && Number.isFinite(m.usd) && m.usd >= 0)
    ? sum(meters.map(m => m.usd)) : null;
  const table = (rs: typeof report.first_table) => rs.map(({ arm, reader, scores: s }) => {
    const policy = policyKey(def.arms.find(a => a.id === arm)!);
    const replayId = rereadCellId(`${def.id}.${arm}`, PARTICLE);
    const isReplay = reader === PARTICLE;
    const allKeys = new Set([...questions, ...ALL_SETS.S1.exclusions].map(q => `read:${answerId(isReplay ? replayId : `${def.id}.${arm}`, q.question_id, reader, 0).slice(0, 16)}`));
    const readerMeters = isReplay ? [...new Set(replayRoots)].flatMap(r => metersAt(join(r, 'cells', replayId, 'meters.ndjson'))) : liveMeters;
    const readerUsd = cost(readerMeters.filter(m => m.phase === 'reader' && allKeys.has(m.key)));
    const queryUsd = cost(liveMeters.filter(m => m.phase === 'retrieval' && m.key.endsWith(`:${policy}`)));
    const judged = scores(isReplay ? replays[arm] : live[arm], reader, 'frontier', questions);
    const correct = [...judged.values()].filter(v => v.value !== null && v.value >= 100 * PASS_THRESHOLD).length;
    return { arm, reader, frontier_score: s.frontier.mean_points, correct,
      usd_per_correct: correct && readerUsd !== null && queryUsd !== null ? (readerUsd + queryUsd) / correct : null };
  });
  const build = cost(liveMeters.filter(m => m.phase === 'ingest' || m.phase === 'background_tail'));
  return { schema: 'gbrain-evals/bn10-private-cost-table/v1', first_table: table(report.first_table), sol: table(report.sol),
    shared_build_usd_per_conversation: build === null ? null : build / ALL_SETS.S1.conversations,
    shared_build_usd_per_question: build === null ? null : build / questions.length };
}

function main(argv: string[]) {
  const { positionals: [mode, extra], values: v } = parseArgs({ args: argv, allowPositionals: true, options: {
    f6: { type: 'string' }, q1: { type: 'string' }, rejudged: { type: 'string' }, frozen: { type: 'string' },
    root: { type: 'string', multiple: true }, reread: { type: 'string', multiple: true }, 'f6-reread': { type: 'string' },
    'bridge-status': { type: 'string' }, 'left-out': { type: 'string', multiple: true }, measured: { type: 'string' },
    out: { type: 'string' }, 'cost-out': { type: 'string' },
  } });
  if (extra || (mode !== 'freeze' && mode !== 'report') || !v.f6 || !v.q1 || !v.rejudged || !v.out
    || (mode === 'report' && (!v.frozen || !v.root?.length || !v['f6-reread'] || !v.measured || !/^\d{4}-\d{2}-\d{2}$/.test(v.measured)
      || (v['bridge-status'] !== 'passed' && v['bridge-status'] !== 'descriptive'))))
    throw refuse({ code: 'USAGE', message: 'expected freeze or report with the preregistered inputs', why: 'freeze uses only stored rows; report also needs the frozen SDDs and current receipts',
      fix: { next: 'run', argv: [...FRONT, 'freeze', '--f6', '<receipt>', '--q1', '<receipt>', '--rejudged', '<file>', '--out', '<freeze.json>'] } });
  const out = resolve(v.out), costOut = v['cost-out'] && resolve(v['cost-out']);
  if (costOut && costOut === out) throw bad('private cost table and report must have distinct destinations');
  custodyGate(def, dirname(out), process.env, `BN10 pairing ${mode}`);
  if (costOut) custodyGate(def, dirname(costOut), process.env, 'BN10 private cost table');
  const data = stored(resolve(v.f6), resolve(v.q1), resolve(v.rejudged), mode === 'freeze');
  const write = (path: string, aggregate: unknown) => writeFileSync(path, JSON.stringify(aggregate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (mode === 'freeze' || !data.questions) { write(out, data.frozen); return; }
  const frozen = json<typeof data.frozen>(v.frozen!);
  if (frozen.schema !== FREEZE_SCHEMA || frozen.seed !== SEED || frozen.resamples !== OPTS.draws
    || Object.entries(data.frozen.sdd_points).some(([k, views]) => VIEWS.some(view => frozen.sdd_points?.[k as keyof Sdds]?.[view] !== views[view])))
    throw bad('the stored rows do not reproduce the SDDs frozen before the counted run');
  const roots = v.root!, replayRoots = v.reread ?? [], questions = data.questions;
  const leftOut = new Map<Arm, number>();
  for (const arg of v['left-out'] ?? []) {
    const m = /^(p|a0|whole)=([1-4])$/.exec(arg);
    if (!m || leftOut.has(m[1] as Arm)) throw bad('a pilot exclusion must name one arm and a failed check from 1 to 4');
    leftOut.set(m[1] as Arm, Number(m[2]));
  }
  const onArms = <T>(fn: (a: Arm) => T) => Object.fromEntries(ARMS.map(arm => [arm, fn(arm)])) as Record<Arm, T>;
  const live = onArms(arm => cell(roots, `${def.id}.${arm}`, false));
  const replays = onArms(arm => cell(replayRoots, rereadCellId(`${def.id}.${arm}`, PARTICLE), false));
  for (const arm of ARMS) {
    if (leftOut.has(arm) && (live[arm].receipts.length || replays[arm].receipts.length)) throw bad('a pilot exclusion cannot hide current counted receipts');
    checkReread(live[arm], replays[arm], `${def.id}.${arm}`);
  }
  const f6Replay = cell([v['f6-reread']!], rereadCellId(F6 + '.p', PARTICLE));
  checkReread(data.f6p, f6Replay, F6 + '.p');
  const instruments = new Set([...Object.values(live), ...Object.values(replays), data.f6p, f6Replay, data.f6a0, data.q1a0, data.f6file]
    .flatMap(c => c.receipts.map(r => `${r.instrument.id}:${r.instrument.sha256}`)));
  if (instruments.size !== 1) throw bad('the counted and stored answers used different scoring instruments');
  const cur = onArms(arm => Object.fromEntries(READERS.map(r => [r, byView(view =>
    scores(r === PARTICLE ? replays[arm] : live[arm], r, view, questions))])) as Record<Reader, Record<View, Series>>);
  const bridge = { f6file: scores(data.f6file, OPUS, 'bridge', questions), q1a0: scores(data.q1a0, OPUS, 'bridge', questions),
    f6a0: scores(data.f6a0, OPUS, 'bridge', questions), f6particle: scores(f6Replay, PARTICLE, 'bridge', questions) };
  const report = cohorts(questions, cur, data.prior, bridge);
  const fences = measureFences(def, roots);
  if (Object.values(fences).some(f => f.overlay_mismatches > 0)) throw bad('a delivered retrieval used a different overlay from its arm');
  const degradedConvs = new Set(questions.filter(q => data.degraded.has(q.question_id)).map(q => q.conversation));
  for (const r of Object.values(live).flatMap(c => c.receipts)) for (const c of r.realizations ?? []) if (c.degraded) degradedConvs.add(c.conversation);
  const clean = questions.filter(q => !degradedConvs.has(q.conversation));
  const outcome = byView(view => primaryOutcome(report.primary[view], frozen.sdd_points.primary[view], view === 'bridge' && v['bridge-status'] === 'descriptive'));
  const readersComplete = (arm: Arm) => report.reader_means[arm]?.all_three.frontier.complete_for_claim
    && [...report.first_table, ...report.sol].filter(r => r.arm === arm).every(r => r.scores.bridge.complete_for_claim);
  const readme = (arm: 'p' | 'whole') => leftOut.has(arm)
    ? `Keep the stored measurement, build and date. The newest arm was left out after pilot check ${leftOut.get(arm)} failed.`
    : !readersComplete(arm) ? 'Do not replace the stored row with an incomplete measurement.'
      : arm === 'p' ? 'Publish the frontier three-reader arm P mean and the Opus-paired change against F6 P with its interval.'
        : 'Publish the frontier three-reader whole-arm mean beside the stored file agent (67.6%), with the Opus-paired difference and interval.';
  const viewsDisagree = outcome.frontier.code !== 'incomplete' && outcome.bridge.code !== 'incomplete'
    && (outcome.frontier.code === 'regression') !== (outcome.bridge.code === 'regression');
  const aggregate = { schema: 'gbrain-evals/bn10-pairing/v1', build: BN10_ASSUMPTIONS.gbrain_sha, version: BN10_ASSUMPTIONS.gbrain_version,
    configuration: BN10_CONFIGURATION, measured: v.measured,
    bridge_status: v['bridge-status'], seed: SEED, resamples: OPTS.draws, preregistered_exclusions: data.excluded, sdd_points: frozen.sdd_points,
    ...report, fences, sensitivity_without_degraded_ingest: degradedConvs.size ? { descriptive: true, omitted_conversations: degradedConvs.size,
      ...cohorts(clean, cur, data.prior, bridge) } : null,
    decision: { primary: outcome, views_disagree: viewsDisagree,
      lead_note: viewsDisagree ? 'The frontier and bridge views disagree on the regression threshold. The frontier view decides.' : null,
      whole_vs_file: wholeOutcome(report.secondary.whole_vs_file.frontier, frozen.sdd_points.whole_vs_file.frontier),
      readme: { p: readme('p'), whole: readme('whole') }, pilot_left_out: Object.fromEntries(leftOut) } };
  if (costOut) write(costOut, privateCosts(roots, live, replays, replayRoots, report, questions));
  write(out, aggregate);
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (e) {
    const op = e instanceof ScoreboardError ? e.op : { code: 'PREFLIGHT_FAILED' as const, message: 'could not read the pairing inputs or write a fresh report', why: 'no custody data or embedded parser error is printed', fix: REPAIR };
    console.error(renderMessage(op));
    process.exitCode = exitCodeOf(op);
  }
}
