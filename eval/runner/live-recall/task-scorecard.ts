/**
 * Live recall phase 2: the task scorecard (live-recall-task-scorecard/v1). Aggregates only, built from the run
 * directory's records and checked structurally before anything is written: every key must be one this file defines and
 * every string must match an allowlist, so a task, an answer, a gold fact or a slug has no place to land. A second scan
 * looks for every private needle in both outbound files. The Markdown is rendered from the validated JSON alone. The
 * format is documented in docs/benchmarks/live-recall/SCORECARD.md, "Phase 2 task scorecard".
 */
import { percentile } from '../metrics.ts';
import { clusteredPairedDelta, exactMcNemar, holmAdjusted, normalQuantile, powerNote, type PairedItem } from '../stats/paired.ts';
import { clusterBootstrapProportion, wilson } from '../q2/stats.ts';
import { ABORT_CODES, LiveRecallAbort } from './brain.ts';
import { scanForLeaks } from './scorecard.ts';
import { ARMS, COUNTED, FORMS, MAX_ATTEMPTS, STATUSES, type AnswerRecord, type JudgeRecord, type Task, type TaskArm, type TaskForm } from './task-arms.ts';
import { LABELLERS, MODELS, judgeFor } from './task-judge.ts';

export const TASK_SCHEMA = 'live-recall-task-scorecard/v1';
export const SEED = 20261108;
export const DRAWS = 10_000;
/** A cell with more than this share of its run episodes excluded for errors (harness, timeout, judge) is invalid. */
export const ERROR_CAP = 0.05;
/** A cell with more than this share excluded as degraded searches is invalid. */
export const DEGRADED_CAP = 0.1;
export const PRIMARY_MODELS = ['claude-opus-5-5', 'particle-1'] as const;
export const TYPES = ['identifier', 'error_string', 'time_window', 'cross_source', 'topic'] as const;
const EXCLUSIONS = ['harness_error', 'timed_out', 'degraded', 'judge_error', 'unjudged', 'not_run'] as const;
type Exclusion = (typeof EXCLUSIONS)[number];
const RATES = ['correct', 'correct_grounded', 'partial', 'abstained', 'no_answer', 'confidently_wrong', 'contradicted'] as const;
type Rate = (typeof RATES)[number];
const EXPOSURES = ['searched', 'gold_seen', 'gold_opened', 'gold_cited', 'summary_gold_cited', 'pasted_gold'] as const;
const POOLED = 'pooled';

const round = (x: number | null | undefined, digits = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits);

/** Minimum detectable difference for a paired binary comparison: two-sided alpha, 80% power, discordant share d of n pairs. */
export function mdd(pairs: number, discordant: number, alpha = 0.05): number | null {
  if (pairs <= 0) return null;
  return round((normalQuantile(1 - alpha / 2) + normalQuantile(0.8)) * Math.sqrt(discordant / pairs));
}

/** The MDD table a freeze records for the four primaries at N tasks: alpha 0.05 and Holm's tightest level (0.05 / 4). */
export function primaryMdd(n: number) {
  const at = (d: number) => ({ alpha_05: mdd(n, d), holm_0125: mdd(n, d, 0.0125) });
  return { pd10: at(0.1), pd20: at(0.2), pd30: at(0.3) };
}

export interface Outcome {
  task: string; type: string; form: TaskForm; arm: TaskArm; model: string;
  state: 'counted' | 'excluded'; exclusion: Exclusion | null;
  /** A counted no-answer whose model call ended on a model-caused 400. */
  model_error: boolean;
  values: Record<Rate, number | null>;
  citations: number; supported: number;
  exposure: Record<(typeof EXPOSURES)[number], number | null>;
  turns: number; tool_calls: number; ms: number;
}

interface Indexed { answers: Map<string, AnswerRecord>; judges: Map<string, JudgeRecord>; judges2: Map<string, JudgeRecord> }

export function indexRecords(records: Array<AnswerRecord | JudgeRecord>): Indexed {
  const answers = new Map<string, AnswerRecord>(), judges = new Map<string, JudgeRecord>(), judges2 = new Map<string, JudgeRecord>();
  for (const r of records) {
    if (r.kind === 'answer') answers.set(r.key, r);
    else if (r.kind !== 'label') (r.kind === 'judge' ? judges : judges2).set(r.key, r);
  }
  return { answers, judges, judges2 };
}

const keyOf = (form: string, task: string, arm: string, model: string) => [form, task, arm, model].join('|');
const bool = (b: boolean | null | undefined) => (b === null || b === undefined ? null : b ? 1 : 0);

