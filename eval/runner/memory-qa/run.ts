/**
 * memory-qa arm runner: one gbrain build, one benchmark split, one process.
 *
 *   bun eval/runner/memory-qa/run.ts --benchmark locomo|lme-s|beam-100k|beam-1m|fixture
 *     [--split dev | --split sealed --decision-id <id> --purpose <text> (custodian; GBRAIN_EVALS_CUSTODY_LOG)] [--gbrain <checkout>[@ref]] [--config key=value]... [--pin key=value]...
 *     [--embed hash|real] [--embedding-model provider:model --embedding-dims N]
 *     [--categories a,b] [--limit N] [--seed N] [--top-k 10] [--shard i/n]
 *     [--benchmark custody --corpus-file <custody path> (custodian sealed corpus; needs --split sealed)]
 *     [--facts conversation] [--qa reader|think --qa-context sessions|facts|none|oracle]
 *     [--retrieved-from <rows dir>] [--search-limit N] [--pool-depth N] [--max-per-session N]
 *     [--reranker on|off] [--qa-sessions N] [--qa-max-tokens N]
 *     [--paid --budget-run-id <id>] --output <dir>
 *
 * Memory-system cells (`--system`, `--arms`, `--replay`, `--sealed-profile`, `--provider-proxy` and the other flags in
 * run-systems.ts) run through run-systems.ts, the open-source comparison's harness, unchanged; this file dispatches to it.
 *
 * What it measures: judge-free session retrieval. Each conversation's
 * sessions are imported as pages into a fresh in-memory gbrain (PGLite), the
 * question goes through gbrain's hybrid search with the pinned search config
 * plus this arm's config overrides, and the retrieved chunks are reduced to
 * distinct sessions in rank order. Rows carry recall_all@5 (every gold
 * session in the top five distinct sessions), recall_any@5, recall_all@10,
 * nDCG@10 and latency. Abstention questions have no gold and are marked so a
 * comparison family excludes them.
 *
 * Facts lane (`--facts conversation`): pages import as conversation pages
 * with ISO session dates and gbrain's conversation-facts extractor runs on
 * each conversation before its questions; rows carry facts_count and
 * facts_unresolved_share, and every saved fact lands in facts.ndjson (with its
 * stored attributed_to when the build has the column).
 * `--qa reader --qa-context facts` answers from the
 * saved facts of the top sessions instead of their raw turns.
 *
 * Reading arms without a brain: `--retrieved-from <dir>` replays the ranked
 * session lists committed in another arm's rows (rows.ndjson[.gz], directly
 * or under shard-*), so a reader change is measured on byte-identical
 * evidence; `--qa-context none` gives the reader no history (the no-memory
 * floor) and `--qa-context oracle` gives it every gold session (the
 * oracle-evidence ceiling). None of the three imports or searches anything.
 *
 * Retrieval depth: `--search-limit N` chunks requested (default top-k x 3),
 * `--pool-depth N` the eval-only candidate pool per arm (gbrain's
 * setEvalPoolDepth), `--max-per-session N` the post-fusion per-page cap.
 *
 * The arm imports gbrain only through `importGbrain`, so `--gbrain` really
 * selects the build under test; the decision kit runs baseline and candidate
 * as separate processes. Gold ids, categories and answers never reach gbrain.
 *
 * Reranker (since 2026-10-12, BEAM-1M S1): on by default for every arm that
 * searches with real embeddings, as gbrain's balanced default ships it; off by
 * default only for keyless `--embed hash` arms, which make no provider call.
 * `--reranker off` (or an explicit `search.reranker.enabled=false` pin or
 * config) measures without it on purpose; the receipt's `reranker` block says
 * which and why, and every searched row carries its own `rerank` state.
 * With the reranker on, the run fails closed with the coded refusal
 * RERANKER_INACTIVE (exit 3, ask the user; no silent fallback): before any
 * search when the reranker's provider key is missing, and at the first query
 * that comes back without rerank scores or with a rerank degradation (failed,
 * skipped or passed through), after writing a receipt with
 * `run_status: refused`. A rerun of the same command resumes.
 *
 * Fidelity: a page saved without vectors (embedding_deferred) under an
 * embedding arm marks the run `invalid` — it measured a different pipeline
 * than the one named. With the reranker on, the budget ledger must also hold
 * at least one request to the reranker model per reranked query; otherwise
 * the run is `invalid`.
 *
 * Reading breadth: `--qa-sessions N` turn groups (sessions) per answer
 * (default 5), recorded as the receipt's `reading.breadth_sessions`;
 * `--qa-max-tokens N` the reader's output limit (default 1,024; OpenAI
 * reasoning models get at least 2,000), equal across readers when set.
 */
import '../budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { EmbeddingCache, makeCachingTransport } from '../longmemeval-cache.ts';
import { ndcgAtK, recallAllAtK, recallAnyAtK, uniqueInOrder, percentile } from '../metrics.ts';
import { loadCorpus, occurrenceId, renderSessionPage, sha256, type Corpus, type MemoryQuestion, type Session } from './corpus.ts';
import { ChatClient, DEFAULT_JUDGE, DEFAULT_READER, chatWithReceipts, factsReaderPrompt, judgeResponse, latestDate, packSessions, readerPrompt, repeatsTrap, sendsTemperature, unresolvedRelativeTime, type SavedFact } from './qa.ts';
import { normalizeUsage, receipt, sumUsage, thinkFinish, USAGE_RECEIPT_SCHEMA, type UsageReceipt } from '../usage-receipt.ts';
import { devConversations, loadSplit } from '../decisions/splits.ts';
import * as systems from './run-systems.ts';
export { readinessProbe, type ProbeResult } from './run-systems.ts';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';
import { decideError, DecideError, renderOperatorMessage } from '../decisions/errors.ts';

export interface RunArgs {
  benchmark: string;
  split: 'dev' | 'sealed';
  /** Custodian sealed runs: recorded in the access log (GBRAIN_EVALS_CUSTODY_LOG) before any sealed question is read. */
  custody?: { decisionId: string; purpose: string; log: string };
  /** benchmark `custody`: the custodian's sealed corpus file (outside the repository). */
  corpusFile?: string;
  gbrain: string | null;
  config: Record<string, string>;
  pins: Record<string, string>;
  embed: 'hash' | 'real';
  embeddingModel: string;
  embeddingDims: number;
  categories: string[] | null;
  limit: number | null;
  seed: number;
  topK: number;
  shard: { index: number; count: number };
  output: string;
  argv: string[];
  qa: { mode: 'none' | 'reader' | 'think'; reader: string; judge: string; runs: number; sessions: number; budgetTokens: number | null; thinkModel: string; context: 'sessions' | 'facts' | 'none' | 'oracle'; maxTokens?: number };
  /** Whether hybridSearch reranks, and what decided it (the flag, an explicit pin/config, or the harness default). */
  reranker: { enabled: boolean; decided_by: 'flag' | 'pin' | 'default' | 'keyless-default' };
  facts: 'none' | 'conversation';
  /** Replay the ranked session lists in this directory's rows instead of searching. */
  retrievedFrom: string | null;
  search: { limit: number | null; poolDepth: number | null; maxPerSession: number | null };
}

