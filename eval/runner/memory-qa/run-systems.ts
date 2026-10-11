/**
 * memory-qa arm runner: one gbrain build, one benchmark split, one process.
 *
 *   bun eval/runner/memory-qa/run.ts (dispatches here for memory-system flags) --benchmark locomo|lme-s|beam-100k|beam-1m|fixture
 *     [--split dev | --split sealed --decision-id <id> --purpose <text> (custodian; GBRAIN_EVALS_CUSTODY_LOG)] [--gbrain <checkout>[@ref]] [--config key=value]... [--pin key=value]...
 *     [--embed hash|real] [--embedding-model provider:model --embedding-dims N]
 *     [--categories a,b] [--limit N] [--seed N] [--top-k 10] [--shard i/n]
 *     [--benchmark custody --corpus-file <custody path> (custodian sealed corpus; needs --split sealed)]
 *     [--facts conversation] [--qa reader|think --qa-context sessions|facts]
 *     [--paid --budget-run-id <id>] --output <dir>
 *     [--system gbrain|gbrain-shootout|fake|<shim URL>] [--context native|rehydrated] [--budget-tokens N]
 *     [--policy vendor-default|fixed-evidence] [--policy-setting key=value]... [--max-attempts 3]
 *     [--finish-timeout-s 600] [--sealed-profile <custody root>] [--provider-proxy <metering proxy URL>]
 *     [--arms <arms.json> [--replay]] [--proxy-slot <slot>] [--no-retry-upstream-5xx] [--ingest-timeout-s 3600]
 *     [--ingest-replicate N]
 *
 * Multi-arm cells (arms.ts): `--arms` ingests each namespace once, retrieves
 * once per question and policy, and derives every context mode and reader
 * from that state, one canonical row set per arm under arms/<id>/; frozen
 * reader prompts in contexts.ndjson are replayed byte for byte. `--replay`
 * adds readers to a finished cell without contacting the system.
 *
 * Provider attribution (with a lease proxy): each ingest and each retrieval
 * is bound to its own proxy key, so rows carry the provider dollars and what
 * the provider answered (`provider.upstream`). A retrieval that failed while
 * the provider returned a 5xx, dropped the connection or sent an unparseable
 * 200 is retried once (`upstream_retry`), unless --no-retry-upstream-5xx.
 *
 * Provider proxy (a shootout cell; default SHOOTOUT_PROXY): the process's
 * provider keys become dummies, gbrain's OpenAI, Anthropic and Voyage calls
 * and the reader's calls go to the cell's lease proxy, and the lease (not this
 * process's budget run) is the spending authority.
 *
 * Systems: `full-context`, `no-memory` and `plain-hybrid` are the D1
 * controls (eval/runner/systems/baselines.ts). `gbrain` (default) is the legacy in-process path behind the
 * `MemorySystem` interface (eval/runner/systems/gbrain.ts), pinned by the
 * keyless golden; every other system gets sanitized input (opaque ids, dated
 * turns, the question and its date), sessions in event-time order, a
 * quiescence wait, one retrieval per question under a named policy, strict
 * recall over first-appearance sources, and the shared renderer
 * (eval/runner/systems/render.ts) for the reading lane in native or
 * source-rehydrated context.
 *
 * Accounting (outcomes.ts): a frozen manifest of expected ids, append-only
 * attempts.ndjson, and rows.ndjson rewritten with exactly one canonical row
 * per expected id; reader and judge failures are outcomes that resume
 * retries, never rows silently dropped from a mean.
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
 * The arm imports gbrain only through `importGbrain`, so `--gbrain` really
 * selects the build under test; the decision kit runs baseline and candidate
 * as separate processes. Gold ids, categories and answers never reach gbrain.
 *
 * Fidelity: a page saved without vectors (embedding_deferred) under an
 * embedding arm, or a pinned reranker that never stamps a rerank score, marks
 * the run `invalid` — it measured a different pipeline than the one named.
 */
import '../budget-ledger.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { budgetOptionsFrom, startPaidRun, receiptCost, type BudgetRun, type PaidRequestGuard } from '../budget-ledger.ts';
import { requirePaidArm } from '../paid-arm.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { EmbeddingCache, makeCachingTransport } from '../longmemeval-cache.ts';
import { ndcgAtK, recallAllAtK, recallAnyAtK, uniqueInOrder, percentile } from '../metrics.ts';
import { loadCorpus, occurrenceId, sha256, type Corpus, type MemoryQuestion, type Session } from './corpus.ts';
import { ChatClient, DEFAULT_JUDGE, DEFAULT_READER, factsReaderPrompt, judgeResponse, packSessions, readerPrompt, repeatsTrap, approxTokens, unresolvedRelativeTime, type SavedFact } from './qa.ts';
import { devConversations, loadSplit } from '../decisions/splits.ts';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';
import { decideError, DecideError, renderOperatorMessage } from '../decisions/errors.ts';
import { appendAttempt, canonicalize, DEFAULT_MAX_ATTEMPTS, freezeManifest, HARNESS_FAILURES, PRODUCT_FAILURES, readAttempts, writeCanonical, type Canonical, type Outcome } from './outcomes.ts';
import { armHash, armsDir, ContextStore, contextKey, expandArms, loadArms, recipeHash, retrievalKey, retrievalsDir, type ArmsSpec } from './arms.ts';

/** An arms file's `judge: "none"`: the readers answer and nothing judges in this process. */
export const READER_ONLY = 'none';

/** A recipe context packed for one question: the prompt and its frozen meta. */
interface RecipeBuild { prompt: string; meta: Record<string, unknown> }
import { ProxyControl, upstreamTrouble, type Meter } from '../metering-proxy.ts';
import { checkSealedDestinations, sealedPaths, type SealedPaths } from './sealed-profile.ts';
import { FakeMemorySystem } from '../systems/fake.ts';
import { FullContextSystem, NoMemorySystem, PlainHybridSystem } from '../systems/baselines.ts';
import { cachedOpenAIEmbedder, PG_EMBED_DIMS } from '../cat40/pg-arm.ts';
import { GbrainLegacySystem, GbrainShootoutSystem, sourceOfSlug, type GbrainModules } from '../systems/gbrain.ts';
import { GbrainQuerySystem } from '../systems/gbrain-query/system.ts';
import { loadConnectorModules, readerBytes } from '../systems/gbrain-query/connector.ts';
import { HttpMemorySystem } from '../systems/http.ts';
import { blocksToItems, packContext, packRecipe, renderItem, datedItems, pseudoSessions, RENDERER_VERSION, sessionDay, strictSources, TOKENIZER, validateSources, type ContextMode } from '../systems/render.ts';
import { renderHistory } from './qa.ts';
import { Sanitizer, SanitizerLeakError } from '../systems/sanitize.ts';
import { policyKnobs, SystemError, type CapabilityRecord, type Item, type MemorySystem, type RetrievalPolicy, type SessionInput } from '../systems/types.ts';

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
  qa: { mode: 'none' | 'reader' | 'think'; reader: string; judge: string; runs: number; sessions: number; budgetTokens: number | null; thinkModel: string; context: 'sessions' | 'facts' };
  facts: 'none' | 'conversation';
  /** `gbrain` (legacy, default), `gbrain-shootout`, `fake`, or a protocol v1 shim URL. */
  system: string;
  context: ContextMode;
  policy: RetrievalPolicy['mode'];
  policySettings: Record<string, string>;
  maxAttempts: number;
  finishTimeoutS: number;
  /** Custody root for the sealed execution profile (required for sealed shootout systems). */
  sealedRoot: string | null;
  /** A shootout cell's metering proxy (--provider-proxy, default SHOOTOUT_PROXY): every provider call goes through it under its lease. */
  providerProxy: string | null;
  /** The proxy slot the system's provider calls arrive on (default: the capability record's system name for a shim, `harness` in process). */
  proxySlot: string | null;
  /** Retry a question once when its retrieval failed and the proxy saw the provider misbehave (5xx, lost connection, unparseable 200). Default on. */
  retryUpstream5xx: boolean;
  /** Per-request deadline for a shim's /ingest. */
  ingestTimeoutS: number;
  /** Multi-arm mode (--arms <file.json>): one ingest, one retrieval per policy, every context and reader derived from them. */
  arms: ArmsSpec | null;
  /** Reader replay (--replay, with --arms): run new arms from a finished cell's frozen retrievals and contexts without contacting the system. */
  replay: boolean;
  /** Independent re-ingestion of the same selection (run-to-run variance); enters the run hash when above 1. */
  ingestReplicate: number;
  /** `gbrain-query` deliver stage: a finished freeze cell's retrievals/rows.ndjson (the frozen hit lists); its hash enters the run hash. */
  frozenFrom: string | null;
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
  qa_score?: number;
  qa_scores?: number[];
  qa_runs?: number;
  qa_trap?: number;
  qa_input_tokens?: number;
  qa_output_tokens?: number;
  qa_context_tokens?: number;
  qa_sessions?: number;
  qa_answer?: string;
  qa_error?: string;
  qa_facts?: number;
  facts_count?: number;
  facts_unresolved_share?: number;
  facts_extract_error?: string;
  error?: string | null;
  error_origin?: 'sut' | 'harness' | 'dependency';
  error_kind?: string;
  outcome?: Outcome;
  system?: string;
  policy?: string;
  context?: ContextMode;
  recall_measurable?: boolean;
  items_returned?: number;
  fanout_mean?: number;
  fanout_max?: number;
  provenance?: { exact: number; partial: number; unavailable: number };
  items?: Item[];
  applied_settings?: Record<string, unknown>;
  truncated?: boolean;
  harness_ms?: number;
  ingest?: { sessions: number; failed_sessions: number; synthetic_times: number; finish_ready: boolean; completeness: string; readiness_probe: ProbeResult; degraded: boolean; errors: IngestError[]; provider?: MemoryQaRow['provider'] };
  qa_context?: { mode: ContextMode; tokenizer: string; renderer: string; budget_tokens: number | null; tokens: number; item_ids: string[]; source_ids: string[]; prompt_sha256: string; recipe?: string; recipe_hash?: string; tokens_before?: number; items_cut?: number; reader_bytes?: { chars: number; utf8_bytes: number }; gold?: { count: number; offered: number; packed: number } };
  qa_prompt?: string;
  provider?: { usd: number; requests: number; unpriced: number; upstream?: Meter['upstream'] };
  upstream_retry?: { first_error: string | null; first_provider: MemoryQaRow['provider'] | null };
  arm?: string;
  /** Typed system diagnostics (RetrieveResult.accounting), copied by value. */
  accounting?: Record<string, unknown>;
  /** A scored row copied from another arm whose prompt was byte-identical (twin reuse). */
  reused_from?: { arm: string; prompt_sha256: string };
  qa_facts_tokens?: number;
  retrieval_key?: string;
  question_id?: string;
  policy_mode?: string;
  query_time?: string | null;
  query_time_source?: 'question' | 'last-session' | 'none';
}