/** One outcome per kept task, form, arm and model the run covers. A judge record is counted only when it names the answer's key. */
export function outcomes(tasks: Task[], forms: readonly TaskForm[], arms: readonly TaskArm[], models: readonly string[], idx: Indexed): Outcome[] {
  const out: Outcome[] = [];
  for (const form of forms) for (const task of tasks) for (const arm of arms) for (const model of models) {
    const a = idx.answers.get(keyOf(form, task.id, arm, model));
    const empty = Object.fromEntries(RATES.map(r => [r, null])) as Record<Rate, number | null>;
    const base: Outcome = {
      task: task.id, type: task.type, form, arm, model, state: 'excluded', exclusion: 'not_run', model_error: false, values: empty, citations: 0, supported: 0,
      exposure: Object.fromEntries(EXPOSURES.map(e => [e, null])) as Outcome['exposure'], turns: 0, tool_calls: 0, ms: 0,
    };
    if (!a) { out.push(base); continue; }
    const ex = a.exposure;
    const exposure = {
      searched: arm === 'B' || arm === 'C' ? bool(ex.searched) : null, gold_seen: arm === 'B' || arm === 'C' ? bool(ex.gold_seen) : null,
      gold_opened: arm === 'B' || arm === 'C' ? bool(ex.gold_opened) : null, gold_cited: arm === 'A' ? null : bool(ex.gold_cited),
      summary_gold_cited: bool(ex.summary_gold_cited), pasted_gold: bool(ex.pasted_gold),
    };
    const turns = (a.roles.answer?.turns ?? 0) + (a.roles.summariser?.turns ?? 0);
    const filled = { ...base, exposure, turns, tool_calls: ex.tool_calls, ms: a.ms };
    if (a.status === 'harness_error') { out.push({ ...filled, exclusion: a.attempt >= MAX_ATTEMPTS ? 'harness_error' : 'not_run' }); continue; }
    if (a.status === 'timed_out' || a.status === 'degraded') { out.push({ ...filled, exclusion: a.status }); continue; }
    if (a.status !== 'answered') {
      const values = { correct: 0, correct_grounded: arm === 'A' ? null : 0, partial: 0, abstained: 0, no_answer: 1, confidently_wrong: 0, contradicted: 0 };
      out.push({ ...filled, state: 'counted', exclusion: null, model_error: a.status === 'model_error', values });
      continue;
    }
    const j = idx.judges.get(a.key);
    if (!j || j.at < a.at) { out.push({ ...filled, exclusion: 'unjudged' }); continue; }
    if (j.status !== 'ok' || !j.derived) { out.push({ ...filled, exclusion: 'judge_error' }); continue; }
    const d = j.derived;
    const values = {
      correct: bool(d.correct)!, correct_grounded: arm === 'A' ? null : bool(d.correct && d.grounded)!, partial: bool(d.partial)!, abstained: bool(d.abstained)!,
      no_answer: 0, confidently_wrong: bool(!d.correct && !d.abstained)!, contradicted: bool(d.contradicted)!,
    };
    out.push({ ...filled, state: 'counted', exclusion: null, values, citations: arm === 'A' ? 0 : d.citations, supported: arm === 'A' ? 0 : d.supported });
  }
  return out;
}

function rate(rows: Outcome[], r: Rate, pooled: boolean) {
  const xs = rows.filter(o => o.values[r] !== null);
  if (!xs.length) return null;
  const k = xs.reduce((s, o) => s + (o.values[r] as number), 0);
  if (!pooled) {
    const w = wilson(k, xs.length);
    return { k, n: xs.length, point: round(w.point), ci95: [round(w.lower), round(w.upper)] };
  }
  const byTask = new Map<string, { k: number; n: number }>();
  for (const o of xs) { const c = byTask.get(o.task) ?? { k: 0, n: 0 }; c.k += o.values[r] as number; c.n++; byTask.set(o.task, c); }
  const b = clusterBootstrapProportion([...byTask.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, c]) => c), { seed: SEED, draws: DRAWS });
  return { k, n: xs.length, point: round(b.point), ci95: b.ci95 ? [round(b.ci95[0]), round(b.ci95[1])] : null };
}

export interface CellCost { answer_usd: number; summariser_usd: number; judge_usd: number; second_judge_usd: number }

function cell(rows: Outcome[], pooled: boolean, cost: CellCost | null, usage: { input: number; output: number; cache_read: number; cache_write: number } | null) {
  const counted = rows.filter(o => o.state === 'counted');
  const ran = rows.filter(o => o.exclusion !== 'not_run');
  const excluded = Object.fromEntries(EXCLUSIONS.map(e => [e, rows.filter(o => o.exclusion === e).length])) as Record<Exclusion, number>;
  const errors = excluded.harness_error + excluded.timed_out + excluded.judge_error;
  const invalid = ran.length > 0 && errors / ran.length > ERROR_CAP ? 'errors_over_cap' : ran.length > 0 && excluded.degraded / ran.length > DEGRADED_CAP ? 'degraded_over_cap' : null;
  const answered = counted.filter(o => o.values.no_answer === 0);
  const correct = counted.reduce((s, o) => s + (o.values.correct ?? 0), 0);
  const answeringUsd = cost ? cost.answer_usd + cost.summariser_usd : null;
  return {
    n_tasks: rows.length, counted: counted.length, model_errors: counted.filter(o => o.model_error).length, excluded, invalid: invalid !== null, invalid_reason: invalid,
    rates: Object.fromEntries(RATES.map(r => [r, rate(counted, r, pooled)])),
    citations: { mean_per_answer: round(answered.length ? answered.reduce((s, o) => s + o.citations, 0) / answered.length : null), supported_share: round(answered.reduce((s, o) => s + o.citations, 0) ? answered.reduce((s, o) => s + o.supported, 0) / answered.reduce((s, o) => s + o.citations, 0) : null) },
    exposure: Object.fromEntries(EXPOSURES.map(e => {
      const xs = ran.filter(o => o.exposure[e] !== null);
      return [e, xs.length ? round(xs.reduce((s, o) => s + (o.exposure[e] as number), 0) / xs.length) : null];
    })),
    turns_mean: round(ran.length ? ran.reduce((s, o) => s + o.turns, 0) / ran.length : null),
    tool_calls_mean: round(ran.length ? ran.reduce((s, o) => s + o.tool_calls, 0) / ran.length : null),
    latency_ms: { p50: round(percentile(ran.map(o => o.ms), 50), 0), p95: round(percentile(ran.map(o => o.ms), 95), 0) },
    tokens: usage,
    cost_usd: cost ? { answer: round(cost.answer_usd), summariser: round(cost.summariser_usd), judge: round(cost.judge_usd), second_judge: round(cost.second_judge_usd) } : null,
    answer_cost_per_correct_usd: answeringUsd !== null && correct > 0 ? round(answeringUsd / correct) : null,
  };
}

