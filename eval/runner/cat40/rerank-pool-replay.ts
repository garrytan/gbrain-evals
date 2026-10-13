/**
 * Cat 40 rerank-pool replay (GBRA-81 low-hanging-fruit plan, item 1, paid gate 2).
 *
 * Question: does gbrain's `search` lose anything when the reranker sees the top
 * 25 fused candidates (`balanced`) instead of the top 50 (`tokenmax`)? The
 * agents of the 2026-10-10 Cat 40 Hard confirmation made 1,030 hybrid `search`
 * calls on world M (`match` unset). This replays every one of them, with its
 * recorded arguments, on a freshly built world M brain, twice:
 *
 *   arm 50  search.reranker.top_n_in = 50
 *   arm 25  search.reranker.top_n_in = 25
 *
 * Both arms pin the same `search.mode` (default `tokenmax`, the mode the
 * recorded calls ran under: init's picker chose it for every Cat 40 slot), so
 * the rerank pool is the only setting that differs. Running the two modes
 * instead would also change nothing else that `search` reads today, but the
 * per-key override isolates the pool by construction, and the runner checks
 * it: `gbrain search modes --json` is read from each arm's brain and any
 * difference other than `reranker_top_n_in` stops the run. The per-arm pool of
 * candidates each retrieval arm fetches does not depend on top_n_in (it is
 * max(2 x limit, 50), hybrid/request.ts), so both arms rerank a prefix of one
 * fused order, provided they see the same query embedding. The provider proxy
 * caches embeddings to make that true and verifies the prefix per call from
 * the hashes of the documents gbrain sent the reranker.
 *
 * Calls go through the agent's real path: `gbrain serve --surface starter`
 * over stdio on a restored slot snapshot, remote caller, as in Cat 40. Per
 * call and arm it records the top 20 rows, which fused-pool rows 26 to 50
 * entered the top 20, gold hit@5 (any of the task's `gold.evidence` documents
 * among the first 5 rows; H5 tasks name none), the rerank status and tokens.
 *
 * Validity (plan, Measurement): any rerank failure, skip, pass-through or a
 * missing rerank request marks the call and invalidates its arm; a call that
 * fails in only one arm is a missing pair and invalidates the comparison; a
 * call whose operation fails identically in both arms is excluded and
 * counted. The gate: gold hit@5 under 25 minus under 50, paired over calls,
 * one-sided 95% lower bound by paired bootstrap (10,000 resamples, seed 1);
 * pass when the lower bound is strictly above -0.01 (1 point), fail when the point
 * estimate is below it, inconclusive otherwise.
 *
 * Paid run (forward upstream; build the slot first, see the runbook section in
 * docs/benchmarks/cat40-hard/RUNBOOK.md):
 *   bun eval/runner/cat40/rerank-pool-replay.ts --gbrain-repo ../gbrain --gbrain-ref <sha> \
 *     --budget-usd 2 --budget-ledger .budget/<ledger>.sqlite --out eval/reports/cat40/rerank-pool-replay
 * Keyless dry run (stub providers, a world M subset brain, nothing leaves the machine):
 *   bun eval/runner/cat40/rerank-pool-replay.ts --upstream stub --fixture-docs 1500 --calls 40 \
 *     --gbrain-repo ../gbrain --gbrain-ref <sha> --budget-usd 1 --budget-ledger <tmp ledger> --out <dir>
 * Cost estimate only (no slot, no ledger): add --estimate-only.
 *
 * Writes <out>/calls.ndjson (one line per call), <out>/summary.json, <out>/summary.md and a receipt.
 */
import { budgetOptionsFrom, priceRequest, receiptCost, startPaidRun } from '../budget-ledger.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { worldDigest, type LadderWorld } from '../../generators/model-ladder-gen.ts';
import { prepareBuild } from '../lifecycle/builds.ts';
import { runCli } from '../lifecycle/drivers.ts';
import { missingSlotSnapshots, slotRoot } from '../cat40-model-ladder.ts';
import { GbrainSlot, MeteringProxy } from './gbrain-arm.ts';
import { UPSTREAM, type ProviderName } from '../metering-proxy.ts';
import { RerankPoolProxy, stubProviderResponse, type Capture, type RerankCapture, type StubRerank } from './rerank-pool-proxy.ts';

export const SCHEMA = 'cat40-rerank-pool-replay-v1';
export const RUNNER = 'cat40-rerank-pool-replay';
/** Arm 50 runs first: its rerank answers are what a verified 25-document prefix can reuse. */
export const ARMS = [50, 25] as const;
export type Arm = typeof ARMS[number];
export const TOP_K = 20;
export const HIT_K = 5;
export const MARGIN = -0.01;
export const RECEIPTS = 'docs/benchmarks/2026-10-10-model-ladder-hard-confirmation';
export const DEFAULT_TRANSCRIPTS = `${RECEIPTS}/main-cells/transcripts.jsonl.gz`;
export const DEFAULT_WORLD = 'eval/reports/cat40/hard-confirm/main/world/world.json';
export const WORLD_MANIFEST = `${RECEIPTS}/main-world-manifest.json`;
/** World M's slot build at gbrain 3e4ff61 embedded 55,859 requests for $2.7360 (main-slots receipt). */
export const MEASURED_SLOT_BUILD_USD = 2.736;
/** Every one of the 1,030 calls made exactly one rerank request in the keyless dry run (no alias fan-out rerank). */
export const MEASURED_REQUESTS_PER_CALL = 1;

// ─── Recorded calls ─────────────────────────────────────────────────

export interface ReplayCall {
  /** `<attempt_id>#<index of the call within the cell>` */
  id: string;
  cell: string;
  model: string;
  task: string;
  family: string;
  session: number | null;
  query: string;
  args: Record<string, unknown>;
  /** The task's gold.evidence document ids (empty for H5). */
  gold: string[];
}

type ToolLine = { name: string; args: Record<string, unknown>; session?: number };
type TranscriptLine = { key: string; attempt_id?: string; tools?: ToolLine[]; sessions?: Array<{ tools: ToolLine[] }> };
type WorldTasks = { tasks: Array<{ id: string; family?: string; gold?: { evidence?: string[] } }> };

/** A hybrid `search` call: `match` unset or `hybrid` (keyword-match calls never reach the reranker). */
export const isHybridSearch = (t: { name: string; args?: Record<string, unknown> }) =>
  t.name === 'search' && (t.args?.match === undefined || t.args?.match === 'hybrid') && typeof t.args?.query === 'string';

/**
 * Every hybrid `search` call of the label's cells, in transcript order, from the last attempt of each cell
 * (a retried cell counts once), with the task's gold documents.
 */
