/**
 * F6 cell definitions: the preregistered current-master rerun of the Q1 BEAM-10M scoreboard at an 8,000-token reader
 * budget (docs/benchmarks/2026-10-29-f6-current-master-preregistration.md, approved with a $3,100 cap).
 *
 * Built with Q1's own tooling (definitions.ts makeCell, estimateCell, definitionProblems), so an F6 cell is a Q1 cell
 * definition the same runner executes (`bun eval/runner/q1/cell.ts run --cell <id>` finds F6 ids here). What F6 adds:
 *
 *   gbrain at the F6 pin (configuration f6-master, GBRAIN_F6=1): one brain per conversation built with gbrain's
 *     conversation fact extraction under a recorded cap, served on the full surface, read by seven arms that each name
 *     their retrieval exactly (RetrievalIdentity: op, args and the six-key search overlay). The runner retrieves
 *     policy-major on these cells, so the shim switches its overlay once per arm per conversation.
 *   the temporal graph's 0.31.2 shipped defaults (configuration shipped-0.31), component arm only.
 *   the D8 long-history reserve (set D8, loader beam-d8, owner custody).
 *   the LongMemEval-S shootout slice for the gbrain arms, lowest priority.
 *
 * Competitor and baseline rows of S1, S2b, S2a and S3 are reused from A24 through publish.ts sources, gated by
 * eval/runner/q1/reuse-check.ts, except the two systems the gate refuses: baseline-file-agent and baseline-hybrid run
 * again on S1 at the current tree (Q1's file-agent arm, and the hybrid's 8,000-token component arm), priced from Q1. No judge repeats, reader replicates, 2k/16k sweep, own-answer arms
 * or write-to-queryable probes; frontier judges re-judge only the S1 claude-sonnet-5-5 answers of arms P and D.
 *
 * `bun eval/runner/q1/cells/f6.ts` regenerates f6-cells.json; a test fails when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_PRICE_OVERRIDES, reservationUsd } from '../../budget-ledger.ts';
import { DEFAULT_ROUTE_CAPS } from '../../metering-proxy.ts';
import {
  ALL_SETS, ASSUMPTIONS, F6_ASSUMPTIONS, f6ExtractionUsd, FRONTIER_JUDGES, makeCell, MANIFEST_SCHEMA, OVERLAY_KEYS, priceOf, READERS, SONNET,
  type ArmSpec, type BlockId, type CellDefinition, type F6BlockId, type Manifest, type RetrievalIdentity, type SetId,
} from './definitions.ts';

export const F6_MANIFEST_PATH = resolve(import.meta.dir, 'f6-cells.json');
export const F6_PREREGISTRATION = 'docs/benchmarks/2026-10-29-f6-current-master-preregistration.md';
/** Garry's approval, 2026-10-27: F6's cap, the dry run included. */
export const F6_CAP_USD = 3100;
export const F6_DRY_RUN_CAP_USD = 60;
/** What the dry run spent (both dry-run campaigns, settled leases; docs/benchmarks/2026-10-29-f6-current-master/dry-run/). */
export const F6_DRY_RUN_SPENT_USD = 31.17;
/** The counted campaign's cap: F6's approval less what the dry run already spent against it. */
export const F6_COUNTED_CAP_USD = Math.round((F6_CAP_USD - F6_DRY_RUN_SPENT_USD) * 100) / 100;
export const F6_CAMPAIGN_ID = 'q1-scoreboard-f6-current-master';

type Overlay = Record<(typeof OVERLAY_KEYS)[number], boolean | string>;
/** Arm A's search keys: every GBRA-205 delivery feature off, chunk budgets, saved facts superseding. */
const BASE: Overlay = {
  'search.evidence_date_header': false, 'search.evidence_titles': false, 'search.fact_source_pages': false,
  'search.query_budget_unit': 'chunk', 'search.query_facts_block': false, 'search.saved_facts_supersede': true,
};
const C_KEYS = { 'search.query_budget_unit': 'auto', 'search.evidence_date_header': true, 'search.evidence_titles': true };
const Q = { limit: 50, token_budget: 5500 };

