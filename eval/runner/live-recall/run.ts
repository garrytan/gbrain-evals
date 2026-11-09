#!/usr/bin/env bun
/**
 * Live recall: recall@k and per-query-type retrieval ablations on a private
 * question set, run on the box that holds the brain. Only an aggregate
 * scorecard leaves that box.
 *
 *   bun eval/runner/live-recall/run.ts run --fixture
 *   bun eval/runner/live-recall/run.ts freeze --questions <private.jsonl> --out <freeze.json> [--protocol batch1|batch2|batch3] [--gbrain <checkout>@<commit>]
 *   bun eval/runner/live-recall/run.ts run --questions <private.jsonl> --freeze <freeze.json> \
 *     --gbrain <gbrain checkout>@<commit> [--database-url-env LIVE_RECALL_DATABASE_URL] [--out <dir>]
 *   bun eval/runner/live-recall/run.ts compare --a <run dir> --b <run dir> --out <dir>
 *   bun eval/runner/live-recall/run.ts pool --a <run dir> --b <run dir> --out <dir>
 *
 * --fixture builds the public 30-page fixture brain in memory with hash
 * embeddings and a token-overlap reranker (with --questions, it asks those
 * questions of the fixture instead of its own; with --protocol, it scores them
 * under that protocol; --protocol batch3 alone adds the public freshness and
 * entity questions and their pages): a keyless harness control whose numbers say nothing
 * about search quality. A counted run takes its protocol from the freeze. A real run opens a Postgres brain
 * only after brain.ts proves a server-side read-only barrier. The run kit,
 * abort codes and scorecard format are in docs/benchmarks/live-recall/.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { rankOfFirstHit, recallAllAtK, uniqueInOrder } from '../metrics.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { gbrainPin } from '../gbrain-version.ts';
import { normalQuantile } from '../stats/paired.ts';
import { ABORT_CODES, COPY_MARKER_TABLE, LiveRecallAbort, checkSchema, installGuards, openPostgresBrain, verifyReadOnly, type GuardCounters } from './brain.ts';
import { visibilityEpoch } from './visibility-epoch.ts';
import { ALL_TYPES, ARMS, GOLD_FOUND_BY, KS, PROTOCOLS, PROTOCOL_TYPES, TYPES, buildScorecard, compareRuns, poolRuns, renderMarkdown, scanForLeaks, validateScorecard, versionOrNull, type Arm, type Form, type Protocol, type QType, type QueryRecord, type Status } from './scorecard.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const FIXTURE_DIR = join(REPO_ROOT, 'eval/data/live-recall-v1');
/** Batch 3's public fixture questions and the pages they add to the fixture brain. */
export const BATCH3_FIXTURE_QUESTIONS = join(FIXTURE_DIR, 'questions-batch3.jsonl');
export const BATCH3_FIXTURE_PAGES = join(FIXTURE_DIR, 'batch3-pages');
export const FIXTURE_DIM = 256;
/** Chunks fetched by every arm except configured, which keeps gbrain's own default limit. */
export const CHUNK_FETCH = 50;
const PAGE_DEPTH = 20;
/** More than this share of questions with an absent gold page aborts the run. */
export const GOLD_MISSING_CAP = 0.1;

export interface Question {
  id: string;
  type: QType;
  forms: Record<Form, string>;
  gold: Array<{ slug: string; chunk_ids?: number[] }>;
  gold_found_by: string;
  window?: { since: string; until: string };
  /** batch3 freshness only: pages holding the superseded fact. */
  stale?: Array<{ slug: string }>;
}

/**
 * Parse the private question file. A refusal names the line and the field, never the content.
 * The protocol fixes the accepted types; under batch3 a freshness question must name its stale
 * pages (none of them gold) and no other type may.
 */
