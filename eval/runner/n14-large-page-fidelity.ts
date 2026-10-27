/**
 * BrainBench N14: large-page fidelity.
 *
 * Question: if I put one very large document in gbrain, can an agent find and
 * read what's deep inside it, and does keeping it up to date stay cheap?
 *
 * The documents come from eval/generators/n14-large-page-gen.ts: a fictional
 * iMessage-style group chat (2 MB, 20 MB, 200 MB; 1 GB listed for manual
 * runs), a long markdown project log and a book-length novel, each with four
 * planted needles per decile of its bytes and a one-detail distractor for
 * every needle. Gold is the generator ledger; the presence oracle rescans the
 * raw bytes before anything is measured.
 *
 * Arms, same documents and same questions in every arm:
 *   single-page    gbrain as it is: the whole document written with put_page,
 *                  read back with a default get_page, appended to by
 *                  rewriting the page. A refusal or an unsearchable page is a
 *                  scored miss, never an error that hides the result.
 *   managed-parts  the best split design today, the one the
 *                  conversation-archive skill and `imessage-daily` pages use:
 *                  a hub page (preamble plus a wikilink index) and one page per
 *                  `## ` section (a day, or a chapter). An append writes one
 *                  new part and updates the hub.
 *   native         the same gbrain through its large-page API, run only when a
 *                  capability probe finds it (get_page `body` modes with a
 *                  window, optionally append_page); otherwise the arm is
 *                  reported as "capability absent", a gap rather than a failure.
 *
 * Hermetic arm (default): provider keys stripped, keyword search only. Each
 * (document, arm) runs in its own child process on in-memory PGLite under an
 * RSS watchdog, so a crash or an out-of-memory kill is measured instead of
 * taking the runner down, and peak RSS belongs to one arm. It records ingest
 * outcome, keyword needle recall@10 by decile (a hit is a top-10 result whose
 * stored chunk holds the needle's answer as a whole token), read correctness
 * (the text a read returns holds the needle and its frame fits the egress
 * cap), the largest response frame of every call, append cost for a 1 KB
 * append (embedding inputs counted by a fake embedder, chunk rows rewritten),
 * the byte-exact export round trip, and ingest wall time and peak RSS.
 *
 * Paid arm (`--paid --budget-run-id <id> --preregistration <path>`): real
 * embeddings for vector and hybrid recall@10 by decile, and reader QA over the
 * deep needles with the preregistered models. Never runs without both flags.
 *
 * Usage:
 *   bun eval/runner/n14-large-page-fidelity.ts [--tier 2mb|20mb|24mib|100mib|128mib|200mb|256mib|260mib|1gb | --tiers 2mb,20mb]
 *     [--arms single-page,managed-parts,native] [--docs conversation,project-log,book] [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]]
 *     [--concurrency N] [--rss-limit-mb N] [--record-bugs] [--json]
 *     [--upgrade-from <checkout>[@ref]]   (2mb tier: seed each document single-page with that gbrain, then backfill and probe it with --gbrain)
 *     [--config key=value[,key=value]]    (brain config set in every child after initSchema, e.g. pages.segmented_storage=on; Amendment 2)
 *     [--native-ingest put_page|import]  (native arm write path; import = importFromFile with the brain's body policy, streamed when segmented; Amendment 2)
 *     [--engine pglite|postgres] [--pg-admin-url <url>]  (Amendment 4: postgres creates one database per child through the admin URL, or N14_PG_ADMIN_URL)
 *     [--lifecycle]                      (Amendment 4: after the round trip, forget a fence fact, soft-delete, restore and purge the page, then count residue)
 */
import { SQL } from 'bun';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { PGLiteEngine as PGLiteEngineType } from 'gbrain/pglite-engine';
import { WAVE_BUG_LEDGER, readBugLedger, upsertBug, type BugEntry } from './bug-ledger.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { attestPreregistration, type Attestation } from './prereg.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, productIdentity, receiptPath, scrubMachinePaths, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  DECILES, N14_DEFAULT_SEED, N14_GENERATOR_VERSION, NEEDLE_TYPES, TIERS, TIER_IDS, checkPresence, containsToken, ledgerFingerprint, tierSpecs, writeDocument,
  type DocKind, type N14DocLedger, type Needle, type PresenceCheck, type TierId,
} from '../generators/n14-large-page-gen.ts';

export const CATEGORY = 'n14-large-page-fidelity';
export const TOP_K = 10;
/** Egress cap on one response frame: the plan's `mcp.max_result_bytes` HTTP default. */
export const EGRESS_CAP_BYTES = 1_048_576;
/** A retrieved passage counts only up to this size, so "return the whole document" never scores. */
export const PASSAGE_CAP_BYTES = 65_536;
export const PARTS_MARKER = '<!-- n14:parts -->';
export const ARMS = ['single-page', 'managed-parts', 'native'] as const;
export type Arm = typeof ARMS[number];
export const DEFAULT_RSS_LIMIT_MB = 6144;
/** Preregistered values (docs/benchmarks/2026-10-14-n14-large-page-fidelity-preregistration.md); the registry row repeats them. */
export const THRESHOLDS = {
  native_keyword_recall_floor: 0.9,
  append_embed_ratio_max: 3,
  native_recall_gap_points_max: 2,
  hybrid_recall_min_decile: 0.95,
} as const;
export const PAID_MODELS = ['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol'] as const;
export const PAID_EMBEDDING = { model: 'voyage:voyage-4', dims: 1024 } as const;
const CONTROL_SLUG = 'notes/n14-control';

/** One token estimate for both sides of the append-cost ratio: UTF-8 bytes / 4, rounded up. */
export const estTokens = (s: string) => Math.ceil(Buffer.byteLength(s) / 4);
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
const errCode = (e: unknown) => (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') ? (e as { code: string }).code : 'error';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Bytes of the JSON-RPC frame that would carry `result` as MCP tool text. */
export function frameBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] } }));
}

// ─── Adapter contract ────────────────────────────────────────────────────

export interface SearchHit {
  slug: string;
  chunk_id: number | null;
  /** The stored passage the hit points at (gbrain: content_chunks.chunk_text by chunk_id). */
  passage: string;
  /** The text the agent actually receives in the result row. */
  delivered: string;
}
export interface IngestOutcome { status: 'stored' | 'refused' | 'error'; code?: string; message?: string; pages: number; chunks: number; embed_skip: string | null; write_errors: number; storage?: BodyStorage | null; pending?: PendingWrites | null; projection?: ProjectionSettle | null }
/** Body storage of the document's entry page (Amendment 2): `segmented` pages keep their body in content-addressed segments. */
/** Writes that replied `write_pending` and were polled to a final state (Amendment 3). */
export interface PendingWrites { writes: number; wait_ms: number }
/** A segmented page's text projection (its chunks) is built after the write commits; probes wait for it to seal (Amendment 3). */
export interface ProjectionSettle { sealed_at_reply: boolean; sealed: boolean; settle_ms: number }
export interface BodyStorage { body_storage: string; body_bytes: number | null; segment_count: number | null; body_generation: number | null }
/** Segment rows an append wrote (Amendment 2): live manifest rows at the new generation, and segment texts added. */
export interface SegmentWrites { generation_before: number | null; generation_after: number | null; live_segments: number; segments_at_new_generation: number; segment_texts_added: number; segment_text_bytes_added: number }
export interface AppendOutcome { status: 'ok' | 'refused' | 'error'; code?: string; message?: string; chunks_before: number; chunks_after: number; chunks_rewritten: number; chunks_deleted: number; path: string; segments?: SegmentWrites | null; pending?: PendingWrites | null; projection?: ProjectionSettle | null }
export interface EmbedCount { inputs: number; tokens: number }
export interface CallFrame { op: string; bytes: number }

/** What a category arm must do. The gbrain arms implement it in a child process; tests use in-memory adapters. */
export interface N14Adapter {
  readonly arm: Arm;
  readonly frames: CallFrame[];
  ingest(ledger: N14DocLedger, raw: string): Promise<IngestOutcome>;
  storedContains(answer: string): Promise<boolean>;
  search(query: string): Promise<SearchHit[]>;
  /** Read the page behind a hit the way this arm reads; returns the response text. */
  read(hit: SearchHit): Promise<string>;
  /** Read the document's entry page by slug with default parameters. */
  directRead(): Promise<string>;
  /** The same default read as an agent-facing (remote) caller; its frame bytes, outside the egress count. */
  agentDirectReadBytes?(): Promise<number>;
  /** Embed everything stale; null when the adapter has no embedder. */
  embedPass(): Promise<EmbedCount | null>;
  append(text: string): Promise<AppendOutcome>;
  /** Export, then reassemble the document body from the exported files. */
  exportBody(): Promise<string>;
  /** Amendment 2: the live segment texts of a segmented entry page, joined in order; null for an inline page. */
  segmentBody?(): Promise<{ body: string; regions: string[] } | null>;
  /** Amendment 4: forget, delete, restore and purge the entry page; `body` is the page as the arm last wrote it. Null when the arm has no single entry page. */
  lifecycle?(body: string): Promise<LifecycleOutcome | null>;
  close(): Promise<void>;
}

export interface ProbeRow { id: string; decile: number; type: string; hit_rank: number | null; delivered_rank: number | null; distractor_rank: number | null; n_results: number; error?: string }
export interface ReadRow { id: string; attempted: boolean; contains: boolean; bytes: number | null; correct: boolean; error?: string }
export interface MemMark { phase: string; t_ms: number; rss_mb: number; max_rss_mb: number }

export interface ArmRun {
  arm: Arm;
  doc: string;
  bytes: number;
  ingest: IngestOutcome & { wall_ms: number };
  stored: { contains: number; total: number };
  control: { hits: number; total: number; missed: string[] };
  probes: ProbeRow[];
  reads: ReadRow[];
  direct_read: { bytes: number | null; error?: string };
  direct_read_agent?: { bytes: number | null; error?: string };
  embed_initial: (EmbedCount & { wall_ms: number }) | null;
  embed_error?: string;
  append: AppendOutcome & { wall_ms: number; embed: EmbedCount | null; appended_tokens: number; visible_rank: number | null; visible_error?: string };
  roundtrip: { status: 'match' | 'mismatch' | 'not_stored' | 'error'; expected_sha256: string; actual_sha256?: string; byte_delta?: number; first_diff?: FirstDiff; error?: string };
  /** Amendment 2 (exploratory, outside the safety count): sha256 of the stored segments against the same expected body. */
  segment_roundtrip?: { status: 'match' | 'mismatch' | 'not_comparable' | 'error'; actual_sha256?: string; byte_delta?: number; regions?: string[]; error?: string };
  lifecycle?: LifecycleOutcome | { error: string };
  frames: { count: number; max_bytes: number; over_cap: number; by_op: Record<string, { count: number; max_bytes: number; over_cap: number }> };
  memory: MemMark[];
}

export interface FirstDiff { offset: number; expected: string; actual: string; differing_lines: number }

/**
 * Amendment 4 (exploratory, outside the verdict): the page's lifecycle after the round trip. `probes` is one needle
 * query per decile; a hit is a top-10 stored chunk holding the needle answer.
 */
export interface LifecycleOutcome {
  probes: number;
  hits_before: number;
  forget: { status: 'ok' | 'error'; fact_rows: number; withdrawn: boolean | null; recall_hits_after: number | null; export_row: 'struck' | 'active' | 'absent' | null; wall_ms: number; error?: string };
  delete: { status: 'ok' | 'error'; hits_after: number | null; get_page_code: string | null; wall_ms: number; error?: string };
  restore: { status: 'ok' | 'error'; hits_after: number | null; export_matches_pre_delete: boolean | null; wall_ms: number; error?: string };
  purge: {
    status: 'ok' | 'error'; wall_ms: number; error?: string; removed?: Record<string, number>;
    residue: { pages: number; chunks: number; manifest_rows: number; versions: number; facts: number; needle_chunks: number; needle_texts: number; unreferenced_texts: number; unreferenced_text_bytes: number } | null;
    sweep: { texts_deleted: number; needle_texts_after: number; texts_left: number } | null;
  };
}

/** Where two texts first differ (UTF-16 offset), with a little context, and how many lines differ by position. */
export function firstDiff(expected: string, actual: string): FirstDiff {
  let i = 0;
  while (i < expected.length && i < actual.length && expected.charCodeAt(i) === actual.charCodeAt(i)) i++;
  const a = expected.split('\n');
  const b = actual.split('\n');
  let differing = Math.abs(a.length - b.length);
  for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) differing++;
  return { offset: i, expected: JSON.stringify(expected.slice(Math.max(0, i - 40), i + 60)), actual: JSON.stringify(actual.slice(Math.max(0, i - 40), i + 60)), differing_lines: differing };
}

/** Rank (1-based) of the first hit whose passage holds `token` within the cap; null when none in the top k. */
export function hitRank(passages: readonly string[], token: string, k = TOP_K): number | null {
  for (let i = 0; i < Math.min(k, passages.length); i++) {
    const p = passages[i];
    if (Buffer.byteLength(p) <= PASSAGE_CAP_BYTES && containsToken(p, token)) return i + 1;
  }
  return null;
}