const DEFAULT_PINS: Record<string, string> = { 'search.mode': 'balanced', 'search.reranker.enabled': 'false', 'search.autocut': 'false' };
/** Planning estimate for one session through the conversation-facts extractor (product default model). */
const FACTS_USD_PER_SESSION = 0.03;

function kv(list: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`${flag} needs key=value (got ${item})`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

export function parseRunArgs(argv: string[]): RunArgs {
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
  const armsFile = one('--arms');
  const arms = armsFile ? loadArms(armsFile) : null;
  return {
    benchmark, split: split as 'dev' | 'sealed', custody, corpusFile: one('--corpus-file'), gbrain: gbrainSpecFrom(argv), config: kv(many('--config'), '--config'),
    pins: { ...DEFAULT_PINS, ...kv(many('--pin'), '--pin') }, embed,
    embeddingModel: one('--embedding-model') ?? 'openai:text-embedding-3-large',
    embeddingDims: Number(one('--embedding-dims') ?? 1536),
    categories: one('--categories') ? one('--categories')!.split(',').map(s => s.trim()).filter(Boolean) : null,
    limit: one('--limit') ? Number(one('--limit')) : null,
    seed: Number(one('--seed') ?? 42), topK: Number(one('--top-k') ?? 10),
    shard: { index: si, count: sn }, output: resolve(output), argv,
    qa: {
      mode: (one('--qa') ?? (arms?.readers.length ? 'reader' : 'none')) as 'none' | 'reader' | 'think',
      reader: one('--reader') ?? DEFAULT_READER[benchmark] ?? 'openai:gpt-4o-2024-08-06',
      judge: one('--judge') ?? DEFAULT_JUDGE[benchmark] ?? 'openai:gpt-4o-2024-08-06',
      runs: Number(one('--qa-runs') ?? 1), sessions: Number(one('--qa-sessions') ?? 5),
      budgetTokens: (one('--budget-tokens') ?? one('--qa-budget-tokens')) ? Number(one('--budget-tokens') ?? one('--qa-budget-tokens')) : null,
      thinkModel: one('--think-model') ?? 'anthropic:claude-sonnet-5-5',
      context: (one('--qa-context') ?? 'sessions') as 'sessions' | 'facts',
    },
    facts: (one('--facts') ?? 'none') as 'none' | 'conversation',
    system: one('--system') ?? 'gbrain',
    context: (one('--context') ?? 'rehydrated') as ContextMode,
    policy: (one('--policy') ?? 'vendor-default') as RetrievalPolicy['mode'],
    policySettings: kv(many('--policy-setting'), '--policy-setting'),
    maxAttempts: Number(one('--max-attempts') ?? DEFAULT_MAX_ATTEMPTS),
    finishTimeoutS: Number(one('--finish-timeout-s') ?? 600),
    sealedRoot: one('--sealed-profile') ? resolve(one('--sealed-profile')!) : null,
    providerProxy: (one('--provider-proxy') ?? process.env.SHOOTOUT_PROXY ?? '').replace(/\/$/, '') || null,
    proxySlot: one('--proxy-slot') ?? process.env.SHOOTOUT_PROXY_SLOT ?? null,
    retryUpstream5xx: !argv.includes('--no-retry-upstream-5xx'),
    ingestTimeoutS: Number(one('--ingest-timeout-s') ?? 3600),
    arms,
    replay: argv.includes('--replay'),
    ingestReplicate: Number(one('--ingest-replicate') ?? 1),
    frozenFrom: one('--frozen-from') ? resolve(one('--frozen-from')!) : null,
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

/** What a system says it is: its capability record's name and versions and, for a shim, the configuration /health reports active. */
export interface SystemIdentity { system: string; config: string | null; versions: Record<string, unknown> | null; health?: Record<string, unknown> }

/** The system identity and capability record a finished multi-arm cell recorded, for `--replay`. */
function replaySource(a: RunArgs): { identity: SystemIdentity | null; capabilities: CapabilityRecord } {
  if (!a.arms) throw new Error('--replay needs --arms (the readers to add)');
  const path = join(a.output, 'receipt.json');
  if (!existsSync(path)) throw new Error(`--replay needs a finished multi-arm cell in ${a.output} (no receipt.json)`);
  const r = JSON.parse(readFileSync(path, 'utf8')) as { kind: string; system?: { identity: SystemIdentity | null; capabilities: CapabilityRecord } };
  if (r.kind !== 'memory-qa-arms' || !r.system?.capabilities) throw new Error(`${path} is not a multi-arm cell receipt`);
  return { identity: r.system.identity, capabilities: r.system.capabilities };
}

/** Stands in for the system during `--replay`: any call means a retrieval was not frozen, which is refused. */
class ReplaySystem implements MemorySystem {
  readonly name: string;
  constructor(private cap: CapabilityRecord) { this.name = `replay:${cap.system}`; }
  private no(): never { throw new SystemError('invalid_request', 'replay mode never calls the system'); }
  async capabilities() { return this.cap; }
  async reset(): Promise<void> { this.no(); }
  async ingestSession(): Promise<never> { this.no(); }
  async finishIngest(): Promise<never> { this.no(); }
  async retrieve(): Promise<never> { this.no(); }
  async deleteSource(): Promise<never> { this.no(); }
}

export async function systemIdentity(a: RunArgs): Promise<SystemIdentity | null> {
  if (a.system === 'gbrain') return null;
  if (!/^https?:\/\//.test(a.system)) return { system: a.system, config: a.system === 'gbrain-shootout' ? JSON.stringify(a.config) : null, versions: null };
  const client = new HttpMemorySystem(a.system);
  const [health, cap] = await Promise.all([client.health(), client.capabilities()]);
  if (health.ok !== true) throw new Error(`${a.system} is not healthy: ${JSON.stringify(health).slice(0, 300)}`);
  const { service_ms: _ms, ...h } = health;
  return { system: cap.system, config: typeof h.config === 'string' ? h.config : null, versions: cap.versions ?? null, health: h };
}

export function runConfigHash(a: RunArgs, gut: GbrainUnderTest, corpus: Corpus, identity: SystemIdentity | null = null): string {
  const pre = { benchmark: a.benchmark, split: a.split, config: a.config, pins: a.pins, embed: a.embed, model: a.embeddingModel, dims: a.embeddingDims, qa: a.qa,
    categories: a.categories, limit: a.limit, seed: a.seed, topK: a.topK, gbrain: gut.overlay?.build.commit ?? gut.version, data: corpus.source.files, ...(a.facts !== 'none' ? { facts: a.facts } : {}),
    ...(a.system !== 'gbrain' ? { system: a.system, context: a.context, policy: a.policy, identity: identity && { system: identity.system, config: identity.config, versions: identity.versions } } : {}),
    ...(a.arms ? { qa: null, context: null, policy: null, arms_policies: Object.keys(a.arms.policies).sort() } : {}),
    ...(a.ingestReplicate !== 1 ? { ingest_replicate: a.ingestReplicate } : {}),
    ...(Object.keys(a.policySettings).length ? { policy_settings: a.policySettings } : {}),
    ...(a.frozenFrom ? { frozen_from_sha256: createHash('sha256').update(readFileSync(a.frozenFrom)).digest('hex') } : {}) };
  return createHash('sha256').update(JSON.stringify(pre)).digest('hex');
}

const errorText = (e: unknown) => (e as Error).message.slice(0, 300);

/** The facts lane's context size: the harness count of the fact lines its prompt carries (`factsReaderPrompt` with no question text). */
export const factsContextTokens = (facts: SavedFact[]) => approxTokens(facts.map(f => `- [${f.valid_from ? f.valid_from.slice(0, 10) : 'undated'}] ${f.fact}`).join('\n'));

export type ProbeResult = 'found' | 'missed' | 'not-measurable' | 'skipped';
/** One failed session: its opaque source id, the error kind and the message (never a request body). */
export interface IngestError { source_id: string; kind: string; message: string }

/**
 * Readiness probe (engineering review P2): after the system reports its
 * background work done, ask for a verbatim passage of the last session it
 * ingested and expect that session among the cited sources. A miss means the
 * quiescence signal lied, so the conversation is ingest-degraded. A vendor
 * error on the probe is retried once, then counts as a miss. Systems
 * without provenance, and the context controls, cannot be probed this way.
 */
export async function readinessProbe(system: MemorySystem, ns: string, last: SessionInput | undefined, policy: RetrievalPolicy, capabilities: CapabilityRecord): Promise<ProbeResult> {
  if (!last) return 'skipped';
  if (capabilities.retrieval_metrics === 'not-applicable' || capabilities.provenance?.status === 'unavailable') return 'not-measurable';
  const passage = [...last.turns].sort((x, y) => y.content.length - x.content.length)[0]?.content.slice(0, 300);
  if (!passage?.trim()) return 'skipped';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await system.retrieve(ns, { text: passage, query_time: null }, { ...policy, mode: 'fixed-evidence', settings: policyKnobs(capabilities.retrieval_policies?.['fixed-evidence']).settings });
      return res.items.some(i => i.source_ids.includes(last.source_id)) ? 'found' : 'missed';
    } catch { /* a vendor error is retried once, then counts as a miss */ }
  }
  return 'missed';
}

/** A system's retrieval failure as a row: its kind decides whether it is a product miss, a harness failure or a budget stop. */
function failureRow(base: MemoryQaRow, e: unknown): MemoryQaRow {
  if (e instanceof SanitizerLeakError) return { ...base, error: e.message, error_origin: 'harness', outcome: 'harness_invalid' };
  const kind = e instanceof SystemError ? e.kind : /budget|BudgetExceeded/i.test(String((e as Error).message)) ? 'budget' : 'product_error';
  if (kind === 'budget') return { ...base, error: errorText(e), error_origin: 'harness', error_kind: kind, outcome: 'budget_not_run' };
  if (kind === 'invalid_request') return { ...base, error: errorText(e), error_origin: 'harness', error_kind: kind, outcome: 'harness_invalid' };
  return { ...base, error: errorText(e), error_origin: 'sut', error_kind: kind, outcome: kind === 'unsupported' ? 'unsupported' : 'retrieval_error' };
}

export async function runArm(a: RunArgs): Promise<{ receipt: Record<string, unknown>; rows: MemoryQaRow[] }> {
  const started = new Date().toISOString();
  const legacy = a.system === 'gbrain';
  const inProcessGbrain = legacy || a.system === 'gbrain-shootout' || a.system === 'gbrain-query';
  if (!legacy && (a.facts !== 'none' || a.qa.mode === 'think' || a.qa.context === 'facts')) throw new Error('--facts, --qa think and --qa-context facts read gbrain directly; they need --system gbrain');
  if (!['native', 'rehydrated'].includes(a.context)) throw new Error('--context must be native or rehydrated');
  if (legacy && a.context !== 'rehydrated') throw new Error('--system gbrain reads the legacy rehydrated sessions; use --system gbrain-shootout for native context');
  if (legacy && a.arms) throw new Error('--arms needs a shootout system (the legacy gbrain path has one fixed retrieval)');
  if (a.arms && a.qa.mode === 'think') throw new Error('--arms reads with fixed readers; --qa think is a gbrain-only lane');
  let sealed: SealedPaths | null = null;
  if (a.sealedRoot || (a.split === 'sealed' && !legacy)) {
    if (!a.sealedRoot) throw new Error('a sealed run of a shootout system needs --sealed-profile <custody root>');
    sealed = sealedPaths(a.sealedRoot, a.output);
    checkSealedDestinations(sealed);
  }
  mkdirSync(a.output, { recursive: true });
  const gut = resolveGbrainUnderTest(a.gbrain);
  if (a.benchmark === 'custody' && a.split !== 'sealed') throw new Error('benchmark custody is a custodian sealed corpus: run it with --split sealed');
  if (a.split === 'sealed') {
    if (!a.custody) throw new Error('sealed memory-qa runs need custody (decision id, purpose, access log)');
    appendAccessLog(a.custody.log, { action: 'open', purpose: `memory-qa ${a.benchmark} sealed: ${a.custody.purpose}`, decision_id: a.custody.decisionId, labels_sha256: a.benchmark === 'custody' && a.corpusFile ? sha256(readFileSync(a.corpusFile)) : 'public-split-file', run_sha256: null });
  }
  const corpus = loadCorpus(a.benchmark, a.corpusFile);
  const allowed = a.benchmark === 'custody' ? null : a.split === 'sealed' ? new Set(loadSplit(a.benchmark).sealed) : devConversations(a.benchmark);
  let questions = corpus.questions.filter(q => !allowed || allowed.has(q.conversation));
  if (a.categories) questions = questions.filter(q => a.categories!.includes(q.category));
  questions = selectQuestions(questions, a.limit, a.seed);
  const convIds = uniqueInOrder(questions.map(q => q.conversation)).sort();
  const myConvs = convIds.filter((_, i) => i % a.shard.count === a.shard.index);
  const byConv = new Map(corpus.conversations.map(c => [c.id, c]));

  const prior = a.replay ? replaySource(a) : null;
  const sysIdentity = prior ? prior.identity : await systemIdentity(a);
  const hash = runConfigHash(a, gut, corpus, sysIdentity);
  const headerPath = join(a.output, 'run-config.json');
  if (existsSync(headerPath)) {
    const prior = JSON.parse(readFileSync(headerPath, 'utf8')) as { run_config_hash: string };
    if (prior.run_config_hash !== hash) throw new Error(`${a.output} holds rows from a different run configuration; use a fresh --output`);
  }
  writeFileSync(headerPath, JSON.stringify({ run_config_hash: hash, benchmark: a.benchmark, shard: a.shard }, null, 2));
  const manifest = freezeManifest(a.output, hash, questions.filter(q => myConvs.includes(q.conversation)).map(q => q.id));
  const pending = canonicalize(manifest, readAttempts(a.output), a.maxAttempts).pending;

  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  let cache: EmbeddingCache | null = null;
  const provider = a.embeddingModel.split(':')[0];
  // The shootout recipe runs gbrain's own search defaults, which call paid providers (the reranker) even with hash vectors.
  if (a.providerProxy) {
    if (!/^https?:\/\/[^/]+$/.test(a.providerProxy)) throw new Error('--provider-proxy must look like http://host:port');
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) process.env[k] = 'dummy-key-the-proxy-replaces';
    process.env.OPENAI_BASE_URL = `${a.providerProxy}/harness/openai/v1`;
    process.env.ANTHROPIC_BASE_URL = `${a.providerProxy}/harness/anthropic`;
  }
  const needsPaid = !a.providerProxy && (((inProcessGbrain || a.system === 'plain-hybrid') && a.embed === 'real') || a.system === 'gbrain-shootout' || a.qa.mode !== 'none' || a.facts !== 'none');
  if (!['none', 'reader', 'think'].includes(a.qa.mode)) throw new Error('--qa must be none, reader or think');
  if (!['none', 'conversation'].includes(a.facts)) throw new Error('--facts must be none or conversation');
  if (!['sessions', 'facts'].includes(a.qa.context)) throw new Error('--qa-context must be sessions or facts');
  if (a.qa.context === 'facts' && (a.facts === 'none' || a.qa.mode !== 'reader')) throw new Error('--qa-context facts needs --facts conversation and --qa reader');
  if (needsPaid) {
    const perQuestion: Record<string, number> = { 'lme-s': 0.012, custody: 0.002, locomo: 0.002, 'beam-100k': 0.01, 'beam-500k': 0.02, 'beam-1m': 0.03, fixture: 0 };
    const perQa: Record<string, number> = { none: 0, reader: (a.benchmark === 'lme-s' ? 0.05 : 0.01) * Math.max(1, (a.arms?.readers.length ?? 1) * (a.arms?.contexts.length ?? 1) * Object.keys(a.arms?.policies ?? { x: 1 }).length), think: 0.08 };
    const mine = manifest.expected.length;
    const factSessions = a.facts === 'none' ? 0 : myConvs.reduce((n, id) => n + (byConv.get(id)?.sessions.length ?? 0), 0);
    const estimate = Math.max(0.05, Math.round((((((inProcessGbrain || a.system === 'plain-hybrid') && a.embed === 'real') ? perQuestion[a.benchmark] ?? 0.02 : 0) + perQa[a.qa.mode] * a.qa.runs) * mine + FACTS_USD_PER_SESSION * factSessions) * 100) / 100);
    try { requirePaidArm(a.argv, { arm: `memory-qa ${a.benchmark}`, estimateUsd: estimate, ledgerPath: budgetOptionsFrom(a.argv).ledgerPath }); }
    catch (e) {
      throw decideError({ code: 'PAID_FLAGS_MISSING', message: (e as Error).message, why: 'real embeddings and the reading lane call paid providers, and every paid request is reserved in the budget ledger first',
        fix: { next: 'run', argv: ['bun', 'eval/runner/budget-ledger.ts', 'status'], verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] } });
    }
    paid = startPaidRun(`memory-qa:${a.benchmark}`, { ...budgetOptionsFrom(a.argv), estimateUsd: estimate });
  }

  // gbrain systems run in process: hash vectors (keyless) or the real provider through the budget ledger and the content-addressed cache.
  let mods: GbrainModules | null = null;
  let connectorMods: Awaited<ReturnType<typeof loadConnectorModules>> | null = null;
  if (inProcessGbrain) {
    const proxyUrls = a.providerProxy ? { base_urls: { voyage: `${a.providerProxy}/harness/voyage/v1` } } : {};
    const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
    if (a.embed === 'hash') {
      const keyEnv = PROVIDER_KEY[provider] ?? 'OPENAI_API_KEY';
      if (!process.env[keyEnv]) process.env[keyEnv] = 'hash-embed-transport-no-provider-call';
      gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env, ...proxyUrls });
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbed(v, a.embeddingDims)), values: params.values, warnings: [], usage: { tokens: 0 } }));
    } else {
      gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env, ...proxyUrls });
      const aiPath = Bun.resolveSync('ai', gut.root);
      const { embedMany } = await import(aiPath) as { embedMany: (p: unknown) => Promise<unknown> };
      const cacheDir = sealed?.embedCache ?? process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
      mkdirSync(cacheDir, { recursive: true });
      const key = `${a.embeddingModel}@${a.embeddingDims}`;
      cache = new EmbeddingCache(join(cacheDir, `embed-cache-${key.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`), key);
      gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: { values: string[] } & Record<string, unknown>) => embedMany(p) as never, cache));
    }
    mods = {
      PGLiteEngine: (await importGbrain<{ PGLiteEngine: GbrainModules['PGLiteEngine'] }>(gut, 'src/core/pglite-engine.ts')).PGLiteEngine,
      importFromContent: (await importGbrain<{ importFromContent: GbrainModules['importFromContent'] }>(gut, 'src/core/import-file.ts')).importFromContent,
      hybridSearch: (await importGbrain<{ hybridSearch: GbrainModules['hybridSearch'] }>(gut, 'src/core/search/hybrid.ts')).hybridSearch,
    };
    if (a.system === 'gbrain-query') connectorMods = await loadConnectorModules(<T,>(rel: string) => importGbrain<T>(gut, rel));
  }

  const extractFacts = a.facts === 'conversation'
    ? (await importGbrain<{ runExtractConversationFactsCore: (e: unknown, o: Record<string, unknown>) => Promise<{ pages_processed: number; pages_failed: number; facts_extracted: number }> }>(gut, 'src/commands/extract-conversation-facts.ts')).runExtractConversationFactsCore
    : null;
  const factStats = { conversations: 0, pages_processed: 0, pages_failed: 0, facts: 0, unresolved: 0, errors: 0 };
  const think = a.qa.mode === 'think' ? (await importGbrain<{ runThink: (e: unknown, o: Record<string, unknown>) => Promise<{ answer: string; synthesis_status?: string }> }>(gut, 'src/core/think/index.ts')).runThink : null;
  const chat = a.qa.mode === 'none' ? null : new ChatClient(sealed?.qaCache ?? process.env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));
  const lastDate = (sessions: Session[]) => sessions.map(x => x.date ?? '').sort().pop() || undefined;

  const rerankPinned = (a.config['search.reranker.enabled'] ?? a.pins['search.reranker.enabled']) === 'true';
  const identity = productIdentityFor(gut) as unknown as Record<string, unknown>;
  const sanitizer = new Sanitizer(corpus, hash);
  const system: MemorySystem = prior ? new ReplaySystem(prior.capabilities)
    : legacy ? new GbrainLegacySystem(mods!, { ...a.pins, ...a.config }, identity, { topK: a.topK, as: extractFacts ? 'conversation' : 'note', rerankPinned })
    : a.system === 'gbrain-shootout' ? new GbrainShootoutSystem(mods!, a.config, identity)
    : a.system === 'gbrain-query' ? new GbrainQuerySystem(mods!, connectorMods!, a.config, identity, { frozenFrom: a.frozenFrom, rerankExpected: (a.config['search.reranker.enabled'] ?? 'true') !== 'false' })
    : a.system === 'fake' ? new FakeMemorySystem()
    : a.system === 'full-context' ? new FullContextSystem()
    : a.system === 'no-memory' ? new NoMemorySystem()
    : a.system === 'plain-hybrid' ? new PlainHybridSystem(a.embed === 'hash'
      ? async texts => texts.map(t => hashEmbed(t, PG_EMBED_DIMS))
      : cachedOpenAIEmbedder(join(sealed?.embedCache ?? process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache'), 'plain-hybrid-te3l-1536.json')),
      a.embed === 'hash' ? `hash@${PG_EMBED_DIMS} (keyless control)` : undefined)
    : /^https?:\/\//.test(a.system) ? new HttpMemorySystem(a.system, { markers: sanitizer.markers, ingestTimeoutMs: a.ingestTimeoutS * 1000 })
    : (() => { throw new Error(`--system must be gbrain, gbrain-shootout, fake, full-context, no-memory, plain-hybrid or a shim URL (got ${a.system})`); })();
  const capabilities = await system.capabilities();
  const policyFor = (mode: RetrievalPolicy['mode']) => {
    const k = policyKnobs(capabilities.retrieval_policies?.[mode]);
    return { policy: { name: `${capabilities.system}:${mode}`, mode, settings: { ...k.settings, ...a.policySettings } } as RetrievalPolicy, source: k.source };
  };
  const { policy, source: knobsSource } = policyFor(a.policy);
  const brain = () => (system as GbrainLegacySystem).brain;
  const fidelity = (inProcessGbrain ? (system as GbrainLegacySystem).fidelity : undefined) ?? { embedding_deferred_pages: 0, rerank_missing_queries: 0, reranked_queries: 0 };
  const ingestStats = { conversations: 0, sessions: 0, failed_sessions: 0, synthetic_times: 0, degraded_conversations: 0, finish_timeouts: 0, readiness_probe_misses: 0, error_kinds: {} as Record<string, number>, usd: 0, upstream_trouble: 0 };
  const allIngestErrors: Array<IngestError & { conversation_ns: string }> = [];
  const invalidReasons: string[] = [];
  const ctl = a.providerProxy ? new ProxyControl(a.providerProxy) : null;
  const slot = a.proxySlot ?? (/^https?:\/\//.test(a.system) ? capabilities.system : 'harness');
  const metered = async <T>(key: string, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; meter: Meter | null }> => {
    if (ctl) return ctl.around(slot, key, fn);
    try { return { value: await fn(), meter: null }; } catch (error) { return { error, meter: null }; }
  };
  const providerOf = (m: Meter | null) => m ? { usd: m.usd, requests: m.requests, unpriced: m.unpriced, ...(m.upstream ? { upstream: m.upstream } : {}) } : undefined;

  // Multi-arm state: one canonical retrieval per (question, policy), one row set per arm, frozen reader contexts.
  const arms = a.arms ? expandArms(a.arms) : [];
  const policies = a.arms ? (Object.keys(a.arms.policies).sort() as Array<(typeof arms)[number]['policy']>) : [];
  const judgeModel = a.arms?.judge ?? a.qa.judge;
  const rDir = retrievalsDir(a.output);
  if (arms.length) mkdirSync(rDir, { recursive: true });
  const rManifest = arms.length ? freezeManifest(rDir, hash, manifest.expected.flatMap(id => policies.map(p => retrievalKey(id, p)))) : null;
  const rPending = rManifest ? canonicalize(rManifest, readAttempts(rDir), a.maxAttempts).pending : new Set<string>();
  if (prior && rPending.size) throw new Error(`--replay reads frozen retrievals, but ${rPending.size} retrievals in ${a.output} are not done; finish the cell first`);
  const rByKey = new Map<string, MemoryQaRow>(rManifest ? canonicalize(rManifest, readAttempts(rDir), a.maxAttempts).rows.map(r => [r.id, r as unknown as MemoryQaRow]) : []);
  const armState = arms.map(arm => {
    const dir = armsDir(a.output, arm);
    mkdirSync(dir, { recursive: true });
    const slice = arm.reader?.slice ? new Set(selectQuestions(questions, arm.reader.slice.limit, arm.reader.slice.seed).map(q => q.id)) : null;
    const m = freezeManifest(dir, armHash(hash, arm, judgeModel, a.qa.runs), manifest.expected.filter(id => !slice || slice.has(id)));
    const canon = canonicalize(m, readAttempts(dir), a.maxAttempts);
    return { arm, dir, manifest: m, pending: canon.pending, written: 0, latest: new Map(canon.rows.map(r => [r.id, r as unknown as MemoryQaRow])) };
  });
  const contexts = new ContextStore(join(a.output, 'contexts.ndjson'));

  let written = 0;
  const record = (row: MemoryQaRow) => { appendAttempt(a.output, row as unknown as Parameters<typeof appendAttempt>[1]); written++; };
  try {
    for (const convId of myConvs) {
      const convQs = questions.filter(q => q.conversation === convId);
      const qs = arms.length
        ? convQs.filter(q => policies.some(p => rPending.has(retrievalKey(q.id, p))) || armState.some(s => s.pending.has(q.id)))
        : convQs.filter(q => pending.has(q.id));
      if (!qs.length) continue;
      if (paid?.guard.exhausted) break;
      const conv = byConv.get(convId)!;
      const ns = sanitizer.ns(convId);
      const plan = legacy ? [] : sanitizer.ingestPlan(conv);
      const lastEventTime = plan.map(p => p.event_time).filter((t): t is string => !!t).sort().pop() ?? null;
      const needIngest = !arms.length || qs.some(q => policies.some(p => rPending.has(retrievalKey(q.id, p))));
      let importError: string | null = null;
      let degraded: MemoryQaRow['ingest'] | undefined;
      const ingested = new Set<string>(plan.map(p => p.input.source_id));
      const ingestErrors: IngestError[] = [];
      if (needIngest) {
        try { await system.reset(ns); } catch (e) { importError = `reset failed: ${errorText(e)}`; }
        if (legacy && !importError) {
          for (const s of conv.sessions) {
            try { await system.ingestSession(ns, sanitizer.session(convId, s), s.date ?? null); }
            catch (e) { importError = (e as Error).message; break; }
          }
        } else if (!importError) {
          let failed = 0, synthetic = 0;
          const ingestAll = async () => {
            for (const step of plan) {
              if (step.synthetic_time) synthetic++;
              try {
                const res = await system.ingestSession(ns, step.input, step.event_time);
                if (res.errors.length || res.completeness === 'degraded') {
                  failed++;
                  ingestErrors.push({ source_id: step.input.source_id, kind: res.errors.length ? 'reported' : 'degraded', message: (res.errors.map(String).join('; ') || `completeness ${res.completeness}`).slice(0, 300) });
                }
              } catch (e) {
                if (e instanceof SanitizerLeakError) { importError = e.message; invalidReasons.push(`sanitizer tripwire during ingest: ${e.message}`); break; }
                if (e instanceof SystemError && e.kind === 'budget') { importError = `budget: ${errorText(e)}`; ingestErrors.push({ source_id: step.input.source_id, kind: 'budget', message: errorText(e) }); break; }
                failed++;
                ingestErrors.push({ source_id: step.input.source_id, kind: e instanceof SystemError ? e.kind : 'product_error', message: errorText(e) });
              }
            }
            let finish: { ready: boolean; completeness: string } = { ready: false, completeness: 'unknown' };
            if (!importError) { try { finish = await system.finishIngest(ns, a.finishTimeoutS); } catch (e) { finish = { ready: false, completeness: `error: ${errorText(e)}` }; } }
            return finish;
          };
          const ran = await metered(`ingest:${ns}`, ingestAll);
          const finish = ran.value ?? { ready: false, completeness: `error: ${errorText(ran.error)}` };
          ingestStats.conversations++; ingestStats.sessions += plan.length; ingestStats.failed_sessions += failed; ingestStats.synthetic_times += synthetic;
          if (ran.meter) { ingestStats.usd += ran.meter.usd; if (upstreamTrouble(ran.meter)) ingestStats.upstream_trouble++; }
          if (!finish.ready) ingestStats.finish_timeouts++;
          const probe = !importError && finish.ready ? await readinessProbe(system, ns, plan.at(-1)?.input, policy, capabilities) : 'skipped';
          if (probe === 'missed') ingestStats.readiness_probe_misses++;
          const isDegraded = !importError && (failed / Math.max(1, plan.length) > 0.01 || !finish.ready || probe === 'missed');
          if (isDegraded) ingestStats.degraded_conversations++;
          degraded = { sessions: plan.length, failed_sessions: failed, synthetic_times: synthetic, finish_ready: finish.ready, completeness: finish.completeness, readiness_probe: probe, degraded: isDegraded, errors: ingestErrors,
            ...(ran.meter ? { provider: providerOf(ran.meter) } : {}) };
          for (const e of ingestErrors) { ingestStats.error_kinds[e.kind] = (ingestStats.error_kinds[e.kind] ?? 0) + 1; if (allIngestErrors.length < 500) allIngestErrors.push({ conversation_ns: ns, ...e }); }
        }
      }
      const factsBySession = new Map<string, SavedFact[]>();
      let convFacts: Pick<MemoryQaRow, 'facts_count' | 'facts_unresolved_share' | 'facts_extract_error'> = {};
      const bySlug = new Map(conv.sessions.map(s => [`chat/${occurrenceId(conv.id, s.id)}`, s.id]));
      if (extractFacts && !importError) {
        let extractError: string | null = null;
        try {
          const res = await extractFacts(brain(), { force: true, sourceId: 'default' });
          factStats.pages_processed += res.pages_processed; factStats.pages_failed += res.pages_failed;
          if (res.pages_failed > 0) extractError = `${res.pages_failed} of ${res.pages_processed + res.pages_failed} pages failed extraction`;
        } catch (e) {
          factStats.errors++;
          extractError = (e as Error).message.slice(0, 300);
        }
        // Whatever the extractor saved before a failure is what the brain holds, so it is read and scored either way.
        const facts = await brain().executeRaw(`SELECT fact, valid_from, source_markdown_slug, to_jsonb(facts)->>'attributed_to' AS attributed_to FROM facts WHERE expired_at IS NULL AND source NOT LIKE 'cli:extract-conversation-facts:terminal%' AND source NOT LIKE 'cli:extract-conversation-facts:non-extractable%' ORDER BY valid_from, id`) as Array<{ fact: string; valid_from: Date | string | null; source_markdown_slug: string | null; attributed_to: string | null }>;
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
      const sessById = new Map(conv.sessions.map(x => [x.id, x]));
      const sessionOf = (src: string) => { const id = sanitizer.sessionOf(ns, src); return id ? sessById.get(id) : undefined; };
      const importFailure = (base: MemoryQaRow): MemoryQaRow => importError!.startsWith('budget:') ? { ...base, error: importError!, error_origin: 'harness', outcome: 'budget_not_run' }
        : invalidReasons.length ? { ...base, error: importError!, error_origin: 'harness', outcome: 'harness_invalid' }
        : { ...base, error: `ingest failed: ${importError}`, error_origin: 'sut', outcome: 'retrieval_error' };

      const daySourceOf = (src: string) => sessionDay(sessionOf(src)?.date);
      const slugSource = (slug: string) => sourceOfSlug(slug);
      /**
       * gbrain-query freeze stage with a budget grid: render each grid budget's
       * raw deliveries with the real session dates and keep only the counts the
       * sizing script needs (the serialized harness tokens per rendering and
       * gbrain's budget_used); the delivered text never reaches the row.
       */
      const withSizing = (acc: Record<string, unknown>): Record<string, unknown> => {
        const nativeTokens = (blocks: Parameters<typeof blocksToItems>[0]) => datedItems(blocksToItems(blocks, slugSource), daySourceOf).reduce((n, i) => n + TOKENIZER.count(renderItem(i) + '\n'), 0);
        const pseudoTokens = (blocks: Parameters<typeof blocksToItems>[0]) => TOKENIZER.count(renderHistory(pseudoSessions(datedItems(blocksToItems(blocks, slugSource), daySourceOf), sessionOf).map(x => x.session)));
        const e2 = system instanceof GbrainQuerySystem ? system.lastSizingE2 : null;
        if (e2) return { ...acc, sizing_e2: e2.map(g => ({ grid: g.grid, budget: g.budget, variants: Object.fromEntries(Object.entries(g.variants).map(([name, d]) => [name,
          { budget_used: d.record.budget_used, blocks: d.record.blocks, over_budget: d.record.over_budget, auto_packing: d.record.auto_packing, pseudo: pseudoTokens(d.blocks), ...(g.grid === 'b8' ? { native: nativeTokens(d.blocks) } : {}) }])) })) };
        const grid = system instanceof GbrainQuerySystem ? system.lastSizing : null;
        if (!grid) return acc;
        return { ...acc, sizing: grid.map(g => ({ budget: g.budget,
          full: { budget_used: g.full.record.budget_used, blocks: g.full.record.blocks, over_budget: g.full.record.over_budget, native: nativeTokens(g.full.blocks), pseudo: pseudoTokens(g.full.blocks) },
          prefix: { budget_used: g.prefix.record.budget_used, blocks: g.prefix.record.blocks, over_budget: g.prefix.record.over_budget, pseudo: pseudoTokens(g.prefix.blocks) } })) };
      };

      /** One retrieval under one policy, metered by the proxy; a product failure during which the provider misbehaved is retried once. */
      const retrieveRow = async (q: MemoryQuestion, base: MemoryQaRow, pol: RetrievalPolicy): Promise<MemoryQaRow> => {
        const once = async (): Promise<{ row: MemoryQaRow; meter: Meter | null }> => {
          const t0 = performance.now();
          const pq = sanitizer.question(q, lastEventTime);
          const r = await metered(`q:${q.id}:${pol.mode}`, () => system.retrieve(ns, pq, pol));
          const harnessMs = performance.now() - t0;
          const provider = providerOf(r.meter);
          if (r.error !== undefined) {
            if (r.error instanceof SanitizerLeakError) invalidReasons.push(`sanitizer tripwire during retrieval: ${r.error.message}`);
            return { row: { ...failureRow(base, r.error), ...(provider ? { provider } : {}) }, meter: r.meter };
          }
          const res = r.value!;
          try { validateSources(res.items, ingested); } catch (e) { return { row: { ...failureRow(base, e), ...(provider ? { provider } : {}) }, meter: r.meter }; }
          const toSessions = (srcs: string[]) => srcs.map(s => sanitizer.sessionOf(ns, s)!);
          const at5 = strictSources(res.items, 5), at10 = strictSources(res.items, 10), atK = strictSources(res.items, a.topK);
          const rel = new Set(q.gold);
          return { meter: r.meter, row: { ...base, system: system.name, policy: pol.name, context: a.context, query_time: pq.query_time, query_time_source: q.question_date ? 'question' : pq.query_time ? 'last-session' : 'none',
            ...(at5.measurable && capabilities.retrieval_metrics !== 'not-applicable' ? { recall_all_at_5: recallAllAtK(toSessions(at5.sources), rel, 5), recall_any_at_5: recallAnyAtK(toSessions(at5.sources), rel, 5),
              recall_all_at_10: recallAllAtK(toSessions(at10.sources), rel, 10), ndcg_at_10: ndcgAtK(toSessions(at10.sources), new Map(q.gold.map(g => [g, 1])), 10) } : { recall_measurable: false }),
            retrieved: toSessions(atK.sources), items_returned: res.items.length, fanout_mean: atK.fanout_mean, fanout_max: atK.fanout_max,
            provenance: { exact: res.items.filter(i => i.provenance_status === 'exact').length, partial: res.items.filter(i => i.provenance_status === 'partial').length, unavailable: res.items.filter(i => i.provenance_status === 'unavailable').length },
            items: res.items, applied_settings: res.applied_settings, truncated: res.truncated, ...(res.accounting ? { accounting: withSizing(res.accounting) } : {}),
            latency_ms: Math.round((res.service_ms ?? harnessMs) * 10) / 10, harness_ms: Math.round(harnessMs * 10) / 10,
            ...(provider ? { provider } : {}), ...(degraded ? { ingest: degraded } : {}), error: null, outcome: degraded?.degraded ? 'ingest_degraded' : 'scored' } };
        };
        const first = await once();
        if (!a.retryUpstream5xx || !first.row.outcome || !PRODUCT_FAILURES.has(first.row.outcome) || !upstreamTrouble(first.meter)) return first.row;
        const second = await once();
        return { ...second.row, upstream_retry: { first_error: first.row.error ?? null, first_provider: first.row.provider ?? null } };
      };

      /** The reading lane on one context: the frozen prompt when one exists, else packed now (and frozen when `freeze` is given). */
      const readRow = async (question: MemoryQuestion, row: MemoryQaRow, items: Item[], context: string, budget: number | null, reader: string, judge: string,
        freeze: { key: string } | null, keepPrompt: boolean, recipeCtx: RecipeBuild | null = null): Promise<MemoryQaRow> => {
        let prompt: string, meta: Record<string, unknown>;
        const frozen = freeze ? contexts.get(freeze.key) : undefined;
        if (frozen) { prompt = frozen.prompt; meta = { ...frozen.meta, replayed: true }; }
        else if (recipeCtx) {
          ({ prompt, meta } = recipeCtx);
          if (freeze) contexts.put({ key: freeze.key, prompt_sha256: meta.prompt_sha256 as string, prompt, meta });
        }
        else {
          const pack = packContext(context as ContextMode, question, items, { budgetTokens: budget, sessionOf, fallbackDate: lastDate(conv.sessions), present: capabilities.presentation === 'event-time' ? 'event-time' : 'rank' });
          prompt = pack.prompt;
          meta = { mode: pack.mode, tokenizer: pack.tokenizer, renderer: pack.renderer, budget_tokens: pack.budget_tokens, tokens: pack.tokens, item_ids: pack.item_ids, source_ids: pack.source_ids, prompt_sha256: createHash('sha256').update(pack.prompt).digest('hex') };
          if (freeze) contexts.put({ key: freeze.key, prompt_sha256: meta.prompt_sha256 as string, prompt, meta });
        }
        let out: MemoryQaRow = { ...row, qa_context: meta as MemoryQaRow['qa_context'], ...(keepPrompt ? { qa_prompt: prompt } : {}) };
        const scores: number[] = [];
        let tin = 0; let tout = 0; let answer = ''; let trap = 0;
        try {
          for (let r = 0; r < a.qa.runs; r++) {
            let res: Awaited<ReturnType<ChatClient['chat']>>;
            try { res = await chat!.chat(reader, prompt, { maxTokens: 1024, replicate: r }); }
            catch (e) { throw new Error(`reader: ${(e as Error).message}`); }
            answer = res.text; tin += res.input_tokens; tout += res.output_tokens;
            if (judge === READER_ONLY) continue;
            scores.push(await judgeResponse(chat!, a.benchmark, judge, question, answer, r).catch(e => { throw new Error(`judge: ${(e as Error).message}`); }));
            if (question.abstention && repeatsTrap(answer, question.trap)) trap++;
          }
          // Reader-only arms (judge "none") keep the whole answer for a scorer outside this process, such as the sealed runner.
          out = judge === READER_ONLY
            ? { ...out, qa_runs: a.qa.runs, qa_input_tokens: Math.round(tin / a.qa.runs), qa_output_tokens: Math.round(tout / a.qa.runs), qa_context_tokens: Number(meta.tokens ?? 0), qa_answer: answer }
            : { ...out, qa_score: scores.reduce((x, y) => x + y, 0) / scores.length, qa_scores: scores, qa_runs: scores.length, ...(question.trap ? { qa_trap: trap / scores.length } : {}),
              qa_input_tokens: Math.round(tin / scores.length), qa_output_tokens: Math.round(tout / scores.length), qa_context_tokens: Number(meta.tokens ?? 0), qa_answer: answer.slice(0, 2000) };
        } catch (e) {
          const msg = (e as Error).message.slice(0, 300);
          out = { ...out, qa_error: msg, outcome: msg.startsWith('judge:') ? 'judge_error' : 'reader_error' };
        }
        return out;
      };

      /** A recipe context, packed now: items from the retrieval or one of its recorded deliveries, optionally the exact selection of another context. */
      const buildRecipe = (q: MemoryQuestion, r: MemoryQaRow, name: string, policy: RetrievalPolicy['mode'], budget: number | null): RecipeBuild => {
        const spec = a.arms!.recipes![name];
        let items: Item[];
        if (spec.items === 'retrieved') items = r.items ?? [];
        else {
          const d = (r.accounting?.deliveries as Record<string, { blocks: Parameters<typeof blocksToItems>[0] }> | undefined)?.[spec.items];
          if (!d) throw new Error(`recipe ${name}: the retrieval row has no delivery ${spec.items}`);
          items = blocksToItems(d.blocks, sourceOfSlug);
        }
        if (spec.select_from) {
          const depName = spec.select_from;
          const depKey = contextKey(q.id, policy, depName, budget, a.arms!.recipes?.[depName] ? recipeHash(depName, a.arms!) : null);
          const ids = (contexts.get(depKey)?.meta.item_ids as string[] | undefined)
            ?? (a.arms!.recipes?.[depName] ? buildRecipe(q, r, depName, policy, budget).meta.item_ids as string[]
              : packContext(depName as ContextMode, q, r.items ?? [], { budgetTokens: budget, sessionOf, fallbackDate: lastDate(conv.sessions) }).item_ids);
          const chosen = new Set(ids);
          items = items.filter(i => chosen.has(i.id));
          if (items.length !== chosen.size) throw new Error(`recipe ${name}: ${chosen.size - items.length} items selected by ${depName} are not in its item source`);
        }
        const pack = packRecipe(spec.render, q, items, { budgetTokens: 'budget_tokens' in spec ? spec.budget_tokens ?? null : budget, sessionOf, fallbackDate: lastDate(conv.sessions) });
        const prompt_sha256 = createHash('sha256').update(pack.prompt).digest('hex');
        const gold = new Set(q.gold);
        const goldIn = (srcs: Iterable<string>) => new Set([...srcs].map(src => sessionOf(src)?.id).filter((id): id is string => !!id && gold.has(id))).size;
        const { chars, utf8_bytes } = readerBytes(pack.prompt);
        return { prompt: pack.prompt, meta: { mode: pack.mode, render: pack.render, recipe: name, recipe_hash: recipeHash(name, a.arms!), tokenizer: pack.tokenizer, renderer: pack.renderer, budget_tokens: pack.budget_tokens,
          tokens: pack.tokens, tokens_before: pack.tokens_before, items_cut: pack.items_cut, dated_items: pack.dated_items, item_ids: pack.item_ids, source_ids: pack.source_ids, prompt_sha256,
          reader_bytes: { chars, utf8_bytes }, gold: { count: gold.size, offered: goldIn(items.flatMap(i => i.source_ids)), packed: goldIn(pack.source_ids) },
          ...(spec.items !== 'retrieved' ? { delivery: spec.items } : {}), ...(spec.select_from ? { select_from: spec.select_from } : {}) } };
      };
      /** Twin reuse: the same final prompt bytes as `reuse_from`'s context, the same reader and judge, and a scored row there: copy it, marked. */
      const reuseRow = (q: MemoryQuestion, s: (typeof armState)[number], key: string, built: RecipeBuild | null): Partial<MemoryQaRow> | null => {
        const dep = a.arms!.recipes![s.arm.context!].reuse_from;
        if (!dep) return null;
        const mine = built?.meta.prompt_sha256 ?? contexts.get(key)?.prompt_sha256;
        const depKey = contextKey(q.id, s.arm.policy, dep, s.arm.budget_tokens, a.arms!.recipes?.[dep] ? recipeHash(dep, a.arms!) : null);
        const theirs = contexts.get(depKey);
        if (!mine || !theirs || theirs.prompt_sha256 !== mine) return null;
        const src = armState.find(x => x.arm.context === dep && x.arm.policy === s.arm.policy && x.arm.budget_tokens === s.arm.budget_tokens && x.arm.reader?.id === s.arm.reader?.id && x.arm.reader?.model === s.arm.reader?.model);
        const prior = src?.latest.get(q.id);
        if (!src || !prior || typeof prior.qa_score !== 'number') return null;
        if (built) contexts.put({ key, prompt_sha256: built.meta.prompt_sha256 as string, prompt: built.prompt, meta: built.meta });
        const { qa_score, qa_scores, qa_runs, qa_trap, qa_input_tokens, qa_output_tokens, qa_context_tokens, qa_answer } = prior;
        return { qa_score, qa_scores, qa_runs, qa_trap, qa_input_tokens, qa_output_tokens, qa_context_tokens, qa_answer, qa_context: { ...(built?.meta ?? contexts.get(key)!.meta) } as MemoryQaRow['qa_context'],
          reused_from: { arm: src.arm.id, prompt_sha256: mine }, outcome: 'scored' };
      };

      for (const q of qs) {
        const base: MemoryQaRow = { id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length, ...convFacts };
        if (arms.length) {
          for (const p of policies) {
            const key = retrievalKey(q.id, p);
            if (!rPending.has(key)) continue;
            const rb: MemoryQaRow = { ...base, id: key, question_id: q.id, policy_mode: p };
            const r = importError ? importFailure(rb) : { ...(await retrieveRow(q, rb, policyFor(p).policy)), id: key, question_id: q.id, policy_mode: p };
            appendAttempt(rDir, r as unknown as Parameters<typeof appendAttempt>[1]);
            rByKey.set(key, r);
          }
          for (const s of armState) {
            if (!s.pending.has(q.id)) continue;
            const r = rByKey.get(retrievalKey(q.id, s.arm.policy));
            if (!r) continue;
            const { items, id: _rid, question_id: _qid, policy_mode: _pm, ...retrieval } = r;
            let row: MemoryQaRow = { ...retrieval, id: q.id, arm: s.arm.id, context: (s.arm.context ?? undefined) as ContextMode | undefined, retrieval_key: retrievalKey(q.id, s.arm.policy) };
            if (s.arm.reader && !r.error && chat) {
              const key = contextKey(q.id, s.arm.policy, s.arm.context!, s.arm.budget_tokens, s.arm.recipe?.hash ?? null);
              let built: RecipeBuild | null = null;
              if (s.arm.recipe && !contexts.get(key)) {
                try { built = buildRecipe(q, r, s.arm.context!, s.arm.policy, s.arm.budget_tokens); }
                catch (e) { row = { ...row, error: errorText(e), error_origin: 'harness', outcome: 'harness_invalid' }; appendAttempt(s.dir, row as unknown as Parameters<typeof appendAttempt>[1]); s.written++; continue; }
              }
              const reused = s.arm.recipe ? reuseRow(q, s, key, built) : null;
              row = reused ? { ...row, ...reused } : await readRow(q, row, items ?? [], s.arm.context!, s.arm.budget_tokens, s.arm.reader.model, judgeModel, { key }, false, built);
            }
            appendAttempt(s.dir, row as unknown as Parameters<typeof appendAttempt>[1]);
            s.latest.set(q.id, row);
            s.written++;
          }
          continue;
        }
        let row: MemoryQaRow;
        if (importError) row = legacy ? { ...base, error: `import failed: ${importError}`, error_origin: 'sut' } : importFailure(base);
        else if (legacy) {
          const t0 = performance.now();
          try {
            const res = await system.retrieve(ns, sanitizer.question(q), policy);
            const latency = res.service_ms ?? performance.now() - t0;
            const retrieved = uniqueInOrder(res.items.map(i => (i.source_ids[0] ? sanitizer.sessionOf(ns, i.source_ids[0]) : undefined) ?? `?${i.id}`)).slice(0, a.topK);
            row = { ...base, ...scoreRetrieval(retrieved, q.gold), retrieved, latency_ms: Math.round(latency * 10) / 10, error: null };
            if (chat) {
              try {
                const scores: number[] = [];
                let tin = 0; let tout = 0; let answer = ''; let trap = 0;
                const pack = packSessions(retrieved.map(id => sessById.get(id)).filter((x): x is Session => !!x), a.qa.sessions, a.qa.budgetTokens);
                const readFacts = a.qa.context === 'facts' ? retrieved.slice(0, a.qa.sessions).flatMap(id => factsBySession.get(id) ?? []) : [];
                for (let r = 0; r < a.qa.runs; r++) {
                  if (think) {
                    const res = await think(brain(), { question: q.question, model: a.qa.thinkModel, modelExplicit: true, remote: false });
                    answer = res.answer ?? '';
                    tin += approxTokens(q.question);
                  } else {
                    const prompt = a.qa.context === 'facts' ? factsReaderPrompt(q, readFacts, lastDate(conv.sessions)) : readerPrompt(q, pack.sessions, lastDate(conv.sessions));
                    const out = await chat.chat(a.qa.reader, prompt, { maxTokens: 1024, replicate: r });
                    answer = out.text; tin += out.input_tokens; tout += out.output_tokens;
                  }
                  scores.push(await judgeResponse(chat, a.benchmark, a.qa.judge, q, answer, r).catch(e => { throw new Error(`judge: ${(e as Error).message}`); }));
                  if (q.abstention && repeatsTrap(answer, q.trap)) trap++;
                }
                row = { ...row, qa_score: scores.reduce((x, y) => x + y, 0) / scores.length, qa_scores: scores, qa_runs: scores.length,
                  ...(q.trap ? { qa_trap: trap / scores.length } : {}), qa_input_tokens: Math.round(tin / scores.length), qa_output_tokens: Math.round(tout / scores.length),
                  qa_context_tokens: think || a.qa.context === 'facts' ? undefined : pack.tokens, qa_sessions: think || a.qa.context === 'facts' ? undefined : pack.sessions.length,
                  ...(a.qa.context === 'facts' ? { qa_facts: readFacts.length, qa_facts_tokens: factsContextTokens(readFacts) } : {}), qa_answer: answer.slice(0, 2000) };
              } catch (e) {
                row = { ...row, qa_error: (e as Error).message.slice(0, 300) };
              }
            }
          } catch (e) {
            row = { ...base, error: (e as Error).message, error_origin: /budget|BudgetExceeded/i.test((e as Error).message) ? 'harness' : 'sut' };
          }
        } else {
          row = await retrieveRow(q, base, policy);
          if (chat && !row.error) row = await readRow(q, row, row.items ?? [], a.context, a.qa.budgetTokens, a.qa.reader, a.qa.judge, null, true);
        }
        record(row);
      }
    }
  } finally {
    try { await system.close?.(); } catch { /* ignore */ }
    cache?.close();
  }

  if (fidelity.embedding_deferred_pages > 0) invalidReasons.push(`${fidelity.embedding_deferred_pages} pages were saved without vectors (embedding_deferred), so vector retrieval was not what ran`);
  if (rerankPinned && fidelity.rerank_missing_queries > 0) invalidReasons.push(`${fidelity.rerank_missing_queries} queries came back without rerank scores although the reranker is pinned on`);
  let cost: Record<string, unknown> | null = null;
  if (paid) {
    const summary = paid.run.close();
    paid.guard.uninstall();
    cost = receiptCost(summary) as unknown as Record<string, unknown>;
  }
  /** Counts, retrieval means and the reading-lane summary of one canonical row set. */
  const summarize = (canon: Canonical, reading: boolean) => {
    const rows = canon.rows as unknown as MemoryQaRow[];
    const scored = rows.filter(r => !r.abstention && !r.error && r.gold_count > 0 && r.recall_measurable !== false);
    const mean = (k: keyof MemoryQaRow) => scored.length ? scored.reduce((s, r) => s + Number(r[k] ?? 0), 0) / scored.length : null;
    const harnessFailures = canon.outcomes.filter(o => HARNESS_FAILURES.has(o.outcome)).length;
    const qaSummary = () => {
      const qa = rows.filter(r => typeof r.qa_score === 'number');
      const product = canon.outcomes.filter(o => PRODUCT_FAILURES.has(o.outcome)).length;
      return { qa_score: qa.length ? qa.reduce((x, r) => x + (r.qa_score ?? 0), 0) / qa.length : null, qa_rows: qa.length, qa_errors: rows.filter(r => r.qa_error).length,
        qa_service_score: qa.length + product ? qa.reduce((x, r) => x + (r.qa_score ?? 0), 0) / (qa.length + product) : null, qa_product_failures: product, qa_incomplete: harnessFailures };
    };
    return {
      rows, harnessFailures,
      counts: { rows: rows.length, scored: scored.length, errors: rows.filter(r => r.error).length, abstention: rows.filter(r => r.abstention).length },
      summary: { recall_all_at_5: mean('recall_all_at_5'), recall_any_at_5: mean('recall_any_at_5'), recall_all_at_10: mean('recall_all_at_10'), ndcg_at_10: mean('ndcg_at_10'),
        latency_p50_ms: scored.length ? percentile(scored.map(r => r.latency_ms ?? 0), 50) : null, latency_p95_ms: scored.length ? percentile(scored.map(r => r.latency_ms ?? 0), 95) : null,
        ...(reading ? qaSummary() : {}) },
      upstream_trouble_rows: rows.filter(r => r.provider?.upstream && upstreamTrouble(r.provider as Meter)).length,
      upstream_retries: rows.filter(r => r.upstream_retry).length,
    };
  };
  const status = (canon: Canonical, extra: string[] = []) => invalidReasons.length || extra.length ? 'invalid' : canon.missing.length ? 'partial' : 'complete';
  const shared = {
    schema_version: 1, benchmark: a.benchmark, split: a.split,
    started_at: started, finished_at: new Date().toISOString(),
    product: productIdentityFor(gut), overlay: overlaySummary(gut), arm_config: a.config, search_pins: a.pins,
    embedding: { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims, cache_stats: cache ? { ...cache.stats } : null },
    dataset: corpus.source,
    facts: a.facts === 'none' ? null : { lane: a.facts, extractor: 'runExtractConversationFactsCore (product default model, force)', pages: 'conversation type, ISO session date', ...factStats,
      unresolved_share: factStats.facts ? factStats.unresolved / factStats.facts : null },
    fidelity, cost, ingest_replicate: a.ingestReplicate,
    metering: a.providerProxy ? { mode: 'lease-proxy', proxy: a.providerProxy, slot, lease_id: process.env.SHOOTOUT_LEASE_ID ?? null, retry_upstream_5xx: a.retryUpstream5xx } : { mode: paid ? 'budget-ledger' : 'none' },
    ingest: legacy ? null : { ...ingestStats, errors: allIngestErrors, errors_truncated: allIngestErrors.length >= 500 }, sanitizer: { forbidden_markers: sanitizer.markers.length }, sealed_profile: sealed ? { checked: 'output and caches inside the custody root, outside the repository and the shared cache' } : null,
  };
  const readerPromptName = (context: ContextMode) => a.qa.mode === 'think' ? 'gbrain think' : a.qa.context === 'facts' ? 'step-by-step reading prompt over the saved facts (text + stored date) of the top sessions' : !legacy && context === 'native' ? `native memory-item reading prompt (${RENDERER_VERSION}, ${TOKENIZER.id})` : 'LongMemEval step-by-step reading prompt, sessions in date order';
  const judgePrompts = a.arms && judgeModel === READER_ONLY ? 'none: reader-only arms, judged outside this process' : a.benchmark.startsWith('beam') ? 'per-rubric-item yes/no' : 'LongMemEval official per-type prompts';

  if (arms.length) {
    const rCanon = canonicalize(rManifest!, readAttempts(rDir), a.maxAttempts);
    writeCanonical(rDir, rCanon);
    const armReceipts = armState.map(s => {
      const canon = canonicalize(s.manifest, readAttempts(s.dir), a.maxAttempts);
      writeCanonical(s.dir, canon);
      const sum = summarize(canon, !!s.arm.reader);
      const pol = policyFor(s.arm.policy);
      const receipt = {
        kind: 'memory-qa-arm', ...shared, run_status: status(canon, canon.foreign.length ? ['foreign'] : []), invalid_reasons: [...invalidReasons, ...(canon.foreign.length ? [`${canon.foreign.length} attempted ids are not in the frozen manifest`] : [])],
        run_config_hash: s.manifest.run_config_hash, cell_run_config_hash: hash, arm: s.arm,
        retrieval_path: `MemorySystem.retrieve (${system.name}, policy ${pol.policy.name}), one retrieval per question and policy shared by every arm`,
        selection: { categories: a.categories, limit: a.limit, seed: a.seed, shard: a.shard, conversations: myConvs.length, questions_expected: s.manifest.expected.length, reader_slice: s.arm.reader?.slice ?? null },
        counts: sum.counts, summary: sum.summary,
        qa: s.arm.reader ? { reader: s.arm.reader.model, judge: judgeModel, runs: a.qa.runs, context: s.arm.context, budget_tokens: s.arm.budget_tokens, reader_prompt: s.arm.recipe ? `recipe ${s.arm.recipe.name} (${a.arms!.recipes![s.arm.recipe.name].render}, ${s.arm.recipe.hash.slice(0, 16)})` : readerPromptName(s.arm.context as ContextMode), judge_prompts: judgePrompts, contexts_file: '../../contexts.ndjson' } : null,
        system: { name: system.name, capability_system: capabilities.system, capabilities, identity: sysIdentity },
        context: s.arm.context, policy: { name: pol.policy.name, mode: pol.policy.mode, settings: pol.policy.settings, settings_source: pol.source },
        manifest_sha256: s.manifest.expected_sha256, outcomes: canon.counts, attempts_this_run: s.written, comparison_complete: canon.missing.length === 0 && sum.harnessFailures === 0,
        upstream: { trouble_rows: sum.upstream_trouble_rows, retried_rows: sum.upstream_retries },
        rows_file: 'rows.ndjson', files: { manifest: 'manifest.json', attempts: 'attempts.ndjson', outcomes: 'outcomes.ndjson', rows: 'rows.ndjson' },
      };
      writeFileSync(join(s.dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
      return receipt;
    });
    const rSum = summarize(rCanon, false);
    const receipt = {
      kind: 'memory-qa-arms', ...shared, run_status: invalidReasons.length ? 'invalid' : armReceipts.every(r => r.run_status === 'complete') && rCanon.missing.length === 0 ? 'complete' : 'partial', invalid_reasons: invalidReasons,
      run_config_hash: hash, selection: { categories: a.categories, limit: a.limit, seed: a.seed, shard: a.shard, conversations: myConvs.length, questions_expected: manifest.expected.length },
      system: { name: system.name, capability_system: capabilities.system, capabilities, identity: sysIdentity },
      counts: rSum.counts, summary: rSum.summary, retrievals: { dir: 'retrievals', expected: rManifest!.expected.length, outcomes: rCanon.counts, policies },
      contexts: { file: 'contexts.ndjson', frozen: contexts.size },
      arms: armReceipts.map(r => ({ id: r.arm.id, dir: `arms/${r.arm.id}`, run_status: r.run_status, outcomes: r.outcomes, counts: r.counts, summary: r.summary })),
    };
    writeFileSync(join(a.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { receipt, rows: rSum.rows };
  }

  const canon = canonicalize(manifest, readAttempts(a.output), a.maxAttempts);
  writeCanonical(a.output, canon);
  if (canon.foreign.length) invalidReasons.push(`${canon.foreign.length} attempted ids are not in the frozen manifest`);
  const sum = summarize(canon, a.qa.mode !== 'none');
  const receipt = {
    kind: 'memory-qa-arm', ...shared, run_status: status(canon), invalid_reasons: invalidReasons, run_config_hash: hash,
    retrieval_path: legacy ? 'hybridSearch (expansion off), chunks reduced to distinct sessions' : `MemorySystem.retrieve (${system.name}, policy ${policy.name}), strict sources in first-appearance order`,
    selection: { categories: a.categories, limit: a.limit, seed: a.seed, shard: a.shard, conversations: myConvs.length, questions_expected: manifest.expected.length },
    counts: sum.counts, summary: sum.summary,
    qa: a.qa.mode === 'none' ? null : { ...a.qa, reader_prompt: readerPromptName(a.context), judge_prompts: judgePrompts },
    rows_file: 'rows.ndjson',
    system: { name: system.name, capability_system: capabilities.system, context: a.context, policy, capabilities, identity: sysIdentity },
    context: a.context, policy: { name: policy.name, mode: policy.mode, settings: policy.settings, settings_source: knobsSource },
    manifest_sha256: manifest.expected_sha256, outcomes: canon.counts, attempts_this_run: written, comparison_complete: canon.missing.length === 0 && sum.harnessFailures === 0,
    upstream: { trouble_rows: sum.upstream_trouble_rows, retried_rows: sum.upstream_retries },
    files: { manifest: 'manifest.json', attempts: 'attempts.ndjson', outcomes: 'outcomes.ndjson', rows: 'rows.ndjson' },
  };
  writeFileSync(join(a.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, rows: sum.rows };
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
