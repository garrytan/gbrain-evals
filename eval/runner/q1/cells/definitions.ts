/**
 * Q1 cell definitions (PLAN §7, preregistration docs/benchmarks/2026-10-06-scoreboard-preregistration.md).
 *
 * A cell is one system x configuration x set: one ingest realization per
 * conversation and one retrieval per question per policy, from which every
 * arm of the cell is derived. Each arm reports into one scoreboard cell
 * (`cells/<arm cell_id>/` in a receipt, eval/runner/scoreboard.ts).
 *
 *   CellDefinition   schema `gbrain-evals/q1-cell/v1` (eval/runner/q1/cells/schema.json):
 *     id             execution id, `<set>.<system>.<configuration>[.r<n>]`
 *     set, block     the set the cell selects questions from and the spend block it is charged to
 *     benchmark, split, selection, exclusions
 *                    which questions run: the split's conversations, then the selection
 *                    recipe (seeded, executed at run time so sealed ids never live here);
 *                    preregistered exclusions still run and are reported apart
 *     system         a kind id from eval/systems/kinds.json; `runner` says whether it is a
 *                    protocol v1 shim (one VM per conversation shard) or in process
 *     configuration  shipped-defaults | full-surface | recipe | common | common-embedder | baseline
 *     arms[]         ArmDefinition: mode (packed, native-default, own-answer, agent,
 *                    full-context, retrieval-only), policy, budget, readers and replicates,
 *                    the frontier-judge scope and the judge-repeat scope
 *     estimate       planned dollars, computed by `estimateCell` from the per-call prices in
 *                    eval/runner/budget-ledger.ts and the manifest's stated token assumptions
 *
 * `bun eval/runner/q1/cells/definitions.ts` regenerates q1-cells.json (the
 * manifest every `bun eval/runner/q1/cell.ts` command reads); a test fails when
 * the committed file is stale. A campaign manifest references a cell by its
 * `id` and a scoreboard cell by its arm `cell_id`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHAT_PRICE_OVERRIDES } from '../../budget-ledger.ts';
import { FRONTIER_READERS, READER_WINDOWS } from '../../systems/baselines.ts';

export const CELL_SCHEMA = 'gbrain-evals/q1-cell/v1';
export const MANIFEST_SCHEMA = 'gbrain-evals/q1-cell-manifest/v1';
export const MANIFEST_PATH = resolve(import.meta.dir, 'q1-cells.json');
export const SCHEMA_PATH = resolve(import.meta.dir, 'schema.json');
export const PREREGISTRATION = 'docs/benchmarks/2026-10-06-scoreboard-preregistration.md';

export type SetId = 'S1' | 'S1-sweep' | 'S2a' | 'S2b' | 'S3' | 'S4' | 'S4-slice' | 'S5' | 'S3-smoke' | 'S3-smoke-default' | 'S2b-ingest';
export type BlockId = 'T1' | 'T2-S2a' | 'T2-S2b' | 'T2-S3' | 'T2-S4-S5';
export type Split = 'dev' | 'sealed' | 'all';

export type Selection =
  | { kind: 'all' }
  /** `per_conversation` questions from every conversation, round-robin over categories, each category in sha256(seed, id) order. */
  | { kind: 'per-conversation'; per_conversation: number; seed: string }
  /** `limit` questions round-robin over strata (category, or conversation then category), each stratum in sha256(seed, id) order; `min` reserves a floor per category first. */
  | { kind: 'stratified'; limit: number; stratify: 'category' | 'conversation-category'; seed: string; min?: Record<string, number> }
  /** The shootout's slice: `selectQuestions(questions, limit, seed)` from eval/runner/memory-qa/run.ts. */
  | { kind: 'shootout-slice'; limit: number; seed: number };

export type ArmMode = 'packed' | 'native-default' | 'own-answer' | 'agent' | 'full-context' | 'retrieval-only';

export interface ArmDefinition {
  id: string;
  /** The scoreboard cell this arm writes: `<cell id>.<arm id>`. */
  cell_id: string;
  /** The scoreboard set (cohort) the arm reports into; a sub-selection gets its own set (S1-sweep, S4-slice). */
  set: SetId;
  arm: 'component' | 'whole-system' | 'diagnostic';
  mode: ArmMode;
  policy: 'fixed-evidence' | 'vendor-default' | null;
  budget: number | null;
  /** Own-answer arms: which answer route (gbrain `synthesize` or `think`). */
  variant?: 'synthesize' | 'think';
  /** A sub-selection of the cell's questions; null runs them all. */
  questions: Selection | null;
  readers: string[];
  reader_replicates: Record<string, number>;
  /** Frontier judges re-judging this arm's answers (replicate 0) under their own instrument ids: every answer of `readers` (null: every reader), or a seeded sample of `sample` questions. */
  frontier: { judges: string[]; readers: string[] | null; sample: number | null } | null;
  /** Judge-only repeats on fixed answers (eval/runner/judge-repeat.ts), planned here, run after the cell. */
  judge_repeats: { count: number; readers: string[] | null } | null;
  label: string;
  anchor?: boolean;
}

export interface CellEstimate { usd: number; lines: Record<string, number> }

