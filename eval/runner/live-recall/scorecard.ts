/**
 * The live-recall scorecard: aggregates only, built from per-query records and
 * checked structurally before anything is written. Every string in the JSON
 * must match an allowlist and every key must be one this file defines, so a
 * question form, a slug or a chunk id has no place to land. The Markdown is
 * rendered from the validated JSON alone. The format is documented in
 * docs/benchmarks/live-recall/SCORECARD.md.
 */
import { percentile } from '../metrics.ts';
import { clusteredPairedDelta, exactMcNemar, holmAdjusted, powerNote, type PairedItem } from '../stats/paired.ts';
import { clusterBootstrapProportion, wilson } from '../q2/stats.ts';
import { ABORT_CODES, LiveRecallAbort } from './brain.ts';

export const SCHEMA = 'live-recall-scorecard/v1';
export const ARMS = ['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured', 'configured_window'] as const;
export const TYPES = ['identifier', 'error_string', 'time_window', 'cross_source', 'topic'] as const;
export const FORMS = ['exact', 'paraphrase'] as const;
export const KS = [1, 5, 10, 20] as const;
export const STATUSES = ['ok', 'error', 'degraded', 'ai_refused', 'rerank_fail_open', 'skipped'] as const;
export const GOLD_FOUND_BY = ['page_first', 'memory', 'gbrain_search', 'other_search', 'unknown'] as const;
export const SEED = 20261106;
export const DRAWS = 10_000;
/** More than this share of rerank fail-open queries makes the configured arms invalid. */
export const RERANK_FAIL_OPEN_CAP = 0.1;

export type Arm = (typeof ARMS)[number];
export type QType = (typeof TYPES)[number];
export type Form = (typeof FORMS)[number];
export type Status = (typeof STATUSES)[number];

/** One arm's answer to one question form. Pointer ids only; it stays on the box in detail.local.jsonl. */
export interface QueryRecord {
  qid: string;
  type: QType;
  form: Form;
  arm: Arm;
  status: Status;
  pages: string[];
  chunks: string[];
  page_rank: number | null;
  chunk_rank: number | null;
  gold_pages: number;
  has_chunk_gold: boolean;
  all_found_at: Record<string, boolean>;
  ms: number;
  returned: number;
  calls: Record<string, number>;
  degraded_stages: string[];
}

export interface RunIdentity {
  started_at: string;
  finished_at: string;
  runner_commit: string;
  runner_dirty: boolean;
  gbrain_pin_version: string;
  gbrain_pin_commit: string;
  gbrain_loaded_version: string;
  gbrain_loaded_commit: string;
  gbrain_overlay: boolean;
  schema_version: number;
  engine: 'postgres' | 'pglite';
  barrier: string;
  connection: string;
  search_mode: string;
  reranker_enabled: boolean;
  reranker_model: string;
  embedding_model: string;
  /** The embedding column the vector and hybrid arms search, resolved the way hybridSearch resolves it. */
  embedding_column: string;
  /** The mode's own expansion default; every arm passes expansion: false regardless. */
  mode_expansion: boolean;
  control: boolean;
  pgvector_version: string | null;
  source_pgvector: string | null;
  source_server_version_num: number | null;
  copy_server_version_num: number | null;
  restore_errors: number | null;
}

export interface QuestionSummary {
  loaded: number;
  gold_missing: number;
  by_type: Record<string, number>;
  gold_found_by: Record<string, number>;
  paraphrase_shares_identifier_token: number;
  freeze_sha_prefix: string;
}

export interface Custody {
  readonly_verified_start: boolean;
  readonly_verified_end: boolean;
  guard_refusals: Record<string, number>;
}

const rate = (k: number, n: number) => (n > 0 ? k / n : null);
const round = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
const interval = (ci: [number, number] | null) => (ci ? [round(ci[0]), round(ci[1])] : null);
const keyOf = (r: { qid: string; form: string }) => r.qid + '\u0000' + r.form;
const rr = (rank: number | null) => (rank ? 1 / rank : 0);
const hitAt = (rank: number | null, k: number) => (rank !== null && rank <= k ? 1 : 0);

