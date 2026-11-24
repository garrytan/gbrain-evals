/**
 * The weekly outcome line's cell set (docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md, "Systems",
 * "Readers and judges" and harness item 3): gbrain, the two memory servers and the grep agent on one week's Set W worlds,
 * with both readers and their judges, built with BG1-C's tooling (definitions.ts makeCell and definitionProblems, bg1c.ts
 * rates and launch), so a weekly cell is a valid Q1 cell definition. Running one is the weekly runner's job: cell.ts gives
 * BG1's paid-window gate, world-end clock and Gemini key handling only to isBg1Benchmark's benchmarks, which bgw is not
 * yet, so the runner wires those for Set W before any weekly cell runs.
 *
 *   G8  gbrain-defaults, configuration rs1-stable as BG1-C's arm P ran it (default fact extraction with name tags,
 *       `query` with the facts block, an 8,000-token read), at the gbrain build the week passes in.
 *   EF  the extract-first server (ext-extract-first, common) at 8,000 tokens; its shipped extraction model is
 *       system-internal.
 *   MB  the memory-bank server (ext-memory-bank, recipe) at 8,000 tokens; its shipped extraction model is
 *       system-internal.
 *   FS  the grep agent (baseline-file-agent, eval/runner/systems/file-agent.ts) in agent mode, at most 40 turns, ripgrep
 *       required (the launch check refuses without it; its version is in the cell's capability receipt).
 *
 * Readers: claude-opus-5-5 reads every 8,000-token context live, and particle-1 re-reads the same frozen context byte for
 * byte afterwards (weeklyLineRereadPlans, eval/runner/q1/reread-cell.ts), both at effort medium with particle-1's output
 * floor, as BG1-C did. On FS each reader is the agent. Judges (R78, R116): every answer gets one gating judge by its
 * reader's family (bg1JudgeOf): gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for particle-1, pinned to
 * PER_READER_JUDGE_SETTINGS. No answer gets a canonical or descriptive judge (descriptive_view false).
 *
 * The gbrain build is never pinned here. Each week runs gbrain's newest release at launch, so the runner resolves the
 * release tag and passes it in, with the week (its Tuesday launch, its world end and its Set W batch) and the week's
 * worlds. A week is one launch unit per cell (one shard): the worlds are the cell's `week.worlds`, which the runner passes
 * to Set W's loader (corpus.ts loadBgw, GBRAIN_EVALS_BGW_UNIT).
 *
 * Money: BG1-C's measured rates per world (bg1c.ts BG1C_RATES) for G8, EF and MB (each row's ingest, Opus's reads and
 * Astra's grading) and particle-1's re-reads; FS at the file agent's per-answer token assumption from the SOTA dev test,
 * which the pilot replaces with its measured cost, plus BG1's measured gating-judge rates. Estimates assume a full week.
 */
import { bgwBatchIds, bgwSlotOf, BGW_WORLDS_PER_WEEK } from '../../memory-qa/bg1-names.ts';
import { bgwWeekWorldEnd } from '../../memory-qa/corpus.ts';
import { COMPAT_PROVIDERS } from '../../providers/openai-compatible.ts';
import { FILE_AGENT_MAX_TURNS } from '../../systems/file-agent.ts';
import {
  ALL_SETS, BG1_MEASURED, bg1JudgeOf, F6_ASSUMPTIONS, f6ExtractionLedgerUsd, makeCell, PER_READER_JUDGE_SETTINGS, priceOf, SOTA_ASSUMPTIONS,
  type ArmDefinition, type ArmSpec, type CellDefinition, type CellEstimate,
} from './definitions.ts';
import { OPUS, PARTICLE, type RereadPlan } from './bg1.ts';
import { BG1C_GBRAIN_LAUNCH, BG1C_RATES, BG1C_WORLD_RATIO } from './bg1c.ts';
import { F6_ARMS } from './f6.ts';

export const WEEKLY_LINE_PREREGISTRATION = 'docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md';
export const WEEKLY_LINE_REGISTRY = 'docs/benchmarks/preregistrations.d/weekly-outcome-line.json';
/** Both readers, on every row. */
export const WEEKLY_LINE_READERS = [OPUS, PARTICLE] as const;
/** Each reader's gating judge (bg1JudgeOf): gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for particle-1. */
export const WEEKLY_LINE_JUDGE_BY_READER: Readonly<Record<string, string>> = Object.fromEntries(WEEKLY_LINE_READERS.map(r => [r, bg1JudgeOf(r)]));
/** The effort every reader and agent sends, as BG1-C fixed it for every reader. */
export const WEEKLY_LINE_EFFORT = 'medium';
/** particle-1's output limit on its re-reads: its provider row's output floor, which leaves room for its reasoning, as BG1-C's re-reads sent it. */
export const WEEKLY_LINE_PARTICLE_MAX_TOKENS = COMPAT_PROVIDERS.particle.models['particle-1'].output_floor;

