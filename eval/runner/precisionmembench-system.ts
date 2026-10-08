/**
 * PrecisionMemBench for any shootout system (open-source memory shootout,
 * Phase 5, row P3; preregistration family S3).
 *
 *   bun eval/runner/precisionmembench-system.ts --system <shim URL>|gbrain-shootout|fake --output <dir>
 *     [--gbrain <checkout>[@ref]] [--config key=value]... [--embed hash|real] [--embedding-model provider:model --embedding-dims N]
 *     [--policy vendor-default|fixed-evidence] [--policy-setting key=value]... [--limit N]
 *     [--max-attempts 3] [--finish-timeout-s 600] [--ingest-timeout-s 3600]
 *     [--provider-proxy <metering proxy URL>] [--proxy-slot <slot>] [--no-retry-upstream-5xx]
 *     [--paid --budget-run-id <id>]   (gbrain-shootout without a lease proxy)
 *
 * The contract ("PrecisionMemBench upstream contract", plan decision 20):
 * the vendored upstream evaluator (eval/precisionmembench/scorer, untouched)
 * builds every case's context. Persona, pinned facts, open questions,
 * relation expansion and the budget are its own, identical for every system;
 * only `searchText` goes through the system under test
 * (eval/precisionmembench/systemAdapter.ts), as for gbrainAdapter.ts.
 *
 * How beliefs reach a system. Through normal ingestion behind the sanitizer:
 * one session per belief, one user turn holding upstream's own `/add` text
 * (canonical name, aliases, content, why it matters). Superseded beliefs are
 * seeded live, as the existing adapter does; no type, label, supersession
 * field, belief id or case id crosses (forbidden markers, checked by the
 * client tripwire). The upstream `/add` carries `user_id` and the belief's
 * scope, and its `/search` asks for a user and a scope. The protocol has
 * neither, so each (user, scope) a case searches is its own opaque
 * namespace holding that user's beliefs of that scope plus the user's
 * universal beliefs: the same federation gbrain's source isolation gives
 * the legacy adapter (scope.ts). A belief no searched namespace holds (the
 * other user's) is ingested into a namespace of its own, so every belief
 * reaches the system.
 *
 * Time. The fixture has no event times on the upstream wire, but two shims
 * (temporal-graph, memory-bank) refuse an undated session. Every belief gets a
 * disclosed synthetic time, one minute apart in fixture order from
 * 2026-05-29T00:00 (upstream's pin date): the arrival order upstream
 * providers saw, and nothing taken from the belief's own dates. Queries are
 * asked at their namespace's last event time (the preregistered rule for
 * undated questions).
 *
 * From items to beliefs. One retrieval per searching case under a named
 * policy (default `vendor-default`, the record's own settings). Returned
 * items map to beliefs through source provenance: distinct sources in
 * first-appearance order over items in rank order, whole items, cut at the
 * case's limit (`maxBeliefs`, default 20), the preregistered strict-source
 * rule (render.ts `strictSources`). Items whose provenance is unavailable
 * cite nothing. A retrieval whose items all lack provenance cannot be mapped
 * to beliefs: the row says `provenance_measurable: false`, its precision and
 * recall are null and the summary reports the family as not measurable
 * rather than zero.
 *
 * Outcomes (memory-qa/outcomes.ts): one canonical row per case from a frozen
 * manifest and append-only attempts. `scored`; product failures kept in the
 * denominator as misses (`retrieval_error`, `unsupported`); `ingest_degraded`
 * (a namespace with failed sessions, a finish timeout or a readiness probe
 * that misses its last session; scores kept); harness failures that make the
 * comparison incomplete (`harness_invalid`, `budget_not_run`). A failed
 * system call is a recorded outcome, never a crash.
 *
 * Families (S3): the categories the vendored scorer classifies as structural
 * (`STRUCTURAL_CATEGORIES` in buildRetrievalReport.ts, read through its own
 * pass classification) are reported separately; every other category is
 * search-only, the headline.
 *
 * Metering: with a lease proxy (--provider-proxy, default SHOOTOUT_PROXY) the
 * process's provider keys become dummies, gbrain's calls go to the proxy, and
 * each namespace's ingest and each case's retrieval are charged to their own
 * proxy key, so rows carry their provider dollars.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun, type BudgetRun, type PaidRequestGuard } from './budget-ledger.ts';
import { requirePaidArm } from './paid-arm.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest } from './gbrain-under-test.ts';
import { EmbeddingCache, makeCachingTransport } from './longmemeval-cache.ts';
import { percentile } from './metrics.ts';
import { ProxyControl, upstreamTrouble, type Meter } from './metering-proxy.ts';
import { appendAttempt, canonicalize, DEFAULT_MAX_ATTEMPTS, freezeManifest, HARNESS_FAILURES, PRODUCT_FAILURES, readAttempts, writeCanonical, type Outcome, type Row } from './memory-qa/outcomes.ts';
import { hashEmbed, readinessProbe, type ProbeResult } from './memory-qa/run.ts';
import type { Conversation, MemoryQuestion } from './memory-qa/corpus.ts';
import { FakeMemorySystem } from './systems/fake.ts';
import { GbrainShootoutSystem, type GbrainModules } from './systems/gbrain.ts';
import { HttpMemorySystem } from './systems/http.ts';
import { strictSources, validateSources } from './systems/render.ts';
import { Sanitizer, SanitizerLeakError } from './systems/sanitize.ts';
import { policyKnobs, SystemError, type CapabilityRecord, type Item, type MemorySystem, type RetrievalPolicy } from './systems/types.ts';
import { buildReportPayload, buildRetrievalSummary } from '../precisionmembench/scorer/buildRetrievalReport.ts';
import { coerceBelief, pinnedInSeedSet, scoreCases, USER_ID, type ReportEntry, type RetrievalCase } from '../precisionmembench/scorer/runCases.ts';
import type { Belief } from '../precisionmembench/scorer/belief.ts';
import { SystemBeliefAdapter, type BeliefSearchRequest } from '../precisionmembench/systemAdapter.ts';

const PMB_DIR = join(import.meta.dir, '..', 'precisionmembench');
export const FIXTURE_BELIEFS = join(PMB_DIR, 'fixtures', 'beliefs.seed.json');
export const FIXTURE_CASES = join(PMB_DIR, 'fixtures', 'retrieval.cases.json');
const SCORER_FILES = ['scorer/baseAdapter.ts', 'scorer/belief.ts', 'scorer/buildRetrievalReport.ts', 'scorer/runCases.ts', 'providers.config.json'];
export const UPSTREAM_COMMIT = 'c9689ca63d83f8979b235fd2c0a6ddf2d28ca850';
export const CONTRACT = 'PrecisionMemBench upstream contract';
export const UNIVERSAL = 'user:universal';
export const TIME_ANCHOR = '2026-05-29T00:00:00';
const DEFAULT_MAX_BELIEFS = 20;
const ADAPTER_VERSION = 'pmb-system-v1';

export interface PmbArgs {
  system: string;
  output: string;
  gbrain: string | null;
  config: Record<string, string>;
  embed: 'hash' | 'real';
  embeddingModel: string;
  embeddingDims: number;
  policy: RetrievalPolicy['mode'];
  policySettings: Record<string, string>;
  limit: number | null;
  maxAttempts: number;
  finishTimeoutS: number;
  ingestTimeoutS: number;
  providerProxy: string | null;
  proxySlot: string | null;
  retryUpstream5xx: boolean;
  argv: string[];
}

const VALUE_FLAGS = new Set(['--system', '--output', '--gbrain', '--config', '--embed', '--embedding-model', '--embedding-dims', '--policy', '--policy-setting', '--limit', '--max-attempts',
  '--finish-timeout-s', '--ingest-timeout-s', '--provider-proxy', '--proxy-slot', '--budget-run-id', '--budget-ledger', '--budget-usd', '--program-cap-usd']);
const BARE_FLAGS = new Set(['--paid', '--no-retry-upstream-5xx']);

function kv(list: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`${flag} needs key=value (got ${item})`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

export function parsePmbArgs(argv: string[]): PmbArgs {
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].includes('=') && argv[i].startsWith('--budget') ? argv[i].slice(0, argv[i].indexOf('=')) : argv[i];
    if (BARE_FLAGS.has(flag) || (flag !== argv[i] && VALUE_FLAGS.has(flag))) continue;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument ${argv[i]} (valid: ${[...VALUE_FLAGS, ...BARE_FLAGS].join(' ')})`);
    if (argv[i + 1] === undefined) throw new Error(`${flag} requires a value`);
    i++;
  }
  const one = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const int = (name: string, fallback: number | null, min: number) => {
    const raw = one(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got ${raw})`);
    return n;
  };
  const system = one('--system');
  if (!system) throw new Error('--system <shim URL>|gbrain-shootout|fake is required');
  if (system !== 'gbrain-shootout' && system !== 'fake' && !/^https?:\/\//.test(system)) throw new Error(`--system must be gbrain-shootout, fake or a protocol v1 shim URL (got ${system})`);
  const output = one('--output');
  if (!output) throw new Error('--output <dir> is required');
  const embed = (one('--embed') ?? 'real') as PmbArgs['embed'];
  if (!['hash', 'real'].includes(embed)) throw new Error('--embed must be hash or real');
  const policy = (one('--policy') ?? 'vendor-default') as PmbArgs['policy'];
  if (policy !== 'vendor-default' && policy !== 'fixed-evidence') throw new Error('--policy must be vendor-default or fixed-evidence');
  const embeddingModel = one('--embedding-model') ?? 'openai:text-embedding-3-large';
  if (!/^(openai|voyage|google):\S+$/.test(embeddingModel)) throw new Error('--embedding-model must look like provider:model');
  return {
    system, output: resolve(output), gbrain: gbrainSpecFrom(argv), config: kv(many('--config'), '--config'), embed, embeddingModel,
    embeddingDims: int('--embedding-dims', 1536, 1)!, policy, policySettings: kv(many('--policy-setting'), '--policy-setting'), limit: int('--limit', null, 1),
    maxAttempts: int('--max-attempts', DEFAULT_MAX_ATTEMPTS, 1)!, finishTimeoutS: int('--finish-timeout-s', 600, 1)!, ingestTimeoutS: int('--ingest-timeout-s', 3600, 1)!,
    providerProxy: (one('--provider-proxy') ?? process.env.SHOOTOUT_PROXY ?? '').replace(/\/$/, '') || null,
    proxySlot: one('--proxy-slot') ?? process.env.SHOOTOUT_PROXY_SLOT ?? null,
    retryUpstream5xx: !argv.includes('--no-retry-upstream-5xx'), argv,
  };
}

export type Family = 'search-only' | 'structural';

/** The vendored scorer's own classification: a passing case with null precision counts as `structural` exactly for its STRUCTURAL_CATEGORIES. */
export function familyOf(category: string): Family {
  const s = buildRetrievalSummary({ provider: 'classify', caseCount: 1, entries: [{ category, retrievalLatencyMs: 0, retrievalPrecision: null, retrievalRecall: null, passed: true }] });
  return s.passTypes.structural === 1 ? 'structural' : 'search-only';
}