type Metric = 'correct' | 'correct_grounded';
interface Spec { id: string; form: TaskForm | typeof POOLED; model: string; a: TaskArm; b: TaskArm; metric: Metric; primary?: 'P1' | 'P2' }

export const PRIMARIES: Spec[] = [
  { id: 'p1_b_vs_a_opus', form: 'paraphrase', model: 'claude-opus-5-5', a: 'A', b: 'B', metric: 'correct', primary: 'P1' },
  { id: 'p1_b_vs_a_particle', form: 'paraphrase', model: 'particle-1', a: 'A', b: 'B', metric: 'correct', primary: 'P1' },
  { id: 'p2_c_vs_b_opus', form: 'paraphrase', model: 'claude-opus-5-5', a: 'B', b: 'C', metric: 'correct_grounded', primary: 'P2' },
  { id: 'p2_c_vs_b_particle', form: 'paraphrase', model: 'particle-1', a: 'B', b: 'C', metric: 'correct_grounded', primary: 'P2' },
];
const DESCRIPTIVE: Array<Pick<Spec, 'a' | 'b' | 'metric'>> = [
  { a: 'A', b: 'B', metric: 'correct' }, { a: 'B', b: 'C', metric: 'correct_grounded' }, { a: 'B', b: 'C', metric: 'correct' },
  { a: 'B', b: 'D', metric: 'correct' }, { a: 'B', b: 'D', metric: 'correct_grounded' },
];
const shortModel = (m: string) => (m === 'claude-opus-5-5' ? 'opus' : m === 'gpt-6.1-sol' ? 'sol' : 'particle');
export const SPECS: Spec[] = [
  ...PRIMARIES,
  ...MODELS.flatMap(model => [...FORMS, POOLED].flatMap(form => DESCRIPTIVE.map(d => ({ ...d, model, form: form as Spec['form'], id: d.b.toLowerCase() + '_vs_' + d.a.toLowerCase() + '_' + d.metric + '_' + form + '_' + shortModel(model) })))),
];

/**
 * How a comparison reads: from its unadjusted 95% interval, except that a primary whose interval excludes zero but whose
 * Holm-adjusted p is HOLM_ALPHA or more reads not_significant_after_correction, never as a measured difference.
 */
type Reading = 'no_measurable_difference' | 'b_higher' | 'b_lower' | 'not_significant_after_correction' | null;
const HOLM_ALPHA = 0.05;

function compare(spec: Spec, rows: Outcome[], invalidCells: Set<string>) {
  const pick = (arm: TaskArm) => new Map(rows.filter(o => o.arm === arm && o.model === spec.model && (spec.form === POOLED || o.form === spec.form) && o.state === 'counted' && o.values[spec.metric] !== null).map(o => [o.form + '|' + o.task, o]));
  const ma = pick(spec.a), mb = pick(spec.b);
  const pairs: PairedItem[] = [];
  for (const [k, oa] of ma) { const ob = mb.get(k); if (ob) pairs.push({ id: k, cluster: oa.task, a: oa.values[spec.metric] as number, b: ob.values[spec.metric] as number }); }
  const forms = spec.form === POOLED ? FORMS : [spec.form];
  const invalid = forms.some(f => invalidCells.has(f + '|' + spec.a + '|' + spec.model) || invalidCells.has(f + '|' + spec.b + '|' + spec.model));
  const head = { id: spec.id, primary: spec.primary ?? null, form: spec.form, model: spec.model, a: spec.a, b: spec.b, metric: spec.metric, untested: invalid };
  if (!pairs.length || invalid) return { ...head, untested: true, n_pairs: pairs.length, mean_a: null, mean_b: null, delta: null, ci95: null, worse_tasks: null, reading: null, mcnemar: null, p_two_sided: null, p_holm: null, mde: null };
  const d = clusteredPairedDelta(pairs, { seed: SEED, draws: DRAWS });
  const m = spec.form === POOLED ? null : exactMcNemar(pairs);
  const byTask = new Map<string, number>();
  for (const x of pairs) byTask.set(x.cluster, (byTask.get(x.cluster) ?? 0) + x.b - x.a);
  const ci = d.ci95 ? [round(d.ci95[0])!, round(d.ci95[1])!] : null;
  return {
    ...head, n_pairs: d.n_pairs, mean_a: round(d.mean_a), mean_b: round(d.mean_b), delta: round(d.delta), ci95: ci,
    worse_tasks: [...byTask.values()].filter(x => x < 0).length,
    reading: (!ci ? null : ci[0] <= 0 && ci[1] >= 0 ? 'no_measurable_difference' : ci[0] > 0 ? 'b_higher' : 'b_lower') as Reading,
    mcnemar: m ? { wins: m.wins, losses: m.losses, discordant: m.discordant, p_two_sided: round(m.p_two_sided) } : null,
    p_two_sided: round(m ? m.p_two_sided : d.p_two_sided), p_holm: null as number | null, mde: round(powerNote(d, { binary: true }).mde),
  };
}

function kappa(pairs: Array<[number, number]>) {
  const n = pairs.length;
  if (!n) return { n: 0, agree: 0, kappa: null };
  const agree = pairs.filter(([x, y]) => x === y).length;
  const px = pairs.filter(([x]) => x === 1).length / n, py = pairs.filter(([, y]) => y === 1).length / n;
  const pe = px * py + (1 - px) * (1 - py);
  return { n, agree, kappa: pe >= 1 ? null : round((agree / n - pe) / (1 - pe)) };
}