export function extractHybridSearchCalls(lines: string[], world: WorldTasks, label = 'gbrain-hard'): ReplayCall[] {
  const tasks = new Map(world.tasks.map(t => [t.id, t]));
  const parsed = lines.filter(l => l.trim() && l.includes(`|${label}|`)).map(l => JSON.parse(l) as TranscriptLine);
  const last = new Map<string, number>();
  parsed.forEach((j, i) => last.set(j.key, i));
  const calls: ReplayCall[] = [];
  parsed.forEach((j, i) => {
    if (last.get(j.key) !== i) return;
    const [model, arm, task] = j.key.split('|');
    if (arm !== label) return;
    const tools = j.tools ?? (j.sessions ?? []).flatMap((s, si) => s.tools.map(t => ({ ...t, session: t.session ?? si + 1 })));
    tools.forEach((t, k) => {
      if (!isHybridSearch(t)) return;
      const spec = tasks.get(task);
      if (!spec) throw new Error(`transcript cell ${j.key} names task ${task}, which the world does not have; is this the right world?`);
      calls.push({ id: `${j.attempt_id ?? j.key}#${k}`, cell: j.key, model, task, family: spec.family ?? task.slice(0, 2), session: t.session ?? null,
        query: String(t.args.query), args: t.args, gold: [...new Set((spec.gold?.evidence ?? []).map(d => d.toLowerCase()))] });
    });
  });
  return calls;
}

export function readTranscriptLines(path: string): string[] {
  const buf = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8').split('\n');
}

/** `n` calls spread evenly over the list (all when n is absent or not smaller). */
export function spreadSample<T>(xs: T[], n?: number): T[] {
  if (!n || n >= xs.length) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
}

// ─── One call's result ──────────────────────────────────────────────

export interface Row { slug: string; chunk_id: number | null }
export interface ParsedResult { error: string | null; rows: Row[]; trailer: string; parse_error?: string }

/** Length of the JSON value at the start of `text` (bracket depth outside strings), or -1 when it does not close. */
export function leadingJsonLength(text: string): number {
  let depth = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if ((ch === ']' || ch === '}') && --depth === 0) return i + 1;
  }
  return -1;
}

/** Rows and trailer of a `search` tool result as the MCP server sends it: lean rows as JSON, then prose and `[gbrain ...]` lines. */
export function parseSearchResult(text: string): ParsedResult {
  if (text.startsWith('Error:')) return { error: text.slice(0, 500), rows: [], trailer: '' };
  const end = /^\s*[[{]/.test(text) ? leadingJsonLength(text) : -1;
  const head = end >= 0 ? text.slice(0, end) : text;
  const trailer = end >= 0 ? text.slice(end).replace(/^\n/, '') : '';
  let parsed: unknown;
  try { parsed = JSON.parse(head); } catch (e) { return { error: null, rows: [], trailer, parse_error: (e as Error).message.slice(0, 200) }; }
  const list = Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>)?.results ?? (parsed as Record<string, unknown>)?.rows);
  if (!Array.isArray(list)) return { error: null, rows: [], trailer, parse_error: 'result is neither a row array nor an object with results/rows' };
  const rows = list.filter(r => r && typeof r === 'object' && typeof (r as Row).slug === 'string')
    .map(r => ({ slug: String((r as Row).slug).toLowerCase(), chunk_id: typeof (r as Row).chunk_id === 'number' ? (r as Row).chunk_id : null }));
  return { error: null, rows, trailer };
}

export type RerankStatus = 'ok' | 'empty' | 'failed' | 'missing';
export interface ArmOutcome {
  arm: Arm;
  /** `op_error`: the tool answered with an error; `harness_error`: the server or transport failed. */
  status: 'ok' | 'op_error' | 'harness_error';
  error?: string;
  rows: number;
  top: Row[];
  rerank: { status: RerankStatus; reason?: string; requests: number; primary_docs: number; primary_doc_sha: string[]; tokens: number; est_tokens: number; reused: boolean };
  embedding_tokens: number;
  refused_routes: string[];
  ms: number;
}

/** The capture of the call's own rerank (its query is the recorded query); alias fan-out searches add more. */
export function primaryRerank(captures: Capture[], query: string): RerankCapture | null {
  const reranks = captures.filter((c): c is RerankCapture => c.kind === 'rerank');
  return reranks.find(c => c.query === query) ?? reranks.find(c => c.query.trim() === query.trim()) ?? reranks[0] ?? null;
}

/** Classify one arm's answer to one call from the tool result and the provider requests it made. */
export function armOutcome(arm: Arm, query: string, text: string | null, harnessError: string | null, captures: Capture[], ms: number): ArmOutcome {
  const reranks = captures.filter((c): c is RerankCapture => c.kind === 'rerank');
  const primary = primaryRerank(captures, query);
  const base = {
    arm, ms,
    embedding_tokens: captures.reduce((n, c) => n + (c.kind === 'embedding' ? c.tokens : 0), 0),
    refused_routes: captures.filter(c => c.kind === 'refused').map(c => c.kind === 'refused' ? `${c.provider}${c.path}` : ''),
  };
  const rerankBase = {
    requests: reranks.length, primary_docs: primary?.doc_sha.length ?? 0, primary_doc_sha: primary?.doc_sha ?? [],
    tokens: reranks.reduce((n, c) => n + c.tokens, 0), est_tokens: reranks.reduce((n, c) => n + c.est_tokens, 0), reused: reranks.some(c => c.reused),
  };
  if (harnessError !== null || text === null) {
    return { ...base, status: 'harness_error', error: (harnessError ?? 'no result').slice(0, 500), rows: 0, top: [], rerank: { ...rerankBase, status: 'failed', reason: 'harness_error' } };
  }
  const parsed = parseSearchResult(text);
  const failedCapture = reranks.find(c => c.status !== 200);
  const notice = parsed.trailer.match(/\b(rerank_failed|reranker_skipped|rerank_passthrough)\b[^\n]*/);
  let rerank: ArmOutcome['rerank'];
  if (failedCapture) rerank = { ...rerankBase, status: 'failed', reason: `provider HTTP ${failedCapture.status}${failedCapture.error ? `: ${failedCapture.error.slice(0, 120)}` : ''}` };
  else if (notice) rerank = { ...rerankBase, status: 'failed', reason: notice[0].slice(0, 160) };
  else if (parsed.error) rerank = { ...rerankBase, status: reranks.length ? 'ok' : 'empty' };
  else if (parsed.rows.length && !primary) rerank = { ...rerankBase, status: 'missing', reason: 'rows came back but no rerank request was made' };
  else rerank = { ...rerankBase, status: primary ? 'ok' : 'empty' };
  if (parsed.error || parsed.parse_error) {
    return { ...base, status: 'op_error', error: (parsed.error ?? `unparseable result: ${parsed.parse_error}; starts ${JSON.stringify(text.slice(0, 160))}`).slice(0, 500), rows: 0, top: [], rerank };
  }
  return { ...base, status: 'ok', rows: parsed.rows.length, top: parsed.rows.slice(0, TOP_K), rerank };
}

