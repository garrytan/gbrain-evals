/**
 * BG1-C cell definitions: the changing-facts confirmation on new sealed worlds
 * (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md, harness item 2), built with BG1's tooling
 * (definitions.ts makeCell and definitionProblems, bg1.ts and f6.ts helpers), so a BG1-C cell is a Q1 cell definition the
 * same runner executes.
 *
 *   Counted (set BG1C, sealed, the first 40 kept worlds, 64 questions each): gbrain at the newest release at launch
 *     (BG1C_GBRAIN_BUILD; configuration rs1-stable as BG1 ran it, with arm P's retrieval), the memory-bank server
 *     (recipe) and the extract-first server (common), all at 8,000 tokens; readers claude-opus-5-5 and gpt-6.2-sol at
 *     effort medium. Each cell runs as launch units of five kept worlds in slot order (kept_units; R113, as GBEV-3 set it):
 *     units 0 to 3, kept worlds 1 to 20, are the first half (halves.first), where the preregistered look happens.
 *   Smoke (block BG1C-smoke, set BG1C-dev1): the same three cells on public dev world bg1-dev-01 at the counted settings,
 *     with particle-1's re-reads. It is each row's pilot (R111).
 *   Re-read plans: particle-1 re-reads every row's frozen contexts byte for byte (reread-cell.ts) at effort medium with
 *     its 16,000-token output floor, in one plan per half of each counted cell (half, units), so the first half's
 *     re-reads are read at the look.
 *
 * Judging: each answer gets exactly one gating judge by its reader's family (frontier.per_reader with
 * BG1C_JUDGE_BY_READER, definitions.ts bg1JudgeOf: gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for gpt-6.2-sol and
 * particle-1), pinned to PER_READER_JUDGE_SETTINGS, under BG1's bg1 instrument. No answer gets BG1's descriptive Gemini
 * view (descriptive_view false).
 *
 * Money: the preregistration's rates ("Budget"; BG1C_RATES), not estimateCell's token model. Each row's dev run
 * measured its ingest, Opus's reads and Astra's grading together, so a cell's estimate is that rate per world, plus
 * gpt-6.2-sol's reads in BG1's money model (definitions.ts bg1ReadUsd, at gpt-6.1-sol's token parameters) and Opus's
 * grading of them at BG1's measured rate per call. A re-read is particle-1's reads and their Opus grading at BG1 wave B's
 * measured rates. Leases and unit hours size the largest world at BG1's ratio over the mean, as bg1.ts does.
 *
 * `bun eval/runner/q1/cells/bg1c.ts` regenerates bg1c-cells.json; a test fails when the committed file is stale.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reservationUsd } from '../../budget-ledger.ts';
import { BG1C_CAMPAIGN, BG1C_FIRST_HALF_UNITS, BG1C_KEPT_UNITS } from '../../memory-qa/bg1-names.ts';
import {
  ALL_SETS, ASSUMPTIONS, BG1_ASSUMPTIONS, BG1_MEASURED, BG1C_JUDGE_BY_READER, BG1C_SETS, bg1JudgeOf, bg1ReadUsd, F6_ASSUMPTIONS, f6ExtractionLedgerUsd, makeCell, MANIFEST_SCHEMA,
  PER_READER_JUDGE_SETTINGS, READER_TOKENS_EXTRA,
  type ArmDefinition, type ArmSpec, type BG1CBlockId, type BG1CSetId, type BlockId, type CellDefinition, type CellEstimate, type Manifest, type SetId,
} from './definitions.ts';
import { listPrice, OPUS, PARTICLE, stage1SmokeLeaseUsd, type RereadPlan } from './bg1.ts';
import { F6_ARMS, peakReservationUsd } from './f6.ts';

export const BG1C_MANIFEST_PATH = resolve(import.meta.dir, 'bg1c-cells.json');
export const BG1C_PREREGISTRATION = 'docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md';
/**
 * gbrain's build on every BG1-C gbrain cell: the newest release tag on gbrain's master. Launch amendment A re-pins it
 * here when a newer release lands before the first counted gbrain cell, and it is frozen once counted gbrain cells start.
 */
export const BG1C_GBRAIN_BUILD = { release: 'v0.60.753.0', commit: 'fbf608cf86ea7b2b912ce80151f856a1a47e9533' } as const;
export const BG1C_SOL = 'openai:gpt-6.2-sol';
/** Live readers; particle-1 re-reads the frozen contexts (reread-cell.ts), so it is the third reader of every row. */
export const BG1C_READERS = [OPUS, BG1C_SOL];
/** The largest world over the mean: BG1-C mints with BG1's generator at its length target, so it takes BG1's ratio. */
export const BG1C_WORLD_RATIO = BG1_ASSUMPTIONS.max_conversation_ratio.BG1;