/** Every judge model's row count and the model versions its providers reported serving. */
function judgeVersions(records: JudgeRecord[]) {
  const out: Record<string, { rows: number; truncated: number; versions: string[] }> = {};
  for (const r of records) {
    const j = (out[r.judge] ??= { rows: 0, truncated: 0, versions: [] });
    j.rows++;
    if (r.truncated) j.truncated++;
    if (r.judge_version && !j.versions.includes(r.judge_version)) j.versions.push(r.judge_version);
  }
  for (const j of Object.values(out)) j.versions.sort();
  return out;
}

export const JUDGE_CHECK_SCHEMA = 'live-recall-judge-check/v1';
/** R78: a counted judge gates a primary only with at least this many labelled answers and this kappa against the labels. */
export const JUDGE_CHECK_MIN_LABELS = 40;
export const JUDGE_CHECK_KAPPA = 0.6;
/** R78: a judge model whose calls hit the output-token cap on more than this share of its rows fails the check, and stops a run. */
export const TRUNCATION_CAP = 0.01;
const CHECK_METRICS = { correct: ARMS, correct_grounded: ARMS.filter(a => a !== 'A') } as const;

/**
 * The R78 judge check over a judge-check run's records. Each answered paraphrase episode carries its counted judge's
 * verdict and one verdict from each labeller. Per counted judge and metric: the labellers' own agreement (kappa over
 * every usable row), the label set (rows both labellers grade alike), and the counted verdict against those labels:
 * bad answers caught, good answers failed, and kappa. A judge passes a metric with at least JUDGE_CHECK_MIN_LABELS
 * labels, and both kappas at least JUDGE_CHECK_KAPPA. correct_grounded leaves out A, which cites nothing. Every judge
 * model must also keep its truncated calls (judge errors at the output-token cap) at or under TRUNCATION_CAP of all its
 * calls, a re-judged call's earlier attempts included, so judging again never washes a truncation out.
 */
export function judgeCheck(records: Array<AnswerRecord | JudgeRecord>) {
  const counted = new Map<string, JudgeRecord>(), labels = new Map<string, JudgeRecord>();
  for (const r of records) {
    if (r.kind === 'judge') counted.set(r.key, r);
    else if (r.kind === 'label') labels.set(r.key + '|' + r.judge, r);
  }
  const answers = records.filter((r): r is AnswerRecord => r.kind === 'answer' && r.status === 'answered');
  const valueOf = (j: JudgeRecord | undefined, metric: keyof typeof CHECK_METRICS, a: AnswerRecord) => (!j || j.at < a.at || j.status !== 'ok' || !j.derived ? null : (metric === 'correct' ? j.derived.correct : j.derived.correct && j.derived.grounded) ? 1 : 0);
  const stats = (rows: AnswerRecord[], metric: keyof typeof CHECK_METRICS) => {
    const usable: Array<{ judge: number; l0: number; l1: number }> = [];
    let unusable = 0;
    for (const a of rows.filter(r => (CHECK_METRICS[metric] as readonly TaskArm[]).includes(r.arm))) {
      const judge = valueOf(counted.get(a.key), metric, a), l0 = valueOf(labels.get(a.key + '|' + LABELLERS[0]), metric, a), l1 = valueOf(labels.get(a.key + '|' + LABELLERS[1]), metric, a);
      if (judge === null || l0 === null || l1 === null) unusable++;
      else usable.push({ judge, l0, l1 });
    }
    const labelled = usable.filter(u => u.l0 === u.l1);
    const bad = labelled.filter(u => u.l0 === 0), good = labelled.filter(u => u.l0 === 1);
    const caught = bad.filter(u => u.judge === 0).length, falseFails = good.filter(u => u.judge === 0).length;
    const labellers = kappa(usable.map(u => [u.l0, u.l1] as [number, number]));
    const against = kappa(labelled.map(u => [u.judge, u.l0] as [number, number]));
    return {
      n_rows: usable.length + unusable, unusable, labeller_agree: labellers.agree, labeller_kappa: labellers.kappa,
      n_labelled: labelled.length, n_bad: bad.length, n_good: good.length, caught, false_fails: falseFails,
      catch_rate: bad.length ? round(caught / bad.length) : null, false_fail_rate: good.length ? round(falseFails / good.length) : null, kappa: against.kappa,
      passed: labelled.length >= JUDGE_CHECK_MIN_LABELS && (labellers.kappa ?? -1) >= JUDGE_CHECK_KAPPA && (against.kappa ?? -1) >= JUDGE_CHECK_KAPPA,
    };
  };
  const judges: Record<string, unknown> = {};
  let passed = answers.length > 0;
  for (const judge of [...new Set(MODELS.map(judgeFor))]) {
    const models = MODELS.filter(m => judgeFor(m) === judge);
    const rows = answers.filter(a => models.includes(a.model as (typeof MODELS)[number]));
    const correct = stats(rows, 'correct'), grounded = stats(rows, 'correct_grounded');
    passed &&= correct.passed && grounded.passed;
    judges[judge] = {
      answer_models: models, correct, correct_grounded: grounded,
      by_model: Object.fromEntries(models.map(m => [m, { correct: stats(rows.filter(a => a.model === m), 'correct'), correct_grounded: stats(rows.filter(a => a.model === m), 'correct_grounded') }])),
    };
  }
  const calls = records.filter((r): r is JudgeRecord => r.kind === 'judge' || r.kind === 'label');
  const truncation = Object.fromEntries(Object.entries(judgeVersions(calls)).map(([m, v]) => [m, { rows: v.rows, truncated: v.truncated, rate: round(v.truncated / v.rows) }]));
  passed &&= Object.values(truncation).every(t => t.truncated <= TRUNCATION_CAP * t.rows);
  return { schema: JUDGE_CHECK_SCHEMA, passed, thresholds: { min_labels: JUDGE_CHECK_MIN_LABELS, kappa: JUDGE_CHECK_KAPPA, truncation: TRUNCATION_CAP }, n_answers: answers.length, judges, truncation, versions: judgeVersions(calls) };
}