/** Rates over one form use Wilson; rates pooled over both forms resample whole questions. */
function proportion(rows: QueryRecord[], value: (r: QueryRecord) => number, pooled: boolean) {
  const n = rows.length;
  const k = rows.reduce((s, r) => s + value(r), 0);
  if (!pooled) {
    const w = wilson(k, n);
    return { hits: k, n, rate: round(rate(k, n)), ci95: n ? [round(w.lower), round(w.upper)] : null, interval: 'wilson' };
  }
  const clusters = new Map<string, { k: number; n: number }>();
  for (const r of rows) {
    const c = clusters.get(r.qid) ?? { k: 0, n: 0 };
    c.k += value(r);
    c.n += 1;
    clusters.set(r.qid, c);
  }
  const b = clusterBootstrapProportion([...clusters.values()], { seed: SEED, draws: DRAWS });
  return { hits: k, n, rate: round(rate(k, n)), ci95: interval(b.ci95), interval: 'cluster_bootstrap' };
}

function meanWithInterval(rows: QueryRecord[], value: (r: QueryRecord) => number) {
  const clusters = new Map<string, { k: number; n: number }>();
  for (const r of rows) {
    const c = clusters.get(r.qid) ?? { k: 0, n: 0 };
    c.k += value(r);
    c.n += 1;
    clusters.set(r.qid, c);
  }
  const b = clusterBootstrapProportion([...clusters.values()], { seed: SEED, draws: DRAWS });
  return { mean: round(b.point), ci95: interval(b.ci95), n: rows.length };
}

function cell(rows: QueryRecord[], pooled: boolean) {
  const multi = rows.filter(r => r.gold_pages > 1);
  const chunked = rows.filter(r => r.has_chunk_gold);
  const calls: Record<string, number> = {};
  for (const r of rows) for (const [kind, c] of Object.entries(r.calls)) calls[kind] = (calls[kind] ?? 0) + c;
  const stages: Record<string, number> = {};
  for (const r of rows) for (const stage of r.degraded_stages) stages[stage] = (stages[stage] ?? 0) + 1;
  return {
    n: rows.length,
    success_at: Object.fromEntries(KS.map(k => ['k' + k, proportion(rows, r => hitAt(r.page_rank, k), pooled)])),
    mrr: meanWithInterval(rows, r => rr(r.page_rank)),
    recall_all_at: multi.length ? Object.fromEntries(KS.map(k => ['k' + k, proportion(multi, r => (r.all_found_at['k' + k] ? 1 : 0), pooled)])) : null,
    chunk_success_at: chunked.length ? Object.fromEntries(KS.map(k => ['k' + k, proportion(chunked, r => hitAt(r.chunk_rank, k), pooled)])) : null,
    mean_pages_returned: round(rows.length ? rows.reduce((s, r) => s + r.returned, 0) / rows.length : null),
    harness_latency_ms: { p50: round(percentile(rows.map(r => r.ms), 50)), p95: round(percentile(rows.map(r => r.ms), 95)) },
    model_calls: calls,
    degraded_stages: stages,
  };
}

function compare(id: string, a: Map<string, QueryRecord>, b: Map<string, QueryRecord>, keys: string[], metric: 'success_at_5' | 'mrr', binaryOnePerQuestion: boolean) {
  const value = (r: QueryRecord) => (metric === 'mrr' ? rr(r.page_rank) : hitAt(r.page_rank, 5));
  const pairs: PairedItem[] = [];
  for (const key of keys) {
    const ra = a.get(key), rb = b.get(key);
    if (ra && rb) pairs.push({ id: key, cluster: ra.qid, a: value(ra), b: value(rb) });
  }
  if (pairs.length === 0) return { id, metric, n_pairs: 0, n_clusters: 0, mean_a: null, mean_b: null, delta: null, ci95: null, p_two_sided: null, p_method: 'none', mcnemar: null, mde: null };
  const d = clusteredPairedDelta(pairs, { seed: SEED, draws: DRAWS });
  const binary = metric === 'success_at_5';
  const m = binary && binaryOnePerQuestion ? exactMcNemar(pairs) : null;
  return {
    id, metric, n_pairs: d.n_pairs, n_clusters: d.n_clusters,
    mean_a: round(d.mean_a), mean_b: round(d.mean_b), delta: round(d.delta), ci95: interval(d.ci95),
    p_two_sided: round(d.p_two_sided), p_method: d.p_method,
    mcnemar: m ? { wins: m.wins, losses: m.losses, discordant: m.discordant, p_two_sided: round(m.p_two_sided) } : null,
    mde: round(powerNote(d, { binary }).mde),
  };
}