export interface CellDefinition {
  schema: typeof CELL_SCHEMA;
  id: string;
  set: SetId;
  block: BlockId;
  benchmark: string;
  split: Split;
  selection: Selection;
  exclusions: Array<{ question_id: string; reason: string }>;
  system: string;
  configuration: string;
  runner: 'shim' | 'in-process';
  /** 1 for the counted realization; 2 for the disclosed LoCoMo ingestion replicate. */
  ingest_replicate: number;
  effort: 'medium';
  canonical_instrument: string;
  /** Write-start-to-queryable probes: the last session plus `sample` sessions per conversation, seeded. */
  probes: { sample: number; seed: string };
  /** Dev smoke cells: only these conversations of the split run (the set's `only_conversations`). */
  only_conversations?: string[];
  /** Ingest probes: write only the first N sessions of each conversation (a fixed fraction, for a system too slow or costly to ingest whole on a smoke). */
  ingest_sessions?: number;
  /** VM units: conversations per launch (a shim cell on S1 launches one VM per conversation). */
  shards: number;
  expected_hours: number;
  /** Shim cells: the stack's bootstrap environment and config (`GBRAIN_FULL_SURFACE=1` for gbrain's full-surface cell). */
  launch?: { env: Record<string, string>; config: 'recipe' | 'common' };
  /** Shim cells: tar the stack's named volumes into the realization once ingest is complete (the launcher sets SHOOTOUT_SNAPSHOT_DIR). */
  snapshot_command?: string;
  /** Shim cells: load that snapshot into a fresh stack before a resumed cell runs (the launcher sets SHOOTOUT_RESTORE_DIR). */
  restore_command?: string;
  arms: ArmDefinition[];
  estimate: CellEstimate;
}

export interface SetFacts {
  id: SetId; benchmark: string; split: Split; questions: number; conversations: number; corpus_tokens: number; messages: number;
  block: BlockId; selection: Selection; exclusions: Array<{ question_id: string; reason: string }>; role: 'headline' | 'public' | 'smoke'; exposure: 'E0' | 'E2' | 'E3'; label: string;
  /** Smoke sets: the dev conversations that run (the rest of the split is never loaded). */
  only_conversations?: string[];
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  generated_by: string;
  preregistration: string;
  readers: string[];
  effort: 'medium';
  prices: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }>;
  assumptions: typeof ASSUMPTIONS;
  sets: SetFacts[];
  blocks: Array<{ id: BlockId; label: string; plan_usd: number; estimate_usd: number; cap_usd: number }>;
  cells: CellDefinition[];
  /** Paid dev smokes (`generateSmokeCells`): dev conversations only, outside every block total. */
  smoke_cells: CellDefinition[];
  total_usd: number;
  plan_total_usd: number;
  cap_usd: number;
}

// ─── Sets (preregistration "Data, exposure and custody") ─────────────

const BEAM10M_EXCLUSION = { question_id: '10m-1:abstention:0', reason: 'exposed in another thread\'s audit (eval/decisions/splits/beam-10m.json exclusions); run and reported apart, never in the confirmatory cohort' };

export const SETS: Record<SetId, SetFacts> = {
  S1: { id: 'S1', benchmark: 'beam-10m', split: 'sealed', questions: 200, conversations: 10, corpus_tokens: 110_000_000, messages: 70_000, block: 'T1', selection: { kind: 'all' }, exclusions: [BEAM10M_EXCLUSION], role: 'headline', exposure: 'E0', label: 'BEAM-10M' },
  'S1-sweep': { id: 'S1-sweep', benchmark: 'beam-10m', split: 'sealed', questions: 100, conversations: 10, corpus_tokens: 110_000_000, messages: 70_000, block: 'T1', selection: { kind: 'stratified', limit: 100, stratify: 'conversation-category', seed: 'q1-sweep' }, exclusions: [BEAM10M_EXCLUSION], role: 'public', exposure: 'E0', label: 'BEAM-10M, 2k/16k sweep subset' },
  S2a: { id: 'S2a', benchmark: 'beam-100k', split: 'sealed', questions: 140, conversations: 14, corpus_tokens: 2_000_000, messages: 1_400, block: 'T2-S2a', selection: { kind: 'per-conversation', per_conversation: 10, seed: 'q1-beam-100k' }, exclusions: [], role: 'public', exposure: 'E2', label: 'BEAM-100K sealed' },
  S2b: { id: 'S2b', benchmark: 'beam-1m', split: 'sealed', questions: 240, conversations: 24, corpus_tokens: 24_000_000, messages: 16_000, block: 'T2-S2b', selection: { kind: 'per-conversation', per_conversation: 10, seed: 'q1-beam-1m' }, exclusions: [], role: 'public', exposure: 'E2', label: 'BEAM-1M sealed' },
  S3: { id: 'S3', benchmark: 'locomo', split: 'all', questions: 200, conversations: 10, corpus_tokens: 260_000, messages: 5_900, block: 'T2-S3', selection: { kind: 'stratified', limit: 200, stratify: 'category', seed: 'q1-locomo', min: { adversarial: 40 } }, exclusions: [], role: 'public', exposure: 'E2', label: 'LoCoMo' },
  S4: { id: 'S4', benchmark: 'lme-s', split: 'dev', questions: 500, conversations: 500, corpus_tokens: 57_500_000, messages: 250_000, block: 'T2-S4-S5', selection: { kind: 'all' }, exclusions: [], role: 'public', exposure: 'E3', label: 'LongMemEval-S' },
  'S4-slice': { id: 'S4-slice', benchmark: 'lme-s', split: 'dev', questions: 100, conversations: 100, corpus_tokens: 11_500_000, messages: 50_000, block: 'T2-S4-S5', selection: { kind: 'shootout-slice', limit: 100, seed: 42 }, exclusions: [], role: 'public', exposure: 'E3', label: 'LongMemEval-S, shootout slice' },
  S5: { id: 'S5', benchmark: 'lme-m', split: 'dev', questions: 100, conversations: 100, corpus_tokens: 150_000_000, messages: 500_000, block: 'T2-S4-S5', selection: { kind: 'all' }, exclusions: [], role: 'public', exposure: 'E3', label: 'LongMemEval-M' },
  'S3-smoke': { id: 'S3-smoke', benchmark: 'locomo', split: 'dev', questions: 20, conversations: 1, corpus_tokens: 20_474, messages: 675, block: 'T2-S3', selection: { kind: 'stratified', limit: 20, stratify: 'category', seed: 'q1-smoke' }, exclusions: [], role: 'smoke', exposure: 'E2', label: 'LoCoMo dev smoke (conv-44, 20 questions)', only_conversations: ['conv-44'] },
  'S3-smoke-default': { id: 'S3-smoke-default', benchmark: 'locomo', split: 'dev', questions: 20, conversations: 1, corpus_tokens: 20_474, messages: 675, block: 'T2-S3', selection: { kind: 'stratified', limit: 20, stratify: 'category', seed: 'q1-smoke' }, exclusions: [], role: 'smoke', exposure: 'E2', label: 'LoCoMo dev smoke, own default amount (conv-44, 20 questions, claude-sonnet-5-5)', only_conversations: ['conv-44'] },
  'S2b-ingest': { id: 'S2b-ingest', benchmark: 'beam-1m', split: 'dev', questions: 10, conversations: 1, corpus_tokens: 926_773, messages: 2_182, block: 'T2-S2b', selection: { kind: 'stratified', limit: 10, stratify: 'category', seed: 'q1-ingest-probe' }, exclusions: [], role: 'smoke', exposure: 'E2', label: 'BEAM-1M dev ingest probe (1m-16, retrieval only)', only_conversations: ['1m-16'] },
};