/** Run one arm over one document through the adapter. Every gbrain exception is recorded, never thrown. */
export async function evaluateArm(adapter: N14Adapter, ledger: N14DocLedger, raw: string, opts: { embed?: boolean; lifecycle?: boolean; probeMemory?: (phase: string) => MemMark } = {}): Promise<ArmRun> {
  const mark = opts.probeMemory ?? ((phase: string) => ({ phase, t_ms: 0, rss_mb: 0, max_rss_mb: 0 }));
  const memory: MemMark[] = [mark('start')];
  const t0 = performance.now();
  let ingest: IngestOutcome;
  try { ingest = await adapter.ingest(ledger, raw); }
  catch (e) { ingest = { status: 'error', code: errCode(e), message: errMsg(e).slice(0, 500), pages: 0, chunks: 0, embed_skip: null, write_errors: 1 }; }
  const ingestMs = performance.now() - t0;
  memory.push(mark('ingest'));

  let contains = 0;
  for (const n of ledger.needles) { try { if (await adapter.storedContains(n.answer)) contains++; } catch { /* counted as absent */ } }

  const searchPassages = async (query: string) => {
    const hits = await adapter.search(query);
    return { hits, passages: hits.map(h => h.passage), delivered: hits.map(h => h.delivered) };
  };
  const control = { hits: 0, total: ledger.control.needles.length, missed: [] as string[] };
  for (const c of ledger.control.needles) {
    try { if (hitRank((await searchPassages(c.query)).passages, c.answer) !== null) control.hits++; else control.missed.push(c.id); }
    catch (e) { control.missed.push(`${c.id}: ${errMsg(e).slice(0, 120)}`); }
  }

  const probes: ProbeRow[] = [];
  const reads: ReadRow[] = [];
  for (const n of ledger.needles) {
    const row: ProbeRow = { id: n.id, decile: n.decile, type: n.type, hit_rank: null, delivered_rank: null, distractor_rank: null, n_results: 0 };
    try {
      const r = await searchPassages(n.query);
      row.n_results = r.hits.length;
      row.hit_rank = hitRank(r.passages, n.answer);
      row.delivered_rank = r.delivered.findIndex(d => containsToken(d, n.answer)) + 1 || null;
      row.distractor_rank = hitRank(r.passages, n.distractor.answer);
      if (row.hit_rank !== null) {
        const hit = r.hits[row.hit_rank - 1];
        try {
          const text = await adapter.read(hit);
          const bytes = adapter.frames.at(-1)?.bytes ?? Buffer.byteLength(text);
          const has = containsToken(text, n.answer);
          reads.push({ id: n.id, attempted: true, contains: has, bytes, correct: has && bytes <= EGRESS_CAP_BYTES });
        } catch (e) { reads.push({ id: n.id, attempted: true, contains: false, bytes: null, correct: false, error: `${errCode(e)}: ${errMsg(e).slice(0, 200)}` }); }
      } else {
        reads.push({ id: n.id, attempted: false, contains: false, bytes: null, correct: false });
      }
    } catch (e) { row.error = `${errCode(e)}: ${errMsg(e).slice(0, 200)}`; reads.push({ id: n.id, attempted: false, contains: false, bytes: null, correct: false }); }
    probes.push(row);
  }
  let directRead: ArmRun['direct_read'];
  try { await adapter.directRead(); directRead = { bytes: adapter.frames.at(-1)?.bytes ?? null }; }
  catch (e) { directRead = { bytes: null, error: `${errCode(e)}: ${errMsg(e).slice(0, 200)}` }; }
  let directReadAgent: ArmRun['direct_read_agent'];
  if (adapter.agentDirectReadBytes) {
    try { directReadAgent = { bytes: await adapter.agentDirectReadBytes() }; }
    catch (e) { directReadAgent = { bytes: null, error: `${errCode(e)}: ${errMsg(e).slice(0, 200)}` }; }
  }
  memory.push(mark('reads'));

  let embedInitial: ArmRun['embed_initial'] = null;
  let embedError: string | undefined;
  if (opts.embed !== false) {
    const te = performance.now();
    try { const c = await adapter.embedPass(); embedInitial = c ? { ...c, wall_ms: performance.now() - te } : null; }
    catch (e) { embedError = `${errCode(e)}: ${errMsg(e).slice(0, 300)}`; }
  }
  const appendText = ledger.append.text;
  const ta = performance.now();
  let app: AppendOutcome;
  try { app = await adapter.append(appendText); }
  catch (e) { app = { status: 'error', code: errCode(e), message: errMsg(e).slice(0, 500), chunks_before: 0, chunks_after: 0, chunks_rewritten: 0, chunks_deleted: 0, path: 'unknown' }; }
  const appendMs = performance.now() - ta;
  let appendEmbed: EmbedCount | null = null;
  if (opts.embed !== false && embedInitial) {
    try { appendEmbed = await adapter.embedPass(); }
    catch (e) { embedError ??= `append: ${errCode(e)}: ${errMsg(e).slice(0, 300)}`; }
  }
  let visibleRank: number | null = null;
  let visibleError: string | undefined;
  try { visibleRank = hitRank((await searchPassages(ledger.append.needle.query)).passages, ledger.append.needle.answer); }
  catch (e) { visibleError = errMsg(e).slice(0, 200); }
  memory.push(mark('append'));

  const expected = canonicalBody(raw.slice(raw.indexOf('\n---\n', 3) + 5) + (app.status === 'ok' ? appendText : ''));
  const expectedSha = sha256(expected);
  let roundtrip: ArmRun['roundtrip'];
  if (ingest.status !== 'stored') roundtrip = { status: 'not_stored', expected_sha256: expectedSha };
  else {
    try {
      const body = canonicalBody(await adapter.exportBody());
      const actualSha = sha256(body);
      roundtrip = { status: actualSha === expectedSha ? 'match' : 'mismatch', expected_sha256: expectedSha, actual_sha256: actualSha, byte_delta: Buffer.byteLength(body) - Buffer.byteLength(expected), ...(actualSha === expectedSha ? {} : { first_diff: firstDiff(expected, body) }) };
    } catch (e) { roundtrip = { status: 'error', expected_sha256: expectedSha, error: `${errCode(e)}: ${errMsg(e).slice(0, 300)}` }; }
  }
  let segmentRoundtrip: ArmRun['segment_roundtrip'];
  if (ingest.status === 'stored' && adapter.segmentBody) {
    try {
      const seg = await adapter.segmentBody();
      if (seg && seg.regions.some(r => r !== 'truth')) segmentRoundtrip = { status: 'not_comparable', regions: seg.regions };
      else if (seg) {
        const body = canonicalBody(seg.body);
        const actualSha = sha256(body);
        segmentRoundtrip = { status: actualSha === expectedSha ? 'match' : 'mismatch', actual_sha256: actualSha, byte_delta: Buffer.byteLength(body) - Buffer.byteLength(expected), regions: seg.regions };
      }
    } catch (e) { segmentRoundtrip = { status: 'error', error: `${errCode(e)}: ${errMsg(e).slice(0, 300)}` }; }
  }
  memory.push(mark('export'));
  let lifecycle: ArmRun['lifecycle'];
  if (opts.lifecycle && ingest.status === 'stored' && adapter.lifecycle) {
    const counted = adapter.frames.length;
    try { lifecycle = await adapter.lifecycle(raw + (app.status === 'ok' ? appendText : '')) ?? undefined; }
    catch (e) { lifecycle = { error: `${errCode(e)}: ${errMsg(e).slice(0, 300)}` }; }
    adapter.frames.splice(counted);
    memory.push(mark('lifecycle'));
  }

  const byOp: ArmRun['frames']['by_op'] = {};
  for (const f of adapter.frames) {
    const o = (byOp[f.op] ??= { count: 0, max_bytes: 0, over_cap: 0 });
    o.count++;
    o.max_bytes = Math.max(o.max_bytes, f.bytes);
    if (f.bytes > EGRESS_CAP_BYTES) o.over_cap++;
  }
  return {
    arm: adapter.arm, doc: ledger.id, bytes: ledger.bytes,
    ingest: { ...ingest, wall_ms: Math.round(ingestMs) },
    stored: { contains, total: ledger.needles.length },
    control, probes, reads, direct_read: directRead, ...(directReadAgent ? { direct_read_agent: directReadAgent } : {}),
    embed_initial: embedInitial,
    ...(embedError ? { embed_error: embedError } : {}),
    append: { ...app, wall_ms: Math.round(appendMs), embed: appendEmbed, appended_tokens: estTokens(appendText), visible_rank: visibleRank, ...(visibleError ? { visible_error: visibleError } : {}) },
    roundtrip,
    ...(segmentRoundtrip ? { segment_roundtrip: segmentRoundtrip } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    frames: { count: adapter.frames.length, max_bytes: Math.max(0, ...adapter.frames.map(f => f.bytes)), over_cap: adapter.frames.filter(f => f.bytes > EGRESS_CAP_BYTES).length, by_op: byOp },
    memory,
  };
}

// ─── Scoring (pure) ──────────────────────────────────────────────────────

export interface Rate { hits: number; total: number; rate: number }
const rate = (hits: number, total: number): Rate => ({ hits, total, rate: total ? hits / total : 0 });

export interface ArmSummary {
  arm: Arm;
  doc: string;
  tier: TierId;
  status: 'ran' | 'crashed' | 'capability_absent';
  crash?: string;
  ingest: { status: string; code?: string; chunks: number; pages: number; embed_skip: string | null; wall_ms: number | null; rss_peak_mb: number | null; rss_over_baseline_mb: number | null; storage?: BodyStorage | null; pending?: PendingWrites | null; projection?: ProjectionSettle | null };
  stored_needles: Rate;
  keyword_recall: Rate;
  keyword_recall_by_decile: Rate[];
  min_decile_recall: number;
  delivered_recall: Rate;
  distractor_preferred: number;
  reads: { attempted: number; contains: number; correct: number; max_bytes: number | null };
  direct_read_bytes: number | null;
  /** Default get_page of the entry page as an agent-facing caller (exploratory, Amendment 1); not in the egress count. */
  direct_read_agent_bytes?: number | null;
  max_frame_bytes: number;
  responses_over_cap: number;
  append: { status: string; code?: string; wall_ms: number | null; embed_inputs: number | null; embed_tokens: number | null; appended_tokens: number; embed_ratio: number | null; chunks_rewritten: number; chunks_deleted: number; visible: boolean; path: string; segments?: SegmentWrites | null; pending?: PendingWrites | null; projection?: ProjectionSettle | null } | null;
  embed_initial: { inputs: number; tokens: number; wall_ms: number; tokens_per_mb: number } | null;
  roundtrip: string;
  segment_roundtrip?: string;
  roundtrip_byte_delta: number | null;
  lifecycle?: LifecycleOutcome | { error: string };
}

export function summarizeArm(run: ArmRun, tier: TierId): ArmSummary {
  const byDecile = Array.from({ length: DECILES }, (_, d) => {
    const rows = run.probes.filter(p => p.decile === d);
    return rate(rows.filter(p => p.hit_rank !== null).length, rows.length);
  });
  const hits = run.probes.filter(p => p.hit_rank !== null).length;
  const baseline = run.memory.find(m => m.phase === 'start');
  const afterIngest = run.memory.find(m => m.phase === 'ingest');
  const chunksAfter = run.append.chunks_after;
  // Append cost is defined only for a page that is searchable after the append.
  const ratio = run.append.status === 'ok' && run.append.embed && chunksAfter > 0 ? run.append.embed.tokens / run.append.appended_tokens : null;
  const attempted = run.reads.filter(r => r.attempted);
  return {
    arm: run.arm, doc: run.doc, tier, status: 'ran',
    ingest: {
      status: run.ingest.status, ...(run.ingest.code ? { code: run.ingest.code } : {}), chunks: run.ingest.chunks, pages: run.ingest.pages, embed_skip: run.ingest.embed_skip,
      wall_ms: run.ingest.wall_ms, rss_peak_mb: afterIngest?.max_rss_mb || null,
      rss_over_baseline_mb: afterIngest && baseline && afterIngest.max_rss_mb ? Math.max(0, Math.round(afterIngest.max_rss_mb - baseline.rss_mb)) : null,
      ...(run.ingest.storage !== undefined ? { storage: run.ingest.storage } : {}),
      ...(run.ingest.pending ? { pending: run.ingest.pending } : {}),
      ...(run.ingest.projection ? { projection: run.ingest.projection } : {}),
    },
    stored_needles: rate(run.stored.contains, run.stored.total),
    keyword_recall: rate(hits, run.probes.length),
    keyword_recall_by_decile: byDecile,
    min_decile_recall: Math.min(...byDecile.map(r => r.rate)),
    delivered_recall: rate(run.probes.filter(p => p.delivered_rank !== null).length, run.probes.length),
    distractor_preferred: run.probes.filter(p => p.distractor_rank !== null && (p.hit_rank === null || p.distractor_rank < p.hit_rank)).length,
    reads: { attempted: attempted.length, contains: attempted.filter(r => r.contains).length, correct: attempted.filter(r => r.correct).length, max_bytes: attempted.length ? Math.max(0, ...attempted.map(r => r.bytes ?? 0)) : null },
    direct_read_bytes: run.direct_read.bytes,
    ...(run.direct_read_agent ? { direct_read_agent_bytes: run.direct_read_agent.bytes } : {}),
    max_frame_bytes: run.frames.max_bytes,
    responses_over_cap: run.frames.over_cap,
    append: {
      status: run.append.status, ...(run.append.code ? { code: run.append.code } : {}), wall_ms: run.append.wall_ms,
      embed_inputs: run.append.embed?.inputs ?? null, embed_tokens: run.append.embed?.tokens ?? null, appended_tokens: run.append.appended_tokens,
      embed_ratio: ratio === null ? null : Number(ratio.toFixed(3)), chunks_rewritten: run.append.chunks_rewritten, chunks_deleted: run.append.chunks_deleted,
      visible: run.append.visible_rank !== null, path: run.append.path, ...(run.append.segments !== undefined ? { segments: run.append.segments } : {}), ...(run.append.pending ? { pending: run.append.pending } : {}), ...(run.append.projection ? { projection: run.append.projection } : {}),
    },
    embed_initial: run.embed_initial ? { inputs: run.embed_initial.inputs, tokens: run.embed_initial.tokens, wall_ms: Math.round(run.embed_initial.wall_ms), tokens_per_mb: Math.round(run.embed_initial.tokens / (run.bytes / 1e6)) } : null,
    roundtrip: run.roundtrip.status,
    ...(run.segment_roundtrip ? { segment_roundtrip: run.segment_roundtrip.status } : {}),
    roundtrip_byte_delta: run.roundtrip.byte_delta ?? null,
    ...(run.lifecycle ? { lifecycle: run.lifecycle } : {}),
  };
}

/** A child that died: every probe it owned is a scored miss and the crash counts against safety. */
export function crashedSummary(arm: Arm, ledger: Pick<N14DocLedger, 'id' | 'needles'>, tier: TierId, crash: string, rssPeakMb: number | null): ArmSummary {
  const zero = rate(0, ledger.needles.length);
  return {
    arm, doc: ledger.id, tier, status: 'crashed', crash,
    ingest: { status: 'crashed', chunks: 0, pages: 0, embed_skip: null, wall_ms: null, rss_peak_mb: rssPeakMb, rss_over_baseline_mb: null },
    stored_needles: zero, keyword_recall: zero,
    keyword_recall_by_decile: Array.from({ length: DECILES }, (_, d) => rate(0, ledger.needles.filter(n => n.decile === d).length)),
    min_decile_recall: 0, delivered_recall: zero, distractor_preferred: 0,
    reads: { attempted: 0, contains: 0, correct: 0, max_bytes: null }, direct_read_bytes: null, max_frame_bytes: 0, responses_over_cap: 0,
    append: null, embed_initial: null, roundtrip: 'crashed', roundtrip_byte_delta: null,
  };
}

/** The native arm when the capability probe finds no large-page API: a reported gap, never scored. */
export function absentSummary(ledger: Pick<N14DocLedger, 'id' | 'needles'>, tier: TierId): ArmSummary {
  const s = crashedSummary('native', ledger, tier, 'capability absent', null);
  return { ...s, status: 'capability_absent', crash: undefined, ingest: { ...s.ingest, status: 'capability_absent' }, roundtrip: 'not_run' };
}

export interface N14Summary {
  safety: { crashes: number; responses_over_cap: number; roundtrip_byte_loss: number; presence_failures: number };
  quality: { native_append_embed_ratio_max: number | null; native_recall_gap_points_max: number | null };
  floor: { native_keyword_recall_2mb: number | null };
  capability: NativeCapability;
  arms: ArmSummary[];
}

export function summarize(arms: readonly ArmSummary[], presenceFailures: number, capability: NativeCapability): N14Summary {
  const ran = arms.filter(a => a.status !== 'capability_absent');
  const native = ran.filter(a => a.arm === 'native');
  const nativeRatios = native.map(a => a.append?.embed_ratio ?? null);
  const gaps = native.map(n => {
    const parts = ran.find(a => a.arm === 'managed-parts' && a.doc === n.doc && a.tier === n.tier);
    return parts ? (parts.keyword_recall.rate - n.keyword_recall.rate) * 100 : null;
  });
  const native2 = native.filter(a => a.tier === '2mb');
  return {
    safety: {
      crashes: ran.filter(a => a.status === 'crashed').length,
      responses_over_cap: ran.reduce((n, a) => n + a.responses_over_cap, 0),
      roundtrip_byte_loss: ran.filter(a => a.roundtrip === 'mismatch' || a.roundtrip === 'error').length,
      presence_failures: presenceFailures,
    },
    quality: {
      // A missing native append measurement (no capability, append refused, page unsearchable) is null, which fails the threshold.
      native_append_embed_ratio_max: !native.length || nativeRatios.some(r => r === null) ? null : Math.max(...(nativeRatios as number[])),
      native_recall_gap_points_max: !native.length || gaps.some(g => g === null) ? null : Number(Math.max(...(gaps as number[])).toFixed(2)),
    },
    floor: {
      native_keyword_recall_2mb: native2.length ? native2.reduce((n, a) => n + a.keyword_recall.hits, 0) / native2.reduce((n, a) => n + a.keyword_recall.total, 0) : null,
    },
    capability,
    arms: [...arms],
  };
}

/** The preregistered rules, applied to a summary; the registry row repeats them for all.ts. */
export function n14Verdict(s: N14Summary): { verdict: 'pass' | 'fail'; failed: string[] } {
  const failed: string[] = [];
  for (const [k, v] of Object.entries(s.safety)) if (v !== 0) failed.push(`safety.${k}=${v}`);
  const { native_append_embed_ratio_max: ratio, native_recall_gap_points_max: gap } = s.quality;
  if (ratio === null || ratio > THRESHOLDS.append_embed_ratio_max) failed.push(`quality.native_append_embed_ratio_max=${ratio}`);
  if (gap === null || gap > THRESHOLDS.native_recall_gap_points_max) failed.push(`quality.native_recall_gap_points_max=${gap}`);
  const floor = s.floor.native_keyword_recall_2mb;
  if (floor === null || floor < THRESHOLDS.native_keyword_recall_floor) failed.push(`floor.native_keyword_recall_2mb=${floor}`);
  return { verdict: failed.length ? 'fail' : 'pass', failed };
}

// ─── Managed parts (the split design) ────────────────────────────────────

export interface PartPlan { slug: string; key: string; content: string; body: string }

/**
 * Split a document into a hub page and one page per `## ` section, the
 * conversation-archive / imessage-daily design. Part bodies are the section
 * text verbatim, so concatenating the hub preamble and the parts in key order
 * rebuilds the body byte for byte.
 */
export function splitIntoParts(raw: string, ledger: Pick<N14DocLedger, 'slug' | 'title' | 'kind' | 'page_type'>): { hub: { slug: string; preamble: string }; parts: PartPlan[] } {
  const bodyStart = raw.indexOf('\n---\n', 3) + 5;
  const body = raw.slice(bodyStart);
  const starts: number[] = [];
  if (body.startsWith('## ')) starts.push(0);
  for (let i = body.indexOf('\n## '); i >= 0; i = body.indexOf('\n## ', i + 1)) starts.push(i + 1);
  const preamble = body.slice(0, starts[0] ?? body.length);
  const partType = ledger.kind === 'conversation' ? 'imessage-daily' : 'note';
  const parts = starts.map((s, i) => {
    const text = body.slice(s, starts[i + 1] ?? body.length);
    return partFor(ledger, text, partType);
  });
  return { hub: { slug: ledger.slug, preamble }, parts };
}

function partFor(ledger: Pick<N14DocLedger, 'slug' | 'title'>, sectionText: string, partType: string): PartPlan {
  const heading = sectionText.slice(3, sectionText.indexOf('\n') >= 0 ? sectionText.indexOf('\n') : undefined).trim();
  const chapter = /^Chapter (\d+)/.exec(heading);
  const key = chapter ? `chapter-${chapter[1].padStart(3, '0')}` : heading;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(key) ? `date: ${key}\n` : '';
  return { slug: `${ledger.slug}/${key}`, key, body: sectionText, content: `---\ntype: ${partType}\ntitle: ${JSON.stringify(`${ledger.title}, ${heading}`)}\n${date}---\n${sectionText}` };
}

export function hubContent(ledger: Pick<N14DocLedger, 'title' | 'page_type'>, preamble: string, parts: readonly PartPlan[]): string {
  return `---\ntype: ${ledger.page_type}\ntitle: ${JSON.stringify(ledger.title)}\nparts: ${parts.length}\n---\n${preamble}${PARTS_MARKER}\n\n${parts.map(p => `- [[${p.slug}]]`).join('\n')}\n`;
}

/**
 * gbrain's documented body framing: parseMarkdown stores `compiled_truth.trim()`
 * (src/core/markdown.ts parseMarkdown) and serializeMarkdown writes it between a
 * blank line and one trailing newline. The round trip applies this framing to the
 * source and compares everything else byte for byte.
 */
export function canonicalBody(body: string): string {
  return `\n${body.trim()}\n`;
}

/** Body of an exported Markdown file (after its frontmatter block). */
export function exportedBody(file: string): string {
  if (!file.startsWith('---\n')) return file;
  const end = file.indexOf('\n---\n', 3);
  return end < 0 ? file : file.slice(end + 5);
}

// ─── Native capability probe ─────────────────────────────────────────────

export interface NativeCapability { present: boolean; get_page_body: string | null; append_page: boolean; upload_session: boolean; evidence: string }

/** Read gbrain's own operation registry: the large-page API is get_page `body` with a window mode. */
export function probeNativeCapability(operations: ReadonlyArray<{ name: string; params?: Record<string, unknown> }>): NativeCapability {
  const byName = new Map(operations.map(o => [o.name, o]));
  const body = byName.get('get_page')?.params?.body;
  const bodyText = body === undefined ? null : JSON.stringify(body);
  const present = bodyText !== null && /window/.test(bodyText);
  const appendPage = byName.has('append_page');
  const upload = byName.has('begin_page_upload') && byName.has('upload_page_part') && byName.has('commit_page_upload');
  return {
    present, get_page_body: bodyText, append_page: appendPage, upload_session: upload,
    evidence: present ? `get_page declares body ${bodyText}${appendPage ? '; append_page exists' : ''}${upload ? '; upload sessions exist' : ''}` : `get_page declares ${bodyText === null ? 'no body parameter' : `body ${bodyText} without a window mode`}; ${appendPage ? 'append_page exists' : 'no append_page op'}`,
  };
}

/**
 * Amendment 5: an upload's parts, in order. Each part ends on a code point boundary, and each upload_page_part call's
 * encoded frame (gbrain's encodedFrameBytes: the JSON-RPC envelope plus its 1024-byte reserve) stays within `cap`.
 */
export function cutUploadParts(buf: Buffer, uploadId: string, cap: number): Buffer[] {
  const frame = (slice: Buffer, part: number) => Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 0,
    result: { upload_id: uploadId, part, text: slice.toString('utf8'), part_sha256: '0'.repeat(64) } })) + 1024;
  const parts: Buffer[] = [];
  for (let off = 0; off < buf.length;) {
    for (let size = Math.min(buf.length - off, Math.floor(cap / 2)); ; size = Math.floor(size * 0.8)) {
      let end = off + size;
      while (end < buf.length && end > off && (buf[end] & 0xc0) === 0x80) end--;
      const slice = buf.subarray(off, end);
      if (end === off) throw new Error(`an upload part limit of ${cap} bytes cannot carry the text at byte ${off}`);
      if (frame(slice, parts.length) > cap) continue;
      parts.push(slice);
      off = end;
      break;
    }
  }
  return parts;
}

