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
import { MODELS } from './task-judge.ts';

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
    else (r.kind === 'judge' ? judges : judges2).set(r.key, r);
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

function compare(spec: Spec, rows: Outcome[], invalidCells: Set<string>) {
  const pick = (arm: TaskArm) => new Map(rows.filter(o => o.arm === arm && o.model === spec.model && (spec.form === POOLED || o.form === spec.form) && o.state === 'counted' && o.values[spec.metric] !== null).map(o => [o.form + '|' + o.task, o]));
  const ma = pick(spec.a), mb = pick(spec.b);
  const pairs: PairedItem[] = [];
  for (const [k, oa] of ma) { const ob = mb.get(k); if (ob) pairs.push({ id: k, cluster: oa.task, a: oa.values[spec.metric] as number, b: ob.values[spec.metric] as number }); }
  const forms = spec.form === POOLED ? FORMS : [spec.form];
  const invalid = forms.some(f => invalidCells.has(f + '|' + spec.a + '|' + spec.model) || invalidCells.has(f + '|' + spec.b + '|' + spec.model));
  const head = { id: spec.id, primary: spec.primary ?? null, form: spec.form, model: spec.model, a: spec.a, b: spec.b, metric: spec.metric, untested: invalid };
  if (!pairs.length || invalid) return { ...head, untested: true, n_pairs: pairs.length, mean_a: null, mean_b: null, delta: null, ci95: null, mcnemar: null, p_two_sided: null, p_holm: null, mde: null };
  const d = clusteredPairedDelta(pairs, { seed: SEED, draws: DRAWS });
  const m = spec.form === POOLED ? null : exactMcNemar(pairs);
  return {
    ...head, n_pairs: d.n_pairs, mean_a: round(d.mean_a), mean_b: round(d.mean_b), delta: round(d.delta), ci95: d.ci95 ? [round(d.ci95[0]), round(d.ci95[1])] : null,
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
  const roleTotals = { answer: 0, summariser: 0, judge: 0, second_judge: 0 };
  for (const r of s.records) {
    const [form, , arm, model] = r.key.split('|') as [string, string, string, string];
    const c = costOf(form, arm, model);
    if (r.kind === 'answer') {
      c.answer_usd += r.roles.answer?.usd ?? 0; c.summariser_usd += r.roles.summariser?.usd ?? 0;
      roleTotals.answer += r.roles.answer?.usd ?? 0; roleTotals.summariser += r.roles.summariser?.usd ?? 0;
      if (r.roles.answer) addUsage(c.usage, r.roles.answer.usage);
      if (r.roles.summariser) addUsage(c.usage, r.roles.summariser.usage);
    } else if (r.kind === 'judge') { c.judge_usd += r.usd; roleTotals.judge += r.usd; }
    else { c.second_judge_usd += r.usd; roleTotals.second_judge += r.usd; }
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
  for (const c of prim) c.p_holm = round(holm[PRIMARIES.findIndex(p => p.id === c.id)]);
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
      model_calls_usd: round(roleTotals.answer + roleTotals.summariser + roleTotals.judge + roleTotals.second_judge),
      by_role_usd: { answer: round(roleTotals.answer), summariser: round(roleTotals.summariser), judge: round(roleTotals.judge), second_judge: round(roleTotals.second_judge) },
      ledger_usd: round(s.ledger_usd),
      other_usd: s.ledger_usd === null ? null : round(s.ledger_usd - (roleTotals.answer + roleTotals.summariser + roleTotals.judge + roleTotals.second_judge)),
    },
    cells,
    comparisons,
    judge_agreement: { second_judge_correct: kappa(second), audit: s.audit },
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
  'tool_result_chars', 'paste_pages', 'paste_chars', 'budget_usd', 'window_note', 'concurrency', 'openai_store', 'result_cache', 'tool_defs_digest',
]);
const STRING_WORDS = new Set<string>([
  TASK_SCHEMA, 'complete', 'incomplete', ...FORMS, POOLED, ...ARMS, ...MODELS, 'correct', 'correct_grounded', 'P1', 'P2', 'errors_over_cap', 'degraded_over_cap',
  ...PRIMARIES.map(p => p.id), ...SPECS.map(p => p.id), 'postgres', 'pglite', 'copy', 'standby', 'no_write_privilege', 'session_pooler', 'transaction_pooler_rewritten', 'direct_or_local', 'in_process',
  'conservative', 'balanced', 'tokenmax', 'remote', 'medium', 'unknown', 'default', ...Object.keys(ABORT_CODES), ...STATUSES,
]);
const STRING_PATTERNS = [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, /^[0-9a-f]{7,64}$/, /^\d+\.\d+\.\d+(\.\d+)?$/];
const MODEL_PATTERN = /^[a-z0-9-]+:[A-Za-z0-9][A-Za-z0-9._\/:-]*$/;
const FIELD_PATTERNS: Record<string, RegExp> = { '$.run.reranker_model': MODEL_PATTERN, '$.run.embedding_model': MODEL_PATTERN, '$.run.window_note': /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/ };
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
  L.push('## Primary comparisons (paraphrase form, Holm over four)', '', '| Comparison | Pairs | A | B | B − A (95% CI) | McNemar p | Holm p | Observed MDE |', '|---|---|---|---|---|---|---|---|');
  for (const c of s.comparisons.filter(c => c.primary)) L.push('| ' + c.id + (c.untested ? ' (untested)' : '') + ' | ' + c.n_pairs + ' | ' + pct(c.mean_a) + ' | ' + pct(c.mean_b) + ' | ' + pct(c.delta) + (Array.isArray(c.ci95) ? ' (' + pct(c.ci95[0]) + ' to ' + pct(c.ci95[1]) + ')' : '') + ' | ' + (c.p_two_sided ?? 'n/a') + ' | ' + (c.p_holm ?? 'n/a') + ' | ' + pct(c.mde) + ' |');
  L.push('', '## Every cell', '', '| Form | Arm | Model | Counted | Excluded | Correct % | Grounded % | Abstained % | Confidently wrong % | Gold seen / opened / cited | Answer cost |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [form, byArm] of Object.entries(s.cells)) for (const [arm, byModel] of Object.entries(byArm as any)) for (const [model, c] of Object.entries(byModel as any) as Array<[string, any]>) {
    const ex = Object.entries(c.excluded).filter(([, n]) => (n as number) > 0).map(([k, n]) => k + ' ' + n).join(', ') || '0';
    const e = c.exposure;
    L.push('| ' + form + ' | ' + arm + ' | ' + model + ' | ' + c.counted + (c.model_errors ? ' (' + c.model_errors + ' model errors)' : '') + (c.invalid ? ' (invalid: ' + c.invalid_reason + ')' : '') + ' | ' + ex + ' | ' + pct(c.rates.correct?.point) + ' | ' + pct(c.rates.correct_grounded?.point) + ' | ' + pct(c.rates.abstained?.point) + ' | ' + pct(c.rates.confidently_wrong?.point) + ' | ' + pct(e.gold_seen) + ' / ' + pct(e.gold_opened) + ' / ' + pct(e.gold_cited) + ' | ' + (c.cost_usd ? usd(c.cost_usd.answer + c.cost_usd.summariser) : 'n/a') + ' |');
  }
  L.push('', '## Descriptive comparisons', '', '| Comparison | Pairs | B − A (95% CI) | p |', '|---|---|---|---|');
  for (const c of s.comparisons.filter(c => !c.primary)) L.push('| ' + c.id + (c.untested ? ' (untested)' : '') + ' | ' + c.n_pairs + ' | ' + pct(c.delta) + (Array.isArray(c.ci95) ? ' (' + pct(c.ci95[0]) + ' to ' + pct(c.ci95[1]) + ')' : '') + ' | ' + (c.p_two_sided ?? 'n/a') + ' |');
  const ja = s.judge_agreement;
  L.push('', '## Judges and cost', '');
  L.push('Second judge (claude-opus-5-5 on particle-1 rows of B, C and D, paraphrase): ' + ja.second_judge_correct.agree + ' of ' + ja.second_judge_correct.n + ' agree on correct, kappa ' + (ja.second_judge_correct.kappa ?? 'n/a') + '. Wintermute audit: ' + (ja.audit ? ja.audit.agree + ' of ' + ja.audit.n : 'not run') + '.');
  L.push('', 'Model calls ' + usd(s.cost.model_calls_usd) + ' (answers ' + usd(s.cost.by_role_usd.answer) + ', summariser ' + usd(s.cost.by_role_usd.summariser) + ', judge ' + usd(s.cost.by_role_usd.judge) + ', second judge ' + usd(s.cost.by_role_usd.second_judge) + '), priced from each response\'s usage at list prices. Ledger total ' + usd(s.cost.ledger_usd) + '; the difference ' + usd(s.cost.other_usd) + ' is gbrain\'s embedding and rerank calls and any retried requests.');
  L.push('', 'Custody: read-only verified at start ' + s.custody.readonly_verified_start + ', at end ' + s.custody.readonly_verified_end + '; guard refusals ' + JSON.stringify(s.custody.guard_refusals) + '; AI refusals ' + JSON.stringify(s.custody.ai_refusals) + '.', '');
  return L.join('\n');
}