export interface MemoryQaRow {
  id: string;
  conversation: string;
  category: string;
  abstention: boolean;
  gold_count: number;
  recall_all_at_5?: number;
  recall_any_at_5?: number;
  recall_all_at_10?: number;
  ndcg_at_10?: number;
  retrieved?: string[];
  latency_ms?: number;
  /** Searched rows only: whether this query's results were reranked (`reranked`), the reranker was off, or the search returned nothing. */
  rerank?: { state: 'reranked' | 'off' | 'no_results'; model?: string };
  qa_score?: number;
  qa_scores?: number[];
  qa_runs?: number;
  qa_trap?: number;
  qa_input_tokens?: number;
  qa_output_tokens?: number;
  qa_context_tokens?: number;
  qa_sessions?: number;
  /** Mean delivered tokens per answer (cl100k of the reader prompt; think's own delivery count). */
  qa_delivered_tokens?: number;
  /** Answers whose provider response carried no usage; qa_input_tokens and qa_output_tokens are then absent. */
  qa_usage_missing?: number;
  /** The final replicate's full answer; every replicate's answer is in qa_receipts. */
  qa_answer?: string;
  /** One usage-receipt/v1 record per attempted reader, think and judge invocation, every replicate. */
  qa_receipts?: UsageReceipt[];
  qa_error?: string;
  qa_facts?: number;
  qa_facts_tokens?: number;
  facts_count?: number;
  facts_unresolved_share?: number;
  facts_extract_error?: string;
  error?: string | null;
  error_origin?: 'sut' | 'harness' | 'dependency';
}

/** The part of hybridSearch's onMeta report the reranker fidelity check reads. */
type SearchMeta = { degraded?: Array<string | { stage?: string; reason?: string }> };

const DEFAULT_PINS: Record<string, string> = { 'search.mode': 'balanced', 'search.autocut': 'false' };
const RECYCLE_EVERY = 25;
const repoRelative = (p: string) => p.replace(resolve(import.meta.dir, '../../..') + '/', '');
/** Planning estimate for one session through the conversation-facts extractor (product default model). */
const FACTS_USD_PER_SESSION = 0.03;
const PRESERVE_TABLES = new Set(['sources', 'config', 'gbrain_cycle_locks', 'subagent_rate_leases', 'persistence_brain', 'shared_skill_state', 'page_generation_clock']);

function kv(list: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`${flag} needs key=value (got ${item})`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

function positiveInt(v: string | undefined, flag: string): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer (got ${v})`);
  return n;
}

/** Ranked session lists by question id from an arm's rows (rows.ndjson or rows.ndjson.gz, in the directory or its shard-* subdirectories); errored rows are skipped. */
export function loadFrozenRetrieval(dir: string): { lists: Map<string, string[]>; files: Array<{ path: string; sha256: string }> } {
  const dirs = existsSync(join(dir, 'rows.ndjson')) || existsSync(join(dir, 'rows.ndjson.gz')) ? [dir]
    : readdirSync(dir).filter(d => d.startsWith('shard-')).sort().map(d => join(dir, d));
  const lists = new Map<string, string[]>();
  const files: Array<{ path: string; sha256: string }> = [];
  for (const d of dirs) {
    const path = existsSync(join(d, 'rows.ndjson.gz')) ? join(d, 'rows.ndjson.gz') : join(d, 'rows.ndjson');
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
    const text = path.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    for (const line of text.split('\n')) if (line.trim()) {
      const r = JSON.parse(line) as MemoryQaRow;
      if (!r.error && Array.isArray(r.retrieved)) lists.set(r.id, r.retrieved);
    }
  }
  if (!lists.size) throw new Error(`--retrieved-from ${dir}: no rows with retrieved lists found`);
  return { lists, files };
}

/** Rerank requests the budget ledger recorded for this run (and this process, when it joined a shared run), by provider:model. */
export function ledgerRerankRequests(ledgerPath: string, runId: string, participant: string | null): Record<string, number> {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const where = participant === null ? 'run_id = ?' : 'run_id = ? AND participant = ?';
    const rows = db.query(`SELECT description, COUNT(*) AS n FROM entries WHERE ${where} AND description LIKE '% rerank' GROUP BY description ORDER BY description`)
      .all(...(participant === null ? [runId] : [runId, participant])) as Array<{ description: string; n: number }>;
    return Object.fromEntries(rows.map(r => [r.description.replace(/ rerank$/, ''), r.n]));
  } finally { db.close(); }
}

/** Flags only the memory-system harness (run-systems.ts) takes; any of them sends the run there. */
const SYSTEMS_FLAGS = ['--system', '--arms', '--replay', '--sealed-profile', '--provider-proxy', '--proxy-slot', '--context', '--policy', '--policy-setting',
  '--max-attempts', '--finish-timeout-s', '--ingest-timeout-s', '--ingest-replicate', '--no-retry-upstream-5xx', '--budget-tokens', '--frozen-from'];
export const isSystemsArgv = (argv: string[]) => argv.some(x => SYSTEMS_FLAGS.includes(x));
export type SystemsRunArgs = systems.RunArgs;

/**
 * `--reranker on|off` wins; an explicit `search.reranker.enabled` pin or config must agree with it. Without either the
 * reranker is on, except for keyless hash-embedding arms, which make no provider call.
 */
export function resolveReranker(flag: string | undefined, explicit: string | undefined, embed: 'hash' | 'real'): RunArgs['reranker'] {
  if (flag !== undefined && flag !== 'on' && flag !== 'off') throw new Error(`--reranker must be on or off (got ${flag})`);
  if (explicit !== undefined && explicit !== 'true' && explicit !== 'false') throw new Error(`search.reranker.enabled must be true or false (got ${explicit})`);
  if (flag !== undefined && explicit !== undefined && (flag === 'on') !== (explicit === 'true')) throw new Error(`--reranker ${flag} contradicts search.reranker.enabled=${explicit}`);
  if (flag !== undefined) return { enabled: flag === 'on', decided_by: 'flag' };
  if (explicit !== undefined) return { enabled: explicit === 'true', decided_by: 'pin' };
  return embed === 'hash' ? { enabled: false, decided_by: 'keyless-default' } : { enabled: true, decided_by: 'default' };
}

/** The coded refusal for a reranker that is on but did not run (fail closed, never a silent unreranked fallback). */
export function rerankerInactive(message: string, rerankModel: string): DecideError {
  return decideError({ code: 'RERANKER_INACTIVE', message, why: `the arm names gbrain's reranked pipeline (${rerankModel}); results without it would be reported as reranked`,
    fix: { next: 'ask_user', user_message: `make the reranker reachable (provider key and endpoint for ${rerankModel}) and rerun the same command, which resumes; or pass --reranker off to measure without reranking on purpose and say so in the preregistration` } });
}