export interface ScoreInput {
  tasks: Task[];
  forms: readonly TaskForm[]; arms: readonly TaskArm[]; models: readonly string[];
  records: Array<AnswerRecord | JudgeRecord>;
  identity: Record<string, unknown>;
  task_summary: { submitted: number; kept_at_freeze: number; dropped_unreachable: number; gold_missing_at_run: number; sha_prefix: string; n_frozen: number };
  custody: { readonly_verified_start: boolean; readonly_verified_end: boolean | null; guard_refusals: Record<string, number> };
  stop: 'LR_CAP_STOP' | null;
  ledger_usd: number | null;
  audit: { n: number; agree: number } | null;
  /** The judge check the counted run started from, as its judge-check.json summarises it. */
  judge_check?: Record<string, unknown> | null;
}

export function buildTaskScorecard(s: ScoreInput) {
  const idx = indexRecords(s.records);
  const rows = outcomes(s.tasks, s.forms, s.arms, s.models, idx);
  const zeroUsage = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  const costs = new Map<string, CellCost & { usage: ReturnType<typeof zeroUsage> }>();
  const costOf = (form: string, arm: string, model: string) => {
    const k = form + '|' + arm + '|' + model;
    if (!costs.has(k)) costs.set(k, { answer_usd: 0, summariser_usd: 0, judge_usd: 0, second_judge_usd: 0, usage: zeroUsage() });
    return costs.get(k)!;
  };
  const addUsage = (u: ReturnType<typeof zeroUsage>, x: { input: number; output: number; cache_read: number; cache_write: number }) => { u.input += x.input; u.output += x.output; u.cache_read += x.cache_read; u.cache_write += x.cache_write; };
  const roleTotals = { answer: 0, summariser: 0, judge: 0, second_judge: 0, label: 0 };
  for (const r of s.records) {
    const [form, , arm, model] = r.key.split('|') as [string, string, string, string];
    const c = costOf(form, arm, model);
    if (r.kind === 'answer') {
      c.answer_usd += r.roles.answer?.usd ?? 0; c.summariser_usd += r.roles.summariser?.usd ?? 0;
      roleTotals.answer += r.roles.answer?.usd ?? 0; roleTotals.summariser += r.roles.summariser?.usd ?? 0;
      if (r.roles.answer) addUsage(c.usage, r.roles.answer.usage);
      if (r.roles.summariser) addUsage(c.usage, r.roles.summariser.usage);
    } else if (r.kind === 'judge') { c.judge_usd += r.usd; roleTotals.judge += r.usd; }
    else if (r.kind === 'judge2') { c.second_judge_usd += r.usd; roleTotals.second_judge += r.usd; }
    else roleTotals.label += r.usd;
  }
  const forms = [...s.forms, ...(s.forms.length > 1 ? [POOLED] : [])] as Array<TaskForm | typeof POOLED>;
  const cells: Record<string, Record<string, Record<string, ReturnType<typeof cell>>>> = {};
  const invalidCells = new Set<string>();
  for (const form of forms) {
    cells[form] = {};
    for (const arm of s.arms) {
      cells[form]![arm] = {};
      for (const model of s.models) {
        const subset = rows.filter(o => o.arm === arm && o.model === model && (form === POOLED || o.form === form));
        const c = form === POOLED ? null : costs.get(form + '|' + arm + '|' + model) ?? null;
        const stats = cell(subset, form === POOLED, c, c ? c.usage : null);
        if (form !== POOLED && stats.invalid) invalidCells.add(form + '|' + arm + '|' + model);
        cells[form]![arm]![model] = stats;
      }
    }
  }
  const comparisons = SPECS.filter(sp => s.arms.includes(sp.a) && s.arms.includes(sp.b) && s.models.includes(sp.model) && (sp.form === POOLED ? s.forms.length > 1 : s.forms.includes(sp.form))).map(sp => compare(sp, rows, invalidCells));
  const prim = comparisons.filter(c => c.primary !== null);
  const holm = holmAdjusted(PRIMARIES.map(p => prim.find(c => c.id === p.id)?.p_two_sided ?? 1));
  for (const c of prim) {
    c.p_holm = round(holm[PRIMARIES.findIndex(p => p.id === c.id)]);
    if ((c.reading === 'b_higher' || c.reading === 'b_lower') && !((c.p_holm ?? 1) < HOLM_ALPHA)) c.reading = 'not_significant_after_correction';
  }
  const second = [...idx.judges2.values()].flatMap(j2 => {
    const j = idx.judges.get(j2.key);
    return j?.derived && j2.derived ? [[j.derived.correct ? 1 : 0, j2.derived.correct ? 1 : 0] as [number, number]] : [];
  });
  const byType = Object.fromEntries(TYPES.map(t => [t, s.tasks.filter(x => x.type === t).length]));
  const card = {
    schema: TASK_SCHEMA,
    status: s.stop === null && rows.every(o => o.exclusion !== 'not_run' && o.exclusion !== 'unjudged') ? 'complete' : 'incomplete',
    stop: s.stop,
    run: s.identity,
    tasks: { ...s.task_summary, kept_at_run: s.tasks.length, by_type: byType, gold_found_by: Object.fromEntries(['page_first', 'memory', 'gbrain_search', 'other_search', 'unknown'].map(g => [g, s.tasks.filter(t => t.gold_found_by === g).length])), mdd_primaries: primaryMdd(s.task_summary.n_frozen) },
    cost: {
      model_calls_usd: round(Object.values(roleTotals).reduce((x, y) => x + y, 0)),
      by_role_usd: { answer: round(roleTotals.answer), summariser: round(roleTotals.summariser), judge: round(roleTotals.judge), second_judge: round(roleTotals.second_judge), label: round(roleTotals.label) },
      ledger_usd: round(s.ledger_usd),
      other_usd: s.ledger_usd === null ? null : round(s.ledger_usd - Object.values(roleTotals).reduce((x, y) => x + y, 0)),
    },
    cells,
    comparisons,
    judge_agreement: { second_judge_correct: kappa(second), audit: s.audit },
    judges: judgeVersions(s.records.filter((r): r is JudgeRecord => r.kind === 'judge' || r.kind === 'judge2')),
    judge_check: s.judge_check ?? null,
    custody: { ...s.custody, ai_refusals: countBy(s.records.flatMap(r => (r.kind === 'answer' ? r.ai_refused : [])).filter(k => /^[a-z_]+$/.test(k))), degraded_stages: countBy(s.records.flatMap(r => (r.kind === 'answer' ? r.stages : [])).filter(k => /^[a-z_]+$/.test(k))) },
  };
  return card;
}