/** The seven gbrain arms, every one at 8,000 tokens on one brain per conversation; each writes all six search keys. */
export const F6_ARMS: Record<string, { label: string; retrieval: RetrievalIdentity }> = {
  a0: { label: 'A0: query limit 50, no token_budget (the harness packs 8,000 from gbrain\'s auto delivery)', retrieval: { op: 'query', args: { limit: 50 }, overlay: { ...BASE } } },
  a: { label: 'A: query token_budget 5,500, chunk unit, no facts block, no headers', retrieval: { op: 'query', args: { ...Q }, overlay: { ...BASE } } },
  p: { label: 'P: A with the facts block', retrieval: { op: 'query', args: { ...Q }, overlay: { ...BASE, 'search.query_facts_block': true } } },
  b: { label: 'B: recall budget_tokens 5,500 (facts first, then pages)', retrieval: { op: 'recall', args: { budget_tokens: 5500 }, overlay: { ...BASE } } },
  c: { label: 'C: A with auto unit, date headers and titles', retrieval: { op: 'query', args: { ...Q }, overlay: { ...BASE, ...C_KEYS } } },
  d: { label: 'D: C with the facts block', retrieval: { op: 'query', args: { ...Q }, overlay: { ...BASE, ...C_KEYS, 'search.query_facts_block': true } } },
  e: { label: 'E: D with fact source pages', retrieval: { op: 'query', args: { ...Q }, overlay: { ...BASE, ...C_KEYS, 'search.query_facts_block': true, 'search.fact_source_pages': true } } },
};
export const ALL_ARMS = ['a0', 'a', 'p', 'b', 'c', 'd', 'e'];
export const D8_GBRAIN_ARMS = ['a', 'p', 'b', 'd'];
/** D8's comparison rows, each at its Q1 headline configuration for BEAM sets other than S1. */
export const D8_SYSTEMS: Array<[string, string]> = [['ext-memory-bank', 'recipe'], ['ext-graph-pipeline', 'recipe'], ['baseline-hybrid', 'baseline'], ['baseline-none', 'baseline']];

const FRONTIER_S1 = { judges: FRONTIER_JUDGES, readers: [SONNET], sample: null };
const gbrainArms = (ids: string[], frontier: string[] = []): ArmSpec[] =>
  ids.map(id => ({ id, mode: 'packed' as const, budget: 8000, label: F6_ARMS[id].label, retrieval: F6_ARMS[id].retrieval, ...(frontier.includes(id) ? { frontier: FRONTIER_S1 } : {}) }));
const b8 = (): ArmSpec => ({ id: 'component-b8000', mode: 'packed', budget: 8000, label: 'component, 8,000 tokens' });
/**
 * The S1 baselines the reuse check refuses, rerun at the current tree and priced from Q1's measured spend (an upper
 * bound: F6 drops Q1's frontier judging, judge repeats, Sonnet replicates and the hybrid's 2k/16k sweep).
 */
export const F6_MEASURED_ESTIMATES: Record<string, { usd: number; basis: string }> = {
  's1.baseline-file-agent.baseline': { usd: 275.96, basis: 'Q1 measured spend of the S1 file agent (whole-agent, 40 turns, three readers)' },
  's1.baseline-hybrid.baseline': { usd: 95.1, basis: 'Q1 clean-run price of the S1 hybrid baseline' },
};
/** No write-to-queryable probes: no conversation is probed at all (probes.conversations 0). */
const noProbes = (set: SetId) => ({ sample: 0, seed: `f6-probes-${set.toLowerCase()}`, conversations: 0 });
/** Each conversation's extraction cap: a multiple of its extraction estimate, at least $1, rounded up to the dollar. */
export function extractionCapUsd(set: SetId): number {
  const s = ALL_SETS[set];
  return Math.max(1, Math.ceil(F6_ASSUMPTIONS.extraction_cap_multiple * f6ExtractionUsd(s.corpus_tokens / s.conversations)));
}
/**
 * The largest single reservation a unit's metering proxy holds at once, as the proxy prices it: input reserved at the
 * request's bytes + 64 tokens (metering-proxy.ts) and output at the route cap, through budget-ledger reservationUsd.
 * The harness answers and judges one call at a time, and probes are off, so the peak is the larger of one harness call
 * and the system's own concurrent calls while it ingests (gbrain extracts one segment at a time on PGLite; the
 * temporal graph's calls are assumed 8 at once, each reserving 16,384 output tokens of gpt-6-luna).
 */