/**
 * BG1-C's rates, each from the preregistration's "Budget" table:
 *   - the mint per kept world: BG1's paid mints MINT-A ($51.37) and MINT-B ($78.69) over their 30 kept worlds;
 *   - each row's dev run per world (ingest, claude-opus-5-5's reads and gpt-6-astra's grading, less its Gemini view):
 *     gbrain v0.60.741.0's $70.65 on 20 worlds, the memory-bank server's $55.10 and the extract-first server's $114.44
 *     on 17;
 *   - gpt-6.2-sol reading one 8,000-token context in BG1's money model, and claude-opus-5-5 grading that answer at BG1's
 *     measured rate per call;
 *   - particle-1 re-reading one answer and claude-opus-5-5 grading it, from BG1 wave B's re-read ($12.10 and $14.03 for
 *     6,912 answers).
 */
export const BG1C_RATES = {
  mint_usd_per_world: (51.37 + 78.69) / 30,
  row_usd_per_world: { 'gbrain-defaults:rs1-stable': 3.5, 'ext-memory-bank:recipe': 3.21, 'ext-extract-first:common': 6.7 } as Record<string, number>,
  sol_read_usd_per_answer: bg1ReadUsd(BG1C_SOL, 8000),
  sol_judge_usd_per_answer: BG1_MEASURED.judge_usd_per_call[OPUS],
  particle_read_usd_per_answer: 12.1 / 6912,
  particle_judge_usd_per_answer: 14.03 / 6912,
};

const round = (x: number) => Math.round(x * 100) / 100;
const estimateOf = (lines: Record<string, number>): CellEstimate => ({
  usd: round(Object.values(lines).reduce((s, v) => s + v, 0)),
  lines: Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, round(v)])),
});

/** A BG1-C cell's estimate: its row's dev-run rate per world, gpt-6.2-sol's reads and their Opus grading, one per question. */
export function bg1cEstimate(def: Pick<CellDefinition, 'set' | 'system' | 'configuration'>): CellEstimate {
  const s = ALL_SETS[def.set], row = BG1C_RATES.row_usd_per_world[`${def.system}:${def.configuration}`];
  if (!(row > 0)) throw new Error(`BG1-C has no dev-run rate for ${def.system}:${def.configuration} (BG1C_RATES.row_usd_per_world)`);
  return estimateOf({ row_dev_rate: s.conversations * row, sol_reads: s.questions * BG1C_RATES.sol_read_usd_per_answer, sol_gating_judges: s.questions * BG1C_RATES.sol_judge_usd_per_answer });
}

/**
 * A BG1-C unit's lease: its largest shard's estimate (one world's dev-run rate at BG1C_WORLD_RATIO times the mean) with
 * F6's lease margin, plus twice the largest single reservation among f6.ts peakReservationUsd's calls and each pinned
 * judge at its pinned output cap.
 */
export function bg1cLease(c: CellDefinition): CellDefinition {
  const L = F6_ASSUMPTIONS.lease;
  const judges = c.arms.flatMap(a => (a.frontier?.settings ? a.frontier.judges.map(j => ({
    usd: reservationUsd({ provider: j.split(':')[0], model: j.split(':')[1], kind: 'chat', ...listPrice(j), inputTokens: L.judge_bytes + 64, maxOutputTokens: a.frontier!.settings!.max_tokens }),
    by: `judge ${j} at ${a.frontier!.settings!.max_tokens} output tokens`,
  })) : []));
  const peak = [peakReservationUsd(c), ...judges].reduce((a, b) => (b.usd > a.usd ? b : a));
  const peakUsd = Math.round(peak.usd * 10_000) / 10_000;
  const largest = c.estimate.usd / c.shards + c.estimate.lines.row_dev_rate / ALL_SETS[c.set].conversations * (BG1C_WORLD_RATIO - 1);
  return { ...c, lease: { usd: Math.ceil((largest * L.margin + 2 * peakUsd) * 100) / 100, basis: `BG1-C: the largest shard's estimate ($${largest.toFixed(2)}, one world at ${BG1C_WORLD_RATIO} times the mean) x ${L.margin} plus twice the peak reservation ($${peakUsd}, ${peak.by})` } };
}

/** A unit's expected hours: its largest shard's at BG1's measured VM hours per million tokens (ingest and both readers' questions), the largest world at BG1C_WORLD_RATIO times the mean. */
function withBg1cHours(c: CellDefinition): CellDefinition {
  const s = ALL_SETS[c.set];
  const whole = BG1_MEASURED.hours_per_mtok[`${c.system}:${c.configuration}`] * s.corpus_tokens / 1e6;
  return { ...c, expected_hours: Math.max(c.expected_hours, Math.ceil(whole / c.shards + whole / s.conversations * (BG1C_WORLD_RATIO - 1))) };
}