/** PLAN §7 block lines (the approved estimate the re-priced manifest is compared with). */
export const PLAN_BLOCKS: Record<BlockId, { label: string; plan_usd: number }> = {
  T1: { label: 'T1 S1 headline (complete)', plan_usd: 3995 },
  'T2-S2a': { label: 'T2 S2a BEAM-100K', plan_usd: 585 },
  'T2-S2b': { label: 'T2 S2b BEAM-1M', plan_usd: 1720 },
  'T2-S3': { label: 'T2 S3 LoCoMo', plan_usd: 730 },
  'T2-S4-S5': { label: 'T2 S4, S5', plan_usd: 420 },
};
export const PLAN_SHARED_USD = 260;
export const CAP_USD = 8500;

// ─── Token and price assumptions (PLAN §7, stated) ───────────────────

export const ASSUMPTIONS = {
  reader_input_overhead_tokens: 1_000,
  reader_output_tokens: { default: 400, 'openai:gpt-6.1-sol': 1_000 } as Record<string, number>,
  /** Delivered evidence at a system's own default amount: gbrain's auto delivery reaches 24,000 tokens; every other system is assumed at 8,000. */
  vendor_default_tokens: { 'gbrain-defaults': 24_000, default: 8_000 } as Record<string, number>,
  /** Ingest dollars per million ingested tokens, from the shootout's pilots and the proof wave's ledger (PLAN §7); a recipe without a measured rate uses its common rate. */
  ingest_usd_per_mtok: {
    'ext-extract-first:common': 1.9, 'ext-extract-first:recipe': 1.9, 'ext-memory-bank:recipe': 1.4, 'ext-memory-bank:common': 1.4,
    'ext-graph-pipeline:recipe': 1.4, 'ext-graph-pipeline:common': 1.4, 'ext-temporal-graph:common': 12, 'ext-temporal-graph:recipe': 12,
    'ext-markdown-kb:recipe': 0.1, 'ext-markdown-kb:common': 0.1, 'ext-verbatim-session:recipe': 0.1, 'ext-verbatim-session:common': 0.1,
    'gbrain-defaults:shipped-defaults': 0.12, 'gbrain-defaults:full-surface': 0.12, 'gbrain-defaults:common-embedder': 0.13, 'baseline-hybrid:baseline': 0.13,
  } as Record<string, number>,
  /** gbrain's default query expansion: one counted call per retrieval (claude-haiku-4-5, 300 tokens in, 100 out). */
  gbrain_expansion: { model: 'anthropic:claude-haiku-4-5', input: 300, output: 100 },
  /** Canonical judge tokens per call; BEAM judges every rubric item (3 assumed). */
  judge: { lme: { model: 'openai:gpt-4o-2024-08-06', calls: 1, input: 700, output: 10 }, beam: { model: 'openai:gpt-4.1-mini', calls: 3, input: 900, output: 60 } },
  frontier_judge_output_tokens: 60,
  /** Agent loops (file agent, `think`, agent runtime): input tokens per question per reader, back-solved from the PLAN §7 block lines so the manifest reproduces the approved budget until the dev stress pilot re-prices them. */
  agent: {
    'baseline-file-agent': { S1: 130_000, S2a: 30_000, S2b: 73_000, S3: 18_000, output: 2_000 },
    think: { S1: 36_000, S2a: 21_000, S2b: 30_000, S3: 20_000, output: 1_000 },
    'ext-agent-runtime': { S3: 7_000, output: 2_000 },
  } as Record<string, Record<string, number>>,
  /** gbrain `synthesize` answers with its configured default model (claude-opus-4-7 at gbrain's pinned price) over its default delivery. */
  synthesize: { model: 'anthropic:claude-opus-4-7', input: 25_000, output: 1_000, price: { input: 5, output: 25 } },
  /** Ingest wall time per million tokens (hours) by `system:configuration` where the dev smokes measured it, else by runner, for the schedule and the /finish wait; a shim cell on S1 runs one conversation per VM. */
  hours_per_mtok: { shim: 4, 'in-process': 0.05, 'ext-extract-first:recipe': 90 } as Record<string, number>,
  vcpu: { shim: 8, 'in-process': 8 },
};