export function parseQuestions(text: string, protocol: Protocol = 'batch1'): Question[] {
  const types = PROTOCOL_TYPES[protocol];
  const out: Question[] = [];
  const ids = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const bad = (field: string) => new LiveRecallAbort('LR_QUESTIONS_INVALID', 'line ' + (i + 1) + ' field ' + field);
    let q: any;
    try { q = JSON.parse(line); } catch { throw bad('json'); }
    if (typeof q?.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(q.id) || ids.has(q.id)) throw bad('id');
    if (!(types as readonly string[]).includes(q.type)) throw bad('type');
    const forms = {} as Record<Form, string>;
    for (const form of ['exact', 'paraphrase'] as const) {
      const v = q.forms?.[form];
      if (typeof v !== 'string' || !v.trim()) throw bad('forms.' + form);
      forms[form] = v;
    }
    if (!Array.isArray(q.gold) || q.gold.length === 0) throw bad('gold');
    const gold = q.gold.map((g: any, j: number) => {
      if (typeof g?.slug !== 'string' || !g.slug.trim()) throw bad('gold[' + j + '].slug');
      if (g.chunk_ids !== undefined && (!Array.isArray(g.chunk_ids) || !g.chunk_ids.every((c: unknown) => Number.isInteger(c)))) throw bad('gold[' + j + '].chunk_ids');
      return g.chunk_ids ? { slug: g.slug, chunk_ids: g.chunk_ids } : { slug: g.slug };
    });
    const foundBy = q.gold_found_by ?? 'unknown';
    if (!(GOLD_FOUND_BY as readonly string[]).includes(foundBy)) throw bad('gold_found_by');
    let window: Question['window'];
    if (q.window !== undefined) {
      const iso = /^\d{4}-\d{2}-\d{2}/;
      if (typeof q.window?.since !== 'string' || typeof q.window?.until !== 'string' || !iso.test(q.window.since) || !iso.test(q.window.until)) throw bad('window');
      window = { since: q.window.since, until: q.window.until };
    }
    let stale: Question['stale'];
    if (protocol === 'batch3') {
      if (q.type === 'freshness') {
        if (!Array.isArray(q.stale) || q.stale.length === 0) throw bad('stale');
        stale = q.stale.map((s: any, j: number) => {
          if (typeof s?.slug !== 'string' || !s.slug.trim() || gold.some((g: { slug: string }) => g.slug === s.slug)) throw bad('stale[' + j + '].slug');
          return { slug: s.slug };
        });
      } else if (q.stale !== undefined) throw bad('stale');
    }
    ids.add(q.id);
    out.push({ id: q.id, type: q.type, forms, gold, gold_found_by: foundBy, ...(window ? { window } : {}), ...(stale ? { stale } : {}) });
  });
  if (out.length === 0) throw new LiveRecallAbort('LR_QUESTIONS_INVALID', 'no questions');
  return out;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Tokens that look like identifiers or error codes: digits, underscores, or a leading run of capitals. */
export function identifierTokens(text: string): Set<string> {
  return new Set(text.split(/[\s,;()"]+/).filter(t => /[0-9_]/.test(t) || /^[A-Z]{3,}/.test(t)).map(t => t.toLowerCase().replace(/[.,:;'"?]+$/, '')).filter(t => t.length >= 3));
}

function paraphraseOverlapShare(questions: Question[]): number {
  if (!questions.length) return 0;
  const leaky = questions.filter(q => [...identifierTokens(q.forms.exact)].some(t => q.forms.paraphrase.toLowerCase().includes(t)));
  return Math.round((leaky.length / questions.length) * 10000) / 10000;
}

/** Minimum detectable difference in success@5 for a paired comparison: two-sided 0.05, 80% power. */
export function mde(pairs: number, discordant: number): number {
  return Math.round((normalQuantile(0.975) + normalQuantile(0.8)) * Math.sqrt(discordant / pairs) * 10000) / 10000;
}

const byPd = (f: (pd: number) => unknown) => ({ pd10: f(0.1), pd20: f(0.2), pd30: f(0.3) });

/** The numbers Wintermute sends before a counted run; we commit them to the preregistration. The protocol fixes which comparisons are primary. */
export function freezeSummary(text: string, questions: Question[], protocol: Exclude<Protocol, 'batch3'> = 'batch1') {
  const n = questions.length;
  const bothForms = byPd(pd => [mde(2 * n, pd), mde(n, pd)]);
  const paraphrase = byPd(pd => mde(n, pd));
  return {
    schema: 'live-recall-freeze/v1',
    protocol,
    questions_sha256: sha256(text),
    n_questions: n,
    by_type: Object.fromEntries(TYPES.map(t => [t, questions.filter(q => q.type === t).length])),
    windowed_time_window: questions.filter(q => q.type === 'time_window' && q.window).length,
    mde_success_at_5: protocol === 'batch1'
      ? { p1_both_forms_range: bothForms, p2_paraphrase: paraphrase }
      : { p1_paraphrase: paraphrase, p2_paraphrase: paraphrase, batch1_p1_both_forms_range: bothForms },
  };
}

/**
 * The batch 3 freeze: the same counts over all seven types, the minimum detectable differences of its two primaries
 * (null for a type with no questions), and the gbrain version the freeze was made with and its GBRA-398 visibility
 * epoch, so a counted run on the other side of that change refuses it.
 */
export function freezeSummaryBatch3(text: string, questions: Question[], gbrain: { version: string }) {
  const typed = (t: QType) => questions.filter(q => q.type === t).length;
  const range = (m: number) => byPd(pd => (m ? [mde(2 * m, pd), mde(m, pd)] : null));
  return {
    schema: 'live-recall-freeze/v1',
    protocol: 'batch3' as const,
    questions_sha256: sha256(text),
    n_questions: questions.length,
    by_type: Object.fromEntries(ALL_TYPES.map(t => [t, typed(t)])),
    windowed_time_window: questions.filter(q => q.type === 'time_window' && q.window).length,
    freshness_stale_pages: questions.reduce((s, q) => s + (q.stale?.length ?? 0), 0),
    gbrain_version: gbrain.version,
    visibility_epoch: visibilityEpoch(gbrain.version),
    mde_success_at_5: { p1_freshness_both_forms_range: range(typed('freshness')), p2_entity_both_forms_range: range(typed('entity')) },
  };
}