// ─── Metrics ────────────────────────────────────────────────────────

const rowKey = (r: Row) => r.chunk_id !== null ? `chunk:${r.chunk_id}` : `page:${r.slug}`;

/** Share of the top-k rows the two lists have in common (k = the longer list, at most `k`); null when both are empty. */
export function overlapAtK(a: Row[], b: Row[], k = TOP_K): number | null {
  const n = Math.min(k, Math.max(a.length, b.length));
  if (!n) return null;
  const left = new Set(a.slice(0, n).map(rowKey));
  return b.slice(0, n).filter(r => left.has(rowKey(r))).length / n;
}

/** 1 when any of the first k rows is a gold document, 0 when none is; null when the task names no gold document. */
export function goldHitAtK(rows: Row[], gold: string[], k = HIT_K): 0 | 1 | null {
  if (!gold.length) return null;
  const g = new Set(gold);
  return rows.slice(0, k).some(r => g.has(r.slug)) ? 1 : 0;
}

export interface ChunkRef { chunk_id: number; slug: string }

/** Fused-pool position of each chunk and page, from the hashes of the documents gbrain sent the reranker. */
export function poolPositions(docSha: string[], index: Map<string, ChunkRef[]>): { byChunk: Map<number, number>; bySlug: Map<string, number>; unmapped: number } {
  const byChunk = new Map<number, number>(), bySlug = new Map<string, number>();
  let unmapped = 0;
  docSha.forEach((h, i) => {
    const refs = index.get(h);
    if (!refs?.length) { unmapped++; return; }
    for (const r of refs) { if (!byChunk.has(r.chunk_id)) byChunk.set(r.chunk_id, i); if (!bySlug.has(r.slug)) bySlug.set(r.slug, i); }
  });
  return { byChunk, bySlug, unmapped };
}

/** Top-k rows whose fused-pool position (0-based) is in [from, to): pool rows 26 to 50 by default. */
export function enteredFromTail(rows: Row[], pos: { byChunk: Map<number, number>; bySlug: Map<string, number> }, k = TOP_K, from = 25, to = 50): Array<Row & { fused_rank: number }> {
  const out: Array<Row & { fused_rank: number }> = [];
  for (const r of rows.slice(0, k)) {
    const p = (r.chunk_id !== null ? pos.byChunk.get(r.chunk_id) : undefined) ?? pos.bySlug.get(r.slug);
    if (p !== undefined && p >= from && p < to) out.push({ ...r, fused_rank: p + 1 });
  }
  return out;
}

/** True when the first `n` documents of the larger pool are exactly the smaller pool, in order. */
export function isPrefix(small: string[], large: string[]): boolean {
  return small.length <= large.length && small.every((h, i) => large[i] === h);
}

/** mulberry32: the PRNG gbrain's eval bootstrap uses (src/eval/shared/bootstrap.ts). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedBound { n: number; estimate: number | null; lower: number | null; resamples: number; seed: number; confidence: number }

/**
 * One-sided lower confidence bound on the mean paired difference: resample the pairs with replacement, sort the
 * resample means, read the alpha quantile (index floor(alpha x resamples)). n = 0 gives nulls, n = 1 a degenerate bound.
 */
export function pairedBootstrapLowerBound(diffs: readonly number[], opts: { resamples?: number; seed?: number; alpha?: number } = {}): PairedBound {
  const resamples = opts.resamples ?? 10_000, seed = opts.seed ?? 1, alpha = opts.alpha ?? 0.05;
  const n = diffs.length;
  const base = { n, resamples, seed, confidence: 1 - alpha };
  if (!n) return { ...base, estimate: null, lower: null };
  const estimate = diffs.reduce((s, d) => s + d, 0) / n;
  if (n === 1) return { ...base, estimate, lower: estimate };
  const rand = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rand() * n)];
    means[r] = s / n;
  }
  means.sort();
  return { ...base, estimate, lower: means[Math.min(resamples - 1, Math.floor(alpha * resamples))] };
}

export type Verdict = 'pass' | 'inconclusive' | 'fail' | 'invalid';
/** The gate (the wave's Measurement rule): pass when the lower bound is strictly above the margin, fail when the estimate is below it. */
export function gateVerdict(b: Pick<PairedBound, 'estimate' | 'lower'>, margin = MARGIN, valid = true): Verdict {
  if (!valid || b.estimate === null || b.lower === null) return 'invalid';
  const eps = 1e-12;
  if (b.lower > margin + eps) return 'pass';
  if (b.estimate < margin - eps) return 'fail';
  return 'inconclusive';
}

// ─── Per-call record and summary ────────────────────────────────────

export interface CallRecord {
  schema: typeof SCHEMA;
  id: string; cell: string; model: string; task: string; family: string; session: number | null;
  query: string; args: Record<string, unknown>; gold_count: number;
  arms: Partial<Record<`${Arm}`, ArmOutcome & { top20: Row[]; gold_hit5: 0 | 1 | null; entered_26_50: Array<Row & { fused_rank: number }> }>>;
  pool: { prefix_verified: boolean | null; pool50_docs: number; pool25_docs: number; unmapped_docs: number };
  top20_overlap: number | null;
  /** Why the call is not in the paired comparison, if it is not. */
  excluded: 'op_error_both' | null;
  /** A one-sided failure: the comparison is invalid while it stands. */
  missing_pair: string | null;
}

export function callRecord(call: ReplayCall, outcomes: Partial<Record<Arm, ArmOutcome>>, index: Map<string, ChunkRef[]>): CallRecord {
  const o50 = outcomes[50], o25 = outcomes[25];
  const pos = poolPositions(o50?.rerank.primary_doc_sha ?? [], index);
  const arms: CallRecord['arms'] = {};
  for (const arm of ARMS) {
    const o = outcomes[arm];
    if (!o) continue;
    arms[`${arm}`] = { ...o, rerank: { ...o.rerank, primary_doc_sha: [] }, top20: o.top, gold_hit5: o.status === 'ok' ? goldHitAtK(o.top, call.gold) : null, entered_26_50: o.status === 'ok' ? enteredFromTail(o.top, pos) : [] };
  }
  const both = o50 && o25;
  const opBoth = both && o50.status === 'op_error' && o25.status === 'op_error' && o50.error === o25.error;
  const missing = !both ? `arm ${o50 ? 25 : 50} has no result` : !opBoth && o50.status !== o25.status ? `arm 50 ${o50.status}, arm 25 ${o25.status}` : null;
  return {
    schema: SCHEMA, id: call.id, cell: call.cell, model: call.model, task: call.task, family: call.family, session: call.session,
    query: call.query, args: call.args, gold_count: call.gold.length, arms,
    pool: {
      prefix_verified: o50?.rerank.primary_docs && o25?.rerank.primary_docs ? isPrefix(o25.rerank.primary_doc_sha, o50.rerank.primary_doc_sha) : null,
      pool50_docs: o50?.rerank.primary_docs ?? 0, pool25_docs: o25?.rerank.primary_docs ?? 0, unmapped_docs: pos.unmapped,
    },
    top20_overlap: both && o50.status === 'ok' && o25.status === 'ok' ? overlapAtK(o50.top, o25.top) : null,
    excluded: opBoth ? 'op_error_both' : null,
    missing_pair: missing,
  };
}