export function peakReservationUsd(c: CellDefinition): { usd: number; by: string } {
  const L = F6_ASSUMPTIONS.lease;
  const one = (model: string, inputBytes: number, maxOut: number) => {
    const p = CHAT_PRICE_OVERRIDES[model] ?? priceOf(model);
    return reservationUsd({ provider: model.split(':')[0], model: model.split(':')[1], kind: 'chat', ...p, inputTokens: inputBytes + 64, maxOutputTokens: maxOut });
  };
  const calls: Array<[string, number]> = [];
  for (const a of c.arms.filter(a => a.mode === 'packed')) for (const r of a.readers) calls.push([`reader ${r}`, one(r, Math.ceil((a.budget ?? 8000) * L.bytes_per_token) + L.template_bytes, DEFAULT_ROUTE_CAPS.reader)]);
  for (const a of c.arms.filter(a => a.mode === 'agent')) {
    const turns = a.readers.map(r => F6_ASSUMPTIONS.agent_first_turn_usd[r] ?? F6_ASSUMPTIONS.agent_first_turn_usd.default);
    calls.push([`file agent: one first turn per reader at once (${a.readers.length})`, turns.reduce((s, x) => s + x, 0)]);
  }
  const judges = [c.benchmark.startsWith('beam') ? ASSUMPTIONS.judge.beam.model : ASSUMPTIONS.judge.lme.model, ...c.arms.flatMap(a => a.frontier?.judges ?? [])];
  for (const j of judges) calls.push([`judge ${j}`, one(j, L.judge_bytes, DEFAULT_ROUTE_CAPS.judge)]);
  if (c.configuration === 'f6-master') calls.push([`extraction ${F6_ASSUMPTIONS.extraction.model}`, one(F6_ASSUMPTIONS.extraction.model, 64_000, DEFAULT_ROUTE_CAPS.extraction)]);
  if (c.configuration === 'shipped-0.31') calls.push(['temporal graph 8 x openai:gpt-6-luna', 8 * one('openai:gpt-6-luna', 40_000, 16_384)]);
  const [by, usd] = calls.sort((a, b) => b[1] - a[1])[0];
  return { usd: Math.round(usd * 10_000) / 10_000, by };
}
/** A unit's lease: its estimate per shard with the lease margin, plus twice the peak reservation, so the last calls of a unit near its estimate still fit. */
function withLease(c: CellDefinition): CellDefinition {
  const peak = peakReservationUsd(c);
  const usd = Math.ceil((c.estimate.usd / c.shards * F6_ASSUMPTIONS.lease.margin + 2 * peak.usd) * 100) / 100;
  return { ...c, lease: { usd, basis: `F6: estimate per shard x ${F6_ASSUMPTIONS.lease.margin} plus twice the peak reservation ($${peak.usd}, ${peak.by})` } };
}
const gbrain = (set: SetId, block: BlockId, ids: string[], frontier: string[] = []) =>
  withLease(makeCell(set, 'gbrain-defaults', 'f6-master', gbrainArms(ids, frontier), { block, probes: noProbes(set), launchEnv: { GBRAIN_F6_EXTRACT_CAP_USD: String(extractionCapUsd(set)) } }));
const other = (set: SetId, block: BlockId, system: string, configuration: string) => withLease(makeCell(set, system, configuration, [b8()], { block, probes: noProbes(set) }));
/** An S1 baseline rerun, with its estimate set from Q1's measured spend (F6_MEASURED_ESTIMATES). */
const rerun = (system: string, arm: ArmSpec) => {
  const c = makeCell('S1', system, 'baseline', [arm], { block: 'F6-S1', probes: noProbes('S1') });
  const m = F6_MEASURED_ESTIMATES[c.id];
  return withLease({ ...c, estimate: { usd: m.usd, lines: { q1_measured: m.usd } } });
};

/** F6's counted cells, in priority order (S4-slice last). */
export function generateF6Cells(): CellDefinition[] {
  return [
    gbrain('S1', 'F6-S1', ALL_ARMS, ['p', 'd']),
    other('S1', 'F6-S1', 'ext-temporal-graph', 'shipped-0.31'),
    rerun('baseline-file-agent', { id: 'whole-agent', mode: 'agent', label: 'file agent, uncapped grep, 40 turns' }),
    rerun('baseline-hybrid', b8()),
    ...(['S2b', 'S2a', 'S3'] as SetId[]).flatMap(set => [gbrain(set, 'F6-T2', ALL_ARMS), other(set, 'F6-T2', 'ext-temporal-graph', 'shipped-0.31')]),
    gbrain('D8', 'F6-D8', D8_GBRAIN_ARMS),
    ...D8_SYSTEMS.map(([system, configuration]) => other('D8', 'F6-D8', system, configuration)),
    gbrain('S4-slice', 'F6-S4', ALL_ARMS),
  ];
}