// ─── Prices ──────────────────────────────────────────────────────────

/** List price per million tokens from eval/runner/budget-ledger.ts; a dated snapshot bills at its family's price. */
export function priceOf(model: string): { input: number; output: number; cache_read?: number; cache_write?: number } {
  const p = CHAT_PRICE_OVERRIDES[model] ?? CHAT_PRICE_OVERRIDES[model.replace(/-\d{4}-?\d{2}-?\d{2}$/, '')];
  if (!p) throw new Error(`no price for ${model} in CHAT_PRICE_OVERRIDES (eval/runner/budget-ledger.ts); register its per-million-token rates there before planning`);
  return p;
}

const call = (model: string, input: number, output: number) => { const p = priceOf(model); return (input * p.input + output * p.output) / 1e6; };
const outTokens = (reader: string) => ASSUMPTIONS.reader_output_tokens[reader] ?? ASSUMPTIONS.reader_output_tokens.default;

// ─── Estimates ───────────────────────────────────────────────────────

function armQuestions(def: Pick<CellDefinition, 'set'>, arm: ArmDefinition): number {
  return SETS[arm.set].questions || SETS[def.set].questions;
}

function judgeCost(benchmark: string, judge?: string): number {
  const j = benchmark.startsWith('beam') ? ASSUMPTIONS.judge.beam : ASSUMPTIONS.judge.lme;
  return j.calls * call(judge ?? j.model, j.input, judge ? ASSUMPTIONS.frontier_judge_output_tokens : j.output);
}

/** Full context per conversation per reader: the history written to the cache once, read from it by later questions; nothing when it cannot fit. */
function fullContextCost(set: SetFacts, reader: string, questions: number): number {
  const history = set.corpus_tokens / set.conversations;
  const w = READER_WINDOWS[reader];
  if (history + ASSUMPTIONS.reader_input_overhead_tokens + 1024 > w.max_input_tokens) return 0;
  const p = priceOf(reader);
  const perConv = questions / set.conversations;
  const conv = (history * (p.cache_write ?? p.input) + Math.max(0, perConv - 1) * history * (p.cache_read ?? p.input)) / 1e6 + perConv * call(reader, ASSUMPTIONS.reader_input_overhead_tokens, outTokens(reader));
  return conv * set.conversations;
}

export function estimateCell(def: Omit<CellDefinition, 'estimate'>): CellEstimate {
  const set = SETS[def.set];
  const lines: Record<string, number> = {};
  const add = (k: string, v: number) => { if (v) lines[k] = (lines[k] ?? 0) + v; };
  const rate = ASSUMPTIONS.ingest_usd_per_mtok[`${def.system}:${def.configuration}`] ?? 0;
  add('ingest', rate * set.corpus_tokens / 1e6);
  const policies = new Set(def.arms.map(a => a.policy).filter(Boolean));
  if (def.system === 'gbrain-defaults') add('system_queries', policies.size * set.questions * call(ASSUMPTIONS.gbrain_expansion.model, ASSUMPTIONS.gbrain_expansion.input, ASSUMPTIONS.gbrain_expansion.output));
  for (const arm of def.arms) {
    const n = armQuestions(def, arm);
    const answers = (reader: string) => n * (arm.reader_replicates[reader] ?? 1);
    for (const r of arm.readers) {
      if (arm.mode === 'packed') add('readers', answers(r) * call(r, arm.budget! + ASSUMPTIONS.reader_input_overhead_tokens, outTokens(r)));
      else if (arm.mode === 'native-default') add('readers', answers(r) * call(r, (ASSUMPTIONS.vendor_default_tokens[def.system] ?? ASSUMPTIONS.vendor_default_tokens.default) + ASSUMPTIONS.reader_input_overhead_tokens, outTokens(r)));
      else if (arm.mode === 'full-context') add('full_context', fullContextCost(set, r, n));
      else if (arm.mode === 'agent') { const a = ASSUMPTIONS.agent[def.system]; add('agent', n * call(r, a[def.set] ?? 0, a.output)); }
      else if (arm.mode === 'own-answer' && arm.variant === 'think') { const a = ASSUMPTIONS.agent.think; add('own_answer', n * call(r, a[def.set] ?? 0, a.output)); }
    }
    if (arm.mode === 'own-answer' && arm.variant === 'synthesize') { const s = ASSUMPTIONS.synthesize; add('own_answer', n * (s.input * s.price.input + s.output * s.price.output) / 1e6); }
    if (arm.mode === 'retrieval-only') continue;
    const judged = arm.readers.reduce((s, r) => s + answers(r), 0);
    add('judges', judged * judgeCost(def.benchmark));
    if (arm.frontier) {
      const fr = arm.frontier.readers ?? arm.readers;
      const items = arm.frontier.sample !== null ? Math.min(n, arm.frontier.sample) * fr.length : n * fr.length;
      for (const j of arm.frontier.judges) add('frontier_judges', items * judgeCost(def.benchmark, j));
    }
    if (arm.judge_repeats) add('judge_repeats', arm.judge_repeats.count * n * (arm.judge_repeats.readers ?? arm.readers).length * judgeCost(def.benchmark));
  }
  const rounded = Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { usd: Math.round(Object.values(lines).reduce((s, v) => s + v, 0) * 100) / 100, lines: rounded };
}

// ─── Generation (PLAN §7 cells) ──────────────────────────────────────