/** The comparisons the preregistration names, in its order. P1 and P2 are the only Holm family. */
export const COMPARISONS: Array<{ id: string; a: Arm; b: Arm; form: Form | 'all' | 'exact_vs_paraphrase'; primary?: 'P1' | 'P2'; windowed?: boolean }> = [
  { id: 'p1_hybrid_vs_hybrid_lexical', a: 'hybrid_lexical', b: 'hybrid', form: 'all', primary: 'P1' },
  { id: 'p2_configured_vs_hybrid_lexical_paraphrase', a: 'hybrid_lexical', b: 'configured', form: 'paraphrase', primary: 'P2' },
  { id: 'hybrid_lexical_vs_keyword', a: 'keyword', b: 'hybrid_lexical', form: 'all' },
  { id: 'hybrid_vs_keyword', a: 'keyword', b: 'hybrid', form: 'all' },
  { id: 'configured_vs_keyword_paraphrase', a: 'keyword', b: 'configured', form: 'paraphrase' },
  { id: 'configured_vs_hybrid', a: 'hybrid', b: 'configured', form: 'all' },
  { id: 'vector_vs_keyword', a: 'keyword', b: 'vector', form: 'all' },
  { id: 'configured_vs_keyword_exact', a: 'keyword', b: 'configured', form: 'exact' },
  { id: 'hybrid_vs_keyword_paraphrase', a: 'keyword', b: 'hybrid', form: 'paraphrase' },
  { id: 'window_vs_configured', a: 'configured', b: 'configured_window', form: 'all', windowed: true },
  ...(['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured'] as const).map(arm => ({ id: 'paraphrase_vs_exact_' + arm, a: arm, b: arm, form: 'exact_vs_paraphrase' as const })),
];

