/**
 * The SkillOpt ceiling attempt's calibration and headroom gate on
 * skillopt-method-v3 (GBEV-30, GST-1013; plan sections 4 and 5).
 *
 * Every arm sends the task with the skill's output contract (`armPrompt`), and
 * every score is substance pass (`evaluateLayers`), with full pass beside it.
 *
 * Calibration (train only; ledger run `n15-ceiling-calibration`, cap $50): the
 * seed at 1 run on every train task of the three skills (`--target opus`, one
 * round per run), or on the first 12 train tasks per skill (`--target sol
 * --half`, the Sol read of the frozen knobs). Per skill: substance pass, full
 * pass and the form-fail share; per target: the metered mean cost per rollout
 * and per model call, refusal classes and stop reasons; and every later stage
 * re-priced from the metered means (`repriceStages`), flagged when it passes
 * its approved cap.
 *
 * Gate (`--attempt 1|2`; ledger run `n15-ceiling-gate-<attempt>`, cap $470; the
 * one stage before B0 that reads the gate split), per pair (skill x target),
 * 456 rollouts and 3 proposer calls:
 *
 *   no-skill         NO_SKILL_TEXT on gate, 1 run
 *   seed             the seed on gate, 2 runs (run 1 designated for binary
 *                    comparisons, run 2 descriptive)
 *   seed-sel         the seed on selection, 2 runs: the bar a proposal beats
 *   seed-train       the seed on the 24 train tasks, 1 run: the trajectories
 *                    both one-shot inputs show
 *   proposal-1, -2   the harness one-shot under gbrain's shipped feedback: the
 *                    seed, `describeJudges(train)` and per train task its
 *                    prompt, tool calls with arguments and returned page names,
 *                    final answer and pass or fail (substance), with selection
 *                    and gate withheld and every page train does not show
 *                    redacted (`redactionScope`); two independent
 *                    proposals, each audited and, when clean, scored on
 *                    selection at 2 runs
 *   one-shot         the kept one-shot (the better proposal on selection when
 *                    it beats the seed's selection score, else the seed, whose
 *                    gate runs it reuses) on gate, 2 runs
 *   kept-rewrite     #304's kept rewrite (`readKeptRewrite`) on gate, 1 run:
 *                    GST-956's preliminary read against the seed's run 1 by
 *                    #304's rewrite rule (`rewriteVerdict`), never deciding
 *   rubric-one-shot  one proposal from #304's F0b input (`criteria.md` and each
 *                    train task's failed checks), audited, on gate at 1 run;
 *                    reported, never deciding
 *   reachability     the seed with a hint naming the pages that decide the
 *                    answer (an abstention task: that no page decides it, and
 *                    its near-miss pages), on gate, 1 run
 *
 * Opus pairs run first; `solGateNeeded` decides whether the Sol pairs run.
 * Each scored pair becomes a `GatePair` and `gateVerdict` reads them, with
 * `unsolvable` from the generator's keyless solvability control re-run over the
 * gate split. `limited_share` is the share of the kept one-shot's failed gate
 * rollouts that stopped at the turn or output limit or had a refused decisive
 * read (tool-calls.ts); `refusal_limited` holds when refused decisive reads
 * alone would make the pair harness-limited: more than a third of the kept
 * one-shot's failed rollouts, or more than 15% of reachability rollouts
 * failing after one.
 *
 * Every rollout and proposal is a row (`CeilingRow`), appended as it lands, so
 * a resumed stage skips what scored and reruns only errored tasks and proposer
 * errors (their earlier requests stay charged in the ledger). An arm with an
 * errored task is unscored, and so is its pair; later pairs still run. A
 * budget refusal or a tripwire (`refusalKind`) stops the stage at once: no row
 * is written for the refused rollouts, and the stage reads incomplete. After
 * each pair, the 1.25x re-price rule reads billed spend per scored rollout on
 * that target over a window from stage start or the last stop (the rollout
 * rows this process wrote; each --resume opens a new window), voided spend
 * included: past 1.25 times the (re-priced) planning price, the stage stops
 * after that pair (`reprice-trigger`), and a window that billed spend but
 * scored no rollout is the `unscored-spend` stop. All billed spend stays on
 * the ledger and counts against the run's cap; the stage also reports voided
 * spend apart, beside the count of arms that carry it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describeJudges } from 'gbrain/core/skillopt';
import type { PGLiteEngine } from 'gbrain/pglite-engine';
import { degenerateAnswers, type MethodTaskV3 } from '../../generators/skillopt-method/common-v3.ts';
import { auditSkill, type AuditResult } from './audit.ts';
import { armPrompt, readContract, type Arm } from './contract.ts';
import { datasetName, readCriteria, readSealedTasks, readSeed, readTasks } from './dataset.ts';
import { datasetContext, redactionScope } from './dataset-context.ts';
import { GATE, gateVerdict, labelPair, solGateNeeded, type GatePair, type GateResult, type PairLabel } from './gate.ts';
import {
  fakeTransport, FRONTIER_TARGET_NAMES, FRONTIER_TARGETS, MODELS_NOT_RUN, NO_SKILL_TEXT, observeModelRequests, openBrain, RETRIEVAL, sha8, TARGET_KEY, withProbeGateway,
  type ChatTransport, type FrontierTarget, type RequestSettings,
} from './headroom.ts';
import { readKeptRewrite } from './kept-rewrites.ts';
import { assertNoHiddenPages, ONE_SHOT_SYSTEM_PASS_FAIL, PROPOSER_MODEL, proposeRewrite, proposerInput, renderFailed, type TrainTrajectory } from './one-shot.ts';
import { callCostUsd, emptyMeter, logRetries, refusalKind, scoreArm, summarizeMeter, type CallUsage, type MeterSummary, type MeterTotals } from './rollouts.ts';
import { compileJudgeV3 } from './score-v3.ts';
import { evaluateLayers, SKILLS, type CheckResult, type Judge, type RuleCheck, type SkillName } from './score.ts';
import { pairedBootstrap, rewriteVerdict, type PairedDifference, type RewriteVerdict } from './test-stage.ts';
import { countStops, decisivePages, harnessLimit, refusedDecisiveReads, tallyRefusals, toolCallRecords, type RefusalTally, type StopClass, type ToolCallRecord } from './tool-calls.ts';

// ─── Stages, runs, prices and caps ───────────────────────────────────────────

export const CEILING_STAGES = ['calibration', 'gate'] as const;
export type CeilingStage = typeof CEILING_STAGES[number];
export const CEILING_DATASET = 'v3' as const;
export const CEILING_PREREGISTRATION = 'docs/benchmarks/2026-11-02-skillopt-ceiling/PREREGISTRATION.md';
/** Every ceiling stage runs at gbrain 62637c96a (v0.60.557.0; plan decision S, as amended 2026-11-03). */
export const CEILING_GBRAIN_COMMIT = '62637c96a5a5c2e9d55594f87a33d79c2f30b54f';

export const GATE_RUNS = { no_skill: 1, seed: 2, seed_sel: 2, train: 1, proposal_sel: 2, one_shot: 2, kept_rewrite: 1, rubric: 1, reachability: 1 } as const;
export const GATE_PROPOSALS = 2;
export const GATE_SPLIT_TASKS = { train: 24, sel: 24, gate: 36 } as const;
/** 36 no-skill, 72 seed on gate, 48 seed on selection, 192 harness one-shot (24 train, 96 selection, 72 gate), 36 rewrite, 36 rubric one-shot, 36 reachability. */
export const GATE_ROLLOUTS_PER_PAIR = GATE_SPLIT_TASKS.gate * (GATE_RUNS.no_skill + GATE_RUNS.seed + GATE_RUNS.one_shot + GATE_RUNS.kept_rewrite + GATE_RUNS.rubric + GATE_RUNS.reachability)
  + GATE_SPLIT_TASKS.sel * (GATE_RUNS.seed_sel + GATE_PROPOSALS * GATE_RUNS.proposal_sel) + GATE_SPLIT_TASKS.train * GATE_RUNS.train;