export function parseRunArgs(argv: string[]): RunArgs {
  if (isSystemsArgv(argv)) return systems.parseRunArgs(argv) as unknown as RunArgs;
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const benchmark = one('--benchmark');
  if (!benchmark) throw new Error('--benchmark is required');
  const output = one('--output');
  if (!output) throw new Error('--output <dir> is required');
  const split = one('--split') ?? 'dev';
  let custody: RunArgs['custody'];
  if (split === 'sealed') {
    const decisionId = one('--decision-id'), purpose = one('--purpose'), log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
    if (!decisionId || !purpose || !log) throw new Error('--split sealed is custodian-only and needs --decision-id, --purpose and GBRAIN_EVALS_CUSTODY_LOG (the custodian access-log path)');
    custody = { decisionId, purpose, log };
  } else if (split !== 'dev') throw decideError({ code: 'SEALED_SOURCE_IN_DEV', message: `--split ${split} is not available to dev runs`,
    why: 'sealed conversations open only through the custodian at a preregistered decision', fix: { next: 'ask_user', user_message: 'request a held-out run from the custodian with `bun run eval:decide request`' } });
  const shardRaw = one('--shard') ?? '0/1';
  const [si, sn] = shardRaw.split('/').map(Number);
  if (!Number.isInteger(si) || !Number.isInteger(sn) || sn < 1 || si < 0 || si >= sn) throw new Error('--shard must look like i/n with 0 <= i < n');
  const embed = (one('--embed') ?? (benchmark === 'fixture' ? 'hash' : 'real')) as 'hash' | 'real';
  if (!['hash', 'real'].includes(embed)) throw new Error('--embed must be hash or real');
  const config = kv(many('--config'), '--config');
  const pins = { ...DEFAULT_PINS, ...kv(many('--pin'), '--pin') };
  const reranker = resolveReranker(one('--reranker'), config['search.reranker.enabled'] ?? pins['search.reranker.enabled'], embed);
  pins['search.reranker.enabled'] = String(reranker.enabled);
  delete config['search.reranker.enabled'];
  return {
    benchmark, split: split as 'dev' | 'sealed', custody, corpusFile: one('--corpus-file'), gbrain: gbrainSpecFrom(argv), config, pins, embed, reranker,
    embeddingModel: one('--embedding-model') ?? 'openai:text-embedding-3-large',
    embeddingDims: Number(one('--embedding-dims') ?? 1536),
    categories: one('--categories') ? one('--categories')!.split(',').map(s => s.trim()).filter(Boolean) : null,
    limit: one('--limit') ? Number(one('--limit')) : null,
    seed: Number(one('--seed') ?? 42), topK: Number(one('--top-k') ?? 10),
    shard: { index: si, count: sn }, output: resolve(output), argv,
    qa: {
      mode: (one('--qa') ?? 'none') as 'none' | 'reader' | 'think',
      reader: one('--reader') ?? DEFAULT_READER[benchmark] ?? 'openai:gpt-4o-2024-08-06',
      judge: one('--judge') ?? DEFAULT_JUDGE[benchmark] ?? 'openai:gpt-4o-2024-08-06',
      runs: Number(one('--qa-runs') ?? 1), sessions: Number(one('--qa-sessions') ?? 5),
      budgetTokens: one('--qa-budget-tokens') ? Number(one('--qa-budget-tokens')) : null,
      thinkModel: one('--think-model') ?? 'anthropic:claude-sonnet-5-5',
      context: (one('--qa-context') ?? 'sessions') as RunArgs['qa']['context'],
      ...(one('--qa-max-tokens') ? { maxTokens: positiveInt(one('--qa-max-tokens'), '--qa-max-tokens')! } : {}),
    },
    facts: (one('--facts') ?? 'none') as 'none' | 'conversation',
    retrievedFrom: one('--retrieved-from') ? resolve(one('--retrieved-from')!) : null,
    search: { limit: positiveInt(one('--search-limit'), '--search-limit'), poolDepth: positiveInt(one('--pool-depth'), '--pool-depth'), maxPerSession: positiveInt(one('--max-per-session'), '--max-per-session') },
  };
}

/** Deterministic, category-stratified subset: questions sorted by sha256(seed, id) within each category, round-robin across categories. */
export function selectQuestions(questions: MemoryQuestion[], limit: number | null, seed: number): MemoryQuestion[] {
  if (limit === null || limit >= questions.length) return questions;
  const key = (q: MemoryQuestion) => createHash('sha256').update(`${seed}\u0000${q.id}`).digest('hex');
  const byCat = new Map<string, MemoryQuestion[]>();
  for (const q of questions) byCat.set(q.category, [...(byCat.get(q.category) ?? []), q]);
  for (const list of byCat.values()) list.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const cats = [...byCat.keys()].sort();
  const out: MemoryQuestion[] = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const c of cats) {
      const q = byCat.get(c)![round];
      if (q && out.length < limit) { out.push(q); added = true; }
    }
    if (!added) break;
  }
  return out;
}

export function scoreRetrieval(retrieved: string[], gold: string[]): Pick<MemoryQaRow, 'recall_all_at_5' | 'recall_any_at_5' | 'recall_all_at_10' | 'ndcg_at_10'> {
  const rel = new Set(gold);
  const grades = new Map(gold.map(g => [g, 1]));
  return {
    recall_all_at_5: recallAllAtK(retrieved, rel, 5), recall_any_at_5: recallAnyAtK(retrieved, rel, 5),
    recall_all_at_10: recallAllAtK(retrieved, rel, 10), ndcg_at_10: ndcgAtK(retrieved, grades, 10),
  };
}