type Kind = 'chat' | 'embedding' | 'rerank' | 'multimodal' | 'decide' | 'transcription';
export interface SearchContext {
  engine: any;
  hybridSearch: (engine: any, query: string, opts: Record<string, unknown>) => Promise<any[]>;
  withGuard: <T>(guard: (call: { kind: Kind }) => Promise<{ settle: (u: unknown) => Promise<void> }>, run: () => Promise<T>) => Promise<T>;
  rerankerEnabled: boolean;
  embeddingOptedOut: boolean;
  /** What hybridSearch hands its own vector leg (embedding column, legacy guard, iterative scan), so the vector arm searches the same column. */
  vectorOpts: Record<string, unknown>;
}

/**
 * Degraded stages that mean a provider or an arm failed, so the query did not
 * run as the arm promises and is excluded. Every other stage gbrain reports
 * (keyword_zero, budget_truncated, a pending index and so on) is how the brain
 * behaves; those queries count, and the scorecard reports each stage's count.
 */
export const FAILURE_STAGES: ReadonlySet<string> = new Set(['embed_unavailable', 'embed_timeout', 'vector_arm_failed', 'keyword_arm_failed', 'title_arm_failed', 'rerank_failed', 'rerank_passthrough']);
/** In the configured arms these are the reranker failing open, so they count toward the arm's fail-open cap. */
const RERANK_FAILURE_STAGES: ReadonlySet<string> = new Set(['rerank_failed', 'rerank_passthrough']);

interface Gold { pages: Set<string>; chunks: Set<string>; stale?: Set<string> }

async function runArm(ctx: SearchContext, arm: Arm, base: Pick<QueryRecord, 'qid' | 'type' | 'form' | 'gold_pages' | 'has_chunk_gold'>, gold: Gold, allowed: Kind[], search: (onMeta: (m: any) => void) => Promise<any[]>): Promise<QueryRecord> {
  const calls: Record<string, number> = {};
  let refused = false;
  let meta: any;
  const guard = async (call: { kind: Kind }) => {
    calls[call.kind] = (calls[call.kind] ?? 0) + 1;
    if (!allowed.includes(call.kind)) {
      refused = true;
      throw new Error('live-recall refused a ' + call.kind + ' call');
    }
    return { settle: async () => {} };
  };
  let results: any[] = [];
  let status: Status = 'ok';
  const t0 = performance.now();
  try {
    results = (await ctx.withGuard(guard, () => search(m => { meta = m; }))) ?? [];
  } catch {
    status = 'error';
  }
  const ms = Math.round(performance.now() - t0);
  if (refused) status = 'ai_refused';
  const degraded = ((meta?.degraded ?? []) as Array<{ stage?: unknown }>).map(d => String(d.stage)).filter(s => /^[a-z_]+$/.test(s));
  if (status === 'ok' && arm.startsWith('configured') && degraded.some(s => RERANK_FAILURE_STAGES.has(s))) status = 'rerank_fail_open';
  if (status === 'ok' && degraded.some(s => FAILURE_STAGES.has(s))) status = 'degraded';
  if (status === 'ok' && arm.startsWith('configured') && ctx.rerankerEnabled && results.length > 0 && !results.some(r => typeof r.rerank_score === 'number')) status = 'rerank_fail_open';
  const pages = uniqueInOrder(results.map(r => String(r.slug))).slice(0, PAGE_DEPTH);
  const chunks = uniqueInOrder(results.map(r => String(r.chunk_id))).slice(0, CHUNK_FETCH);
  const pageRank = rankOfFirstHit(pages, gold.pages);
  const chunkRank = gold.chunks.size ? rankOfFirstHit(chunks, gold.chunks) : Infinity;
  const staleRank = gold.stale ? rankOfFirstHit(pages, gold.stale) : Infinity;
  return {
    ...base, arm, status, pages, chunks,
    page_rank: Number.isFinite(pageRank) ? pageRank : null,
    chunk_rank: Number.isFinite(chunkRank) ? chunkRank : null,
    all_found_at: Object.fromEntries(KS.map(k => ['k' + k, recallAllAtK(pages, gold.pages, k) === 1])),
    ms, returned: pages.length, calls, degraded_stages: degraded,
    ...(gold.stale ? { stale_rank: Number.isFinite(staleRank) ? staleRank : null } : {}),
  };
}