/**
 * The four rows, keyed by the preregistration's row names (weekly-line/design.ts WL_ROWS): each row's system and
 * configuration, and the mode and reading budget of its one arm (an 8,000-token read, or the grep agent with none).
 */
export const WEEKLY_LINE_ROWS = {
  gbrain: { system: 'gbrain-defaults', configuration: 'rs1-stable', mode: 'packed', budget: 8000 },
  'grep-agent': { system: 'baseline-file-agent', configuration: 'baseline', mode: 'agent', budget: null },
  'extract-first': { system: 'ext-extract-first', configuration: 'common', mode: 'packed', budget: 8000 },
  'memory-bank': { system: 'ext-memory-bank', configuration: 'recipe', mode: 'packed', budget: 8000 },
} as const;

/**
 * The two servers as the week records them (weekly-line/aggregates.ts meta `comparators`): each bundle's package version and
 * the date its lock was last fixed, the patched locks of gbrain-evals#594 (GBEV-3 ruling, 2026-11-23).
 */
export const WEEKLY_LINE_COMPARATORS = {
  'extract-first': { version: '2.2.1', fixed: '2026-11-23' },
  'memory-bank': { version: '0.10.2', fixed: '2026-11-23' },
} as const;

/** One model of a registry entry's `models` list. */
export interface RegistryModel { model: string; role: string; system?: string }

/**
 * Every model the weekly cells call, with its role, as the registry entry lists them (WEEKLY_LINE_REGISTRY `models`, less
 * its simulators, which are the mint's): the readers under test, their judges, and each compared system's shipped models
 * as system-internal. gpt-4o-mini is the memory-bank server's shipped extraction model, tested as shipped; no gpt-4o
 * model sits in a role we choose. The extract-first server's `common` setup also embeds with text-embedding-3-large
 * (eval/systems/extract-first/shim.py memory_config); the registry entry lists it from launch amendment A, and until
 * then the launch check refuses.
 */
export const WEEKLY_LINE_MODELS: ReadonlyArray<RegistryModel> = [
  ...WEEKLY_LINE_READERS.map(model => ({ model, role: 'under-test' })),
  ...[...new Set(Object.values(WEEKLY_LINE_JUDGE_BY_READER))].map(model => ({ model, role: 'judge' })),
  { model: 'openai:gpt-4.1-mini', role: 'system-internal', system: 'ext-extract-first' },
  { model: 'openai:text-embedding-3-large', role: 'system-internal', system: 'ext-extract-first' },
  { model: 'openai:gpt-4o-mini', role: 'system-internal', system: 'ext-memory-bank' },
  { model: F6_ASSUMPTIONS.extraction.model, role: 'system-internal', system: 'gbrain-defaults' },
  { model: F6_ASSUMPTIONS.embedding_model, role: 'system-internal', system: 'gbrain-defaults' },
];

/** The week a set of cells runs: its Tuesday launch (YYYY-MM-DD), its world end (the Sunday before) and its Set W batch (the batch's first world id, bgw-1001 for the first). */
export interface WeeklyLineWeek { launch: string; world_end: string; batch: string }
/** The gbrain build a week runs: the newest release tag on gbrain's master at launch and its full commit. */
export interface WeeklyLineGbrainBuild { release: string; commit: string }
/** The generator's input: the week, its worlds in slot order (up to 8 of the batch's), and the gbrain build. */
export interface WeeklyLineInput { week: WeeklyLineWeek; worlds: readonly string[]; gbrain: WeeklyLineGbrainBuild }

/**
 * Why a week and its worlds can't run: a launch that isn't a Tuesday, a world end that isn't the Sunday before it, a batch
 * or a world outside Set W, a repeated world, worlds out of slot order, or more than a week's worlds. Empty when they can.
 */