export const GATE_PROPOSER_CALLS_PER_PAIR = GATE_PROPOSALS + 1;
/** The Sol read of the frozen knobs: the first 12 train tasks per skill (train is ordered round-robin by family). */
export const CALIBRATION_HALF_TASKS = 12;
/** The Opus seed's calibration band (plan section 4). */
export const CALIBRATION_BAND = { low: 0.30, high: 0.60 } as const;

/** Section 5's planning prices: an Opus 5.5 rollout at $0.20, a Sol rollout at $0.10, an Opus proposer call at the top of $0.25 to $0.30. */
export const PLANNING_PRICES_USD = { rollout: { opus: 0.20, sol: 0.10 }, proposer_call: 0.30 } as const;
/** After a pair, a stage whose mean rollout cost on that target passes this times its price stops (section 5). */
export const REPRICE_FACTOR = 1.25;

/**
 * Section 5's stages as calibration re-prices them: rollouts per target,
 * proposer calls and the approved cap. E1 counts gbrain's one-shot per pair as
 * 72 baseline selection, 8 train, 72 candidate selection and 72 gate
 * rollouts and one proposer call, on up to six pairs.
 */
export const CEILING_STAGE_PLANS = {
  calibration: { what: 'calibration: up to 3 Opus rounds of the seed on the 72 train tasks, and one Sol read of 36', rollouts: { opus: 3 * 72, sol: 36 }, proposer_calls: 0, cap_usd: 50, ledger_run: 'n15-ceiling-calibration' },
  gate: { what: `one gate attempt: ${GATE_ROLLOUTS_PER_PAIR} rollouts and ${GATE_PROPOSER_CALLS_PER_PAIR} proposer calls on each of six pairs`, rollouts: { opus: 3 * GATE_ROLLOUTS_PER_PAIR, sol: 3 * GATE_ROLLOUTS_PER_PAIR }, proposer_calls: 6 * GATE_PROPOSER_CALLS_PER_PAIR, cap_usd: 470, ledger_run: 'n15-ceiling-gate-<attempt>' },
  'stop-read': { what: 'stop-path read: 1,728 rollouts per target', rollouts: { opus: 1728, sol: 1728 }, proposer_calls: 0, cap_usd: 650, ledger_run: 'n15-ceiling-stop-read' },
  'e1-check': { what: "B0: gbrain's E1 one-shot on up to six headroom pairs, 224 rollouts and one proposer call each", rollouts: { opus: 3 * 224, sol: 3 * 224 }, proposer_calls: 6, cap_usd: 300, ledger_run: 'n15-ceiling-e1-check' },
} as const;
export type PlannedStage = keyof typeof CEILING_STAGE_PLANS;

/** The ledger runner a stage's run must belong to. */
export const ceilingLedgerRun = (stage: CeilingStage, attempt?: 1 | 2) => (stage === 'gate' ? `n15-ceiling-gate-${attempt ?? 1}` : CEILING_STAGE_PLANS.calibration.ledger_run);

export interface StageEstimate {
  stage: PlannedStage;
  what: string;
  planning_usd: number;
  repriced_usd: number;
  cap_usd: number;
  over_cap: boolean;
  rollout_usd: Record<FrontierTarget, { usd: number; source: 'metered' | 'planning' }>;
  proposer_call_usd: { usd: number; source: 'planning' };
}

/** Every planned stage at planning prices and at the metered mean rollout cost of each target that has one. */
export function repriceStages(metered: Partial<Record<FrontierTarget, number | null>>): StageEstimate[] {
  const rollout_usd = Object.fromEntries(FRONTIER_TARGET_NAMES.map(t => {
    const m = metered[t];
    return [t, typeof m === 'number' ? { usd: m, source: 'metered' as const } : { usd: PLANNING_PRICES_USD.rollout[t], source: 'planning' as const }];
  })) as StageEstimate['rollout_usd'];
  const proposer = PLANNING_PRICES_USD.proposer_call;
  return (Object.keys(CEILING_STAGE_PLANS) as PlannedStage[]).map(stage => {
    const p = CEILING_STAGE_PLANS[stage];
    const at = (price: (t: FrontierTarget) => number) => FRONTIER_TARGET_NAMES.reduce((n, t) => n + p.rollouts[t] * price(t), 0) + p.proposer_calls * proposer;
    const repriced = at(t => rollout_usd[t].usd);
    return { stage, what: p.what, planning_usd: at(t => PLANNING_PRICES_USD.rollout[t]), repriced_usd: repriced, cap_usd: p.cap_usd, over_cap: repriced > p.cap_usd, rollout_usd, proposer_call_usd: { usd: proposer, source: 'planning' } };
  });
}

/** One gate attempt at these rollout prices: what refuses its start when it passes the $470 cap. */
export const gateEstimateUsd = (prices: Record<FrontierTarget, number>) =>
  FRONTIER_TARGET_NAMES.reduce((n, t) => n + 3 * GATE_ROLLOUTS_PER_PAIR * prices[t], 0) + 6 * GATE_PROPOSER_CALLS_PER_PAIR * PLANNING_PRICES_USD.proposer_call;

// ─── Rows ────────────────────────────────────────────────────────────────────

export type GateArm = 'no-skill' | 'seed' | 'seed-sel' | 'seed-train' | 'proposal-1' | 'proposal-2' | 'one-shot' | 'kept-rewrite' | 'rubric-one-shot' | 'reachability';
export type ProposalId = 'proposal-1' | 'proposal-2' | 'rubric-one-shot';
type RowSplit = 'train' | 'sel' | 'gate';

/** The contract arm each row arm sends its prompt as. */
const PROMPT_ARM: Readonly<Record<GateArm, Arm>> = {
  'no-skill': 'no-skill', seed: 'seed', 'seed-sel': 'seed', 'seed-train': 'seed', 'proposal-1': 'one-shot', 'proposal-2': 'one-shot',
  'one-shot': 'one-shot', 'kept-rewrite': 'kept-rewrite', 'rubric-one-shot': 'rubric-one-shot', reachability: 'reachability',
};

export interface RolloutUsage { calls: number; usd: number; unpriced_calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; reasoning_tokens: number | null }

/** One rollout: scored (substance, full, form, answer, tool calls, stop reason, cost) or errored (an infrastructure error, rerun on resume). */
export interface RolloutRow {
  kind: 'rollout';
  target: FrontierTarget;
  skill: SkillName;
  arm: GateArm;
  split: RowSplit;
  task_id: string;
  /** 1-based; run 1 is the designated run. */
  run: number;
  skill_sha8: string;
  error?: string;
  substance?: boolean;
  full?: boolean;
  /** A form check failed. */
  form_fail?: boolean;
  /** Failed checks by kind and description, never their arguments. */
  failed?: string[];
  answer?: string;
  tool_calls?: ToolCallRecord[];
  stop_reason?: string;
  turns?: number;
  usage?: RolloutUsage;
  at: string;
}

/** One proposer call: a proposal (or none), or a proposer error rerun on resume. */
export interface ProposalRow {
  kind: 'proposal';
  target: FrontierTarget;
  skill: SkillName;
  proposal: ProposalId;
  input_sha8: string;
  outcome: 'proposed' | 'no-rewrite' | 'proposer-error';
  text?: string;
  text_sha8?: string;
  error?: string;
  cost_usd: number | null;
  retries: number;
  stop_reason?: string;
  at: string;
}