/** Every arm for every question form, sequentially. The hybrid arm runs first so vector reuses its query embedding. */
export async function runQuestions(ctx: SearchContext, questions: Question[], progress?: (done: number) => void): Promise<QueryRecord[]> {
  const records: QueryRecord[] = [];
  const hybridOpts = { limit: CHUNK_FETCH, expansion: false, crossModal: 'text', autocut: false, reranker: { enabled: false, topNIn: 25, topNOut: null } };
  for (const [i, q] of questions.entries()) {
    const gold: Gold = { pages: new Set(q.gold.map(g => g.slug)), chunks: new Set(q.gold.flatMap(g => (g.chunk_ids ?? []).map(String))), ...(q.stale ? { stale: new Set(q.stale.map(s => s.slug)) } : {}) };
    for (const form of ['exact', 'paraphrase'] as const) {
      const text = q.forms[form];
      const base = { qid: q.id, type: q.type, form, gold_pages: gold.pages.size, has_chunk_gold: gold.chunks.size > 0 };
      let embedding: Float32Array | null = null;
      const skipped = (arm: Arm): QueryRecord => ({ ...base, arm, status: 'skipped', pages: [], chunks: [], page_rank: null, chunk_rank: null, all_found_at: {}, ms: 0, returned: 0, calls: {}, degraded_stages: [] });
      if (ctx.embeddingOptedOut) records.push(skipped('hybrid'));
      else records.push(await runArm(ctx, 'hybrid', base, gold, ['embedding'], onMeta => ctx.hybridSearch(ctx.engine, text, { ...hybridOpts, onMeta, onQueryEmbedding: (e: Float32Array) => { embedding = e; } })));
      records.push(await runArm(ctx, 'keyword', base, gold, [], () => ctx.engine.searchKeyword(text, { limit: CHUNK_FETCH })));
      records.push(await runArm(ctx, 'hybrid_lexical', base, gold, [], onMeta => ctx.hybridSearch(ctx.engine, text, { ...hybridOpts, onMeta, decide: { keywordOnly: true } })));
      if (ctx.embeddingOptedOut) records.push(skipped('vector'));
      else if (!embedding) records.push({ ...skipped('vector'), status: 'error' });
      else {
        const vector = embedding;
        records.push(await runArm(ctx, 'vector', base, gold, [], () => ctx.engine.searchVector(vector, { ...ctx.vectorOpts, limit: CHUNK_FETCH })));
      }
      records.push(await runArm(ctx, 'configured', base, gold, ['embedding', 'rerank'], onMeta => ctx.hybridSearch(ctx.engine, text, { expansion: false, crossModal: 'text', onMeta })));
      if (q.type === 'time_window' && q.window) {
        const w = q.window;
        records.push(await runArm(ctx, 'configured_window', base, gold, ['embedding', 'rerank'], onMeta => ctx.hybridSearch(ctx.engine, text, { expansion: false, crossModal: 'text', since: w.since, until: w.until, onMeta })));
      }
    }
    progress?.(i + 1);
  }
  return records;
}

/**
 * Public text every arm searches before any question: two made-up words, rare
 * enough that each keyword, title and windowed statement finds nothing or next
 * to nothing through the index and stays far inside gbrain's keyword statement
 * bound. Each arm's search statements still run, so a missing grant on them
 * still fails; the stages that need results, the reranker among them, run only
 * on the vector leg's candidates. The first probe ('live-recall arm preflight
 * probe') shared common words with Garry's brain. On gbrain 0.60.593.0 it
 * stopped two runs with keyword_arm_failed on configured_window: the first log
 * shows its all-time windowed keyword statement hitting that bound, and the
 * second run started with no gbrain job active.
 */
export const PREFLIGHT_PROBE = 'zqxjvk wfpqyz';

/**
 * One public probe through every arm, windowed so configured_window runs too,
 * before any counted search. An arm that errors, is refused a model call, fails
 * its reranker open or reports a failure stage aborts the run, naming only the
 * arms, their statuses and gbrain's stage names: batch 1's first counted attempt
 * lost every hybrid arm to title_arm_failed (a missing EXECUTE grant) and
 * measured nothing.
 */
export async function armPreflight(ctx: SearchContext): Promise<void> {
  const probe: Question = { id: 'preflight', type: 'time_window', forms: { exact: PREFLIGHT_PROBE, paraphrase: PREFLIGHT_PROBE }, gold: [{ slug: 'live-recall-preflight' }], gold_found_by: 'unknown', window: { since: '1970-01-01', until: '2100-01-01' } };
  const failed = new Map<string, string>();
  for (const r of await runQuestions(ctx, [probe])) {
    if (r.status === 'ok' || r.status === 'skipped') continue;
    const stages = [...new Set(r.degraded_stages.filter(s => FAILURE_STAGES.has(s)))];
    failed.set(r.arm, r.arm + ' ' + r.status + (stages.length ? ' (' + stages.join(', ') + ')' : ''));
  }
  if (failed.size) throw new LiveRecallAbort('LR_ARM_PREFLIGHT', [...failed.values()].join('; '));
}

/** Drop questions whose gold pages (or, for freshness, stale pages) the brain does not hold; abort past the cap. */
export async function presenceCheck(engine: any, questions: Question[]): Promise<{ kept: Question[]; missing: number }> {
  const kept: Question[] = [];
  for (const q of questions) {
    let present = true;
    for (const g of [...q.gold, ...(q.stale ?? [])]) if (!(await engine.getPage(g.slug))) present = false;
    if (present) kept.push(q);
  }
  const missing = questions.length - kept.length;
  if (missing / questions.length > GOLD_MISSING_CAP) throw new LiveRecallAbort('LR_GOLD_MISSING_CAP', missing + ' of ' + questions.length + ' questions have an absent gold page');
  return { kept, missing };
}

function walkPages(dir: string, root = dir): Array<{ slug: string; body: string }> {
  return readdirSync(dir).sort().flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walkPages(full, root);
    return name.endsWith('.md') ? [{ slug: relative(root, full).replace(/\.md$/, ''), body: readFileSync(full, 'utf8') }] : [];
  });
}

