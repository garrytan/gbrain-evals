/**
 * RS1 cell definitions: the narrowed RS1 test (docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md, GST-1886 PR 1),
 * built with Q1's tooling (definitions.ts makeCell, estimateCell, definitionProblems) and F6's lease helpers, so an RS1
 * cell is a Q1 cell definition the same runner executes: `bun eval/runner/q1/cell.ts run --cell <id> --manifest rs1`.
 *
 *   Counted (set RS1, sealed, at the cap of 33 kept conversations): gbrain at the `stable` tag (configuration
 *     rs1-stable, F6's build path with arm P's retrieval), the memory-bank server (recipe) and the extract-first server
 *     (common) at 8,000 tokens, and the no-memory floor; readers claude-opus-5-5 and gpt-6.1-sol. Each cell runs as
 *     launch units of five kept conversations in slot order (kept_units): units 0 to 3 are wave A (the first 20 kept),
 *     the rest wave B, whose cells a dated amendment regenerates once the pilot sets N_final.
 *   Stage 1 (block RS1-S1, set RS1-dev2: public BEAM-1M dev conversations 1m-20 and 1m-28, at most $60): the same four
 *     cells.
 *   Re-read plans: particle-1 re-reads every row's frozen contexts byte for byte (reread-cell.ts), each with its own
 *     estimate; they run only in paid windows.
 *
 * Judging: every answer gets BEAM's canonical judge (gpt-4.1-mini), descriptive only since the R78 amendment. The three
 * system rows also get exactly one gating judge per answer by the reader's family (frontier.per_reader, definitions.ts
 * frontierJudgeOf: gpt-6-astra for claude-opus-5-5, claude-opus-5-5 for gpt-6.1-sol and particle-1), pinned to medium
 * effort and an 8,000-token output cap; the floor gets the canonical judge only. The two judge views are scored apart
 * (eval/runner/rs1/verdict.ts), never averaged, and only the gating view decides.
 *
 * `bun eval/runner/q1/cells/rs1.ts` regenerates rs1-cells.json; a test fails when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScoreboardMessage } from '../scoreboard-errors.ts';
import {
  ALL_SETS, ASSUMPTIONS, estimateCell, F6_ASSUMPTIONS, frontierJudgeOf, makeCell, MANIFEST_SCHEMA, PER_READER_JUDGE_SETTINGS, priceOf, RS1_ASSUMPTIONS,
  type ArmDefinition, type ArmSpec, type BlockId, type CellDefinition, type CellEstimate, type Manifest, type RS1BlockId, type SetId,
} from './definitions.ts';
import { extractionCapUsd, F6_ARMS, withHours, withLease } from './f6.ts';

export const RS1_MANIFEST_PATH = resolve(import.meta.dir, 'rs1-cells.json');
export const RS1_PREREGISTRATION = 'docs/benchmarks/2026-11-08-rs1-narrow-preregistration.md';
export const RS1_CAMPAIGN_ID = 'q1-scoreboard-rs1-narrow';
/** GBEV-3, 2026-11-08 (option 2b): plan $2,033 all-in, ceiling $2,722, check-in at a projected $2,300; stage 1 at most $60. */
export const RS1_PLAN_USD = 2033;
export const RS1_STAGE1_CAP_USD = 60;
/** Kept conversations per launch unit, the cap on N_final and wave A's size (the internal pilot). */
export const RS1_KEPT_UNITS = 5;
export const RS1_CAP_CONVERSATIONS = 33;
export const RS1_WAVE_A = 20;

export const OPUS = 'anthropic:claude-opus-5-5';
export const SOL = 'openai:gpt-6.1-sol';
export const PARTICLE = 'particle:particle-1';
/** Live readers; particle-1 re-reads the frozen contexts (reread-cell.ts), so it is the third reader of every row. */
export const RS1_READERS = [OPUS, SOL];

const perReader = (readers: string[]): NonNullable<ArmDefinition['frontier']> => ({ judges: [...new Set(readers.map(frontierJudgeOf))].sort(), readers: null, sample: null, per_reader: true, settings: { ...PER_READER_JUDGE_SETTINGS } });
const p = (): ArmSpec => ({ id: 'p', mode: 'packed', budget: 8000, label: F6_ARMS.p.label, retrieval: F6_ARMS.p.retrieval, readers: RS1_READERS, frontier: perReader(RS1_READERS) });
const b8 = (frontier: boolean): ArmSpec => ({ id: 'component-b8000', mode: 'packed', budget: 8000, label: 'component, 8,000 tokens', readers: RS1_READERS, frontier: frontier ? perReader(RS1_READERS) : null });