export function buildScorecard(records: QueryRecord[], questions: QuestionSummary, identity: RunIdentity, custody: Custody) {
  const byArm = new Map<Arm, QueryRecord[]>(ARMS.map(a => [a, records.filter(r => r.arm === a)]));
  const invalid: Record<string, string> = {};
  for (const arm of ['configured', 'configured_window'] as const) {
    const rows = byArm.get(arm)!;
    const failOpen = rows.filter(r => r.status === 'rerank_fail_open').length;
    if (rows.length && failOpen / rows.length > RERANK_FAIL_OPEN_CAP) invalid[arm] = 'rerank_fail_open_over_cap';
  }
  if (byArm.get('vector')!.length && byArm.get('vector')!.every(r => r.status === 'skipped')) invalid.vector = 'embedding_opted_out';
  if (byArm.get('hybrid')!.length && byArm.get('hybrid')!.every(r => r.status === 'skipped')) invalid.hybrid = 'embedding_opted_out';

  const common = (['keyword', 'vector', 'hybrid_lexical', 'hybrid', 'configured'] as const).filter(a => !invalid[a] && byArm.get(a)!.length);
  const statusBy = new Map<string, Map<Arm, QueryRecord>>();
  for (const r of records) {
    const m = statusBy.get(keyOf(r)) ?? new Map();
    m.set(r.arm, r);
    statusBy.set(keyOf(r), m);
  }
  const exclusions: Record<string, number> = {};
  const eligible = new Set<string>();
  for (const [key, arms] of statusBy) {
    const reason = common.map(a => { const r = arms.get(a); return !r ? 'missing_record' : r.status === 'ok' ? '' : a + '_' + r.status; }).find(Boolean);
    if (!reason) eligible.add(key);
    else exclusions[reason] = (exclusions[reason] ?? 0) + 1;
  }
  const ok = (arm: Arm) => byArm.get(arm)!.filter(r => eligible.has(keyOf(r)) && r.status === 'ok');

  const arms: Record<string, unknown> = {};
  for (const arm of ARMS) {
    if (invalid[arm]) { arms[arm] = { invalid: invalid[arm] }; continue; }
    const rows = ok(arm);
    if (!rows.length) { arms[arm] = { invalid: 'no_eligible_queries' }; continue; }
    const forms = (subset: QueryRecord[]) => ({
      all: cell(subset, true),
      exact: cell(subset.filter(r => r.form === 'exact'), false),
      paraphrase: cell(subset.filter(r => r.form === 'paraphrase'), false),
    });
    arms[arm] = {
      overall: forms(rows),
      by_type: Object.fromEntries(TYPES.map(t => [t, forms(rows.filter(r => r.type === t))])),
    };
  }

  const comparisons: Array<Record<string, unknown>> = [];
  for (const c of COMPARISONS) {
    if (invalid[c.a] || invalid[c.b] || !byArm.get(c.a)!.length || !byArm.get(c.b)!.length) {
      comparisons.push({ id: c.id, skipped: 'arm_invalid_or_absent' });
      continue;
    }
    for (const metric of ['success_at_5', 'mrr'] as const) {
      if (c.form === 'exact_vs_paraphrase') {
        const rows = ok(c.a);
        const exact = new Map(rows.filter(r => r.form === 'exact').map(r => [r.qid, r] as const));
        const para = new Map(rows.filter(r => r.form === 'paraphrase').map(r => [r.qid, r] as const));
        comparisons.push({ ...compare(c.id, exact, para, [...exact.keys()], metric, true), a: 'exact', b: 'paraphrase', arm: c.a, form: 'exact_vs_paraphrase', primary: null });
        continue;
      }
      const rowsA = ok(c.a), rowsB = ok(c.b);
      const mapA = new Map(rowsA.map(r => [keyOf(r), r] as const)), mapB = new Map(rowsB.map(r => [keyOf(r), r] as const));
      const keys = [...mapB.keys()].filter(k => mapA.has(k) && (c.form === 'all' || mapB.get(k)!.form === c.form));
      comparisons.push({ ...compare(c.id, mapA, mapB, keys, metric, c.form !== 'all'), a: c.a, b: c.b, form: c.form, primary: c.primary ?? null });
    }
  }
  const primaryIds = COMPARISONS.filter(c => c.primary).map(c => c.id);
  const primaries = comparisons.filter(c => c.primary && c.metric === 'success_at_5' && typeof c.p_two_sided === 'number');
  const holm = holmAdjusted(primaryIds.map(id => (primaries.find(c => c.id === id)?.p_two_sided as number | undefined) ?? 1));
  primaries.forEach(c => { c.p_holm = round(holm[primaryIds.indexOf(c.id as string)]!); });

  const scorecard = {
    schema: SCHEMA,
    run: identity,
    custody,
    questions,
    eligibility: { eligible_question_forms: eligible.size, exclusions, invalid_arms: invalid, common_arms: common },
    arms,
    comparisons,
  };
  validateScorecard(scorecard);
  return scorecard;
}

export const COMPARE_SCHEMA = 'live-recall-compare/v1';
const COMPARE_FORMS = ['all', 'exact', 'paraphrase'] as const;
const compareId = (arm: Arm, form: (typeof COMPARE_FORMS)[number]) => 'run_b_vs_run_a_' + arm + '_' + form;

/**
 * Two runs on the same questions (a baseline and a candidate gbrain, or the
 * same gbrain twice for run-to-run noise), paired per arm on question forms
 * that are ok in both. Reads two detail.local.jsonl files on the box; emits
 * aggregates only, through the same structural check as the scorecard. An arm
 * invalid in either run's scorecard is skipped.
 */