/** gbrain's extraction cap per world: F6's multiple of the largest world's extraction at gbrain's own ledger rate, at least $1, rounded up to the dollar (f6.ts extractionCapUsd, at BG1C_WORLD_RATIO). */
const extractionCapUsd = (set: BG1CSetId) => {
  const s = ALL_SETS[set];
  return Math.max(1, Math.ceil(F6_ASSUMPTIONS.extraction_cap_multiple * f6ExtractionLedgerUsd(s.corpus_tokens / s.conversations * BG1C_WORLD_RATIO)));
};

const perReader = (): NonNullable<ArmDefinition['frontier']> => ({ judges: [...new Set(BG1C_READERS.map(bg1JudgeOf))].sort(), readers: null, sample: null, per_reader: true, judge_by_reader: { ...BG1C_JUDGE_BY_READER }, settings: { ...PER_READER_JUDGE_SETTINGS } });
const p = (): ArmSpec => ({ id: 'p', mode: 'packed', budget: 8000, label: F6_ARMS.p.label, retrieval: F6_ARMS.p.retrieval, readers: [...BG1C_READERS], frontier: perReader() });
const b8 = (): ArmSpec => ({ id: 'component-b8000', mode: 'packed', budget: 8000, label: 'component, 8,000 tokens', readers: [...BG1C_READERS], frontier: perReader() });
/** No write-to-queryable probes on any BG1-C cell. */
const noProbes = (set: SetId) => ({ sample: 0, seed: `bg1c-probes-${set.toLowerCase()}`, conversations: 0 });
/** One cell: the counted set runs in units of kept worlds under BG1's bg1 instrument, and the smoke keeps bg1-dev's; gbrain's build is BG1C_GBRAIN_BUILD's commit. */
const cell = (set: BG1CSetId, system: string, configuration: string, arm: ArmSpec): CellDefinition => {
  const counted = set === 'BG1C';
  const made = makeCell(set, system, configuration, [arm], {
    probes: noProbes(set), ...(counted ? { keptUnits: BG1C_KEPT_UNITS } : {}),
    ...(system === 'gbrain-defaults' ? { launchEnv: { GBRAIN_SHA: BG1C_GBRAIN_BUILD.commit, GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(set)) } } : {}),
  });
  const def: CellDefinition = { ...made, ...(counted ? { canonical_instrument: 'bg1' } : {}), descriptive_view: false };
  return bg1cLease(withBg1cHours({ ...def, estimate: bg1cEstimate(def) }));
};
const rows = (set: BG1CSetId) => [
  cell(set, 'gbrain-defaults', 'rs1-stable', p()),
  cell(set, 'ext-memory-bank', 'recipe', b8()),
  cell(set, 'ext-extract-first', 'common', b8()),
];

/** BG1-C's counted cells: the three rows on the first 40 kept worlds. */
export const generateBG1CCells = (): CellDefinition[] => rows('BG1C');
/** The smoke: the same three cells on public dev world bg1-dev-01. */
export const generateBG1CSmokeCells = (): CellDefinition[] => rows('BG1C-dev1');

export interface BG1CRereadPlan extends RereadPlan {
  /** The half of the kept worlds the plan re-reads: 1 is units 0 to 3 (kept worlds 1 to 20), 2 the rest; null on the smoke. */
  half: 1 | 2 | null;
  /** The source cell's launch units whose frozen contexts the plan re-reads. */
  units: number[];
}

/**
 * particle-1's re-reads (eval/runner/q1/reread-cell.ts): every frozen context of each row read once and graded by
 * particle-1's gating judge (claude-opus-5-5), one plan per half of a counted cell and one for the smoke, priced at BG1
 * wave B's measured rates per answer. A half's id is the re-read cell id with .h1 or .h2.
 */
export function bg1cRereadPlans(cells: CellDefinition[]): BG1CRereadPlan[] {
  const parts = (c: CellDefinition): Array<{ half: 1 | 2 | null; units: number[] }> => {
    const all = Array.from({ length: c.shards }, (_, i) => i);
    return c.kept_units ? [{ half: 1, units: all.slice(0, BG1C_FIRST_HALF_UNITS) }, { half: 2, units: all.slice(BG1C_FIRST_HALF_UNITS) }] : [{ half: null, units: all }];
  };
  return cells.flatMap(c => c.arms.flatMap(a => parts(c).map(({ half, units }) => {
    const s = ALL_SETS[c.set];
    const worlds = c.kept_units ? Math.min(s.conversations, (units[units.length - 1] + 1) * c.kept_units) - units[0] * c.kept_units : s.conversations;
    const answers = worlds * s.questions / s.conversations;
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}${half ? `.h${half}` : ''}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block, half, units,
      judges: [bg1JudgeOf(PARTICLE)], estimate: estimateOf({ readers: answers * BG1C_RATES.particle_read_usd_per_answer, frontier_judges: answers * BG1C_RATES.particle_judge_usd_per_answer }) };
  })));
}