/** Point gbrain's gateway at keyless transports: hash embeddings and a token-overlap reranker. Returns the reset. */
export async function useFixtureTransports(gut: GbrainUnderTest): Promise<() => void> {
  const { hashEmbedVector } = await import('../cat18-embedding-providers.ts');
  const { makeOverlapRerankTransport } = await import('../cat18b-embedding-rerank-matrix.ts');
  const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: FIXTURE_DIM, env: { OPENAI_API_KEY: 'fixture', VOYAGE_API_KEY: 'fixture' } });
  gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(t => hashEmbedVector(t, FIXTURE_DIM)), values: params.values, warnings: [] }));
  gateway.__setRerankTransportForTests(makeOverlapRerankTransport());
  return () => {
    gateway.__setEmbedTransportForTests(null);
    gateway.__setRerankTransportForTests(null);
  };
}

/** Import the fixture pages (and any extra page directory), embedded, into an engine whose schema is initialised. */
export async function ingestFixture(gut: GbrainUnderTest, engine: any, extraPagesDir?: string): Promise<void> {
  const { assertEmbedded } = await import('../import-embedded.ts');
  const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
  const pages = [...walkPages(join(FIXTURE_DIR, 'pages')), ...(extraPagesDir ? walkPages(extraPagesDir) : [])];
  for (const page of pages) assertEmbedded(await importFromContent(engine, page.slug, page.body, { noEmbed: false }), page.slug);
}

/** The public fixture as an in-memory PGLite brain with keyless transports, marked as a copy and set read-only. Phase 2 adds its own pages. */
export async function buildFixtureBrain(gut: GbrainUnderTest, extraPagesDir?: string): Promise<{ engine: any; close: () => Promise<void> }> {
  const reset = await useFixtureTransports(gut);
  const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await ingestFixture(gut, engine, extraPagesDir);
  await engine.executeRaw('CREATE TABLE public.' + COPY_MARKER_TABLE + ' (made_at timestamptz NOT NULL DEFAULT now())');
  await engine.executeRaw('SET default_transaction_read_only = on');
  return {
    engine,
    close: async () => {
      reset();
      await engine.disconnect();
    },
  };
}

/** Route every write to stdout, stderr and console into the run's local log; say() reaches the terminal. */
export function captureOutput(logPath: string): { say: (line: string) => void; restore: () => void } {
  const fd = openSync(logPath, 'a', 0o600);
  const out = process.stdout.write.bind(process.stdout);
  const saved = { out: process.stdout.write, err: process.stderr.write, log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const sink = (chunk: unknown) => { writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)); return true; };
  const line = (...args: unknown[]) => { writeSync(fd, args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n'); };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  console.log = console.info = console.warn = console.error = console.debug = line;
  return {
    say: (text: string) => { out('live-recall: ' + text + '\n'); },
    restore: () => {
      Object.assign(process.stdout, { write: saved.out });
      Object.assign(process.stderr, { write: saved.err });
      Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug });
      closeSync(fd);
    },
  };
}

/** An epoch named in the freeze, echoed only when it is one of the known words. */
const versionOrEpoch = (v: unknown) => (typeof v === 'string' && /^(pre_gbra_398|post_gbra_398|unknown)$/.test(v) ? v : 'unrecognised');