/** Whether `buildContext` will call `searchText` for this case (verbatim condition: a non-blank query and a positive belief budget). */
export function searches(tc: RetrievalCase): boolean {
  return tc.query.trim() !== '' && ({ maxBeliefs: DEFAULT_MAX_BELIEFS, ...tc.budget }.maxBeliefs ?? DEFAULT_MAX_BELIEFS) > 0;
}

export interface View { id: string; user: string; scope: string; beliefs: Belief[]; searched: boolean }

const viewId = (user: string, scope: string) => `pmb-view:${user}:${scope}`;
const scopeOf = (scope: string | undefined) => scope ?? UNIVERSAL;

/**
 * The namespaces a run builds: one per (user, scope) a case searches, holding
 * that user's beliefs of that scope plus the user's universal beliefs, then
 * one per (owner, home scope) for any belief no searched namespace holds.
 * Unsearched namespaces come first, so a shim holds them while the cases run.
 */
export function buildViews(beliefs: readonly Belief[], cases: readonly RetrievalCase[]): View[] {
  const holds = (user: string, scope: string) => beliefs.filter(b => b.user_id === user && (b.scope.includes(scope) || b.scope.includes(UNIVERSAL)));
  const searched: View[] = [];
  for (const tc of cases) {
    if (!searches(tc)) continue;
    const user = tc.userId ?? USER_ID, scope = scopeOf(tc.scope[0]);
    if (!searched.some(v => v.user === user && v.scope === scope)) searched.push({ id: viewId(user, scope), user, scope, beliefs: holds(user, scope), searched: true });
  }
  const owners: View[] = [];
  for (const b of beliefs) {
    if ([...searched, ...owners].some(v => v.beliefs.includes(b))) continue;
    const scope = b.scope[0] ?? UNIVERSAL;
    owners.push({ id: viewId(b.user_id, scope), user: b.user_id, scope, beliefs: holds(b.user_id, scope), searched: false });
  }
  return [...owners, ...searched];
}