export type CeilingRow = RolloutRow | ProposalRow;

/** What a rows file belongs to; a resume refuses rows of another stage, attempt, target, mode or dataset. */
export interface RowsHeader { kind: 'header'; stage: CeilingStage; attempt: number | null; target: FrontierTarget | null; half: boolean; mode: 'fake' | 'live'; dataset_manifest_sha256: string }

export interface RowStore { readonly rows: readonly CeilingRow[]; append(row: CeilingRow): void }

export function memoryRows(rows: CeilingRow[] = []): RowStore {
  return { rows, append: row => { rows.push(row); } };
}

/**
 * Rows as JSONL at `path`, its first line the header (written with the first
 * row). An existing file is read only with `resume` and only when its header
 * matches; every row is appended to the file as it lands.
 */
export function fileRows(path: string, header: Omit<RowsHeader, 'kind'>, resume: boolean): RowStore {
  const head: RowsHeader = { kind: 'header', ...header };
  const rows: CeilingRow[] = [];
  let started = existsSync(path);
  if (started) {
    if (!resume) throw new Error(`${path} already holds rows; pass --resume to continue that stage, or choose a fresh --output`);
    const [first, ...rest] = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RowsHeader | CeilingRow);
    if (JSON.stringify(first) !== JSON.stringify(head)) throw new Error(`${path} belongs to another run (${JSON.stringify(first)}); this run is ${JSON.stringify(head)}`);
    rows.push(...(rest as CeilingRow[]));
  }
  return {
    rows,
    append: row => {
      if (!started) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(head) + '\n'); started = true; }
      appendFileSync(path, JSON.stringify(row) + '\n');
      rows.push(row);
    },
  };
}

const rolloutKey = (r: Pick<RolloutRow, 'target' | 'skill' | 'arm' | 'split' | 'task_id' | 'run' | 'skill_sha8'>) => [r.target, r.skill, r.arm, r.split, r.task_id, r.run, r.skill_sha8].join('|');
const proposalKey = (target: FrontierTarget, skill: SkillName, id: ProposalId) => [target, skill, id].join('|');

/** The latest row per rollout and per proposal, kept current as rows are appended, and every failed rollout's rows (a rerun supersedes them, but their spend stays). */
function indexRows(store: RowStore) {
  const rollouts = new Map<string, RolloutRow>();
  const failed = new Map<string, RolloutRow[]>();
  const proposals = new Map<string, ProposalRow>();
  const fresh: RolloutRow[] = [];
  const add = (r: CeilingRow) => {
    if (r.kind === 'proposal') { proposals.set(proposalKey(r.target, r.skill, r.proposal), r); return; }
    const key = rolloutKey(r);
    rollouts.set(key, r);
    if (r.error !== undefined) failed.set(key, [...(failed.get(key) ?? []), r]);
  };
  store.rows.forEach(add);
  return {
    append(row: CeilingRow) { store.append(row); add(row); if (row.kind === 'rollout') fresh.push(row); },
    /** The rollout rows on `target` this process wrote: the re-price window since stage start or the --resume that opened it. */
    fresh: (target: FrontierTarget) => fresh.filter(r => r.target === target),
    rollout: (k: Parameters<typeof rolloutKey>[0]) => rollouts.get(rolloutKey(k)),
    failed: (k: Parameters<typeof rolloutKey>[0]) => failed.get(rolloutKey(k)) ?? [],
    proposal: (target: FrontierTarget, skill: SkillName, id: ProposalId) => proposals.get(proposalKey(target, skill, id)),
  };
}
type RowIndex = ReturnType<typeof indexRows>;

function usageOf(calls: readonly CallUsage[]): RolloutUsage {
  const u: RolloutUsage = { calls: 0, usd: 0, unpriced_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: null };
  for (const c of calls) {
    u.calls++;
    const usd = callCostUsd(c);
    if (usd === null) u.unpriced_calls++;
    else u.usd += usd;
    u.input_tokens += c.input_tokens;
    u.output_tokens += c.output_tokens;
    u.cache_read_tokens += c.cache_read_tokens;
    u.cache_creation_tokens += c.cache_creation_tokens;
    if (typeof c.reasoning_tokens === 'number') u.reasoning_tokens = (u.reasoning_tokens ?? 0) + c.reasoning_tokens;
  }
  return u;
}

/** A meter over rollout rows: scored rows count as rollouts, and an error row's paid calls add their calls, tokens and list-price dollars, so a failed rollout's spend raises the mean per scored rollout. Calibration's mean and the gate's re-price window both read it this way. */
export function meterOfRows(rows: readonly RolloutRow[]): MeterTotals {
  const m = emptyMeter();
  for (const r of rows) {
    if (!r.usage) continue;
    if (r.error === undefined) m.rollouts++;
    m.calls += r.usage.calls;
    m.usd += r.usage.usd;
    m.unpriced_calls += r.usage.unpriced_calls;
    m.input_tokens += r.usage.input_tokens;
    m.output_tokens += r.usage.output_tokens;
    m.cache_read_tokens += r.usage.cache_read_tokens;
    m.cache_creation_tokens += r.usage.cache_creation_tokens;
    if (r.usage.reasoning_tokens !== null) m.reasoning_tokens = (m.reasoning_tokens ?? 0) + r.usage.reasoning_tokens;
  }
  return m;
}

const meanCallUsd = (m: MeterTotals) => (m.calls ? m.usd / m.calls : null);