// ─── gbrain adapter (runs inside a child process) ────────────────────────

interface OperationsModule { operations: Array<{ name: string; params?: Record<string, unknown>; handler: (ctx: unknown, p: Record<string, unknown>) => Promise<unknown> }> }
interface GatewayModule {
  configureGateway: (c: Record<string, unknown>) => void;
  __setEmbedTransportForTests: (fn: unknown) => void;
  embedQuery?: (text: string) => Promise<Float32Array>;
  chat?: (o: Record<string, unknown>) => Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } }>;
}
type RunEmbedCore = (engine: unknown, opts: Record<string, unknown>) => Promise<unknown>;
type RunExport = (engine: unknown, args: string[]) => Promise<void>;
type ImportFromFile = (engine: unknown, file: string, rel: string, opts: Record<string, unknown>) => Promise<{ status: string; error?: string; refusal?: { code: string; message: string } }>;
export type NativeIngest = 'put_page' | 'import';
/** How long a `write_pending` write is polled before the harness records it as still pending (Amendment 3). */
export const PENDING_WAIT_MAX_MS = 240_000;
/** How long probes wait for a segmented page's projection to seal (Amendment 3). */
export const PROJECTION_SETTLE_MAX_MS = 240_000;
/** Amendment 4: both waits scale with the document, 3 s per MB above the Amendment 3 floor (805 s at 256 MiB). */
export const settleBoundMs = (bytes: number) => Math.max(PROJECTION_SETTLE_MAX_MS, Math.ceil(bytes / 1e6) * 3_000);
export const LIFECYCLE_TOKEN = 'quillfeather7731';
/** Amendment 5: the preregistered upload threshold, 4 MiB. */
export const UPLOAD_ABOVE_BYTES = 4 * 1024 * 1024;
export const LIFECYCLE_CLAIM = `The N14 lifecycle marker is ${LIFECYCLE_TOKEN}`;
/** Amendment 4: the facts fence the lifecycle appends, one fact row whose claim carries LIFECYCLE_TOKEN. */
export function lifecycleFence(): string {
  return ['', '', '## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    `| 1 | ${LIFECYCLE_CLAIM} | fact | 1.0 | world | low | 2026-10-01 |  | n14 |  |`,
    '<!--- gbrain:facts:end -->', ''].join('\n');
}
type Embedder = { kind: 'counting' } | { kind: 'none' } | { kind: 'real'; model: string; dims: number; env: Record<string, string> };

export class GbrainAdapter implements N14Adapter {
  readonly frames: CallFrame[] = [];
  readonly arm: Arm;
  #engine!: PGLiteEngineType;
  #ops!: Map<string, OperationsModule['operations'][number]>;
  #ctx!: Record<string, unknown>;
  #gw!: GatewayModule;
  #runEmbedCore!: RunEmbedCore;
  #runExport!: RunExport;
  #embedder: Embedder;
  #embedCount: EmbedCount = { inputs: 0, tokens: 0 };
  #gatewayReady = false;
  #countingModel: { embedding_model: string; embedding_dimensions: number } | null = null;
  #ledger!: N14DocLedger;
  #raw = '';
  #rev = new Map<string, string>();
  #parts: PartPlan[] = [];
  #preamble = '';
  #capability!: NativeCapability;
  #runBackfill: ((engine: unknown) => Promise<unknown>) | null = null;
  #nativeIngest: NativeIngest = 'put_page';
  #pending: PendingWrites = { writes: 0, wait_ms: 0 };
  #importFile: ((file: string, rel: string) => Promise<{ status: string; error?: string; refusal?: { code: string; message: string } }>) | null = null;
  #pg: { admin: SQL; db: string } | null = null;
  /** The `runOversizedBackfill` receipt when this adapter's ingest is the upgrade backfill (Amendment 1). */
  backfill: unknown = null;

  private constructor(arm: Arm, embedder: Embedder) { this.arm = arm; this.#embedder = embedder; }

  /**
   * `dataDir` opens a file-backed brain instead of an in-memory one. `upgrade`
   * makes ingest run the gbrain under test's oversized-page backfill on a brain
   * an older gbrain seeded, instead of writing the document.
   */
  static async open(root: string, arm: Arm, embedder: Embedder, opts: { dataDir?: string; upgrade?: boolean; config?: Record<string, string>; nativeIngest?: NativeIngest; pgAdminUrl?: string } = {}): Promise<GbrainAdapter> {
    const a = new GbrainAdapter(arm, embedder);
    a.#nativeIngest = opts.nativeIngest ?? 'put_page';
    const gut: GbrainUnderTest = { root, version: 'child', overlay: null };
    const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => PGLiteEngineType }>(gut, 'src/core/pglite-engine.ts');
    const { operations } = await importGbrain<OperationsModule>(gut, 'src/core/operations.ts');
    a.#gw = await importGbrain<GatewayModule>(gut, 'src/core/ai/gateway.ts');
    a.#runEmbedCore = (await importGbrain<{ runEmbedCore: RunEmbedCore }>(gut, 'src/commands/embed.ts')).runEmbedCore;
    a.#runExport = (await importGbrain<{ runExport: RunExport }>(gut, 'src/commands/export.ts')).runExport;
    if (a.#nativeIngest === 'import' && arm === 'native') {
      const { importFromFile } = await importGbrain<{ importFromFile: ImportFromFile }>(gut, 'src/core/import-file.ts');
      const { readPageBodyPolicy } = await importGbrain<{ readPageBodyPolicy: (engine: unknown) => Promise<unknown> }>(gut, 'src/core/page-body/limits.ts');
      a.#importFile = async (file, rel) => importFromFile(a.#engine, file, rel, { noEmbed: true, sourceId: 'default', bodyPolicy: await readPageBodyPolicy(a.#engine) });
    }
    if (opts.upgrade) {
      const { runOversizedBackfill } = await importGbrain<{ runOversizedBackfill: (engine: unknown) => Promise<unknown> }>(gut, 'src/core/oversized-backfill.ts');
      a.#runBackfill = runOversizedBackfill;
    }
    let engineConfig: Record<string, unknown> = { engine: 'pglite', database_path: opts.dataDir ?? ':memory:' };
    if (opts.pgAdminUrl) {
      const { PostgresEngine } = await importGbrain<{ PostgresEngine: new () => PGLiteEngineType }>(gut, 'src/core/postgres-engine.ts');
      const db = `n14_${process.pid}_${randomUUID().slice(0, 8)}`;
      const admin = new SQL(opts.pgAdminUrl);
      await admin.unsafe(`CREATE DATABASE ${db}`);
      a.#pg = { admin, db };
      const url = new URL(opts.pgAdminUrl);
      url.pathname = `/${db}`;
      engineConfig = { engine: 'postgres', database_url: url.toString() };
      a.#engine = new PostgresEngine();
      await a.#engine.connect({ database_url: url.toString(), poolSize: 10 } as never);
    } else {
      a.#engine = new PGLiteEngine();
      await a.#engine.connect(opts.dataDir ? { database_path: opts.dataDir } : {});
    }
    await a.#engine.initSchema();
    for (const [k, v] of Object.entries({ 'search.cache.enabled': 'false', 'search.reranker.enabled': 'false', 'search.expansion': 'false' })) await a.#engine.setConfig(k, v);
    for (const [k, v] of Object.entries(opts.config ?? {})) await a.#engine.setConfig(k, v);
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    a.#ctx = { engine: a.#engine, config: engineConfig, logger, dryRun: false, remote: false, sourceId: 'default' };
    a.#ops = new Map(operations.map(o => [o.name, o]));
    a.#capability = probeNativeCapability(operations);
    return a;
  }