export function compareRuns(a: QueryRecord[], b: QueryRecord[], invalidArms: ReadonlySet<string> = new Set()) {
  const comparisons: Array<Record<string, unknown>> = [];
  for (const arm of ARMS) {
    if (invalidArms.has(arm)) {
      for (const form of COMPARE_FORMS) comparisons.push({ id: compareId(arm, form), skipped: 'arm_invalid_or_absent' });
      continue;
    }
    const okA = new Map(a.filter(r => r.arm === arm && r.status === 'ok').map(r => [keyOf(r), r] as const));
    const okB = new Map(b.filter(r => r.arm === arm && r.status === 'ok').map(r => [keyOf(r), r] as const));
    for (const form of COMPARE_FORMS) {
      const keys = [...okB.keys()].filter(k => okA.has(k) && (form === 'all' || okB.get(k)!.form === form));
      const top5Changed = keys.filter(k => okA.get(k)!.pages.slice(0, 5).join('\u0000') !== okB.get(k)!.pages.slice(0, 5).join('\u0000')).length;
      for (const metric of ['success_at_5', 'mrr'] as const) {
        comparisons.push({ ...compare(compareId(arm, form), okA, okB, keys, metric, form !== 'all'), a: 'run_a', b: 'run_b', arm, form, top5_changed: top5Changed });
      }
    }
  }
  return { schema: COMPARE_SCHEMA, comparisons };
}

const KEY_WORDS = new Set<string>([
  'schema', 'run', 'custody', 'questions', 'eligibility', 'arms', 'comparisons', 'overall', 'by_type', 'all', 'exact', 'paraphrase',
  'n', 'success_at', 'mrr', 'mean', 'ci95', 'hits', 'rate', 'interval', 'recall_all_at', 'chunk_success_at', 'mean_pages_returned',
  'harness_latency_ms', 'p50', 'p95', 'model_calls', 'invalid', 'id', 'metric', 'n_pairs', 'n_clusters', 'mean_a', 'mean_b', 'delta',
  'p_two_sided', 'p_method', 'mcnemar', 'wins', 'losses', 'discordant', 'mde', 'a', 'b', 'arm', 'form', 'primary', 'p_holm', 'skipped',
  'eligible_question_forms', 'exclusions', 'invalid_arms', 'common_arms', 'loaded', 'gold_missing', 'gold_found_by',
  'paraphrase_shares_identifier_token', 'freeze_sha_prefix', 'readonly_verified_start', 'readonly_verified_end', 'guard_refusals',
  'started_at', 'finished_at', 'runner_commit', 'runner_dirty', 'gbrain_pin_version', 'gbrain_pin_commit', 'gbrain_loaded_version',
  'gbrain_loaded_commit', 'gbrain_overlay', 'schema_version', 'engine', 'barrier', 'connection', 'search_mode', 'reranker_enabled',
  'reranker_model', 'embedding_model', 'embedding_column', 'mode_expansion', 'control', 'top5_changed', 'degraded_stages',
  'pgvector_version', 'source_pgvector', 'source_server_version_num', 'copy_server_version_num', 'restore_errors', 'run_a', 'run_b',
  'chat', 'embedding', 'rerank', 'multimodal', 'decide', 'transcription',
  ...ARMS, ...TYPES, ...KS.map(k => 'k' + k), ...STATUSES, ...GOLD_FOUND_BY,
]);
const KEY_PATTERNS = [/^(keyword|vector|hybrid_lexical|hybrid|configured|configured_window|missing)_(ok|error|degraded|ai_refused|rerank_fail_open|skipped|record)$/, /^[a-z_]+$/];
const STRING_WORDS = new Set<string>([
  SCHEMA, ...ARMS, ...TYPES, ...FORMS, 'exact_vs_paraphrase', 'P1', 'P2', 'success_at_5', 'mrr', 'wilson', 'cluster_bootstrap', 'none',
  'exact-sign-flip', 'monte-carlo-sign-flip', 'degenerate', 'postgres', 'pglite', 'copy', 'standby', 'no_write_privilege',
  'session_pooler', 'transaction_pooler_rewritten', 'direct_or_local', 'in_process', 'conservative', 'balanced', 'tokenmax',
  'rerank_fail_open_over_cap', 'embedding_opted_out', 'no_eligible_queries', 'arm_invalid_or_absent', 'unknown',
  ...COMPARISONS.map(c => c.id), ...Object.keys(ABORT_CODES),
  COMPARE_SCHEMA, 'run_a', 'run_b', 'all', ...ARMS.flatMap(arm => COMPARE_FORMS.map(form => compareId(arm, form))),
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(\.\d+)?$/;
export const versionOrNull = (v: unknown): string | null => (typeof v === 'string' && VERSION_PATTERN.test(v) ? v : null);
const STRING_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  /^[0-9a-f]{7,64}$/,
  VERSION_PATTERN,
];
/** Shapes allowed only at one path: a provider:model id (Ollama, OpenRouter and similar ids carry slashes, underscores and capitals) and a column name. */
const MODEL_PATTERN = /^[a-z0-9-]+:[A-Za-z0-9][A-Za-z0-9._\/:-]*$/;
const FIELD_PATTERNS: Record<string, RegExp> = {
  '$.run.reranker_model': MODEL_PATTERN,
  '$.run.embedding_model': MODEL_PATTERN,
  '$.run.embedding_column': /^[a-z_][a-z0-9_]{0,62}$/,
};

/** Structural custody check: known keys, allowlisted strings, finite numbers. Throws LR_CUSTODY_LEAK naming only the path. */
export function validateScorecard(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'non-finite number at ' + path);
    return;
  }
  if (typeof value === 'string') {
    if (STRING_WORDS.has(value) || STRING_PATTERNS.some(p => p.test(value)) || FIELD_PATTERNS[path]?.test(value)) return;
    throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'unexpected string at ' + path);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => validateScorecard(v, path + '[' + i + ']'));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!KEY_WORDS.has(k) && !KEY_PATTERNS[0]!.test(k) && !((path.endsWith('.guard_refusals') || path.endsWith('.degraded_stages')) && KEY_PATTERNS[1]!.test(k))) {
        throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'unexpected key under ' + path);
      }
      validateScorecard(v, path + '.' + k);
    }
    return;
  }
  throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'unexpected value type at ' + path);
}