const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => { m[x] = (m[x] ?? 0) + 1; return m; }, {});

// ─── Custody: structural allowlist and leak scan ───────────────────────────────────────────────────────────────────

const KEY_WORDS = new Set<string>([
  'schema', 'status', 'stop', 'run', 'tasks', 'cost', 'cells', 'comparisons', 'judge_agreement', 'custody',
  'submitted', 'kept_at_freeze', 'dropped_unreachable', 'gold_missing_at_run', 'sha_prefix', 'n_frozen', 'kept_at_run', 'by_type', 'gold_found_by', 'mdd_primaries',
  'pd10', 'pd20', 'pd30', 'alpha_05', 'holm_0125', ...TYPES, 'page_first', 'memory', 'gbrain_search', 'other_search', 'unknown',
  'model_calls_usd', 'by_role_usd', 'ledger_usd', 'other_usd', 'answer', 'summariser', 'judge', 'second_judge',
  ...FORMS, POOLED, ...ARMS, ...MODELS,
  'n_tasks', 'counted', 'model_errors', 'excluded', 'invalid', 'invalid_reason', 'rates', 'citations', 'exposure', 'turns_mean', 'tool_calls_mean', 'latency_ms', 'tokens', 'cost_usd', 'answer_cost_per_correct_usd',
  ...EXCLUSIONS, ...RATES, 'k', 'n', 'point', 'ci95', 'mean_per_answer', 'supported_share', ...EXPOSURES, 'p50', 'p95', 'input', 'output', 'cache_read', 'cache_write',
  'id', 'primary', 'form', 'model', 'a', 'b', 'metric', 'untested', 'n_pairs', 'mean_a', 'mean_b', 'delta', 'mcnemar', 'wins', 'losses', 'discordant', 'p_two_sided', 'p_holm', 'mde',
  'second_judge_correct', 'audit', 'agree', 'kappa',
  'readonly_verified_start', 'readonly_verified_end', 'guard_refusals', 'ai_refusals', 'degraded_stages',
  'started_at', 'finished_at', 'runner_commit', 'runner_dirty', 'harness_digest', 'gbrain_pin_version', 'gbrain_pin_commit', 'gbrain_loaded_version', 'gbrain_loaded_commit', 'gbrain_overlay',
  'schema_version', 'engine', 'barrier', 'connection', 'control', 'search_mode', 'reranker_enabled', 'reranker_model', 'embedding_model', 'source_scope_default',
  'privacy_posture', 'remote_private_pages', 'crag_escalation', 'crag_think', 'models', 'arms', 'forms', 'judges', 'second_judge_model', 'effort', 'max_output_tokens', 'max_turns',
  'tool_result_chars', 'paste_pages', 'paste_chars', 'budget_usd', 'final_cap_usd', 'cap_extensions', 'window_note', 'concurrency', 'openai_store', 'result_cache', 'tool_defs_digest',
  'worse_tasks', 'reading', 'label', 'rows', 'versions', 'judge_check', 'labellers', 'label_effort', ...LABELLERS,
  'passed', 'waiver', 'thresholds', 'min_labels', 'n_answers', 'n_tasks_checked', 'answer_models', 'by_model', 'n_rows', 'unusable', 'labeller_agree', 'labeller_kappa',
  'n_labelled', 'n_bad', 'n_good', 'caught', 'false_fails', 'catch_rate', 'false_fail_rate', 'tasks_sha256', 'judge_check_sha256',
  'truncated', 'truncation', 'rate', 'steps', 'labels', 'stop', 'complete',
]);
const STRING_WORDS = new Set<string>([
  TASK_SCHEMA, 'complete', 'incomplete', ...FORMS, POOLED, ...ARMS, ...MODELS, 'correct', 'correct_grounded', 'P1', 'P2', 'errors_over_cap', 'degraded_over_cap',
  ...PRIMARIES.map(p => p.id), ...SPECS.map(p => p.id), 'postgres', 'pglite', 'copy', 'standby', 'no_write_privilege', 'session_pooler', 'transaction_pooler_rewritten', 'direct_or_local', 'in_process',
  'conservative', 'balanced', 'tokenmax', 'remote', 'medium', 'unknown', 'default', ...Object.keys(ABORT_CODES), ...STATUSES,
  'no_measurable_difference', 'b_higher', 'b_lower', 'not_significant_after_correction', JUDGE_CHECK_SCHEMA, 'high', ...LABELLERS,
]);
const JUDGE_VERSION = new RegExp('^(' + [...LABELLERS, ...MODELS].map(m => m.replaceAll('.', '\\.')).join('|') + ')[A-Za-z0-9._-]{0,40}$');
const STRING_PATTERNS = [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, /^[0-9a-f]{7,64}$/, /^\d+\.\d+\.\d+(\.\d+)?$/];
const MODEL_PATTERN = /^[a-z0-9-]+:[A-Za-z0-9][A-Za-z0-9._\/:-]*$/;
const NOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FIELD_PATTERNS: Record<string, RegExp> = { '$.run.reranker_model': MODEL_PATTERN, '$.run.embedding_model': MODEL_PATTERN, '$.run.window_note': NOTE_PATTERN, '$.judge_check.waiver': NOTE_PATTERN };
const OPEN_KEY_PARENTS = ['.guard_refusals', '.ai_refusals', '.degraded_stages'];