export function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  for (const tok of tokens) vec[createHash('sha256').update(tok).digest().readUInt32BE(0) % dims] += 1;
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

const PROVIDER_KEY: Record<string, string> = { openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' };

export function runConfigHash(a: RunArgs, gut: GbrainUnderTest, corpus: Corpus, frozenFiles: Array<{ sha256: string }> | null = null): string {
  const pre = { benchmark: a.benchmark, split: a.split, config: a.config, pins: a.pins, embed: a.embed, model: a.embeddingModel, dims: a.embeddingDims, qa: a.qa,
    categories: a.categories, limit: a.limit, seed: a.seed, topK: a.topK, gbrain: gut.overlay?.build.commit ?? gut.version, data: corpus.source.files, ...(a.facts !== 'none' ? { facts: a.facts } : {}),
    ...(frozenFiles ? { retrieved_from: frozenFiles.map(f => f.sha256) } : {}), ...(a.search.limit || a.search.poolDepth || a.search.maxPerSession ? { search: a.search } : {}) };
  return createHash('sha256').update(JSON.stringify(pre)).digest('hex');
}

/** cl100k counter from the gbrain build under test, or null when that build has no cl100k encoder (delivered tokens are then left out). */
async function cl100kCounter(gut: GbrainUnderTest): Promise<((s: string) => number) | null> {
  try {
    const t = await importGbrain<{ estimateTokens: (s: string) => number; cl100kAvailable: () => boolean }>(gut, 'src/core/chunkers/token-estimate.ts');
    return t.cl100kAvailable() ? t.estimateTokens : null;
  } catch {
    return null;
  }
}

type ThinkFn = (engine: unknown, o: Record<string, unknown>) => Promise<{
  answer: string; synthesis_status?: string; modelUsed?: string;
  usage?: { input_tokens: number; output_tokens: number } | null;
  evidence_delivery?: { tokens_delivered: number; tokenizer: string };
}>;

/**
 * The reading lane for one question: answer (reader prompt or gbrain think)
 * and judge, `qa.runs` times. Every attempted invocation leaves a receipt;
 * token means come from provider usage (think's returned usage, never the
 * question's length) and are left out when any answer lacked usage.
 */
export async function readAndJudge(p: {
  benchmark: string; qa: RunArgs['qa']; q: MemoryQuestion; chat: ChatClient;
  think: { fn: ThinkFn; engine: unknown } | null; prompt: string | null; countTokens: ((s: string) => number) | null;
}): Promise<Partial<MemoryQaRow>> {
  const receipts: UsageReceipt[] = [];
  const scores: number[] = [];
  let answer = '';
  let trap = 0;
  try {
    for (let r = 0; r < p.qa.runs; r++) {
      if (p.think) {
        const base = { lane: 'memory-qa', role: 'think' as const, question_id: p.q.id, replicate: r, attempt: 0, model: p.qa.thinkModel, from_cache: false };
        let res: Awaited<ReturnType<ThinkFn>>;
        try {
          res = await p.think.fn(p.think.engine, { question: p.q.question, model: p.qa.thinkModel, modelExplicit: true, remote: false });
        } catch (e) {
          receipts.push(receipt({ ...base, response_model: null, status: 'error', error: (e as Error).message.slice(0, 300), finish: null, finish_raw: null, answer: '', usage: null, usage_raw: null, delivered: null }));
          throw e;
        }
        answer = res.answer ?? '';
        const d = res.evidence_delivery;
        receipts.push(receipt({ ...base, response_model: res.modelUsed ?? null, status: 'ok', error: null, finish: thinkFinish(res.synthesis_status), finish_raw: res.synthesis_status ?? null,
          answer, usage: normalizeUsage('gbrain-think', res.usage), usage_raw: res.usage ?? null, delivered: d ? { tokenizer: d.tokenizer, tokens: d.tokens_delivered } : null }));
      } else {
        const delivered = p.countTokens ? { tokenizer: 'cl100k', tokens: p.countTokens(p.prompt!) } : null;
        answer = (await chatWithReceipts(p.chat, { role: 'reader', question_id: p.q.id, replicate: r, model: p.qa.reader, delivered }, p.prompt!, { maxTokens: p.qa.maxTokens ?? 1024, replicate: r }, receipts)).text;
      }
      scores.push(await judgeResponse(p.chat, p.benchmark, p.qa.judge, p.q, answer, r, receipts));
      if (p.q.abstention && repeatsTrap(answer, p.q.trap)) trap++;
    }
  } catch (e) {
    return { qa_error: (e as Error).message.slice(0, 300), qa_receipts: receipts };
  }
  const answers = receipts.filter(x => x.role !== 'judge' && x.status === 'ok');
  const missing = answers.filter(x => !x.usage).length;
  const mean = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
  return {
    qa_score: scores.reduce((x, y) => x + y, 0) / scores.length, qa_scores: scores, qa_runs: scores.length, ...(p.q.trap ? { qa_trap: trap / scores.length } : {}),
    ...(missing ? { qa_usage_missing: missing } : { qa_input_tokens: mean(answers.map(x => x.usage!.input_total)), qa_output_tokens: mean(answers.map(x => x.usage!.output_total)) }),
    ...(answers.every(x => x.delivered) ? { qa_delivered_tokens: mean(answers.map(x => x.delivered!.tokens)) } : {}),
    qa_answer: answer, qa_receipts: receipts,
  };
}

export async function runArm(a: RunArgs): Promise<{ receipt: Record<string, unknown>; rows: MemoryQaRow[] }> {
  if ('system' in a) return systems.runArm(a as unknown as systems.RunArgs) as unknown as Promise<{ receipt: Record<string, unknown>; rows: MemoryQaRow[] }>;
  const started = new Date().toISOString();
  mkdirSync(a.output, { recursive: true });
  const gut = resolveGbrainUnderTest(a.gbrain);
  if (a.benchmark === 'custody' && a.split !== 'sealed') throw new Error('benchmark custody is a custodian sealed corpus: run it with --split sealed');
  if (a.split === 'sealed') {
    if (!a.custody) throw new Error('sealed memory-qa runs need custody (decision id, purpose, access log)');
    appendAccessLog(a.custody.log, { action: 'open', purpose: `memory-qa ${a.benchmark} sealed: ${a.custody.purpose}`, decision_id: a.custody.decisionId, labels_sha256: a.benchmark === 'custody' && a.corpusFile ? sha256(readFileSync(a.corpusFile)) : 'public-split-file', run_sha256: null });
  }
  const allowed = a.benchmark === 'custody' ? null : a.split === 'sealed' ? new Set(loadSplit(a.benchmark).sealed) : devConversations(a.benchmark);
  const corpus = loadCorpus(a.benchmark, a.corpusFile, allowed ?? undefined);
  let questions = corpus.questions.filter(q => !allowed || allowed.has(q.conversation));
  if (a.categories) questions = questions.filter(q => a.categories!.includes(q.category));
  questions = selectQuestions(questions, a.limit, a.seed);
  const convIds = uniqueInOrder(questions.map(q => q.conversation)).sort();
  const myConvs = convIds.filter((_, i) => i % a.shard.count === a.shard.index);
  const byConv = new Map(corpus.conversations.map(c => [c.id, c]));

  if (!['none', 'reader', 'think'].includes(a.qa.mode)) throw new Error('--qa must be none, reader or think');
  if (!['none', 'conversation'].includes(a.facts)) throw new Error('--facts must be none or conversation');
  if (!['sessions', 'facts', 'none', 'oracle'].includes(a.qa.context)) throw new Error('--qa-context must be sessions, facts, none or oracle');
  if (a.qa.context === 'facts' && (a.facts === 'none' || a.qa.mode !== 'reader')) throw new Error('--qa-context facts needs --facts conversation and --qa reader');
  if ((a.qa.context === 'none' || a.qa.context === 'oracle') && a.qa.mode !== 'reader') throw new Error(`--qa-context ${a.qa.context} needs --qa reader`);
  if ((a.retrievedFrom || a.qa.context === 'none' || a.qa.context === 'oracle') && (a.qa.mode === 'think' || a.facts !== 'none')) throw new Error('--retrieved-from and --qa-context none|oracle build no brain, so they cannot run think or the facts lane');
  const frozen = a.retrievedFrom ? loadFrozenRetrieval(a.retrievedFrom) : null;
  // No brain is built when the evidence is replayed, empty or the gold sessions themselves.
  const brainless = !!frozen || a.qa.context === 'none' || a.qa.context === 'oracle';
  const hash = runConfigHash(a, gut, corpus, frozen?.files ?? null);
  const rowsPath = join(a.output, 'rows.ndjson');
  const headerPath = join(a.output, 'run-config.json');
  const done = new Set<string>();
  type Attempt = { run_status: string; finished_at: string; rows_added: number; reranked_queries: number; rerank_provider_requests: Record<string, number> | null; embedding_deferred_pages: number; usd: number | null };
  let priorAttempts: Attempt[] = [];
  if (existsSync(headerPath)) {
    const prior = JSON.parse(readFileSync(headerPath, 'utf8')) as { run_config_hash: string };
    if (prior.run_config_hash !== hash) throw new Error(`${a.output} holds rows from a different run configuration; use a fresh --output`);
    if (existsSync(rowsPath)) for (const line of readFileSync(rowsPath, 'utf8').split('\n')) if (line.trim()) {
      const r = JSON.parse(line) as MemoryQaRow;
      if (!r.error) done.add(r.id);
    }
    const receiptPath = join(a.output, 'receipt.json');
    if (existsSync(receiptPath)) {
      const prev = JSON.parse(readFileSync(receiptPath, 'utf8')) as { run_status: string; finished_at: string; counts?: { rows: number }; attempts?: Attempt[]; fidelity?: Partial<Attempt>; cost?: { usd?: number } | null };
      priorAttempts = prev.attempts ?? [{ run_status: prev.run_status, finished_at: prev.finished_at, rows_added: prev.counts?.rows ?? 0, reranked_queries: prev.fidelity?.reranked_queries ?? 0,
        rerank_provider_requests: prev.fidelity?.rerank_provider_requests ?? null, embedding_deferred_pages: prev.fidelity?.embedding_deferred_pages ?? 0, usd: prev.cost?.usd ?? null }];
    }
  }
  const rowsBefore = existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8').split('\n').filter(l => l.trim()).length : 0;
  writeFileSync(headerPath, JSON.stringify({ run_config_hash: hash, benchmark: a.benchmark, shard: a.shard }, null, 2));

  // Gateway: hash vectors (keyless) or the real provider through the budget ledger and the content-addressed cache.
  const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  let cache: EmbeddingCache | null = null;
  const provider = a.embeddingModel.split(':')[0];
  const rerankOn = !brainless && a.reranker.enabled;
  const needsPaid = (!brainless && a.embed === 'real') || rerankOn || a.qa.mode !== 'none' || a.facts !== 'none';
  const rerankModel = a.config['search.reranker.model'] ?? a.pins['search.reranker.model']
    ?? (rerankOn ? (await importGbrain<{ DEFAULT_RERANKER_MODEL?: string }>(gut, 'src/core/ai/defaults.ts').catch(() => ({} as { DEFAULT_RERANKER_MODEL?: string }))).DEFAULT_RERANKER_MODEL ?? null : null);
  if (rerankOn) {
    const keyEnv = PROVIDER_KEY[(rerankModel ?? 'voyage:').split(':')[0]];
    if (keyEnv && !process.env[keyEnv]) throw rerankerInactive(`the reranker is on but ${keyEnv} is not set, so every search would fall back to unreranked order (nothing was searched)`, rerankModel ?? 'the default reranker');
  }
  if (needsPaid) {
    const perQuestion: Record<string, number> = { 'lme-s': 0.012, custody: 0.002, locomo: 0.002, 'beam-100k': 0.01, 'beam-500k': 0.02, 'beam-1m': 0.03, fixture: 0 };
    const perQa: Record<string, number> = { none: 0, reader: a.benchmark === 'lme-s' ? 0.05 : 0.01, think: 0.08 };
    const mine = questions.filter(q => myConvs.includes(q.conversation)).length;
    const factSessions = a.facts === 'none' ? 0 : myConvs.reduce((n, id) => n + (byConv.get(id)?.sessions.length ?? 0), 0);
    const estimate = Math.max(0.05, Math.round((((a.embed === 'real' && !brainless ? perQuestion[a.benchmark] ?? 0.02 : 0) + perQa[a.qa.mode] * a.qa.runs) * mine + FACTS_USD_PER_SESSION * factSessions) * 100) / 100);
    try { requirePaidArm(a.argv, { arm: `memory-qa ${a.benchmark}`, estimateUsd: estimate }); }
    catch (e) {
      throw decideError({ code: 'PAID_FLAGS_MISSING', message: (e as Error).message, why: 'real embeddings and the reading lane call paid providers, and every paid request is reserved in the budget ledger first',
        fix: { next: 'run', argv: ['bun', 'eval/runner/budget-ledger.ts', 'status'], verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] } });
    }
    paid = startPaidRun(`memory-qa:${a.benchmark}`, { ...budgetOptionsFrom(a.argv), estimateUsd: estimate });
  }
  if (brainless) { /* nothing is embedded or searched */ }
  else if (a.embed === 'hash') {
    const keyEnv = PROVIDER_KEY[provider] ?? 'OPENAI_API_KEY';
    if (!process.env[keyEnv]) process.env[keyEnv] = 'hash-embed-transport-no-provider-call';
    process.env.GBRAIN_MODEL_DISCOVERY = 'off';
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env });
    gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbed(v, a.embeddingDims)), values: params.values, warnings: [], usage: { tokens: 0 } }));
  } else {
    gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env });
    const aiPath = Bun.resolveSync('ai', gut.root);
    const { embedMany } = await import(aiPath) as { embedMany: (p: unknown) => Promise<unknown> };
    const cacheDir = process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
    mkdirSync(cacheDir, { recursive: true });
    const key = `${a.embeddingModel}@${a.embeddingDims}`;
    cache = new EmbeddingCache(join(cacheDir, `embed-cache-${key.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`), key);
    gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: { values: string[] } & Record<string, unknown>) => embedMany(p) as never, cache));
  }

  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => any }>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<{ importFromContent: (e: unknown, slug: string, content: string, o?: Record<string, unknown>) => Promise<{ embedding_deferred?: boolean }> }>(gut, 'src/core/import-file.ts');
  const { hybridSearch } = await importGbrain<{ hybridSearch: (e: unknown, q: string, o?: Record<string, unknown>) => Promise<Array<{ slug: string; rerank_score?: number }>> }>(gut, 'src/core/search/hybrid.ts');
  if (a.search.poolDepth !== null) {
    const { setEvalPoolDepth } = await importGbrain<{ setEvalPoolDepth: (n: number | null) => void }>(gut, 'src/core/search/eval-pool-depth.ts');
    setEvalPoolDepth(a.search.poolDepth);
  }

  const extractFacts = a.facts === 'conversation'
    ? (await importGbrain<{ runExtractConversationFactsCore: (e: unknown, o: Record<string, unknown>) => Promise<{ pages_processed: number; pages_failed: number; facts_extracted: number }> }>(gut, 'src/commands/extract-conversation-facts.ts')).runExtractConversationFactsCore
    : null;
  const factStats = { conversations: 0, pages_processed: 0, pages_failed: 0, facts: 0, unresolved: 0, errors: 0 };
  const think = a.qa.mode === 'think' ? (await importGbrain<{ runThink: ThinkFn }>(gut, 'src/core/think/index.ts')).runThink : null;
  const countTokens = a.qa.mode === 'reader' ? await cl100kCounter(gut) : null;
  const chat = a.qa.mode === 'none' ? null : new ChatClient(process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));
  const openEngine = async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    for (const [k, v] of Object.entries({ ...a.pins, ...a.config })) await e.setConfig(k, v);
    return e;
  };
  const reset = async (e: any) => {
    const rows = await e.executeRaw(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`) as Array<{ tablename: string }>;
    const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
    if (targets.length) await e.executeRaw(`TRUNCATE ${targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ')} RESTART IDENTITY CASCADE`);
  };

  const fidelity = { embedding_deferred_pages: 0, reranked_queries: 0, rerank_provider_requests: null as Record<string, number> | null };
  let refusal: DecideError | null = null;
  const rows: MemoryQaRow[] = [];
  let engine = brainless ? null : await openEngine();
  let processed = 0;
  try {
    for (const convId of myConvs) {
      const qs = questions.filter(q => q.conversation === convId && !done.has(q.id));
      if (!qs.length) continue;
      if (paid?.guard.exhausted) break;
      if (engine && processed > 0 && processed % RECYCLE_EVERY === 0) { try { await engine.disconnect(); } catch { /* ignore */ } engine = await openEngine(); }
      else if (engine && processed > 0) await reset(engine);
      processed++;
      const conv = byConv.get(convId)!;
      const bySlug = new Map<string, string>();
      let importError: string | null = null;
      if (engine) for (const s of conv.sessions) {
        const slug = `chat/${occurrenceId(conv.id, s.id)}`;
        bySlug.set(slug, s.id);
        try {
          const res = await importFromContent(engine, slug, renderSessionPage(s, { as: extractFacts ? 'conversation' : 'note' }), {});
          if (res?.embedding_deferred) fidelity.embedding_deferred_pages++;
        } catch (e) { importError = (e as Error).message; break; }
      }
      const factsBySession = new Map<string, SavedFact[]>();
      let convFacts: Pick<MemoryQaRow, 'facts_count' | 'facts_unresolved_share' | 'facts_extract_error'> = {};
      if (extractFacts && !importError) {
        let extractError: string | null = null;
        try {
          const res = await extractFacts(engine, { sourceId: 'default', slugs: [...bySlug.keys()], types: ['conversation'], force: true });
          factStats.pages_processed += res.pages_processed; factStats.pages_failed += res.pages_failed;
          if (res.pages_failed) extractError = `${res.pages_failed} of ${bySlug.size} pages failed extraction`;
        } catch (e) {
          factStats.errors++;
          extractError = (e as Error).message.slice(0, 300);
        }
        // Whatever the extractor saved before a failure is what the brain holds, so it is read and scored either way.
        const facts = await engine.executeRaw(`SELECT fact, valid_from, source_markdown_slug, to_jsonb(facts)->>'attributed_to' AS attributed_to FROM facts WHERE expired_at IS NULL AND source NOT LIKE 'cli:extract-conversation-facts:terminal%' AND source NOT LIKE 'cli:extract-conversation-facts:non-extractable%' ORDER BY valid_from, id`) as Array<{ fact: string; valid_from: Date | string | null; source_markdown_slug: string | null; attributed_to: string | null }>;
        for (const f of facts) {
          const sessionId = f.source_markdown_slug ? bySlug.get(f.source_markdown_slug) : undefined;
          if (!sessionId) continue;
          factsBySession.set(sessionId, [...(factsBySession.get(sessionId) ?? []), { fact: f.fact, valid_from: f.valid_from ? new Date(f.valid_from).toISOString() : null }]);
        }
        appendFileSync(join(a.output, 'facts.ndjson'), facts.map(f => JSON.stringify({ conversation: convId, session: f.source_markdown_slug ? bySlug.get(f.source_markdown_slug) ?? null : null,
          valid_from: f.valid_from ? new Date(f.valid_from).toISOString() : null, fact: f.fact, attributed_to: f.attributed_to, unresolved: unresolvedRelativeTime(f.fact) }) + '\n').join(''));
        const unresolved = facts.filter(f => unresolvedRelativeTime(f.fact)).length;
        factStats.conversations++; factStats.facts += facts.length; factStats.unresolved += unresolved;
        convFacts = { facts_count: facts.length, facts_unresolved_share: facts.length ? unresolved / facts.length : 0,
          ...(extractError ? { facts_extract_error: extractError } : {}) };
      }
      for (const q of qs) {
        const base: MemoryQaRow = { id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length, ...convFacts };
        let row: MemoryQaRow;
        if (importError) row = { ...base, error: `import failed: ${importError}`, error_origin: 'sut' };
        else if (frozen && !frozen.lists.has(q.id)) row = { ...base, error: `no frozen ranked list for ${q.id} in ${a.retrievedFrom}`, error_origin: 'harness' };
        else {
          const t0 = performance.now();
          try {
            let retrieved: string[] = [];
            if (frozen) {
              retrieved = frozen.lists.get(q.id)!.slice(0, a.topK);
              row = { ...base, ...scoreRetrieval(retrieved, q.gold), retrieved, error: null };
            } else if (engine) {
              const seen: { meta: SearchMeta | null } = { meta: null };
              const results = await hybridSearch(engine, q.question, { limit: a.search.limit ?? a.topK * 3, expansion: false,
                ...(a.search.maxPerSession ? { dedupOpts: { maxPerPage: a.search.maxPerSession } } : {}), onMeta: (m: SearchMeta) => { seen.meta = m; } });
              const latency = performance.now() - t0;
              let rerank: MemoryQaRow['rerank'] = { state: !results.length ? 'no_results' : rerankOn ? 'reranked' : 'off' };
              if (rerank.state === 'reranked') {
                const stages = (seen.meta?.degraded ?? []).map(d => (typeof d === 'string' ? d : `${d.stage ?? ''}${d.reason ? `: ${d.reason}` : ''}`)).filter(st => /rerank/.test(st));
                if (!results.some(r => r.rerank_score !== undefined) || stages.length) {
                  throw rerankerInactive(`question ${q.id} came back ${stages.length ? `with a rerank degradation (${stages.join(', ')})` : 'without rerank scores'} although the reranker is on; the run stopped there`, rerankModel ?? 'the default reranker');
                }
                fidelity.reranked_queries++;
                if (rerankModel) rerank = { ...rerank, model: rerankModel };
              }
              retrieved = uniqueInOrder(results.map(r => bySlug.get(r.slug) ?? `?${r.slug}`)).slice(0, a.topK);
              row = { ...base, ...scoreRetrieval(retrieved, q.gold), retrieved, latency_ms: Math.round(latency * 10) / 10, rerank, error: null };
            } else row = { ...base, error: null };
            if (chat) {
              const sessById = new Map(conv.sessions.map(x => [x.id, x]));
              const evidence = a.qa.context === 'none' ? [] : a.qa.context === 'oracle' ? q.gold : retrieved;
              const pack = packSessions(evidence.map(id => sessById.get(id)).filter((x): x is Session => !!x), a.qa.context === 'oracle' ? evidence.length : a.qa.sessions, a.qa.budgetTokens);
              const readFacts = a.qa.context === 'facts' ? retrieved.slice(0, a.qa.sessions).flatMap(id => factsBySession.get(id) ?? []) : [];
              const prompt = think ? null : a.qa.context === 'facts' ? factsReaderPrompt(q, readFacts, latestDate(conv.sessions)) : readerPrompt(q, pack.sessions, latestDate(conv.sessions));
              row = { ...row, ...await readAndJudge({ benchmark: a.benchmark, qa: a.qa, q, chat, think: think ? { fn: think, engine } : null, prompt, countTokens }),
                qa_context_tokens: think || a.qa.context === 'facts' ? undefined : pack.tokens, qa_sessions: think || a.qa.context === 'facts' ? undefined : pack.sessions.length,
                ...(a.qa.context === 'facts' ? { qa_facts: readFacts.length, qa_facts_tokens: systems.factsContextTokens(readFacts) } : {}) };
            }
          } catch (e) {
            if (e instanceof DecideError) throw e;
            row = { ...base, error: (e as Error).message, error_origin: /budget|BudgetExceeded/i.test((e as Error).message) ? 'harness' : 'sut' };
          }
        }
        rows.push(row);
        appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      }
    }
  } catch (e) {
    if (!(e instanceof DecideError && e.op.code === 'RERANKER_INACTIVE')) throw e;
    refusal = e;
  } finally {
    try { await engine?.disconnect(); } catch { /* ignore */ }
    cache?.close();
  }

  const allRows: MemoryQaRow[] = (existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8') : '').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const scored = allRows.filter(r => !r.abstention && !r.error && r.gold_count > 0);
  const mean = (k: keyof MemoryQaRow) => scored.length ? scored.reduce((s, r) => s + Number(r[k] ?? 0), 0) / scored.length : null;
  const retrievalScored = !!frozen || !brainless;
  const invalidReasons: string[] = [];
  const expected = questions.filter(q => myConvs.includes(q.conversation)).length;
  let cost: Record<string, unknown> | null = null;
  if (paid && rerankOn) fidelity.rerank_provider_requests = ledgerRerankRequests(paid.run.ledgerPath, paid.run.runId, paid.run.participant);
  const attemptFidelity = { ...fidelity };
  for (const p of priorAttempts) {
    fidelity.reranked_queries += p.reranked_queries;
    fidelity.embedding_deferred_pages += p.embedding_deferred_pages;
    if (p.rerank_provider_requests) {
      fidelity.rerank_provider_requests ??= {};
      for (const [m, n] of Object.entries(p.rerank_provider_requests)) fidelity.rerank_provider_requests[m] = (fidelity.rerank_provider_requests[m] ?? 0) + n;
    }
  }
  if (fidelity.embedding_deferred_pages > 0) invalidReasons.push(`${fidelity.embedding_deferred_pages} pages were saved without vectors (embedding_deferred), so vector retrieval was not what ran`);
  if (paid) {
    if (rerankOn) {
      const metered = rerankModel ? fidelity.rerank_provider_requests![rerankModel] ?? 0 : Object.values(fidelity.rerank_provider_requests!).reduce((x, y) => x + y, 0);
      if (metered < fidelity.reranked_queries || (fidelity.reranked_queries === 0 && allRows.length > 0)) invalidReasons.push(`the budget ledger holds ${metered} ${rerankModel ?? 'rerank'} requests for ${fidelity.reranked_queries} reranked queries`);
    }
    const summary = paid.run.close();
    paid.guard.uninstall();
    cost = receiptCost(summary) as unknown as Record<string, unknown>;
  }
  const runStatus = refusal ? 'refused' : invalidReasons.length ? 'invalid' : allRows.length < expected ? 'partial' : 'complete';
  const finishedAt = new Date().toISOString();
  const attempts: Attempt[] = [...priorAttempts, { run_status: runStatus, finished_at: finishedAt, rows_added: allRows.length - rowsBefore, reranked_queries: attemptFidelity.reranked_queries,
    rerank_provider_requests: attemptFidelity.rerank_provider_requests, embedding_deferred_pages: attemptFidelity.embedding_deferred_pages, usd: (cost?.usd as number | undefined) ?? null }];
  const receipt = {
    kind: 'memory-qa-arm', schema_version: 1, benchmark: a.benchmark, split: a.split, run_status: runStatus, invalid_reasons: invalidReasons, ...(refusal ? { refusal: refusal.op } : {}),
    started_at: started, finished_at: finishedAt, run_config_hash: hash,
    product: productIdentityFor(gut), overlay: overlaySummary(gut), arm_config: a.config, search_pins: a.pins,
    retrieval_path: frozen ? `frozen ranked lists replayed from ${repoRelative(a.retrievedFrom!)}` : a.qa.context === 'none' ? 'none (no-memory reader)' : a.qa.context === 'oracle' ? 'none (oracle: every gold session)'
      : 'hybridSearch (expansion off), chunks reduced to distinct sessions',
    ...(frozen ? { retrieved_from: frozen.files.map(f => ({ path: repoRelative(f.path), sha256: f.sha256 })) } : {}),
    search_knobs: a.search,
    reranker: brainless ? { applies: false } : { applies: true, enabled: rerankOn, decided_by: a.reranker.decided_by, model: rerankModel },
    reading: a.qa.mode === 'none' ? null : { breadth_sessions: a.qa.sessions, budget_tokens: a.qa.budgetTokens, max_output_tokens: a.qa.maxTokens ?? 1024 },
    embedding: { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims, cache_stats: cache ? { ...cache.stats } : null },
    dataset: corpus.source, selection: { categories: a.categories, limit: a.limit, seed: a.seed, shard: a.shard, conversations: myConvs.length, questions_expected: expected },
    counts: { rows: allRows.length, scored: scored.length, errors: allRows.filter(r => r.error).length, abstention: allRows.filter(r => r.abstention).length },
    summary: { recall_all_at_5: retrievalScored ? mean('recall_all_at_5') : null, recall_any_at_5: retrievalScored ? mean('recall_any_at_5') : null, recall_all_at_10: retrievalScored ? mean('recall_all_at_10') : null, ndcg_at_10: retrievalScored ? mean('ndcg_at_10') : null,
      latency_p50_ms: brainless || !scored.length ? null : percentile(scored.map(r => r.latency_ms ?? 0), 50), latency_p95_ms: brainless || !scored.length ? null : percentile(scored.map(r => r.latency_ms ?? 0), 95),
      ...(a.qa.mode !== 'none' ? (() => { const qa = allRows.filter(r => typeof r.qa_score === 'number'); return { qa_score: qa.length ? qa.reduce((x, r) => x + (r.qa_score ?? 0), 0) / qa.length : null, qa_rows: qa.length, qa_errors: allRows.filter(r => r.qa_error).length }; })() : {}) },
    facts: a.facts === 'none' ? null : { lane: a.facts, extractor: 'runExtractConversationFactsCore (product default model, force)', pages: 'conversation type, ISO session date', ...factStats,
      unresolved_share: factStats.facts ? factStats.unresolved / factStats.facts : null },
    qa: a.qa.mode === 'none' ? null : { ...a.qa, reader_prompt: a.qa.mode === 'think' ? 'gbrain think' : a.qa.context === 'facts' ? 'step-by-step reading prompt over the saved facts (text + stored date) of the top sessions'
      : a.qa.context === 'none' ? 'LongMemEval step-by-step reading prompt with an empty history (no memory)' : a.qa.context === 'oracle' ? 'LongMemEval step-by-step reading prompt over every gold session, in date order'
      : 'LongMemEval step-by-step reading prompt, sessions in date order', temperature_sent: { reader: sendsTemperature(a.qa.reader) ? 0 : 'none (provider default)', judge: sendsTemperature(a.qa.judge) ? 0 : 'none (provider default)' }, session_order: 'chronological (BEAM Month-DD-YYYY dates compared as dates since 2026-10-08; other formats as strings)', judge_prompts: a.benchmark.startsWith('beam') ? 'per-rubric-item yes/no' : 'LongMemEval official per-type prompts' },
    usage: a.qa.mode === 'none' ? null : (() => {
      const all = allRows.flatMap(r => r.qa_receipts ?? []);
      return { schema: USAGE_RECEIPT_SCHEMA, by_role: Object.fromEntries([...new Set(all.map(r => r.role))].sort().map(role => [role, sumUsage(all.filter(r => r.role === role))])) };
    })(),
    fidelity, cost, attempts, cost_usd_all_attempts: attempts.some(x => x.usd !== null) ? Math.round(attempts.reduce((x, y) => x + (y.usd ?? 0), 0) * 1e6) / 1e6 : null, rows_file: 'rows.ndjson',
  };
  writeFileSync(join(a.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (refusal) throw refusal;
  return { receipt, rows: allRows };
}

if (import.meta.main) {
  try {
    const a = parseRunArgs(process.argv.slice(2));
    const { receipt } = await runArm(a);
    const s = receipt.summary as Record<string, number | null>;
    process.stderr.write(`[memory-qa] ${a.benchmark} ${receipt.run_status}: ${(receipt.counts as Record<string, number>).scored} scored, recall_all@5 ${s.recall_all_at_5?.toFixed(4) ?? 'n/a'}; receipt ${join(a.output, 'receipt.json')}\n`);
    process.exit(receipt.run_status === 'invalid' ? 4 : 0);
  } catch (e) {
    if (e instanceof DecideError) { process.stderr.write(renderOperatorMessage(e.op) + '\n'); process.exit(e.op.fix.next === 'ask_user' ? 3 : 2); }
    throw e;
  }
}