export function weeklyLineWeekProblems(week: WeeklyLineWeek, worlds: readonly string[]): string[] {
  const p: string[] = [];
  let end: string | null = null;
  try { end = bgwWeekWorldEnd(week.launch); } catch (e) { p.push((e as Error).message); }
  if (end !== null && week.world_end !== end) p.push(`week ${week.launch}: world end ${week.world_end} is not ${end}, the Sunday before its Tuesday launch`);
  const first = bgwSlotOf(week.batch);
  let batch: string[] = [];
  if (first === null) p.push(`batch ${JSON.stringify(week.batch)} is not a Set W world id (bgw- and four digits)`);
  else try { batch = bgwBatchIds(first); } catch (e) { p.push((e as Error).message); }
  if (!(worlds.length >= 1 && worlds.length <= BGW_WORLDS_PER_WEEK)) p.push(`a week runs 1 to ${BGW_WORLDS_PER_WEEK} worlds, not ${worlds.length}`);
  if (new Set(worlds).size !== worlds.length) p.push('the week names a world twice');
  const outside = worlds.filter(w => bgwSlotOf(w) === null || (batch.length > 0 && !batch.includes(w)));
  if (outside.length) p.push(`world(s) ${outside.join(', ')} are not Set W worlds of batch ${week.batch}`);
  if (worlds.some((w, i) => i > 0 && (bgwSlotOf(w) ?? 0) <= (bgwSlotOf(worlds[i - 1]) ?? 0))) p.push("the week's worlds are not in slot order");
  return p;
}

/** Why a gbrain build can't be recorded: a release that isn't a version tag or a commit that isn't a full 40-hex sha. Empty when it can. */
export function weeklyLineBuildProblems(gbrain: WeeklyLineGbrainBuild): string[] {
  return [
    ...(/^v\d+(\.\d+)+$/.test(gbrain.release ?? '') ? [] : [`gbrain release ${JSON.stringify(gbrain.release)} is not a version tag (v<major>.<minor>...)`]),
    ...(/^[0-9a-f]{40}$/.test(gbrain.commit ?? '') ? [] : [`gbrain commit ${JSON.stringify(gbrain.commit)} is not a full 40-character sha`]),
  ];
}

const round = (x: number) => Math.round(x * 100) / 100;
const estimateOf = (lines: Record<string, number>): CellEstimate => ({
  usd: round(Object.values(lines).reduce((s, v) => s + v, 0)),
  lines: Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, round(v)])),
});
const listUsd = (model: string, input: number, output: number) => { const p = priceOf(model); return (input * p.input + output * p.output) / 1e6; };
/** The file agent's tokens per answer: the SOTA dev test's assumption for the same loop, until the pilot measures it on Set W's worlds. */
export const WEEKLY_LINE_FILE_AGENT_TOKENS = { input: SOTA_ASSUMPTIONS.agent['baseline-file-agent']['SOTA-dev'] as number, output: SOTA_ASSUMPTIONS.agent['baseline-file-agent'].output as number };

/** A weekly cell's estimate for a full week: BG1-C's rate per world for an 8,000-token row, else the file agent's reads and their gating judges. */
function weeklyEstimate(c: CellDefinition): CellEstimate {
  const s = ALL_SETS[c.set], key = `${c.system}:${c.configuration}`;
  if (c.system !== 'baseline-file-agent') {
    const row = BG1C_RATES.row_usd_per_world[key];
    if (!(row > 0)) throw new Error(`the weekly line has no rate for ${key} (BG1C_RATES.row_usd_per_world)`);
    return estimateOf({ row_dev_rate: s.conversations * row });
  }
  const t = WEEKLY_LINE_FILE_AGENT_TOKENS;
  return estimateOf({
    agent: WEEKLY_LINE_READERS.reduce((n, r) => n + s.questions * listUsd(r, t.input, t.output), 0),
    frontier_judges: WEEKLY_LINE_READERS.reduce((n, r) => n + s.questions * BG1_MEASURED.judge_usd_per_call[WEEKLY_LINE_JUDGE_BY_READER[r]], 0),
  });
}

/** gbrain's extraction cap per world, as BG1-C sets it: twice the largest world's extraction at gbrain's own ledger rate, at least $1, rounded up. */
const extractionCapUsd = () => {
  const s = ALL_SETS.BGW;
  return Math.max(1, Math.ceil(F6_ASSUMPTIONS.extraction_cap_multiple * f6ExtractionLedgerUsd(s.corpus_tokens / s.conversations * BG1C_WORLD_RATIO)));
};