const quantile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : null;
const round = (x: number | null, d = 4) => x === null ? null : Number(x.toFixed(d));

export interface ArmSummary { calls: number; ok: number; op_error: number; harness_error: number; rerank_failed: number; rerank_missing: number; rerank_tokens: number; rerank_est_tokens: number; embedding_tokens: number; reused_calls: number; refused_routes: number; gold_calls: number; gold_hit5: number | null; complete: boolean; valid: boolean; invalid_reasons: string[] }

export function summarize(records: CallRecord[], opts: { planned: number; completeArms: Record<`${Arm}`, boolean> }) {
  const arms = {} as Record<`${Arm}`, ArmSummary>;
  for (const arm of ARMS) {
    const outs = records.map(r => r.arms[`${arm}`]).filter((o): o is NonNullable<typeof o> => !!o);
    const failed = outs.filter(o => o.rerank.status === 'failed'), missing = outs.filter(o => o.rerank.status === 'missing');
    const harness = outs.filter(o => o.status === 'harness_error');
    const gold = records.filter(r => r.excluded === null && r.arms[`${arm}`]?.gold_hit5 !== null && r.arms[`${arm}`] !== undefined);
    const reasons = [
      ...(failed.length ? [`${failed.length} call(s) with a failed, skipped or pass-through rerank (first: ${failed[0].rerank.reason})`] : []),
      ...(missing.length ? [`${missing.length} call(s) returned rows without a rerank request`] : []),
      ...(harness.length ? [`${harness.length} harness error(s)`] : []),
      ...(!opts.completeArms[`${arm}`] || outs.length < opts.planned ? [`incomplete: ${outs.length} of ${opts.planned} calls replayed`] : []),
    ];
    arms[`${arm}`] = {
      calls: outs.length, ok: outs.filter(o => o.status === 'ok').length, op_error: outs.filter(o => o.status === 'op_error').length, harness_error: harness.length,
      rerank_failed: failed.length, rerank_missing: missing.length,
      rerank_tokens: outs.reduce((n, o) => n + o.rerank.tokens, 0), rerank_est_tokens: outs.reduce((n, o) => n + o.rerank.est_tokens, 0),
      embedding_tokens: outs.reduce((n, o) => n + o.embedding_tokens, 0), reused_calls: outs.filter(o => o.rerank.reused).length,
      refused_routes: outs.reduce((n, o) => n + o.refused_routes.length, 0),
      gold_calls: gold.length, gold_hit5: gold.length ? round(gold.reduce((n, r) => n + (r.arms[`${arm}`]!.gold_hit5 ?? 0), 0) / gold.length) : null,
      complete: opts.completeArms[`${arm}`] && outs.length >= opts.planned, valid: reasons.length === 0, invalid_reasons: reasons,
    };
  }
  const missingPairs = records.filter(r => r.missing_pair !== null);
  const comparisonValid = arms['50'].valid && arms['25'].valid && missingPairs.length === 0;
  const paired = records.filter(r => r.excluded === null && r.missing_pair === null && r.arms['50']?.gold_hit5 !== null && r.arms['25']?.gold_hit5 !== null && r.arms['50'] && r.arms['25']);
  const diffs = paired.map(r => (r.arms['25']!.gold_hit5 as number) - (r.arms['50']!.gold_hit5 as number));
  const bound = pairedBootstrapLowerBound(diffs, { resamples: 10_000, seed: 1, alpha: 0.05 });
  const overlaps = records.map(r => r.top20_overlap).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const deep = records.filter(r => r.excluded === null && r.arms['50']?.status === 'ok' && r.pool.pool50_docs > 25);
  const entered = deep.filter(r => (r.arms['50']?.entered_26_50.length ?? 0) > 0);
  const prefixKnown = records.filter(r => r.pool.prefix_verified !== null);
  const byFamily: Record<string, { calls: number; gold_calls: number; hit5_50: number | null; hit5_25: number | null; mean_overlap: number | null; entered_rate_50: number | null }> = {};
  for (const fam of [...new Set(records.map(r => r.family))].sort()) {
    const rs = records.filter(r => r.family === fam);
    const ps = paired.filter(r => r.family === fam);
    const ov = rs.map(r => r.top20_overlap).filter((x): x is number => x !== null);
    const dp = deep.filter(r => r.family === fam);
    byFamily[fam] = {
      calls: rs.length, gold_calls: ps.length,
      hit5_50: ps.length ? round(ps.reduce((n, r) => n + (r.arms['50']!.gold_hit5 as number), 0) / ps.length) : null,
      hit5_25: ps.length ? round(ps.reduce((n, r) => n + (r.arms['25']!.gold_hit5 as number), 0) / ps.length) : null,
      mean_overlap: ov.length ? round(ov.reduce((a, b) => a + b, 0) / ov.length) : null,
      entered_rate_50: dp.length ? round(dp.filter(r => (r.arms['50']?.entered_26_50.length ?? 0) > 0).length / dp.length) : null,
    };
  }
  return {
    schema: `${SCHEMA}-summary`,
    calls: { planned: opts.planned, recorded: records.length, excluded_op_error_both: records.filter(r => r.excluded).length, missing_pairs: missingPairs.length, missing_pair_examples: missingPairs.slice(0, 5).map(r => `${r.id}: ${r.missing_pair}`) },
    arms,
    comparison_valid: comparisonValid,
    top20_overlap: {
      n: overlaps.length, mean: overlaps.length ? round(overlaps.reduce((a, b) => a + b, 0) / overlaps.length) : null,
      min: overlaps[0] ?? null, p10: quantile(overlaps, 0.1), p25: quantile(overlaps, 0.25), median: quantile(overlaps, 0.5),
      identical: overlaps.filter(x => x === 1).length,
      buckets: { '1.0': overlaps.filter(x => x === 1).length, '0.90-0.99': overlaps.filter(x => x >= 0.9 && x < 1).length, '0.75-0.89': overlaps.filter(x => x >= 0.75 && x < 0.9).length, '0.50-0.74': overlaps.filter(x => x >= 0.5 && x < 0.75).length, '<0.50': overlaps.filter(x => x < 0.5).length },
    },
    pool_rows_26_50: {
      calls_with_pool_over_25: deep.length,
      calls_where_any_entered_top20: entered.length,
      rate: deep.length ? round(entered.length / deep.length) : null,
      rows_entered: deep.reduce((n, r) => n + (r.arms['50']?.entered_26_50.length ?? 0), 0),
      mean_rows_entered_per_deep_call: deep.length ? round(deep.reduce((n, r) => n + (r.arms['50']?.entered_26_50.length ?? 0), 0) / deep.length) : null,
      arm25_rows_from_26_50_in_top20: records.reduce((n, r) => n + (r.arms['25']?.entered_26_50.length ?? 0), 0),
    },
    prefix: { checked: prefixKnown.length, verified: prefixKnown.filter(r => r.pool.prefix_verified).length, unmapped_docs: records.reduce((n, r) => n + r.pool.unmapped_docs, 0) },
    gold_hit5: {
      paired_calls: paired.length, arm50: paired.length ? round(paired.reduce((n, r) => n + (r.arms['50']!.gold_hit5 as number), 0) / paired.length) : null,
      arm25: paired.length ? round(paired.reduce((n, r) => n + (r.arms['25']!.gold_hit5 as number), 0) / paired.length) : null,
      discordant: { arm25_only: diffs.filter(d => d > 0).length, arm50_only: diffs.filter(d => d < 0).length },
      difference_25_minus_50: { estimate: round(bound.estimate, 6), lower_95_one_sided: round(bound.lower, 6), resamples: bound.resamples, seed: bound.seed, n: bound.n },
      margin: MARGIN,
      verdict: gateVerdict(bound, MARGIN, comparisonValid),
    },
    by_family: byFamily,
  };
}
export type Summary = ReturnType<typeof summarize>;

