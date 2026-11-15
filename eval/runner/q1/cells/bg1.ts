/**
 * BG1 cell definitions: the changing-facts battleground (docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md,
 * GST-2010), built with Q1's tooling (definitions.ts makeCell, estimateCell, definitionProblems) and F6's helpers, so a
 * BG1 cell is a Q1 cell definition the same runner executes: `bun eval/runner/q1/cell.ts run --cell <id> --manifest bg1`.
 *
 *   Counted (set BG1, sealed, at N_final = 30 kept worlds, 64 questions each): gbrain at the `stable` tag (configuration
 *     rs1-stable, F6's build path with arm P's retrieval), the memory-bank server (recipe), the extract-first server
 *     (common), the temporal-graph library (shipped-0.31), hybrid search (baseline) and the no-memory floor, all at 8,000
 *     tokens; readers claude-opus-5-5 and gpt-6.1-sol at effort medium with a 2,048-token output limit. Each cell runs
 *     as launch units of six kept worlds in slot order (kept_units): units 0 and 1 are wave A (the first 12 kept, the
 *     internal pilot), the rest wave B (units 2 to 4), regenerated at N_final 30 by the preregistration's Amendment 7.
 *   Full-context reference (set BG1-fc10, descriptive): Opus and Sol read each whole history with prompt caching
 *     (system baseline-full-context, arm whole-full-context) on the first 10 kept worlds, as two launch units of five
 *     (inside wave A). It is its own set so its estimate, lease and receipts cover those 10 worlds only, and the
 *     runner needs no new arm mode: a full-context arm is one Q1 already runs.
 *   Stage 1 (block BG1-S1, set BG1-dev3: the three public dev worlds): the six rows and the full-context reference
 *     (which doubles as the gold audit, review finding F4), the particle-1 re-reads and the judge check. Its cap is
 *     min(300, the larger of its estimate / 0.75 and its smoke leases, rounded up) (stage1CapUsd, the
 *     preregistration's Amendment 1), and `cell.ts plan --manifest bg1` refuses above it.
 *   Re-read plans: particle-1 re-reads every row's frozen contexts byte for byte (reread-cell.ts) at effort medium with
 *     its 16,000-token output floor, each with its own estimate; they run only in paid windows.
 *
 * Judging: every answer gets BG1's canonical judge (gemini-3.8-flash, the bg1 instrument), descriptive. The five system
 * rows and the full-context reference also get exactly one gating judge per answer by the reader's family
 * (frontier.per_reader with BG1's map, definitions.ts bg1JudgeOf: gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for
 * gpt-6.1-sol and particle-1), pinned to PER_READER_JUDGE_SETTINGS; the floor gets the canonical judge only. Judge lines
 * are priced per call in place of estimateCell's token assumption, which prices the shared frontier rule: stage 1's
 * cells at BG1_ASSUMPTIONS ($0.022 Astra, $0.016 Opus, the canonical judge from its tokens), the counted cells at stage
 * 1's measured rates (BG1_MEASURED, the stage 2 freeze), which also price their ingest, their unit hours and the
 * full-context reference's reads. Leases hold twice the largest reservation of a pinned judge or a whole-history read,
 * so they do not depend on how f6.ts sizes judge caps.
 *
 * `bun eval/runner/q1/cells/bg1.ts` regenerates bg1-cells.json; a test fails when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatPrice, reservationUsd } from '../../budget-ledger.ts';
import { BG1_KEPT_UNITS, BG1_WAVE_A } from '../../memory-qa/bg1-names.ts';
import { DEFAULT_ROUTE_CAPS } from '../../metering-proxy.ts';
import type { ScoreboardMessage } from '../scoreboard-errors.ts';
import {
  ALL_SETS, ASSUMPTIONS, BG1_ASSUMPTIONS, BG1_JUDGE_BY_READER, BG1_MEASURED, BG1_SETS, bg1JudgeOf, bg1Rates, estimateCell, F6_ASSUMPTIONS, makeCell, MANIFEST_SCHEMA, PER_READER_JUDGE_SETTINGS,
  type ArmDefinition, type ArmSpec, type BG1BlockId, type BG1SetId, type BlockId, type CellDefinition, type CellEstimate, type Manifest, type SetId,
} from './definitions.ts';
import { extractionCapUsd, F6_ARMS, maxShardUsd, peakReservationUsd, withHours } from './f6.ts';

export const BG1_MANIFEST_PATH = resolve(import.meta.dir, 'bg1-cells.json');
export const BG1_PREREGISTRATION = 'docs/benchmarks/2026-11-09-changing-facts-battleground-preregistration.md';
export const BG1_CAMPAIGN_ID = 'q1-scoreboard-bg1-changing-facts';
/** Kept worlds per full-context launch unit: BG1-fc10's 10 worlds in two units, both inside wave A. */
export const BG1_FC_UNITS = 5;
export const STAGE1_CAP_CEILING_USD = 300;
export const STAGE1_CAP_SHARE = 0.75;
/** The judge check's pool as planned (eval/runner/bg1/judge-check.ts): stage 1 dev answers and construction items, each graded by gpt-6-astra and claude-opus-5-5. */
export const JUDGE_CHECK_PLAN = { dev_answers: 160, construction_items: 160 } as const;
/**
 * Stage 1's smoke leases summed: campaignCells (cell.ts) launches each stage 1 cell once as a smoke unit, whose lease
 * holds twice its estimate per shard, rounded up to the cent and at least a cent.
 */
