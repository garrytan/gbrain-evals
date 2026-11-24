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
 *
 * World length: a week's batch names its seed set, and the seed set its length profile (bg1-names.ts BGW_SEED_SETS), so a
 * W1 week runs set BGW (about 200,000 tokens a world) and a W1-long week runs set BGW-long (about 1,000,000). Each
 * 8,000-token row's rate is BG1-C's at 200,000 tokens plus the part that grows with a world's tokens, its ingest at BG1's
 * measured rate per million tokens (and gbrain's fact extraction at F6's), over the tokens past 200,000; reads and judging
 * stay per question. The grep agent's tokens per answer stay as they are: the SOTA dev test measured them on BEAM-1M
 * histories, about 1,000,000 tokens each. VM hours and gbrain's extraction cap follow the set's tokens. At 200,000 tokens
 * every rate is BG1-C's as before.
 */
import { bgwBatchIds, bgwProfileOf, bgwSlotOf, BGW_CAMPAIGN, BGW_WORLDS_PER_WEEK } from '../../memory-qa/bg1-names.ts';
import { bgwWeekWorldEnd } from '../../memory-qa/corpus.ts';
import { COMPAT_PROVIDERS } from '../../providers/openai-compatible.ts';
import { FILE_AGENT_MAX_TURNS } from '../../systems/file-agent.ts';
import {
  ALL_SETS, ASSUMPTIONS, BG1_MEASURED, bg1JudgeOf, F6_ASSUMPTIONS, f6ExtractionLedgerUsd, f6ExtractionUsd, makeCell, MANIFEST_SCHEMA, PER_READER_JUDGE_SETTINGS, priceOf, SOTA_ASSUMPTIONS, WEEKLY_LINE_SETS,
  type ArmDefinition, type ArmSpec, type CellDefinition, type CellEstimate, type Manifest, type WeeklyLineSetId,
} from './definitions.ts';
import { listPrice, OPUS, PARTICLE, type RereadPlan } from './bg1.ts';
import { priceRequest, reservationUsd } from '../../budget-ledger.ts';
import { BG1_JUDGE_PROMPT, BG1_ORDERED_RULE } from '../../memory-qa/instruments.ts';
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

/**
 * The bundle locks the line runs on (GBEV-3 ruling, 2026-11-23): gbrain-evals#594's patched locks, extract-first
 * 9c32b495 and memory-bank 29b875e0, each the SHA-256 of a committed uv.lock as #594's relock and the comparison pin table
 * (docs/comparison-systems.md) record it. Both copies are checked: the pin table's lock_file and the shim's own lock,
 * which the cell's machine builds from. BG1-C ran on the earlier locks 9777b7a8 and f54d89df.
 */
export const WEEKLY_LINE_BUNDLE_LOCKS: Readonly<Record<string, { sha256: string; files: readonly string[] }>> = {
  'ext-extract-first': { sha256: '9c32b495ffd262519959b9d00c5d7b7a3db453765c5a6c9324008bc3e5fbaeae', files: ['docs/comparison-systems/ext-extract-first/uv.lock', 'eval/systems/extract-first/uv.lock'] },
  'ext-memory-bank': { sha256: '29b875e0c591f5314b095923a248b5c8c02e85686d8699c517270ad508327ddf', files: ['docs/comparison-systems/ext-memory-bank/uv.lock', 'eval/systems/memory-bank/uv.lock'] },
};

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

/**
 * The grep agent's wall time per answer, its gating judgment included, in seconds: an assumption, because neither the
 * SOTA dev test nor any earlier file-agent run records one (SOTA_ASSUMPTIONS holds tokens per answer only: 73,000 in and
 * 2,000 out, over at most 40 turns). 90 s is a 40-turn loop's typical dozen turns at several seconds a turn, plus the
 * judge call; the pilot measures it on Set W's dev world and a dated amendment replaces it.
 */