  get capability(): NativeCapability { return this.#capability; }

  async call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const o = this.#ops.get(name);
    if (!o) throw Object.assign(new Error(`gbrain has no operation ${name}`), { code: 'unknown_operation' });
    const result = await o.handler(this.#ctx, params);
    this.frames.push({ op: name, bytes: frameBytes(result) });
    return result;
  }

  async sql<T = Record<string, unknown>>(q: string, params?: unknown[]): Promise<T[]> {
    return await (this.#engine as unknown as { executeRaw: <R>(q: string, p?: unknown[]) => Promise<R[]> }).executeRaw<T>(q, params);
  }

  async #put(slug: string, content: string): Promise<void> {
    const prev = this.#rev.get(slug);
    const r = await this.#callSettled('put_page', { slug, content, ...(prev ? { expected_revision: prev } : {}) }) as { revision?: string };
    if (r?.revision) this.#rev.set(slug, r.revision);
  }

  /** A write operation; a `write_pending` reply is polled to its final state (Amendment 3). */
  async #callSettled(name: string, params: Record<string, unknown>): Promise<unknown> {
    try { return await this.call(name, params); }
    catch (e) {
      const request = (e as { writeRequest?: { request_id?: string } }).writeRequest;
      if (errCode(e) !== 'write_pending' || !request?.request_id) throw e;
      return await this.#settle(request.request_id);
    }
  }

  #boundMs(): number { return this.#ledger ? settleBoundMs(this.#ledger.bytes) : PENDING_WAIT_MAX_MS; }