const BG1C_BLOCKS: Record<BG1CBlockId, string> = {
  'BG1C-smoke': 'BG1-C smoke on public dev world bg1-dev-01 (the three rows at the counted settings and particle-1\'s re-reads), each row\'s pilot',
  BG1C: 'BG1-C counted cells on the first 40 kept worlds (gbrain arm P at the newest release, the memory-bank and extract-first servers) and particle-1\'s re-reads by half',
};

export interface BG1CManifest extends Manifest {
  campaign_id: string; gbrain_build: typeof BG1C_GBRAIN_BUILD;
  bg1c_rates: typeof BG1C_RATES; reader_tokens_extra: typeof READER_TOKENS_EXTRA; bg1_measured: typeof BG1_MEASURED; f6_assumptions: typeof F6_ASSUMPTIONS;
  frontier_judges: Record<string, string>; reread_plans: BG1CRereadPlan[];
  /** Launch units by half of the kept worlds: first is units 0 to 3 of each counted cell (kept worlds 1 to 20, where the look happens), second the rest. */
  halves: { first: string[]; second: string[] };
}

/**
 * The manifest. Each block's estimate is its cells and its re-reads. The smoke stops at the larger of 1.5 times its
 * estimate and its smoke units' leases (campaignCells leases a smoke unit at twice its estimate), rounded up to the
 * dollar; the counted block at 1.5 times its cells' estimate, or at its units' leases where they hold more, since its
 * re-reads spend from their own ledgers.
 */
export function buildBG1CManifest(): BG1CManifest {
  const cells = generateBG1CCells(), smoke = generateBG1CSmokeCells();
  const rereads = [...bg1cRereadPlans(cells), ...bg1cRereadPlans(smoke)];
  const cellsUsd = (id: BG1CBlockId) => [...cells, ...smoke].filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0);
  const blockUsd = (id: BG1CBlockId) => round(cellsUsd(id) + rereads.filter(r => r.block === id).reduce((s, r) => s + r.estimate.usd, 0));
  const capUsd = (id: BG1CBlockId) => (id === 'BG1C-smoke' ? Math.ceil(Math.max(1.5 * blockUsd(id), stage1SmokeLeaseUsd(smoke))) : round(Math.max(1.5 * cellsUsd(id), cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0))));
  const blocks = (Object.keys(BG1C_BLOCKS) as BG1CBlockId[]).map(id => ({ id: id as BlockId, label: BG1C_BLOCKS[id], plan_usd: blockUsd(id), estimate_usd: blockUsd(id), cap_usd: capUsd(id) }));
  const units = (first: boolean) => cells.flatMap(c => Array.from({ length: c.shards }, (_, i) => i).filter(i => (i < BG1C_FIRST_HALF_UNITS) === first).map(i => `${c.id}.c${i}`));
  const models = [...BG1C_READERS, PARTICLE, ...Object.values(BG1C_JUDGE_BY_READER), F6_ASSUMPTIONS.extraction.model];
  const counted = blocks.find(b => b.id === 'BG1C')!;
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/bg1c.ts', preregistration: BG1C_PREREGISTRATION, readers: [...BG1C_READERS], effort: 'medium',
    prices: Object.fromEntries([...new Set(models)].sort().map(m => { const { input, output, cache_read, cache_write } = listPrice(m); return [m, { input, output, ...(cache_read !== undefined ? { cache_read } : {}), ...(cache_write !== undefined ? { cache_write } : {}) }]; })),
    assumptions: ASSUMPTIONS, f6_assumptions: F6_ASSUMPTIONS, bg1_measured: BG1_MEASURED, reader_tokens_extra: READER_TOKENS_EXTRA, bg1c_rates: BG1C_RATES,
    sets: Object.values(BG1C_SETS), blocks, cells, smoke_cells: smoke,
    total_usd: counted.estimate_usd, plan_total_usd: counted.plan_usd, cap_usd: counted.cap_usd,
    campaign_id: BG1C_CAMPAIGN, gbrain_build: { ...BG1C_GBRAIN_BUILD },
    frontier_judges: { ...BG1C_JUDGE_BY_READER }, reread_plans: rereads,
    halves: { first: units(true), second: units(false) },
  };
}

export const bg1cManifestText = (m: BG1CManifest = buildBG1CManifest()) => JSON.stringify(m, null, 2) + '\n';

if (import.meta.main) {
  const m = buildBG1CManifest();
  writeFileSync(BG1C_MANIFEST_PATH, bg1cManifestText(m));
  console.log(`eval/runner/q1/cells/bg1c-cells.json written (${m.cells.length} cells, ${m.smoke_cells.length} smoke cells, ${m.reread_plans.length} re-read plans)`);
}