const minutesAfter = (iso: string, n: number) => new Date(new Date(`${iso}Z`).getTime() + n * 60_000).toISOString().slice(0, 19);

/** The views as a sanitizer corpus: each view a conversation, each belief a one-turn session with upstream's `/add` text and its synthetic time. */
export function pmbCorpus(views: readonly View[], beliefs: readonly Belief[], cases: readonly RetrievalCase[], text: (b: Belief) => string): { conversations: Conversation[]; questions: MemoryQuestion[] } {
  const index = new Map(beliefs.map((b, i) => [b._id, i]));
  return {
    conversations: views.map(v => ({ id: v.id, sessions: v.beliefs.map(b => ({ id: b._id, date: minutesAfter(TIME_ANCHOR, index.get(b._id)!), turns: [{ speaker: 'user', content: text(b) }] })) })),
    questions: cases.map(tc => ({ id: tc.caseId, conversation: searches(tc) ? viewId(tc.userId ?? USER_ID, scopeOf(tc.scope[0])) : '', question: tc.query, category: tc.category, gold: [], abstention: false })),
  };
}

/**
 * Evaluator-side labels that must never reach a system beyond the corpus
 * markers (ids, categories): user ids, scopes, belief types and statuses. A
 * label that occurs in honest traffic (belief text or a query) is dropped.
 */
export function labelMarkers(beliefs: readonly Belief[], cases: readonly RetrievalCase[], text: (b: Belief) => string): string[] {
  const honest = [...beliefs.map(text), ...cases.map(c => c.query)].join('\n');
  const raw = beliefs as unknown as Array<Record<string, unknown>>;
  const candidates = new Set<string>([...beliefs.map(b => b.user_id), ...beliefs.flatMap(b => b.scope), ...cases.map(c => c.userId ?? USER_ID), ...cases.flatMap(c => c.scope),
    ...raw.flatMap(b => ['type', 'subtype', 'relation_type', 'epistemic_status', 'expertise_domain', 'expertise_depth'].map(k => b[k]).filter((v): v is string => typeof v === 'string'))]);
  return [...candidates].filter(m => m.length >= 6 && !honest.includes(m)).sort();
}

/** The expected-relevant set the scorer measures precision and recall against (verbatim derivation). */
function expectedOf(tc: RetrievalCase, pinnedInSeed: Set<string>): string[] {
  const rb = tc.expect.relevantBeliefs ?? {};
  return rb.shouldOnlyInclude ? [...rb.shouldOnlyInclude] : (rb.mustInclude ?? []).filter(id => !pinnedInSeed.has(id));
}

/** A system that failed during `buildContext` returned nothing: precision and recall per the empty-return rules, kept in every denominator. */
function missEntry(tc: RetrievalCase, pinnedInSeed: Set<string>, message: string): ReportEntry {
  const expected = expectedOf(tc, pinnedInSeed);
  return { caseId: tc.caseId, category: tc.category, description: tc.description, pinnedBeliefs: [], relevantBeliefs: [], retrievedQuestions: [],
    retrievalPrecision: expected.length ? 0 : null, retrievalRecall: expected.length ? 0 : null, pinnedCoverage: null, passed: false,
    failures: [`provider threw during buildContext: ${message}`], retrievalLatencyMs: 0 };
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** A failure's canonical outcome: its kind decides product miss, harness failure or budget stop (memory-qa's rule). */
export function failureOutcome(e: unknown): { outcome: Outcome; error_origin: 'sut' | 'harness'; error_kind: string } {
  if (e instanceof SanitizerLeakError) return { outcome: 'harness_invalid', error_origin: 'harness', error_kind: 'sanitizer' };
  if (e instanceof HarnessError) return { outcome: 'harness_invalid', error_origin: 'harness', error_kind: 'harness' };
  const kind = e instanceof SystemError ? e.kind : /budget|BudgetExceeded/i.test(errorText(e)) ? 'budget' : 'product_error';
  if (kind === 'budget') return { outcome: 'budget_not_run', error_origin: 'harness', error_kind: kind };
  if (kind === 'invalid_request') return { outcome: 'harness_invalid', error_origin: 'harness', error_kind: kind };
  return { outcome: kind === 'unsupported' ? 'unsupported' : 'retrieval_error', error_origin: 'sut', error_kind: kind };
}

class HarnessError extends Error { constructor(message: string) { super(message); this.name = 'HarnessError'; } }

interface ViewIngest { ns: string; sessions: number; failed_sessions: number; finish_ready: boolean; completeness: string; readiness_probe: ProbeResult; degraded: boolean; error: string | null; errors: Array<{ source_id: string; kind: string; message: string }>; provider?: ProviderUse }
interface ProviderUse { usd: number; requests: number; unpriced: number; upstream?: Meter['upstream'] }

