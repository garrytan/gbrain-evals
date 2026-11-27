#!/usr/bin/env bun
/**
 * Live recall: recall@k and per-query-type retrieval ablations on a private
 * question set, run on the box that holds the brain. Only an aggregate
 * scorecard leaves that box.
 *
 *   bun eval/runner/live-recall/run.ts run --fixture
 *   bun eval/runner/live-recall/run.ts run --synthetic <dir from eval/generators/conditions-recall-gen.ts or batch3-synthetic-gen.ts> [--protocol batch3] [--out <dir>]
 *     [--paid --budget-run-id <id> [--budget-ledger <path>]]   (Voyage embeddings and rerank; see synthetic.ts)
 *   bun eval/runner/live-recall/run.ts freeze --questions <private.jsonl> --out <freeze.json> [--protocol batch1|batch2|batch3|batch4|batch5] [--gbrain <checkout>@<commit>]
 *     [--prior <batch 1 file> --prior <batch 2 file> --prior <batch 3 file> [--prior <batch 4 file>]]   (batch4 and batch5 only, required: the held-out check)
 *   bun eval/runner/live-recall/run.ts run --questions <private.jsonl> --freeze <freeze.json> \
 *     --gbrain <gbrain checkout>@<commit> [--database-url-env LIVE_RECALL_DATABASE_URL] [--out <dir>] [--reference-build]
 *   bun eval/runner/live-recall/run.ts compare --a <run dir> --b <run dir> --out <dir>
 *   bun eval/runner/live-recall/run.ts pool --a <run dir> --b <run dir> --out <dir>
 *
 * --fixture builds the public 30-page fixture brain in memory with hash
 * embeddings and a token-overlap reranker (with --questions, it asks those
 * questions of the fixture instead of its own; with --protocol, it scores them
 * under that protocol; --protocol batch3 alone adds the public freshness and
 * entity questions and their pages): a keyless harness control whose numbers say nothing
 * about search quality. --synthetic scores the same six arms on a generated
 * conditions-recall brain (G2: unembedded chunks, synopsis vectors off, a keyword
 * candidate bound, shell pages) or a batch-3 brain, also keyless and also a
 * control (run.transports: hash). With --paid --budget-run-id it embeds and
 * reranks with Voyage instead (run.transports: voyage), after printing an
 * estimate, with every request reserved and settled on the budget ledger and
 * nothing sent to any host but api.voyageai.com. A counted run takes its protocol from the freeze. A real run opens a Postgres brain
 * only after brain.ts proves a server-side read-only barrier; --reference-build lets a build brain.ts names as a
 * reference read a brain whose schema is newer than it expects. Every --fixture and real-brain run also starts
 * `run.ts keyless-arm`, the search_op_keyless arm in a process of its own with no provider key. The run kit,
 * abort codes and scorecard format are in docs/benchmarks/live-recall/.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { rankOfFirstHit, recallAllAtK, uniqueInOrder } from '../metrics.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { gbrainPin } from '../gbrain-version.ts';
import { normalQuantile } from '../stats/paired.ts';
import { ABORT_CODES, COPY_MARKER_TABLE, LiveRecallAbort, assertReferenceBuild, checkSchema, installGuards, openPostgresBrain, verifyReadOnly, type GuardCounters } from './brain.ts';
import { visibilityEpoch } from './visibility-epoch.ts';
import type { Transports } from './synthetic.ts';
import { budgetOptionsFrom, receiptCost, startPaidRun } from '../budget-ledger.ts';
import { PaidArmRefusal, paidRequested, requirePaidArm } from '../paid-arm.ts';
import { ALL_TYPES, ARMS, EPOCH_PROTOCOLS, FILL_ALPHA, FILL_MIN_WINS, FORMS, GOLD_FOUND_BY, KEYLESS_ARM, KS, PROTOCOLS, PROTOCOL_TYPES, TYPES, buildScorecard, compareRuns, poolRuns, renderMarkdown, scanForLeaks, validateScorecard, versionOrNull, type Arm, type Form, type KeylessRecord, type Protocol, type QType, type QueryRecord, type Status } from './scorecard.ts';

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
  /** batch3 entity only, optional: the look-alike pages a wrong answer would come from. */
  decoy?: Array<{ slug: string }>;
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
    let decoy: Question['decoy'];
    if (protocol === 'batch3') {
      if (q.type === 'freshness') {
        if (!Array.isArray(q.stale) || q.stale.length === 0) throw bad('stale');
        stale = q.stale.map((s: any, j: number) => {
          if (typeof s?.slug !== 'string' || !s.slug.trim() || gold.some((g: { slug: string }) => g.slug === s.slug)) throw bad('stale[' + j + '].slug');
          return { slug: s.slug };
        });
      } else if (q.stale !== undefined) throw bad('stale');
      if (q.type === 'entity' && q.decoy !== undefined) {
        if (!Array.isArray(q.decoy) || q.decoy.length === 0) throw bad('decoy');
        decoy = q.decoy.map((s: any, j: number) => {
          if (typeof s?.slug !== 'string' || !s.slug.trim() || gold.some((g: { slug: string }) => g.slug === s.slug)) throw bad('decoy[' + j + '].slug');
          return { slug: s.slug };
        });
      } else if (q.decoy !== undefined) throw bad('decoy');
    }
    ids.add(q.id);
    out.push({ id: q.id, type: q.type, forms, gold, gold_found_by: foundBy, ...(window ? { window } : {}), ...(stale ? { stale } : {}), ...(decoy ? { decoy } : {}) });
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
export function freezeSummary(text: string, questions: Question[], protocol: 'batch1' | 'batch2' = 'batch1') {
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

/** The earlier question files a batch 4 freeze is checked against, from the frozen samples in live-recall PREREGISTRATION.md. */
export const PRIOR_QUESTION_FILES: ReadonlyArray<{ batch: string; protocol: Protocol; sha256: string }> = [
  { batch: 'batch1', protocol: 'batch1', sha256: '88eaa30c34d85d303aff2a0faf81e9adfe6a5815dadc5196879c827e6f02ae9f' },
  { batch: 'batch2', protocol: 'batch2', sha256: 'dd69701c55534429fb758ca8335af175a3dfcc3c9aca6c9c2d2fc81bf3f11099' },
  { batch: 'batch3', protocol: 'batch3', sha256: 'c023694ef59e03e64fd1b0553b6516f7bccad424b85f0f74bdf95d2a08b6014e' },
];

/** The earlier question files a batch 5 freeze is checked against: batch 4's three and batch 4 itself. */
export const BATCH5_PRIOR_QUESTION_FILES: ReadonlyArray<{ batch: string; protocol: Protocol; sha256: string }> = [
  ...PRIOR_QUESTION_FILES,
  { batch: 'batch4', protocol: 'batch4', sha256: '69f923673764fc11aa501a4d3b0efae53ff7d2ec8ce806a32176472662b3ca04' },
];

/** The protocols whose freeze is a held-out check, and the earlier files each is checked against. */
export const HELD_OUT_PRIORS: Partial<Record<Protocol, ReadonlyArray<{ batch: string; protocol: Protocol; sha256: string }>>> = { batch4: PRIOR_QUESTION_FILES, batch5: BATCH5_PRIOR_QUESTION_FILES };

const normalForm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * What a new question set shares with the earlier ones: question ids, forms that match an earlier exact or paraphrase
 * form after folding case, spacing and punctuation, and distinct gold pages that were an earlier gold, stale or decoy
 * page. The earlier files must be exactly the expected ones, by sha256. Counts only; nothing private is returned.
 */
export function priorOverlap(questions: Question[], priorTexts: string[], expected: ReadonlyArray<{ protocol: Protocol; sha256: string }> = PRIOR_QUESTION_FILES) {
  const byHash = new Map(priorTexts.map(text => [sha256(text), text]));
  const missing = expected.filter(p => !byHash.has(p.sha256));
  if (missing.length || byHash.size !== expected.length || priorTexts.length !== expected.length) {
    throw new LiveRecallAbort('LR_FREEZE_OVERLAP', 'the freeze needs exactly the ' + expected.length + ' earlier question files, one --prior each (missing sha256 ' + (missing.map(p => p.sha256.slice(0, 12)).join(', ') || 'none') + ', ' + priorTexts.length + ' given, ' + byHash.size + ' distinct)');
  }
  const prior = expected.flatMap(p => parseQuestions(byHash.get(p.sha256)!, p.protocol));
  const ids = new Set(prior.map(q => q.id));
  const forms = new Set(prior.flatMap(q => Object.values(q.forms).map(normalForm)).filter(Boolean));
  const pages = new Set(prior.flatMap(q => [...q.gold, ...(q.stale ?? []), ...(q.decoy ?? [])].map(g => g.slug)));
  return {
    files: expected.map(p => p.sha256),
    question_ids: questions.filter(q => ids.has(q.id)).length,
    forms: questions.flatMap(q => Object.values(q.forms).map(normalForm)).filter(f => f && forms.has(f)).length,
    gold_pages: new Set(questions.flatMap(q => q.gold.map(g => g.slug)).filter(s => pages.has(s))).size,
  };
}

/**
 * The batch 4 freeze (the G2 held-out replication): batch 2's counts and minimum detectable differences, plus G2's
 * primary, the gbrain version and visibility epoch as for batch 3, and a held-out check against the earlier question
 * files. Any shared question id, form or gold page refuses the freeze (LR_FREEZE_OVERLAP) and nothing is written.
 */
export function freezeSummaryBatch4(text: string, questions: Question[], gbrain: { version: string }, overlap: ReturnType<typeof priorOverlap>) {
  if (overlap.question_ids || overlap.forms || overlap.gold_pages) {
    throw new LiveRecallAbort('LR_FREEZE_OVERLAP', 'the new questions share ' + overlap.question_ids + ' question ids, ' + overlap.forms + ' forms and ' + overlap.gold_pages + ' gold pages with the earlier batches');
  }
  const base = freezeSummary(text, questions, 'batch2');
  return {
    ...base,
    protocol: 'batch4' as const,
    gbrain_version: gbrain.version,
    visibility_epoch: visibilityEpoch(gbrain.version),
    prior_question_files: overlap.files,
    prior_overlap: { question_ids: 0, forms: 0, gold_pages: 0 },
    mde_success_at_5: { ...base.mde_success_at_5, g2_primary_paraphrase_vs_exact_configured: byPd(pd => mde(questions.length, pd)) },
  };
}

/**
 * The batch 5 freeze (the paraphrase gap at gbrain's newest release, and the keyless fill's primary): batch 4's freeze,
 * checked against the four earlier question files, plus the fill primary's threshold. Fill rows only follow the rows
 * returned without them, so its exact one-sided sign test holds at FILL_MIN_WINS wins with no losses, whatever N is.
 */
export function freezeSummaryBatch5(text: string, questions: Question[], gbrain: { version: string }, overlap: ReturnType<typeof priorOverlap>) {
  return {
    ...freezeSummaryBatch4(text, questions, gbrain, overlap),
    protocol: 'batch5' as const,
    fill_primary: { test: 'exact_one_sided_sign', alpha: FILL_ALPHA, min_wins_no_losses: FILL_MIN_WINS, smallest_detectable_paraphrase: Math.round((FILL_MIN_WINS / questions.length) * 10000) / 10000 },
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

interface Gold { pages: Set<string>; chunks: Set<string>; stale?: Set<string>; decoy?: Set<string> }

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
  const decoyRank = gold.decoy ? rankOfFirstHit(pages, gold.decoy) : Infinity;
  return {
    ...base, arm, status, pages, chunks,
    page_rank: Number.isFinite(pageRank) ? pageRank : null,
    chunk_rank: Number.isFinite(chunkRank) ? chunkRank : null,
    all_found_at: Object.fromEntries(KS.map(k => ['k' + k, recallAllAtK(pages, gold.pages, k) === 1])),
    ms, returned: pages.length, calls, degraded_stages: degraded,
    ...(gold.stale ? { stale_rank: Number.isFinite(staleRank) ? staleRank : null } : {}),
    ...(gold.decoy ? { decoy_rank: Number.isFinite(decoyRank) ? decoyRank : null } : {}),
  };
}

/** Every arm for every question form, sequentially. The hybrid arm runs first so vector reuses its query embedding. */
export async function runQuestions(ctx: SearchContext, questions: Question[], progress?: (done: number) => void): Promise<QueryRecord[]> {
  const records: QueryRecord[] = [];
  const hybridOpts = { limit: CHUNK_FETCH, expansion: false, crossModal: 'text', autocut: false, reranker: { enabled: false, topNIn: 25, topNOut: null } };
  for (const [i, q] of questions.entries()) {
    const gold: Gold = { pages: new Set(q.gold.map(g => g.slug)), chunks: new Set(q.gold.flatMap(g => (g.chunk_ids ?? []).map(String))), ...(q.stale ? { stale: new Set(q.stale.map(s => s.slug)) } : {}), ...(q.decoy ? { decoy: new Set(q.decoy.map(s => s.slug)) } : {}) };
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

/**
 * Every environment variable gbrain's provider recipes read for a key, account or endpoint, plus anything named like a
 * key: the search_op_keyless process gets each of them blank and its gateway none of them.
 */
export async function providerEnvNames(gut: GbrainUnderTest): Promise<Set<string>> {
  const { listRecipes } = await importGbrain<any>(gut, 'src/core/ai/recipes/index.ts');
  const names = new Set<string>((listRecipes() as Array<{ auth_env?: { required?: string[]; optional?: string[] } }>).flatMap(r => [...(r.auth_env?.required ?? []), ...(r.auth_env?.optional ?? [])]));
  for (const name of Object.keys(process.env)) if (/(_API_KEY|_TOKEN|_SECRET)$/.test(name)) names.add(name);
  return names;
}

/**
 * Turn the loaded gbrain keyless: no test transports, and a gateway configured with every provider variable removed.
 * Returns the check the arm runs before its preflight and before every query: gbrain must report no embedding provider
 * (for the brain's own model and any multimodal one) and no reranker, or the process stops with LR_KEYLESS_PROVIDER.
 */
export async function makeKeyless(gut: GbrainUnderTest, names: Set<string>): Promise<() => void> {
  const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  gateway.__setEmbedTransportForTests(null);
  gateway.__setRerankTransportForTests(null);
  const config = gateway.requireConfig();
  gateway.configureGateway({ ...config, env: Object.fromEntries(Object.entries(config.env ?? {}).filter(([k]) => !names.has(k) && !/(KEY|TOKEN|SECRET)/i.test(k))) });
  const multimodal = await importGbrain<any>(gut, 'src/core/ai/multimodal-model.ts').then(m => m.multimodalEmbeddingModel?.() ?? null).catch(() => null);
  return () => {
    const embedding = gateway.isAvailable('embedding', gateway.getEmbeddingModelProvenance() ?? undefined) || (multimodal !== null && gateway.isAvailable('embedding', multimodal));
    if (embedding || gateway.isAvailable('reranker')) throw new LiveRecallAbort('LR_KEYLESS_PROVIDER', 'gbrain reports an ' + (embedding ? 'embedding' : 'reranking') + ' provider in the keyless process');
  };
}

/**
 * Pages from a search-operation response's rows in order, with and without the rows gbrain marked keyword_fill, and
 * the fill's exposure: how many fill rows, whether a page only a fill row brought is in the first five, and whether a
 * fill row came before a row without the flag.
 */
export function keylessPages(rows: ReadonlyArray<{ slug?: unknown; keyword_fill?: unknown }>, gold: ReadonlySet<string>) {
  const pagesOf = (xs: typeof rows) => uniqueInOrder(xs.map(r => String(r.slug))).slice(0, PAGE_DEPTH);
  const rank = (p: string[]) => { const k = rankOfFirstHit(p, gold); return Number.isFinite(k) ? k : null; };
  const allFound = (p: string[]) => Object.fromEntries(KS.map(k => ['k' + k, recallAllAtK(p, gold, k) === 1]));
  const pages = pagesOf(rows), offPages = pagesOf(rows.filter(r => r.keyword_fill !== true));
  return {
    pages, page_rank: rank(pages), all_found_at: allFound(pages), returned: pages.length,
    fill_off: { pages: offPages, page_rank: rank(offPages), all_found_at: allFound(offPages) },
    fill_rows: rows.filter(r => r.keyword_fill === true).length,
    fill_in_top5: pages.slice(0, 5).some(p => !offPages.includes(p)),
    prefix_broken: rows.some((r, i) => r.keyword_fill === true && rows.slice(i + 1).some(x => x.keyword_fill !== true)),
  };
}

/**
 * The seventh arm (batch 5 amendment): gbrain's search operation through gbrain's own dispatcher as a trusted local
 * caller, the way `gbrain search "<question>"` runs it, with the question as its only parameter. It runs only in the
 * search_op_keyless process (keylessArm). The AI guard refuses every model call. On the keyless path gbrain always
 * reports embed_unavailable, so a response without it, with no retrieval meta, or with any other failure stage is
 * degraded. fill_off is the same response without the rows gbrain marked keyword_fill, which gbrain returns only when
 * the other rows are exactly its fill-off response (chooseFill in src/core/ops/search-fill.ts).
 */
export async function runKeylessQuestions(gut: GbrainUnderTest, engine: any, questions: Question[], check: () => void = () => {}): Promise<KeylessRecord[]> {
  const [dispatch, invocation] = await Promise.all([importGbrain<any>(gut, 'src/mcp/dispatch.ts'), importGbrain<any>(gut, 'src/core/ai/invocation-guard.ts')]);
  const records: KeylessRecord[] = [];
  for (const q of questions) {
    const gold = new Set(q.gold.map(g => g.slug));
    for (const form of FORMS) {
      check();
      const calls: Record<string, number> = {};
      let refused = false;
      let meta: any = null;
      let rows: Array<{ slug?: unknown; keyword_fill?: unknown }> = [];
      let status: Status = 'ok';
      const guard = async (call: { kind: Kind }) => {
        calls[call.kind] = (calls[call.kind] ?? 0) + 1;
        refused = true;
        throw new Error('live-recall refused a ' + call.kind + ' call');
      };
      const metaHook = async (_name: string, c: { emitResponseMeta?: (k: string, v: unknown) => void }) => {
        const previous = c.emitResponseMeta;
        c.emitResponseMeta = (k, v) => { if (k === 'retrieval') meta = v; previous?.(k, v); };
        return undefined;
      };
      const t0 = performance.now();
      try {
        const r = await invocation.withAIInvocationGuard(guard, () => dispatch.dispatchToolCall(engine, 'search', { query: q.forms[form] }, { remote: false, transport: 'stdio', metaHook }));
        const parsed = r?.isError ? null : JSON.parse(r?.content?.[0]?.text ?? 'null');
        if (Array.isArray(parsed)) rows = parsed;
        else status = 'error';
      } catch {
        status = 'error';
      }
      const ms = Math.round(performance.now() - t0);
      if (refused) status = 'ai_refused';
      const degraded = ((meta?.degraded ?? []) as Array<{ stage?: unknown }>).map(d => String(d.stage)).filter(s => /^[a-z_]+$/.test(s));
      if (status === 'ok' && (meta === null || !degraded.includes('embed_unavailable') || degraded.some(s => s !== 'embed_unavailable' && FAILURE_STAGES.has(s)))) status = 'degraded';
      records.push({ qid: q.id, type: q.type, form, arm: KEYLESS_ARM, status, chunks: [], chunk_rank: null, gold_pages: gold.size, has_chunk_gold: false, ms, calls, degraded_stages: degraded, ...keylessPages(rows, gold) });
    }
  }
  return records;
}

/**
 * The search_op_keyless process (`run.ts keyless-arm`, started only by liveRecall): every provider variable blank,
 * every HTTP request refused, the same brain opened the same way, gbrain's gateway made keyless and checked, one public
 * probe through the arm, then every kept question. Writes keyless.local.jsonl, or keyless.abort.json naming the abort
 * code, into the run directory; gbrain's output goes to keyless.local.log there.
 */
async function keylessArm(argv: string[]): Promise<number> {
  const out = flag(argv, '--out'), questionsPath = flag(argv, '--questions');
  if (!out || !questionsPath) { console.error('usage: run.ts keyless-arm is started by run.ts run'); return 2; }
  const protocol = (flag(argv, '--protocol') ?? 'batch1') as Protocol;
  const { restore } = captureOutput(join(out, 'keyless.local.log'));
  globalThis.fetch = (async (input: RequestInfo | URL) => { throw new Error('the keyless search-operation process sends no HTTP request; refused ' + new URL(input instanceof Request ? input.url : String(input)).hostname); }) as unknown as typeof fetch;
  try {
    const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
    const names = await providerEnvNames(gut);
    for (const name of names) process.env[name] = '';
    process.env.GBRAIN_MODEL_DISCOVERY = 'off';
    const counters: GuardCounters = { refusals: {} };
    const brain = argv.includes('--fixture')
      ? await buildFixtureBrain(gut, protocol === 'batch3' ? BATCH3_FIXTURE_PAGES : undefined)
      : await openPostgresBrain(gut, flag(argv, '--database-url-env') ?? 'LIVE_RECALL_DATABASE_URL', counters, argv.includes('--reference-build'), join(out, 'keyless-gbrain-home'));
    try {
      if (argv.includes('--fixture')) { installGuards(brain.engine, counters); await verifyReadOnly(brain.engine); }
      const check = await makeKeyless(gut, names);
      const probe: Question = { id: 'preflight', type: 'topic', forms: { exact: PREFLIGHT_PROBE, paraphrase: PREFLIGHT_PROBE }, gold: [{ slug: 'live-recall-preflight' }], gold_found_by: 'unknown' };
      const failed = (await runKeylessQuestions(gut, brain.engine, [probe], check)).find(r => r.status !== 'ok');
      if (failed) throw new LiveRecallAbort('LR_ARM_PREFLIGHT', KEYLESS_ARM + ' ' + failed.status);
      const { kept } = await presenceCheck(brain.engine, parseQuestions(readFileSync(questionsPath, 'utf8'), protocol));
      const records = await runKeylessQuestions(gut, brain.engine, kept, check);
      check();
      await verifyReadOnly(brain.engine);
      writeFileSync(join(out, 'keyless.local.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
      return 0;
    } finally {
      await brain.close();
    }
  } catch (error) {
    writeFileSync(join(out, 'keyless.abort.json'), JSON.stringify({ code: error instanceof LiveRecallAbort ? error.code : 'LR_KEYLESS_ARM' }) + '\n', { mode: 0o600 });
    console.error(error instanceof Error ? error.stack : String(error));
    return 3;
  } finally {
    restore();
  }
}

/**
 * Start the search_op_keyless process for this run and read its records. It runs before this process opens the brain,
 * with every provider variable blank and the same gbrain, questions, protocol, database variable and barrier. A process
 * that stops ends the run with its abort code, before any other arm searches.
 */
async function runKeylessChild(o: RunOptions, questionsPath: string, protocol: Protocol): Promise<KeylessRecord[]> {
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const recordsPath = join(o.out, 'keyless.local.jsonl'), abortPath = join(o.out, 'keyless.abort.json');
  rmSync(recordsPath, { force: true });
  rmSync(abortPath, { force: true });
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_MODEL_DISCOVERY: 'off' };
  for (const name of await providerEnvNames(o.gut)) env[name] = '';
  delete env.GBRAIN_UNDER_TEST;
  const args = [join(REPO_ROOT, 'eval/runner/live-recall/run.ts'), 'keyless-arm', '--questions', questionsPath, '--protocol', protocol, '--out', o.out, '--database-url-env', o.databaseUrlEnv,
    ...(o.gut.overlay ? ['--gbrain', o.gut.overlay.requested] : []), ...(o.fixture ? ['--fixture'] : []), ...(o.referenceBuild ? ['--reference-build'] : [])];
  const child = spawnSync(process.execPath, args, { env, stdio: 'ignore', cwd: REPO_ROOT, timeout: 3_600_000 });
  if (child.status === 0 && existsSync(recordsPath)) return readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as KeylessRecord);
  const code = existsSync(abortPath) ? JSON.parse(readFileSync(abortPath, 'utf8')).code : null;
  throw new LiveRecallAbort(typeof code === 'string' && code in ABORT_CODES ? code as keyof typeof ABORT_CODES : 'LR_KEYLESS_ARM', 'the ' + KEYLESS_ARM + ' process stopped with exit ' + (child.status ?? 'none'));
}

/** Drop questions whose gold pages (or, under batch 3, stale or decoy pages) the brain does not hold; abort past the cap. */
export async function presenceCheck(engine: any, questions: Question[]): Promise<{ kept: Question[]; missing: number }> {
  const kept: Question[] = [];
  for (const q of questions) {
    let present = true;
    for (const g of [...q.gold, ...(q.stale ?? []), ...(q.decoy ?? [])]) if (!(await engine.getPage(g.slug))) present = false;
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

/**
 * Point gbrain's gateway at keyless transports: hash embeddings and a token-overlap reranker. It also sets
 * GBRAIN_MODEL_DISCOVERY=off, since gbrain otherwise lists models at api.openai.com before its first OpenAI-routed
 * embedding, which would be a network request from a keyless run. Returns the reset.
 */
export async function useFixtureTransports(gut: GbrainUnderTest): Promise<() => void> {
  const { hashEmbedVector } = await import('../cat18-embedding-providers.ts');
  const { makeOverlapRerankTransport } = await import('../cat18b-embedding-rerank-matrix.ts');
  const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  gateway.configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: FIXTURE_DIM, env: { OPENAI_API_KEY: 'fixture', VOYAGE_API_KEY: 'fixture' } });
  gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(t => hashEmbedVector(t, FIXTURE_DIM)), values: params.values, warnings: [] }));
  gateway.__setRerankTransportForTests(makeOverlapRerankTransport());
  const discovery = process.env.GBRAIN_MODEL_DISCOVERY;
  process.env.GBRAIN_MODEL_DISCOVERY = 'off';
  return () => {
    gateway.__setEmbedTransportForTests(null);
    gateway.__setRerankTransportForTests(null);
    if (discovery === undefined) delete process.env.GBRAIN_MODEL_DISCOVERY;
    else process.env.GBRAIN_MODEL_DISCOVERY = discovery;
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

interface RunOptions { fixture: boolean; synthetic?: string; questionsPath?: string; freezePath?: string; databaseUrlEnv: string; out: string; gut: GbrainUnderTest; protocol?: Protocol; transports?: Transports; referenceBuild?: boolean }

/**
 * Live pages in gbrain's conversation-archive layout, the rows gbrain #9433 (v0.60.727.0) ranks below a written page that
 * scores close to them (ARCHIVE_SLUG and ARCHIVE_SOURCES in src/core/search/rank-priors.ts at v0.60.733.0), and how many
 * of the run's distinct gold pages are among them (batch 5's 2026-11-16 build entry). Counts only.
 */
export async function archiveLayoutCounts(engine: { executeRaw: (sql: string, params?: unknown[]) => Promise<any[]> }, goldSlugs: readonly string[]) {
  const layout = "deleted_at IS NULL AND (slug ~ '^conversations/[a-z][a-z0-9-]*/[0-9]{4}-[0-9]{2}-[0-9]{2}(/|$)' OR source_id IN ('conversations', 'conversations-owner'))";
  const [all] = await engine.executeRaw('SELECT count(*)::int AS n FROM pages WHERE ' + layout);
  const [gold] = await engine.executeRaw('SELECT count(DISTINCT slug)::int AS n FROM pages WHERE ' + layout + ' AND slug = ANY($1::text[])', [[...new Set(goldSlugs)]]);
  return { archive_layout_pages: Number(all?.n), gold_pages_in_archive_layout: Number(gold?.n) };
}

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
  const runner = { commit: git(['rev-parse', 'HEAD']) || 'unknown', dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '' };
  const counters: GuardCounters = { refusals: {} };
  let questionsText: string;
  let protocol: Protocol = o.protocol ?? 'batch1';
  let frozenEpoch: { gbrain_version: string | null; visibility_epoch: string | null } | null = null;
  let priorCheck: { files: string[]; question_ids: number; forms: number; gold_pages: number } | null = null;
  const runEpoch = visibilityEpoch(o.gut.version);
  let questionsFile = o.questionsPath;
  let synthetic: Awaited<ReturnType<typeof import('./synthetic.ts').buildSyntheticBrain>> | null = null;
  if (o.synthetic) {
    const { buildSyntheticBrain } = await import('./synthetic.ts');
    synthetic = await buildSyntheticBrain(o.gut, o.synthetic, o.transports);
    questionsText = synthetic.questionsText;
    if (!o.protocol && synthetic.protocol) protocol = synthetic.protocol;
  } else if (o.fixture) {
    questionsFile ??= protocol === 'batch3' ? BATCH3_FIXTURE_QUESTIONS : join(FIXTURE_DIR, 'questions.jsonl');
    questionsText = readFileSync(questionsFile, 'utf8');
  }
  else {
    if (!o.questionsPath || !o.freezePath) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'a counted run needs --questions and --freeze');
    questionsText = readFileSync(o.questionsPath, 'utf8');
    const frozen = JSON.parse(readFileSync(o.freezePath, 'utf8'));
    if (frozen?.questions_sha256 !== sha256(questionsText)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'question file hash differs from the freeze');
    const frozenProtocol = frozen.protocol ?? 'batch1';
    if (!(PROTOCOLS as readonly string[]).includes(frozenProtocol)) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the freeze names an unknown protocol');
    if (o.protocol && o.protocol !== frozenProtocol) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', '--protocol differs from the protocol in the freeze');
    protocol = frozenProtocol;
    const priorFiles = HELD_OUT_PRIORS[protocol];
    if (priorFiles) {
      const files = frozen.prior_question_files, o = frozen.prior_overlap;
      const clean = Array.isArray(files) && JSON.stringify(files) === JSON.stringify(priorFiles.map(p => p.sha256)) && o?.question_ids === 0 && o?.forms === 0 && o?.gold_pages === 0;
      if (!clean) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the ' + protocol + ' freeze records no clean check against the ' + priorFiles.length + ' earlier question files (prior_question_files, prior_overlap)');
      priorCheck = { files: priorFiles.map(p => p.sha256.slice(0, 12)), question_ids: 0, forms: 0, gold_pages: 0 };
    }
    if (EPOCH_PROTOCOLS.includes(protocol)) {
      if (typeof frozen.visibility_epoch !== 'string') throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the ' + protocol + ' freeze records no visibility_epoch');
      if (frozen.visibility_epoch !== runEpoch) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the freeze visibility_epoch ' + versionOrEpoch(frozen.visibility_epoch) + ' differs from this run\'s ' + runEpoch + ' (GBRA-398)');
      if (runEpoch === 'unknown' && frozen.gbrain_version !== o.gut.version) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'the visibility epoch is unknown on both sides, so the run needs the freeze\'s gbrain version ' + (versionOrNull(frozen.gbrain_version) ?? 'unrecorded') + ' (GBRA-398)');
      frozenEpoch = { gbrain_version: versionOrNull(frozen.gbrain_version), visibility_epoch: frozen.visibility_epoch };
    }
  }
  const inProcess = o.fixture || synthetic !== null;
  let questions: Question[];
  try {
    questions = parseQuestions(questionsText, protocol);
  } catch (error) {
    await synthetic?.close();
    throw error;
  }
  const keyless = synthetic || !questionsFile ? null : await runKeylessChild(o, questionsFile, protocol);
  if (keyless) say(KEYLESS_ARM + ': ' + keyless.length + ' question forms searched in its own keyless process');

  let engine: any, barrier: string, connection: string, schemaVersion: number, codeSchemaVersion: number, close: () => Promise<void>;
  if (inProcess) {
    const brain = synthetic ?? await buildFixtureBrain(o.gut, protocol === 'batch3' ? BATCH3_FIXTURE_PAGES : undefined);
    engine = brain.engine;
    barrier = 'copy';
    connection = 'in_process';
    close = brain.close;
    installGuards(engine, counters);
    await verifyReadOnly(engine);
    ({ schema_version: schemaVersion, code_schema_version: codeSchemaVersion } = await checkSchema(engine, o.gut));
  } else {
    const brain = await openPostgresBrain(o.gut, o.databaseUrlEnv, counters, o.referenceBuild, join(o.out, 'gbrain-home'));
    ({ engine, barrier, connection, close, schema_version: schemaVersion, code_schema_version: codeSchemaVersion } = brain);
  }
  say('gbrain ' + o.gut.version + ', schema ' + schemaVersion + ', barrier ' + barrier + ', connection ' + connection + '; read-only verified');
  const countPages = async (since?: string) => Number((await engine.executeRaw('SELECT count(*)::int AS n FROM pages' + (since ? " WHERE updated_at >= '" + since + "'::timestamptz" : '')))[0]?.n);
  try {
    const pagesAtStart = await countPages();
    const archive = await archiveLayoutCounts(engine, questions.flatMap(q => q.gold.map(g => g.slug)));
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
    const pagesAtEnd = await countPages(), pagesUpdated = await countPages(startedAt);

    const pinCommit = (gbrainPin().split('#')[1] ?? 'unknown').toLowerCase();
    const identity = {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      runner_commit: runner.commit,
      runner_dirty: runner.dirty,
      gbrain_pin_version: JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/gbrain/package.json'), 'utf8')).version,
      gbrain_pin_commit: /^[0-9a-f]{7,64}$/.test(pinCommit) ? pinCommit : 'unknown',
      gbrain_loaded_version: o.gut.version,
      gbrain_loaded_commit: o.gut.overlay?.build.commit ?? (/^[0-9a-f]{7,64}$/.test(pinCommit) ? pinCommit : 'unknown'),
      gbrain_overlay: o.gut.overlay !== null,
      schema_version: schemaVersion,
      code_schema_version: codeSchemaVersion,
      reference_build: Boolean(o.referenceBuild),
      brain_pages_at_start: pagesAtStart,
      brain_pages_at_end: pagesAtEnd,
      brain_pages_updated_since_start: pagesUpdated,
      ...archive,
      engine: (inProcess ? 'pglite' : 'postgres') as 'pglite' | 'postgres',
      barrier,
      connection,
      search_mode: String(knobs.resolved_mode),
      reranker_enabled: Boolean(knobs.reranker_enabled),
      reranker_model: String(knobs.reranker_model),
      embedding_model: embeddingModel,
      embedding_column: /^[a-z_][a-z0-9_]{0,62}$/.test(String(column.name)) ? String(column.name) : 'unknown',
      mode_expansion: Boolean(knobs.expansion),
      control: inProcess,
      ...(inProcess ? { transports: synthetic?.applied.transports ?? 'hash' } : {}),
      ...facts,
      ...(synthetic ? { synthetic: { digest: synthetic.manifest.digest, questions_sha256: synthetic.manifest.questions_sha256, ...synthetic.manifest.knobs, chunks: synthetic.applied.chunks, unembedded_chunks: synthetic.applied.unembedded_chunks } } : {}),
      ...(EPOCH_PROTOCOLS.includes(protocol) ? { visibility_epoch: runEpoch, freeze_gbrain_version: frozenEpoch?.gbrain_version ?? null, freeze_visibility_epoch: frozenEpoch?.visibility_epoch ?? null } : {}),
    };
    const summary = {
      loaded: questions.length,
      gold_missing: missing,
      by_type: Object.fromEntries(PROTOCOL_TYPES[protocol].map(t => [t, kept.filter(q => q.type === t).length])),
      gold_found_by: Object.fromEntries(GOLD_FOUND_BY.map(g => [g, kept.filter(q => q.gold_found_by === g).length])),
      paraphrase_shares_identifier_token: paraphraseOverlapShare(kept),
      freeze_sha_prefix: sha256(questionsText).slice(0, 12),
      ...(priorCheck ? { prior_overlap: priorCheck } : {}),
    };
    mkdirSync(o.out, { recursive: true });
    const detail = join(o.out, 'detail.local.jsonl');
    writeFileSync(detail, records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    const scorecard = buildScorecard(records, summary, identity, { readonly_verified_start: true, readonly_verified_end: true, guard_refusals: counters.refusals }, protocol, keyless);
    const json = JSON.stringify(scorecard, null, 2) + '\n';
    const markdown = renderMarkdown(scorecard);
    const needles = new Set<string>([...questions.flatMap(q => [...Object.values(q.forms), ...q.gold.map(g => g.slug), ...(q.stale ?? []).map(s => s.slug), ...(q.decoy ?? []).map(s => s.slug)]), ...records.flatMap(r => r.pages), ...(keyless ?? []).flatMap(r => [...r.pages, ...r.fill_off.pages])]);
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
  const keylessPath = join(dir, 'keyless.local.jsonl');
  const keyless = existsSync(keylessPath) ? readFileSync(keylessPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as KeylessRecord) : [];
  const identity = { gbrain_loaded_version: card.run.gbrain_loaded_version, gbrain_loaded_commit: card.run.gbrain_loaded_commit, barrier: card.run.barrier, control: card.run.control, freeze_sha_prefix: card.questions.freeze_sha_prefix };
  const invalid: string[] = [...ARMS.filter(arm => card.arms?.[arm]?.invalid), ...(!card.keyless_op || card.keyless_op.invalid ? [KEYLESS_ARM] : [])];
  return { card, identity, records, keyless, invalid };
}

function refuseControl(runA: ReturnType<typeof loadRunDir>, runB: ReturnType<typeof loadRunDir>) {
  if (runA.identity.control === true || runB.identity.control === true) throw new LiveRecallAbort('LR_COMPARE_CONTROL', (runA.identity.control === true ? 'run_a' : 'run_b') + ' is a fixture control run');
}

/** Pair two run directories, refusing runs on different question files or a fixture control, and skipping an arm invalid in either; compare.json carries each run's identity. */
export function compareRunDirs(a: string, b: string) {
  const runA = loadRunDir(a), runB = loadRunDir(b);
  if (runA.identity.freeze_sha_prefix !== runB.identity.freeze_sha_prefix) throw new LiveRecallAbort('LR_FREEZE_MISMATCH', 'run_a and run_b were made on different question files (freeze_sha_prefix differs)');
  refuseControl(runA, runB);
  const { schema, comparisons } = compareRuns([...runA.records, ...runA.keyless], [...runB.records, ...runB.keyless], new Set([...runA.invalid, ...runB.invalid]));
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

/** For --paid, outside the ledger's guard: send only to Voyage. The guard prices every paid host, so a stray chat call would be reserved and sent; this refuses it before the guard sees it. */
function voyageOnlyFetch(send: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== 'api.voyageai.com') throw new Error('live-recall synthetic --paid sends only to api.voyageai.com; refused a request to ' + url.hostname);
    return send(input, init);
  }) as typeof fetch;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const protocol = flag(argv, '--protocol');
  if (protocol !== undefined && !(PROTOCOLS as readonly string[]).includes(protocol)) { console.error('usage: --protocol ' + PROTOCOLS.join('|')); return 2; }
  if (command === 'freeze') {
    const path = flag(argv, '--questions'), out = flag(argv, '--out');
    const priors = argv.flatMap((a, i) => (a === '--prior' && argv[i + 1] ? [argv[i + 1]!] : []));
    if (!path || !out) { console.error('usage: run.ts freeze --questions <file> --out <freeze.json> [--protocol ' + PROTOCOLS.join('|') + '] [--gbrain <checkout>@<commit>] [--prior <file> (batch4 and batch5: one per earlier batch)]'); return 2; }
    const text = readFileSync(path, 'utf8');
    const p = (protocol ?? 'batch1') as Protocol;
    const priorFiles = HELD_OUT_PRIORS[p];
    if (priors.length && !priorFiles) { console.error('usage: --prior applies only to freeze --protocol batch4 or batch5'); return 2; }
    let summary;
    try {
      const questions = parseQuestions(text, p);
      summary = p === 'batch3' ? freezeSummaryBatch3(text, questions, resolveGbrainUnderTest(gbrainSpecFrom(argv)))
        : p === 'batch4' ? freezeSummaryBatch4(text, questions, resolveGbrainUnderTest(gbrainSpecFrom(argv)), priorOverlap(questions, priors.map(f => readFileSync(f, 'utf8')), priorFiles))
        : p === 'batch5' ? freezeSummaryBatch5(text, questions, resolveGbrainUnderTest(gbrainSpecFrom(argv)), priorOverlap(questions, priors.map(f => readFileSync(f, 'utf8')), priorFiles))
        : freezeSummary(text, questions, p);
    } catch (error) {
      if (!(error instanceof LiveRecallAbort)) throw error;
      console.error('live-recall: ABORT ' + error.code + ': ' + error.detail);
      console.error('live-recall: fix: ' + ABORT_CODES[error.code] + ' (docs/benchmarks/live-recall/RUN-KIT.md#' + error.code.toLowerCase() + '). Nothing was written.');
      return 3;
    }
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
  if (command === 'keyless-arm') return keylessArm(argv);
  if (command !== 'run') { console.error('usage: run.ts run|freeze|compare|pool (see the header of this file)'); return 2; }
  const fixture = argv.includes('--fixture');
  const synthetic = flag(argv, '--synthetic');
  const referenceBuild = argv.includes('--reference-build');
  if (referenceBuild && (fixture || synthetic)) { console.error('live-recall: --reference-build applies only to a run on a real brain (--questions and --freeze)'); return 2; }
  const paid = paidRequested(argv);
  if (paid && !synthetic) { console.error('live-recall: --paid applies only to run --synthetic <dir>, which then embeds and reranks with Voyage'); return 2; }
  let estimate: ReturnType<typeof import('./synthetic.ts').estimateVoyageUsd> | null = null;
  if (paid) {
    const { estimateVoyageUsd, readSyntheticDir, VOYAGE_SYNTHETIC } = await import('./synthetic.ts');
    if (readSyntheticDir(resolve(synthetic!)).manifest.knobs.keyword_candidate_bound !== null) {
      console.error('live-recall: REFUSED: a paid synthetic run takes no keyword_candidate_bound. On PGLite the bound samples only gbrain\'s all-words keyword match, never the any-word retry that sets keyword_candidates_incomplete on Postgres, so it cannot reproduce the real condition (predictive-measures preregistration, amendment of 2026-11-10). Regenerate the directory without --keyword-bound.');
      return 2;
    }
    estimate = estimateVoyageUsd(resolve(synthetic!));
    console.log('live-recall: --paid synthetic run with ' + VOYAGE_SYNTHETIC.embedding_model + ', ' + VOYAGE_SYNTHETIC.search_mode + ' and ' + VOYAGE_SYNTHETIC.reranker_model + ': estimated $' + estimate.usd.toFixed(4) + ' (' + estimate.embedding_tokens + ' embedding tokens at $' + estimate.embedding_usd_per_mtok + '/M, ' + estimate.rerank_tokens + ' rerank tokens at $' + estimate.rerank_usd_per_mtok + '/M)');
    try {
      requirePaidArm(argv, { arm: 'live-recall synthetic (' + VOYAGE_SYNTHETIC.embedding_model + ' + ' + VOYAGE_SYNTHETIC.reranker_model + ')', estimateUsd: estimate.usd });
    } catch (error) {
      if (!(error instanceof PaidArmRefusal)) throw error;
      console.error('live-recall: REFUSED: ' + error.message);
      return 2;
    }
  }
  const out = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/live-recall', new Date().toISOString().replace(/[:.]/g, '-') + (synthetic ? '-synthetic' : fixture ? '-fixture' : '')));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  process.env.GBRAIN_AUDIT_DIR = out;
  const { say, restore } = captureOutput(join(out, 'gbrain.local.log'));
  const savedFetch = globalThis.fetch;
  let paidRun: ReturnType<typeof startPaidRun> | null = null;
  try {
    const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
    if (estimate) {
      paidRun = startPaidRun('live-recall-synthetic-voyage', { ...budgetOptionsFrom(argv), runId: flag(argv, '--budget-run-id'), estimateUsd: estimate.usd, log: say });
      globalThis.fetch = voyageOnlyFetch(globalThis.fetch);
    }
    const paths = await liveRecall({ fixture, synthetic: synthetic ? resolve(synthetic) : undefined, questionsPath: flag(argv, '--questions'), freezePath: flag(argv, '--freeze'), databaseUrlEnv: flag(argv, '--database-url-env') ?? 'LIVE_RECALL_DATABASE_URL', out, gut, protocol: protocol as Protocol | undefined, transports: estimate ? 'voyage' : 'hash', referenceBuild }, say);
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
    if (paidRun) {
      globalThis.fetch = savedFetch;
      paidRun.guard.uninstall();
      const cost = receiptCost(paidRun.run.close());
      writeFileSync(join(out, 'paid-receipt.json'), JSON.stringify({ transports: 'voyage', estimate, cost }, null, 2) + '\n');
      say('paid: $' + cost.usd.toFixed(6) + ' on the ledger (' + cost.basis + '); receipt ' + join(out, 'paid-receipt.json'));
    }
    globalThis.fetch = savedFetch;
    restore();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