export function summaryMarkdown(s: Summary, meta: { upstream: string; fixture: boolean; gbrain_commit: string; search_mode: string }): string {
  const pct = (x: number | null) => x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
  const g = s.gold_hit5;
  const L = [
    `# Cat 40 rerank-pool replay: 25 vs 50`,
    '',
    meta.upstream === 'stub' ? '**Keyless dry run with stub providers: these numbers test the harness, not search quality.**' : '',
    meta.fixture ? '**Fixture brain (a subset of world M).**' : '',
    '',
    `gbrain ${meta.gbrain_commit.slice(0, 12)}, search.mode ${meta.search_mode}, top_n_in 50 vs 25. Calls: ${s.calls.recorded} of ${s.calls.planned} (excluded, op error in both arms: ${s.calls.excluded_op_error_both}; missing pairs: ${s.calls.missing_pairs}).`,
    '',
    `**Gate:** gold hit@5 under 25 is ${pct(g.arm25)} vs ${pct(g.arm50)} under 50 over ${g.paired_calls} paired calls; difference ${g.difference_25_minus_50.estimate === null ? 'n/a' : (g.difference_25_minus_50.estimate * 100).toFixed(2) + ' pts'}, one-sided 95% lower bound ${g.difference_25_minus_50.lower_95_one_sided === null ? 'n/a' : (g.difference_25_minus_50.lower_95_one_sided * 100).toFixed(2) + ' pts'} (margin -1 pt). Verdict: **${g.verdict}**.`,
    '',
    '| Arm | calls | ok | op error | rerank failed | rerank missing | reused | gold calls | gold hit@5 | rerank tokens | valid |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...ARMS.map(a => { const x = s.arms[`${a}`]; return `| ${a} | ${x.calls} | ${x.ok} | ${x.op_error} | ${x.rerank_failed} | ${x.rerank_missing} | ${x.reused_calls} | ${x.gold_calls} | ${pct(x.gold_hit5)} | ${x.rerank_tokens} | ${x.valid ? 'yes' : `no: ${x.invalid_reasons.join('; ')}`} |`; }),
    '',
    `**Top-20 overlap** (n ${s.top20_overlap.n}): mean ${s.top20_overlap.mean}, median ${s.top20_overlap.median}, p10 ${s.top20_overlap.p10}, min ${s.top20_overlap.min}; identical ${s.top20_overlap.identical}. Buckets: ${Object.entries(s.top20_overlap.buckets).map(([k, v]) => `${k}: ${v}`).join(', ')}.`,
    '',
    `**Pool rows 26 to 50 in the top 20 (arm 50):** ${s.pool_rows_26_50.calls_where_any_entered_top20} of ${s.pool_rows_26_50.calls_with_pool_over_25} calls whose pool exceeded 25 (${pct(s.pool_rows_26_50.rate)}), ${s.pool_rows_26_50.rows_entered} rows in all.`,
    '',
    `**Prefix check:** the 25 pool was the first 25 of the 50 pool on ${s.prefix.verified} of ${s.prefix.checked} calls; ${s.prefix.unmapped_docs} reranked documents could not be mapped to a chunk.`,
    '',
    '| Family | calls | gold calls | hit@5 50 | hit@5 25 | mean overlap | rows 26-50 entered (rate) |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(s.by_family).map(([f, x]) => `| ${f} | ${x.calls} | ${x.gold_calls} | ${pct(x.hit5_50)} | ${pct(x.hit5_25)} | ${x.mean_overlap ?? 'n/a'} | ${pct(x.entered_rate_50)} |`),
    '',
  ];
  return L.filter((l, i) => l !== '' || L[i - 1] !== '').join('\n');
}

// ─── Cost estimate ──────────────────────────────────────────────────

export interface CostEstimate {
  calls: number; requests_per_call: number; docs_per_request: { arm50: number; arm25: number }; reuse: boolean;
  tokens_per_doc: number; rerank_tokens: number; embedding_tokens: number; rerank_usd_per_mtok: number; embedding_usd_per_mtok: number;
  replay_usd: number; replay_worst_usd: number; slot_build_usd: number; slot_build_measured_usd: number; total_usd: number; basis: string;
}

/**
 * Projected replay cost from token counts. A rerank bills query tokens times documents plus document tokens;
 * documents are chunks, about one per document body here, capped by gbrain at 6,000 characters. `requests_per_call`
 * covers alias fan-out searches, which would rerank their own pools (none did in the dry run). `worst` doubles the document size and assumes no reuse.
 */