export const WEEKLY_LINE_FILE_AGENT_SECONDS_PER_ANSWER = 90;
/** The margin on the grep agent's hours, over the per-answer assumption. */
export const WEEKLY_LINE_FILE_AGENT_HOURS_MARGIN = 1.5;
/**
 * The grep agent cell's expected hours: every answer of the week (its worlds times 64 questions times both readers, run
 * one after another in the cell) at the per-answer assumption, times the margin, rounded up. A full week is 1,024 answers,
 * 39 hours, so its VM timeout (cell.ts plan: 1.5 times the expected hours plus 2, at most 72) is 61 hours.
 */
export const weeklyLineFileAgentHours = (worlds: number) =>
  Math.ceil(worlds * (ALL_SETS.BGW.questions / ALL_SETS.BGW.conversations) * WEEKLY_LINE_READERS.length * WEEKLY_LINE_FILE_AGENT_SECONDS_PER_ANSWER * WEEKLY_LINE_FILE_AGENT_HOURS_MARGIN / 3600);

/** The two counted sets a week can run: W1's about 200,000-token worlds, or W1-long's about 1,000,000-token worlds. */
export type WeeklyLineCountedSet = 'BGW' | 'BGW-long';
/** The counted set a week's batch runs: its seed set's length profile picks BGW or BGW-long. */
export const weeklyLineSetOf = (batch: string): WeeklyLineCountedSet => {
  const first = bgwSlotOf(batch);
  if (first === null) throw new Error(`batch ${JSON.stringify(batch)} is not a Set W world id (bgw- and four digits)`);
  return bgwProfileOf(first) === 'long' ? 'BGW-long' : 'BGW';
};

/** The world length BG1-C's per-world rates were measured at (bg1c.ts BG1C_RATES, its sets' 200,000 tokens a world). */
export const WEEKLY_LINE_RATE_WORLD_TOKENS = 200_000;
/** An 8,000-token row's ingest for one world of `tokens`: BG1's measured ingest per million tokens, and for gbrain its fact extraction at F6's rate. */
const ingestUsd = (key: string, tokens: number) => (BG1_MEASURED.ingest_usd_per_mtok[key] ?? 0) * tokens / 1e6 + (key === 'gbrain-defaults:rs1-stable' ? f6ExtractionUsd(tokens) : 0);

/**
 * A weekly cell's estimate for a full week: BG1-C's rate per world for an 8,000-token row, plus its ingest over the
 * world's tokens past 200,000 (ingest_past_rate) when the set's worlds are longer; else the file agent's reads and their
 * gating judges.
 */
function weeklyEstimate(c: Pick<CellDefinition, 'set' | 'system' | 'configuration'>): CellEstimate {
  const s = ALL_SETS[c.set], key = `${c.system}:${c.configuration}`;
  if (c.system !== 'baseline-file-agent') {
    const row = BG1C_RATES.row_usd_per_world[key];
    if (!(row > 0)) throw new Error(`the weekly line has no rate for ${key} (BG1C_RATES.row_usd_per_world)`);
    const tokens = s.corpus_tokens / s.conversations;
    const more = tokens > WEEKLY_LINE_RATE_WORLD_TOKENS ? ingestUsd(key, tokens) - ingestUsd(key, WEEKLY_LINE_RATE_WORLD_TOKENS) : 0;
    return estimateOf({ row_dev_rate: s.conversations * row, ...(more > 0 ? { ingest_past_rate: s.conversations * more } : {}) });
  }
  const t = WEEKLY_LINE_FILE_AGENT_TOKENS;
  return estimateOf({
    agent: WEEKLY_LINE_READERS.reduce((n, r) => n + s.questions * listUsd(r, t.input, t.output), 0),
    frontier_judges: WEEKLY_LINE_READERS.reduce((n, r) => n + s.questions * BG1_MEASURED.judge_usd_per_call[WEEKLY_LINE_JUDGE_BY_READER[r]], 0),
  });
}