/**
 * Second check: no private needle (a question form, a gold or retrieved slug)
 * appears in an outbound text. Only distinctive needles are scanned: ones with a
 * space, a slash or a digit, or at least 12 characters. A short single word
 * (a slug like `people`) cannot be told apart from the scorecard's own
 * vocabulary, a needle that is itself one of the format's words cannot be told
 * apart from it, and a bare date, version or hex string (a daily page's slug)
 * cannot be told apart from the run's own timestamps and commits; the
 * structural check already keeps all three out.
 */
export function scanForLeaks(outbound: string, needles: Iterable<string>): void {
  for (const needle of needles) {
    if (STRING_WORDS.has(needle) || KEY_WORDS.has(needle) || STRING_PATTERNS.some(p => p.test(needle)) || /^\d{4}-\d{2}-\d{2}$/.test(needle)) continue;
    const distinctive = needle.length >= 12 || (needle.length >= 5 && /[\s/0-9]/.test(needle));
    if (distinctive && outbound.includes(needle)) throw new LiveRecallAbort('LR_CUSTODY_LEAK', 'a private string matched an outbound file');
  }
}

const pct = (x: unknown) => (typeof x === 'number' ? (100 * x).toFixed(1) : 'n/a');
const ci = (x: unknown) => (Array.isArray(x) && typeof x[0] === 'number' ? pct(x[0]) + '–' + pct(x[1]) : 'n/a');