/** No write-to-queryable probes on any RS1 cell. */
const noProbes = (set: SetId) => ({ sample: 0, seed: `rs1-probes-${set.toLowerCase()}`, conversations: 0 });
const cell = (set: SetId, block: RS1BlockId, system: string, configuration: string, arms: ArmSpec[]) => withHours(withLease(makeCell(set, system, configuration, arms, {
  block, probes: noProbes(set), ...(set === 'RS1' ? { keptUnits: RS1_KEPT_UNITS } : {}),
  ...(system === 'gbrain-defaults' ? { launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(set)) } } : {}),
})));
const rows = (set: SetId, block: RS1BlockId) => [
  cell(set, block, 'gbrain-defaults', 'rs1-stable', [p()]),
  cell(set, block, 'ext-memory-bank', 'recipe', [b8(true)]),
  cell(set, block, 'ext-extract-first', 'common', [b8(true)]),
  cell(set, block, 'baseline-none', 'baseline', [b8(false)]),
];

/** RS1's counted cells: gbrain, the two servers and the floor, on the kept conversations. */
export const generateRS1Cells = (): CellDefinition[] => rows('RS1', 'RS1');
/** Stage 1: the same four cells on two public BEAM-1M dev conversations. */
export const generateRS1Stage1Cells = (): CellDefinition[] => rows('RS1-dev2', 'RS1-S1');

export interface RereadPlan { id: string; cell: string; arm: string; arm_cell_id: string; reader: string; set: SetId; block: BlockId; judges: string[]; estimate: CellEstimate }

/**
 * particle-1's re-read of each row (eval/runner/q1/reread-cell.ts, under rereadCellId's id): every frozen context read
 * once and judged by the canonical judge, plus particle-1's frontier judge on the system rows, priced by estimateCell's
 * reader and judge lines with particle-1 as the arm's only reader.
 */
export function rereadPlans(cells: CellDefinition[]): RereadPlan[] {
  return cells.flatMap(c => c.arms.filter(a => a.mode === 'packed').map(a => {
    const frontier = a.frontier ? { ...a.frontier, judges: [frontierJudgeOf(PARTICLE)] } : null;
    const e = estimateCell({ ...c, arms: [{ ...a, readers: [PARTICLE], reader_replicates: {}, frontier }] });
    const lines = Object.fromEntries(['readers', 'judges', 'frontier_judges'].filter(k => e.lines[k]).map(k => [k, e.lines[k]]));
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block,
      judges: [ASSUMPTIONS.judge.beam.model, ...(frontier?.judges ?? [])], estimate: { usd: Math.round(Object.values(lines).reduce((s, v) => s + v, 0) * 100) / 100, lines } };
  }));
}

const RS1_BLOCKS: Record<RS1BlockId, string> = {
  'RS1-S1': 'RS1 stage 1 (public BEAM-1M dev conversations 1m-20 and 1m-28; every row, both judge views, particle-1 re-reads)',
  RS1: 'RS1 counted cells at the cap of 33 kept conversations (gbrain arm P at the stable tag, the two servers, the floor)',
};

export interface RS1Manifest extends Manifest {
  rs1_assumptions: typeof RS1_ASSUMPTIONS; f6_assumptions: typeof F6_ASSUMPTIONS; campaign_id: string;
  stage1_cap_usd: number; stage1_estimate_usd: number; dry_run_cap_usd: number;
  /** The most stage 1's particle-1 re-reads may hold on their ledger: their estimate, kept out of the dry-run campaign's cap so both fit $60. */
  stage1_reread_cap_usd: number;
  frontier_judges: Record<string, string>; reread_plans: RereadPlan[];
  /** Launch units by wave: A runs the first 20 kept conversations (units 0 to 3), B the rest up to N_final. */
  waves: { A: string[]; B: string[] };
}