/** gbrain's extraction cap per world, as BG1-C sets it: twice the largest world's extraction at gbrain's own ledger rate, at least $1, rounded up. */
const extractionCapUsd = (set: WeeklyLineSetId) => {
  const s = ALL_SETS[set];
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

type WeeklyLineRow = keyof typeof WEEKLY_LINE_ROWS;
const WL_ROW_OF = Object.fromEntries((Object.keys(WEEKLY_LINE_ROWS) as WeeklyLineRow[]).map(r => [WEEKLY_LINE_ROWS[r].system, r])) as Record<string, WeeklyLineRow>;
/** Where a set of the line's cells runs: one week of Set W (BGW, or BGW-long for a W1-long batch), or the public dev worlds of the pilot (BGW-pilot) or the judge check (BGW-judge). */
type WeeklyLineTarget = { set: WeeklyLineCountedSet; week: WeeklyLineWeek; worlds: readonly string[] } | { set: 'BGW-pilot' | 'BGW-judge' };

/**
 * The line's cells for one target, in WEEKLY_LINE_ROWS order over `rows`: the counted week and the public-world runs are
 * built here alone, so a pilot cell differs from a counted one only in its set (and with it its loader and worlds) and in
 * the gbrain build passed in. `gbrain` is needed only when `rows` holds the gbrain row.
 */
function weeklyLineCells(target: WeeklyLineTarget, gbrain: WeeklyLineGbrainBuild | null, rows: readonly WeeklyLineRow[]): CellDefinition[] {
  const worlds = 'week' in target ? target.worlds.length : ALL_SETS[target.set].conversations;
  return rows.map(row => {
    const { system, configuration } = WEEKLY_LINE_ROWS[row];
    const g8 = system === 'gbrain-defaults';
    if (g8 && !gbrain) throw new Error(`the weekly line's gbrain row on ${target.set} needs the gbrain build it runs`);
    const made = makeCell(target.set, system, configuration, [ARMS[row]()], {
      probes: { sample: 0, seed: 'weekly-line-probes', conversations: 0 }, descriptiveView: false,
      ...(system === 'baseline-file-agent' ? { runner: 'in-process' as const } : {}),
      ...(g8 ? { launch: { env: { ...BG1C_GBRAIN_LAUNCH.env, GBRAIN_SHA: gbrain!.commit }, config: BG1C_GBRAIN_LAUNCH.config }, launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(target.set)) } } : {}),
    });
    const hours = BG1_MEASURED.hours_per_mtok[`${system}:${configuration}`];
    const def: CellDefinition = {
      ...made, canonical_instrument: 'bg1', effort: WEEKLY_LINE_EFFORT, shards: 1,
      expected_hours: system === 'baseline-file-agent' ? weeklyLineFileAgentHours(worlds) : hours ? Math.ceil(hours * ALL_SETS[target.set].corpus_tokens / 1e6 * BG1C_WORLD_RATIO) : made.expected_hours,
      ...('week' in target ? { week: { ...target.week, worlds: [...target.worlds] } } : {}), ...(g8 ? { gbrain_build: { release: gbrain!.release, commit: gbrain!.commit } } : {}),
    };
    return { ...def, estimate: weeklyEstimate(def) };
  });
}

/**
 * One week's cells, in WEEKLY_LINE_ROWS order: G8, FS, EF and MB on the week's Set W worlds, gbrain at `gbrain`, on the
 * counted set its batch's length picks (weeklyLineSetOf). Throws on a week, world list or build that weeklyLineWeekProblems
 * or weeklyLineBuildProblems rejects.
 */