export const stage1SmokeLeaseUsd = (smoke: readonly CellDefinition[]) =>
  Math.round(smoke.reduce((s, c) => s + Math.max(0.01, Math.ceil(2 * c.estimate.usd / c.shards * 100) / 100), 0) * 100) / 100;
/** The stage 1 cap (Amendment 1): the larger of the estimate over 0.75 and the smoke leases, rounded up to the dollar, at most the ceiling. */
export const stage1CapUsd = (estimateUsd: number, smokeLeaseUsd: number) =>
  Math.min(STAGE1_CAP_CEILING_USD, Math.max(Math.ceil(estimateUsd / STAGE1_CAP_SHARE), Math.ceil(smokeLeaseUsd)));
/** A model's list price (budget-ledger chatPrice, which also holds the Gemini rows). */
export const listPrice = (model: string) => { const p = chatPrice(model); if (!p) throw new Error(`no list price for ${model} in eval/runner/budget-ledger.ts`); return p; };

export const OPUS = 'anthropic:claude-opus-5-5';
export const SOL = 'openai:gpt-6.1-sol';
export const PARTICLE = 'particle:particle-1';
/** Live readers; particle-1 re-reads the frozen contexts (reread-cell.ts), so it is the third reader of every row. */
export const BG1_READERS = [OPUS, SOL];

const perReader = (readers: string[]): NonNullable<ArmDefinition['frontier']> => ({ judges: [...new Set(readers.map(bg1JudgeOf))].sort(), readers: null, sample: null, per_reader: true, judge_by_reader: { ...BG1_JUDGE_BY_READER }, settings: { ...PER_READER_JUDGE_SETTINGS } });
const p = (): ArmSpec => ({ id: 'p', mode: 'packed', budget: 8000, label: F6_ARMS.p.label, retrieval: F6_ARMS.p.retrieval, readers: BG1_READERS, frontier: perReader(BG1_READERS) });
const b8 = (frontier: boolean): ArmSpec => ({ id: 'component-b8000', mode: 'packed', budget: 8000, label: 'component, 8,000 tokens', readers: BG1_READERS, frontier: frontier ? perReader(BG1_READERS) : null });
const fc = (): ArmSpec => ({ id: 'whole-full-context', mode: 'full-context', label: 'whole history (reference, descriptive)', readers: BG1_READERS, frontier: perReader(BG1_READERS) });

/** The canonical judge's dollars per call, at its list price (BG1_ASSUMPTIONS.canonical_judge_tokens). */
export function canonicalJudgeUsd(): number {
  const t = BG1_ASSUMPTIONS.canonical_judge_tokens, price = listPrice('gemini:gemini-3.8-flash');
  return (t.input * price.input + t.output * price.output) / 1e6;
}

/**
 * A BG1 estimate: estimateCell's lines with both judge lines priced per call, one call per answer (the bg1 instrument
 * asks once): the canonical judge on every answer and each reader's gating judge (bg1Rates: measured for the counted
 * cells, assumed for stage 1's). A counted full-context cell's reads are stage 1's measured dollars per world and reader.
 */