/** Structural custody check: known keys, allowlisted strings, finite numbers. Throws LR_CUSTODY_LEAK naming only the path. */
export function validateTaskScorecard(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'non-finite number at ' + path);
    return;
  }
  if (typeof value === 'string') {
    if (STRING_WORDS.has(value) || STRING_PATTERNS.some(p => p.test(value)) || FIELD_PATTERNS[path]?.test(value)) return;
    if (/\.versions\[\d+\]$/.test(path) && JUDGE_VERSION.test(value)) return;
    throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'unexpected string at ' + path);
  }
  if (Array.isArray(value)) { value.forEach((v, i) => validateTaskScorecard(v, path + '[' + i + ']')); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!KEY_WORDS.has(k) && !(OPEN_KEY_PARENTS.some(p => path.endsWith(p)) && /^[a-z_]{1,64}$/.test(k))) throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'unexpected key under ' + path);
      validateTaskScorecard(v, path + '.' + k);
    }
    return;
  }
  throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'unexpected value type at ' + path);
}

/**
 * Private needles for the leak scan: every task form, gold fact, gold answer and variant, every gold, seen and cited
 * slug. A needle with no letter (a number, a date) is left to the structural check, where a number can only sit under
 * a known numeric key, so a numeric gold fact cannot match a token count.
 */
export function taskNeedles(tasks: Task[], records: Array<AnswerRecord | JudgeRecord>): string[] {
  const out = new Set<string>();
  for (const t of tasks) for (const x of [...Object.values(t.forms), t.gold_answer.text, ...t.gold_answer.required_facts.map(f => f.fact), ...(t.gold_answer.acceptable_variants ?? []), ...t.gold_pages, t.id]) out.add(x);
  for (const r of records) if (r.kind === 'answer') for (const x of [...r.slugs_seen, ...r.cited]) out.add(x);
  return [...out].filter(n => /[A-Za-z]/.test(n));
}

export function checkOutbound(json: string, markdown: string, needles: string[]): void {
  validateTaskScorecard(JSON.parse(json));
  scanForLeaks(json + markdown, needles);
}

// ─── Markdown ──────────────────────────────────────────────────────────────────────────────────────────────────────

const pct = (x: unknown) => (typeof x === 'number' ? (100 * x).toFixed(1) : 'n/a');
const usd = (x: unknown) => (typeof x === 'number' ? '$' + x.toFixed(4) : 'n/a');
const readingText = (c: { reading: unknown; a: string; b: string }) => (c.reading === 'no_measurable_difference' ? 'no measurable difference' : c.reading === 'not_significant_after_correction' ? 'not significant after correcting for multiple comparisons' : c.reading === 'b_higher' ? c.b + ' above ' + c.a : c.reading === 'b_lower' ? c.b + ' below ' + c.a : 'n/a');
const rateText = (r: any) => (r ? pct(r.point) + (Array.isArray(r.ci95) ? ' (' + pct(r.ci95[0]) + '–' + pct(r.ci95[1]) + ')' : '') + ', n=' + r.n : 'n/a');