export function buildRS1Manifest(): RS1Manifest {
  const cells = generateRS1Cells();
  const smoke = generateRS1Stage1Cells();
  const rereads = [...rereadPlans(cells), ...rereadPlans(smoke)];
  const round = (x: number) => Math.round(x * 100) / 100;
  const cellsUsd = (id: RS1BlockId) => [...cells, ...smoke].filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0);
  const rereadsUsd = (id: RS1BlockId) => rereads.filter(r => r.block === id).reduce((s, r) => s + r.estimate.usd, 0);
  const blockUsd = (id: RS1BlockId) => round(cellsUsd(id) + rereadsUsd(id));
  // The counted block stops at 1.5 times its cells' estimate (its re-reads spend from their own ledgers, not the block), or at
  // its units' leases where they hold more; stage 1 at its own cap, shared by the dry-run campaign and the stage 1 re-reads.
  const blocks = (Object.keys(RS1_BLOCKS) as RS1BlockId[]).map(id => ({ id: id as BlockId, label: RS1_BLOCKS[id], plan_usd: blockUsd(id), estimate_usd: blockUsd(id),
    cap_usd: id === 'RS1-S1' ? RS1_STAGE1_CAP_USD : round(Math.max(cellsUsd(id) * 1.5, cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0))) }));
  const stage1Rereads = round(rereadsUsd('RS1-S1'));
  const units = (from: number, to: number) => cells.flatMap(c => Array.from({ length: c.shards }, (_, i) => i).filter(i => i >= from && i < to).map(i => `${c.id}.c${i}`));
  const waveA = RS1_WAVE_A / RS1_KEPT_UNITS;
  const models = [...RS1_READERS, PARTICLE, ...[...RS1_READERS, PARTICLE].map(frontierJudgeOf), ASSUMPTIONS.judge.beam.model, F6_ASSUMPTIONS.extraction.model].map(m => [m, priceOf(m)] as const);
  const counted = blocks.find(b => b.id === 'RS1')!;
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/rs1.ts', preregistration: RS1_PREREGISTRATION, readers: RS1_READERS, effort: 'medium',
    prices: Object.fromEntries([...new Map(models)].sort(([a], [b]) => (a < b ? -1 : 1))), assumptions: ASSUMPTIONS, f6_assumptions: F6_ASSUMPTIONS, rs1_assumptions: RS1_ASSUMPTIONS,
    sets: [ALL_SETS.RS1, ALL_SETS['RS1-dev2']], blocks, cells, smoke_cells: smoke,
    total_usd: counted.estimate_usd, plan_total_usd: RS1_PLAN_USD, cap_usd: counted.cap_usd,
    stage1_cap_usd: RS1_STAGE1_CAP_USD, stage1_estimate_usd: blocks.find(b => b.id === 'RS1-S1')!.estimate_usd, dry_run_cap_usd: round(RS1_STAGE1_CAP_USD - stage1Rereads),
    stage1_reread_cap_usd: stage1Rereads, campaign_id: RS1_CAMPAIGN_ID,
    frontier_judges: Object.fromEntries([...RS1_READERS, PARTICLE].map(r => [r, frontierJudgeOf(r)])), reread_plans: rereads,
    waves: { A: units(0, waveA), B: units(waveA, Infinity) },
  };
}

/** Stage 1's refusal: its estimate above its fixed cap stops `cell.ts plan --manifest rs1` before any campaign is written. */
export function stage1OverCap(m: Pick<RS1Manifest, 'stage1_estimate_usd' | 'stage1_cap_usd'>): ScoreboardMessage | null {
  if (m.stage1_estimate_usd <= m.stage1_cap_usd) return null;
  return {
    code: 'RS1_STAGE1_OVER_CAP',
    message: `stage 1 is estimated at $${m.stage1_estimate_usd.toFixed(2)}, above its fixed $${m.stage1_cap_usd.toFixed(2)} cap by $${(m.stage1_estimate_usd - m.stage1_cap_usd).toFixed(2)}`,
    why: 'stage 1\'s cap is fixed in the preregistration; a larger stage 1 or a smaller scope is GBEV-3\'s call, never the planner\'s',
    fix: { next: 'ask_user', user_message: 'bring the stage 1 estimate and its lines (rs1-cells.json smoke_cells and the RS1-S1 re-read plans) to GBEV-3', verify: ['bun', 'eval/runner/q1/cell.ts', 'plan', '--manifest', 'rs1'] },
    state: { stage1_estimate_usd: m.stage1_estimate_usd, stage1_cap_usd: m.stage1_cap_usd, side_effects: 'none: no campaign manifest written, nothing reserved' },
  };
}

export const rs1ManifestText = (m: RS1Manifest = buildRS1Manifest()) => JSON.stringify(m, null, 2) + '\n';
export const loadRS1Manifest = (path = RS1_MANIFEST_PATH) => JSON.parse(readFileSync(path, 'utf8')) as RS1Manifest;

if (import.meta.main) {
  writeFileSync(RS1_MANIFEST_PATH, rs1ManifestText());
  const m = buildRS1Manifest();
  console.log(`eval/runner/q1/cells/rs1-cells.json written (${m.cells.length} cells, ${m.smoke_cells.length} stage 1 cells, ${m.reread_plans.length} re-read plans; estimate $${m.total_usd}, stage 1 $${m.stage1_estimate_usd} of $${m.stage1_cap_usd})`);
}