export function bg1Estimate(def: Omit<CellDefinition, 'estimate'>): CellEstimate {
  const base = estimateCell(def);
  const sealed = def.benchmark === 'bg1';
  const lines: Record<string, number> = Object.fromEntries(Object.entries(base.lines).filter(([k]) => k !== 'judges' && k !== 'frontier_judges' && !(sealed && k === 'full_context')));
  const add = (k: string, v: number) => { if (v) lines[k] = (lines[k] ?? 0) + v; };
  const canonical = sealed ? BG1_MEASURED.canonical_judge_usd_per_call : canonicalJudgeUsd();
  for (const arm of def.arms) {
    const n = ALL_SETS[arm.set].questions;
    add('judges', n * arm.readers.length * canonical);
    if (arm.frontier?.per_reader) for (const r of arm.frontier.readers ?? arm.readers) add('frontier_judges', n * bg1Rates(def.benchmark).judge_usd_per_call[bg1JudgeOf(r)]);
    if (sealed && arm.mode === 'full-context') for (const r of arm.readers) add('full_context', ALL_SETS[arm.set].conversations * BG1_MEASURED.full_context_read_usd_per_world[r]);
  }
  const rounded = Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { usd: Math.round(Object.values(lines).reduce((s, v) => s + v, 0) * 100) / 100, lines: rounded };
}

/**
 * A BG1 unit's lease: its largest shard's estimate with F6's lease margin, plus twice the largest single reservation
 * among f6.ts peakReservationUsd's calls, each pinned judge at its pinned output cap, and each whole-history read (the
 * largest world at F6's bytes per token, reserved at the cache-write rate).
 */
export function bg1Lease(c: CellDefinition): CellDefinition {
  const L = F6_ASSUMPTIONS.lease;
  const one = (model: string, inputBytes: number, maxOut: number, cacheWritePremium = false) =>
    reservationUsd({ provider: model.split(':')[0], model: model.split(':')[1], kind: 'chat', ...listPrice(model), inputTokens: inputBytes + 64, maxOutputTokens: maxOut, cacheWritePremium });
  const world = ALL_SETS[c.set].corpus_tokens / ALL_SETS[c.set].conversations * BG1_ASSUMPTIONS.max_conversation_ratio[c.set];
  const calls: Array<{ usd: number; by: string }> = [peakReservationUsd(c),
    ...c.arms.flatMap(a => (a.frontier?.settings ? a.frontier.judges.map(j => ({ usd: one(j, L.judge_bytes, a.frontier!.settings!.max_tokens), by: `judge ${j} at ${a.frontier!.settings!.max_tokens} output tokens` })) : [])),
    ...c.arms.filter(a => a.mode === 'full-context').flatMap(a => a.readers.map(r => ({ usd: one(r, Math.ceil(world * L.bytes_per_token) + L.template_bytes, DEFAULT_ROUTE_CAPS.reader, true), by: `whole-history read ${r}` })))];
  const peak = calls.reduce((a, b) => (b.usd > a.usd ? b : a));
  const peakUsd = Math.round(peak.usd * 10_000) / 10_000;
  const largest = maxShardUsd(c);
  return { ...c, lease: { usd: Math.ceil((largest * L.margin + 2 * peakUsd) * 100) / 100, basis: `BG1: the largest shard's estimate ($${largest.toFixed(2)}) x ${L.margin} plus twice the peak reservation ($${peakUsd}, ${peak.by})` } };
}

/** No write-to-queryable probes on any BG1 cell. */
const noProbes = (set: SetId) => ({ sample: 0, seed: `bg1-probes-${set.toLowerCase()}`, conversations: 0 });
const KEPT: Partial<Record<BG1SetId, number>> = { BG1: BG1_KEPT_UNITS, 'BG1-fc10': BG1_FC_UNITS };
const cell = (set: BG1SetId, block: BG1BlockId, system: string, configuration: string, arms: ArmSpec[]) => {
  const made = makeCell(set, system, configuration, arms, {
    block, probes: noProbes(set), ...(KEPT[set] ? { keptUnits: KEPT[set] } : {}),
    ...(system === 'gbrain-defaults' ? { launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(set)) } } : {}),
  });
  return withHours(bg1Lease({ ...made, estimate: bg1Estimate(made) }));
};
const rows = (set: BG1SetId, block: BG1BlockId) => [
  cell(set, block, 'gbrain-defaults', 'rs1-stable', [p()]),
  cell(set, block, 'ext-memory-bank', 'recipe', [b8(true)]),
  cell(set, block, 'ext-extract-first', 'common', [b8(true)]),
  cell(set, block, 'ext-temporal-graph', 'shipped-0.31', [b8(true)]),
  cell(set, block, 'baseline-hybrid', 'baseline', [b8(true)]),
  cell(set, block, 'baseline-none', 'baseline', [b8(false)]),
];
const fullContext = (set: BG1SetId, block: BG1BlockId) => cell(set, block, 'baseline-full-context', 'baseline', [fc()]);