/** Markdown view of a validated scorecard. Reads only the JSON. */
export function renderMarkdown(s: ReturnType<typeof buildScorecard>): string {
  const lines: string[] = [];
  const r = s.run;
  lines.push('# Live-recall scorecard', '');
  lines.push('gbrain ' + r.gbrain_loaded_version + ' (' + r.gbrain_loaded_commit.slice(0, 9) + '), schema ' + r.schema_version + ', ' + r.engine + ', barrier: ' + r.barrier + ', pgvector ' + (r.pgvector_version ?? 'n/a') + ', mode: ' + r.search_mode + (r.control ? '. CONTROL RUN (hash embeddings): numbers say nothing about search quality.' : '.'));
  if ((r.source_pgvector !== null && r.source_pgvector !== r.pgvector_version) || (r.restore_errors ?? 0) > 0) lines.push('Warning: vector search on this copy may differ from the live brain (source pgvector ' + (r.source_pgvector ?? 'unknown') + ', copy pgvector ' + (r.pgvector_version ?? 'none') + ', restore errors ' + (r.restore_errors ?? 'unknown') + ').');
  lines.push('Question forms eligible: ' + s.eligibility.eligible_question_forms + ' of ' + (s.questions.loaded - s.questions.gold_missing) * 2 + ' (questions loaded: ' + s.questions.loaded + ', dropped for an absent gold page: ' + s.questions.gold_missing + ').', '');
  lines.push('## Arms, all queries (both forms)', '', '| Arm | n | success@1 | success@5 (95% CI) | success@10 | success@20 | MRR | pages returned |', '|---|---|---|---|---|---|---|---|');
  for (const arm of ARMS) {
    const a = (s.arms as Record<string, any>)[arm];
    if (!a || a.invalid) { lines.push('| ' + arm + ' | invalid: ' + (a?.invalid ?? 'absent') + ' | | | | | | |'); continue; }
    const c = a.overall.all;
    lines.push('| ' + arm + ' | ' + c.n + ' | ' + pct(c.success_at.k1.rate) + ' | ' + pct(c.success_at.k5.rate) + ' (' + ci(c.success_at.k5.ci95) + ') | ' + pct(c.success_at.k10.rate) + ' | ' + pct(c.success_at.k20.rate) + ' | ' + (c.mrr.mean ?? 'n/a') + ' | ' + (c.mean_pages_returned ?? 'n/a') + ' |');
  }
  lines.push('', '## success@5 by type and form', '', '| Arm | Type | exact n | exact | paraphrase n | paraphrase |', '|---|---|---|---|---|---|');
  for (const arm of ARMS) {
    const a = (s.arms as Record<string, any>)[arm];
    if (!a || a.invalid) continue;
    for (const t of TYPES) {
      const c = a.by_type[t];
      lines.push('| ' + arm + ' | ' + t + ' | ' + c.exact.n + ' | ' + pct(c.exact.success_at.k5.rate) + ' | ' + c.paraphrase.n + ' | ' + pct(c.paraphrase.success_at.k5.rate) + ' |');
    }
  }
  lines.push('', '## Paired comparisons (delta = B minus A)', '', '| Comparison | Metric | Pairs | A | B | Delta (95% CI) | p | Holm p | MDE |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of s.comparisons as Array<Record<string, any>>) {
    if (c.skipped) { lines.push('| ' + c.id + ' | skipped: ' + c.skipped + ' | | | | | | | |'); continue; }
    const scale = c.metric === 'mrr' ? (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : 'n/a') : pct;
    lines.push('| ' + c.id + (c.primary ? ' (' + c.primary + ')' : '') + ' | ' + c.metric + ' | ' + c.n_pairs + ' | ' + scale(c.mean_a) + ' | ' + scale(c.mean_b) + ' | ' + scale(c.delta) + ' (' + (Array.isArray(c.ci95) ? scale(c.ci95[0]) + ' to ' + scale(c.ci95[1]) : 'n/a') + ') | ' + (c.p_two_sided ?? 'n/a') + ' | ' + (c.p_holm ?? '') + ' | ' + scale(c.mde) + ' |');
  }
  lines.push('', '## Custody', '');
  lines.push('Read-only verified at start: ' + s.custody.readonly_verified_start + ', at end: ' + s.custody.readonly_verified_end + '. Guard refusals by verb: ' + (Object.entries(s.custody.guard_refusals).map(([k, v]) => k + ' ' + v).join(', ') || 'none') + '.');
  lines.push('Exclusions: ' + (Object.entries(s.eligibility.exclusions).map(([k, v]) => k + ' ' + v).join(', ') || 'none') + '.');
  lines.push('Latency is harness latency (pool size 2, local database), not production latency. configured keeps gbrain\'s own default result limit, so its pages-returned column shows how deep success@10 and success@20 can reach.');
  return lines.join('\n') + '\n';
}
