/**
 * BEAM-10M on gbrain's newest release (docs/benchmarks/2026-11-19-beam10m-newest-preregistration.md, GST-3139), built
 * with Q1's tooling (definitions.ts makeCell, estimateCell, definitionProblems) and F6's lease helpers, so a cell here is
 * a Q1 cell definition the same runner executes: `bun eval/runner/q1/cell.ts run --cell <id> --manifest bn10`.
 *
 *   Counted (block BN10, set S1, sealed): gbrain at the newest release on F6's build path (configuration bn10-newest),
 *     arms P and A0 packed to 8,000 tokens with F6's retrieval identities, and the whole system: a bare `query` under
 *     P's six search keys, read at gbrain's own default amount. Readers claude-opus-5-5 and gpt-6.2-sol.
 *   Dry run (block BN10-dry, set S2b-ingest: public BEAM-1M dev conversation 1m-16, 10 questions): the same cell, the
 *     per-arm pilot of amendment A2.
 *   Re-read plans: particle-1 re-reads every arm's frozen contexts byte for byte (reread-cell.ts), each with its own
 *     estimate; they run only in paid windows.
 *
 * Judging: every answer gets BEAM's canonical judge (gpt-4.1-mini), the bridge view, and exactly one frontier judge by
 * the reader's family (frontier.per_reader, definitions.ts frontierJudgeOf): gpt-6.1-sol for claude-opus-5-5 and
 * particle-1, claude-opus-5-5 for gpt-6.2-sol, every call pinned to PER_READER_JUDGE_SETTINGS. The readers are named here, not in the runner's shared FRONTIER_READERS
 * (amendment A1).
 *
 * `bun eval/runner/q1/cells/bn10.ts` regenerates bn10-cells.json; a test fails when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_SETS, ASSUMPTIONS, BN10_ASSUMPTIONS, estimateCell, F6_ASSUMPTIONS, frontierJudgeOf, makeCell, MANIFEST_SCHEMA, PER_READER_JUDGE_SETTINGS, priceOf,
  type ArmDefinition, type ArmSpec, type BlockId, type BN10BlockId, type CellDefinition, type Manifest, type SetId,
} from './definitions.ts';
import { extractionCapUsd, F6_ARMS, withHours, withLease } from './f6.ts';
import type { RereadPlan } from './rs1.ts';

export const BN10_MANIFEST_PATH = resolve(import.meta.dir, 'bn10-cells.json');
export const BN10_PREREGISTRATION = 'docs/benchmarks/2026-11-19-beam10m-newest-preregistration.md';
export const BN10_CAMPAIGN_ID = 'q1-scoreboard-bn10-newest';
export const BN10_CONFIGURATION = 'bn10-newest';
/** The dry run's preregistered runaway cap (plan X row 1), shared by its campaign and its particle-1 re-reads. */
export const BN10_DRY_RUN_CAP_USD = 37;

export const OPUS = 'anthropic:claude-opus-5-5';
export const SOL = 'openai:gpt-6.2-sol';
export const PARTICLE = 'particle:particle-1';
/** Live readers; particle-1 re-reads the frozen contexts (reread-cell.ts), so it is the third reader of every arm. */
export const BN10_READERS = [OPUS, SOL];

const perReader = (readers: string[]): NonNullable<ArmDefinition['frontier']> => ({ judges: [...new Set(readers.map(frontierJudgeOf))].sort(), readers: null, sample: null, per_reader: true, settings: { ...PER_READER_JUDGE_SETTINGS } });
const frontier = perReader(BN10_READERS);
export const BN10_ARMS: ArmSpec[] = [
  { id: 'p', mode: 'packed', budget: 8000, label: F6_ARMS.p.label, retrieval: F6_ARMS.p.retrieval, readers: BN10_READERS, frontier },
  { id: 'a0', mode: 'packed', budget: 8000, label: F6_ARMS.a0.label, retrieval: F6_ARMS.a0.retrieval, readers: BN10_READERS, frontier },
  { id: 'whole', mode: 'native-default', label: 'whole system: a bare query under P\'s search keys, read at gbrain\'s own default amount',
    retrieval: { op: 'query', args: {}, overlay: { ...F6_ARMS.p.retrieval.overlay } }, readers: BN10_READERS, frontier },
];

const noProbes = (set: SetId) => ({ sample: 0, seed: `bn10-probes-${set.toLowerCase()}`, conversations: 0 });
const cell = (set: SetId, block: BN10BlockId) => withHours(withLease(makeCell(set, 'gbrain-defaults', BN10_CONFIGURATION, BN10_ARMS, {
  block, probes: noProbes(set), launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(set)) },
})));

/** The counted cell: gbrain's three arms on the sealed BEAM-10M set. */
export const generateBN10Cells = (): CellDefinition[] => [cell('S1', 'BN10')];
/** The dry run and per-arm pilot: the same cell on public BEAM-1M dev conversation 1m-16. */
export const generateBN10DryRunCells = (): CellDefinition[] => [cell('S2b-ingest', 'BN10-dry')];

/**
 * particle-1's re-read of each arm (eval/runner/q1/reread-cell.ts): every frozen context read once and judged by the
 * canonical judge and particle-1's frontier judge, priced by estimateCell's reader and judge lines with particle-1 as the
 * arm's only reader. The whole arm's contexts are frozen too (native-default), so it gets a plan like the packed arms.
 */