/**
 * The priced dry run (public data only, at most $60 against F6's cap): one public BEAM-1M dev conversation (1m-16, 10
 * questions) with all seven gbrain arms and the temporal graph 0.31.2, and LoCoMo conv-44 (20 questions) for the gbrain
 * arms; three readers, canonical judges.
 */
export function generateF6DryRunCells(): CellDefinition[] {
  return [
    gbrain('S2b-ingest', 'F6-dry', ALL_ARMS),
    other('S2b-ingest', 'F6-dry', 'ext-temporal-graph', 'shipped-0.31'),
    gbrain('S3-smoke', 'F6-dry', ALL_ARMS),
  ];
}

const F6_BLOCKS: Record<F6BlockId, string> = {
  'F6-S1': 'F6 S1 BEAM-10M (gbrain seven arms, temporal graph 0.31.2, file agent and hybrid baseline reruns)',
  'F6-T2': 'F6 S2b, S2a, S3 (gbrain seven arms, temporal graph 0.31.2)',
  'F6-D8': 'F6 D8 long-history reserve',
  'F6-S4': 'F6 S4-slice LongMemEval-S (lowest priority)',
  'F6-dry': 'F6 priced dry run (public dev data)',
};

export interface F6Manifest extends Manifest { f6_assumptions: typeof F6_ASSUMPTIONS; dry_run_cap_usd: number; dry_run_spent_usd: number; campaign_id: string }

export function buildF6Manifest(): F6Manifest {
  const cells = generateF6Cells();
  const smoke = generateF6DryRunCells();
  const round = (x: number) => Math.round(x * 100) / 100;
  const blocks = (Object.keys(F6_BLOCKS) as F6BlockId[]).filter(id => id !== 'F6-dry').map(id => {
    const estimate = round(cells.filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0));
    return { id: id as BlockId, label: F6_BLOCKS[id], plan_usd: estimate, estimate_usd: estimate, cap_usd: round(estimate * 1.5) };
  });
  const models = [...READERS, ...FRONTIER_JUDGES, ASSUMPTIONS.judge.lme.model, ASSUMPTIONS.judge.beam.model, F6_ASSUMPTIONS.extraction.model, 'openai:gpt-6-luna'].map(m => [m, priceOf(m)] as const);
  const sets = [...new Set([...cells, ...smoke].map(c => c.set))].map(s => ALL_SETS[s]);
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/f6.ts', preregistration: F6_PREREGISTRATION, readers: READERS, effort: 'medium',
    prices: Object.fromEntries(models.sort(([a], [b]) => (a < b ? -1 : 1))), assumptions: ASSUMPTIONS, f6_assumptions: F6_ASSUMPTIONS,
    sets, blocks, cells, smoke_cells: smoke,
    total_usd: round(blocks.reduce((s, b) => s + b.estimate_usd, 0)), plan_total_usd: F6_CAP_USD, cap_usd: F6_COUNTED_CAP_USD, dry_run_cap_usd: F6_DRY_RUN_CAP_USD, dry_run_spent_usd: F6_DRY_RUN_SPENT_USD, campaign_id: F6_CAMPAIGN_ID,
  };
}

export const f6ManifestText = (m: F6Manifest = buildF6Manifest()) => JSON.stringify(m, null, 2) + '\n';
export const loadF6Manifest = (path = F6_MANIFEST_PATH) => JSON.parse(readFileSync(path, 'utf8')) as F6Manifest;

if (import.meta.main) {
  writeFileSync(F6_MANIFEST_PATH, f6ManifestText());
  const m = buildF6Manifest();
  console.log(`eval/runner/q1/cells/f6-cells.json written (${m.cells.length} cells, ${m.smoke_cells.length} dry-run cells, estimate $${m.total_usd}, cap $${m.cap_usd})`);
}