const READERS = [...FRONTIER_READERS];
const SONNET = 'anthropic:claude-sonnet-5-5';
const FRONTIER_JUDGES = ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'];
const EXT_BEAM = ['ext-extract-first', 'ext-memory-bank', 'ext-graph-pipeline', 'ext-temporal-graph', 'ext-markdown-kb', 'ext-verbatim-session'];
const EXT_LME = ['ext-markdown-kb', 'ext-verbatim-session'];
const PASSIVE_BASELINES = ['baseline-recency', 'baseline-hybrid', 'baseline-none'];
/** Headline configuration per system and benchmark family (preregistration "External configurations"). */
const headlineConfig = (system: string, family: 'beam' | 'locomo' | 'lme') =>
  system === 'gbrain-defaults' ? 'shipped-defaults' : system.startsWith('baseline-') ? 'baseline'
  : (system === 'ext-extract-first' || system === 'ext-temporal-graph') && family === 'beam' ? 'common' : 'recipe';
const SHIMS = new Set(['gbrain-defaults', ...EXT_BEAM]);

const short = (system: string) => system.replace(/^ext-|^baseline-/, '');
const familyOf = (b: string): 'beam' | 'locomo' | 'lme' => b.startsWith('beam') ? 'beam' : b === 'locomo' ? 'locomo' : 'lme';

interface ArmSpec extends Partial<ArmDefinition> { id: string; mode: ArmMode }

function makeCell(set: SetId, system: string, configuration: string, armSpecs: ArmSpec[], extra: { ingest_replicate?: number } = {}): CellDefinition {
  const s = SETS[set];
  const id = `${set.toLowerCase()}.${system}.${configuration}${extra.ingest_replicate && extra.ingest_replicate > 1 ? `.r${extra.ingest_replicate}` : ''}`;
  const runner = SHIMS.has(system) ? 'shim' as const : 'in-process' as const;
  const arms: ArmDefinition[] = armSpecs.map(a => {
    const component = a.mode === 'packed';
    return {
      id: a.id, cell_id: `${id}.${a.id}`, set: a.set ?? set,
      arm: a.arm ?? (component ? 'component' : a.mode === 'retrieval-only' ? 'diagnostic' : 'whole-system'), mode: a.mode,
      policy: a.policy !== undefined ? a.policy : component || a.mode === 'retrieval-only' ? 'fixed-evidence' : a.mode === 'native-default' ? 'vendor-default' : null,
      budget: a.budget ?? null, ...(a.variant ? { variant: a.variant } : {}),
      questions: a.questions ?? null, readers: a.readers ?? (a.mode === 'retrieval-only' ? [] : READERS), reader_replicates: a.reader_replicates ?? {},
      frontier: a.frontier ?? null, judge_repeats: a.judge_repeats ?? null, label: a.label ?? a.id, ...(a.anchor ? { anchor: true } : {}),
    };
  });
  const shards = runner === 'shim' && set === 'S1' ? s.conversations : 1;
  const launch = runner === 'shim' ? shimLaunch(system, configuration) : null;
  const hours = Math.max(1, Math.ceil((ASSUMPTIONS.hours_per_mtok[`${system}:${configuration}`] ?? ASSUMPTIONS.hours_per_mtok[runner]) * s.corpus_tokens / 1e6 / shards));
  const base = { schema: CELL_SCHEMA as typeof CELL_SCHEMA, id, set, block: s.block, benchmark: s.benchmark, split: s.split, selection: s.selection, exclusions: s.exclusions, system, configuration, runner,
    ingest_replicate: extra.ingest_replicate ?? 1, effort: 'medium' as const, canonical_instrument: s.benchmark, probes: { sample: 20, seed: `q1-probes-${set.toLowerCase()}` },
    ...(s.only_conversations ? { only_conversations: s.only_conversations } : {}), shards, expected_hours: Math.min(48, hours), ...(launch ? shimCommands(system, launch) : {}), arms };
  return { ...base, estimate: estimateCell(base) };
}

/** How a shim cell's stack starts: bootstrap.sh --config and any environment the configuration needs. */
export function shimLaunch(system: string, configuration: string): NonNullable<CellDefinition['launch']> {
  return { env: configuration === 'full-surface' ? { GBRAIN_FULL_SURFACE: '1' } : {}, config: configuration === 'common' || configuration === 'common-embedder' ? 'common' : 'recipe' };
}