export function rereadPlans(cells: CellDefinition[]): RereadPlan[] {
  return cells.flatMap(c => c.arms.filter(a => a.mode === 'packed' || a.mode === 'native-default').map(a => {
    const fr = a.frontier ? { ...a.frontier, judges: [frontierJudgeOf(PARTICLE)] } : null;
    const e = estimateCell({ ...c, arms: [{ ...a, readers: [PARTICLE], reader_replicates: {}, frontier: fr }] });
    const lines = Object.fromEntries(['readers', 'judges', 'frontier_judges'].filter(k => e.lines[k]).map(k => [k, e.lines[k]]));
    return { id: `${a.cell_id}.reread-${PARTICLE.replace(/[^a-z0-9.-]+/gi, '-')}`, cell: c.id, arm: a.id, arm_cell_id: a.cell_id, reader: PARTICLE, set: a.set, block: c.block,
      judges: [ASSUMPTIONS.judge.beam.model, ...(fr?.judges ?? [])], estimate: { usd: Math.round(Object.values(lines).reduce((s, v) => s + v, 0) * 100) / 100, lines } };
  }));
}

const BN10_BLOCKS: Record<BN10BlockId, string> = {
  'BN10-dry': 'BEAM-10M re-measure dry run and per-arm pilot (public BEAM-1M dev conversation 1m-16; arms P, A0 and whole; both judge views; particle-1 re-reads)',
  BN10: 'BEAM-10M re-measure counted cell (gbrain at the newest release: arms P, A0 and whole on the sealed set)',
};

export interface BN10Manifest extends Manifest {
  f6_assumptions: typeof F6_ASSUMPTIONS; bn10_assumptions: typeof BN10_ASSUMPTIONS; campaign_id: string;
  dry_run_cap_usd: number; dry_run_estimate_usd: number;
  /** The most the dry run's particle-1 re-reads may hold on their ledger: their estimate, kept out of the dry-run campaign's cap so both fit its cap. */
  dry_run_reread_cap_usd: number;
  frontier_judges: Record<string, string>; reread_plans: RereadPlan[];
}

export function buildBN10Manifest(): BN10Manifest {
  const cells = generateBN10Cells();
  const smoke = generateBN10DryRunCells();
  const rereads = [...rereadPlans(cells), ...rereadPlans(smoke)];
  const round = (x: number) => Math.round(x * 100) / 100;
  const cellsUsd = (id: BN10BlockId) => [...cells, ...smoke].filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0);
  const rereadsUsd = (id: BN10BlockId) => rereads.filter(r => r.block === id).reduce((s, r) => s + r.estimate.usd, 0);
  const blockUsd = (id: BN10BlockId) => round(cellsUsd(id) + rereadsUsd(id));
  // The counted block stops at 1.5 times its cell's estimate (its re-reads spend from their own ledgers), or at its
  // shards' leases where they hold more; the dry run at its preregistered cap, shared with its re-reads.
  const blocks = (Object.keys(BN10_BLOCKS) as BN10BlockId[]).map(id => ({ id: id as BlockId, label: BN10_BLOCKS[id], plan_usd: blockUsd(id), estimate_usd: blockUsd(id),
    cap_usd: id === 'BN10-dry' ? BN10_DRY_RUN_CAP_USD : round(Math.max(cellsUsd(id) * 1.5, cells.reduce((s, c) => s + c.lease!.usd * c.shards, 0))) }));
  const dryRereads = round(rereadsUsd('BN10-dry'));
  const all = [...BN10_READERS, PARTICLE];
  const models = [...all, ...all.map(frontierJudgeOf), ASSUMPTIONS.judge.beam.model, F6_ASSUMPTIONS.extraction.model].map(m => [m, priceOf(m)] as const);
  const counted = blocks.find(b => b.id === 'BN10')!;
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/bn10.ts', preregistration: BN10_PREREGISTRATION, readers: BN10_READERS, effort: 'medium',
    prices: Object.fromEntries([...new Map(models)].sort(([a], [b]) => (a < b ? -1 : 1))), assumptions: ASSUMPTIONS, f6_assumptions: F6_ASSUMPTIONS, bn10_assumptions: BN10_ASSUMPTIONS,
    sets: [ALL_SETS.S1, ALL_SETS['S2b-ingest']], blocks, cells, smoke_cells: smoke,
    total_usd: counted.estimate_usd, plan_total_usd: counted.plan_usd, cap_usd: counted.cap_usd,
    dry_run_cap_usd: round(BN10_DRY_RUN_CAP_USD - dryRereads), dry_run_estimate_usd: blocks.find(b => b.id === 'BN10-dry')!.estimate_usd, dry_run_reread_cap_usd: dryRereads,
    campaign_id: BN10_CAMPAIGN_ID, frontier_judges: Object.fromEntries(all.map(r => [r, frontierJudgeOf(r)])), reread_plans: rereads,
  };
}

export const bn10ManifestText = (m: BN10Manifest = buildBN10Manifest()) => JSON.stringify(m, null, 2) + '\n';
export const loadBN10Manifest = (path = BN10_MANIFEST_PATH) => JSON.parse(readFileSync(path, 'utf8')) as BN10Manifest;

if (import.meta.main) {
  writeFileSync(BN10_MANIFEST_PATH, bn10ManifestText());
  const m = buildBN10Manifest();
  console.log(`eval/runner/q1/cells/bn10-cells.json written (${m.cells.length} cell, ${m.smoke_cells.length} dry-run cell, ${m.reread_plans.length} re-read plans; estimate $${m.total_usd}, dry run $${m.dry_run_estimate_usd} of $${BN10_DRY_RUN_CAP_USD})`);
}