export function estimateReplayCost(calls: ReplayCall[], world: Pick<LadderWorld, 'docs'>, opts: { requestsPerCall?: number; reuse?: boolean } = {}): CostEstimate {
  const rerankPrice = priceRequest('https://api.voyageai.com/v1/rerank', { model: 'rerank-2.5', query: 'q', documents: ['d'] })!.input;
  const embedPrice = priceRequest('https://api.openai.com/v1/embeddings', { model: 'text-embedding-3-large', input: 'q' })!.input;
  const bodies = (world.docs as Array<{ title?: string; body?: string }>).map(d => Math.min(6000, (d.body ?? '').length + (d.title ?? '').length + 2));
  const tokensPerDoc = bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length / 4 : 0;
  const rpc = opts.requestsPerCall ?? MEASURED_REQUESTS_PER_CALL, reuse = opts.reuse !== false;
  const qTok = calls.length ? calls.reduce((n, c) => n + Math.ceil(c.query.length / 4), 0) / calls.length : 0;
  const docs = { arm50: 50, arm25: reuse ? 0 : 25 };
  const perRequest = (n: number, perDoc: number) => n * (qTok + perDoc);
  const rerankTokens = calls.length * rpc * (perRequest(docs.arm50, tokensPerDoc) + perRequest(docs.arm25, tokensPerDoc));
  const worstTokens = calls.length * rpc * (perRequest(50, tokensPerDoc * 2) + perRequest(25, tokensPerDoc * 2));
  const embeddingTokens = calls.length * rpc * qTok;
  const replay = rerankTokens * rerankPrice / 1e6 + embeddingTokens * embedPrice / 1e6;
  const worst = worstTokens * rerankPrice / 1e6 + 2 * embeddingTokens * embedPrice / 1e6;
  const allChars = (world.docs as Array<{ title?: string; body?: string }>).reduce((n, d) => n + (d.body ?? '').length + (d.title ?? '').length, 0);
  const slotBuild = allChars / 4 * embedPrice / 1e6;
  return {
    calls: calls.length, requests_per_call: rpc, docs_per_request: docs, reuse, tokens_per_doc: Math.round(tokensPerDoc),
    rerank_tokens: Math.round(rerankTokens), embedding_tokens: Math.round(embeddingTokens), rerank_usd_per_mtok: rerankPrice, embedding_usd_per_mtok: embedPrice,
    replay_usd: Number(replay.toFixed(4)), replay_worst_usd: Number(worst.toFixed(4)), slot_build_usd: Number(slotBuild.toFixed(4)), slot_build_measured_usd: MEASURED_SLOT_BUILD_USD,
    total_usd: Number((Math.max(slotBuild, MEASURED_SLOT_BUILD_USD) + replay).toFixed(4)),
    basis: `voyage:rerank-2.5 $${rerankPrice}/M tokens and openai:text-embedding-3-large $${embedPrice}/M (budget-ledger.ts prices); 4 characters per token; ${rpc} rerank requests per call; slot build measured on this world at gbrain 3e4ff61 (${RECEIPTS}/main-slots)`,
  };
}

// ─── Fixture world (keyless dry run) ────────────────────────────────

/** World M cut to `maxDocs` documents: every gold document of the replayed calls' tasks, then a seeded sample of the rest. */
export function fixtureWorld(world: LadderWorld, calls: ReplayCall[], maxDocs: number): LadderWorld {
  const keep = new Set(calls.flatMap(c => c.gold));
  const rest = world.docs.filter(d => !keep.has(d.id.toLowerCase()));
  const rand = mulberry32(1);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const ids = new Set([...keep, ...rest.slice(0, Math.max(0, maxDocs - keep.size)).map(d => d.id.toLowerCase())]);
  return { ...world, docs: world.docs.filter(d => ids.has(d.id.toLowerCase())) };
}

/** Fetch for a MeteringProxy that answers from the stub providers (slot builds in the keyless dry run). */
export function stubFetch(stubRerank: StubRerank = 'lexical'): typeof fetch {
  const byHost = Object.fromEntries(Object.entries(UPSTREAM).map(([p, u]) => [new URL(u).host, p as ProviderName]));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const provider = byHost[url.host];
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : {};
    return (provider && stubProviderResponse(provider, url.pathname, body, stubRerank))
      ?? Response.json({ error: { message: `stub upstream: ${url.host}${url.pathname} is not served in a keyless run` } }, { status: 403 });
  }) as typeof fetch;
}

// ─── Brain-side helpers ─────────────────────────────────────────────