  /** Amendment 3: an accepted write that replies `write_pending` is polled with get_write_request, as its contract asks, until it is final. */
  async #settle(requestId: string): Promise<{ revision?: string }> {
    const t0 = performance.now();
    for (;;) {
      const rec = await this.call('get_write_request', { request_id: requestId }) as { state: string; retry_after_ms?: number | null; revision?: string; write_error?: string; write_error_message?: string; write_error_reason?: string; error_detail?: unknown };
      if (['committed', 'conflict', 'failed', 'cancelled'].includes(rec.state)) {
        this.#pending.writes++;
        this.#pending.wait_ms += Math.round(performance.now() - t0);
        if (rec.state !== 'committed') {
          const detail = rec.error_detail == null ? '' : ` detail: ${(typeof rec.error_detail === 'string' ? rec.error_detail : JSON.stringify(rec.error_detail)).slice(0, 300)}`;
          throw Object.assign(new Error(`${rec.write_error_message ?? `write ${rec.state}`}${rec.write_error_reason ? ` (${rec.write_error_reason})` : ''}${detail}`), { code: rec.write_error ?? `write_${rec.state}` });
        }
        return rec;
      }
      if (performance.now() - t0 > this.#boundMs()) {
        this.#pending.writes++;
        this.#pending.wait_ms += Math.round(performance.now() - t0);
        throw Object.assign(new Error(`write ${requestId} still ${rec.state} after ${this.#boundMs()} ms`), { code: 'write_pending' });
      }
      await new Promise(res => setTimeout(res, Math.min(Math.max(rec.retry_after_ms ?? 500, 200), 5_000)));
    }
  }

  #takePending(): PendingWrites | null {
    const p = this.#pending;
    this.#pending = { writes: 0, wait_ms: 0 };
    return p.writes ? p : null;
  }

  async ingest(ledger: N14DocLedger, raw: string): Promise<IngestOutcome> {
    this.#ledger = ledger;
    this.#raw = raw;
    let writeErrors = 0;
    let first: { code: string; message: string } | null = null;
    if (this.#runBackfill) {
      try {
        this.backfill = await this.#runBackfill(this.#engine);
        const failed = (this.backfill as { failed?: Array<{ error: string }> }).failed ?? [];
        if (failed.length) { writeErrors = failed.length; first = { code: 'backfill_failed', message: failed[0].error }; }
      } catch (e) { writeErrors++; first = { code: errCode(e), message: errMsg(e).slice(0, 500) }; }
      return await this.#ingestOutcome(writeErrors, first);
    }
    await this.#put(CONTROL_SLUG, ledger.control.content);
    const attempt = async (slug: string, content: string) => {
      try { await this.#put(slug, content); }
      catch (e) { writeErrors++; first ??= { code: errCode(e), message: errMsg(e).slice(0, 500) }; }
    };
    if (this.arm === 'managed-parts') {
      const split = splitIntoParts(raw, ledger);
      this.#parts = split.parts;
      this.#preamble = split.hub.preamble;
      for (const p of split.parts) await attempt(p.slug, p.content);
      await attempt(ledger.slug, hubContent(ledger, split.hub.preamble, split.parts));
    } else if (this.#importFile) {
      try { await this.#importDoc(raw); } catch (e) { writeErrors++; first ??= { code: errCode(e), message: errMsg(e).slice(0, 500) }; }
    } else if (this.#usesUpload(raw)) {
      try { await this.#upload(ledger.slug, raw, 'create'); } catch (e) { writeErrors++; first ??= { code: errCode(e), message: errMsg(e).slice(0, 500) }; }
    } else {
      await attempt(ledger.slug, raw);
    }
    return await this.#ingestOutcome(writeErrors, first);
  }

  /** `--native-ingest import`: write the document to a file named for its slug and import it with the brain's body policy (streamed above the single-string ceiling when segmented storage is on). */
  async #importDoc(content: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'n14-import-'));
    try {
      const file = join(dir, 'doc.md');
      writeFileSync(file, content);
      const r = await this.#importFile!(file, `${this.#ledger.slug}.md`);
      if (r.status !== 'imported') throw Object.assign(new Error(r.refusal?.message ?? r.error ?? `import ${r.status}`), { code: r.refusal?.code ?? `import_${r.status}` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async #hasSegments(): Promise<boolean> {
    const r = await this.sql<{ t: string | null }>(`SELECT to_regclass('page_body_manifest')::text AS t`);
    return !!r[0]?.t;
  }

  async #storage(): Promise<BodyStorage | null> {
    if (!(await this.#hasSegments())) return null;
    const r = await this.sql<{ body_storage: string; body_bytes: string | null; segment_count: number | null; body_generation: string | null }>(
      `SELECT body_storage, body_bytes, segment_count, body_generation FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [this.#ledger.slug]);
    if (!r[0]) return null;
    const num = (x: string | number | null) => x === null ? null : Number(x);
    return { body_storage: r[0].body_storage, body_bytes: num(r[0].body_bytes), segment_count: num(r[0].segment_count), body_generation: num(r[0].body_generation) };
  }

  async segmentBody(): Promise<{ body: string; regions: string[] } | null> {
    if (this.arm === 'managed-parts' || (await this.#storage())?.body_storage !== 'segmented') return null;
    const rows = await this.sql<{ region: string; body: Uint8Array }>(
      `SELECT m.region, t.body FROM page_body_manifest m JOIN pages p ON p.id = m.page_id JOIN page_segment_texts t ON t.source_id = m.source_id AND t.sha256 = m.sha256
        WHERE p.slug = $1 AND p.deleted_at IS NULL AND m.gen_to IS NULL AND m.staging_id IS NULL ORDER BY CASE m.region WHEN 'truth' THEN 0 ELSE 1 END, m.seq`, [this.#ledger.slug]);
    return { body: Buffer.concat(rows.map(r => Buffer.from(r.body))).toString('utf8'), regions: [...new Set(rows.map(r => r.region))] };
  }

  /** Null for an inline page or no segmented storage; otherwise waits (bounded) until the text projection is sealed at the page's revision. */
  async #settleProjection(): Promise<ProjectionSettle | null> {
    if ((await this.#storage())?.body_storage !== 'segmented') return null;
    const t0 = performance.now();
    const sealedNow = async () => Number((await this.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = $1 AND deleted_at IS NULL AND text_projection_revision = knowledge_revision`, [this.#ledger.slug]))[0]?.n ?? 0) > 0;
    const atReply = await sealedNow();
    let sealed = atReply;
    while (!sealed && performance.now() - t0 < this.#boundMs()) {
      await new Promise(res => setTimeout(res, 250));
      sealed = await sealedNow();
    }
    return { sealed_at_reply: atReply, sealed, settle_ms: Math.round(performance.now() - t0) };
  }

  async #segmentTexts(): Promise<{ n: number; bytes: number }> {
    const r = await this.sql<{ n: number; bytes: string }>(`SELECT count(*)::int AS n, coalesce(sum(byte_len), 0)::bigint AS bytes FROM page_segment_texts`);
    return { n: Number(r[0]?.n ?? 0), bytes: Number(r[0]?.bytes ?? 0) };
  }

  async #ingestOutcome(writeErrors: number, first: { code: string; message: string } | null): Promise<IngestOutcome> {
    const projection = this.arm === 'managed-parts' ? null : await this.#settleProjection();
    const docPages = await this.sql<{ n: number; chunks: number; skip: string | null }>(
      `SELECT count(*)::int AS n, coalesce(sum((SELECT count(*) FROM content_chunks c WHERE c.page_id = p.id)), 0)::int AS chunks,
              max(p.frontmatter->'embed_skip'->>'reason') AS skip
         FROM pages p WHERE p.deleted_at IS NULL AND p.slug <> $1`, [CONTROL_SLUG]);
    const pages = Number(docPages[0]?.n ?? 0);
    const status: IngestOutcome['status'] = pages > 0 && writeErrors === 0 ? 'stored' : first && /too_large|file_too_large|oversized|request_too_large/.test(first.code + first.message) ? 'refused' : pages > 0 ? 'stored' : 'error';
    return { status, ...(first ? { code: first.code, message: first.message } : {}), pages, chunks: Number(docPages[0]?.chunks ?? 0), embed_skip: docPages[0]?.skip ?? null, write_errors: writeErrors, storage: this.arm === 'managed-parts' ? null : await this.#storage(), pending: this.#takePending(), projection };
  }

  /** Amendment 5: the native arm writes a document over 4 MiB through an upload session when gbrain has one. */
  #usesUpload(content: string): boolean {
    return this.arm === 'native' && this.#capability.upload_session && Buffer.byteLength(content) > UPLOAD_ABOVE_BYTES;
  }

  /** An upload session: parts cut on code points so each call's encoded frame fits the session's part_max_frame_bytes. */
  async #upload(slug: string, raw: string, mode: 'create' | 'replace'): Promise<void> {
    const buf = Buffer.from(raw);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const expected = mode === 'replace' ? (await this.call('get_page', { slug, body: 'none' }) as { revision?: string }).revision : undefined;
    const begun = await this.call('begin_page_upload', { slug, mode, total_bytes: buf.length, sha256: sha(buf), request_id: randomUUID(), ...(expected ? { expected_revision: expected } : {}) }) as { upload_id: string; part_max_frame_bytes: number };
    const parts = cutUploadParts(buf, begun.upload_id, begun.part_max_frame_bytes);
    for (const [part, slice] of parts.entries()) await this.call('upload_page_part', { upload_id: begun.upload_id, part, text: slice.toString('utf8'), part_sha256: sha(slice) });
    const r = await this.#callSettled('commit_page_upload', { upload_id: begun.upload_id }) as { revision?: string };
    if (r?.revision) this.#rev.set(slug, r.revision);
  }

  async storedContains(answer: string): Promise<boolean> {
    const r = await this.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug <> $2 AND strpos(compiled_truth, $1) > 0`, [answer, CONTROL_SLUG]);
    if (Number(r[0]?.n ?? 0) > 0 || !(await this.#hasSegments())) return Number(r[0]?.n ?? 0) > 0;
    const seg = await this.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM page_body_manifest m JOIN pages p ON p.id = m.page_id JOIN page_segment_texts t ON t.source_id = m.source_id AND t.sha256 = m.sha256
        WHERE p.deleted_at IS NULL AND p.slug <> $2 AND m.gen_to IS NULL AND m.staging_id IS NULL AND position(convert_to($1, 'UTF8') IN t.body) > 0`, [answer, CONTROL_SLUG]);
    return Number(seg[0]?.n ?? 0) > 0;
  }

  async search(query: string): Promise<SearchHit[]> {
    const rows = await this.call('search', { query, limit: TOP_K }) as Array<{ slug: string; chunk_id?: number | null; chunk_text?: string }>;
    const ids = rows.map(r => r.chunk_id).filter((x): x is number => typeof x === 'number');
    const stored = new Map((ids.length ? await this.sql<{ id: number; chunk_text: string }>(`SELECT id, chunk_text FROM content_chunks WHERE id = ANY($1::int[])`, [ids]) : []).map(r => [Number(r.id), r.chunk_text]));
    return rows.slice(0, TOP_K).map(r => ({ slug: r.slug, chunk_id: typeof r.chunk_id === 'number' ? r.chunk_id : null, passage: typeof r.chunk_id === 'number' ? stored.get(r.chunk_id) ?? '' : '', delivered: r.chunk_text ?? '' }));
  }

  async read(hit: SearchHit): Promise<string> {
    const params: Record<string, unknown> = this.arm === 'native' ? { slug: hit.slug, body: 'window', ...(hit.chunk_id !== null ? { around_chunk_id: hit.chunk_id } : {}) } : { slug: hit.slug };
    return JSON.stringify(await this.call('get_page', params));
  }

  async directRead(): Promise<string> {
    return JSON.stringify(await this.call('get_page', { slug: this.#ledger.slug }));
  }

  async agentDirectReadBytes(): Promise<number> {
    return frameBytes(await this.#ops.get('get_page')!.handler({ ...this.#ctx, remote: true }, { slug: this.#ledger.slug }));
  }

  async #ensureGateway(): Promise<void> {
    if (this.#gatewayReady) return;
    if (this.#embedder.kind === 'counting') {
      // The brain's own configured model and dimensions (voyage:voyage-4, 1024 at the pin), so the counted batches are the ones gbrain plans.
      const cfg = new Map((await this.sql<{ key: string; value: string }>(`SELECT key, value FROM config WHERE key IN ('embedding_model', 'embedding_dimensions')`)).map(r => [r.key, r.value]));
      const model = cfg.get('embedding_model') ?? 'voyage:voyage-4';
      const dims = Number(cfg.get('embedding_dimensions') ?? 1024);
      const provider = model.split(':')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_');
      this.#countingModel = { embedding_model: model, embedding_dimensions: dims };
      this.#gw.configureGateway({ ...this.#countingModel, env: { [`${provider}_API_KEY`]: 'n14-counting-embedder-no-network' } });
      this.#gw.__setEmbedTransportForTests(async (p: { values: string[] }) => {
        this.#embedCount.inputs += p.values.length;
        for (const v of p.values) this.#embedCount.tokens += estTokens(v);
        return { embeddings: p.values.map(v => countingVector(v, dims)), values: p.values, warnings: [], usage: { tokens: 0 } };
      });
    } else if (this.#embedder.kind === 'real') {
      this.#gw.configureGateway({ embedding_model: this.#embedder.model, embedding_dimensions: this.#embedder.dims, env: this.#embedder.env });
      this.#gw.__setEmbedTransportForTests(null);
    }
    this.#gatewayReady = true;
  }

  async embedPass(): Promise<EmbedCount | null> {
    if (this.#embedder.kind === 'none') return null;
    await this.#ensureGateway();
    const before = { ...this.#embedCount };
    try {
      await this.#runEmbedCore(this.#engine, { stale: true, catchUp: true });
    } finally {
      if (this.#embedder.kind === 'counting') {
        // Back to keyless, so later searches take the same keyword path as the needle probes instead of hybrid over hash vectors.
        this.#gw.configureGateway({ ...this.#countingModel, env: {} });
        this.#gw.__setEmbedTransportForTests(null);
        this.#gatewayReady = false;
      }
    }
    return { inputs: this.#embedCount.inputs - before.inputs, tokens: this.#embedCount.tokens - before.tokens };
  }

  async #chunkSnapshot(): Promise<Map<number, string>> {
    const rows = await this.sql<{ id: number; h: string }>(`SELECT c.id, md5(c.chunk_text) AS h FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.deleted_at IS NULL AND p.slug <> $1`, [CONTROL_SLUG]);
    return new Map(rows.map(r => [Number(r.id), r.h]));
  }

  async append(text: string): Promise<AppendOutcome> {
    this.#takePending();
    const before = await this.#chunkSnapshot();
    const storageBefore = this.arm === 'managed-parts' ? null : await this.#storage();
    const textsBefore = storageBefore ? await this.#segmentTexts() : null;
    let path = 'put_page (whole page rewrite)';
    let failure: { status: 'refused' | 'error'; code: string; message: string } | null = null;
    try {
      if (this.arm === 'managed-parts') {
        path = 'put_page new part + hub index update';
        const part = partFor(this.#ledger, text, this.#ledger.kind === 'conversation' ? 'imessage-daily' : 'note');
        this.#parts.push(part);
        await this.#put(part.slug, part.content);
        await this.#put(this.#ledger.slug, hubContent(this.#ledger, this.#preamble, this.#parts));
      } else if (this.arm === 'native' && this.#capability.append_page) {
        path = 'append_page';
        const stored = this.#raw.trimEnd();
        const r = await this.#callSettled('append_page', { slug: this.#ledger.slug, text: this.#raw.slice(stored.length) + text, separator: 'none', request_id: randomUUID(),
          ...(this.#rev.get(this.#ledger.slug) ? { expected_revision: this.#rev.get(this.#ledger.slug) } : {}) }) as { revision?: string };
        if (r?.revision) this.#rev.set(this.#ledger.slug, r.revision);
      } else if (this.#importFile) {
        path = 'importFromFile re-import of the whole file (segment-aware)';
        await this.#importDoc(this.#raw + text);
      } else {
        await this.#put(this.#ledger.slug, this.#raw + text);
      }
    } catch (e) {
      const code = errCode(e);
      const message = errMsg(e).slice(0, 500);
      failure = { status: /too_large|oversized/.test(code + message) ? 'refused' : 'error', code, message };
    }
    const projection = storageBefore && !failure ? await this.#settleProjection() : null;
    const after = await this.#chunkSnapshot();
    let rewritten = 0;
    for (const [id, h] of after) if (before.get(id) !== h) rewritten++;
    let deleted = 0;
    for (const id of before.keys()) if (!after.has(id)) deleted++;
    let segments: SegmentWrites | null = null;
    const storageAfter = storageBefore ? await this.#storage() : null;
    if (textsBefore && storageAfter && (storageBefore?.body_storage === 'segmented' || storageAfter.body_storage === 'segmented')) {
      const textsAfter = await this.#segmentTexts();
      const live = await this.sql<{ n: number; at_new: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE m.gen_from = p.body_generation)::int AS at_new FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
          WHERE p.slug = $1 AND p.deleted_at IS NULL AND m.gen_to IS NULL AND m.staging_id IS NULL`, [this.#ledger.slug]);
      segments = { generation_before: storageBefore?.body_generation ?? null, generation_after: storageAfter.body_generation, live_segments: Number(live[0]?.n ?? 0),
        segments_at_new_generation: Number(live[0]?.at_new ?? 0), segment_texts_added: textsAfter.n - textsBefore.n, segment_text_bytes_added: textsAfter.bytes - textsBefore.bytes };
    }
    return { status: failure ? failure.status : 'ok', ...(failure ? { code: failure.code, message: failure.message } : {}), chunks_before: before.size, chunks_after: after.size, chunks_rewritten: rewritten, chunks_deleted: deleted, path, ...(storageBefore ? { segments } : {}), pending: this.#takePending(), ...(projection ? { projection } : {}) };
  }

  async exportBody(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'n14-export-'));
    const out = join(dir, 'out');
    const realExit = process.exit;
    const realLog = console.log;
    const realError = console.error;
    let stderr = '';
    try {
      process.exit = ((code?: number) => { throw Object.assign(new Error(`export exited with code ${code ?? 0}${stderr ? `: ${stderr.split('\n')[0]}` : ''}`), { code: 'export_failed' }); }) as typeof process.exit;
      console.log = () => {};
      console.error = (...args: unknown[]) => { stderr += `${args.map(String).join(' ')}\n`; };
      await this.#runExport(this.#engine, ['--dir', out, '--slug-prefix', this.#ledger.slug]);
    } finally {
      process.exit = realExit;
      console.log = realLog;
      console.error = realError;
    }
    try {
      const read = (slug: string) => readFileSync(join(out, `${slug}.md`), 'utf8');
      if (this.arm !== 'managed-parts') return exportedBody(read(this.#ledger.slug));
      const hub = exportedBody(read(this.#ledger.slug));
      const at = hub.indexOf(PARTS_MARKER);
      const preamble = at >= 0 ? hub.slice(0, at) : hub;
      const partDir = join(out, this.#ledger.slug);
      const keys = existsSync(partDir) ? readdirSync(partDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort() : [];
      // Sections are separated by exactly one blank line in the source, so trimmed parts rejoin with one.
      return [preamble, ...keys.map(k => exportedBody(read(`${this.#ledger.slug}/${k}`)))].map(x => x.trim()).join('\n\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async lifecycle(body: string): Promise<LifecycleOutcome | null> {
    if (this.arm === 'managed-parts') return null;
    if (body.includes(LIFECYCLE_TOKEN)) throw Object.assign(new Error(`the document already holds ${LIFECYCLE_TOKEN}`), { code: 'harness' });
    const slug = this.#ledger.slug;
    const probes = Array.from({ length: DECILES }, (_, d) => this.#ledger.needles.find(n => n.decile === d)).filter((n): n is Needle => !!n);
    const hits = async () => {
      let n = 0;
      for (const p of probes) if (hitRank((await this.search(p.query)).map(h => h.passage), p.answer) !== null) n++;
      return n;
    };
    const revision = async (includeDeleted = false) => (await this.call('get_page', { slug, body: 'none', ...(includeDeleted ? { include_deleted: true } : {}) }) as { revision?: string }).revision;
    const count = async (q: string, params: unknown[]) => Number((await this.sql<{ n: number }>(q, params))[0]?.n ?? 0);
    const fail = (e: unknown) => `${errCode(e)}: ${errMsg(e).slice(0, 300)}`;
    const out: LifecycleOutcome = {
      probes: probes.length, hits_before: await hits(),
      forget: { status: 'ok', fact_rows: 0, withdrawn: null, recall_hits_after: null, export_row: null, wall_ms: 0 },
      delete: { status: 'ok', hits_after: null, get_page_code: null, wall_ms: 0 },
      restore: { status: 'ok', hits_after: null, export_matches_pre_delete: null, wall_ms: 0 },
      purge: { status: 'ok', wall_ms: 0, residue: null, sweep: null },
    };

    let t0 = performance.now();
    let preDelete: string | null = null;
    try {
      const withFence = body + lifecycleFence();
      if (this.#importFile) await this.#importDoc(withFence);
      else if (this.#usesUpload(withFence)) await this.#upload(slug, withFence, 'replace');
      else await this.#put(slug, withFence);
      await this.#settleProjection();
      const rows = await this.sql<{ id: number }>(`SELECT id FROM facts WHERE strpos(fact, $1) > 0 ORDER BY id`, [LIFECYCLE_TOKEN]);
      out.forget.fact_rows = rows.length;
      if (!rows.length) throw Object.assign(new Error('the facts fence produced no fact row'), { code: 'no_fact_row' });
      const id = Number(rows[0].id);
      await this.#callSettled('forget_fact', { id, reason: 'n14 lifecycle' });
      out.forget.withdrawn = await count(`SELECT count(*)::int AS n FROM facts WHERE id = $1 AND expired_at IS NULL`, [id]) === 0;
      const recall = await this.call('recall', { query: LIFECYCLE_TOKEN }) as { facts?: unknown[] };
      out.forget.recall_hits_after = (recall.facts ?? []).filter(f => JSON.stringify(f).includes(LIFECYCLE_TOKEN)).length;
      preDelete = await this.exportBody();
      const line = preDelete.split('\n').find(l => l.includes(LIFECYCLE_TOKEN));
      out.forget.export_row = !line ? 'absent' : line.includes(`~~${LIFECYCLE_CLAIM}~~`) ? 'struck' : 'active';
    } catch (e) { out.forget.status = 'error'; out.forget.error = fail(e); }
    out.forget.wall_ms = Math.round(performance.now() - t0);
    preDelete ??= await this.exportBody().catch(() => null);

    t0 = performance.now();
    try {
      await this.#callSettled('delete_page', { slug, expected_revision: await revision() });
      out.delete.hits_after = await hits();
      try { await this.call('get_page', { slug, body: 'none' }); out.delete.get_page_code = 'returned'; }
      catch (e) { out.delete.get_page_code = errCode(e); }
    } catch (e) { out.delete.status = 'error'; out.delete.error = fail(e); }
    out.delete.wall_ms = Math.round(performance.now() - t0);

    t0 = performance.now();
    try {
      await this.#callSettled('restore_page', { slug, expected_revision: await revision(true) });
      await this.#settleProjection();
      out.restore.hits_after = await hits();
      const after = await this.exportBody();
      out.restore.export_matches_pre_delete = preDelete === null ? null : sha256(canonicalBody(after)) === sha256(canonicalBody(preDelete));
    } catch (e) { out.restore.status = 'error'; out.restore.error = fail(e); }
    out.restore.wall_ms = Math.round(performance.now() - t0);

    t0 = performance.now();
    try {
      const pageId = Number((await this.sql<{ id: number }>(`SELECT id FROM pages WHERE slug = $1`, [slug]))[0]?.id ?? -1);
      const r = await this.#callSettled('delete_page', { slug, expected_revision: await revision(), purge: true }) as { purge?: { removed?: Record<string, unknown> } };
      out.purge.removed = Object.fromEntries(Object.entries(r?.purge?.removed ?? {}).filter((x): x is [string, number] => typeof x[1] === 'number' && x[1] > 0));
      const answers = [...this.#ledger.needles.map(n => n.answer), this.#ledger.append.needle.answer, LIFECYCLE_TOKEN];
      const segments = await this.#hasSegments();
      const needleTexts = async () => {
        if (!segments) return 0;
        let n = 0;
        for (const a of answers) if (await count(`SELECT count(*)::int AS n FROM page_segment_texts WHERE position(convert_to($1, 'UTF8') IN body) > 0`, [a]) > 0) n++;
        return n;
      };
      let needleChunks = 0;
      for (const a of answers) if (await count(`SELECT count(*)::int AS n FROM content_chunks WHERE strpos(chunk_text, $1) > 0`, [a]) > 0) needleChunks++;
      const unref = segments ? (await this.sql<{ n: number; bytes: string }>(`SELECT count(*)::int AS n, coalesce(sum(byte_len), 0)::bigint AS bytes FROM page_segment_texts t
        WHERE NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id = t.source_id AND m.sha256 = t.sha256)`))[0] : null;
      out.purge.residue = {
        pages: await count(`SELECT count(*)::int AS n FROM pages WHERE id = $1 OR slug = $2`, [pageId, slug]),
        chunks: await count(`SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1`, [pageId]),
        manifest_rows: segments ? await count(`SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id = $1`, [pageId]) : 0,
        versions: await count(`SELECT count(*)::int AS n FROM page_versions WHERE page_id = $1`, [pageId]),
        facts: await count(`SELECT count(*)::int AS n FROM facts WHERE strpos(fact, $1) > 0`, [LIFECYCLE_TOKEN]),
        needle_chunks: needleChunks,
        needle_texts: await needleTexts(),
        unreferenced_texts: Number(unref?.n ?? 0),
        unreferenced_text_bytes: Number(unref?.bytes ?? 0),
      };
      if (segments) {
        const swept = await (this.#engine as unknown as { sweepSegments: (o: Record<string, unknown>) => Promise<{ textsDeleted: number }> }).sweepSegments({ graceMs: 0 });
        out.purge.sweep = { texts_deleted: swept.textsDeleted, needle_texts_after: await needleTexts(), texts_left: await count(`SELECT count(*)::int AS n FROM page_segment_texts`, []) };
      }
    } catch (e) { out.purge.status = 'error'; out.purge.error = fail(e); }
    out.purge.wall_ms = Math.round(performance.now() - t0);
    return out;
  }

  /** Paid arm helpers: hybrid query and vector-only search, hits mapped to stored chunks. */
  async hybrid(query: string): Promise<SearchHit[]> {
    const rows = await this.call('query', { query, limit: TOP_K, expand: false, autocut: false, adaptive_return: false }) as Array<{ slug: string; chunk_id?: number | null; chunk_text?: string }>;
    return await this.#mapRows(rows);
  }

  async vector(query: string): Promise<SearchHit[]> {
    if (!this.#gw.embedQuery) throw new Error('gateway has no embedQuery');
    const vec = await this.#gw.embedQuery(query);
    const rows = await (this.#engine as unknown as { searchVector: (v: Float32Array, o: Record<string, unknown>) => Promise<Array<{ slug: string; chunk_id?: number; chunk_text?: string }>> }).searchVector(vec, { limit: TOP_K });
    return await this.#mapRows(rows);
  }

  async #mapRows(rows: Array<{ slug: string; chunk_id?: number | null; chunk_text?: string }>): Promise<SearchHit[]> {
    const ids = rows.map(r => r.chunk_id).filter((x): x is number => typeof x === 'number');
    const stored = new Map((ids.length ? await this.sql<{ id: number; chunk_text: string }>(`SELECT id, chunk_text FROM content_chunks WHERE id = ANY($1::int[])`, [ids]) : []).map(r => [Number(r.id), r.chunk_text]));
    return rows.slice(0, TOP_K).map(r => ({ slug: r.slug, chunk_id: typeof r.chunk_id === 'number' ? r.chunk_id : null, passage: typeof r.chunk_id === 'number' ? stored.get(r.chunk_id) ?? '' : '', delivered: r.chunk_text ?? '' }));
  }

  get gateway(): GatewayModule { return this.#gw; }

  async close(): Promise<void> {
    try { this.#gw.__setEmbedTransportForTests(null); } catch { /* best effort */ }
    await this.#engine.disconnect().catch(() => {});
    if (this.#pg) {
      await this.#pg.admin.unsafe(`DROP DATABASE IF EXISTS ${this.#pg.db} WITH (FORCE)`).catch(() => {});
      await this.#pg.admin.close().catch(() => {});
    }
  }
}

/** A deterministic unit vector per text for the counting embedder (a harness control, never a quality signal). */
function countingVector(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0);
  const h = createHash('sha256').update(text).digest();
  for (let i = 0; i < 16; i++) v[h[i] % dims] += (h[i + 16] / 255) - 0.5;
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

// ─── Child process ───────────────────────────────────────────────────────

/** `phase` (Amendment 1 upgrade path): `seed` writes the document single-page into the file-backed brain at `dataDir`; `upgrade` opens it, backfills and probes. */
interface ChildSpec { root: string; arm: Arm; docPath: string; ledgerPath: string; outPath: string; embed: boolean; dataDir?: string; phase?: 'seed' | 'upgrade'; config?: Record<string, string>; nativeIngest?: NativeIngest; pgAdminUrl?: string; lifecycle?: boolean }
interface ChildResult { ok: true; run: ArmRun; capability: NativeCapability; backfill?: unknown }
interface SeedResult { ok: true; seed: IngestOutcome }

function memMark(t0: number): (phase: string) => MemMark {
  return (phase: string) => ({ phase, t_ms: Math.round(performance.now() - t0), rss_mb: Math.round(process.memoryUsage().rss / 1048576), max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) });
}

async function childMain(specPath: string): Promise<void> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ChildSpec;
  await withHermeticEnv('n14-child', async () => {
    const ledger = JSON.parse(readFileSync(spec.ledgerPath, 'utf8')) as N14DocLedger;
    const adapter = await GbrainAdapter.open(spec.root, spec.arm, spec.embed ? { kind: 'counting' } : { kind: 'none' }, { dataDir: spec.dataDir, upgrade: spec.phase === 'upgrade', config: spec.config, nativeIngest: spec.nativeIngest, pgAdminUrl: spec.pgAdminUrl });
    try {
      const raw = readFileSync(spec.docPath, 'utf8');
      if (spec.phase === 'seed') {
        const seed: SeedResult = { ok: true, seed: await adapter.ingest(ledger, raw) };
        writeFileSync(spec.outPath, JSON.stringify(seed));
        return;
      }
      const t0 = performance.now();
      const run = await evaluateArm(adapter, ledger, raw, { embed: spec.embed, lifecycle: spec.lifecycle, probeMemory: memMark(t0) });
      const result: ChildResult = { ok: true, run, capability: adapter.capability, ...(adapter.backfill ? { backfill: adapter.backfill } : {}) };
      writeFileSync(spec.outPath, JSON.stringify(result));
    } finally {
      await adapter.close();
    }
  });
}

interface ChildOutcome { result: ChildResult | null; crash: string | null; rss_peak_mb: number; wall_ms: number; tail: string }

function readRssMb(pid: number): number {
  try { const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(Number(m[1]) / 1024) : 0; }
  catch { return 0; }
}

async function runChild(spec: ChildSpec, rssLimitMb: number, timeoutMs: number): Promise<ChildOutcome> {
  const specPath = spec.outPath.replace(/\.json$/, '.spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  const started = performance.now();
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [import.meta.path, '--child', specPath], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let tail = '';
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let peak = 0;
    let killed: string | null = null;
    const watch = setInterval(() => {
      const rss = readRssMb(child.pid ?? 0);
      peak = Math.max(peak, rss);
      if (rss > rssLimitMb && !killed) { killed = `rss_limit: RSS ${rss} MB passed the ${rssLimitMb} MB ceiling`; child.kill('SIGKILL'); }
    }, 100);
    const timer = setTimeout(() => { if (!killed) { killed = `timeout after ${timeoutMs} ms`; child.kill('SIGKILL'); } }, timeoutMs);
    child.on('close', (code, signal) => {
      clearInterval(watch);
      clearTimeout(timer);
      const wall = Math.round(performance.now() - started);
      let result: ChildResult | null = null;
      if (!killed && code === 0 && existsSync(spec.outPath)) {
        try { result = JSON.parse(readFileSync(spec.outPath, 'utf8')) as ChildResult; } catch { result = null; }
      }
      const crash = result ? null : killed ?? `exit ${code ?? 'null'}${signal ? ` signal ${signal}` : ''} without a result`;
      resolve({ result, crash, rss_peak_mb: peak, wall_ms: wall, tail });
    });
  });
}

// ─── Run ─────────────────────────────────────────────────────────────────

/** One upgrade-path row (Amendment 1, exploratory): seeded by the older gbrain, backfilled and probed by the gbrain under test. */
export interface UpgradeRow {
  tier: TierId; doc: string;
  seed: IngestOutcome | null; seed_crash: string | null;
  backfill: unknown; marker_removed: boolean | null;
  summary: ArmSummary | null; crash: string | null; wall_ms: number; rss_peak_mb: number;
}

export interface TierRun { tier: TierId; docs: N14DocLedger[]; presence: PresenceCheck[]; arms: ArmSummary[]; upgrade?: UpgradeRow[]; children: Array<{ tier: TierId; doc: string; arm: Arm; wall_ms: number; rss_peak_mb: number; crash: string | null; control: ArmRun['control'] | null; tail?: string }> }

export interface N14RunResult {
  tiers: TierRun[];
  capability: NativeCapability;
  summary: N14Summary | null;
  verdict: ReturnType<typeof n14Verdict> | null;
  acc: ProbeAccounting;
  harnessError: string | null;
  ledgerSha256: string;
  runs: Array<{ tier: TierId; run: ArmRun }>;
}

export interface N14Options { gut: GbrainUnderTest; upgradeFrom?: GbrainUnderTest; tiers: TierId[]; arms: Arm[]; docs?: DocKind[]; seed: number; concurrency: number; rssLimitMb: number; workDir?: string; log?: (s: string) => void; config?: Record<string, string>; nativeIngest?: NativeIngest; pgAdminUrl?: string; lifecycle?: boolean }

/** Tiers whose children run the counting embedder (the append re-embed cost); Amendment 4 adds 24mib. */
export const EMBED_PASS_TIERS = ['2mb', '20mb', '24mib'] as const;

async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

export async function runN14(opts: N14Options): Promise<N14RunResult> {
  return withHermeticEnv('n14', () => runN14Hermetic(opts));
}

async function runN14Hermetic(opts: N14Options): Promise<N14RunResult> {
  const log = opts.log ?? (() => {});
  const { operations } = await importGbrain<OperationsModule>(opts.gut, 'src/core/operations.ts');
  const capability = probeNativeCapability(operations);
  log(`native capability: ${capability.present ? 'present' : 'absent'} (${capability.evidence})`);
  const work = opts.workDir ?? mkdtempSync(join(tmpdir(), 'n14-work-'));
  mkdirSync(work, { recursive: true });
  const tiers: TierRun[] = [];
  const runs: N14RunResult['runs'] = [];
  const allLedgers: N14DocLedger[] = [];
  let presenceFailures = 0;
  let harnessError: string | null = null;
  const specsFor = (t: TierId) => tierSpecs(t, opts.seed).filter(x => !opts.docs || opts.docs.includes(x.kind));
  const plannedProbes = opts.tiers.reduce((n, t) => n + specsFor(t).length * DECILES * NEEDLE_TYPES.length * opts.arms.length, 0);
  const acc = new ProbeAccounting(plannedProbes);
  try {
    for (const tier of opts.tiers) {
      const dir = join(work, tier);
      mkdirSync(dir, { recursive: true });
      const docs: Array<{ ledger: N14DocLedger; docPath: string; ledgerPath: string }> = [];
      for (const spec of specsFor(tier)) {
        const docPath = join(dir, `${spec.kind}.md`);
        const ledger = writeDocument(spec, docPath);
        const ledgerPath = join(dir, `${spec.kind}.ledger.json`);
        writeFileSync(ledgerPath, JSON.stringify(ledger));
        docs.push({ ledger, docPath, ledgerPath });
        allLedgers.push(ledger);
        log(`[${tier}] generated ${spec.kind}: ${(ledger.bytes / 1e6).toFixed(1)} MB, ${ledger.lines} lines, ${ledger.sections.length} sections`);
      }
      const presence = docs.flatMap(d => checkPresence(readFileSync(d.docPath), d.ledger));
      const failed = presence.filter(p => !p.ok);
      presenceFailures += failed.length;
      const tierRun: TierRun = { tier, docs: docs.map(d => d.ledger), presence, arms: [], children: [] };
      tiers.push(tierRun);
      if (failed.length) {
        harnessError = `presence assertions failed: ${failed.map(f => `${f.name} (expected ${f.expected}, got ${f.actual})`).join('; ')}`;
        acc.error(`presence:${tier}`, 'harness', harnessError);
        break;
      }
      const jobs = docs.flatMap(d => opts.arms.map(arm => ({ d, arm })));
      for (const { d } of jobs.filter(j => j.arm === 'native' && !capability.present)) tierRun.arms.push(absentSummary(d.ledger, tier));
      const runnable = jobs.filter(j => j.arm !== 'native' || capability.present);
      const embed = (EMBED_PASS_TIERS as readonly string[]).includes(tier);
      const timeoutMs = Math.max(300_000, Math.round(Math.max(...docs.map(x => x.ledger.bytes)) / 1e6 * 20_000));
      const outcomes = await pool(runnable, opts.concurrency, async ({ d, arm }) => {
        log(`[${tier}] ${d.ledger.id} / ${arm}: start`);
        const o = await runChild({ root: opts.gut.root, arm, docPath: d.docPath, ledgerPath: d.ledgerPath, outPath: join(dir, `${d.ledger.id}.${arm}.result.json`), embed, config: opts.config, nativeIngest: opts.nativeIngest, pgAdminUrl: opts.pgAdminUrl, lifecycle: opts.lifecycle }, opts.rssLimitMb, timeoutMs);
        log(`[${tier}] ${d.ledger.id} / ${arm}: ${o.crash ? `CRASH ${o.crash}` : 'done'} in ${(o.wall_ms / 1000).toFixed(1)} s, peak RSS ${o.rss_peak_mb} MB`);
        return { d, arm, o };
      });
      for (const { d, arm, o } of outcomes) {
        tierRun.children.push({ tier, doc: d.ledger.id, arm, wall_ms: o.wall_ms, rss_peak_mb: o.rss_peak_mb, crash: o.crash, control: o.result?.run.control ?? null, ...(o.crash ? { tail: o.tail } : {}) });
        if (!o.result) {
          tierRun.arms.push(crashedSummary(arm, d.ledger, tier, o.crash ?? 'unknown', o.rss_peak_mb));
          for (const n of d.ledger.needles) acc.error(`${tier}:${arm}:${n.id}`, 'sut', `child crashed: ${o.crash}`);
          continue;
        }
        const run = o.result.run;
        runs.push({ tier, run });
        tierRun.arms.push(summarizeArm(run, tier));
        if (run.control.hits < run.control.total) {
          presenceFailures++;
          const msg = `control page not found in ${tier}/${d.ledger.id}/${arm}: ${run.control.missed.join(', ')}`;
          acc.error(`control:${tier}:${d.ledger.id}:${arm}`, 'harness', msg);
          harnessError ??= `solvability control failed: ${msg}`;
        }
        for (const p of run.probes) {
          if (p.error) acc.error(`${tier}:${arm}:${p.id}`, 'sut', p.error);
          else acc.score(`${tier}:${arm}:${p.id}`, p.hit_rank !== null ? 1 : 0);
        }
      }
      if (opts.upgradeFrom && tier === '2mb') {
        const from = opts.upgradeFrom;
        tierRun.upgrade = await pool(docs, opts.concurrency, async d => {
          const dataDir = join(dir, `${d.ledger.id}.upgrade-brain`);
          log(`[${tier}] ${d.ledger.id} / upgrade: seeding with gbrain ${from.version}`);
          const s = await runChild({ root: from.root, arm: 'single-page', docPath: d.docPath, ledgerPath: d.ledgerPath, outPath: join(dir, `${d.ledger.id}.upgrade-seed.json`), embed: false, dataDir, phase: 'seed' }, opts.rssLimitMb, timeoutMs);
          const seed = (s.result as unknown as SeedResult | null)?.seed ?? null;
          const row: UpgradeRow = { tier, doc: d.ledger.id, seed, seed_crash: s.crash, backfill: null, marker_removed: null, summary: null, crash: null, wall_ms: s.wall_ms, rss_peak_mb: s.rss_peak_mb };
          if (!seed) return row;
          const u = await runChild({ root: opts.gut.root, arm: 'native', docPath: d.docPath, ledgerPath: d.ledgerPath, outPath: join(dir, `${d.ledger.id}.upgrade.result.json`), embed: false, dataDir, phase: 'upgrade' }, opts.rssLimitMb, timeoutMs);
          log(`[${tier}] ${d.ledger.id} / upgrade: ${u.crash ? `CRASH ${u.crash}` : 'done'} in ${(u.wall_ms / 1000).toFixed(1)} s, peak RSS ${u.rss_peak_mb} MB`);
          row.crash = u.crash;
          row.wall_ms += u.wall_ms;
          row.rss_peak_mb = Math.max(row.rss_peak_mb, u.rss_peak_mb);
          if (u.result) {
            row.backfill = u.result.backfill ?? null;
            row.summary = summarizeArm(u.result.run, tier);
            row.marker_removed = u.result.run.ingest.embed_skip === null;
          }
          return row;
        });
      }
    }
  } catch (e) {
    harnessError = `harness: ${errMsg(e)}`;
    acc.error('run', 'harness', harnessError);
  } finally {
    if (!opts.workDir) rmSync(work, { recursive: true, force: true });
  }
  const arms = tiers.flatMap(t => t.arms);
  const summary = harnessError ? null : summarize(arms, presenceFailures, capability);
  return { tiers, capability, summary, verdict: summary ? n14Verdict(summary) : null, acc, harnessError, ledgerSha256: ledgerFingerprint(allLedgers), runs };
}

// ─── gbrain findings ─────────────────────────────────────────────────────

export function n14Findings(r: N14RunResult, gut: GbrainUnderTest): BugEntry[] {
  const sha = gut.overlay?.build.commit ?? productIdentity('gbrain').declared_sha;
  if (!sha || !r.summary) return [];
  const at = gut.overlay ? `--gbrain <gbrain checkout>@${sha}` : '';
  const repro = (tier: TierId, arms: string) => `bun eval/runner/n14-large-page-fidelity.ts --tier ${tier} --arms ${arms} ${at}`.trim();
  const out: BugEntry[] = [];
  const single = r.summary.arms.filter(a => a.arm === 'single-page' && a.status === 'ran');
  const skipped = single.find(a => a.ingest.status === 'stored' && a.ingest.chunks === 0);
  if (skipped) {
    out.push({
      id: 'N14-1', category: 'large-page-fidelity', classification: 'feature-gap', status: 'open', gbrain_sha: sha,
      contract: 'gbrain does not claim search over pages above content_sanity.bytes_block (500 KB default, src/core/content-sanity.ts DEFAULT_BYTES_BLOCK); such a page lands with frontmatter embed_skip and is never chunked',
      surface: 'put_page -> content sanity (embed_skip, PAGE_OVERSIZED)',
      repro: repro(skipped.tier, 'single-page'),
      expected: 'a stored page is keyword-searchable: a query for a planted needle returns the chunk that holds it',
      actual: `the ${(skipped.doc)} document (${skipped.tier}) is stored with embed_skip=${skipped.ingest.embed_skip} and ${skipped.ingest.chunks} chunks; keyword needle recall@10 ${skipped.keyword_recall.hits}/${skipped.keyword_recall.total} while every needle is in the stored body (${skipped.stored_needles.hits}/${skipped.stored_needles.total})`,
    });
  }
  const refused = single.find(a => a.ingest.status === 'refused');
  if (refused) {
    out.push({
      id: 'N14-2', category: 'large-page-fidelity', classification: 'feature-gap', status: 'open', gbrain_sha: sha,
      contract: 'gbrain documents a per-page write limit (MAX_FILE_SIZE 5 MB in src/core/import-screen.ts before v0.60.242.0; the 24 MiB page ceiling from v0.60.242.0; request_too_large in src/core/error-registry.ts) and tells the user to split the file',
      surface: 'put_page -> persistence preparation (request_too_large)',
      repro: repro(refused.tier, 'single-page'),
      expected: 'one large document can be written as one page',
      actual: `put_page of the ${refused.tier} ${refused.doc} refused with ${refused.ingest.code}; keyword recall ${refused.keyword_recall.hits}/${refused.keyword_recall.total}`,
    });
  }
  const capacity = single.find(a => a.ingest.code === 'queue_capacity');
  if (capacity) {
    out.push({
      id: 'N14-4', category: 'large-page-fidelity', classification: 'bug', status: 'open', gbrain_sha: sha,
      contract: 'src/core/error-registry.ts registers queue_capacity as retryable ("The bounded queue is full; existing requests keep their place"); a page over MAX_FILE_SIZE is refused with request_too_large and split advice (src/core/persistence/page-prepare.ts)',
      surface: 'put_page -> persistence admission (src/core/persistence/journal.ts intent-bytes check against persistence.limits principalIntentBytes, 32 MiB default)',
      repro: repro(capacity.tier, 'single-page'),
      expected: 'a single page larger than the per-request intent-byte cap is refused as too large (request_too_large, not retryable), as the 20 MB page is',
      actual: `put_page of the ${capacity.tier} ${capacity.doc} on an empty brain returned queue_capacity (write capacity exhausted), a retryable code for a request no amount of waiting can admit; keyword recall ${capacity.keyword_recall.hits}/${capacity.keyword_recall.total}`,
    });
  }
  const loud = r.capability.present ? undefined : single.find(a => (a.direct_read_bytes ?? 0) > EGRESS_CAP_BYTES);
  if (loud) {
    out.push({
      id: 'N14-3', category: 'large-page-fidelity', classification: 'feature-gap', status: 'open', gbrain_sha: sha,
      contract: 'get_page has no windowed read and no response budget at this commit (params slug, include_content, content_only; src/core/ops/pages.ts get_page); nothing claims a bounded response',
      surface: 'get_page (default parameters)',
      repro: repro(loud.tier, 'single-page'),
      expected: `a read of a large page returns a bounded window (frame at most ${EGRESS_CAP_BYTES} bytes) with a way to page`,
      actual: `a default get_page of the stored ${loud.tier} ${loud.doc} page returns a ${loud.direct_read_bytes}-byte frame (${(loud.direct_read_bytes! / EGRESS_CAP_BYTES).toFixed(1)}x the 1 MiB cap)`,
    });
  }
  return out;
}

// ─── Paid arm ────────────────────────────────────────────────────────────

export interface QaRow { needle: string; model: string; arm: Arm; tier: TierId; answer: string; correct: boolean; distractor: boolean; error?: string }

/** Exact-token scoring of a reader answer; an answer naming the distractor's value is a confusion. */
export function scoreQa(answer: string, needle: Pick<Needle, 'answer' | 'distractor'>): { correct: boolean; distractor: boolean } {
  const correct = containsToken(answer, needle.answer);
  const distractor = containsToken(answer, needle.distractor.answer);
  return { correct: correct && !distractor, distractor };
}

async function runPaid(gut: GbrainUnderTest, argv: readonly string[], tiers: TierId[], arms: Arm[], seed: number, log: (s: string) => void): Promise<{ data: Record<string, unknown>; cost: RunSummary | null }> {
  const voyage = process.env.VOYAGE_API_KEY ?? '';
  const keys = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '', OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' };
  if (!voyage || !keys.ANTHROPIC_API_KEY || !keys.OPENAI_API_KEY) throw new Error('the N14 paid arm needs VOYAGE_API_KEY, ANTHROPIC_API_KEY and OPENAI_API_KEY');
  const { run, guard } = startPaidRun(`${CATEGORY}-paid`, { ...budgetOptionsFrom(argv), estimateUsd: PAID_ESTIMATE_USD, log });
  const recall: Record<string, unknown> = {};
  const qa: QaRow[] = [];
  let cost: RunSummary | null = null;
  try {
    for (const tier of tiers) {
      const work = mkdtempSync(join(tmpdir(), `n14-paid-${tier}-`));
      try {
        for (const spec of tierSpecs(tier, seed)) {
          const docPath = join(work, `${spec.kind}.md`);
          const ledger = writeDocument(spec, docPath);
          const failed = checkPresence(readFileSync(docPath), ledger).filter(p => !p.ok);
          if (failed.length) throw new Error(`presence failed for ${tier}/${spec.kind}: ${failed[0].name}`);
          const raw = readFileSync(docPath, 'utf8');
          for (const arm of arms) {
            if (guard.exhausted) break;
            const adapter = await GbrainAdapter.open(gut.root, arm, { kind: 'real', model: PAID_EMBEDDING.model, dims: PAID_EMBEDDING.dims, env: { VOYAGE_API_KEY: voyage, ...keys } });
            if (arm === 'native' && !adapter.capability.present) { await adapter.close(); recall[`${tier}/${spec.kind}/${arm}`] = 'capability absent'; continue; }
            try {
              const ingest = await adapter.ingest(ledger, raw);
              await adapter.embedPass();
              const rows = { hybrid: new Array(DECILES).fill(0), vector: new Array(DECILES).fill(0), total: new Array(DECILES).fill(0) };
              const deliveredByNeedle = new Map<string, string[]>();
              for (const n of ledger.needles) {
                rows.total[n.decile]++;
                try {
                  const h = await adapter.hybrid(n.query);
                  if (hitRank(h.map(x => x.passage), n.answer) !== null) rows.hybrid[n.decile]++;
                  deliveredByNeedle.set(n.id, h.slice(0, 5).map(x => x.delivered.slice(0, 2000)));
                } catch { /* scored miss */ }
                try { if (hitRank((await adapter.vector(n.query)).map(x => x.passage), n.answer) !== null) rows.vector[n.decile]++; } catch { /* scored miss */ }
              }
              const byDecile = (k: 'hybrid' | 'vector') => rows[k].map((h, d) => rate(h, rows.total[d]));
              recall[`${tier}/${spec.kind}/${arm}`] = { ingest: ingest.status, hybrid_by_decile: byDecile('hybrid'), vector_by_decile: byDecile('vector'), hybrid_min_decile: Math.min(...byDecile('hybrid').map(r => r.rate)) };
              for (const n of ingest.status === 'stored' ? ledger.needles.filter(x => x.decile >= 5) : []) {
                for (const model of PAID_MODELS) {
                  if (guard.exhausted) break;
                  const context = (deliveredByNeedle.get(n.id) ?? []).map((t, i) => `[${i + 1}] ${t}`).join('\n\n') || '(no results)';
                  try {
                    adapter.gateway.configureGateway({ chat_model: model, embedding_model: PAID_EMBEDDING.model, embedding_dimensions: PAID_EMBEDDING.dims, env: { VOYAGE_API_KEY: voyage, ...keys } });
                    const res = await adapter.gateway.chat!({ model, system: 'Answer from the search results only. Reply with the answer alone, or "unknown".', messages: [{ role: 'user', content: `Search results:\n${context}\n\nQuestion: ${n.question}` }], maxTokens: 64 });
                    qa.push({ needle: n.id, model, arm, tier, answer: res.text.trim().slice(0, 200), ...scoreQa(res.text, n) });
                  } catch (e) { qa.push({ needle: n.id, model, arm, tier, answer: '', correct: false, distractor: false, error: errMsg(e).slice(0, 200) }); }
                }
              }
            } finally { await adapter.close(); }
          }
        }
      } finally { rmSync(work, { recursive: true, force: true }); }
    }
  } finally {
    guard.uninstall();
    cost = run.close();
  }
  const qaByModel = Object.fromEntries(PAID_MODELS.map(m => { const rs = qa.filter(q => q.model === m); return [m, { correct: rs.filter(q => q.correct).length, distractor: rs.filter(q => q.distractor).length, errors: rs.filter(q => q.error).length, total: rs.length }]; }));
  const gates = Object.entries(recall).filter(([k, v]) => typeof v === 'object' && /^(2mb|20mb)\//.test(k) && !k.endsWith('/single-page')).map(([k, v]) => {
    const min = (v as { hybrid_min_decile: number }).hybrid_min_decile;
    return { id: `hybrid-recall-${k}`, pass: min >= THRESHOLDS.hybrid_recall_min_decile, observed: min, threshold: THRESHOLDS.hybrid_recall_min_decile };
  });
  return { data: { paid: { embedding: PAID_EMBEDDING, models: PAID_MODELS, recall, qa_by_model: qaByModel, qa, gates } }, cost };
}

const PAID_ESTIMATE_USD = 8;

// ─── CLI ─────────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

export function parseTiers(argv: readonly string[]): TierId[] {
  const raw = argValue(argv, '--tiers') ?? argValue(argv, '--tier') ?? '2mb';
  const tiers = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const t of tiers) if (!TIER_IDS.includes(t as TierId)) throw new Error(`unknown tier ${t}; use ${TIER_IDS.join(', ')}`);
  return tiers as TierId[];
}

export function parseDocs(argv: readonly string[]): DocKind[] | undefined {
  const raw = argValue(argv, '--docs');
  if (!raw) return undefined;
  const docs = raw.split(',').map(x => x.trim()).filter(Boolean);
  for (const d of docs) if (!['conversation', 'project-log', 'book'].includes(d)) throw new Error(`unknown document ${d}; use conversation, project-log, book`);
  return docs as DocKind[];
}

/** `--config key=value[,key=value]` (repeatable): brain config every child sets after initSchema (Amendment 2). Undefined when absent. */
export function parseConfigOverlay(argv: readonly string[]): Record<string, string> | undefined {
  const raw = argv.flatMap((a, i) => a === '--config' ? [argv[i + 1] ?? ''] : a.startsWith('--config=') ? [a.slice('--config='.length)] : []);
  if (!raw.length) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.flatMap(r => r.split(','))) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--config takes key=value, got ${JSON.stringify(pair)}`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

export function parseNativeIngest(argv: readonly string[]): NativeIngest {
  const raw = argValue(argv, '--native-ingest') ?? 'put_page';
  if (raw !== 'put_page' && raw !== 'import') throw new Error(`--native-ingest takes put_page or import, got ${raw}`);
  return raw;
}

/** `--engine pglite|postgres` (Amendment 4); postgres needs an admin URL from `--pg-admin-url` or N14_PG_ADMIN_URL. */
export function parseEngine(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): { kind: 'pglite' } | { kind: 'postgres'; adminUrl: string } {
  const kind = argValue(argv, '--engine') ?? 'pglite';
  if (kind === 'pglite') return { kind };
  if (kind !== 'postgres') throw new Error(`--engine takes pglite or postgres, got ${kind}`);
  const adminUrl = argValue(argv, '--pg-admin-url') ?? env.N14_PG_ADMIN_URL;
  if (!adminUrl) throw new Error('--engine postgres needs --pg-admin-url <url> or N14_PG_ADMIN_URL');
  return { kind, adminUrl };
}

export function parseArms(argv: readonly string[]): Arm[] {
  const raw = argValue(argv, '--arms');
  if (!raw) return [...ARMS];
  const arms = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const a of arms) if (!(ARMS as readonly string[]).includes(a)) throw new Error(`unknown arm ${a}; use ${ARMS.join(', ')}`);
  return arms as Arm[];
}

const pct = (r: Rate) => `${r.hits}/${r.total}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child') { await childMain(argv[1]); process.exit(0); }
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? N14_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const tiers = parseTiers(argv);
  const arms = parseArms(argv);
  const docs = parseDocs(argv);
  const concurrency = Number(argValue(argv, '--concurrency') ?? 2);
  const rssLimitMb = Number(argValue(argv, '--rss-limit-mb') ?? DEFAULT_RSS_LIMIT_MB);
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const paid = paidRequested(argv);
  let attestation: Attestation | null = null;
  if (paid) {
    requirePaidArm(argv, { arm: 'N14 paid arm (real embeddings and reader QA)', estimateUsd: PAID_ESTIMATE_USD });
    const prereg = argValue(argv, '--preregistration');
    if (!prereg) throw new Error('the N14 paid arm needs --preregistration docs/benchmarks/2026-10-14-n14-large-page-fidelity-preregistration.md (committed and pushed)');
    attestation = attestPreregistration(prereg);
  }
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const config = parseConfigOverlay(argv);
  const nativeIngest = parseNativeIngest(argv);
  const upgradeSpec = argValue(argv, '--upgrade-from');
  const upgradeFrom = upgradeSpec ? resolveGbrainUnderTest(upgradeSpec) : undefined;
  if (upgradeFrom && !tiers.includes('2mb')) throw new Error('--upgrade-from runs on the 2mb tier; add --tiers 2mb');
  const engine = parseEngine(argv);
  if (upgradeFrom && engine.kind === 'postgres') throw new Error('--upgrade-from runs on file-backed PGLite only');
  const lifecycle = argv.includes('--lifecycle');
  let postgresServer: string | null = null;
  if (engine.kind === 'postgres') {
    const admin = new SQL(engine.adminUrl);
    try { postgresServer = String((await admin.unsafe('SHOW server_version'))[0]?.server_version ?? ''); } finally { await admin.close(); }
  }
  log(`# BrainBench N14: large-page fidelity (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'}; ${engine.kind}${postgresServer ? ` ${postgresServer}` : ''}; tiers ${tiers.join(', ')}; arms ${arms.join(', ')})`);
  const t0 = performance.now();
  const r = await runN14({ gut, upgradeFrom, tiers, arms, docs, seed, concurrency, rssLimitMb, log, ...(config ? { config } : {}), ...(nativeIngest !== 'put_page' ? { nativeIngest } : {}), ...(engine.kind === 'postgres' ? { pgAdminUrl: engine.adminUrl } : {}), ...(lifecycle ? { lifecycle } : {}) });
  const hermeticMs = Math.round(performance.now() - t0);
  let paidData: Record<string, unknown> | null = null;
  let paidCost: RunSummary | null = null;
  if (paid && !r.harnessError) ({ data: paidData, cost: paidCost } = await runPaid(gut, argv, tiers.filter(t => t !== '1gb'), arms, seed, log));
  const a = r.acc.summary();
  const findings = n14Findings(r, gut);
  if (argv.includes('--record-bugs')) {
    const prior = new Map(readBugLedger(WAVE_BUG_LEDGER).entries.map(e => [e.id, e]));
    for (const f of findings) {
      const was = prior.get(f.id);
      const history = was?.review ? [...(was.review_history ?? []), was.review] : was?.review_history;
      upsertBug({ ...f, review: { date: startedAt.slice(0, 10), gbrain_sha: f.gbrain_sha, evidence: 'rerun', receipts: [relative(process.cwd(), outPath)], note: was?.review ? 'reproduced by this run' : 'found by this run' }, ...(history?.length ? { review_history: history } : {}) });
    }
  }
  const runStatus = r.harnessError || a.run_invalid ? 'error' : 'completed';
  const receipt: Receipt = {
    ...(paidCost ? { cost: receiptCost(paidCost), delivered_tokens: null } : noModelSpend('hermetic: provider keys stripped, keyword search only; the append-cost embedder is an in-process counting fake (no network)')),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: runStatus,
    ...(runStatus === 'completed' ? { verdict: r.verdict?.verdict ?? 'fail' } : {}),
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: a.publishable && !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    ...(attestation ? { preregistration_attestation: attestation } : {}),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: engine.kind === 'postgres' ? `postgres ${postgresServer} (pgvector), one fresh database per (document, arm) child process, created and dropped by the harness` : 'pglite-in-memory, one brain per (document, arm) child process',
      decide: DECIDE_OFF,
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default }',
      tiers, arms, docs: docs ?? 'all', seed, concurrency, rss_limit_mb: rssLimitMb,
      generator_version: N14_GENERATOR_VERSION,
      tier_sizes: Object.fromEntries(tiers.map(t => [t, TIERS[t]])),
      search: `search op (keyword), limit ${TOP_K}; a hit is a result whose stored chunk (content_chunks.chunk_text by chunk_id) holds the needle answer as a whole token, passage at most ${PASSAGE_CAP_BYTES} bytes`,
      egress: `largest JSON-RPC text frame of every operation result; cap ${EGRESS_CAP_BYTES} bytes`,
      reads: 'single-page and managed-parts: get_page {slug} of the hit page; native: get_page {slug, body: window, around_chunk_id}; plus one default get_page of the entry page per arm',
      append: 'single-page: put_page whole page + 1 KB; managed-parts: put_page new part + hub index; native: append_page when it exists (the source\'s trailing whitespace, then the 1 KB day, separator none; Amendment 5)',
      native_write: 'native: put_page up to 4 MiB; above it an upload session (begin_page_upload mode create, upload_page_part cut to part_max_frame_bytes, commit_page_upload) when gbrain has one; the lifecycle fence write uses mode replace (Amendment 5)',
      append_cost: 'embedding inputs and estimated tokens (UTF-8 bytes / 4) sent by runEmbedCore({stale: true}) after the append, counted by a fake embed transport; ratio = embed tokens / appended tokens; null when the page has no chunks',
      embed_pass_tiers: EMBED_PASS_TIERS,
      settle_bound: 'write_pending polls and projection settles wait up to max(240 s, 3 s per MB of the document) (Amendment 4)',
      ...(lifecycle ? { lifecycle: `exploratory (Amendment 4): after the round trip, append a one-row facts fence and forget_fact it (fact withdrawn, recall, exported row), delete_page (search hits for one needle per decile, get_page), restore_page (hits, export equal to the pre-delete export), delete_page purge: true (residue rows and needle bytes, then sweepSegments({ graceMs: 0 })); lifecycle calls are outside the egress count` } : {}),
      roundtrip: 'export (runExport --slug-prefix) then reassemble the body; sha256 against source body + append',
      native_capability: r.capability,
      thresholds: THRESHOLDS,
      gbrain_overlay: overlaySummary(gut),
      ...(config ? { config_overlay: config } : {}),
      ...(nativeIngest !== 'put_page' ? { native_ingest: 'importFromFile(engine, file, <slug>.md, { noEmbed: true, bodyPolicy: readPageBodyPolicy(engine) }); the append re-imports the whole file' } : {}),
      ...(upgradeFrom ? { upgrade_from: { gbrain_version: upgradeFrom.version, overlay: overlaySummary(upgradeFrom), path: 'file-backed PGLite seeded single-page by upgrade_from (embed off), then opened by the gbrain under test: initSchema, runOversizedBackfill, the native arm probes without an embed pass' } } : {}),
      direct_read_agent: 'exploratory (Amendment 1): the entry page default get_page also made with remote: true; its frame is reported per arm and is not in the egress count',
      hermetic_wall_ms: hermeticMs,
    },
    hashes: { ledger_sha256: r.ledgerSha256 },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      safety: r.summary?.safety ?? null,
      quality: r.summary?.quality ?? null,
      floor: r.summary?.floor ?? null,
      capability: r.capability,
      verdict_failures: r.verdict?.failed ?? null,
      arms: r.summary?.arms ?? r.tiers.flatMap(t => t.arms),
      children: r.tiers.flatMap(t => t.children),
      ...(upgradeFrom ? { upgrade: r.tiers.flatMap(t => t.upgrade ?? []) } : {}),
      presence: r.tiers.flatMap(t => t.presence),
      documents: r.tiers.flatMap(t => t.docs.map(d => ({ tier: t.tier, id: d.id, bytes: d.bytes, lines: d.lines, sections: d.sections.length, sha256: d.sha256, needles: d.needles.length, append_bytes: d.append.bytes }))),
      probes: r.runs.map(x => ({ tier: x.tier, arm: x.run.arm, doc: x.run.doc, rows: x.run.probes, reads: x.run.reads, append: x.run.append, roundtrip: x.run.roundtrip, segment_roundtrip: x.run.segment_roundtrip ?? null, lifecycle: x.run.lifecycle ?? null, frames: x.run.frames, memory: x.run.memory, ingest: x.run.ingest, direct_read: x.run.direct_read, direct_read_agent: x.run.direct_read_agent ?? null, embed_initial: x.run.embed_initial, embed_error: x.run.embed_error ?? null })),
      findings: findings.map(f => ({ id: f.id, classification: f.classification, surface: f.surface, actual: f.actual, repro: f.repro })),
      ...(paidData ?? {}),
      harness_error: r.harnessError,
    },
  };
  writeReceipt(outPath, scrubMachinePaths(receipt));

  log('');
  log(`verdict: ${runStatus === 'completed' ? r.verdict?.verdict : `run error (${r.harnessError})`}${r.verdict?.failed.length ? ` (${r.verdict.failed.join('; ')})` : ''}`);
  if (r.summary) {
    const s = r.summary;
    log(`safety: crashes ${s.safety.crashes}, responses over ${EGRESS_CAP_BYTES} B ${s.safety.responses_over_cap}, round-trip byte loss ${s.safety.roundtrip_byte_loss}, presence failures ${s.safety.presence_failures}`);
    log(`quality: native append embed ratio max ${s.quality.native_append_embed_ratio_max ?? 'n/a'} (<= ${THRESHOLDS.append_embed_ratio_max}), native recall gap vs parts ${s.quality.native_recall_gap_points_max ?? 'n/a'} points (<= ${THRESHOLDS.native_recall_gap_points_max}), native keyword recall at 2 MB ${s.floor.native_keyword_recall_2mb ?? 'n/a'} (>= ${THRESHOLDS.native_keyword_recall_floor}); native capability ${s.capability.present ? 'present' : 'absent'}`);
    log('\n| tier | doc | arm | ingest | chunks | keyword recall@10 | min decile | delivered | reads ok | max frame B | append embed ratio | rewritten | round trip | ingest s | RSS over base MB |');
    log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of s.arms) {
      log(`| ${x.tier} | ${x.doc} | ${x.arm} | ${x.ingest.status}${x.ingest.code ? ` (${x.ingest.code})` : ''}${x.ingest.embed_skip ? ` embed_skip=${x.ingest.embed_skip}` : ''} | ${x.ingest.chunks} | ${pct(x.keyword_recall)} | ${x.min_decile_recall.toFixed(2)} | ${pct(x.delivered_recall)} | ${x.reads.correct}/${x.reads.attempted} | ${x.max_frame_bytes} | ${x.append?.embed_ratio ?? 'n/a'} | ${x.append?.chunks_rewritten ?? 'n/a'} | ${x.roundtrip} | ${x.ingest.wall_ms === null ? 'n/a' : (x.ingest.wall_ms / 1000).toFixed(1)} | ${x.ingest.rss_over_baseline_mb ?? 'n/a'} |`);
    }
  }
  const upgrades = r.tiers.flatMap(t => t.upgrade ?? []);
  if (upgrades.length) {
    log('\nupgrade path (exploratory): seeded by the older gbrain, backfilled and probed by the gbrain under test');
    log('| doc | seed | backfill reindexed/candidates (held) | marker removed | chunks | keyword recall@10 | min decile | reads ok | max frame B | round trip |');
    log('|---|---|---|---|---|---|---|---|---|---|');
    for (const u of upgrades) {
      const b = u.backfill as { reindexed?: number; candidates?: number; held_for_approval?: number } | null;
      const x = u.summary;
      log(`| ${u.doc} | ${u.seed ? `${u.seed.status}${u.seed.embed_skip ? ` embed_skip=${u.seed.embed_skip}` : ''}, ${u.seed.chunks} chunks` : `crash ${u.seed_crash}`} | ${b ? `${b.reindexed}/${b.candidates} (${b.held_for_approval})` : 'n/a'} | ${u.marker_removed ?? 'n/a'} | ${x?.ingest.chunks ?? 'n/a'} | ${x ? pct(x.keyword_recall) : 'n/a'} | ${x ? x.min_decile_recall.toFixed(2) : 'n/a'} | ${x ? `${x.reads.correct}/${x.reads.attempted}` : 'n/a'} | ${x?.max_frame_bytes ?? 'n/a'} | ${x?.roundtrip ?? (u.crash ? `crash ${u.crash}` : 'n/a')} |`);
    }
  }
  const lifecycles = r.runs.filter(x => x.run.lifecycle);
  if (lifecycles.length) {
    log('\nlifecycle (exploratory, Amendment 4)');
    log('| tier | doc | arm | hits before | forget: rows / withdrawn / recall after / exported row | delete: hits / get_page | restore: hits / export equal | purge: pages, chunks, manifest, versions, facts / needle chunks, texts / unreferenced texts (bytes) / after sweep |');
    log('|---|---|---|---|---|---|---|---|');
    for (const { tier, run } of lifecycles) {
      const l = run.lifecycle!;
      if ('error' in l) { log(`| ${tier} | ${run.doc} | ${run.arm} | error ${l.error} |||||`); continue; }
      const p = l.purge.residue;
      log(`| ${tier} | ${run.doc} | ${run.arm} | ${l.hits_before}/${l.probes} | ${l.forget.status === 'ok' ? `${l.forget.fact_rows} / ${l.forget.withdrawn} / ${l.forget.recall_hits_after} / ${l.forget.export_row}` : `error ${l.forget.error}`} | ${l.delete.status === 'ok' ? `${l.delete.hits_after}/${l.probes} / ${l.delete.get_page_code}` : `error ${l.delete.error}`} | ${l.restore.status === 'ok' ? `${l.restore.hits_after}/${l.probes} / ${l.restore.export_matches_pre_delete}` : `error ${l.restore.error}`} | ${l.purge.status === 'ok' && p ? `${p.pages}, ${p.chunks}, ${p.manifest_rows}, ${p.versions}, ${p.facts} / ${p.needle_chunks}, ${p.needle_texts} / ${p.unreferenced_texts} (${p.unreferenced_text_bytes}) / ${l.purge.sweep ? `${l.purge.sweep.texts_deleted} deleted, ${l.purge.sweep.needle_texts_after} needle texts` : 'n/a'}` : `error ${l.purge.error}`} |`);
    }
  }
  log(`\ngbrain findings: ${findings.length ? '' : 'none'}`);
  for (const f of findings) log(`  ${f.id} (${f.classification}) ${f.surface}: ${f.actual}\n    repro: ${f.repro}`);
  if (argv.includes('--record-bugs')) log(`  recorded in ${WAVE_BUG_LEDGER}`);
  log(`receipt: ${outPath} (hermetic arm ${(hermeticMs / 1000).toFixed(1)} s)`);
  if (json) process.stdout.write(JSON.stringify({ run_status: runStatus, verdict: receipt.verdict, safety: r.summary?.safety, quality: r.summary?.quality, floor: r.summary?.floor }, null, 2) + '\n');
  process.exit(runStatus === 'error' ? 3 : r.verdict?.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