function git(args: string[]): string {
  try { return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

interface RunOptions { fixture: boolean; questionsPath?: string; freezePath?: string; databaseUrlEnv: string; out: string; gut: GbrainUnderTest; protocol?: Protocol }

/** One counted or control run. Returns the outbound file paths. */
/** pgvector in the database searched and, on a copy, the versions and restore error count snapshot.sh wrote into the marker row. */
async function copyFacts(engine: any, barrier: string) {
  const [vector] = await engine.executeRaw("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const [marker] = barrier === 'copy' ? await engine.executeRaw('SELECT to_jsonb(m) AS row FROM public.' + COPY_MARKER_TABLE + ' m LIMIT 1') : [];
  const row: Record<string, unknown> = (typeof marker?.row === 'string' ? JSON.parse(marker.row) : marker?.row) ?? {};
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : null);
  return {
    pgvector_version: versionOrNull(vector?.extversion),
    source_pgvector: versionOrNull(row.source_pgvector),
    source_server_version_num: int(row.source_server_version_num),
    copy_server_version_num: int(row.copy_server_version_num),
    restore_errors: int(row.restore_errors),
  };
}

export async function liveRecall(o: RunOptions, say: (line: string) => void): Promise<{ scorecard: string; markdown: string; detail: string }> {
  const startedAt = new Date().toISOString();
  const counters: GuardCounters = { refusals: {} };
  let questionsText: string;
  let protocol: Protocol = o.protocol ?? 'batch1';
  let frozenEpoch: { gbrain_version: string | null; visibility_epoch: string | null } | null = null;
  const runEpoch = visibilityEpoch(o.gut.version);
  if (o.fixture) questionsText = readFileSync(o.questionsPath ?? (protocol === 'batch3' ? BATCH3_FIXTURE_QUESTIONS : join(FIXTURE_DIR, 'questions.jsonl')), 'utf8');
  else {
    if (!o.questionsPath || !o.freezePath) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'a counted run needs --questions and --freeze');
    questionsText = readFileSync(o.questionsPath, 'utf8');
    const frozen = JSON.parse(readFileSync(o.freezePath, 'utf8'));
    if (frozen?.questions_sha256 !== sha256(questionsText)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'question file hash differs from the freeze');
    const frozenProtocol = frozen.protocol ?? 'batch1';
    if (!(PROTOCOLS as readonly string[]).includes(frozenProtocol)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the freeze names an unknown protocol');
    if (o.protocol && o.protocol !== frozenProtocol) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', '--protocol differs from the protocol in the freeze');
    protocol = frozenProtocol;
    if (protocol === 'batch3') {
      if (typeof frozen.visibility_epoch !== 'string') throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the batch3 freeze records no visibility_epoch');
      if (frozen.visibility_epoch !== runEpoch) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the freeze visibility_epoch ' + versionOrEpoch(frozen.visibility_epoch) + ' differs from this run\'s ' + runEpoch + ' (GBRA-398)');
      frozenEpoch = { gbrain_version: versionOrNull(frozen.gbrain_version), visibility_epoch: frozen.visibility_epoch };
    }
  }
  const questions = parseQuestions(questionsText, protocol);

  let engine: any, barrier: string, connection: string, schemaVersion: number, close: () => Promise<void>;
  if (o.fixture) {
    const brain = await buildFixtureBrain(o.gut, protocol === 'batch3' ? BATCH3_FIXTURE_PAGES : undefined);
    engine = brain.engine;
    barrier = 'copy';
    connection = 'in_process';
    close = brain.close;
    installGuards(engine, counters);
    await verifyReadOnly(engine);
    schemaVersion = (await checkSchema(engine, o.gut)).schema_version;
  } else {
    const brain = await openPostgresBrain(o.gut, o.databaseUrlEnv, counters);
    ({ engine, barrier, connection, close } = brain);
    schemaVersion = brain.schema_version;
  }
  say('gbrain ' + o.gut.version + ', schema ' + schemaVersion + ', barrier ' + barrier + ', connection ' + connection + '; read-only verified');
  try {
    const facts = await copyFacts(engine, barrier);
    const { loadSearchModeConfig, resolveSearchMode } = await importGbrain<any>(o.gut, 'src/core/search/mode.ts');
    const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
    if (knobs.reranker_enabled && String(knobs.reranker_model).startsWith('typesafe:')) throw new LiveRecallAbort('LR_RERANK_NEEDS_TYPESAFE', 'configured reranker is a TypeSafe recipe');
    const { hybridSearch } = await importGbrain<any>(o.gut, 'src/core/search/hybrid.ts');
    const { withAIInvocationGuard } = await importGbrain<any>(o.gut, 'src/core/ai/invocation-guard.ts');
    const { factEmbeddingDisabled } = await importGbrain<any>(o.gut, 'src/core/embedding-disabled.ts');
    const { getEmbeddingModelProvenance } = await importGbrain<any>(o.gut, 'src/core/ai/gateway.ts');
    const embeddingModel: string | null = getEmbeddingModelProvenance();
    if (!embeddingModel) throw new LiveRecallAbort('LR_EMBEDDING_UNVERIFIED', 'no explicit embedding_model in the loaded gbrain config');
    const { loadConfig, loadConfigWithEngine } = await importGbrain<any>(o.gut, 'src/core/config.ts');
    const { resolveEmbeddingColumn } = await importGbrain<any>(o.gut, 'src/core/search/embedding-column.ts');
    const { resolveVectorLegacyGuard } = await importGbrain<any>(o.gut, 'src/core/search/vector-legacy-guard.ts');
    const { resolveHnswIterativeScan } = await importGbrain<any>(o.gut, 'src/core/search/hnsw-iterative-scan.ts');
    const columnConfig = (await loadConfigWithEngine(engine).catch(() => null)) ?? loadConfig() ?? null;
    const column = resolveEmbeddingColumn(undefined, columnConfig ?? { engine: 'pglite' });
    const vectorOpts = { embeddingColumn: column, vectorLegacyGuard: resolveVectorLegacyGuard(engine, columnConfig), hnswIterativeScan: resolveHnswIterativeScan(engine, columnConfig) };
    const ctx: SearchContext = { engine, hybridSearch, withGuard: withAIInvocationGuard, rerankerEnabled: knobs.reranker_enabled, embeddingOptedOut: await factEmbeddingDisabled(engine), vectorOpts };
    if (!ctx.embeddingOptedOut) {
      const { embed } = await importGbrain<any>(o.gut, 'src/core/ai/gateway.ts');
      const embedOnly = async (call: { kind: Kind }) => {
        if (call.kind !== 'embedding') throw new Error('live-recall refused a ' + call.kind + ' call');
        return { settle: async () => {} };
      };
      try {
        await withAIInvocationGuard(embedOnly, () => embed(['live-recall preflight']));
      } catch {
        throw new LiveRecallAbort('LR_EMBEDDING_UNAVAILABLE', 'one preflight query embedding failed');
      }
    }

    await armPreflight(ctx);
    say('arm preflight passed: one public probe query ran clean through every arm');
    const { kept, missing } = await presenceCheck(engine, questions);
    say(questions.length + ' questions loaded, ' + missing + ' with an absent gold page; arms ' + ARMS.join(','));
    const records = await runQuestions(ctx, kept, done => { if (done % 10 === 0 || done === kept.length) say(done + '/' + kept.length + ' questions'); });
    await verifyReadOnly(engine);

    const pinCommit = (gbrainPin().split('#')[1] ?? 'unknown').toLowerCase();
    const identity = {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      runner_commit: git(['rev-parse', 'HEAD']) || 'unknown',
      runner_dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '',
      gbrain_pin_version: JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/gbrain/package.json'), 'utf8')).version,
      gbrain_pin_commit: /^[0-9a-f]{7,64}$/.test(pinCommit) ? pinCommit : 'unknown',
      gbrain_loaded_version: o.gut.version,
      gbrain_loaded_commit: o.gut.overlay?.build.commit ?? (/^[0-9a-f]{7,64}$/.test(pinCommit) ? pinCommit : 'unknown'),
      gbrain_overlay: o.gut.overlay !== null,
      schema_version: schemaVersion,
      engine: (o.fixture ? 'pglite' : 'postgres') as 'pglite' | 'postgres',
      barrier,
      connection,
      search_mode: String(knobs.resolved_mode),
      reranker_enabled: Boolean(knobs.reranker_enabled),
      reranker_model: String(knobs.reranker_model),
      embedding_model: embeddingModel,
      embedding_column: /^[a-z_][a-z0-9_]{0,62}$/.test(String(column.name)) ? String(column.name) : 'unknown',
      mode_expansion: Boolean(knobs.expansion),
      control: o.fixture,
      ...facts,
      ...(protocol === 'batch3' ? { visibility_epoch: runEpoch, freeze_gbrain_version: frozenEpoch?.gbrain_version ?? null, freeze_visibility_epoch: frozenEpoch?.visibility_epoch ?? null } : {}),
    };
    const summary = {
      loaded: questions.length,
      gold_missing: missing,
      by_type: Object.fromEntries(PROTOCOL_TYPES[protocol].map(t => [t, kept.filter(q => q.type === t).length])),
      gold_found_by: Object.fromEntries(GOLD_FOUND_BY.map(g => [g, kept.filter(q => q.gold_found_by === g).length])),
      paraphrase_shares_identifier_token: paraphraseOverlapShare(kept),
      freeze_sha_prefix: sha256(questionsText).slice(0, 12),
    };
    mkdirSync(o.out, { recursive: true });
    const detail = join(o.out, 'detail.local.jsonl');
    writeFileSync(detail, records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    const scorecard = buildScorecard(records, summary, identity, { readonly_verified_start: true, readonly_verified_end: true, guard_refusals: counters.refusals }, protocol);
    const json = JSON.stringify(scorecard, null, 2) + '\n';
    const markdown = renderMarkdown(scorecard);
    const needles = new Set<string>([...questions.flatMap(q => [...Object.values(q.forms), ...q.gold.map(g => g.slug), ...(q.stale ?? []).map(s => s.slug)]), ...records.flatMap(r => r.pages)]);
    scanForLeaks(json + markdown, needles);
    const jsonPath = join(o.out, 'scorecard.json'), mdPath = join(o.out, 'scorecard.md');
    writeFileSync(jsonPath, json);
    writeFileSync(mdPath, markdown);
    return { scorecard: jsonPath, markdown: mdPath, detail };
  } finally {
    await close();
  }
}

function loadRunDir(dir: string) {
  const card = JSON.parse(readFileSync(join(dir, 'scorecard.json'), 'utf8'));
  const records = readFileSync(join(dir, 'detail.local.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as QueryRecord);
  const identity = { gbrain_loaded_version: card.run.gbrain_loaded_version, gbrain_loaded_commit: card.run.gbrain_loaded_commit, barrier: card.run.barrier, control: card.run.control, freeze_sha_prefix: card.questions.freeze_sha_prefix };
  const invalid = ARMS.filter(arm => card.arms?.[arm]?.invalid);
  return { card, identity, records, invalid };
}

function refuseControl(runA: ReturnType<typeof loadRunDir>, runB: ReturnType<typeof loadRunDir>) {
  if (runA.identity.control === true || runB.identity.control === true) throw new LiveRecallAbort('LR_COMPARE_CONTROL', (runA.identity.control === true ? 'run_a' : 'run_b') + ' is a fixture control run');
}

/** Pair two run directories, refusing runs on different question files or a fixture control, and skipping an arm invalid in either; compare.json carries each run's identity. */
export function compareRunDirs(a: string, b: string) {
  const runA = loadRunDir(a), runB = loadRunDir(b);
  if (runA.identity.freeze_sha_prefix !== runB.identity.freeze_sha_prefix) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'run_a and run_b were made on different question files (freeze_sha_prefix differs)');
  refuseControl(runA, runB);
  const { schema, comparisons } = compareRuns(runA.records, runB.records, new Set([...runA.invalid, ...runB.invalid]));
  const result = { schema, run_a: runA.identity, run_b: runB.identity, comparisons };
  validateScorecard(result);
  return result;
}

/** Run settings two pooled runs must share, so the pool measures one gbrain configuration. */
const POOL_SAME = ['gbrain_loaded_commit', 'search_mode', 'reranker_enabled', 'reranker_model', 'embedding_model', 'embedding_column'] as const;

/** Pool two counted runs on independent question files made with the same gbrain and search settings; pool.json carries each run's identity and secondary comparisons only. */
export function poolRunDirs(a: string, b: string) {
  const runA = loadRunDir(a), runB = loadRunDir(b);
  if (runA.identity.freeze_sha_prefix === runB.identity.freeze_sha_prefix) throw new LiveRecallAbort('LR_POOL_MISMATCH', 'run_a and run_b were made on the same question file');
  refuseControl(runA, runB);
  const differs = POOL_SAME.filter(field => runA.card.run[field] !== runB.card.run[field]);
  if (differs.length) throw new LiveRecallAbort('LR_POOL_MISMATCH', 'run_a and run_b differ in ' + differs.join(', '));
  const result = { ...poolRuns(runA.records, runB.records, new Set([...runA.invalid, ...runB.invalid])), run_a: runA.identity, run_b: runB.identity };
  validateScorecard(result);
  return result;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const protocol = flag(argv, '--protocol');
  if (protocol !== undefined && !(PROTOCOLS as readonly string[]).includes(protocol)) { console.error('usage: --protocol ' + PROTOCOLS.join('|')); return 2; }
  if (command === 'freeze') {
    const path = flag(argv, '--questions'), out = flag(argv, '--out');
    if (!path || !out) { console.error('usage: run.ts freeze --questions <file> --out <freeze.json> [--protocol ' + PROTOCOLS.join('|') + ']'); return 2; }
    const text = readFileSync(path, 'utf8');
    const p = (protocol ?? 'batch1') as Protocol;
    const summary = p === 'batch3' ? freezeSummaryBatch3(text, parseQuestions(text, p), resolveGbrainUnderTest(gbrainSpecFrom(argv))) : freezeSummary(text, parseQuestions(text, p), p);
    writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
    console.log('live-recall: freeze ' + out + ' (' + summary.n_questions + ' questions, protocol ' + summary.protocol + ')');
    return 0;
  }
  if (command === 'compare' || command === 'pool') {
    const a = flag(argv, '--a'), b = flag(argv, '--b'), out = flag(argv, '--out');
    if (!a || !b || !out) { console.error('usage: run.ts ' + command + ' --a <run dir> --b <run dir> --out <dir> (refuses with ' + (command === 'compare' ? 'LR_FREEZE_MISMATCH' : 'LR_POOL_MISMATCH') + ' or LR_COMPARE_CONTROL)'); return 2; }
    let result;
    try {
      result = command === 'compare' ? compareRunDirs(a, b) : poolRunDirs(a, b);
    } catch (error) {
      if (!(error instanceof LiveRecallAbort)) throw error;
      console.error('live-recall: ABORT ' + error.code + ': ' + error.detail);
      console.error('live-recall: fix: ' + ABORT_CODES[error.code] + ' (docs/benchmarks/live-recall/RUN-KIT.md#' + error.code.toLowerCase() + ')');
      return 3;
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, command + '.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('live-recall: ' + command + ' ' + join(out, command + '.json'));
    return 0;
  }
  if (command !== 'run') { console.error('usage: run.ts run|freeze|compare|pool (see the header of this file)'); return 2; }
  const fixture = argv.includes('--fixture');
  const out = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/live-recall', new Date().toISOString().replace(/[:.]/g, '-') + (fixture ? '-fixture' : '')));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  process.env.GBRAIN_AUDIT_DIR = out;
  const { say, restore } = captureOutput(join(out, 'gbrain.local.log'));
  try {
    const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
    const paths = await liveRecall({ fixture, questionsPath: flag(argv, '--questions'), freezePath: flag(argv, '--freeze'), databaseUrlEnv: flag(argv, '--database-url-env') ?? 'LIVE_RECALL_DATABASE_URL', out, gut, protocol: protocol as Protocol | undefined }, say);
    say('scorecard (send these two files): ' + paths.scorecard + ' and ' + paths.markdown);
    say('detail and gbrain log (stay on this box): ' + paths.detail + ' and ' + join(out, 'gbrain.local.log'));
    return 0;
  } catch (error) {
    if (error instanceof LiveRecallAbort) {
      say('ABORT ' + error.code + ': ' + error.detail);
      say('fix: ' + ABORT_CODES[error.code] + ' (docs/benchmarks/live-recall/RUN-KIT.md#' + error.code.toLowerCase() + '). Side effects: none outside ' + out + '.');
      return 3;
    }
    say('ABORT LR_INTERNAL: ' + (error instanceof Error ? error.name : 'unknown') + '; the full message is in ' + join(out, 'gbrain.local.log') + ', which stays on this box.');
    console.error(error instanceof Error ? error.stack : String(error));
    return 4;
  } finally {
    restore();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