export interface PmbRow extends Row {
  case_id: string;
  category: string;
  family: Family;
  description: string;
  user: string;
  scope: string[];
  query: string;
  budget: RetrievalCase['budget'] | null;
  system: string;
  policy: string;
  system_called: boolean;
  outcome: Outcome;
  error: string | null;
  error_kind?: string;
  error_origin?: 'sut' | 'harness';
  passed: boolean;
  precision: number | null;
  recall: number | null;
  pinned_coverage: number | null;
  failures: string[];
  returned_ids: string[];
  pinned_ids: string[];
  question_ids: string[];
  expected_ids: string[];
  search_ids?: string[];
  provenance_measurable?: boolean;
  scorer_metrics?: { precision: number | null; recall: number | null };
  items_returned?: number;
  items_cited?: number;
  provenance?: { exact: number; partial: number; unavailable: number };
  fanout_mean?: number;
  fanout_max?: number;
  items?: Item[];
  applied_settings?: Record<string, unknown>;
  truncated?: boolean;
  query_time?: string | null;
  latency_ms?: number;
  harness_ms?: number;
  scorer_latency_ms: number;
  provider?: ProviderUse;
  upstream_retry?: { first_error: string | null; first_provider: ProviderUse | null };
  ingest?: ViewIngest;
}

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const round4 = (x: number) => Math.round(x * 10000) / 10000;
const mean = (xs: number[]) => xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const providerOf = (m: Meter | null): ProviderUse | undefined => m ? { usd: m.usd, requests: m.requests, unpriced: m.unpriced, ...(m.upstream ? { upstream: m.upstream } : {}) } : undefined;

/** True when the system returned items but none of them cited a source: no case can be mapped to beliefs (the preregistered not-measurable rule). */
export function provenanceBlind(rows: readonly PmbRow[]): boolean {
  const answered = rows.filter(r => (r.items_returned ?? 0) > 0);
  return answered.length > 0 && answered.every(r => r.provenance_measurable === false);
}

/** Per-family means over rows without a harness failure; product failures count as the misses they are, rows whose items cite nothing are left out and counted. */
export function familySummary(rows: readonly PmbRow[], blind: boolean) {
  const counted = rows.filter(r => !HARNESS_FAILURES.has(r.outcome));
  const measurable = blind ? [] : counted.filter(r => r.provenance_measurable !== false);
  const precision = measurable.map(r => r.precision).filter((v): v is number => v !== null);
  const recall = measurable.map(r => r.recall).filter((v): v is number => v !== null);
  return {
    cases: rows.length, counted: counted.length, harness_failures: rows.length - counted.length, passed: counted.filter(r => r.passed).length,
    mean_precision: mean(precision), n_precision: precision.length, mean_recall: mean(recall), n_recall: recall.length,
    provenance_not_measurable: counted.filter(r => r.provenance_measurable === false).length,
    metrics: blind ? 'not measurable: no returned item cites a source' : 'measured',
  };
}