/** chunk id, slug and the hash of the document gbrain's reranker would be sent for every chunk (capRerankDoc of chunk_text or title). */
export function dumpChunkIndex(buildDir: string, brainDir: string, outFile: string): Map<string, ChunkRef[]> {
  const pglite = join(buildDir, 'node_modules/@electric-sql/pglite/dist');
  const script = `
    const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)});
    const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)});
    const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)});
    const { capRerankDoc } = await import(${JSON.stringify(join(buildDir, 'src/core/search/rerank.ts'))});
    const { createHash } = await import('node:crypto');
    const { writeFileSync } = await import('node:fs');
    const db = await PGlite.create({ dataDir: ${JSON.stringify(brainDir)}, extensions: { vector, pg_trgm } });
    const { rows } = await db.query('SELECT cc.id, p.slug, cc.chunk_text, p.title FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY cc.id');
    await db.close();
    const sha = s => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
    writeFileSync(${JSON.stringify(outFile)}, rows.map(r => JSON.stringify({ chunk_id: r.id, slug: String(r.slug).toLowerCase(), h: sha(capRerankDoc(r.chunk_text || r.title || '')) })).join('\\n') + '\\n');
    process.stdout.write(String(rows.length));`;
  execFileSync('bun', ['-e', script], { cwd: buildDir, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' } });
  const index = new Map<string, ChunkRef[]>();
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    if (!line) continue;
    const { chunk_id, slug, h } = JSON.parse(line) as ChunkRef & { h: string };
    const list = index.get(h) ?? [];
    list.push({ chunk_id, slug });
    index.set(h, list);
  }
  return index;
}

/** Dotted paths at which two JSON values differ. */
export function jsonDiff(a: unknown, b: unknown, path = ''): string[] {
  if (a === b) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap(k => jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return [path || '(root)'];
}

/** The `gbrain config set` pairs one arm applies after every restore. */
export function armConfig(arm: Arm, searchMode: string, extra: Array<[string, string]>): Array<[string, string]> {
  return [['search.mode', searchMode], ['search.reranker.enabled', 'true'], ['search.cache.enabled', 'false'], ...extra, ['search.reranker.top_n_in', String(arm)]];
}

// ─── Runner ─────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export class ReplayStop extends Error {
  constructor(message: string, readonly fix: string) { super(message); this.name = 'ReplayStop'; }
}

export async function main(argv = process.argv.slice(2)) {
  const log = (s: string) => process.stderr.write(`[rerank-pool-replay] ${s}\n`);
  const upstream = (flag(argv, '--upstream') ?? 'forward') as 'forward' | 'stub';
  if (!['forward', 'stub'].includes(upstream)) throw new Error('--upstream must be forward or stub');
  const stubRerankFlag = flag(argv, '--stub-rerank') ?? 'lexical';
  if (!['lexical', 'fail', 'fail-arm-25', 'fail-arm-50'].includes(stubRerankFlag)) throw new Error('--stub-rerank must be lexical, fail, fail-arm-25 or fail-arm-50');
  if (upstream === 'forward' && (argv.includes('--stub-rerank') || argv.includes('--fixture-docs'))) throw new Error('--stub-rerank and --fixture-docs need --upstream stub');
  const fixtureDocs = flag(argv, '--fixture-docs') ? Number(flag(argv, '--fixture-docs')) : null;
  const searchMode = flag(argv, '--search-mode') ?? 'tokenmax';
  const extraConfig = (flag(argv, '--gbrain-config') ?? 'search.reranker.timeout_ms=15000').split(',').filter(Boolean).map(kv => {
    const i = kv.indexOf('=');
    if (i <= 0) throw new Error(`--gbrain-config expects key=value pairs separated by commas, got "${kv}"`);
    const pair = [kv.slice(0, i), kv.slice(i + 1)] as [string, string];
    if (['search.mode', 'search.reranker.top_n_in', 'search.reranker.enabled', 'search.cache.enabled'].includes(pair[0])) throw new Error(`--gbrain-config may not set ${pair[0]}; the runner pins it`);
    return pair;
  });
  const label = flag(argv, '--label') ?? 'gbrain-hard';
  const worldPath = resolve(flag(argv, '--world') ?? DEFAULT_WORLD);
  const transcripts = resolve(flag(argv, '--transcripts') ?? DEFAULT_TRANSCRIPTS);
  const out = resolve(flag(argv, '--out') ?? 'eval/reports/cat40/rerank-pool-replay');
  const reuse = !argv.includes('--no-reuse');
  const reuseAudit = Number(flag(argv, '--reuse-audit') ?? 20);

  if (!existsSync(worldPath)) throw new ReplayStop(`world M is missing at ${relative(process.cwd(), worldPath)}`,
    'regenerate it (free, about 40 s): CONFIRM_WORLD=main scripts/cat40-hard.sh step confirm-world, or the two model-ladder-gen.ts commands in docs/benchmarks/cat40-hard/RUNBOOK.md');
  const world: LadderWorld = JSON.parse(readFileSync(worldPath, 'utf8'));
  const digest = worldDigest(world);
  const manifest = JSON.parse(readFileSync(resolve(WORLD_MANIFEST), 'utf8')) as { digest: string };
  if (digest !== manifest.digest) throw new ReplayStop(`world digest ${digest.slice(0, 12)} is not world M's ${manifest.digest.slice(0, 12)} (${WORLD_MANIFEST})`, 'regenerate world M from seed 20261021 and the frozen knobs; never edit a world');
  const all = extractHybridSearchCalls(readTranscriptLines(transcripts), world as unknown as WorldTasks, label);
  const calls = spreadSample(all, flag(argv, '--calls') ? Number(flag(argv, '--calls')) : undefined);
  log(`${all.length} hybrid search calls recorded (${all.filter(c => c.gold.length).length} name a gold document); replaying ${calls.length}`);
  const estimate = estimateReplayCost(calls, world, { reuse, requestsPerCall: flag(argv, '--requests-per-call') ? Number(flag(argv, '--requests-per-call')) : undefined });
  if (argv.includes('--estimate-only')) { console.log(JSON.stringify({ calls_recorded: all.length, calls_with_gold: all.filter(c => c.gold.length).length, estimate }, null, 2)); return { estimate }; }

  if (upstream === 'stub') {
    // Nothing may reach a provider: no real key reaches a gbrain child, and the proxy never fetches in stub mode.
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY']) delete process.env[k];
    process.env.OPENAI_API_KEY = 'sk-keyless-stub-dry-run';
    process.env.VOYAGE_API_KEY = 'pa-keyless-stub-dry-run';
  }
  const repo = resolve(flag(argv, '--gbrain-repo') ?? '../gbrain');
  const root = resolve(flag(argv, '--gbrain-root') ?? join(process.env.HOME ?? '.', '.capy/work/cat40/gbrain'));
  const rev = (ref: string) => execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  if (!flag(argv, '--gbrain-ref')) throw new Error('--gbrain-ref <sha> is required (the build the replay measures)');
  const commit = rev(flag(argv, '--gbrain-ref')!);
  const slotCommit = flag(argv, '--slot-ref') ? rev(flag(argv, '--slot-ref')!) : commit;
  const nSlots = Number(flag(argv, '--slots') ?? 1);
  const analyze = !argv.includes('--no-pglite-analyze');
  const brainWorld = fixtureDocs ? fixtureWorld(world, calls, fixtureDocs) : world;
  const slotDir = slotRoot(root, slotCommit, brainWorld, analyze);
  mkdirSync(out, { recursive: true });
  if (!fixtureDocs) {
    const missing = missingSlotSnapshots(slotDir, nSlots);
    if (missing.length) throw new ReplayStop(`slot snapshots missing for build ${slotCommit.slice(0, 12)} on world M (${missing.join(', ')})`,
      `build one first (about $2.75 of embeddings, about 1 hour): bun eval/runner/cat40-model-ladder.ts --build-slots --world ${relative(process.cwd(), worldPath)} --gbrain-repo ${repo} --gbrain-ref ${slotCommit} --gbrain-root ${root} --slots ${nSlots} --slot-build-allowance-usd 4 --budget-usd ${4 * nSlots} --budget-ledger <ledger> --out ${relative(process.cwd(), join(out, 'slots'))}`);
  }

  const { run, guard } = startPaidRun(RUNNER, { ...budgetOptionsFrom(argv), estimateUsd: upstream === 'stub' ? 0 : estimate.replay_usd, log });
  const proxy = new RerankPoolProxy({ upstream, stubRerank: stubRerankFlag === 'fail' ? 'fail' : 'lexical', reuseRerank: reuse, reuseAuditCalls: reuseAudit });
  const slots: GbrainSlot[] = [];
  const outcomes = new Map<string, Partial<Record<Arm, ArmOutcome>>>();
  const completeArms = { '50': false, '25': false } as Record<`${Arm}`, boolean>;
  const modes: Partial<Record<`${Arm}`, unknown>> = {};
  let index = new Map<string, ChunkRef[]>();
  let fixtureBuild: unknown = null, stopReason: string | null = null, summary;
  let build: ReturnType<typeof prepareBuild> | null = null;
  try {
    build = prepareBuild(repo, { label: 'under-test', ref: commit, description: 'gbrain under test' }, join(root, 'builds'));
    if (fixtureDocs) {
      const meter = new MeteringProxy({ fetchImpl: stubFetch() });
      meter.start();
      try {
        const s = new GbrainSlot('slot0', slotDir, build.dir, meter.port, 'starter');
        if (!s.hasSnapshot()) {
          log(`building a ${brainWorld.docs.length}-document fixture brain with stub embeddings in ${slotDir}`);
          const b = await s.build(brainWorld, meter, analyze);
          fixtureBuild = { docs: brainWorld.docs.length, ms: b.ms, steps: b.steps.map(x => ({ step: x.step, code: x.code, ms: x.ms })), stub_meter: b.meter };
        } else fixtureBuild = { docs: brainWorld.docs.length, reused_snapshot: s.snapshot };
      } finally { meter.stop(); }
      writeFileSync(join(out, 'fixture-world.json'), JSON.stringify(brainWorld));
    }
    proxy.start();
    for (const arm of ARMS) {
      if (stopReason) break;
      proxy.setStubRerank(stubRerankFlag === 'fail' || stubRerankFlag === `fail-arm-${arm}` ? 'fail' : 'lexical');
      for (const s of slots.splice(0)) await s.stop();
      for (let i = 0; i < (fixtureDocs ? 1 : nSlots); i++) {
        const s = new GbrainSlot(`slot${i}`, slotDir, build.dir, proxy.port, 'starter');
        s.config = armConfig(arm, searchMode, extraConfig);
        await s.restore();
        if (i === 0) {
          await s.stop();
          const r = await runCli(s.run, ['search', 'modes', '--json'], 300_000);
          try { modes[`${arm}`] = JSON.parse(r.stdout); } catch { throw new Error(`gbrain search modes --json did not answer JSON (exit ${r.code}): ${(r.stdout + r.stderr).slice(-400)}`); }
          if (!index.size) { index = dumpChunkIndex(build.dir, join(s.dir, 'home', 'brain.pglite'), join(out, 'chunk-index.ndjson')); log(`chunk index: ${index.size} distinct rerank documents`); }
          await s.start();
        }
        slots.push(s);
      }
      if (arm === 25) {
        const diff = jsonDiff(modes['50'], modes['25']).filter(p => !/top_n_in/.test(p));
        if (diff.length) throw new ReplayStop(`the two arms resolve different search settings besides reranker_top_n_in: ${diff.slice(0, 8).join(', ')}`, 'pin the differing keys with --gbrain-config so only the pool differs');
      }
      log(`arm ${arm}: replaying ${calls.length} calls on ${slots.length} slot(s)`);
      let done = 0;
      await Promise.all(slots.map(async (s, w) => {
        for (let j = w; j < calls.length; j += slots.length) {
          if (stopReason) return;
          if (guard.exhausted) { stopReason = `the budget ledger refused a reservation (run ${run.runId}); stopped before exceeding the cap`; return; }
          const c = calls[j];
          const key = `${arm}:${c.id}`;
          proxy.bind(s.id, key);
          const t0 = performance.now();
          let text: string | null = null, harness: string | null = null;
          try { text = await s.client!.call('search', c.args); } catch (e) { harness = (e as Error).message; }
          proxy.unbind(s.id);
          const o = armOutcome(arm, c.query, text, harness, proxy.take(key), Math.round(performance.now() - t0));
          outcomes.set(c.id, { ...outcomes.get(c.id), [arm]: o });
          if (o.status === 'harness_error') { try { await s.restore(); } catch (e) { stopReason = `slot ${s.id} could not be restored after a harness error: ${(e as Error).message}`; return; } }
          if (++done % 100 === 0) log(`arm ${arm}: ${done}/${calls.length}`);
        }
      }));
      completeArms[`${arm}`] = !stopReason && calls.every(c => outcomes.get(c.id)?.[arm]);
    }
  } finally {
    await Promise.all(slots.map(s => s.stop()));
    proxy.stop();
    summary = run.close();
    guard.uninstall();
  }
  const records = calls.filter(c => outcomes.has(c.id)).map(c => callRecord(c, outcomes.get(c.id)!, index));
  writeFileSync(join(out, 'calls.ndjson'), records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  const s = summarize(records, { planned: calls.length, completeArms });
  const meta = { upstream, fixture: !!fixtureDocs, gbrain_commit: commit, search_mode: searchMode };
  const evalsCommit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
  const record = {
    ...s, ...meta, counted: upstream === 'forward' && !fixtureDocs && calls.length === all.length,
    stop_reason: stopReason, slot_commit: slotCommit, slot_dir: slotDir, gbrain_version: build?.version ?? null, gbrain_tree: build?.tree ?? null,
    evals_commit: evalsCommit, world: { path: relative(process.cwd(), worldPath), digest, docs: brainWorld.docs.length, fixture_of: fixtureDocs ? digest : null },
    transcripts: relative(process.cwd(), transcripts), label, calls_recorded: all.length, calls_with_gold: all.filter(c => c.gold.length).length,
    arm_config: Object.fromEntries(ARMS.map(a => [a, armConfig(a, searchMode, extraConfig)])), modes_digest: Object.fromEntries(ARMS.map(a => [a, modes[`${a}`] ? createHash('sha256').update(JSON.stringify(modes[`${a}`])).digest('hex').slice(0, 16) : null])),
    reuse: { requested: reuse, audit_calls: reuseAudit, ...proxy.reuse }, chunk_index_size: index.size, fixture_build: fixtureBuild,
    estimate, cost: receiptCost(summary), budget_run_id: run.runId, argv, finished_at: new Date().toISOString(),
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(join(out, 'summary.md'), summaryMarkdown(s, meta) + '\n');
  writeFileSync(join(out, `receipt-${Date.now()}.json`), JSON.stringify({ ...record, schema: `${SCHEMA}-receipt` }, null, 2) + '\n');
  log(`gold hit@5 50: ${s.gold_hit5.arm50} 25: ${s.gold_hit5.arm25}; difference ${s.gold_hit5.difference_25_minus_50.estimate}, lower bound ${s.gold_hit5.difference_25_minus_50.lower_95_one_sided}; verdict ${s.gold_hit5.verdict}; spent $${record.cost.usd.toFixed(4)}`);
  if (stopReason) log(`stopped: ${stopReason}`);
  if (!s.comparison_valid) process.exitCode = 1;
  return record;
}

if (import.meta.main) {
  main().catch(e => {
    if (e instanceof ReplayStop) { console.error(`[rerank-pool-replay] STOP: ${e.message}\n  fix: ${e.fix}`); process.exit(3); }
    console.error(e);
    process.exit(1);
  });
}