/** `KEY=value ` for a launch environment, in key order. */
export const launchPrefix = (launch: NonNullable<CellDefinition['launch']>) => Object.entries(launch.env).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v} `).join('');

/** A shim cell's launch record and its snapshot and restore commands (eval/systems/bootstrap.sh snapshot | restore). */
function shimCommands(system: string, launch: NonNullable<CellDefinition['launch']>) {
  const pre = launchPrefix(launch);
  return {
    launch,
    snapshot_command: `${pre}bash eval/systems/bootstrap.sh snapshot --system ${system} --out "$SHOOTOUT_SNAPSHOT_DIR/${system}.tar"`,
    restore_command: `${pre}bash eval/systems/bootstrap.sh restore --system ${system} --config ${launch.config} --from "$SHOOTOUT_RESTORE_DIR/${system}.tar"`,
  };
}

const b8 = (extra: Partial<ArmSpec> = {}): ArmSpec => ({ id: 'component-b8000', mode: 'packed', budget: 8000, label: 'component, 8,000 tokens', ...extra });

/** Every Q1 cell, in campaign order. */
export function generateCells(): CellDefinition[] {
  const cells: CellDefinition[] = [];
  const sonnetRows = { judges: FRONTIER_JUDGES, readers: [SONNET], sample: null };
  const everyRow = { judges: FRONTIER_JUDGES, readers: null, sample: null };
  const repeatsSonnet = { count: 10, readers: [SONNET] };
  const repeatsAll = { count: 10, readers: null };
  const sweep = (readers: string[], set: SetId, questions: Selection | null, frontier: ArmDefinition['frontier']): ArmSpec[] => [2000, 16000].map(b => ({ id: `component-b${b}`, mode: 'packed' as const, budget: b, set, questions, readers, frontier, label: `component, ${b.toLocaleString('en-US')} tokens (sweep)` }));

  const think: ArmSpec = { id: 'whole-think', mode: 'own-answer', variant: 'think', label: 'gbrain think (full surface, each reader)', frontier: everyRow, judge_repeats: repeatsAll };
  const synthesize: ArmSpec = { id: 'whole-synthesize', mode: 'own-answer', variant: 'synthesize', readers: ['system-default'], label: 'gbrain synthesize (own answer, starter surface)' };
  /** `think` is a full-surface op, so it runs in its own cell on a stack started with GBRAIN_FULL_SURFACE=1; every starter-surface row keeps a starter-only stack. */
  const fullSurface = (set: SetId) => makeCell(set, 'gbrain-defaults', 'full-surface', [think]);

  // S1, BEAM-10M: the headline.
  const s1Sweep = SETS['S1-sweep'].selection;
  for (const system of ['gbrain-defaults', ...EXT_BEAM, ...PASSIVE_BASELINES]) {
    const arms: ArmSpec[] = [
      b8({ reader_replicates: { [SONNET]: 3 }, frontier: sonnetRows, judge_repeats: repeatsSonnet, ...(system === 'gbrain-defaults' ? { anchor: true } : {}) }),
      ...sweep(READERS, 'S1-sweep', s1Sweep, sonnetRows),
    ];
    if (system !== 'baseline-recency' && system !== 'baseline-none') arms.push({ id: 'whole-default', mode: 'native-default', label: 'whole system, own default amount', frontier: sonnetRows, ...(system === 'gbrain-defaults' ? { anchor: true } : {}) });
    if (system === 'gbrain-defaults') arms.push(synthesize);
    cells.push(makeCell('S1', system, headlineConfig(system, 'beam'), arms));
    if (system === 'gbrain-defaults') cells.push(fullSurface('S1'));
  }
  cells.push(makeCell('S1', 'baseline-full-context', 'baseline', [{ id: 'whole-full-context', mode: 'full-context', label: 'whole history, where it fits', frontier: sonnetRows }]));
  cells.push(makeCell('S1', 'baseline-file-agent', 'baseline', [{ id: 'whole-agent', mode: 'agent', label: 'file agent, uncapped grep, 40 turns', frontier: everyRow, judge_repeats: repeatsAll }]));

  // T2 sets: per-set frontier sample of about 300 items across the set's judged arms.
  const t2 = (set: SetId, family: 'beam' | 'locomo') => {
    const out: CellDefinition[] = [];
    for (const system of ['gbrain-defaults', ...EXT_BEAM, ...PASSIVE_BASELINES]) {
      const arms: ArmSpec[] = [b8({ judge_repeats: repeatsSonnet, ...(system === 'gbrain-defaults' ? { anchor: true } : {}) })];
      if (set === 'S2b') arms.push(...sweep([SONNET], set, null, null));
      if (system === 'gbrain-defaults' && set !== 'S3') arms.push(synthesize);
      out.push(makeCell(set, system, headlineConfig(system, family), arms));
      if (system === 'gbrain-defaults') out.push(fullSurface(set));
    }
    if (set === 'S2b') out.push(makeCell(set, 'gbrain-defaults', 'common-embedder', [b8({ label: 'component diagnostic, text-embedding-3-large at 1,536 dimensions' })]));
    if (set === 'S2a' || set === 'S3') for (const system of EXT_BEAM.filter(s => headlineConfig(s, family) !== 'common')) out.push(makeCell(set, system, 'common', [b8({ label: 'component, 8,000 tokens, common configuration (diagnostic)' })]));
    out.push(makeCell(set, 'baseline-full-context', 'baseline', [{ id: 'whole-full-context', mode: 'full-context', label: 'whole history, where it fits' }]));
    out.push(makeCell(set, 'baseline-file-agent', 'baseline', [{ id: 'whole-agent', mode: 'agent', label: 'file agent, uncapped grep, 40 turns', frontier: everyRow, judge_repeats: repeatsAll }]));
    if (set === 'S3') {
      out.push(makeCell(set, 'ext-agent-runtime', 'recipe', [{ id: 'whole-agent', mode: 'agent', label: 'agent runtime, sessions as files' }]));
      for (const system of ['gbrain-defaults', ...EXT_BEAM, 'baseline-hybrid']) out.push(makeCell(set, system, headlineConfig(system, family), [{ id: 'retrieval-only', mode: 'retrieval-only', label: 'second ingest (disclosed replicate), retrieval only' }], { ingest_replicate: 2 }));
    }
    return withFrontierSample(out, set);
  };
  cells.push(...t2('S2b', 'beam'), ...t2('S2a', 'beam'), ...t2('S3', 'locomo'));

  // S4 and S5: LongMemEval regression and scale rows.
  const slice = SETS['S4-slice'].selection;
  cells.push(...withFrontierSample([
    makeCell('S4', 'gbrain-defaults', 'shipped-defaults', [
      b8({ readers: [SONNET], anchor: true, label: 'component, 8,000 tokens, 500-question regression (claude-sonnet-5-5 only)' }),
      b8({ id: 'component-b8000-slice', set: 'S4-slice', questions: slice, anchor: true, label: 'component, 8,000 tokens, shootout slice' }),
    ]),
    ...[...EXT_LME, ...PASSIVE_BASELINES].map(system => makeCell('S4-slice', system, headlineConfig(system, 'lme'), [b8()])),
  ], 'S4-slice'));
  cells.push(...withFrontierSample(['gbrain-defaults', ...EXT_LME, ...PASSIVE_BASELINES].map(system => makeCell('S5', system, headlineConfig(system, 'lme'), [b8({ ...(system === 'gbrain-defaults' ? { anchor: true } : {}) })])), 'S5'));
  return cells;
}

/**
 * The preregistered paid dev smokes (re-pricing, token calibration and the shrink rule's dev strengths): every system's
 * 8k component arm with the three readers and the canonical judge on one LoCoMo dev conversation, gbrain synthesize, the
 * file agent and full context on the same questions, and a retrieval-only ingest of one BEAM-1M dev conversation for
 * each LLM-extracting system (the ingest-cost projection behind the 48-hour and 1.5x rules).
 */
export function generateSmokeCells(): CellDefinition[] {
  const synthesize: ArmSpec = { id: 'whole-synthesize', mode: 'own-answer', variant: 'synthesize', readers: ['system-default'], label: 'gbrain synthesize (own answer, starter surface)' };
  const cells = ['gbrain-defaults', ...EXT_BEAM, ...PASSIVE_BASELINES].map(system =>
    makeCell('S3-smoke', system, headlineConfig(system, 'locomo'), [b8({ label: 'component, 8,000 tokens (dev smoke)' }), ...(system === 'gbrain-defaults' ? [synthesize] : [])]));
  cells.push(makeCell('S3-smoke', 'baseline-file-agent', 'baseline', [{ id: 'whole-agent', mode: 'agent', label: 'file agent, uncapped grep, 40 turns (dev smoke)' }]));
  cells.push(makeCell('S3-smoke', 'baseline-full-context', 'baseline', [{ id: 'whole-full-context', mode: 'full-context', label: 'whole history (dev smoke)' }]));
  // Each system's own default amount (the S1 whole-default arm's evidence size), read by claude-sonnet-5-5 only: the
  // vendor-default token assumption. The temporal graph is left out: its LoCoMo recipe ingest costs many times the
  // plan, and its S1 row runs the common configuration.
  for (const system of ['gbrain-defaults', ...EXT_BEAM.filter(s => s !== 'ext-temporal-graph'), 'baseline-hybrid'])
    cells.push(makeCell('S3-smoke-default', system, headlineConfig(system, 'locomo'), [{ id: 'whole-default', mode: 'native-default', readers: [SONNET], label: 'whole system, own default amount (dev smoke, claude-sonnet-5-5)' }]));
  for (const system of ['ext-extract-first', 'ext-memory-bank', 'ext-graph-pipeline', 'ext-temporal-graph']) {
    const cell = makeCell('S2b-ingest', system, headlineConfig(system, 'beam'), [{ id: 'retrieval-only', mode: 'retrieval-only', label: 'ingest-cost probe, retrieval only' }]);
    // The temporal graph's LoCoMo smoke ingested at many times the planned rate, so its BEAM-1M probe writes the first
    // tenth of the conversation (93 of 928 sessions) and the projection scales from that prefix.
    cells.push(system === 'ext-temporal-graph' ? { ...cell, ingest_sessions: 93 } : cell);
  }
  return cells;
}

/** A stratified ~300-item frontier re-judge per set: the sample spread over the set's judged arms that have no other frontier scope. */
function withFrontierSample(cells: CellDefinition[], set: SetId): CellDefinition[] {
  const open = cells.flatMap(c => c.arms.filter(a => a.set === set && !a.frontier && a.mode !== 'retrieval-only' && a.readers.length && a.readers[0] !== 'system-default'));
  const items = open.reduce((s, a) => s + a.readers.length, 0);
  const sample = items ? Math.max(1, Math.ceil(300 / items)) : 0;
  return cells.map(c => {
    const arms = c.arms.map(a => open.includes(a) ? { ...a, frontier: { judges: FRONTIER_JUDGES, readers: null, sample } } : a);
    const base = { ...c, arms };
    return { ...base, estimate: estimateCell(base) };
  });
}

export function buildManifest(): Manifest {
  const cells = generateCells();
  const blocks = (Object.keys(PLAN_BLOCKS) as BlockId[]).map(id => {
    const estimate = Math.round(cells.filter(c => c.block === id).reduce((s, c) => s + c.estimate.usd, 0) * 100) / 100;
    return { id, label: PLAN_BLOCKS[id].label, plan_usd: PLAN_BLOCKS[id].plan_usd, estimate_usd: estimate, cap_usd: Math.round(estimate * 150) / 100 };
  });
  const models = [...READERS, ...FRONTIER_JUDGES, ASSUMPTIONS.judge.lme.model, ASSUMPTIONS.judge.beam.model, ASSUMPTIONS.gbrain_expansion.model].map(m => [m, priceOf(m)] as const);
  return {
    schema: MANIFEST_SCHEMA, generated_by: 'bun eval/runner/q1/cells/definitions.ts', preregistration: PREREGISTRATION, readers: READERS, effort: 'medium',
    prices: Object.fromEntries(models.sort(([a], [b]) => (a < b ? -1 : 1))), assumptions: ASSUMPTIONS,
    sets: Object.values(SETS), blocks, cells, smoke_cells: generateSmokeCells(),
    total_usd: Math.round(blocks.reduce((s, b) => s + b.estimate_usd, 0) * 100) / 100,
    plan_total_usd: Object.values(PLAN_BLOCKS).reduce((s, b) => s + b.plan_usd, 0) + PLAN_SHARED_USD, cap_usd: CAP_USD,
  };
}

export const manifestText = (m: Manifest = buildManifest()) => JSON.stringify(m, null, 2) + '\n';

export function loadManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export const manifestSha256 = (path = MANIFEST_PATH) => createHash('sha256').update(readFileSync(path)).digest('hex');

// ─── Validation (mirrors schema.json) ───────────────────────────────

const ID = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const MODES: readonly ArmMode[] = ['packed', 'native-default', 'own-answer', 'agent', 'full-context', 'retrieval-only'];

function selectionProblems(s: Selection, where: string): string[] {
  if (!s || typeof s !== 'object') return [`${where} must be an object`];
  if (s.kind === 'all') return [];
  if (s.kind === 'per-conversation') return Number.isInteger(s.per_conversation) && s.per_conversation > 0 && typeof s.seed === 'string' && s.seed ? [] : [`${where}: per-conversation needs a positive per_conversation and a seed`];
  if (s.kind === 'stratified') return Number.isInteger(s.limit) && s.limit > 0 && ['category', 'conversation-category'].includes(s.stratify) && typeof s.seed === 'string' && s.seed ? [] : [`${where}: stratified needs a positive limit, stratify category|conversation-category and a seed`];
  if (s.kind === 'shootout-slice') return Number.isInteger(s.limit) && s.limit > 0 && Number.isInteger(s.seed) ? [] : [`${where}: shootout-slice needs an integer limit and seed`];
  return [`${where}: unknown selection kind ${JSON.stringify((s as { kind?: unknown }).kind)}`];
}

/** Problems with one definition against the schema and the kind vocabulary; empty when it is runnable. */
export function definitionProblems(d: CellDefinition, kinds: ReadonlySet<string>): string[] {
  const p: string[] = [];
  if (d.schema !== CELL_SCHEMA) p.push(`schema must be ${CELL_SCHEMA}`);
  if (!ID.test(d.id ?? '')) p.push(`id ${JSON.stringify(d.id)} must be 1-80 characters of [a-z0-9.-]`);
  if (!SETS[d.set]) p.push(`set ${d.set} is unknown`);
  if (!PLAN_BLOCKS[d.block]) p.push(`block ${d.block} is unknown`);
  if (!['dev', 'sealed', 'all'].includes(d.split)) p.push('split must be dev, sealed or all');
  p.push(...selectionProblems(d.selection, 'selection'));
  if (!kinds.has(d.system)) p.push(`system ${d.system} is not a kind id in eval/systems/kinds.json`);
  if (!['shim', 'in-process'].includes(d.runner)) p.push('runner must be shim or in-process');
  if (!(Number.isInteger(d.ingest_replicate) && d.ingest_replicate >= 1)) p.push('ingest_replicate must be a positive integer');
  if (!(Number.isInteger(d.probes?.sample) && d.probes.sample >= 0 && d.probes.seed)) p.push('probes needs a sample size and a seed');
  if (d.ingest_sessions !== undefined && !(Number.isInteger(d.ingest_sessions) && d.ingest_sessions > 0)) p.push('ingest_sessions must be a positive whole number of sessions');
  if (d.only_conversations !== undefined && !(Array.isArray(d.only_conversations) && d.only_conversations.length && d.only_conversations.every(c => typeof c === 'string' && c) && d.split === 'dev')) p.push('only_conversations must list dev conversation ids on a dev-split cell');
  if (!Array.isArray(d.arms) || !d.arms.length) p.push('arms must list at least one arm');
  const ids = new Set<string>();
  for (const a of d.arms ?? []) {
    const w = `arm ${a.id}`;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.id ?? '') || ids.has(a.id)) p.push(`${w}: id must be unique, 1-40 characters of [a-z0-9-]`);
    ids.add(a.id);
    if (a.cell_id !== `${d.id}.${a.id}`) p.push(`${w}: cell_id must be ${d.id}.${a.id}`);
    if (!SETS[a.set]) p.push(`${w}: set ${a.set} is unknown`);
    if (!MODES.includes(a.mode)) p.push(`${w}: mode must be one of ${MODES.join(', ')}`);
    if (a.mode === 'packed' && !(Number.isInteger(a.budget) && (a.budget as number) > 0)) p.push(`${w}: a packed arm needs a positive token budget`);
    if (a.mode !== 'packed' && a.budget !== null) p.push(`${w}: only packed arms carry a budget`);
    if ((a.mode === 'packed' || a.mode === 'retrieval-only') && a.policy !== 'fixed-evidence') p.push(`${w}: ${a.mode} arms retrieve under fixed-evidence`);
    if (a.mode === 'native-default' && a.policy !== 'vendor-default') p.push(`${w}: native-default arms retrieve under vendor-default`);
    if (a.mode === 'own-answer' && !a.variant) p.push(`${w}: own-answer arms name their variant (synthesize or think)`);
    if (a.mode !== 'retrieval-only' && !a.readers?.length) p.push(`${w}: a judged arm needs at least one reader`);
    if (a.questions) p.push(...selectionProblems(a.questions, `${w} questions`));
    for (const [r, n] of Object.entries(a.reader_replicates ?? {})) if (!a.readers.includes(r) || !(Number.isInteger(n) && n >= 1)) p.push(`${w}: reader_replicates.${r} must name one of its readers with a positive count`);
  }
  return p;
}

if (import.meta.main) {
  writeFileSync(MANIFEST_PATH, manifestText());
  console.log(`${join('eval/runner/q1/cells', 'q1-cells.json')} written (${buildManifest().cells.length} cells)`);
}