const perReader = (readers: readonly string[]): NonNullable<ArmDefinition['frontier']> => ({
  judges: [...new Set(readers.map(r => WEEKLY_LINE_JUDGE_BY_READER[r]))].sort(), readers: null, sample: null, per_reader: true,
  judge_by_reader: Object.fromEntries(readers.map(r => [r, WEEKLY_LINE_JUDGE_BY_READER[r]])), settings: { ...PER_READER_JUDGE_SETTINGS },
});
/** The 8,000-token rows are read live by claude-opus-5-5; particle-1 re-reads them (weeklyLineRereadPlans). */
const LIVE = [OPUS];
const R = WEEKLY_LINE_ROWS;
const ARMS: Record<keyof typeof WEEKLY_LINE_ROWS, () => ArmSpec> = {
  gbrain: () => ({ id: 'p', mode: R.gbrain.mode, budget: R.gbrain.budget, label: F6_ARMS.p.label, retrieval: F6_ARMS.p.retrieval, readers: [...LIVE], frontier: perReader(LIVE) }),
  'grep-agent': () => ({ id: 'whole-agent', mode: R['grep-agent'].mode, label: `grep agent, uncapped ripgrep, ${FILE_AGENT_MAX_TURNS} turns`, readers: [...WEEKLY_LINE_READERS], frontier: perReader(WEEKLY_LINE_READERS) }),
  'extract-first': () => ({ id: 'component-b8000', mode: R['extract-first'].mode, budget: R['extract-first'].budget, label: 'component, 8,000 tokens', readers: [...LIVE], frontier: perReader(LIVE) }),
  'memory-bank': () => ({ id: 'component-b8000', mode: R['memory-bank'].mode, budget: R['memory-bank'].budget, label: 'component, 8,000 tokens', readers: [...LIVE], frontier: perReader(LIVE) }),
};

/**
 * One week's cells, in WEEKLY_LINE_ROWS order: G8, FS, EF and MB on the week's Set W worlds, gbrain at `gbrain`. Throws on
 * a week, world list or build that weeklyLineWeekProblems or weeklyLineBuildProblems rejects.
 */
export function generateWeeklyLineCells(input: WeeklyLineInput): CellDefinition[] {
  const { week, worlds, gbrain } = input;
  const problems = [...weeklyLineWeekProblems(week, worlds), ...weeklyLineBuildProblems(gbrain)];
  if (problems.length) throw new Error(`the weekly line can't build week ${week.launch}: ${problems.join('; ')}`);
  return (Object.keys(WEEKLY_LINE_ROWS) as Array<keyof typeof WEEKLY_LINE_ROWS>).map(row => {
    const { system, configuration } = WEEKLY_LINE_ROWS[row];
    const g8 = system === 'gbrain-defaults';
    const made = makeCell('BGW', system, configuration, [ARMS[row]()], {
      probes: { sample: 0, seed: 'weekly-line-probes', conversations: 0 }, descriptiveView: false,
      ...(system === 'baseline-file-agent' ? { runner: 'in-process' as const } : {}),
      ...(g8 ? { launch: { env: { ...BG1C_GBRAIN_LAUNCH.env, GBRAIN_SHA: gbrain.commit }, config: BG1C_GBRAIN_LAUNCH.config }, launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd()) } } : {}),
    });
    const hours = BG1_MEASURED.hours_per_mtok[`${system}:${configuration}`];
    const def: CellDefinition = {
      ...made, canonical_instrument: 'bg1', effort: WEEKLY_LINE_EFFORT, shards: 1,
      expected_hours: hours ? Math.ceil(hours * ALL_SETS.BGW.corpus_tokens / 1e6 * BG1C_WORLD_RATIO) : made.expected_hours,
      week: { ...week, worlds: [...worlds] }, ...(g8 ? { gbrain_build: { release: gbrain.release, commit: gbrain.commit } } : {}),
    };
    return { ...def, estimate: weeklyEstimate(def) };
  });
}

export interface WeeklyLineRereadPlan extends RereadPlan {
  /** The week's worlds, whose frozen contexts the plan re-reads. */
  worlds: string[];
  effort: typeof WEEKLY_LINE_EFFORT;
  /** particle-1's output limit (WEEKLY_LINE_PARTICLE_MAX_TOKENS). */
  max_tokens: number;
}

/**
 * particle-1's re-reads (eval/runner/q1/reread-cell.ts): every frozen 8,000-token context of G8, EF and MB read once by
 * particle-1 and graded by its gating judge (claude-opus-5-5), priced at BG1 wave B's measured rates per answer. FS has
 * none, because particle-1 is that row's agent.
 */
export function weeklyLineRereadPlans(cells: readonly CellDefinition[]): WeeklyLineRereadPlan[] {
  return cells.flatMap(c => c.arms.filter(a => a.mode === 'packed').map(a => {
    const answers = ALL_SETS[c.set].questions;
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block,
      judges: [WEEKLY_LINE_JUDGE_BY_READER[PARTICLE]], worlds: [...(c.week?.worlds ?? [])], effort: WEEKLY_LINE_EFFORT, max_tokens: WEEKLY_LINE_PARTICLE_MAX_TOKENS,
      estimate: estimateOf({ readers: answers * BG1C_RATES.particle_read_usd_per_answer, frontier_judges: answers * BG1C_RATES.particle_judge_usd_per_answer }) };
  }));
}