const METER_COUNTS = ['rollouts', 'retries', 'calls', 'usd', 'unpriced_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const;

function sumMeters(ms: readonly MeterTotals[]): MeterTotals {
  const into = emptyMeter();
  for (const m of ms) {
    for (const k of METER_COUNTS) into[k] += m[k];
    if (m.reasoning_tokens !== null) into.reasoning_tokens = (into.reasoning_tokens ?? 0) + m.reasoning_tokens;
  }
  return into;
}

// ─── Arms ────────────────────────────────────────────────────────────────────

/** A budget refusal or tripwire: the stage stops at once and reads incomplete. */
export interface StageStop { kind: 'budget_exhausted' | 'cell_invalid'; target: FrontierTarget; skill: SkillName; arm: GateArm | ProposalId; error: string }
class StageStopped extends Error { constructor(readonly stop: StageStop) { super(`${stop.kind} at ${stop.target} ${stop.skill} ${stop.arm}: ${stop.error}`); } }

const isForm = (c: RuleCheck) => (c as { layer?: string }).layer === 'form';
/** scoreArm's judge for v3: substance pass. */
const substance = (text: string, judge: Judge): CheckResult => { const l = evaluateLayers(text, judge); return { correct: l.substance, failed: l.failed }; };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const median = (xs: readonly number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface ArmSpec { arm: GateArm; split: RowSplit; tasks: readonly MethodTaskV3[]; runs: number; skillText: string; prompt?: (t: MethodTaskV3) => string }

export interface ArmSummary {
  arm: GateArm;
  split: RowSplit;
  runs: number;
  tasks: number;
  skill_sha8: string;
  /** Mean over tasks of the median of runs, substance pass; null while any rollout is unscored. */
  substance: number | null;
  full: number | null;
  /** Share of tasks whose run-1 rollout fails a form check. */
  form_fail: number | null;
  /** The designated run's substance pass, per task. */
  run1: Record<string, number> | null;
  errored_tasks: string[];
  refusals: RefusalTally;
  stops: Record<StopClass, number>;
  cost: MeterSummary;
  /** The paid calls and list-price dollars of the arm's failed rollouts (in `cost` too): spend that scored nothing. */
  voided: { calls: number; usd: number };
}

interface PairContext {
  engine: PGLiteEngine;
  target: FrontierTarget;
  skill: SkillName;
  rows: RowIndex;
  log: (line: string) => void;
}

/** The rows of an arm, per task in order, each with one slot per run (undefined when the run has no row) and every failed row of those runs. */
function armRows(c: PairContext, spec: ArmSpec): Array<{ task: MethodTaskV3; runs: Array<RolloutRow | undefined>; failed: RolloutRow[] }> {
  const skill_sha8 = sha8(spec.skillText);
  return spec.tasks.map(task => {
    const keys = Array.from({ length: spec.runs }, (_, i) => ({ target: c.target, skill: c.skill, arm: spec.arm, split: spec.split, task_id: task.task_id, run: i + 1, skill_sha8 }));
    return { task, runs: keys.map(k => c.rows.rollout(k)), failed: keys.flatMap(k => c.rows.failed(k)) };
  });
}

export function summarizeArm(spec: ArmSpec, cells: ReturnType<typeof armRows>): ArmSummary {
  const all = cells.flatMap(c => c.runs).filter((r): r is RolloutRow => !!r);
  const scored = all.filter(r => r.error === undefined);
  const complete = cells.every(c => c.runs.every(r => r && r.error === undefined));
  const score = (key: 'substance' | 'full') => (complete ? mean(cells.map(c => median(c.runs.map(r => (r![key] ? 1 : 0))))) : null);
  const voided = meterOfRows(cells.flatMap(c => c.failed));
  return {
    arm: spec.arm, split: spec.split, runs: spec.runs, tasks: spec.tasks.length, skill_sha8: sha8(spec.skillText),
    substance: score('substance'), full: score('full'),
    form_fail: complete ? cells.filter(c => c.runs[0]!.form_fail).length / cells.length : null,
    run1: complete ? Object.fromEntries(cells.map(c => [c.task.task_id, c.runs[0]!.substance ? 1 : 0])) : null,
    errored_tasks: cells.filter(c => c.runs.some(r => !r || r.error !== undefined)).map(c => c.task.task_id),
    refusals: tallyRefusals(scored.map(r => r.tool_calls ?? [])),
    stops: countStops(scored.map(r => r.stop_reason)),
    cost: summarizeMeter(meterOfRows([...scored, ...cells.flatMap(c => c.failed)])),
    voided: { calls: voided.calls, usd: voided.usd },
  };
}

/**
 * Run an arm's missing and errored rollouts, one run index at a time, and
 * return its summary. A scored rollout already in the rows is never re-run. A
 * refusal throws `StageStopped` and writes no row for the refused rollouts.
 */
async function runArm(c: PairContext, spec: ArmSpec): Promise<ArmSummary> {
  const skill_sha8 = sha8(spec.skillText);
  const model = FRONTIER_TARGETS[c.target];
  const prompt = spec.prompt ?? ((t: MethodTaskV3) => armPrompt(t.task, c.skill, PROMPT_ARM[spec.arm]));
  const byId = new Map(spec.tasks.map(t => [t.task_id, t]));
  for (let run = 1; run <= spec.runs; run++) {
    const need = spec.tasks.filter(t => {
      const row = c.rows.rollout({ target: c.target, skill: c.skill, arm: spec.arm, split: spec.split, task_id: t.task_id, run, skill_sha8 });
      return !row || row.error !== undefined;
    });
    if (!need.length) continue;
    const base = { kind: 'rollout' as const, target: c.target, skill: c.skill, arm: spec.arm, split: spec.split, run, skill_sha8 };
    const seen = new Set<string>();
    const taskErrors = new Map<string, string>();
    const failedCalls = new Map<string, CallUsage[]>();
    c.log(`[n15 ceiling] ${c.target} ${c.skill} ${spec.arm} run ${run}: ${need.length} ${spec.split} tasks`);
    const arm = await scoreArm({
      engine: c.engine, skillText: spec.skillText, model, runs: 1, evaluate: substance, onRetry: logRetries(c.log), onTaskError: (id, error) => taskErrors.set(id, error),
      onFailedRollout: (id, calls) => failedCalls.set(id, [...(failedCalls.get(id) ?? []), ...calls]),
      tasks: need.map(t => ({ task_id: t.task_id, task: prompt(t), judge: t.judge })),
      onRollout: (trajectory, _result, calls) => {
        seen.add(trajectory.task_id);
        const l = evaluateLayers(trajectory.final_text, byId.get(trajectory.task_id)!.judge);
        c.rows.append({
          ...base, task_id: trajectory.task_id, substance: l.substance, full: l.full, form_fail: l.failed.some(isForm), failed: l.failed.map(renderFailed),
          answer: trajectory.final_text, tool_calls: toolCallRecords(trajectory), stop_reason: trajectory.stop_reason, turns: trajectory.turns, usage: usageOf(calls), at: new Date().toISOString(),
        });
      },
    });
    if (arm.budget_exhausted || arm.cell_invalid) throw new StageStopped({ kind: arm.budget_exhausted ? 'budget_exhausted' : 'cell_invalid', target: c.target, skill: c.skill, arm: spec.arm, error: arm.error ?? '' });
    for (const t of need) {
      if (seen.has(t.task_id)) continue;
      const calls = failedCalls.get(t.task_id);
      c.rows.append({ ...base, task_id: t.task_id, error: taskErrors.get(t.task_id) ?? arm.error ?? 'unscored', ...(calls ? { usage: usageOf(calls) } : {}), at: new Date().toISOString() });
    }
  }
  return summarizeArm(spec, armRows(c, spec));
}

// ─── Solvability, hints and feedback ─────────────────────────────────────────

export interface Solvability { tasks: number; judge_mismatch: string[]; controls_failing: string[]; degenerate_passing: string[] }

/** The generator's keyless solvability control over a split: each judge recompiles from its gold, the oracle answer passes every check, and every degenerate answer fails substance. */
export function solvability(skill: SkillName, tasks: readonly MethodTaskV3[]): Solvability {
  return {
    tasks: tasks.length,
    judge_mismatch: tasks.filter(t => JSON.stringify(compileJudgeV3(skill, t.gold)) !== JSON.stringify(t.judge)).map(t => t.task_id),
    controls_failing: tasks.filter(t => !evaluateLayers(t.oracle_answer, t.judge).full).map(t => t.task_id),
    degenerate_passing: tasks.flatMap(t => degenerateAnswers(skill, t).filter(d => evaluateLayers(d.text, t.judge).substance).map(d => `${t.task_id}:${d.kind}`)),
  };
}
const solvable = (s: Solvability) => !s.judge_mismatch.length && !s.controls_failing.length && !s.degenerate_passing.length;

const list = (xs: readonly string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The reachability control's hint, appended to the task: the pages that decide it, or for an abstention task that none does and which near-miss pages exist. */
export function reachabilityHint(t: Pick<MethodTaskV3, 'answerable' | 'gold' | 'near_miss'>): string {
  if (t.answerable) return t.gold.slugs.length === 1 ? `Hint: the brain page that decides the answer is ${t.gold.slugs[0]}.` : `Hint: the brain pages that decide the answer are ${list(t.gold.slugs)}.`;
  const near = t.near_miss ?? [];
  const nearest = near.length === 1 ? ` The nearest page, which does not decide it, is ${near[0]}.` : near.length ? ` The nearest pages, which do not decide it, are ${list(near)}.` : '';
  return `Hint: no brain page decides the answer.${nearest}`;
}

/** A seed-on-train row as the proposer input shows it (the fields `seedOnTrain` keeps). */
const trainTrajectory = (task: MethodTaskV3, row: RolloutRow, prompt: string): TrainTrajectory => ({
  task_id: task.task_id, task: prompt, answer: row.answer ?? null, correct: !!row.substance, failed: row.failed ?? [],
  tool_calls: (row.tool_calls ?? []).map(c => ({ name: c.name, input: c.input, failed: c.error !== undefined, pages: c.pages ?? [] })),
});

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface CalibrationSkillResult {
  skill: SkillName;
  tasks: number;
  substance: number | null;
  full: number | null;
  form_fail: number | null;
  /** Opus only: the seed's substance pass is in [0.30, 0.60]. */
  in_band: boolean | null;
  errored_tasks: string[];
  refusals: RefusalTally;
  stops: Record<StopClass, number>;
  cost: MeterSummary;
  mean_call_usd: number | null;
}

export interface CalibrationResult {
  mode: 'fake' | 'live';
  stage: 'calibration';
  target: FrontierTarget;
  half: boolean;
  dataset: string;
  dataset_manifest_sha256: string;
  models: { target: string; proposer: null };
  runs: 1;
  skills: CalibrationSkillResult[];
  /** Every skill's rollouts on this target. */
  cost: MeterSummary;
  mean_call_usd: number | null;
  refusals: RefusalTally;
  stops: Record<StopClass, number>;
  /** Every planned stage re-priced from the metered means: this target's, and the other's when given. */
  repriced: StageEstimate[];
  stopped: StageStop | null;
  files_read: string[];
  models_not_run: typeof MODELS_NOT_RUN;
  retrieval: string;
  request_settings: RequestSettings[] | null;
}

export interface CalibrationOptions {
  target: FrontierTarget;
  /** The first 12 train tasks per skill (the Sol read). */
  half?: boolean;
  fake: boolean;
  rows?: RowStore;
  /** The other target's metered mean rollout cost, from its calibration, for the re-priced stages. */
  other?: { target: FrontierTarget; mean_rollout_usd: number | null };
  engine?: PGLiteEngine;
  log?: (line: string) => void;
  /** Called with each skill's result as soon as it is scored. */
  onSkill?: (result: CalibrationSkillResult) => void;
  /** Fake runs only: the chat transport (default fakeTransport). */
  transport?: (tasks: readonly MethodTaskV3[]) => ChatTransport;
}

/** Calibration for one target (see the header). Reads train only. */
export async function runCalibration(o: CalibrationOptions): Promise<CalibrationResult> {
  const log = o.log ?? (() => {});
  const ctx = datasetContext(CEILING_DATASET);
  for (const s of SKILLS) readContract(s);
  const files_read: string[] = [];
  const tasks = new Map(SKILLS.map(s => {
    files_read.push(`eval/data/${datasetName(CEILING_DATASET)}/${s}/train.jsonl`);
    const train = readTasks(s, 'train', CEILING_DATASET);
    return [s, o.half ? train.slice(0, CALIBRATION_HALF_TASKS) : train] as const;
  }));
  const rows = indexRows(o.rows ?? memoryRows());
  const transport = o.fake ? (o.transport ?? fakeTransport)([...tasks.values()].flat()) : undefined;
  const skills: CalibrationSkillResult[] = [];
  const all: RolloutRow[] = [];
  let stopped: StageStop | null = null;
  const engine = o.engine ?? await openBrain(CEILING_DATASET);
  const observer = o.fake ? null : observeModelRequests();
  try {
    await withProbeGateway({ chatModel: FRONTIER_TARGETS[o.target], fake: o.fake, transport, keys: [TARGET_KEY[o.target]] }, async () => {
      for (const skill of SKILLS) {
        const c: PairContext = { engine, target: o.target, skill, rows, log };
        const spec: ArmSpec = { arm: 'seed', split: 'train', tasks: tasks.get(skill)!, runs: 1, skillText: readSeed(skill, CEILING_DATASET) };
        try {
          await runArm(c, spec);
        } catch (e) {
          if (!(e instanceof StageStopped)) throw e;
          stopped = e.stop;
        }
        const cells = armRows(c, spec);
        all.push(...cells.flatMap(x => x.runs).filter((r): r is RolloutRow => !!r && r.error === undefined));
        const a = summarizeArm(spec, cells);
        const result: CalibrationSkillResult = {
          skill, tasks: spec.tasks.length, substance: a.substance, full: a.full, form_fail: a.form_fail,
          in_band: o.target === 'opus' && a.substance !== null ? a.substance >= CALIBRATION_BAND.low && a.substance <= CALIBRATION_BAND.high : null,
          errored_tasks: a.errored_tasks, refusals: a.refusals, stops: a.stops, cost: a.cost, mean_call_usd: meanCallUsd(a.cost),
        };
        skills.push(result);
        o.onSkill?.(result);
        log(`[n15 ceiling] calibration ${o.target} ${skill}: substance ${a.substance ?? 'unscored'}, full ${a.full ?? 'unscored'}, form fail ${a.form_fail ?? 'n/a'}, mean rollout $${a.cost.mean_rollout_usd?.toFixed(4) ?? 'n/a'}`);
        if (stopped) break;
      }
    });
  } finally {
    observer?.stop();
    if (!o.engine) await engine.disconnect().catch(() => {});
  }
  const meter = sumMeters(skills.map(s => s.cost));
  const cost = summarizeMeter(meter);
  return {
    mode: o.fake ? 'fake' : 'live', stage: 'calibration', target: o.target, half: !!o.half,
    dataset: datasetName(CEILING_DATASET), dataset_manifest_sha256: ctx.manifest_sha256,
    models: { target: FRONTIER_TARGETS[o.target], proposer: null }, runs: 1,
    skills, cost, mean_call_usd: meanCallUsd(meter),
    refusals: tallyRefusals(all.map(r => r.tool_calls ?? [])), stops: countStops(all.map(r => r.stop_reason)),
    repriced: repriceStages({ [o.target]: cost.mean_rollout_usd, ...(o.other ? { [o.other.target]: o.other.mean_rollout_usd } : {}) }),
    stopped, files_read, models_not_run: MODELS_NOT_RUN, retrieval: RETRIEVAL,
    request_settings: observer ? observer.settings() : null,
  };
}

// ─── Gate ────────────────────────────────────────────────────────────────────

export interface ProposalSummary {
  id: ProposalId;
  outcome: ProposalRow['outcome'] | 'audit-disqualified' | 'not-run';
  text_sha8?: string;
  audit?: AuditResult;
  /** Substance pass on selection at 2 runs (one-shot proposals that passed the audit). */
  selection?: number | null;
  cost_usd: number | null;
  retries: number;
  error?: string;
}

export interface Gst956Read {
  /** #304's kept rewrite (1 run) minus the seed's designated run, per gate task, substance pass. */
  difference: (PairedDifference & { verdict: RewriteVerdict }) | null;
  rule: string;
}

export interface GatePairResult {
  skill: SkillName;
  target: FrontierTarget;
  status: 'scored' | 'errored' | 'stopped' | 'not-run';
  not_run_reason?: 'sol-gate-not-needed' | 'reprice-trigger' | 'unscored-spend' | 'stage-stopped' | 'opus-incomplete';
  arms: Partial<Record<GateArm, ArmSummary>>;
  proposals: ProposalSummary[];
  /** The kept one-shot: a proposal that beat the seed on selection, else the seed; null while undecided. */
  kept: 'seed' | 'proposal-1' | 'proposal-2' | null;
  /** Substance pass on the whole gate split. */
  scores: {
    no_skill: number | null; seed_run1: number | null; seed_run2: number | null; seed: number | null;
    seed_trained_families: number | null; seed_held_out_families: number | null;
    seed_selection: number | null; one_shot: number | null; kept_rewrite: number | null; rubric_one_shot: number | null; reachability: number | null;
  };
  gate_pair: GatePair | null;
  label: PairLabel | null;
  gst956: Gst956Read | null;
  /** The pair's rollouts, every arm, from its rows. */
  cost: MeterSummary;
  proposer_usd: number | null;
  proposer_retries: number;
  /** In memory only (the runner writes them beside the receipt): proposer inputs and proposal texts. */
  texts: { proposer_input?: string; rubric_input?: string; proposals: Partial<Record<ProposalId, string>> };
}

/** `mean_rollout_usd` is the window's billed spend on the target, voided included, over its scored rollouts. */
export interface RepriceStop { reason: 'reprice-trigger'; target: FrontierTarget; skill: SkillName; mean_rollout_usd: number; threshold_usd: number }
/** A window that billed `usd` on the target and scored no rollout; a --resume opens a new window. */
export interface UnscoredStop { reason: 'unscored-spend'; target: FrontierTarget; skill: SkillName; usd: number }
/** Failed rollouts' spend on a target and the arms that carry it, reported apart (it is on the ledger and in the re-price window too). */
export interface VoidedSpend { arms: number; usd: number }

export interface GateStageResult {
  mode: 'fake' | 'live';
  stage: 'gate';
  attempt: 1 | 2;
  dataset: string;
  dataset_manifest_sha256: string;
  models: { targets: typeof FRONTIER_TARGETS; proposer: string };
  runs: typeof GATE_RUNS;
  prices: Record<FrontierTarget, number>;
  estimate_usd: number;
  pairs: GatePairResult[];
  /** Whether `solGateNeeded` asked for Sol's pairs after the Opus pairs (null when the stage stopped first), and whether they ran. */
  sol_gate: { needed: boolean | null; ran: boolean };
  solvability: Record<SkillName, Solvability>;
  unsolvable: SkillName[];
  verdict: GateResult;
  stopped: StageStop | null;
  reprice_trigger: RepriceStop | null;
  unscored_spend: UnscoredStop | null;
  voided: Record<FrontierTarget, VoidedSpend>;
  /** Every task file the stage read; it never reads test. */
  files_read: Array<{ path: string; use: 'scored' | 'proposer input' }>;
  models_not_run: typeof MODELS_NOT_RUN;
  retrieval: string;
  request_settings: RequestSettings[] | null;
}

export interface GateStageOptions {
  attempt: 1 | 2;
  fake: boolean;
  rows?: RowStore;
  /** Mean rollout prices the re-price trigger reads (default: the planning prices). */
  prices?: Record<FrontierTarget, number>;
  engine?: PGLiteEngine;
  log?: (line: string) => void;
  /** Called with each pair's result as soon as it is scored, errored or stopped. */
  onPair?: (pair: GatePairResult) => void;
  /** Fake runs only: the chat transport (default fakeTransport). */
  transport?: (tasks: readonly MethodTaskV3[]) => ChatTransport;
}

interface SkillData { train: MethodTaskV3[]; sel: MethodTaskV3[]; gate: MethodTaskV3[]; seed: string; kept: string; criteria: string; feedback: string }

/** The voided spend of `pairs`: their arms' failed-rollout dollars, and how many arms made a paid call that scored nothing. */
function voidedOf(pairs: readonly GatePairResult[]): VoidedSpend {
  const arms = pairs.flatMap(p => Object.values(p.arms)).filter(a => a!.voided.calls > 0);
  return { arms: arms.length, usd: arms.reduce((usd, a) => usd + a!.voided.usd, 0) };
}

const EMPTY_SCORES: GatePairResult['scores'] = { no_skill: null, seed_run1: null, seed_run2: null, seed: null, seed_trained_families: null, seed_held_out_families: null, seed_selection: null, one_shot: null, kept_rewrite: null, rubric_one_shot: null, reachability: null };
const emptyPair = (skill: SkillName, target: FrontierTarget, status: GatePairResult['status'], not_run_reason?: GatePairResult['not_run_reason']): GatePairResult =>
  ({ skill, target, status, ...(not_run_reason ? { not_run_reason } : {}), arms: {}, proposals: [], kept: null, scores: { ...EMPTY_SCORES }, gate_pair: null, label: null, gst956: null, cost: summarizeMeter(emptyMeter()), proposer_usd: null, proposer_retries: 0, texts: { proposals: {} } });

/** The designated run's substance pass over a subset of tasks. */
const run1Over = (a: ArmSummary | undefined, tasks: readonly MethodTaskV3[]) => (a?.run1 && tasks.length ? mean(tasks.map(t => a.run1![t.task_id]!)) : null);

/**
 * One pair (see the header). Arms run one at a time; each later step that
 * needs an unscored arm is skipped and the pair reads errored. A refusal
 * throws `StageStopped` with the pair so far in `partial`.
 */
async function runPair(c: PairContext, d: SkillData, unsolvable: readonly SkillName[], partial: GatePairResult): Promise<GatePairResult> {
  const r = partial;
  const arm = async (spec: ArmSpec) => (r.arms[spec.arm] = await runArm(c, spec));
  const rubricPrompt = (t: MethodTaskV3) => armPrompt(t.task, c.skill, 'rubric-one-shot');

  const noSkill = await arm({ arm: 'no-skill', split: 'gate', tasks: d.gate, runs: GATE_RUNS.no_skill, skillText: NO_SKILL_TEXT });
  const seed = await arm({ arm: 'seed', split: 'gate', tasks: d.gate, runs: GATE_RUNS.seed, skillText: d.seed });
  const seedSel = await arm({ arm: 'seed-sel', split: 'sel', tasks: d.sel, runs: GATE_RUNS.seed_sel, skillText: d.seed });
  const trainSpec: ArmSpec = { arm: 'seed-train', split: 'train', tasks: d.train, runs: GATE_RUNS.train, skillText: d.seed };
  const seedTrain = await arm(trainSpec);

  // Both one-shot inputs show the same seed trajectories on train; selection and gate are withheld, and every page train does not show (test's among them) is redacted.
  const ctx = datasetContext(CEILING_DATASET);
  const scope = redactionScope(ctx, d.train, [...d.sel, ...d.gate]);
  const train = seedTrain.substance === null ? null : armRows(c, trainSpec).map(x => trainTrajectory(x.task, x.runs[0]!, armPrompt(x.task.task, c.skill, 'seed')));
  let harnessInput: ReturnType<typeof proposerInput> | null = null;
  let rubricInput: ReturnType<typeof proposerInput> | null = null;
  let inputError: string | null = null;
  try {
    harnessInput = train && proposerInput({ seedText: d.seed, criteria: d.feedback, trajectories: train, ...scope, failedChecks: false });
    rubricInput = train && proposerInput({ seedText: d.seed, criteria: d.criteria, trajectories: train, ...scope });
  } catch (e) {
    inputError = `the proposer input could not be built: ${errMsg(e)}`;
    c.log(`[n15 ceiling] ${c.target} ${c.skill}: ${inputError}; the pair reads errored and no proposer call is made`);
  }
  if (harnessInput) r.texts.proposer_input = harnessInput.text;
  if (rubricInput) r.texts.rubric_input = rubricInput.text;

  const propose = async (id: ProposalId, input: { text: string } | null, system?: string): Promise<ProposalSummary> => {
    if (!input) return { id, outcome: 'not-run', cost_usd: null, retries: 0, error: inputError ?? `the seed's train pass is unscored (${seedTrain.errored_tasks.length} tasks errored)` };
    const input_sha8 = sha8(input.text);
    let row = c.rows.proposal(c.target, c.skill, id);
    if (row && row.outcome !== 'proposer-error' && row.input_sha8 !== input_sha8) throw new Error(`${c.target} ${c.skill} ${id}: the stored proposal was made from input ${row.input_sha8}, but the rows now give ${input_sha8}`);
    if (!row || row.outcome === 'proposer-error') {
      const base = { kind: 'proposal' as const, target: c.target, skill: c.skill, proposal: id, input_sha8 };
      c.log(`[n15 ceiling] ${c.target} ${c.skill} ${id}: proposer call`);
      try {
        const p = await proposeRewrite(input.text, d.seed, { system, onRetry: (attempt, e) => logRetries(c.log)(id, attempt, e) });
        row = { ...base, outcome: p.text ? 'proposed' : 'no-rewrite', ...(p.text ? { text: p.text, text_sha8: sha8(p.text) } : {}), ...(p.error ? { error: p.error } : {}), cost_usd: p.cost_usd, retries: p.retries, stop_reason: p.stop_reason, at: new Date().toISOString() };
      } catch (e) {
        const kind = refusalKind(e);
        if (kind) throw new StageStopped({ kind: kind === 'budget' ? 'budget_exhausted' : 'cell_invalid', target: c.target, skill: c.skill, arm: id, error: errMsg(e) });
        row = { ...base, outcome: 'proposer-error', error: errMsg(e), cost_usd: null, retries: 0, at: new Date().toISOString() };
      }
      c.rows.append(row);
    }
    const summary: ProposalSummary = { id, outcome: row.outcome, cost_usd: row.cost_usd, retries: row.retries, ...(row.error ? { error: row.error } : {}) };
    if (!row.text) return summary;
    r.texts.proposals[id] = row.text;
    const audit = auditSkill(c.skill, row.text, d.seed, CEILING_DATASET);
    return { ...summary, text_sha8: row.text_sha8, audit, outcome: audit.disqualified ? 'audit-disqualified' : 'proposed' };
  };

  // The harness one-shot: two proposals, each clean one scored on selection.
  for (const id of ['proposal-1', 'proposal-2'] as const) {
    const p = await propose(id, harnessInput, ONE_SHOT_SYSTEM_PASS_FAIL);
    r.proposals.push(p);
    if (p.outcome === 'proposed') p.selection = (await arm({ arm: id, split: 'sel', tasks: d.sel, runs: GATE_RUNS.proposal_sel, skillText: r.texts.proposals[id]! })).substance;
  }
  const clean = r.proposals.filter(p => p.outcome === 'proposed');
  const decided = seedSel.substance !== null && clean.every(p => p.selection !== null) && r.proposals.every(p => p.outcome !== 'proposer-error' && p.outcome !== 'not-run');
  if (decided) {
    const best = [...clean].sort((a, b) => b.selection! - a.selection!)[0];
    r.kept = best && best.selection! > seedSel.substance! ? best.id as 'proposal-1' | 'proposal-2' : 'seed';
  }
  const oneShot = r.kept === null ? null : r.kept === 'seed' ? seed
    : await arm({ arm: 'one-shot', split: 'gate', tasks: d.gate, runs: GATE_RUNS.one_shot, skillText: r.texts.proposals[r.kept]! });

  const keptRewrite = await arm({ arm: 'kept-rewrite', split: 'gate', tasks: d.gate, runs: GATE_RUNS.kept_rewrite, skillText: d.kept });
  const rubric = await propose('rubric-one-shot', rubricInput);
  r.proposals.push(rubric);
  const rubricArm = rubric.outcome === 'proposed' ? await arm({ arm: 'rubric-one-shot', split: 'gate', tasks: d.gate, runs: GATE_RUNS.rubric, skillText: r.texts.proposals['rubric-one-shot']!, prompt: rubricPrompt }) : null;
  const reach = await arm({ arm: 'reachability', split: 'gate', tasks: d.gate, runs: GATE_RUNS.reachability, skillText: d.seed, prompt: t => armPrompt(`${t.task}\n\n${reachabilityHint(t)}`, c.skill, 'reachability') });

  r.scores = {
    no_skill: noSkill.substance,
    seed_run1: run1Over(seed, d.gate),
    seed_run2: seed.substance === null ? null : mean(armRows(c, { arm: 'seed', split: 'gate', tasks: d.gate, runs: GATE_RUNS.seed, skillText: d.seed }).map(x => (x.runs[1]!.substance ? 1 : 0))),
    seed: seed.substance,
    seed_trained_families: run1Over(seed, d.gate.filter(t => !t.held_out)),
    seed_held_out_families: run1Over(seed, d.gate.filter(t => t.held_out)),
    seed_selection: seedSel.substance,
    one_shot: oneShot?.substance ?? null,
    kept_rewrite: keptRewrite.substance,
    rubric_one_shot: rubricArm?.substance ?? null,
    reachability: reach.substance,
  };
  const proposerCosts = r.proposals.map(p => p.cost_usd).filter((x): x is number => x !== null);
  r.proposer_usd = proposerCosts.length ? proposerCosts.reduce((a, b) => a + b, 0) : null;
  r.proposer_retries = r.proposals.reduce((n, p) => n + p.retries, 0);

  if (keptRewrite.run1 && seed.run1) {
    const diff = pairedBootstrap(d.gate.map(t => keptRewrite.run1![t.task_id]! - seed.run1![t.task_id]!));
    r.gst956 = { difference: diff && { ...diff, verdict: rewriteVerdict(diff) }, rule: "#304's rewrite rule (test-stage.ts rewriteVerdict): rewrite-beats-seed when the bootstrap lower bound is above 0 and the exact McNemar p is below 0.05, rewrite-worse when the upper bound is below 0 with p below 0.05, else no-difference-shown; never deciding the gate" };
  }

  const harnessOneShot = r.proposals.filter(p => p.id !== 'rubric-one-shot');
  const scored = [noSkill, seed, seedSel, seedTrain, keptRewrite, reach].every(a => a.substance !== null) && oneShot?.substance != null && (rubric.outcome !== 'proposed' || rubricArm?.substance != null)
    && r.proposals.every(p => p.outcome !== 'proposer-error' && p.outcome !== 'not-run');
  if (scored) {
    const decisive = new Map(d.gate.map(t => [t.task_id, decisivePages(t)]));
    const oneShotSpec: ArmSpec = r.kept === 'seed'
      ? { arm: 'seed', split: 'gate', tasks: d.gate, runs: GATE_RUNS.seed, skillText: d.seed }
      : { arm: 'one-shot', split: 'gate', tasks: d.gate, runs: GATE_RUNS.one_shot, skillText: r.texts.proposals[r.kept!]! };
    const failed = armRows(c, oneShotSpec).flatMap(x => x.runs.filter(row => !row!.substance).map(row => ({ row: row!, decisive: decisive.get(x.task.task_id)! })));
    const reachRows = armRows(c, { arm: 'reachability', split: 'gate', tasks: d.gate, runs: 1, skillText: d.seed }).map(x => ({ row: x.runs[0]!, decisive: decisive.get(x.task.task_id)! }));
    const refused = (x: { row: RolloutRow; decisive: string[] }) => refusedDecisiveReads(x.row.tool_calls ?? [], x.decisive).length > 0;
    const limited = failed.filter(x => harnessLimit(x.row, x.decisive) !== null).length;
    const reachRefused = reachRows.filter(x => !x.row.substance && refused(x)).length;
    r.gate_pair = {
      skill: c.skill, target: c.target,
      form_fail: { no_skill: noSkill.form_fail!, seed: seed.form_fail! },
      proposals_passing_audit: harnessOneShot.filter(p => p.outcome === 'proposed').length,
      reachability: reach.substance!,
      limited_share: failed.length ? limited / failed.length : 0,
      refusal_limited: (failed.length > 0 && failed.filter(refused).length / failed.length > GATE.maxLimitedShare) || reachRefused / reachRows.length > 1 - GATE.minReachability,
      one_shot: oneShot!.substance!,
      seed: r.scores.seed_run1!,
    };
    r.label = labelPair(r.gate_pair, unsolvable);
  }
  r.status = scored ? 'scored' : 'errored';
  return r;
}

/** The gate stage for one attempt (see the header). */
export async function runGateStage(o: GateStageOptions): Promise<GateStageResult> {
  const log = o.log ?? (() => {});
  const prices = o.prices ?? { ...PLANNING_PRICES_USD.rollout };
  const ctx = datasetContext(CEILING_DATASET);
  const files_read: GateStageResult['files_read'] = [];
  const path = (s: SkillName, split: string) => `eval/data/${datasetName(CEILING_DATASET)}/${s}/${split}.jsonl`;
  const data = new Map(SKILLS.map(s => {
    files_read.push({ path: path(s, 'train'), use: 'proposer input' }, { path: path(s, 'sel'), use: 'scored' }, { path: path(s, 'gate'), use: 'scored' });
    const train = readTasks(s, 'train', CEILING_DATASET);
    const seed = readSeed(s, CEILING_DATASET);
    return [s, { train, sel: readTasks(s, 'sel', CEILING_DATASET), gate: readSealedTasks(s, 'gate', CEILING_DATASET), seed, kept: readKeptRewrite(s), criteria: readCriteria(s, CEILING_DATASET), feedback: describeJudges(train) }] as const;
  }));
  // Static checks before any paid call: the prompts' contracts are the committed contract.md files, and every text the proposer gets verbatim names no page the train split does not show.
  for (const s of SKILLS) readContract(s);
  for (const [s, d] of data) {
    const { pages } = redactionScope(ctx, d.train, [...d.sel, ...d.gate]);
    try { assertNoHiddenPages(d.seed, d.feedback, pages); assertNoHiddenPages(d.seed, d.criteria, pages); } catch (e) { throw new Error(`${s}: ${errMsg(e)}`); }
  }
  const solv = Object.fromEntries(SKILLS.map(s => [s, solvability(s, data.get(s)!.gate)])) as Record<SkillName, Solvability>;
  const unsolvable = SKILLS.filter(s => !solvable(solv[s]));
  const rows = indexRows(o.rows ?? memoryRows());
  const transport = o.fake ? (o.transport ?? fakeTransport)([...data.values()].flatMap(d => [...d.train, ...d.sel, ...d.gate])) : undefined;
  const pairs: GatePairResult[] = [];
  let stopped: StageStop | null = null;
  let trigger: RepriceStop | null = null;
  let unscored: UnscoredStop | null = null;
  let solNeeded: boolean | null = null;
  let solRan = false;
  const engine = o.engine ?? await openBrain(CEILING_DATASET);
  const observer = o.fake ? null : observeModelRequests();
  const scoredPairs = () => pairs.filter(p => p.gate_pair).map(p => p.gate_pair!);
  try {
    for (const target of FRONTIER_TARGET_NAMES) {
      if (target === 'sol' && !stopped && !trigger && !unscored) {
        if (pairs.some(p => p.target === 'opus' && p.status === 'errored')) {
          for (const skill of SKILLS) { const p = emptyPair(skill, target, 'not-run', 'opus-incomplete'); pairs.push(p); o.onPair?.(p); }
          log(`[n15 ceiling] gate ${o.attempt}: an Opus pair errored, so Sol's gate waits for a --resume that completes Opus first; the stage reads incomplete`);
          continue;
        }
        solNeeded = solGateNeeded({ pairs: scoredPairs(), unsolvable, attempt: o.attempt });
        if (!solNeeded) {
          for (const skill of SKILLS) { const p = emptyPair(skill, target, 'not-run', 'sol-gate-not-needed'); pairs.push(p); o.onPair?.(p); }
          log(`[n15 ceiling] gate ${o.attempt}: Sol's gate is not needed (no Opus pair has headroom and the Opus pairs read saturated)`);
          continue;
        }
        solRan = true;
      }
      await withProbeGateway({ chatModel: FRONTIER_TARGETS[target], fake: o.fake, transport, keys: [...new Set([TARGET_KEY[target], 'ANTHROPIC_API_KEY'])] }, async () => {
        for (const skill of SKILLS) {
          if (stopped || trigger || unscored) { const p = emptyPair(skill, target, 'not-run', stopped ? 'stage-stopped' : unscored ? 'unscored-spend' : 'reprice-trigger'); pairs.push(p); o.onPair?.(p); continue; }
          const c: PairContext = { engine, target, skill, rows, log };
          const partial = emptyPair(skill, target, 'errored');
          let pair: GatePairResult;
          try {
            pair = await runPair(c, data.get(skill)!, unsolvable, partial);
          } catch (e) {
            if (!(e instanceof StageStopped)) throw e;
            stopped = e.stop;
            pair = { ...partial, status: 'stopped' };
            log(`[n15 ceiling] gate ${o.attempt}: ${e.message}; the stage stops and reads incomplete`);
          }
          pair.cost = summarizeMeter(sumMeters(Object.values(pair.arms).map(a => a!.cost)));
          pairs.push(pair);
          o.onPair?.(pair);
          log(`[n15 ceiling] gate ${o.attempt} ${target} ${skill}: ${pair.status}${pair.label ? `, ${pair.label}` : ''}; one-shot ${pair.scores.one_shot ?? 'n/a'} (kept ${pair.kept ?? 'undecided'}), seed ${pair.scores.seed_run1 ?? 'n/a'}, reachability ${pair.scores.reachability ?? 'n/a'}`);
          if (stopped) continue;
          const window = meterOfRows(rows.fresh(target));
          const meanUsd = window.rollouts ? window.usd / window.rollouts : null;
          const threshold = REPRICE_FACTOR * prices[target];
          if (meanUsd === null && window.calls > 0) {
            unscored = { reason: 'unscored-spend', target, skill, usd: window.usd };
            log(`[n15 ceiling] unscored spend: this window billed $${window.usd.toFixed(4)} on ${target} over ${window.calls} calls and scored no rollout; the stage stops after this pair, and a --resume opens a new window`);
          } else if (meanUsd !== null && meanUsd > threshold) {
            trigger = { reason: 'reprice-trigger', target, skill, mean_rollout_usd: meanUsd, threshold_usd: threshold };
            log(`[n15 ceiling] reprice trigger: this window's billed spend per scored ${target} rollout, voided included, is $${meanUsd.toFixed(4)}, above $${threshold.toFixed(4)} (1.25 x $${prices[target].toFixed(4)}); the stage stops after this pair`);
          }
        }
      });
    }
  } finally {
    observer?.stop();
    if (!o.engine) await engine.disconnect().catch(() => {});
  }
  return {
    mode: o.fake ? 'fake' : 'live', stage: 'gate', attempt: o.attempt,
    dataset: datasetName(CEILING_DATASET), dataset_manifest_sha256: ctx.manifest_sha256,
    models: { targets: FRONTIER_TARGETS, proposer: PROPOSER_MODEL }, runs: GATE_RUNS, prices, estimate_usd: gateEstimateUsd(prices),
    pairs, sol_gate: { needed: solNeeded, ran: solRan }, solvability: solv, unsolvable,
    verdict: gateVerdict({ pairs: scoredPairs(), unsolvable, budget_stop: !!stopped, attempt: o.attempt }),
    stopped, reprice_trigger: trigger, unscored_spend: unscored,
    voided: Object.fromEntries(FRONTIER_TARGET_NAMES.map(t => [t, voidedOf(pairs.filter(p => p.target === t))])) as Record<FrontierTarget, VoidedSpend>,
    files_read, models_not_run: MODELS_NOT_RUN, retrieval: RETRIEVAL,
    request_settings: observer ? observer.settings() : null,
  };
}