export function generateWeeklyLineCells(input: WeeklyLineInput): CellDefinition[] {
  const { week, worlds, gbrain } = input;
  const problems = [...weeklyLineWeekProblems(week, worlds), ...weeklyLineBuildProblems(gbrain)];
  if (problems.length) throw new Error(`the weekly line can't build week ${week.launch}: ${problems.join('; ')}`);
  return weeklyLineCells({ set: weeklyLineSetOf(week.batch), week, worlds }, gbrain, Object.keys(WEEKLY_LINE_ROWS) as WeeklyLineRow[]);
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
 * none, because particle-1 is that row's agent. A pilot's re-read reads its dev world (the cell's only_conversations).
 */
export function weeklyLineRereadPlans(cells: readonly CellDefinition[]): WeeklyLineRereadPlan[] {
  return cells.flatMap(c => c.arms.filter(a => a.mode === 'packed').map(a => {
    const answers = ALL_SETS[c.set].questions;
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block,
      judges: [WEEKLY_LINE_JUDGE_BY_READER[PARTICLE]], worlds: [...(c.week?.worlds ?? c.only_conversations ?? [])], effort: WEEKLY_LINE_EFFORT, max_tokens: WEEKLY_LINE_PARTICLE_MAX_TOKENS,
      estimate: estimateOf({ readers: answers * BG1C_RATES.particle_read_usd_per_answer, frontier_judges: answers * BG1C_RATES.particle_judge_usd_per_answer }) };
  }));
}

// ─── The pilot and the judge check on public dev worlds (R111, R78) ──

/** The cents below (floor) and above (ceil) an amount, so a cap never rounds up past its line and an estimate never rounds down. */
const floorCents = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
const ceilCents = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;
const rereadUsdPerAnswer = () => BG1C_RATES.particle_read_usd_per_answer + BG1C_RATES.particle_judge_usd_per_answer;

/**
 * Each row's planned dollars per world on a counted set, the unit of its block budget: the row's full-week cell estimate
 * per world (weeklyEstimate: BG1-C's measured rate for an 8,000-token row with its longer worlds' extra ingest, the file
 * agent's token assumption and BG1's gating-judge rates for the grep agent) plus particle-1's re-read of one world's 64
 * frozen contexts on an 8,000-token row.
 */
export function weeklyLineRates(set: WeeklyLineCountedSet): Record<WeeklyLineRow, number> {
  return Object.fromEntries((Object.keys(WEEKLY_LINE_ROWS) as WeeklyLineRow[]).map(row => {
    const { system, configuration, mode } = WEEKLY_LINE_ROWS[row], s = ALL_SETS[set], perWorld = s.questions / s.conversations;
    return [row, weeklyEstimate({ set, system, configuration }).usd / s.conversations + (mode === 'packed' ? perWorld * rereadUsdPerAnswer() : 0)];
  })) as Record<WeeklyLineRow, number>;
}
/** The rates of set BGW, W1's 200,000-token worlds. */
export const WEEKLY_LINE_RATES: Readonly<Record<WeeklyLineRow, number>> = weeklyLineRates('BGW');
/**
 * A block's worlds (four weeks of eight), the multiple of a row's rate that makes its block budget; weekly-line/design.ts
 * WL_BLOCK_WORLDS, restated here because the cell runner's frozen paths don't include the design module.
 */
export const WEEKLY_LINE_BLOCK_WORLDS = BGW_WORLDS_PER_WEEK * 4;
/** R111: each row's pilot spends at most this share of its block budget. */
export const WEEKLY_LINE_PILOT_FRACTION = 0.1;
/** The grep agent's judge check pauses here: its cells and the labelling pass together. */
export const WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD = 100;
/** Labelled answers per judge the judge check draws (R78 for a plan frozen on or after 2026-11-22). */
export const WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE = 100;
/**
 * The labelling pass's ledger cap: gemini-3.8-flash grading at most every sampled answer at BG1's measured canonical
 * rate per call, twice over for margin, at least $1. The judge check's cells take the rest of its pause.
 */
export const WEEKLY_LINE_LABEL_CAP_USD = Math.max(1, ceilCents(2 * WEEKLY_LINE_READERS.length * WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE * BG1_MEASURED.canonical_judge_usd_per_call));
/**
 * The Claude Code quick look (R112): its cap, and why it doesn't run from this harness. The repository's Claude Code
 * runners (Cat 41's container, T0's parity slice) drive gbrain through its MCP server and hooks; none answers questions
 * over the chats as files with a judged record, so the quick look would need a new runner, not an adapter.
 */
export const WEEKLY_LINE_QUICK_LOOK = { cap_usd: 100, status: 'skipped', reason: 'needs a new Claude Code runner (sessions as files, drive masking, judged records), not a small adapter' } as const;

/** Bytes a judge prompt's question, reference answer and value lists may take beyond its template: a bound, far above any dev or Set W question's. */
const JUDGE_QUESTION_BYTES = 8_192;

/**
 * The worst-case reservation of one claude-opus-5-5 gating-judge call on a particle-1 re-read answer, as the lease proxy
 * holds it before sending (metering-proxy.ts: budget-ledger.ts priceRequest, its input bounded by the body's bytes, then
 * reservationUsd): the judge's pinned output cap, and an input of the bg1 judge prompt around the longest answer
 * particle-1 may write (its output floor, at four bytes a token).
 */
export function weeklyRereadJudgeReservationUsd(): number {
  const judge = bg1JudgeOf(PARTICLE);
  const template = Buffer.byteLength([BG1_JUDGE_PROMPT, BG1_ORDERED_RULE].join('\n'));
  const body = { model: judge.slice(judge.indexOf(':') + 1), max_tokens: PER_READER_JUDGE_SETTINGS.max_tokens, output_config: { effort: PER_READER_JUDGE_SETTINGS.effort },
    messages: [{ role: 'user', content: 'x'.repeat(template + JUDGE_QUESTION_BYTES + 4 * WEEKLY_LINE_PARTICLE_MAX_TOKENS) }] };
  const price = priceRequest('https://api.anthropic.com/v1/messages', body);
  if (!price) throw new Error(`${judge} has no price in budget-ledger.ts, so its re-read reservation cannot be sized`);
  return reservationUsd({ ...price, inputTokens: Math.max(price.inputTokens, Buffer.byteLength(JSON.stringify(body)) + 64) });
}
/** Worst-case judge reservations each re-read ledger holds above its estimate, so its last answers are never refused for headroom. */
export const WEEKLY_REREAD_JUDGE_RESERVATIONS = 2;

/** One row's pilot money: its block budget, its cap (a tenth of the budget), its re-read's share and the cells' share (the cell's lease). */
export interface WeeklyPilotCap { row: WeeklyLineRow; rate_usd_per_world: number; block_budget_usd: number; cap_usd: number; reread_cap_usd: number; cells_cap_usd: number }

/**
 * Each row's pilot caps (R111): the block budget is the row's rate on the counted set the pilot precedes (BGW unless a
 * W1-long block follows it) times a block's worlds, and the cap is a tenth of it, rounded down to the cent. On an 8,000-token row the particle-1 re-read takes its own pilot estimate plus two worst-case
 * gating-judge reservations (weeklyRereadJudgeReservationUsd), rounded up, and the cell takes the rest, so the two
 * ledgers together never pass the cap.
 */
export function weeklyLinePilotCaps(counted: WeeklyLineCountedSet = 'BGW'): Record<WeeklyLineRow, WeeklyPilotCap> {
  const pilot = ALL_SETS['BGW-pilot'], rates = weeklyLineRates(counted);
  return Object.fromEntries((Object.keys(WEEKLY_LINE_ROWS) as WeeklyLineRow[]).map(row => {
    const rate = rates[row], budget = rate * WEEKLY_LINE_BLOCK_WORLDS, cap = floorCents(budget * WEEKLY_LINE_PILOT_FRACTION);
    const reread = WEEKLY_LINE_ROWS[row].mode === 'packed' ? ceilCents(pilot.questions * rereadUsdPerAnswer() + WEEKLY_REREAD_JUDGE_RESERVATIONS * weeklyRereadJudgeReservationUsd()) : 0;
    return [row, { row, rate_usd_per_world: Math.round(rate * 10_000) / 10_000, block_budget_usd: Math.round(budget * 100) / 100, cap_usd: cap, reread_cap_usd: reread, cells_cap_usd: floorCents(cap - reread) }];
  })) as Record<WeeklyLineRow, WeeklyPilotCap>;
}

const withLease = (c: CellDefinition, usd: number, basis: string): CellDefinition => ({ ...c, lease: { usd, basis } });

/**
 * The pilot (R111): the four rows on public dev world bg1-dev-01 (set BGW-pilot, loader bg1-dev), built by the weekly
 * generator at the counted settings with the gbrain build passed in. Each cell's lease is its row's cells cap
 * (weeklyLinePilotCaps on `counted`, the counted set the pilot precedes), so a unit stops before its row's pilot passes a
 * tenth of its block budget. The pilot's own world stays bg1-dev-01, about 200,000 tokens, whichever set follows.
 */
export function generateWeeklyLinePilotCells(gbrain: WeeklyLineGbrainBuild, counted: WeeklyLineCountedSet = 'BGW'): CellDefinition[] {
  const problems = weeklyLineBuildProblems(gbrain);
  if (problems.length) throw new Error(`the weekly line's pilot can't build: ${problems.join('; ')}`);
  const caps = weeklyLinePilotCaps(counted);
  return weeklyLineCells({ set: 'BGW-pilot' }, gbrain, Object.keys(WEEKLY_LINE_ROWS) as WeeklyLineRow[]).map(c => {
    const cap = caps[WL_ROW_OF[c.system]];
    return withLease(c, cap.cells_cap_usd, `weekly pilot (R111): a tenth of the row's block budget ($${cap.block_budget_usd} = $${cap.rate_usd_per_world} a world x ${WEEKLY_LINE_BLOCK_WORLDS}) is $${cap.cap_usd}, less the re-read's $${cap.reread_cap_usd}`);
  });
}

/**
 * The grep agent's judge check (R78): the grep agent alone, both readers as agents with their gating judges, on public dev
 * worlds bg1-dev-02 and bg1-dev-03 (set BGW-judge), so that with the pilot's grep-agent answers each reader has 192 to
 * sample from. Its lease is the judge check's pause less the labelling pass's cap.
 */
export function generateWeeklyLineJudgeCheckCells(): CellDefinition[] {
  const usd = floorCents(WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD - WEEKLY_LINE_LABEL_CAP_USD);
  return weeklyLineCells({ set: 'BGW-judge' }, null, ['grep-agent']).map(c => withLease(c, usd, `weekly judge check (R78): its $${WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD} pause less the labelling pass's $${WEEKLY_LINE_LABEL_CAP_USD}`));
}

/** The variable that names the pilot's gbrain build to every pilot command (`<release>@<commit>`), so a VM regenerates the same cells. */
export const WEEKLY_PILOT_GBRAIN_ENV = 'GBRAIN_EVALS_WEEKLY_PILOT_GBRAIN';

/** The pilot's gbrain build from WEEKLY_PILOT_GBRAIN_ENV; throws when it is unset or not a release tag and a full commit. */
export function weeklyPilotBuild(env: Record<string, string | undefined> = process.env): WeeklyLineGbrainBuild {
  const raw = env[WEEKLY_PILOT_GBRAIN_ENV];
  if (!raw) throw new Error(`${WEEKLY_PILOT_GBRAIN_ENV} is not set: the pilot's cells name the gbrain build they run as <release>@<commit>, the newest release when the pilot was planned (bun eval/runner/weekly-line/pilot.ts plan)`);
  const [release, commit, ...rest] = raw.split('@');
  const build = { release, commit: commit ?? '' };
  const problems = rest.length ? ['it holds more than one @'] : weeklyLineBuildProblems(build);
  if (problems.length) throw new Error(`${WEEKLY_PILOT_GBRAIN_ENV}=${raw} is not <release>@<commit>: ${problems.join('; ')}`);
  return build;
}

export interface WeeklyPilotManifest extends Manifest {
  campaign_id: string; gbrain_build: WeeklyLineGbrainBuild; frontier_judges: Readonly<Record<string, string>>;
  reread_plans: WeeklyLineRereadPlan[]; pilot_caps: Record<WeeklyLineRow, WeeklyPilotCap>; rates: Readonly<Record<WeeklyLineRow, number>>;
  judge_check: { pause_usd: number; cells_cap_usd: number; label_cap_usd: number; per_judge: number; labeller: string };
  quick_look: typeof WEEKLY_LINE_QUICK_LOOK;
}

/** The labeller where the gold doesn't settle a grep-agent answer (the preregistration's judge check). */
export const WEEKLY_LINE_LABELLER = 'gemini:gemini-3.8-flash';

/**
 * The pilot's and the judge check's cell manifest (cell.ts `--manifest weekly-pilot`), for the gbrain build passed in: the
 * pilot's four cells and the judge check's grep-agent cell, particle-1's re-reads of the pilot's three 8,000-token rows,
 * and each block's estimate and cap (the pilot's: its rows' caps; the judge check's: its pause). The pilot's caps and recorded
 * rates are those of the counted set it precedes, `counted` (BGW unless a W1-long block is amended in).
 */
export function buildWeeklyPilotManifest(gbrain: WeeklyLineGbrainBuild, counted: WeeklyLineCountedSet = 'BGW'): WeeklyPilotManifest {
  const pilot = generateWeeklyLinePilotCells(gbrain, counted), judge = generateWeeklyLineJudgeCheckCells(), caps = weeklyLinePilotCaps(counted);
  const rereads = weeklyLineRereadPlans(pilot);
  const sum = (xs: Array<{ estimate: CellEstimate }>) => xs.reduce((s, x) => s + x.estimate.usd, 0);
  const labelUsd = WEEKLY_LINE_READERS.length * WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE * BG1_MEASURED.canonical_judge_usd_per_call;
  const pilotUsd = round(sum(pilot) + sum(rereads)), judgeUsd = round(sum(judge) + labelUsd);
  const pilotCap = round(Object.values(caps).reduce((s, c) => s + c.cap_usd, 0));
  const models = [...new Set([...WEEKLY_LINE_READERS, ...Object.values(WEEKLY_LINE_JUDGE_BY_READER), F6_ASSUMPTIONS.extraction.model])].sort();
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'eval/runner/q1/cells/weekly-line.ts buildWeeklyPilotManifest', preregistration: WEEKLY_LINE_PREREGISTRATION, readers: [...WEEKLY_LINE_READERS], effort: WEEKLY_LINE_EFFORT,
    prices: Object.fromEntries(models.map(m => { const { input, output, cache_read, cache_write } = listPrice(m); return [m, { input, output, ...(cache_read !== undefined ? { cache_read } : {}), ...(cache_write !== undefined ? { cache_write } : {}) }]; })),
    assumptions: ASSUMPTIONS, sets: [WEEKLY_LINE_SETS['BGW-pilot'], WEEKLY_LINE_SETS['BGW-judge']],
    blocks: [
      { id: 'BGW-pilot', label: "weekly line pilot on bg1-dev-01 (R111): the four rows at the counted settings and particle-1's re-reads", plan_usd: pilotUsd, estimate_usd: pilotUsd, cap_usd: pilotCap },
      { id: 'BGW-judge', label: "weekly line judge check (R78): the grep agent on bg1-dev-02 and bg1-dev-03 and the labelling pass", plan_usd: judgeUsd, estimate_usd: judgeUsd, cap_usd: WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD },
    ],
    cells: [...pilot, ...judge], smoke_cells: [], addon_cells: [],
    total_usd: round(pilotUsd + judgeUsd), plan_total_usd: round(pilotUsd + judgeUsd), cap_usd: round(pilotCap + WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD),
    campaign_id: BGW_CAMPAIGN, gbrain_build: { ...gbrain }, frontier_judges: { ...WEEKLY_LINE_JUDGE_BY_READER }, reread_plans: rereads, pilot_caps: caps, rates: weeklyLineRates(counted),
    judge_check: { pause_usd: WEEKLY_LINE_JUDGE_CHECK_PAUSE_USD, cells_cap_usd: judge[0].lease!.usd, label_cap_usd: WEEKLY_LINE_LABEL_CAP_USD, per_judge: WEEKLY_LINE_JUDGE_CHECK_PER_JUDGE, labeller: WEEKLY_LINE_LABELLER },
    quick_look: WEEKLY_LINE_QUICK_LOOK,
  };
}