/** Markdown view of a validated task scorecard. Reads only the JSON. */
export function renderTaskMarkdown(s: ReturnType<typeof buildTaskScorecard>): string {
  const L: string[] = [];
  const run = s.run as Record<string, unknown>;
  L.push('# Live recall phase 2 task scorecard', '');
  L.push('Status: ' + s.status + (s.stop ? ' (' + s.stop + ')' : '') + '. gbrain ' + String(run.gbrain_loaded_version) + ' at ' + String(run.gbrain_loaded_commit) + ', barrier ' + String(run.barrier) + ', runner ' + String(run.runner_commit) + (run.control ? '. Fixture control: these numbers say nothing about Garry\'s brain.' : '.'), '');
  L.push('Tasks: ' + s.tasks.kept_at_run + ' kept at run (' + s.tasks.n_frozen + ' frozen, ' + s.tasks.dropped_unreachable + ' dropped at the freeze as unreachable to a remote caller, ' + s.tasks.gold_missing_at_run + ' lost since).', '');
  const para = (s.cells as any).paraphrase;
  if (para) {
    L.push('## Primary models, paraphrase form', '', '| Arm | Model | Correct % (95% CI) | Correct and grounded % | Answer cost per correct |', '|---|---|---|---|---|');
    for (const arm of ARMS) for (const model of PRIMARY_MODELS) {
      const c = para[arm]?.[model];
      if (c) L.push('| ' + arm + ' | ' + model + ' | ' + rateText(c.rates.correct) + ' | ' + rateText(c.rates.correct_grounded) + ' | ' + usd(c.answer_cost_per_correct_usd) + ' |');
    }
    L.push('');
  }
  L.push('## Primary comparisons (paraphrase form, Holm over four)', '', '| Comparison | Pairs | A | B | B − A (95% CI) | Reading | Tasks worse | McNemar p | Holm p | Observed MDE |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const c of s.comparisons.filter(c => c.primary)) L.push('| ' + c.id + (c.untested ? ' (untested)' : '') + ' | ' + c.n_pairs + ' | ' + pct(c.mean_a) + ' | ' + pct(c.mean_b) + ' | ' + pct(c.delta) + (Array.isArray(c.ci95) ? ' (' + pct(c.ci95[0]) + ' to ' + pct(c.ci95[1]) + ')' : '') + ' | ' + readingText(c) + ' | ' + (c.worse_tasks ?? 'n/a') + ' | ' + (c.p_two_sided ?? 'n/a') + ' | ' + (c.p_holm ?? 'n/a') + ' | ' + pct(c.mde) + ' |');
  L.push('', '## Every cell', '', '| Form | Arm | Model | Counted | Excluded | Correct % | Grounded % | Abstained % | Confidently wrong % | Gold seen / opened / cited | Answer cost |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [form, byArm] of Object.entries(s.cells)) for (const [arm, byModel] of Object.entries(byArm as any)) for (const [model, c] of Object.entries(byModel as any) as Array<[string, any]>) {
    const ex = Object.entries(c.excluded).filter(([, n]) => (n as number) > 0).map(([k, n]) => k + ' ' + n).join(', ') || '0';
    const e = c.exposure;
    L.push('| ' + form + ' | ' + arm + ' | ' + model + ' | ' + c.counted + (c.model_errors ? ' (' + c.model_errors + ' model errors)' : '') + (c.invalid ? ' (invalid: ' + c.invalid_reason + ')' : '') + ' | ' + ex + ' | ' + pct(c.rates.correct?.point) + ' | ' + pct(c.rates.correct_grounded?.point) + ' | ' + pct(c.rates.abstained?.point) + ' | ' + pct(c.rates.confidently_wrong?.point) + ' | ' + pct(e.gold_seen) + ' / ' + pct(e.gold_opened) + ' / ' + pct(e.gold_cited) + ' | ' + (c.cost_usd ? usd(c.cost_usd.answer + c.cost_usd.summariser) : 'n/a') + ' |');
  }
  L.push('', '## Descriptive comparisons', '', '| Comparison | Pairs | B − A (95% CI) | Reading | Tasks worse | p |', '|---|---|---|---|---|---|');
  for (const c of s.comparisons.filter(c => !c.primary)) L.push('| ' + c.id + (c.untested ? ' (untested)' : '') + ' | ' + c.n_pairs + ' | ' + pct(c.delta) + (Array.isArray(c.ci95) ? ' (' + pct(c.ci95[0]) + ' to ' + pct(c.ci95[1]) + ')' : '') + ' | ' + readingText(c) + ' | ' + (c.worse_tasks ?? 'n/a') + ' | ' + (c.p_two_sided ?? 'n/a') + ' |');
  const ja = s.judge_agreement;
  L.push('', '## Judges and cost', '');
  L.push('Second judge (claude-opus-5-5 on particle-1 rows of B, C and D, paraphrase): ' + ja.second_judge_correct.agree + ' of ' + ja.second_judge_correct.n + ' agree on correct, kappa ' + (ja.second_judge_correct.kappa ?? 'n/a') + '. Wintermute audit: ' + (ja.audit ? ja.audit.agree + ' of ' + ja.audit.n : 'not run') + '.');
  L.push('', 'Judge versions: ' + (Object.entries(s.judges).map(([m, j]) => m + ' ' + j.rows + ' rows (' + (j.versions.join(', ') || 'no version reported') + ')').join('; ') || 'none') + '.');
  const jc = s.judge_check as any;
  if (jc) L.push('', 'Judge check before the run: ' + (jc.passed ? 'passed' : 'not passed' + (jc.waiver ? ', run under GBEV-3 waiver ' + jc.waiver : '')) + '. ' + Object.entries(jc.judges ?? {}).map(([m, j]: [string, any]) => m + ': ' + (['correct', 'correct_grounded'] as const).map(k => k + ' kappa ' + (j[k].kappa ?? 'n/a') + ' on ' + j[k].n_labelled + ' labels (caught ' + j[k].caught + ' of ' + j[k].n_bad + ' bad, failed ' + j[k].false_fails + ' of ' + j[k].n_good + ' good; labellers agree kappa ' + (j[k].labeller_kappa ?? 'n/a') + ')').join(', ')).join('; ') + '.');
  L.push('', 'Model calls ' + usd(s.cost.model_calls_usd) + ' (answers ' + usd(s.cost.by_role_usd.answer) + ', summariser ' + usd(s.cost.by_role_usd.summariser) + ', judge ' + usd(s.cost.by_role_usd.judge) + ', second judge ' + usd(s.cost.by_role_usd.second_judge) + (s.cost.by_role_usd.label ? ', judge-check labels ' + usd(s.cost.by_role_usd.label) : '') + '), priced from each response\'s usage at list prices. Ledger total ' + usd(s.cost.ledger_usd) + '; the difference ' + usd(s.cost.other_usd) + ' is gbrain\'s embedding and rerank calls and any retried requests.');
  L.push('', 'Custody: read-only verified at start ' + s.custody.readonly_verified_start + ', at end ' + s.custody.readonly_verified_end + '; guard refusals ' + JSON.stringify(s.custody.guard_refusals) + '; AI refusals ' + JSON.stringify(s.custody.ai_refusals) + '.', '');
  return L.join('\n');
}