export async function runPmb(a: PmbArgs): Promise<{ receipt: Record<string, unknown>; rows: PmbRow[] }> {
  const started = new Date().toISOString();
  mkdirSync(a.output, { recursive: true });
  const fixtureText = { beliefs: readFileSync(FIXTURE_BELIEFS, 'utf8'), cases: readFileSync(FIXTURE_CASES, 'utf8') };
  const beliefs = (JSON.parse(fixtureText.beliefs) as Record<string, unknown>[]).map(coerceBelief);
  const allCases = JSON.parse(fixtureText.cases) as RetrievalCase[];
  const cases = a.limit ? allCases.slice(0, a.limit) : allCases;
  const pinnedInSeed = pinnedInSeedSet(beliefs);

  let current: { caseId: string; user: string; scope: string; ns: string; queryTime: string | null; ingested: Set<string>; retrieval?: Partial<PmbRow> } | null = null;
  const adapter = new SystemBeliefAdapter(req => search(req));
  adapter.loadFixture(beliefs);
  const text = (b: Belief) => adapter.text(b);
  const views = buildViews(beliefs, cases);
  const corpus = pmbCorpus(views, beliefs, cases, text);
  const gut = resolveGbrainUnderTest(a.system === 'gbrain-shootout' ? a.gbrain : null);

  if (a.providerProxy) {
    if (!/^https?:\/\/[^/]+$/.test(a.providerProxy)) throw new Error('--provider-proxy must look like http://host:port');
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) process.env[k] = 'dummy-key-the-proxy-replaces';
    process.env.OPENAI_BASE_URL = `${a.providerProxy}/harness/openai/v1`;
    process.env.ANTHROPIC_BASE_URL = `${a.providerProxy}/harness/anthropic`;
  }

  let identity: Record<string, unknown> | null = null;
  if (/^https?:\/\//.test(a.system)) {
    const probe = new HttpMemorySystem(a.system);
    const [health, cap] = await Promise.all([probe.health(), probe.capabilities()]);
    if (health.ok !== true) throw new Error(`${a.system} is not healthy: ${JSON.stringify(health).slice(0, 300)}`);
    const { service_ms: _ms, ...h } = health;
    identity = { system: cap.system, config: typeof h.config === 'string' ? h.config : null, versions: cap.versions ?? null, health: h };
  } else if (a.system === 'gbrain-shootout') {
    identity = { system: 'gbrain-shootout', config: a.config, embedding: { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims }, gbrain: gut.overlay?.build.commit ?? gut.version };
  } else identity = { system: a.system };

  const scorerSha = Object.fromEntries(SCORER_FILES.map(f => [f, sha256(readFileSync(join(PMB_DIR, f)))]));
  const fixtureSha = { 'fixtures/beliefs.seed.json': sha256(fixtureText.beliefs), 'fixtures/retrieval.cases.json': sha256(fixtureText.cases) };
  const hash = sha256(JSON.stringify({ adapter: ADAPTER_VERSION, identity, policy: a.policy, policySettings: a.policySettings, limit: a.limit, fixtureSha, scorerSha, anchor: TIME_ANCHOR }));
  const headerPath = join(a.output, 'run-config.json');
  if (existsSync(headerPath) && (JSON.parse(readFileSync(headerPath, 'utf8')) as { run_config_hash: string }).run_config_hash !== hash) throw new Error(`${a.output} holds rows from a different run configuration; use a fresh --output`);
  writeFileSync(headerPath, JSON.stringify({ run_config_hash: hash, benchmark: 'precisionmembench', contract: CONTRACT, system: identity }, null, 2) + '\n');
  const manifest = freezeManifest(a.output, hash, cases.map(c => c.caseId));
  const pending = canonicalize(manifest, readAttempts(a.output), a.maxAttempts).pending;

  const sanitizer = new Sanitizer(corpus, hash);
  const markers = [...new Set([...sanitizer.markers, ...labelMarkers(beliefs, cases, text)])].sort();
  const outgoing = [...corpus.conversations.flatMap(c => c.sessions.flatMap(s => s.turns.map(t => t.content))), ...cases.map(c => c.query)];
  if (outgoing.some(t => markers.some(m => t.includes(m)))) throw new Error('a belief text or query carries a forbidden marker; the marker set would trip on honest traffic');

  const needsPaid = !a.providerProxy && a.system === 'gbrain-shootout' && (a.embed === 'real' || a.config['search.reranker.enabled'] !== 'false');
  let paid: { run: BudgetRun; guard: PaidRequestGuard } | null = null;
  if (needsPaid) {
    requirePaidArm(a.argv, { arm: 'precisionmembench gbrain-shootout', estimateUsd: 0.25, ledgerPath: budgetOptionsFrom(a.argv).ledgerPath });
    paid = startPaidRun('precisionmembench-system:gbrain-shootout', { ...budgetOptionsFrom(a.argv), estimateUsd: 0.25 });
  }

  let cache: EmbeddingCache | null = null;
  let system: MemorySystem;
  if (a.system === 'gbrain-shootout') {
    const provider = a.embeddingModel.split(':')[0];
    const proxyUrls = a.providerProxy ? { base_urls: { voyage: `${a.providerProxy}/harness/voyage/v1` } } : {};
    const gateway = await importGbrain<{ configureGateway: (c: Record<string, unknown>) => void; __setEmbedTransportForTests: (fn: unknown) => void }>(gut, 'src/core/ai/gateway.ts');
    if (a.embed === 'hash') {
      const keyEnv = ({ openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' } as Record<string, string>)[provider] ?? 'OPENAI_API_KEY';
      if (!process.env[keyEnv]) process.env[keyEnv] = 'hash-embed-transport-no-provider-call';
      gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env, ...proxyUrls });
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbed(v, a.embeddingDims)), values: params.values, warnings: [], usage: { tokens: 0 } }));
    } else {
      gateway.configureGateway({ embedding_model: a.embeddingModel, embedding_dimensions: a.embeddingDims, env: process.env, ...proxyUrls });
      const { embedMany } = await import(Bun.resolveSync('ai', gut.root)) as { embedMany: (p: unknown) => Promise<unknown> };
      const cacheDir = process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache');
      mkdirSync(cacheDir, { recursive: true });
      const key = `${a.embeddingModel}@${a.embeddingDims}`;
      cache = new EmbeddingCache(join(cacheDir, `embed-cache-${key.replace(/[^a-z0-9@-]/gi, '_')}.sqlite`), key);
      gateway.__setEmbedTransportForTests(makeCachingTransport(async (p: { values: string[] } & Record<string, unknown>) => embedMany(p) as never, cache));
    }
    const mods: GbrainModules = {
      PGLiteEngine: (await importGbrain<{ PGLiteEngine: GbrainModules['PGLiteEngine'] }>(gut, 'src/core/pglite-engine.ts')).PGLiteEngine,
      importFromContent: (await importGbrain<{ importFromContent: GbrainModules['importFromContent'] }>(gut, 'src/core/import-file.ts')).importFromContent,
      hybridSearch: (await importGbrain<{ hybridSearch: GbrainModules['hybridSearch'] }>(gut, 'src/core/search/hybrid.ts')).hybridSearch,
    };
    system = new GbrainShootoutSystem(mods, a.config, productIdentityFor(gut) as unknown as Record<string, unknown>);
  } else if (a.system === 'fake') system = new FakeMemorySystem();
  else system = new HttpMemorySystem(a.system, { markers, ingestTimeoutMs: a.ingestTimeoutS * 1000 });

  const capabilities: CapabilityRecord = await system.capabilities();
  const knobs = policyKnobs(capabilities.retrieval_policies?.[a.policy]);
  const policy: RetrievalPolicy = { name: `${capabilities.system}:${a.policy}`, mode: a.policy, settings: { ...knobs.settings, ...a.policySettings } };
  const ctl = a.providerProxy ? new ProxyControl(a.providerProxy) : null;
  const slot = a.proxySlot ?? (/^https?:\/\//.test(a.system) ? capabilities.system : 'harness');
  const metered = async <T>(key: string, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; meter: Meter | null }> => {
    if (ctl) return ctl.around(slot, key, fn);
    try { return { value: await fn(), meter: null }; } catch (error) { return { error, meter: null }; }
  };
  const invalidReasons: string[] = [];

  /** The one system call: retrieve in the case's namespace, validate sources, map items to beliefs. Failures are recorded on the case and rethrown into the scorer. */
  async function search(req: BeliefSearchRequest): Promise<string[]> {
    const c = current;
    if (!c || c.user !== req.userId || c.scope !== scopeOf(req.scope)) throw new HarnessError(`searchText for ${req.userId} in ${scopeOf(req.scope)} outside its prepared namespace`);
    const once = async (): Promise<{ part: Partial<PmbRow>; ids?: string[]; error?: unknown; meter: Meter | null }> => {
      const t0 = performance.now();
      const r = await metered(`q:${sha256(c.caseId).slice(0, 16)}`, () => system.retrieve(c.ns, { text: req.query, query_time: c.queryTime }, policy));
      const harness_ms = Math.round((performance.now() - t0) * 10) / 10;
      const provider = providerOf(r.meter);
      const base: Partial<PmbRow> = { query_time: c.queryTime, harness_ms, ...(provider ? { provider } : {}) };
      if (r.error !== undefined) return { part: base, error: r.error, meter: r.meter };
      const res = r.value!;
      try { validateSources(res.items, c.ingested); } catch (e) { return { part: base, error: e, meter: r.meter }; }
      const cut = strictSources(res.items, req.limit);
      const ids = cut.sources.map(s => sanitizer.sessionOf(c.ns, s)!);
      return { ids, meter: r.meter, part: { ...base, search_ids: ids, provenance_measurable: cut.measurable, items_returned: res.items.length,
        items_cited: res.items.filter(i => i.provenance_status !== 'unavailable').length,
        provenance: { exact: res.items.filter(i => i.provenance_status === 'exact').length, partial: res.items.filter(i => i.provenance_status === 'partial').length, unavailable: res.items.filter(i => i.provenance_status === 'unavailable').length },
        fanout_mean: round4(cut.fanout_mean), fanout_max: cut.fanout_max, items: res.items, applied_settings: res.applied_settings, truncated: res.truncated,
        latency_ms: Math.round((res.service_ms ?? harness_ms) * 10) / 10 } };
    };
    let got = await once();
    if (got.error !== undefined && a.retryUpstream5xx && PRODUCT_FAILURES.has(failureOutcome(got.error).outcome) && upstreamTrouble(got.meter)) {
      const first = got;
      got = await once();
      got.part.upstream_retry = { first_error: errorText(first.error), first_provider: first.part.provider ?? null };
    }
    c.retrieval = got.part;
    if (got.error !== undefined) {
      if (got.error instanceof SanitizerLeakError) invalidReasons.push(`sanitizer tripwire during retrieval: ${got.error.message}`);
      throw got.error;
    }
    return got.ids!;
  }

  const rowOf = (tc: RetrievalCase, entry: ReportEntry, extra: Partial<PmbRow>): PmbRow => {
    const row: PmbRow = {
      id: tc.caseId, case_id: tc.caseId, category: tc.category, family: familyOf(tc.category), description: tc.description, user: tc.userId ?? USER_ID, scope: tc.scope, query: tc.query, budget: tc.budget ?? null,
      system: system.name, policy: policy.name, system_called: false, outcome: 'scored', error: null,
      passed: entry.passed, precision: entry.retrievalPrecision, recall: entry.retrievalRecall, pinned_coverage: entry.pinnedCoverage, failures: entry.failures,
      returned_ids: entry.relevantBeliefs, pinned_ids: entry.pinnedBeliefs, question_ids: entry.retrievedQuestions, expected_ids: expectedOf(tc, pinnedInSeed),
      scorer_latency_ms: entry.retrievalLatencyMs, ...extra,
    };
    if (row.provenance_measurable === false && row.outcome !== 'retrieval_error') return { ...row, scorer_metrics: { precision: row.precision, recall: row.recall }, precision: null, recall: null };
    return row;
  };

  const scoreOne = async (tc: RetrievalCase, extra: Partial<PmbRow>): Promise<PmbRow> => {
    try {
      const [entry] = await scoreCases(adapter, [tc], pinnedInSeed);
      return rowOf(tc, entry, { ...extra, ...(current?.retrieval ?? {}) });
    } catch (e) {
      const f = failureOutcome(e);
      return rowOf(tc, missEntry(tc, pinnedInSeed, errorText(e)), { ...extra, ...(current?.retrieval ?? {}), error: errorText(e), ...f });
    }
  };

  let attempts = 0;
  const record = (row: PmbRow) => { appendAttempt(a.output, row); attempts++; };
  const ingestReports: Array<{ view: View; ns: string; ingest: ViewIngest | null }> = views.map(v => ({ view: v, ns: sanitizer.ns(v.id), ingest: null }));
  const ingestTotals = { namespaces: 0, sessions: 0, failed_sessions: 0, degraded_namespaces: 0, finish_timeouts: 0, readiness_probe_misses: 0, usd: 0, requests: 0 };

  const ingestView = async (v: View, ns: string): Promise<{ ingest: ViewIngest; importError: string | null }> => {
    const conv = corpus.conversations.find(c => c.id === v.id)!;
    const plan = sanitizer.ingestPlan(conv);
    const errors: ViewIngest['errors'] = [];
    let importError: string | null = null, failed = 0;
    const ran = await metered(`ingest:${ns}`, async () => {
      try { await system.reset(ns); } catch (e) { importError = e instanceof SystemError && e.kind === 'budget' ? `budget: ${errorText(e)}` : `reset failed: ${errorText(e)}`; return { ready: false, completeness: 'reset failed' }; }
      for (const step of plan) {
        try {
          const res = await system.ingestSession(ns, step.input, step.event_time);
          if (res.errors.length || res.completeness === 'degraded') { failed++; errors.push({ source_id: step.input.source_id, kind: res.errors.length ? 'reported' : 'degraded', message: (res.errors.map(String).join('; ') || `completeness ${res.completeness}`).slice(0, 300) }); }
        } catch (e) {
          if (e instanceof SanitizerLeakError) { importError = e.message; invalidReasons.push(`sanitizer tripwire during ingest: ${e.message}`); break; }
          if (e instanceof SystemError && e.kind === 'budget') { importError = `budget: ${errorText(e)}`; errors.push({ source_id: step.input.source_id, kind: 'budget', message: errorText(e) }); break; }
          failed++;
          errors.push({ source_id: step.input.source_id, kind: e instanceof SystemError ? e.kind : 'product_error', message: errorText(e) });
        }
      }
      if (importError) return { ready: false, completeness: 'not finished' };
      try { return await system.finishIngest(ns, a.finishTimeoutS); } catch (e) { return { ready: false, completeness: `error: ${errorText(e)}` }; }
    });
    const finish = ran.value ?? { ready: false, completeness: `error: ${errorText(ran.error)}` };
    let probe: ProbeResult = 'skipped';
    let probeMeter: Meter | null = null;
    if (!importError && finish.ready) {
      const p = await metered(`probe:${ns}`, () => readinessProbe(system, ns, plan.at(-1)?.input, policy, capabilities));
      probe = p.value ?? 'missed';
      probeMeter = p.meter;
    }
    const degraded = !importError && (failed > 0 || !finish.ready || probe === 'missed');
    const usd = (ran.meter?.usd ?? 0) + (probeMeter?.usd ?? 0), requests = (ran.meter?.requests ?? 0) + (probeMeter?.requests ?? 0);
    ingestTotals.namespaces++; ingestTotals.sessions += plan.length; ingestTotals.failed_sessions += failed; ingestTotals.usd += usd; ingestTotals.requests += requests;
    if (!finish.ready) ingestTotals.finish_timeouts++;
    if (probe === 'missed') ingestTotals.readiness_probe_misses++;
    if (degraded) ingestTotals.degraded_namespaces++;
    return { importError, ingest: { ns, sessions: plan.length, failed_sessions: failed, finish_ready: finish.ready, completeness: finish.completeness, readiness_probe: probe, degraded, error: importError, errors,
      ...(ctl ? { provider: { usd, requests, unpriced: (ran.meter?.unpriced ?? 0) + (probeMeter?.unpriced ?? 0), ...(ran.meter?.upstream ? { upstream: ran.meter.upstream } : {}) } } : {}) } };
  };

  try {
    for (const tc of cases.filter(c => pending.has(c.caseId) && !searches(c))) { current = null; record(await scoreOne(tc, {})); }
    const searchedPending = views.filter(v => v.searched && cases.some(c => pending.has(c.caseId) && searches(c) && v.id === viewId(c.userId ?? USER_ID, scopeOf(c.scope[0]))));
    if (searchedPending.length) {
      for (const rep of ingestReports.filter(r => !r.view.searched)) rep.ingest = (await ingestView(rep.view, rep.ns)).ingest;
      for (const rep of ingestReports.filter(r => searchedPending.includes(r.view))) {
        if (paid?.guard.exhausted) break;
        const { ingest, importError } = await ingestView(rep.view, rep.ns);
        rep.ingest = ingest;
        const conv = corpus.conversations.find(c => c.id === rep.view.id)!;
        const queryTime = conv.sessions.map(s => s.date!).sort().pop() ?? null;
        const ingested = new Set(conv.sessions.map(s => sanitizer.source(conv.id, s.id)));
        for (const tc of cases.filter(c => pending.has(c.caseId) && searches(c) && viewId(c.userId ?? USER_ID, scopeOf(c.scope[0])) === rep.view.id)) {
          if (importError) {
            const f = importError.startsWith('budget:') ? { outcome: 'budget_not_run' as const, error_origin: 'harness' as const, error_kind: 'budget' }
              : invalidReasons.length ? { outcome: 'harness_invalid' as const, error_origin: 'harness' as const, error_kind: 'sanitizer' }
              : { outcome: 'retrieval_error' as const, error_origin: 'sut' as const, error_kind: 'ingest' };
            record(rowOf(tc, missEntry(tc, pinnedInSeed, `ingest failed: ${importError}`), { ...f, error: `ingest failed: ${importError}`, ingest }));
            continue;
          }
          current = { caseId: tc.caseId, user: rep.view.user, scope: rep.view.scope, ns: rep.ns, queryTime, ingested };
          const row = await scoreOne(tc, { system_called: true, ingest });
          record(row.outcome === 'scored' && ingest.degraded ? { ...row, outcome: 'ingest_degraded' } : row);
          current = null;
        }
      }
    }
  } finally {
    try { await system.close?.(); } catch { /* ignore */ }
    cache?.close();
  }

  const fidelity = system instanceof GbrainShootoutSystem ? system.fidelity : null;
  if (fidelity && a.embed === 'real' && fidelity.embedding_deferred_pages > 0) invalidReasons.push(`${fidelity.embedding_deferred_pages} pages were saved without vectors (embedding_deferred), so vector retrieval was not what ran`);
  let cost: Record<string, unknown> | null = null;
  if (paid) { const summary = paid.run.close(); paid.guard.uninstall(); cost = receiptCost(summary) as unknown as Record<string, unknown>; }

  const canon = canonicalize(manifest, readAttempts(a.output), a.maxAttempts);
  writeCanonical(a.output, canon);
  if (canon.foreign.length) invalidReasons.push(`${canon.foreign.length} attempted ids are not in the frozen manifest`);
  const rows = canon.rows as unknown as PmbRow[];
  const entries: ReportEntry[] = rows.map(r => ({ caseId: r.case_id, category: r.category, description: r.description, pinnedBeliefs: r.pinned_ids, relevantBeliefs: r.returned_ids, retrievedQuestions: r.question_ids,
    retrievalPrecision: r.scorer_metrics ? r.scorer_metrics.precision : r.precision, retrievalRecall: r.scorer_metrics ? r.scorer_metrics.recall : r.recall, pinnedCoverage: r.pinned_coverage, passed: r.passed, failures: r.failures, retrievalLatencyMs: r.scorer_latency_ms }));
  const providerLabel = `${capabilities.system}${identity?.config && typeof identity.config === 'string' ? `-${identity.config}` : ''}`;
  const report = buildReportPayload({ provider: providerLabel, entries, caseCount: entries.length }, entries);
  writeFileSync(join(a.output, 'report.json'), JSON.stringify({ ...report, contract: CONTRACT, note: 'upstream report shape over the canonical rows; failed system calls are scored misses, harness failures included as recorded (see receipt.json for the counted families)' }, null, 2) + '\n');

  const called = rows.filter(r => r.system_called && (r.outcome === 'scored' || r.outcome === 'ingest_degraded') && typeof r.latency_ms === 'number');
  const harnessFailures = canon.outcomes.filter(o => HARNESS_FAILURES.has(o.outcome)).length;
  const retrievalUsd = rows.reduce((s, r) => s + (r.provider?.usd ?? 0), 0);
  const blind = provenanceBlind(rows);
  const byCategory = [...new Set(rows.map(r => r.category))].map(category => ({ category, family: familyOf(category), ...familySummary(rows.filter(r => r.category === category), blind) }));
  const partial = cases.length < allCases.length;
  const runStatus = invalidReasons.length ? 'invalid' : canon.missing.length ? 'partial' : partial ? 'partial' : 'complete';
  const receipt = {
    kind: 'precisionmembench-system', schema_version: 1, benchmark: 'precisionmembench', contract: CONTRACT,
    started_at: started, finished_at: new Date().toISOString(), run_status: runStatus, invalid_reasons: invalidReasons, run_config_hash: hash,
    upstream: { repo: 'tenurehq/precisionmembench', commit: UPSTREAM_COMMIT, fixture_sha256: fixtureSha, scorer_sha256: scorerSha },
    evaluator: 'vendored BaseAdapter.buildContext and scoreCases, unchanged: persona, pinned facts, open questions, relation expansion and the budget come from the shared evaluator; only searchText calls the system (eval/precisionmembench/systemAdapter.ts)',
    ingestion: { unit: 'one session per belief, one user turn with upstream\'s /add text (BaseAdapter.beliefToText)', superseded: 'seeded live; no supersession field crosses',
      event_time: `synthetic and disclosed: ${TIME_ANCHOR} plus one minute per fixture index (arrival order), never the belief's own dates`, query_time: 'the namespace\'s last event time',
      namespaces: 'one per (user, scope) a case searches: that user\'s beliefs of that scope plus the user\'s universal beliefs; a belief no searched namespace holds gets its owner\'s own namespace' },
    belief_mapping: 'distinct cited sources in first-appearance order over items in rank order, whole items, cut at the case limit (maxBeliefs, default 20); one source is one belief of that namespace; items with provenance unavailable cite nothing; a retrieval whose items all lack provenance is not measurable',
    families: { 'search-only': 'every category the vendored scorer does not list as structural (the S3 headline)', structural: 'the scorer\'s STRUCTURAL_CATEGORIES, reported separately' },
    selection: { cases_expected: manifest.expected.length, full_case_count: allCases.length, limit: a.limit, partial },
    system: { name: system.name, capability_system: capabilities.system, identity, capabilities },
    policy: { name: policy.name, mode: policy.mode, settings: policy.settings, settings_source: knobs.source },
    product: a.system === 'gbrain-shootout' ? productIdentityFor(gut) : null, overlay: a.system === 'gbrain-shootout' && gut.overlay ? { ...overlaySummary(gut), requested: gut.overlay.requested.split(homedir()).join('~') } : null,
    gbrain_config: a.system === 'gbrain-shootout' ? a.config : null,
    embedding: a.system === 'gbrain-shootout' ? { mode: a.embed, model: a.embeddingModel, dims: a.embeddingDims, cache_stats: cache ? { ...cache.stats } : null } : null,
    fidelity, cost,
    metering: a.providerProxy ? { mode: 'lease-proxy', proxy: a.providerProxy, slot, lease_id: process.env.SHOOTOUT_LEASE_ID ?? null, retry_upstream_5xx: a.retryUpstream5xx } : { mode: paid ? 'budget-ledger' : 'none' },
    sanitizer: { forbidden_markers: markers.length },
    ingest: { ...ingestTotals, usd: round4(ingestTotals.usd) },
    namespaces: ingestReports.map(r => ({ ns: r.ns, user: r.view.user, scope: r.view.scope, beliefs: r.view.beliefs.length, searched: r.view.searched, ingest: r.ingest })),
    costs: { ingest_usd: round4(ingestTotals.usd), retrieval_usd: round4(retrievalUsd), total_usd: round4(ingestTotals.usd + retrievalUsd), source: ctl ? 'metering proxy' : paid ? 'budget ledger (see cost)' : 'not metered' },
    latency: { system_calls: called.length, p50_ms: called.length ? percentile(called.map(r => r.latency_ms!), 50) : null, p95_ms: called.length ? percentile(called.map(r => r.latency_ms!), 95) : null },
    outcomes: canon.counts, attempts_this_run: attempts, comparison_complete: canon.missing.length === 0 && harnessFailures === 0 && !partial,
    summary: { 'search-only': familySummary(rows.filter(r => r.family === 'search-only'), blind), structural: familySummary(rows.filter(r => r.family === 'structural'), blind), all: familySummary(rows, blind), categories: byCategory,
      upstream: report.retrieval },
    files: { manifest: 'manifest.json', attempts: 'attempts.ndjson', outcomes: 'outcomes.ndjson', rows: 'rows.ndjson', report: 'report.json' },
  };
  writeFileSync(join(a.output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, rows };
}

if (import.meta.main) {
  const a = parsePmbArgs(process.argv.slice(2));
  const { receipt } = await runPmb(a);
  const s = (receipt.summary as Record<string, ReturnType<typeof familySummary>>)['search-only'];
  process.stderr.write(`[precisionmembench-system] ${receipt.run_status}: search-only precision ${s.mean_precision ?? 'n/a'} (n=${s.n_precision}), recall ${s.mean_recall ?? 'n/a'} (n=${s.n_recall}), outcomes ${JSON.stringify(receipt.outcomes)}; receipt ${join(a.output, 'receipt.json')}\n`);
  process.exit(receipt.run_status === 'invalid' ? 4 : 0);
}