/** BG1's counted cells: the six rows on the kept worlds, and the full-context reference on the first 10. */
export const generateBG1Cells = (): CellDefinition[] => [...rows('BG1', 'BG1'), fullContext('BG1-fc10', 'BG1')];
/** Stage 1: the same seven cells on the three public dev worlds. */
export const generateBG1Stage1Cells = (): CellDefinition[] => [...rows('BG1-dev3', 'BG1-S1'), fullContext('BG1-dev3', 'BG1-S1')];

export interface RereadPlan { id: string; cell: string; arm: string; arm_cell_id: string; reader: string; set: SetId; block: BlockId; judges: string[]; estimate: CellEstimate }

/**
 * particle-1's re-read of each row (eval/runner/q1/reread-cell.ts, under rereadCellId's id): every frozen context of a
 * packed arm read once and judged by the canonical judge, plus particle-1's gating judge (claude-opus-5-5) on the system
 * rows, priced by bg1Estimate's reader and judge lines with particle-1 as the arm's only reader. The full-context
 * reference is Opus and Sol only.
 */
export function rereadPlans(cells: CellDefinition[]): RereadPlan[] {
  return cells.flatMap(c => c.arms.filter(a => a.mode === 'packed').map(a => {
    const frontier = a.frontier ? { ...a.frontier, judges: [bg1JudgeOf(PARTICLE)] } : null;
    const e = bg1Estimate({ ...c, arms: [{ ...a, readers: [PARTICLE], reader_replicates: {}, frontier }] });
    const lines = Object.fromEntries(['readers', 'judges', 'frontier_judges'].filter(k => e.lines[k]).map(k => [k, e.lines[k]]));
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block,
      judges: ['gemini:gemini-3.8-flash', ...(frontier?.judges ?? [])], estimate: { usd: Math.round(Object.values(lines).reduce((s, v) => s + v, 0) * 100) / 100, lines } };
  }));
}

const BG1_BLOCKS: Record<BG1BlockId, string> = {
  'BG1-S1': 'BG1 stage 1 (the three public dev worlds; every row, the full-context reference, particle-1 re-reads and the judge check)',
  BG1: 'BG1 counted cells at N_final = 30 kept worlds (gbrain arm P at the stable tag, the three comparators, hybrid search, the floor) and the full-context reference on the first 10',
};

export interface BG1Manifest extends Manifest {
  bg1_assumptions: typeof BG1_ASSUMPTIONS; bg1_measured: typeof BG1_MEASURED; f6_assumptions: typeof F6_ASSUMPTIONS; campaign_id: string;
  /** Stage 1's estimate (its cells, its re-reads and the judge check) and its cap, min(300, the larger of estimate / 0.75 and the smoke leases, rounded up). */
  stage1_cap_usd: number; stage1_estimate_usd: number;
  /** The judge check's planned pool and its estimate, inside stage 1. */
  judge_check: { dev_answers: number; construction_items: number; estimate_usd: number };
  frontier_judges: Record<string, string>; reread_plans: RereadPlan[];
  /** Launch units by wave: A runs the first 12 kept worlds (units 0 and 1 of each row, and the full-context units), B the rest up to N_final. */
  waves: { A: string[]; B: string[] };
}

export function buildBG1Manifest(): BG1Manifest {
  const cells = generateBG1Cells();
  const smoke = generateBG1Stage1Cells();
  const rereads = [...rereadPlans(cells), ...rereadPlans(smoke)];
  const round = (x: number) => Math.round(x * 100) / 100;
  const judgeCheck = round((JUDGE_CHECK_PLAN.dev_answers + JUDGE_CHECK_PLAN.construction_items) * (BG1_ASSUMPTIONS.judge_usd_per_call['openai:gpt-6-astra'] + BG1_ASSUMPTIONS.judge_usd_per_call['anthropic:claude-opus-5-5']));
  const cellsUsd = (id: BG1BlockId) => [...cells, ...smoke].filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0);
  const rereadsUsd = (id: BG1BlockId) => rereads.filter(r => r.block === id).reduce((s, r) => s + r.estimate.usd, 0);
  const blockUsd = (id: BG1BlockId) => round(cellsUsd(id) + rereadsUsd(id) + (id === 'BG1-S1' ? judgeCheck : 0));
  const stage1 = blockUsd('BG1-S1');
  const stage1Cap = stage1CapUsd(stage1, stage1SmokeLeaseUsd(smoke));
  // The counted block stops at 1.5 times its cells' estimate (its re-reads spend from their own ledgers), or at its units' leases where they hold more.
  const blocks = (Object.keys(BG1_BLOCKS) as BG1BlockId[]).map(id => ({ id: id as BlockId, label: BG1_BLOCKS[id], plan_usd: blockUsd(id), estimate_usd: blockUsd(id),
    cap_usd: id === 'BG1-S1' ? stage1Cap : round(Math.max(cellsUsd(id) * 1.5, cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0))) }));
  const waveA = (c: CellDefinition) => c.set === 'BG1-fc10' ? c.shards : BG1_WAVE_A / BG1_KEPT_UNITS;
  const units = (pick: (c: CellDefinition, i: number) => boolean) => cells.flatMap(c => Array.from({ length: c.shards }, (_, i) => i).filter(i => pick(c, i)).map(i => `${c.id}.c${i}`));
  const models = [...BG1_READERS, PARTICLE, ...Object.values(BG1_JUDGE_BY_READER), 'gemini:gemini-3.8-flash', F6_ASSUMPTIONS.extraction.model];
  const counted = blocks.find(b => b.id === 'BG1')!;
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/bg1.ts', preregistration: BG1_PREREGISTRATION, readers: BG1_READERS, effort: 'medium',
    prices: Object.fromEntries([...new Set(models)].sort().map(m => { const { input, output, cache_read, cache_write } = listPrice(m); return [m, { input, output, ...(cache_read !== undefined ? { cache_read } : {}), ...(cache_write !== undefined ? { cache_write } : {}) }]; })),
    assumptions: ASSUMPTIONS, f6_assumptions: F6_ASSUMPTIONS, bg1_assumptions: BG1_ASSUMPTIONS, bg1_measured: BG1_MEASURED,
    sets: Object.values(BG1_SETS), blocks, cells, smoke_cells: smoke,
    total_usd: counted.estimate_usd, plan_total_usd: counted.plan_usd, cap_usd: counted.cap_usd,
    stage1_cap_usd: stage1Cap, stage1_estimate_usd: stage1, campaign_id: BG1_CAMPAIGN_ID,
    judge_check: { ...JUDGE_CHECK_PLAN, estimate_usd: judgeCheck },
    frontier_judges: { ...BG1_JUDGE_BY_READER }, reread_plans: rereads,
    waves: { A: units((c, i) => i < waveA(c)), B: units((c, i) => i >= waveA(c)) },
  };
}

/** Stage 1's refusal: its estimate above its cap stops `cell.ts plan --manifest bg1` before any campaign is written. */
export function bg1Stage1OverCap(m: Pick<BG1Manifest, 'stage1_estimate_usd' | 'stage1_cap_usd'>): ScoreboardMessage | null {
  if (m.stage1_estimate_usd <= m.stage1_cap_usd) return null;
  return {
    code: 'BG1_STAGE1_OVER_CAP',
    message: `BG1 stage 1 is estimated at $${m.stage1_estimate_usd.toFixed(2)}, above its $${m.stage1_cap_usd.toFixed(2)} cap`,
    why: 'stage 1\'s cap is min(300, the larger of its estimate / 0.75 and its smoke leases) under the preregistration\'s Amendment 1; a larger stage 1 or a smaller scope is GBEV-3\'s call, never the planner\'s',
    fix: { next: 'ask_user', user_message: 'bring the stage 1 estimate and its lines (bg1-cells.json smoke_cells, the BG1-S1 re-read plans and the judge check) to GBEV-3', verify: ['bun', 'eval/runner/q1/cell.ts', 'plan', '--manifest', 'bg1'] },
    state: { stage1_estimate_usd: m.stage1_estimate_usd, stage1_cap_usd: m.stage1_cap_usd, side_effects: 'none: no campaign manifest written, nothing reserved' },
  };
}

export const bg1ManifestText = (m: BG1Manifest = buildBG1Manifest()) => JSON.stringify(m, null, 2) + '\n';
export const loadBG1Manifest = (path = BG1_MANIFEST_PATH) => JSON.parse(readFileSync(path, 'utf8')) as BG1Manifest;

if (import.meta.main) {
  writeFileSync(BG1_MANIFEST_PATH, bg1ManifestText());
  const m = buildBG1Manifest();
  console.log(`eval/runner/q1/cells/bg1-cells.json written (${m.cells.length} cells, ${m.smoke_cells.length} stage 1 cells, ${m.reread_plans.length} re-read plans)`);
}
