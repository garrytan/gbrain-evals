/**
 * Q1 cell runner (PLAN §4.3, §4.8 contracts 3, 7, 8, 10 and 12; preregistration
 * docs/benchmarks/2026-10-06-scoreboard-preregistration.md).
 *
 *   bun eval/runner/q1/cell.ts plan [--json] [--campaign-out <q1 campaign manifest.json>] [--with-smoke]
 *   bun eval/runner/q1/cell.ts show --cell <id> [--json]
 *   bun eval/runner/q1/cell.ts run --cell <id> [--paid --budget-run-id <id>] [--limit N] [--out <dir>] [--arms a,b]
 *     [--shard i/n] [--system-url <shim URL>] [--provider-proxy <url>] [--aggregates <file>] [--max-attempts 3]
 *     [--no-frontier] [--finish-timeout-s 600] [--probe-timeout-s 900]
 *   bun eval/runner/q1/cell.ts merge --cell <id> --from <out dir>... --out <dir>
 *
 * A cell (eval/runner/q1/cells/definitions.ts) is one system x configuration
 * x set. The runner:
 *
 *   1. ingests each conversation once as an immutable realization, id
 *      sha256(cell | conversation | attempt), with ingest timing (wall, per
 *      session write, finish wait) and write-start-to-queryable probes: the
 *      last session plus a seeded sample of 20 sessions, each timed from the
 *      start of its write to the first fixed-evidence retrieval that returns
 *      it (probes poll while later sessions are written). Every conversation
 *      of the shard is ingested before any question, then
 *      `$SHOOTOUT_OUT/ingest-complete` is written so the VM snapshots the
 *      store; with SHOOTOUT_RESTORED_REALIZATION set the restored store is
 *      used and nothing is re-ingested;
 *   2. retrieves once per question per policy the arms need (fixed-evidence
 *      for component arms, vendor-default for whole-system default arms);
 *   3. derives every arm: component arms pack the system's items into the
 *      arm's budget with readerCounter over the arm's readers, one frozen
 *      context per arm and question in contexts.ndjson that every reader
 *      reads byte for byte; whole-system arms read the system's default
 *      amount, ask an answering system (file agent, agent runtime) or read
 *      the whole history where it fits the reader's window;
 *   4. reads with each reader at effort medium (plus per-reader replicates),
 *      judges every answer with the benchmark's canonical instrument
 *      (judge_replicate 0) and, where the arm says so, with the frontier
 *      judges under their own instrument ids (`<instrument>@<judge>`);
 *   5. publishes `cells/<arm cell_id>/` exactly as eval/runner/scoreboard.ts
 *      reads it: receipt.json, run-config.json (config_sha256 is its
 *      sha256), rows.ndjson, answers.ndjson, judgments.ndjson, plus
 *      readiness.ndjson for eval/runner/cost-speed.ts.
 *
 * Resume (contract 8): staging lives under `runs/<cell id>/`, one directory
 * per realization. Answers and judgments are immutable logs; a reader or
 * judge call that already has a record is never repeated. Work that needs the
 * system's store (a retrieval, an agent answer, a full-context read) runs only
 * on a realization this process ingested or restored; otherwise the old
 * realization is invalidated and the whole conversation is ingested again, so
 * a conversation is never partly re-ingested and no arm mixes realizations.
 * Packed answers and judgments resume from staged retrievals without the
 * store. Row attempts are appended to `attempts.ndjson` every 20 questions
 * (the VM checkpoints on that count) and the published files are rewritten
 * at every flush.
 *
 * Metering (with a lease proxy, SHOOTOUT_PROXY or --provider-proxy): provider
 * keys become SHOOTOUT_CELL_TOKEN (or a dummy), the system's calls run on its
 * slot with proxy phases `commit` (each /ingest), `background` (last ingest
 * to finish ready) and `query` (retrieval); readers run on the `harness` slot
 * and judges on the `judge` slot, so judge spend and its output cap are apart
 * from answers. Without a proxy the run needs `--paid --budget-run-id`
 * (eval/runner/paid-arm.ts) and the budget ledger guards every call.
 *
 * Custody (contract 10): a cell whose split is sealed (or all, on a benchmark
 * with sealed conversations) needs GBRAIN_EVALS_CUSTODY_LOG and an output
 * directory outside the repository, as eval/runner/memory-qa/sealed-profile.ts
 * enforces; the opening is logged before the corpus loads, and `--aggregates`
 * writes the only file that may land inside the repository (allowlisted
 * counts, means and timings).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { cachedOpenAIEmbedder, PG_EMBED_DIMS } from '../cat40/pg-arm.ts';
import { DecideError, renderOperatorMessage } from '../decisions/errors.ts';
import { loadSplit } from '../decisions/splits.ts';
import { ndcgAtK, percentile, recallAllAtK, recallAnyAtK } from '../metrics.ts';
import { DEFAULT_ROUTE_CAPS, ProxyControl, upstreamTrouble, type Meter, type Phase } from '../metering-proxy.ts';
import { loadCorpus, type Corpus, type MemoryQuestion } from '../memory-qa/corpus.ts';
import { ContextStore } from '../memory-qa/arms.ts';
import { instrumentFor, type Instrument } from '../memory-qa/instruments.ts';
import { DEFAULT_MAX_ATTEMPTS, type Outcome } from '../memory-qa/outcomes.ts';
import { ChatClient, judgeAnswer, READER_TEMPLATE, type ChatLike } from '../memory-qa/qa.ts';
import { answerId, answerRecord, judgmentKey, readRecords, RecordLog, sha256, type AnswerRecord, type JudgmentRecord, type Q1Row } from '../memory-qa/records.ts';
import { failureRow, hashEmbed, readinessProbe, selectQuestions } from '../memory-qa/run.ts';
import { checkSealedDestinations, sealedPaths } from '../memory-qa/sealed-profile.ts';
import { PaidArmRefusal, requirePaidArm } from '../paid-arm.ts';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';
import { DEFAULT_ROUTE_CLASSES, type CampaignManifest as Q1Campaign, type CellSpec } from '../shootout-cell.ts';
import { AgentRuntimeSystem } from '../systems/agent-runtime.ts';
import { answerFullContext, FullContextSystem, NoMemorySystem, PlainHybridSystem, type FitTokenizer } from '../systems/baselines.ts';
import { FILE_AGENT_SYSTEM, FileAgentSystem, type AnsweringSystem } from '../systems/file-agent.ts';
import { HttpMemorySystem } from '../systems/http.ts';
import { encodingCount, NATIVE_READER_TEMPLATE, packContext, readerCounter, readerTokenizer, RENDERER_VERSION, strictSources, validateSources, type PackCounter, type PackedContext } from '../systems/render.ts';
import { Sanitizer, SanitizerLeakError } from '../systems/sanitize.ts';
import { answerModes, passiveUnsupported, policyKnobs, type CapabilityRecord, type Item, type MemorySystem, type OwnAnswerSystem, type RetrievalPolicy, type SessionInput } from '../systems/types.ts';
import { definitionProblems, launchPrefix, loadManifest, MANIFEST_PATH, SETS, shimLaunch, type ArmDefinition, type CellDefinition, type Manifest, type Selection } from './cells/definitions.ts';
import { hedgeStamp } from './hedge.ts';
import { exitCodeOf, refuse, renderMessage, ScoreboardError, type ScoreboardMessage } from './scoreboard-errors.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const RUN_CONFIG_SCHEMA = 'gbrain-evals/q1-run-config/v1';
export const CELL_RECEIPT_SCHEMA = 'gbrain-evals/q1-cell-receipt/v1';
export const ROW_FLUSH_EVERY = 20;
const FRONT = ['bun', 'eval/runner/q1/cell.ts'];
/** Outcomes a resume never retries (eval/runner/memory-qa/outcomes.ts); every other outcome retries up to the attempt limit. */
const FINAL: ReadonlySet<Outcome> = new Set(['scored', 'unsupported', 'ingest_degraded', 'turn_cap', 'context_overflow', 'does_not_fit']);
const JUDGED: ReadonlySet<Outcome> = new Set(['scored', 'ingest_degraded']);
const READER_MAX_TOKENS = 2048;

const kindsSet = () => new Set((JSON.parse(readFileSync(join(REPO_ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
const rel = (p: string) => relative(REPO_ROOT, p) || '.';
const writeAtomic = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };
const readLines = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } }) : [];
const hashKey = (seed: string, id: string) => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');
const pct = (xs: number[], p: number) => xs.length ? Math.round(percentile(xs, p) * 10) / 10 : null;

// ─── Identity ────────────────────────────────────────────────────────

export const realizationId = (cellId: string, conversation: string, attempt: number) => sha256(`${cellId}|${conversation}|${attempt}`);
export const frontierInstrumentId = (instrument: string, judge: string) => `${instrument}@${judge}`;
export const contextKey = (realization: string, questionId: string, armId: string) => `${realization}|${questionId}|${armId}`;

// ─── Selection ───────────────────────────────────────────────────────

/** Round-robin over strata, each stratum in sha256(seed, id) order, until `limit`. */
function roundRobin(strata: Map<string, MemoryQuestion[]>, limit: number, seed: string): MemoryQuestion[] {
  for (const list of strata.values()) list.sort((a, b) => (hashKey(seed, a.id) < hashKey(seed, b.id) ? -1 : 1));
  const keys = [...strata.keys()].sort();
  const out: MemoryQuestion[] = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const k of keys) { const q = strata.get(k)![round]; if (q && out.length < limit) { out.push(q); added = true; } }
    if (!added) break;
  }
  return out;
}

const groupBy = (qs: readonly MemoryQuestion[], key: (q: MemoryQuestion) => string) => { const m = new Map<string, MemoryQuestion[]>(); for (const q of qs) m.set(key(q), [...(m.get(key(q)) ?? []), q]); return m; };

/** The questions a selection recipe picks, in a deterministic order (conversation, then id). */
export function selectCellQuestions(questions: readonly MemoryQuestion[], sel: Selection): MemoryQuestion[] {
  const order = (qs: MemoryQuestion[]) => [...qs].sort((a, b) => (a.conversation === b.conversation ? (a.id < b.id ? -1 : 1) : a.conversation < b.conversation ? -1 : 1));
  if (sel.kind === 'all') return order([...questions]);
  if (sel.kind === 'shootout-slice') return order(selectQuestions([...questions], sel.limit, sel.seed));
  if (sel.kind === 'per-conversation') return order([...groupBy(questions, q => q.conversation).values()].flatMap(qs => roundRobin(groupBy(qs, q => q.category), sel.per_conversation, sel.seed)));
  const floor: MemoryQuestion[] = [];
  for (const [cat, n] of Object.entries(sel.min ?? {})) floor.push(...roundRobin(groupBy(questions.filter(q => q.category === cat), q => q.conversation), n, sel.seed));
  const taken = new Set(floor.map(q => q.id));
  const rest = questions.filter(q => !taken.has(q.id));
  const strata = sel.stratify === 'category' ? groupBy(rest, q => q.category) : groupBy(rest, q => `${q.conversation}\u0000${q.category}`);
  if (sel.stratify === 'conversation-category') {
    const byConv = groupBy(rest, q => q.conversation);
    const convs = [...byConv.keys()].sort();
    const per = new Map(convs.map(c => [c, roundRobin(groupBy(byConv.get(c)!, q => q.category), Infinity, sel.seed)]));
    const out: MemoryQuestion[] = [];
    for (let round = 0; out.length < sel.limit - floor.length; round++) {
      let added = false;
      for (const c of convs) { const q = per.get(c)![round]; if (q && out.length < sel.limit - floor.length) { out.push(q); added = true; } }
      if (!added) break;
    }
    return order([...floor, ...out]);
  }
  return order([...floor, ...roundRobin(strata, sel.limit - floor.length, sel.seed)]);
}

/** The conversations a split admits for a benchmark: `all` is dev and sealed together; LongMemEval-M and fixtures have no split file. */
export function splitConversations(benchmark: string, split: CellDefinition['split'], corpus: Corpus): Set<string> {
  if (benchmark === 'lme-m' || benchmark === 'fixture' || corpus.benchmark === 'fixture') return new Set(corpus.conversations.map(c => c.id));
  const s = loadSplit(benchmark);
  return new Set(split === 'dev' ? s.dev : split === 'sealed' ? s.sealed : [...s.dev, ...s.sealed]);
}

export function needsCustody(def: Pick<CellDefinition, 'benchmark' | 'split'>): boolean {
  if (def.split === 'dev' || def.benchmark === 'lme-m') return false;
  try { return loadSplit(def.benchmark).sealed.length > 0; } catch { return true; }
}

// ─── Dependencies and options ────────────────────────────────────────

export interface CellOptions {
  out: string;
  limit?: number | null;
  /** Run only these arms (by arm id). */
  arms?: string[] | null;
  shard?: { index: number; count: number };
  maxAttempts?: number;
  /** Frontier judges where the definition asks for them (default on). */
  frontier?: boolean;
  systemUrl?: string | null;
  providerProxy?: string | null;
  finishTimeoutS?: number;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  /** Keyless baseline-hybrid: hash vectors instead of OpenAI embeddings. */
  embed?: 'hash' | 'real';
  /** How long questions wait for the launcher's store snapshot after ingest (default 4 hours); the snapshot stops the stack. */
  snapshotTimeoutMs?: number;
  /** Test hook: stop (as if killed) after this many questions have been processed. */
  stopAfterQuestions?: number;
  env?: Record<string, string | undefined>;
}

export interface CellDeps {
  corpus?: Corpus;
  system?: MemorySystem;
  reader?: ChatLike;
  judge?: ChatLike;
  /** Full-context reads: the provider fetch (a stub in keyless tests). */
  fullContextFetch?: typeof fetch;
  /** Full-context fit check tokenizer per reader (default: the reader's local encoding times its calibration). */
  fitTokenizer?: (reader: string) => FitTokenizer;
}

export interface ArmResult { cell_id: string; dir: string; status: 'complete' | 'partial' | 'invalid'; config_sha256: string; answers: number; judgments: number; rows: number; readers: string[] }
export interface CellResult { cell: string; out: string; status: 'complete' | 'partial' | 'invalid'; arms: ArmResult[]; stopped: string | null; invalid_reasons: string[] }

// ─── Staging ─────────────────────────────────────────────────────────

interface RealizationEvent {
  realization_id: string; conversation: string; attempt: number; event: 'started' | 'ingested' | 'invalidated'; at: string;
  reason?: string; restored_from?: string; ingest?: IngestSummary; probes?: ProbeRecord[];
}
export interface IngestSummary {
  sessions: number; failed_sessions: number; synthetic_times: number; messages: number; ingested_tokens: number;
  wall_ms: number; write_ms: { p50: number | null; p95: number | null; total: number }; finish: { ready: boolean; waited_ms: number; completeness: string };
  readiness_probe: string; degraded: boolean; errors: Array<{ source_id: string; kind: string; message: string }>;
}
export interface ProbeRecord { realization_id: string; source_id: string; kind: 'last' | 'sample'; status: 'found' | 'missed' | 'not-measurable'; write_start_to_queryable_ms: number | null; polls: number }
interface StagedRetrieval {
  key: string; question_id: string; policy: string; attempt: number; outcome: Outcome; error?: string; error_kind?: string;
  items: Item[]; applied_settings: Record<string, unknown>; truncated: boolean; latency_ms: number | null; harness_ms: number; query_time: string | null; at: string;
}
interface MeterLine { phase: 'ingest' | 'retrieval' | 'reader' | 'judge'; key: string; usd: number; requests: number; unpriced: number }

class Staging {
  readonly root: string;
  constructor(out: string, readonly cellId: string) { this.root = join(out, 'runs', cellId); mkdirSync(this.root, { recursive: true }); }
  get eventsPath() { return join(this.root, 'realizations.ndjson'); }
  events(): RealizationEvent[] { return readLines<RealizationEvent>(this.eventsPath); }
  event(e: RealizationEvent) { appendFileSync(this.eventsPath, JSON.stringify(e) + '\n'); }
  /** The latest realization of a conversation and its state. */
  latest(conversation: string): { id: string; attempt: number; state: 'started' | 'ingested' | 'invalidated'; ingest?: IngestSummary; probes?: ProbeRecord[]; restored_from?: string } | null {
    const evs = this.events().filter(e => e.conversation === conversation);
    if (!evs.length) return null;
    const last = evs[evs.length - 1];
    const ingested = evs.find(e => e.realization_id === last.realization_id && e.event === 'ingested');
    return { id: last.realization_id, attempt: last.attempt, state: last.event, ingest: ingested?.ingest, probes: ingested?.probes, restored_from: ingested?.restored_from };
  }
  dir(rid: string) { const d = join(this.root, 'r', rid); mkdirSync(d, { recursive: true }); return d; }
  meters(): MeterLine[] { return readLines<MeterLine>(join(this.root, 'meters.ndjson')); }
  meter(m: MeterLine) { appendFileSync(join(this.root, 'meters.ndjson'), JSON.stringify(m) + '\n'); }
}

/** Latest record per key from an append-only log. */
function latestBy<T>(path: string, key: (x: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of readLines<T>(path)) m.set(key(x), x);
  return m;
}

// ─── Counters and readers ────────────────────────────────────────────

/** The same counter, with long texts measured once (a whole history repeats across one conversation's questions). */
function memoCounter(c: PackCounter): PackCounter {
  const cache = new Map<string, number[]>();
  return { ...c, measure: (text: string) => {
    if (text.length < 8192) return c.measure(text);
    const k = sha256(text);
    let v = cache.get(k);
    if (!v) { v = c.measure(text); cache.set(k, v); }
    return v;
  } };
}

const fitCache = new Map<string, number>();
/** A reader's local encoding times its calibration, memoized: the fit check counts each conversation's history once. */
export function readerFitTokenizer(reader: string): FitTokenizer {
  const t = readerTokenizer(reader);
  return { id: `${t.encoding}x${t.calibration}`, count: text => {
    const k = `${t.encoding}|${sha256(text)}`;
    let n = fitCache.get(k);
    if (n === undefined) { n = encodingCount(t.encoding, text); fitCache.set(k, n); }
    return Math.ceil(n * t.calibration);
  } };
}

// ─── Metering ────────────────────────────────────────────────────────

interface Metering {
  slotEnv<T>(slot: string, fn: () => Promise<T>): Promise<T>;
  around<T>(slot: string, key: string, phase: MeterLine['phase'], fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; meter: Meter | null }>;
  phase(slot: string, phase: Phase | null): Promise<void>;
}

function metering(proxy: string | null, staging: Staging, env: Record<string, string | undefined>): Metering {
  if (!proxy) return {
    slotEnv: (_slot, fn) => fn(),
    async around(_slot, _key, _phase, fn) { try { return { value: await fn(), meter: null }; } catch (error) { return { error, meter: null }; } },
    async phase() {},
  };
  const ctl = new ProxyControl(proxy);
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) env[k] = env.SHOOTOUT_CELL_TOKEN || 'dummy-key-the-proxy-replaces';
  const slotEnv = async <T>(slot: string, fn: () => Promise<T>): Promise<T> => {
    const prior = { o: env.OPENAI_BASE_URL, a: env.ANTHROPIC_BASE_URL, v: env.VOYAGE_BASE_URL };
    env.OPENAI_BASE_URL = `${proxy}/${slot}/openai/v1`; env.ANTHROPIC_BASE_URL = `${proxy}/${slot}/anthropic`; env.VOYAGE_BASE_URL = `${proxy}/${slot}/voyage/v1`;
    try { return await fn(); } finally { env.OPENAI_BASE_URL = prior.o; env.ANTHROPIC_BASE_URL = prior.a; env.VOYAGE_BASE_URL = prior.v; }
  };
  return {
    slotEnv,
    async around(slot, key, phase, fn) {
      const r = await ctl.around(slot, key, () => slotEnv(slot, fn));
      staging.meter({ phase, key, usd: r.meter.usd, requests: r.meter.requests, unpriced: r.meter.unpriced });
      return r;
    },
    async phase(slot, phase) { await ctl.phase(slot, phase); },
  };
}

/** A ChatLike whose calls go out on a proxy slot (readers on `harness`, judges on `judge`). */
const onSlot = (chat: ChatLike, m: Metering, slot: string): ChatLike => ({ chat: (model, prompt, opts) => m.slotEnv(slot, () => chat.chat(model, prompt, opts)) });

// ─── Systems ─────────────────────────────────────────────────────────

/** The system a definition names: a protocol v1 shim at --system-url, or the in-process control or answering system. */
export function systemFor(def: CellDefinition, opts: CellOptions, sanitizer: Sanitizer): MemorySystem {
  if (def.runner === 'shim') {
    if (!opts.systemUrl) throw refuse({ code: 'NOT_YET_AVAILABLE', message: `cell ${def.id} runs ${def.system} as a protocol v1 shim, and no --system-url was given`,
      why: 'shim systems run in their own container behind the protocol; the runner talks to the shim the cell command started',
      fix: { next: 'run', argv: ['bash', 'eval/systems/bootstrap.sh', 'up', '--system', def.system, '--config', def.configuration === 'common' ? 'common' : 'recipe'], user_message: `then rerun with --system-url http://127.0.0.1:8700`, verify: ['curl', '-s', 'http://127.0.0.1:8700/health'] } });
    return new HttpMemorySystem(opts.systemUrl, { name: def.system, markers: sanitizer.markers });
  }
  switch (def.system) {
    case 'baseline-full-context': return new FullContextSystem('whole-history');
    case 'baseline-recency': return new FullContextSystem('recency');
    case 'baseline-none': return new NoMemorySystem();
    case 'baseline-hybrid': return new PlainHybridSystem(opts.embed === 'hash' ? async texts => texts.map(t => hashEmbed(t, PG_EMBED_DIMS))
      : cachedOpenAIEmbedder(join(process.env.GBRAIN_EVALS_EMBED_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'embed-cache'), 'plain-hybrid-te3l-1536.json'), fetch, opts.providerProxy ? `${opts.providerProxy}/${def.system}/openai/v1` : undefined), opts.embed === 'hash' ? `hash@${PG_EMBED_DIMS} (keyless control)` : undefined);
    case 'baseline-file-agent': return new FileAgentSystem({ workDir: join(opts.out, 'runs', def.id, 'file-agent'), effort: def.effort });
    case 'ext-agent-runtime': return new AgentRuntimeSystem();
    default: throw refuse({ code: 'NOT_YET_AVAILABLE', message: `no in-process system for ${def.system}`, why: 'only harness controls and answering systems run in process', fix: { next: 'report', user_message: `check ${def.id}'s runner in eval/runner/q1/cells/definitions.ts` } });
  }
}

const isAnswering = (s: MemorySystem): s is AnsweringSystem => typeof (s as Partial<AnsweringSystem>).answer === 'function';

/** The model a system's own-answer mode answers with when the request names none (capabilities `answer.models`). */
const ownModel = (cap: CapabilityRecord, mode: string): string | null => {
  const m: unknown = cap.answer?.models?.[mode];
  return typeof m === 'string' && m ? m : null;
};

/**
 * The readers an arm's answers are recorded under. An own-answer arm's `system-default` reader is the system's own
 * configured model, recorded as `own:<resolved model>` (gbrain `synthesize`: gbrain's `models.think`); every other
 * reader (gbrain `think` with each frontier reader as `model`) is itself.
 */
export function armReaders(arm: ArmDefinition, cap: CapabilityRecord): string[] {
  if (arm.mode !== 'own-answer') return arm.readers;
  return arm.readers.map(r => (r === 'system-default' ? `own:${ownModel(cap, arm.variant!) ?? 'unresolved'}` : r));
}

// ─── Run config ──────────────────────────────────────────────────────

const PROMPTS: Record<string, string> = { native: NATIVE_READER_TEMPLATE, rehydrated: READER_TEMPLATE, agent: FILE_AGENT_SYSTEM };

/** The arm's configuration identity, deterministic: the scoreboard's config_sha256 is the sha256 of these bytes. */
export function runConfigText(def: CellDefinition, arm: ArmDefinition, ctx: { instrument: Instrument; dataset: Corpus['source']; scheduledSha: string; limit: number | null }): string {
  const { estimate: _e, arms: _a, ...cell } = def;
  const counter = arm.mode === 'packed' || arm.mode === 'native-default' ? readerCounter(arm.readers).identity : arm.mode === 'full-context' ? arm.readers.map(r => ({ reader: r, ...readerTokenizer(r) })) : null;
  const prompt = arm.mode === 'full-context' ? PROMPTS.rehydrated : arm.mode === 'agent' && def.system === 'baseline-file-agent' ? PROMPTS.agent : arm.mode === 'packed' || arm.mode === 'native-default' ? PROMPTS.native : null;
  return JSON.stringify({
    schema: RUN_CONFIG_SCHEMA, cell_id: arm.cell_id, run_cell: def.id, cell, arm,
    instrument: { id: ctx.instrument.id, sha256: ctx.instrument.sha256, judge: ctx.instrument.canonical_judge },
    reader: { effort: def.effort, max_tokens: READER_MAX_TOKENS, prompt_sha256: prompt ? sha256(prompt) : null },
    renderer: RENDERER_VERSION, counter, dataset: ctx.dataset, scheduled_sha256: ctx.scheduledSha, limit: ctx.limit,
  }, null, 2) + '\n';
}

// ─── Probes ──────────────────────────────────────────────────────────

/** The probe set of one conversation: the last session plus `sample` others, seeded (all of them when there are fewer). */
export function probeSample(plan: ReadonlyArray<{ input: SessionInput }>, sample: number, seed: string): Map<number, 'last' | 'sample'> {
  const out = new Map<number, 'last' | 'sample'>();
  if (!plan.length) return out;
  out.set(plan.length - 1, 'last');
  const rest = plan.map((p, i) => ({ i, k: hashKey(seed, p.input.source_id) })).filter(x => x.i !== plan.length - 1).sort((a, b) => (a.k < b.k ? -1 : 1)).slice(0, sample);
  for (const x of rest) out.set(x.i, 'sample');
  return out;
}

const probeable = (cap: CapabilityRecord) => cap.retrieval_metrics !== 'not-applicable' && cap.provenance?.status !== 'unavailable' && !passiveUnsupported(cap)
  && (cap.retrieval_policies?.['fixed-evidence'] as { supported?: boolean } | undefined)?.supported !== false;

const passageOf = (s: SessionInput) => [...s.turns].sort((x, y) => y.content.length - x.content.length)[0]?.content.slice(0, 300) ?? '';

// ─── Rows ────────────────────────────────────────────────────────────

const PROVENANCE_ORDER = ['exact', 'partial', 'unavailable'] as const;
const weakest = (items: readonly Item[]): Q1Row['provenance_status'] => items.length ? PROVENANCE_ORDER[Math.max(...items.map(i => PROVENANCE_ORDER.indexOf(i.provenance_status)))] : 'none';

// ─── The run ─────────────────────────────────────────────────────────

/**
 * The launcher (shootout-cell.ts runRemote) snapshots a shim cell's store when ingest-complete appears, and the snapshot
 * stops the stack (bootstrap.sh snapshot). Questions wait for its realization record, written after the snapshot
 * command exits and the stack is healthy again, so no retrieval meets a stopped system. A failed snapshot is recorded
 * by the launcher and the cell goes on; a snapshot that never finishes is refused.
 */
async function awaitSnapshot(path: string, since: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(existsSync(path) && statSync(path).mtimeMs >= since - 1000)) {
    if (Date.now() > deadline) throw refuse({ code: 'NOT_YET_AVAILABLE', message: `no store snapshot at ${path} within ${Math.round(timeoutMs / 60_000)} minutes of ingest-complete`,
      why: 'a shim cell\'s questions run only after the launcher has snapshotted the ingested store (the snapshot stops the stack)', fix: { next: 'report', user_message: 'check the snapshot command in the cell log (bash eval/systems/bootstrap.sh snapshot)' } });
    await Bun.sleep(2000);
  }
}

export async function runCell(def: CellDefinition, opts: CellOptions, deps: CellDeps = {}): Promise<CellResult> {
  const env = opts.env ?? process.env;
  const problems = definitionProblems(def, kindsSet());
  if (problems.length) throw refuse({ code: 'USAGE', message: `cell ${def.id} is not a valid definition: ${problems.slice(0, 4).join('; ')}`, why: 'the runner executes only definitions that pass the cell schema', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/cells/definitions.ts'], verify: [...FRONT, 'show', '--cell', def.id] } });
  const out = resolve(opts.out);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const arms = def.arms.filter(a => !opts.arms || opts.arms.includes(a.id));
  if (!arms.length) throw refuse({ code: 'USAGE', message: `--arms ${opts.arms?.join(',')} names no arm of ${def.id}`, why: 'a run needs at least one arm', fix: { next: 'run', argv: [...FRONT, 'show', '--cell', def.id] } });

  // Custody before anything reads the corpus.
  const custody = !deps.corpus && needsCustody(def);
  if (custody) {
    const log = env.GBRAIN_EVALS_CUSTODY_LOG;
    if (!log) throw refuse({ code: 'CUSTODY_REQUIRED', message: `cell ${def.id} opens sealed conversations (${def.benchmark}, split ${def.split}) and GBRAIN_EVALS_CUSTODY_LOG is not set`,
      why: 'sealed sets open only on the custodian\'s host, and every opening is logged before a question is read', fix: { next: 'ask_user', user_message: `ask the custodian to run ${def.id} on the custody host (decision q1-scoreboard)` } });
    try { checkSealedDestinations(sealedPaths(out, out)); }
    catch (e) { throw refuse({ code: 'SEALED_CELL_LOCAL', message: `cell ${def.id}: ${(e as Error).message}`, why: 'sealed rows, answers, contexts and caches stay inside a custody root outside the repository; only --aggregates may write inside it', fix: { next: 'run', argv: [...FRONT, 'run', '--cell', def.id, '--out', '<custody root outside the repository>'] } }); }
    appendAccessLog(log, { action: 'open', purpose: `q1 cell ${def.id}`, decision_id: env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', labels_sha256: 'public-split-file', run_sha256: null });
  }
  mkdirSync(out, { recursive: true });
  const corpus = deps.corpus ?? loadCorpus(def.benchmark);
  const allowed = splitConversations(def.benchmark, def.split, corpus);
  let selected = selectCellQuestions(corpus.questions.filter(q => allowed.has(q.conversation)), def.selection);
  if (opts.limit) selected = selectCellQuestions(selectQuestions(selected, opts.limit, 42), { kind: 'all' });
  const shard = opts.shard ?? { index: 0, count: 1 };
  const convIds = [...new Set(selected.map(q => q.conversation))].sort().filter((_, i) => i % shard.count === shard.index);
  const armQs = new Map(arms.map(a => [a.id, new Set((a.questions ? selectCellQuestions(selected, a.questions) : selected).map(q => q.id))]));
  const instrument = instrumentFor(def.canonical_instrument);
  const scheduledSha = sha256(selected.map(q => q.id).join('\n'));

  // Run configs: written once, refused when a resume would change them.
  const configs = new Map<string, { text: string; sha: string }>();
  for (const a of arms) {
    const text = runConfigText(def, a, { instrument, dataset: corpus.source, scheduledSha, limit: opts.limit ?? null });
    const path = join(out, 'cells', a.cell_id, 'run-config.json');
    if (existsSync(path) && readFileSync(path, 'utf8') !== text) throw refuse({ code: 'RESUME_REFUSED', message: `${rel(path)} holds a different configuration than this run (${a.cell_id})`,
      why: 'a counted cell runs exactly the configuration it froze; a changed configuration is a new cell identity', fix: { next: 'run', argv: [...FRONT, 'run', '--cell', def.id, '--out', '<a fresh directory>'] } });
    writeAtomic(path, text);
    configs.set(a.id, { text, sha: sha256(text) });
  }

  const staging = new Staging(out, def.id);
  const meter = metering(opts.providerProxy ?? null, staging, env);
  const sanitizer = new Sanitizer(corpus, `${def.id}|${def.ingest_replicate}`);
  const system = deps.system ?? systemFor(def, opts, sanitizer);
  const capabilities = await system.capabilities();
  const slot = def.runner === 'shim' ? capabilities.system : def.system;
  const policyFor = (mode: RetrievalPolicy['mode']): RetrievalPolicy => ({ name: `${capabilities.system}:${mode}`, mode, settings: policyKnobs(capabilities.retrieval_policies?.[mode]).settings });
  const ownArms = arms.filter(a => a.mode === 'own-answer');
  const agentArms = arms.filter(a => a.mode === 'agent');
  const modes = answerModes(capabilities);
  const unserved = ownArms.filter(a => typeof (system as Partial<OwnAnswerSystem>).answer !== 'function' || !modes.includes(a.variant!) || (a.readers.includes('system-default') && !ownModel(capabilities, a.variant!)));
  const noAgent = def.runner === 'shim' || !isAnswering(system) ? agentArms : [];
  if (unserved.length || noAgent.length) {
    const blocked = [...unserved, ...noAgent];
    const runnable = arms.filter(a => !blocked.includes(a)).map(a => a.id);
    const think = unserved.some(a => a.variant === 'think') && !modes.includes('think') && modes.includes('synthesize');
    const why = unserved.map(a => !modes.includes(a.variant!) ? `${a.id} needs answer mode ${a.variant} (the stack serves ${modes.length ? modes.join(', ') : 'no answer route'})` : `${a.id} records gbrain's own model, and capabilities answer.models.${a.variant} names none`)
      .concat(noAgent.map(a => `${a.id} needs an in-process answering system`));
    throw refuse({ code: 'NOT_YET_AVAILABLE', message: `cell ${def.id}: ${why.join('; ')}`,
      why: 'own-answer arms (gbrain synthesize and think, an external system\'s answer endpoint) are scored only through the system\'s own route (POST /answer, advertised in capabilities answer.modes), never emulated',
      fix: think ? { next: 'run', argv: ['bash', '-c', `GBRAIN_FULL_SURFACE=1 bash eval/systems/bootstrap.sh up --system ${def.system}`], user_message: `think is a full-surface op: restart the stack with GBRAIN_FULL_SURFACE=1, then rerun ${def.id}`, verify: ['curl', '-s', 'http://127.0.0.1:8700/capabilities'] }
        : runnable.length ? { next: 'run', argv: [...FRONT, 'run', '--cell', def.id, '--arms', runnable.join(',')], user_message: 'run the other arms now; the blocked arms wait for the system\'s answer route' } : { next: 'report', user_message: 'the cell waits for an answer route in the system\'s shim' } });
  }
  const readersOf = new Map(arms.map(a => [a.id, armReaders(a, capabilities)]));
  const chat = deps.reader ?? deps.judge ?? new ChatClient(custody ? join(out, 'cache', 'qa') : env.GBRAIN_EVALS_QA_CACHE ?? join(homedir(), '.cache', 'gbrain-evals', 'qa-cache'));
  const reader = onSlot(deps.reader ?? chat, meter, 'harness');
  const judge = onSlot(deps.judge ?? chat, meter, 'judge');
  const fitTokenizer = deps.fitTokenizer ?? readerFitTokenizer;
  const counters = new Map(arms.filter(a => a.readers.length && (a.mode === 'packed' || a.mode === 'native-default' || a.mode === 'full-context')).map(a => [a.id, memoCounter(readerCounter(a.readers))]));
  const contexts = new ContextStore(join(staging.root, 'contexts.ndjson'));
  const invalidReasons: string[] = [];
  const live = new Set<string>();
  const restored = env.SHOOTOUT_RESTORED_REALIZATION || null;
  const byConv = new Map(corpus.conversations.map(c => [c.id, c]));
  const qById = new Map(selected.map(q => [q.id, q]));
  const policies = [...new Set(arms.map(a => a.policy).filter((p): p is RetrievalPolicy['mode'] => !!p))];
  let stopped: string | null = null;
  let processed = 0;

  /** What a conversation still needs on a realization: store work (retrievals, agent answers, full-context reads) and any work at all. */
  const pendingOn = (rid: string, convId: string) => {
    const dir = staging.dir(rid);
    const retrievals = latestBy<StagedRetrieval>(join(dir, 'retrievals.ndjson'), r => r.key);
    const answers = new Set(readRecords(join(dir, 'answers.ndjson'), 'answer').map(a => a.answer_id));
    const qs = selected.filter(q => q.conversation === convId);
    let store = false, any = false;
    for (const q of qs) {
      for (const p of policies) {
        if (!arms.some(a => a.policy === p && armQs.get(a.id)!.has(q.id))) continue;
        const r = retrievals.get(`${q.id}|${p}`);
        if (!r || (!FINAL.has(r.outcome) && r.attempt < maxAttempts)) store = true;
      }
      for (const a of arms) {
        if (!armQs.get(a.id)!.has(q.id) || a.mode === 'retrieval-only') continue;
        for (const r of readersOf.get(a.id)!) for (let rep = 0; rep < (a.reader_replicates[r] ?? 1); rep++) {
          if (answers.has(answerId(a.cell_id, q.id, r, rep))) continue;
          any = true;
          if (a.mode === 'agent' || a.mode === 'own-answer' || a.mode === 'full-context') store = true;
        }
      }
    }
    return { store, any: any || store };
  };

  // ─── Phase 1: one realization per conversation ───
  const realizations = new Map<string, string>();
  try {
    for (const convId of convIds) {
      const prior = staging.latest(convId);
      if (prior?.state === 'ingested' && restored) {
        realizations.set(convId, prior.id); live.add(prior.id);
        continue;
      }
      if (prior?.state === 'ingested') {
        const need = pendingOn(prior.id, convId);
        if (!need.store || live.has(prior.id)) { realizations.set(convId, prior.id); continue; }
        staging.event({ realization_id: prior.id, conversation: convId, attempt: prior.attempt, event: 'invalidated', at: new Date().toISOString(), reason: 'the store behind this realization is gone (new process, no restored snapshot) and store work is pending; the whole conversation is ingested again' });
      } else if (prior?.state === 'started') {
        staging.event({ realization_id: prior.id, conversation: convId, attempt: prior.attempt, event: 'invalidated', at: new Date().toISOString(), reason: 'ingest was interrupted; a conversation is never partly re-ingested' });
      }
      const attempt = prior ? prior.attempt + 1 : 0;
      const rid = realizationId(def.id, convId, attempt);
      if (restored) {
        staging.event({ realization_id: rid, conversation: convId, attempt, event: 'started', at: new Date().toISOString() });
        staging.event({ realization_id: rid, conversation: convId, attempt, event: 'ingested', at: new Date().toISOString(), restored_from: restored });
        realizations.set(convId, rid); live.add(rid);
        continue;
      }
      const ingest = await ingestConversation(rid, convId, attempt);
      if (ingest === 'stopped') break;
      realizations.set(convId, rid); live.add(rid);
    }
    if (!stopped) {
      const shootoutOut = env.SHOOTOUT_OUT ? resolve(env.SHOOTOUT_OUT) : out;
      const marked = Date.now();
      writeFileSync(join(shootoutOut, 'ingest-complete'), JSON.stringify({ cell: def.id, realizations: Object.fromEntries(realizations), at: new Date().toISOString() }) + '\n');
      if (env.SHOOTOUT_SNAPSHOT_DIR && !restored && def.runner === 'shim') await awaitSnapshot(join(shootoutOut, 'realization', 'realization.json'), marked, opts.snapshotTimeoutMs ?? 4 * 3_600_000);
    }

    // ─── Phase 2: questions ───
    for (const convId of convIds) {
      const rid = realizations.get(convId);
      if (!rid || stopped) break;
      await runQuestions(rid, convId);
    }
  } finally {
    try { await system.close?.(); } catch { /* closing is best effort */ }
  }

  const armResults = publishCell(def, arms, [out], out, { instrument, selected, invalidReasons, configs, capabilities, stopped, maxAttempts });
  return { cell: def.id, out, status: invalidReasons.length ? 'invalid' : armResults.every(a => a.status === 'complete') && !stopped ? 'complete' : 'partial', arms: armResults, stopped, invalid_reasons: invalidReasons };

  // ─── Ingest ───
  async function ingestConversation(rid: string, convId: string, attempt: number): Promise<'ok' | 'stopped'> {
    const conv = byConv.get(convId)!;
    const ns = sanitizer.ns(convId);
    staging.event({ realization_id: rid, conversation: convId, attempt, event: 'started', at: new Date().toISOString() });
    const plan = sanitizer.ingestPlan(conv);
    const sample = probeSample(plan, def.probes.sample, `${def.probes.seed}|${convId}`);
    const canProbe = probeable(capabilities);
    const fixed = policyFor('fixed-evidence');
    const errors: IngestSummary['errors'] = [];
    const writes: number[] = [];
    let failed = 0, synthetic = 0, messages = 0, tokens = 0;
    const probes: Array<Promise<ProbeRecord>> = [];
    const probe = async (step: { input: SessionInput }, kind: 'last' | 'sample', t0: number): Promise<ProbeRecord> => {
      const base = { realization_id: rid, source_id: step.input.source_id, kind };
      if (!canProbe) return { ...base, status: 'not-measurable', write_start_to_queryable_ms: null, polls: 0 };
      const passage = passageOf(step.input);
      const deadline = t0 + (opts.probeTimeoutMs ?? 900_000);
      let polls = 0;
      while (true) {
        polls++;
        try {
          const res = await system.retrieve(ns, { text: passage, query_time: null }, fixed);
          if (res.items.some(i => i.source_ids.includes(step.input.source_id))) return { ...base, status: 'found', write_start_to_queryable_ms: Math.round((performance.now() - t0) * 10) / 10, polls };
        } catch { /* a vendor error is polled again until the deadline */ }
        if (performance.now() >= deadline) return { ...base, status: 'missed', write_start_to_queryable_ms: null, polls };
        await Bun.sleep(opts.probeIntervalMs ?? 2000);
      }
    };
    const t0 = performance.now();
    let importError: string | null = null;
    const ran = await meter.around(slot, `ingest:${ns}`, 'ingest', async () => {
      await system.reset(ns);
      await meter.phase(slot, 'commit');
      for (const [i, step] of plan.entries()) {
        if (step.synthetic_time) synthetic++;
        messages += step.input.turns.length;
        tokens += encodingCount('cl100k_base', step.input.turns.map(t => `${t.speaker}: ${t.content}`).join('\n'));
        const w0 = performance.now();
        try {
          const res = await system.ingestSession(ns, step.input, step.event_time);
          writes.push(res.service_ms ?? performance.now() - w0);
          if (res.errors.length || res.completeness === 'degraded') { failed++; errors.push({ source_id: step.input.source_id, kind: res.errors.length ? 'reported' : 'degraded', message: (res.errors.map(String).join('; ') || `completeness ${res.completeness}`).slice(0, 300) }); }
        } catch (e) {
          if (e instanceof SanitizerLeakError) { importError = e.message; invalidReasons.push(`sanitizer tripwire during ingest: ${e.message}`); break; }
          if (/budget|BudgetExceeded/i.test(String((e as Error).message))) { importError = `budget: ${(e as Error).message.slice(0, 200)}`; break; }
          failed++;
          errors.push({ source_id: step.input.source_id, kind: (e as { kind?: string }).kind ?? 'product_error', message: (e as Error).message.slice(0, 300) });
        }
        const kind = sample.get(i);
        if (kind) probes.push(probe(step, kind, w0));
      }
      await meter.phase(slot, 'background');
      let finish = { ready: false, waited_ms: 0, completeness: 'not reached' };
      if (!importError) { try { const f = await system.finishIngest(ns, opts.finishTimeoutS ?? 600); finish = { ready: f.ready, waited_ms: f.waited_ms, completeness: f.completeness }; } catch (e) { finish = { ready: false, waited_ms: 0, completeness: `error: ${(e as Error).message.slice(0, 200)}` }; } }
      const probeRecords = await Promise.all(probes);
      await meter.phase(slot, null);
      return { finish, probeRecords };
    });
    if (ran.error) importError ??= (ran.error as Error).message.slice(0, 300);
    if (importError?.startsWith('budget:')) { stopped = importError; return 'stopped'; }
    const finish = ran.value?.finish ?? { ready: false, waited_ms: 0, completeness: `error: ${importError}` };
    const probeRecords = ran.value?.probeRecords ?? [];
    const barrier = !canProbe ? 'not-measurable' : !importError && finish.ready ? await readinessProbe(system, ns, plan.at(-1)?.input, fixed, capabilities) : 'skipped';
    const ingest: IngestSummary = {
      sessions: plan.length, failed_sessions: failed, synthetic_times: synthetic, messages, ingested_tokens: tokens, wall_ms: Math.round(performance.now() - t0),
      write_ms: { p50: pct(writes, 50), p95: pct(writes, 95), total: Math.round(writes.reduce((s, x) => s + x, 0)) }, finish, readiness_probe: barrier,
      degraded: !!importError || failed / Math.max(1, plan.length) > 0.01 || !finish.ready || barrier === 'missed', errors: errors.slice(0, 200),
    };
    writeAtomic(join(staging.dir(rid), 'readiness.ndjson'), probeRecords.map(p => JSON.stringify(p) + '\n').join(''));
    staging.event({ realization_id: rid, conversation: convId, attempt, event: 'ingested', at: new Date().toISOString(), ingest, probes: probeRecords });
    return 'ok';
  }

  // ─── Questions ───
  async function runQuestions(rid: string, convId: string): Promise<void> {
    const conv = byConv.get(convId)!;
    const ns = sanitizer.ns(convId);
    const dir = staging.dir(rid);
    const isLive = live.has(rid);
    const plan = sanitizer.ingestPlan(conv);
    const lastEventTime = plan.map(p => p.event_time).filter((t): t is string => !!t).sort().pop() ?? null;
    const fallbackDate = conv.sessions.map(x => x.date ?? '').sort().pop() || undefined;
    const ingested = new Set(plan.map(p => p.input.source_id));
    const sessById = new Map(conv.sessions.map(s => [s.id, s]));
    const sessionOf = (src: string) => { const id = sanitizer.sessionOf(ns, src); return id ? sessById.get(id) : undefined; };
    const degraded = staging.latest(convId)?.ingest?.degraded ?? false;
    const retrievalsPath = join(dir, 'retrievals.ndjson');
    const retrievals = latestBy<StagedRetrieval>(retrievalsPath, r => r.key);
    const answers = new RecordLog(join(dir, 'answers.ndjson'), 'answer');
    const judgments = new RecordLog(join(dir, 'judgments.ndjson'), 'judgment');
    const answerTries = new Map<string, number>();
    for (const t of readLines<{ answer_id: string }>(join(dir, 'answer-attempts.ndjson'))) answerTries.set(t.answer_id, (answerTries.get(t.answer_id) ?? 0) + 1);
    const rowBuffer: Q1Row[] = [];
    const flush = () => {
      if (rowBuffer.length) appendFileSync(join(dir, 'attempts.ndjson'), rowBuffer.splice(0).map(r => JSON.stringify(r) + '\n').join(''));
      publishCell(def, arms, [out], out, { instrument, selected, invalidReasons, configs, capabilities, stopped, maxAttempts });
    };

    const retrieve = async (q: MemoryQuestion, mode: RetrievalPolicy['mode']): Promise<StagedRetrieval | null> => {
      const key = `${q.id}|${mode}`;
      const prior = retrievals.get(key);
      if (prior && (FINAL.has(prior.outcome) || prior.attempt >= maxAttempts)) return prior;
      if (!isLive) return prior ?? null;
      const once = async () => {
        const pq = sanitizer.question(q, lastEventTime);
        const t0 = performance.now();
        await meter.phase(slot, 'query');
        const r = await meter.around(slot, `q:${q.id}:${mode}`, 'retrieval', () => system.retrieve(ns, pq, policyFor(mode)));
        await meter.phase(slot, null);
        const harness = Math.round((performance.now() - t0) * 10) / 10;
        const base = { key, question_id: q.id, policy: mode, attempt: (prior?.attempt ?? 0) + 1, items: [] as Item[], applied_settings: {}, truncated: false, latency_ms: null, harness_ms: harness, query_time: pq.query_time, at: new Date().toISOString() };
        const fail = (e: unknown): StagedRetrieval => {
          if (e instanceof SanitizerLeakError) invalidReasons.push(`sanitizer tripwire during retrieval: ${e.message}`);
          const f = failureRow({ id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length }, e);
          return { ...base, outcome: f.outcome!, error: String(f.error), error_kind: f.error_kind };
        };
        if (r.error !== undefined) return { staged: fail(r.error), meter: r.meter };
        try { validateSources(r.value!.items, ingested); } catch (e) { return { staged: fail(e), meter: r.meter }; }
        return { meter: r.meter, staged: { ...base, outcome: degraded ? 'ingest_degraded' as const : 'scored' as const, items: r.value!.items, applied_settings: r.value!.applied_settings, truncated: r.value!.truncated, latency_ms: Math.round((r.value!.service_ms ?? harness) * 10) / 10 } };
      };
      let res = await once();
      if (res.staged.outcome === 'retrieval_error' && res.meter && upstreamTrouble(res.meter)) res = await once();
      if (/budget/i.test(res.staged.error ?? '') && res.staged.outcome === 'budget_not_run') stopped = `budget: ${res.staged.error}`;
      appendFileSync(retrievalsPath, JSON.stringify(res.staged) + '\n');
      retrievals.set(key, res.staged);
      return res.staged;
    };

    const terminal = (id: string, outcome: Outcome) => FINAL.has(outcome) || (answerTries.get(id) ?? 0) + 1 >= maxAttempts;
    const recordAttempt = (id: string, outcome: Outcome, error?: string) => { appendFileSync(join(dir, 'answer-attempts.ndjson'), JSON.stringify({ answer_id: id, outcome, error: error?.slice(0, 300), at: new Date().toISOString() }) + '\n'); answerTries.set(id, (answerTries.get(id) ?? 0) + 1); };
    const appendAnswer = (raw: AnswerRecord, error?: string, pack: PackedContext | null = null) => {
      const a = withDerived(raw, pack);
      if (FINAL.has(a.outcome)) { answers.append(a); return; }
      if (terminal(a.answer_id, a.outcome)) { recordAttempt(a.answer_id, a.outcome, error); answers.append(a); return; }
      recordAttempt(a.answer_id, a.outcome, error);
    };

    const judgeOne = async (q: MemoryQuestion, a: AnswerRecord, arm: ArmDefinition) => {
      if (!JUDGED.has(a.outcome)) return;
      const tasks: Array<{ judgeModel: string; instrumentId: string }> = [{ judgeModel: instrument.canonical_judge, instrumentId: instrument.id }];
      const f = arm.frontier;
      if (f && opts.frontier !== false && a.replicate === 0 && (!f.readers || f.readers.includes(a.reader)) && inFrontierSample(arm, q.id)) for (const j of f.judges) tasks.push({ judgeModel: j, instrumentId: frontierInstrumentId(instrument.id, j) });
      for (const t of tasks) {
        if (judgments.has(judgmentKey({ answer_id: a.answer_id, instrument_sha256: instrument.sha256, judge: t.judgeModel, judge_replicate: 0 }))) continue;
        const r = await meter.around('judge', `judge:${a.answer_id.slice(0, 16)}:${t.judgeModel}`, 'judge', () => judgeAnswer(judge, instrument, q, a.text, { judge: t.judgeModel, judgeReplicate: 0, maxAttempts }));
        if (r.error !== undefined) { if (/budget/i.test(String((r.error as Error).message))) stopped = `budget: ${(r.error as Error).message.slice(0, 200)}`; continue; }
        judgments.append({ answer_id: a.answer_id, ...r.value!, instrument_id: t.instrumentId });
      }
    };
    const frontierSamples = new Map<string, Set<string>>();
    const inFrontierSample = (arm: ArmDefinition, qid: string) => {
      if (arm.frontier?.sample === null || arm.frontier?.sample === undefined) return true;
      let s = frontierSamples.get(arm.id);
      if (!s) { s = new Set(selectQuestions(selected.filter(q => armQs.get(arm.id)!.has(q.id)), arm.frontier.sample, 7).map(q => q.id)); frontierSamples.set(arm.id, s); }
      return s.has(qid);
    };

    const identity = (arm: ArmDefinition, q: MemoryQuestion, readerId: string, replicate: number, context: string) => ({ cell_id: arm.cell_id, realization_id: rid, question_id: q.id, conversation: q.conversation, system: def.system, arm: arm.arm, reader: readerId, replicate, effort: arm.mode === 'own-answer' ? null : def.effort, context_sha256: context });
    const zero = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

    const rowFor = (arm: ArmDefinition, q: MemoryQuestion, r: StagedRetrieval | null, pack: PackedContext | null, extra: Partial<Q1Row> = {}): Q1Row => {
      const base: Q1Row = { id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length, cell_id: arm.cell_id, realization_id: rid,
        delivered_tokens: pack?.delivered ?? {}, fill_rate: pack?.fill_rate ?? null, packing_loss: pack?.packing_loss ?? null, provenance_status: weakest(r?.items ?? []), fanout: { mean: 0, max: 0 }, ...extra };
      if (!r) return { ...base, recall_measurable: false, ...extra };
      const items = r.items;
      const at5 = strictSources(items, 5), at10 = strictSources(items, 10);
      const toSessions = (srcs: string[]) => srcs.map(s => sanitizer.sessionOf(ns, s)!);
      const gold = new Set(q.gold);
      const measurable = at5.measurable && capabilities.retrieval_metrics !== 'not-applicable' && FINAL.has(r.outcome) && r.outcome !== 'unsupported';
      return {
        ...base, outcome: r.outcome, policy: r.policy, query_time: r.query_time, latency_ms: r.latency_ms ?? undefined, harness_ms: r.harness_ms, items_returned: items.length, truncated: r.truncated,
        ...(r.error ? { error: r.error, error_kind: r.error_kind } : {}),
        ...(measurable ? { recall_all_at_5: recallAllAtK(toSessions(at5.sources), gold, 5), recall_any_at_5: recallAnyAtK(toSessions(at5.sources), gold, 5), recall_all_at_10: recallAllAtK(toSessions(at10.sources), gold, 10),
          recall_any_at_10: recallAnyAtK(toSessions(at10.sources), gold, 10), ndcg_at_10: ndcgAtK(toSessions(at10.sources), new Map(q.gold.map(g => [g, 1])), 10), retrieved: toSessions(at10.sources) } : { recall_measurable: false }),
        fanout: { mean: Math.round(at10.fanout_mean * 1000) / 1000, max: at10.fanout_max },
        provenance: { exact: items.filter(i => i.provenance_status === 'exact').length, partial: items.filter(i => i.provenance_status === 'partial').length, unavailable: items.filter(i => i.provenance_status === 'unavailable').length },
        ...extra,
      };
    };

    const packFor = (arm: ArmDefinition, q: MemoryQuestion, r: StagedRetrieval, mode: 'native' | 'rehydrated'): PackedContext => {
      const key = contextKey(rid, q.id, arm.id);
      const pack = packContext(mode, q, r.items, { budgetTokens: arm.budget, sessionOf, fallbackDate, present: capabilities.presentation === 'event-time' ? 'event-time' : 'rank', counter: counters.get(arm.id)! });
      const frozen = contexts.get(key);
      if (frozen && frozen.prompt_sha256 !== sha256(pack.prompt)) invalidReasons.push(`context ${key} no longer packs to its frozen bytes`);
      if (!frozen) contexts.put({ key, prompt_sha256: sha256(pack.prompt), prompt: pack.prompt, meta: { context_sha256: pack.context_sha256, identity_sha256: pack.identity_sha256, tokens: pack.tokens, reader_tokens: pack.reader_tokens, delivered: pack.delivered, fill_rate: pack.fill_rate, item_ids: pack.item_ids, cut: pack.cut } });
      return pack;
    };

    const readPacked = async (arm: ArmDefinition, q: MemoryQuestion, r: StagedRetrieval | null) => {
      const failed = !r || !(r.outcome === 'scored' || r.outcome === 'ingest_degraded');
      const pack = !failed ? packFor(arm, q, r!, 'native') : null;
      const ctx = pack?.context_sha256 ?? sha256(`no-context|${r?.outcome ?? 'missing'}`);
      for (const rd of arm.readers) for (let rep = 0; rep < (arm.reader_replicates[rd] ?? 1); rep++) {
        if (stopped) return pack;
        const id = identity(arm, q, rd, rep, ctx);
        const aid = answerId(arm.cell_id, q.id, rd, rep);
        if (answers.has(aid)) continue;
        if (failed) {
          if (r && (FINAL.has(r.outcome) || r.attempt >= maxAttempts)) answers.append(answerRecord(id, { text: '', outcome: r.outcome, usage: zero, latency_ms: 0, provider_input_tokens: null }));
          continue;
        }
        const t0 = performance.now();
        const res = await meter.around('harness', `read:${aid.slice(0, 16)}`, 'reader', () => reader.chat(rd, pack!.prompt, { maxTokens: READER_MAX_TOKENS, replicate: rep, effort: def.effort }));
        if (res.error !== undefined) {
          const msg = String((res.error as Error).message);
          if (/budget|BudgetExceeded/i.test(msg)) { stopped = `budget: ${msg.slice(0, 200)}`; return pack; }
          appendAnswer(answerRecord(id, { text: '', outcome: 'reader_error', usage: zero, latency_ms: Math.round(performance.now() - t0), provider_input_tokens: null }), msg);
          continue;
        }
        const c = res.value!;
        appendAnswer(answerRecord(id, { text: c.text, outcome: r!.outcome, usage: { input: c.input_tokens, output: c.output_tokens, cache_read: c.cache_read_tokens ?? 0, cache_write: c.cache_write_tokens ?? 0 },
          latency_ms: Math.round(performance.now() - t0), provider_input_tokens: c.input_tokens + (c.cache_read_tokens ?? 0) + (c.cache_write_tokens ?? 0) }), undefined, pack);
      }
      return pack;
    };

    const readStore = async (arm: ArmDefinition, q: MemoryQuestion): Promise<Partial<Q1Row>> => {
      const extra: Partial<Q1Row> & { evidence_opened?: Record<string, number | null>; fit?: Record<string, unknown>; own_answer?: Record<string, unknown> } = {};
      let pack: PackedContext | null = null;
      if (arm.mode === 'full-context') {
        const all = await system.retrieve(ns, { text: q.question, query_time: null }, policyFor('vendor-default'));
        pack = packContext('rehydrated', q, all.items, { budgetTokens: null, sessionOf, fallbackDate, counter: counters.get(arm.id)! });
        Object.assign(extra, { delivered_tokens: pack.delivered, recall_measurable: false });
      }
      for (const rd of readersOf.get(arm.id)!) for (let rep = 0; rep < (arm.reader_replicates[rd] ?? 1); rep++) {
        if (stopped) return extra;
        const ctx = pack ? pack.context_sha256 : sha256(`${arm.mode}|${ns}|${q.id}|${rd}`);
        const id = identity(arm, q, rd, rep, ctx);
        const aid = answerId(arm.cell_id, q.id, rd, rep);
        if (answers.has(aid)) continue;
        if (!isLive) continue;
        if (arm.mode === 'full-context') {
          const res = await meter.around('harness', `read:${aid.slice(0, 16)}`, 'reader', () => answerFullContext({ reader: rd, prompt: pack!.prompt, conversation: ns, maxOutputTokens: READER_MAX_TOKENS, effort: def.effort, tokenizer: fitTokenizer(rd), ...(deps.fullContextFetch ? { fetchImpl: deps.fullContextFetch } : {}) }));
          const a = res.value;
          if (!a) { appendAnswer(answerRecord(id, { text: '', outcome: 'reader_error', usage: zero, latency_ms: 0, provider_input_tokens: null }), String((res.error as Error)?.message)); continue; }
          extra.fit = { ...(extra.fit ?? {}), [rd]: { fits: a.fit.fits, prompt_tokens: a.fit.prompt_tokens, max_input_tokens: a.fit.max_input_tokens, tokenizer: a.fit.tokenizer } };
          appendAnswer(answerRecord(id, { text: a.text, outcome: a.outcome === 'scored' && degraded ? 'ingest_degraded' : a.outcome, usage: a.usage, latency_ms: Math.round(a.latency_ms), provider_input_tokens: a.provider_input_tokens || null }), a.error);
          continue;
        }
        if (arm.mode === 'own-answer') {
          const pq = sanitizer.question(q, lastEventTime);
          const own = rd.startsWith('own:') ? rd.slice(4) : null;
          const t0 = performance.now();
          await meter.phase(slot, 'query');
          const res = await meter.around(slot, `own:${aid.slice(0, 16)}`, 'reader', () => (system as OwnAnswerSystem).answer(ns, pq, { mode: arm.variant!, model: own ? null : rd }));
          await meter.phase(slot, null);
          if (res.error !== undefined) {
            if (res.error instanceof SanitizerLeakError) invalidReasons.push(`sanitizer tripwire during an own answer: ${res.error.message}`);
            const f = failureRow({ id: q.id, conversation: q.conversation, category: q.category, abstention: q.abstention, gold_count: q.gold.length }, res.error);
            if (f.outcome === 'budget_not_run') stopped = `budget: ${String(f.error).slice(0, 200)}`;
            appendAnswer(answerRecord(id, { text: '', outcome: f.outcome!, usage: zero, latency_ms: Math.round(performance.now() - t0), provider_input_tokens: null }), String(f.error));
            continue;
          }
          const a = res.value!;
          const drift = own && a.model && a.model !== own ? `answered with ${a.model}, not the resolved ${own}` : null;
          const cited = a.source_ids.filter(s => ingested.has(s));
          const gold = new Set(q.gold.map(g => sanitizer.source(q.conversation, g)));
          extra.own_answer = { ...(extra.own_answer ?? {}), [rd]: { degraded: a.degraded, model: a.model, cited: cited.length, cited_gold: gold.size ? cited.filter(s => gold.has(s)).length / gold.size : null } };
          const outcome = drift || a.outcome === 'harness_invalid' ? 'harness_invalid' as const : degraded ? 'ingest_degraded' as const : 'scored' as const;
          appendAnswer(answerRecord(id, { text: a.text, outcome, usage: { ...zero, input: a.usage.input, output: a.usage.output }, latency_ms: Math.round(a.service_ms ?? performance.now() - t0), provider_input_tokens: null,
            ...(a.degraded ? { stop_reason: a.degraded } : {}), ...(a.usd !== null ? { usd: a.usd } : {}) }), drift ?? (a.outcome === 'harness_invalid' ? 'the system classified its answer path as a harness failure' : undefined));
          continue;
        }
        const pq = sanitizer.question(q, lastEventTime);
        const res = await meter.around('harness', `answer:${aid.slice(0, 16)}`, 'reader', () => (system as AnsweringSystem).answer(ns, pq, { reader: rd, replicate: rep }));
        if (res.error !== undefined) { appendAnswer(answerRecord(id, { text: '', outcome: 'reader_error', usage: zero, latency_ms: 0, provider_input_tokens: null }), String((res.error as Error).message)); continue; }
        const a = res.value!;
        const gold = q.gold.map(g => sanitizer.source(q.conversation, g));
        const opened = a.opened_source_ids.filter(s => gold.includes(s)).length;
        extra.evidence_opened = { ...(extra.evidence_opened ?? {}), [rd]: gold.length ? opened / new Set(gold).size : null };
        appendAnswer(answerRecord(id, { ...a, outcome: a.outcome === 'scored' && degraded ? 'ingest_degraded' : a.outcome, opened_source_ids: a.opened_source_ids.map(s => sanitizer.sessionOf(ns, s) ?? s) }), a.error);
      }
      return extra;
    };

    for (const q of selected.filter(x => x.conversation === convId)) {
      if (stopped) break;
      if (opts.stopAfterQuestions !== undefined && processed >= opts.stopAfterQuestions) { stopped = 'stopped by the test hook (simulated kill)'; break; }
      const staged = new Map<string, StagedRetrieval | null>();
      for (const p of policies) if (arms.some(a => a.policy === p && armQs.get(a.id)!.has(q.id))) staged.set(p, await retrieve(q, p));
      for (const arm of arms) {
        if (!armQs.get(arm.id)!.has(q.id) || stopped) continue;
        const r = arm.policy ? staged.get(arm.policy) ?? null : null;
        let row: Q1Row;
        if (arm.mode === 'retrieval-only') row = rowFor(arm, q, r, null);
        else if (arm.mode === 'packed' || arm.mode === 'native-default') {
          const pack = await readPacked(arm, q, r);
          row = rowFor(arm, q, r, pack, pack ? { reader_tokens: pack.reader_tokens, context_sha256: pack.context_sha256 } as Partial<Q1Row> : {});
        } else row = rowFor(arm, q, null, null, await readStore(arm, q));
        for (const a of answers.all().filter(x => x.cell_id === arm.cell_id && x.question_id === q.id)) { if (stopped) break; await judgeOne(q, a, arm); }
        rowBuffer.push(row);
      }
      processed++;
      if (processed % ROW_FLUSH_EVERY === 0) flush();
    }
    flush();
  }
}

/**
 * The per-answer derived fields on a judged answer (preregistration, "Derived columns"): the hedge verdict on its text,
 * and the evidence its reader was given, as the packed context's per-tokenizer counts on a component arm or the
 * reader's total input tokens (`reader_input`) on a whole-system arm.
 */
export function withDerived(a: AnswerRecord, pack: PackedContext | null): AnswerRecord {
  if (!JUDGED.has(a.outcome)) return a;
  const delivered = a.arm === 'component' && pack ? pack.delivered : { reader_input: a.provider_input_tokens ?? a.usage.input + a.usage.cache_read + a.usage.cache_write };
  return { ...a, hedge: hedgeStamp(a.text), delivered_tokens: delivered };
}

// ─── Publish ─────────────────────────────────────────────────────────

interface PublishCtx {
  instrument: Instrument; selected: MemoryQuestion[]; invalidReasons: string[]; configs: Map<string, { text: string; sha: string }>;
  capabilities: CapabilityRecord; stopped: string | null; maxAttempts: number;
}

/** The valid realization of each conversation across staging roots (shards), and its records. */
function gatherStaging(cellId: string, roots: string[]) {
  const convs = new Map<string, { root: string; rid: string; ingest?: IngestSummary; probes: ProbeRecord[]; restored_from?: string; attempts: number }>();
  for (const root of roots) {
    const st = new Staging(root, cellId);
    const evs = st.events();
    for (const conv of [...new Set(evs.map(e => e.conversation))]) {
      const l = st.latest(conv);
      if (!l || l.state !== 'ingested') continue;
      convs.set(conv, { root: st.root, rid: l.id, ingest: l.ingest, probes: l.probes ?? [], restored_from: l.restored_from, attempts: l.attempt + 1 });
    }
  }
  return convs;
}

/** Rewrite every arm's scoreboard cell from the staging of its valid realizations; returns each arm's status. */
export function publishCell(def: CellDefinition, arms: ArmDefinition[], roots: string[], out: string, ctx: PublishCtx): ArmResult[] {
  const convs = gatherStaging(def.id, roots);
  const qOrder = new Map(ctx.selected.map((q, i) => [q.id, i]));
  const staged = [...convs.entries()].map(([conv, c]) => {
    const dir = join(c.root, 'r', c.rid);
    return { conv, ...c, rows: latestBy<Q1Row>(join(dir, 'attempts.ndjson'), r => `${r.cell_id}|${r.id}`), answers: readRecords(join(dir, 'answers.ndjson'), 'answer'), judgments: readRecords(join(dir, 'judgments.ndjson'), 'judgment') };
  });
  const meters = roots.flatMap(r => new Staging(r, def.id).meters());
  const spend = meters.length ? Object.fromEntries((['ingest', 'retrieval', 'reader', 'judge'] as const).map(p => [p, Math.round(meters.filter(m => m.phase === p).reduce((s, m) => s + m.usd, 0) * 1e6) / 1e6])) : null;
  const ingests = staged.map(s => s.ingest).filter((x): x is IngestSummary => !!x);
  const probes = staged.flatMap(s => s.probes);
  const found = probes.filter(p => p.write_start_to_queryable_ms !== null).map(p => p.write_start_to_queryable_ms!);
  return arms.map(arm => {
    const dir = join(out, 'cells', arm.cell_id);
    mkdirSync(dir, { recursive: true });
    const qs = new Set((arm.questions ? selectCellQuestions(ctx.selected, arm.questions) : ctx.selected).map(q => q.id));
    const byOrder = (a: { id?: string; question_id?: string }, b: { id?: string; question_id?: string }) => (qOrder.get(a.id ?? a.question_id!) ?? 0) - (qOrder.get(b.id ?? b.question_id!) ?? 0);
    const rows = staged.flatMap(s => [...s.rows.values()].filter(r => r.cell_id === arm.cell_id && qs.has(r.id))).sort(byOrder);
    const readers = armReaders(arm, ctx.capabilities);
    const readerOrder = (r: string) => readers.indexOf(r);
    const answers = staged.flatMap(s => s.answers.filter(a => a.cell_id === arm.cell_id && qs.has(a.question_id))).sort((a, b) => byOrder(a, b) || readerOrder(a.reader) - readerOrder(b.reader) || a.replicate - b.replicate);
    const ids = new Set(answers.map(a => a.answer_id));
    const aOrder = new Map(answers.map((a, i) => [a.answer_id, i]));
    const judgments = staged.flatMap(s => s.judgments.filter(j => ids.has(j.answer_id))).sort((a, b) => (aOrder.get(a.answer_id)! - aOrder.get(b.answer_id)!) || (a.instrument_id < b.instrument_id ? -1 : a.instrument_id > b.instrument_id ? 1 : 0) || a.judge_replicate - b.judge_replicate);
    const nd = (xs: unknown[]) => xs.map(x => JSON.stringify(x) + '\n').join('');
    writeAtomic(join(dir, 'rows.ndjson'), nd(rows));
    writeAtomic(join(dir, 'answers.ndjson'), nd(answers));
    writeAtomic(join(dir, 'judgments.ndjson'), nd(judgments));
    writeAtomic(join(dir, 'readiness.ndjson'), nd(found.map(ms => ({ write_start_to_queryable_ms: ms }))));
    const promised = readers.reduce((s, r) => s + (arm.reader_replicates[r] ?? 1), 0) * qs.size;
    const canonical = new Set(judgments.filter(j => j.instrument_id === ctx.instrument.id && j.judge_replicate === 0).map(j => j.answer_id));
    const unjudged = answers.filter(a => JUDGED.has(a.outcome) && !canonical.has(a.answer_id)).length;
    const outcomes: Record<string, number> = {};
    for (const a of answers) outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1;
    const complete = rows.length === qs.size && (arm.mode === 'retrieval-only' || (answers.length === promised && unjudged === 0));
    const status: ArmResult['status'] = ctx.invalidReasons.length ? 'invalid' : complete ? 'complete' : 'partial';
    const config = ctx.configs.get(arm.id) ?? (existsSync(join(dir, 'run-config.json')) ? { text: readFileSync(join(dir, 'run-config.json'), 'utf8'), sha: sha256(readFileSync(join(dir, 'run-config.json'))) } : null);
    const scores = (reader: string) => { const xs = answers.filter(a => a.reader === reader && canonical.has(a.answer_id)).map(a => judgments.find(j => j.answer_id === a.answer_id && j.instrument_id === ctx.instrument.id && j.judge_replicate === 0)!.score).filter((x): x is number => typeof x === 'number'); return xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length * 1e6) / 1e6 : null; };
    const receipt = {
      schema: CELL_RECEIPT_SCHEMA, cell_id: arm.cell_id, run_cell: def.id, config_sha256: config?.sha ?? null, run_status: status, invalid_reasons: ctx.invalidReasons, stopped: ctx.stopped,
      set: arm.set, benchmark: def.benchmark, split: def.split, block: def.block,
      system: { kind: def.system, configuration: def.configuration, runner: def.runner, capability_system: ctx.capabilities.system, versions: ctx.capabilities.versions, capabilities: ctx.capabilities },
      arm: { id: arm.id, arm: arm.arm, mode: arm.mode, policy: arm.policy, budget: arm.budget, variant: arm.variant ?? null, label: arm.label },
      readers, reader_replicates: arm.reader_replicates, effort: arm.mode === 'own-answer' ? null : def.effort,
      instrument: { id: ctx.instrument.id, sha256: ctx.instrument.sha256, judge: ctx.instrument.canonical_judge }, frontier: arm.frontier ? { ...arm.frontier, instrument_ids: arm.frontier.judges.map(j => frontierInstrumentId(ctx.instrument.id, j)) } : null,
      selection: { questions: qs.size, conversations: new Set(rows.map(r => r.conversation)).size, scheduled_sha256: sha256([...qs].join('\n')) },
      counts: { rows: rows.length, answers: answers.length, answers_promised: promised, judgments: judgments.length, unjudged, outcomes },
      per_reader_mean: Object.fromEntries(readers.map(r => [r, scores(r)])),
      realizations: staged.map(s => ({ conversation: s.conv, realization_id: s.rid, attempts: s.attempts, restored_from: s.restored_from ?? null, degraded: s.ingest?.degraded ?? null })).sort((a, b) => (a.conversation < b.conversation ? -1 : 1)),
      ingest: {
        conversations: ingests.length, messages: ingests.reduce((s, x) => s + x.messages, 0), ingested_tokens: ingests.reduce((s, x) => s + x.ingested_tokens, 0),
        wall_ms: { total: ingests.reduce((s, x) => s + x.wall_ms, 0), p50: pct(ingests.map(x => x.wall_ms), 50), p95: pct(ingests.map(x => x.wall_ms), 95) },
        failed_sessions: ingests.reduce((s, x) => s + x.failed_sessions, 0), degraded_conversations: ingests.filter(x => x.degraded).length,
        readiness_samples_ms: found, write_start_to_queryable_ms: { p50: pct(found, 50), p95: pct(found, 95), probes: probes.length, found: found.length, missed: probes.filter(p => p.status === 'missed').length, not_measurable: probes.filter(p => p.status === 'not-measurable').length },
      },
      timings: { retrieval_ms: { p50: pct(rows.map(r => r.latency_ms).filter((x): x is number => typeof x === 'number'), 50), p95: pct(rows.map(r => r.latency_ms).filter((x): x is number => typeof x === 'number'), 95) },
        answer_ms: { p50: pct(answers.map(a => a.latency_ms), 50), p95: pct(answers.map(a => a.latency_ms), 95) } },
      usage: { input: answers.reduce((s, a) => s + a.usage.input, 0), output: answers.reduce((s, a) => s + a.usage.output, 0), cache_read: answers.reduce((s, a) => s + a.usage.cache_read, 0), cache_write: answers.reduce((s, a) => s + a.usage.cache_write, 0) },
      spend: spend ? { source: 'metering proxy (whole cell, every arm)', usd: spend, total_usd: Math.round(Object.values(spend).reduce((s, x) => s + x, 0) * 1e6) / 1e6 } : { source: null, note: 'no metering proxy: the budget ledger holds this run\'s spend' },
      files: { rows: 'rows.ndjson', answers: 'answers.ndjson', judgments: 'judgments.ndjson', run_config: 'run-config.json', readiness: 'readiness.ndjson', contexts: `../../runs/${def.id}/contexts.ndjson` },
    };
    writeAtomic(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { cell_id: arm.cell_id, dir, status, config_sha256: config?.sha ?? '', answers: answers.length, judgments: judgments.length, rows: rows.length, readers };
  });
}

// ─── Aggregates (the only output a sealed cell may write inside the repository) ───

const AGG_KEYS = ['cell_id', 'run_cell', 'config_sha256', 'run_status', 'set', 'benchmark', 'split', 'block', 'readers', 'counts', 'per_reader_mean', 'timings', 'spend'] as const;

/** Allowlisted aggregate view of each arm's receipt: counts, means, timings and spend; no rows, answers, ids or text. */
export function cellAggregates(results: ArmResult[]): Record<string, unknown> {
  return { schema: 'gbrain-evals/q1-cell-aggregates/v1', arms: results.map(r => {
    const rec = JSON.parse(readFileSync(join(r.dir, 'receipt.json'), 'utf8')) as Record<string, any>;
    const pick = Object.fromEntries(AGG_KEYS.map(k => [k, rec[k]]));
    const ing = rec.ingest ?? {};
    return { ...pick, ingest: { conversations: ing.conversations, messages: ing.messages, ingested_tokens: ing.ingested_tokens, wall_ms: ing.wall_ms, failed_sessions: ing.failed_sessions, degraded_conversations: ing.degraded_conversations, write_start_to_queryable_ms: ing.write_start_to_queryable_ms } };
  }) };
}

/** A campaign.json cell entry for a published arm (eval/runner/scoreboard.ts CampaignCell). */
export function scoreboardCampaignCell(def: CellDefinition, arm: ArmDefinition, result: Pick<ArmResult, 'status' | 'config_sha256'> & Partial<Pick<ArmResult, 'readers'>>) {
  return { cell_id: arm.cell_id, set: arm.set, system: def.system, arm: arm.arm === 'diagnostic' ? 'component' as const : arm.arm, budget: arm.budget, configuration: def.configuration, label: arm.label,
    ...(arm.anchor ? { anchor: true } : {}), status: result.status === 'invalid' ? 'invalid' as const : 'complete' as const, readers: result.readers ?? arm.readers,
    ...(Object.keys(arm.reader_replicates).length ? { reader_replicates: arm.reader_replicates } : {}), canonical_instrument: def.canonical_instrument, config_sha256: result.config_sha256 };
}

// ─── Plan and the Q1 campaign manifest ───────────────────────────────

/** Repository paths every Q1 cell executes (their git tree enters the campaign hash). */
export const EXECUTES = ['eval/runner/q1/cell.ts', 'eval/runner/q1/cells', 'eval/runner/q1/scoreboard-errors.ts', 'eval/runner/memory-qa', 'eval/runner/systems', 'eval/runner/cat40', 'eval/runner/decisions',
  'eval/runner/metering-proxy.ts', 'eval/runner/budget-ledger.ts', 'eval/runner/paid-arm.ts', 'eval/runner/metrics.ts', 'eval/runner/sealed-confirmation-lib.ts', 'eval/runner/shootout-cell.ts',
  'eval/systems', 'docs/comparison-systems', 'eval/decisions', 'package.json', 'bun.lock'];

const VM_VCPU = 4;
/** Waves: T1 first (S1 shim shards packed under the overnight cap), then each T2 set after T1 settles, in the preregistered scope-reduction order reversed. */
const T2_WAVES: Record<string, number> = { 'T2-S2b': 1, 'T2-S3': 2, 'T2-S2a': 3, 'T2-S4-S5': 4 };

/** One launch unit per cell, or per conversation shard for an S1 shim cell, in the shootout campaign's cell format. */
export function campaignCells(m: Manifest, opts: { smoke?: boolean; vcpuCapNight?: number } = {}): CellSpec[] {
  const perWave = Math.floor((opts.vcpuCapNight ?? 200) / VM_VCPU);
  const t1Units = m.cells.filter(c => c.block === 'T1').flatMap(c => Array.from({ length: c.shards }, (_, i) => ({ c, i }))).sort((a, b) => b.c.estimate.usd / b.c.shards - a.c.estimate.usd / a.c.shards || (a.c.id < b.c.id ? -1 : 1) || a.i - b.i);
  const t1Waves = Math.max(1, Math.ceil(t1Units.length / perWave));
  const waveOf = new Map(t1Units.map((u, k) => [`${u.c.id}|${u.i}`, Math.floor(k / perWave) + 1]));
  const spec = (c: CellDefinition, i: number, smoke: boolean): CellSpec => {
    const id = `${c.id}${c.shards > 1 ? `.c${i}` : ''}${smoke ? '.smoke' : ''}`;
    const run = [...FRONT, 'run', '--cell', c.id, ...(c.shards > 1 ? ['--shard', `${i}/${c.shards}`] : []), ...(smoke ? ['--limit', '20'] : []), ...(c.runner === 'shim' ? ['--system-url', 'http://127.0.0.1:8700'] : []), '--out', '"$SHOOTOUT_OUT"'].join(' ');
    const launch = c.launch ?? shimLaunch(c.system, c.configuration);
    const command = c.runner === 'shim' ? `${launchPrefix(launch)}bash eval/systems/bootstrap.sh up --system ${c.system} --config ${launch.config} && ${run}; rc=$?; bash eval/systems/bootstrap.sh down --system ${c.system}; exit $rc` : run;
    const lease = Math.max(0.01, Math.ceil((smoke ? c.estimate.usd * 20 / SETS[c.set].questions : c.estimate.usd / c.shards) * 100) / 100);
    return {
      id, system: c.system, benchmark: c.benchmark, config: c.configuration, lease_usd: lease, command,
      setup_command: `bash eval/systems/bootstrap.sh setup${c.runner === 'shim' ? ` --system ${c.system}` : ''} --datasets ${c.benchmark}`,
      vm: { size: `standard-${VM_VCPU}` }, timeout_hours: smoke ? 6 : Math.min(72, Math.ceil(c.expected_hours * 1.5) + 2), block: c.block, sealed: c.split !== 'dev',
      ...(smoke ? { smoke: true } : {}), providers: c.system === 'gbrain-defaults' ? ['openai', 'anthropic', 'voyage'] : ['openai', 'anthropic'],
      expected_hours: smoke ? 1 : c.expected_hours, wave: c.block === 'T1' ? waveOf.get(`${c.id}|${i}`)! : t1Waves + T2_WAVES[c.block],
      ...(c.snapshot_command ? { snapshot_command: c.snapshot_command } : {}), ...(c.restore_command ? { restore_command: c.restore_command } : {}),
    };
  };
  const out: CellSpec[] = [];
  for (const c of m.cells) for (let i = 0; i < c.shards; i++) out.push(spec(c, i, false));
  if (opts.smoke) for (const c of m.cells.filter(x => x.ingest_replicate === 1)) out.push(spec(c, 0, true));
  return out;
}

/** The Q1 scoreboard campaign manifest (shootout-cell.ts `q1-scoreboard-campaign`) for the cell manifest. */
export function campaignManifest(m: Manifest, opts: { smoke?: boolean } = {}): Q1Campaign {
  const models = [...new Set([...m.readers, ...Object.keys(m.prices), 'openai:gpt-4.1-mini', 'openai:text-embedding-3-large', 'anthropic:claude-opus-4-7', 'anthropic:claude-haiku-4-5'])].sort();
  return {
    kind: 'q1-scoreboard-campaign', schema_version: 1, campaign_id: 'q1-scoreboard', cap_usd: m.cap_usd, ledger: 'eval/reports/scoreboard/q1-scoreboard/campaign.sqlite',
    parameters: {}, cells: campaignCells(m, opts), executes: EXECUTES, images: {},
    blocks: Object.fromEntries(m.blocks.map(b => [b.id, { estimate_usd: b.estimate_usd, cap_usd: b.cap_usd }])),
    output_caps: { ...DEFAULT_ROUTE_CAPS }, route_classes: { ...DEFAULT_ROUTE_CLASSES }, schedule: { vcpu_cap_day: 128, vcpu_cap_night: 200 }, row_pull_every: ROW_FLUSH_EVERY, pull_interval_minutes: 10, models,
  };
}

export function renderPlan(m: Manifest): string {
  const cells = campaignCells(m);
  const waves = [...new Set(cells.map(c => c.wave!))].sort((a, b) => a - b).map(w => ({ w, n: cells.filter(c => c.wave === w).length, hours: Math.max(...cells.filter(c => c.wave === w).map(c => c.expected_hours ?? 0)), blocks: [...new Set(cells.filter(c => c.wave === w).map(c => c.block))].join(', ') }));
  const usd = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return [
    `Q1 cell manifest: ${m.cells.length} cells, ${m.cells.reduce((s, c) => s + c.arms.length, 0)} scoreboard cells, estimate ${usd(m.total_usd)} (PLAN §7 total ${usd(m.plan_total_usd)} including $260 shared work outside the cells), cap ${usd(m.cap_usd)}.`,
    `Readers ${m.readers.join(', ')} at effort ${m.effort}; prices from eval/runner/budget-ledger.ts; token assumptions in eval/runner/q1/cells/q1-cells.json.`, '',
    '| Block | PLAN §7 | Estimate | Hard cap (1.5x) |', '|---|---:|---:|---:|', ...m.blocks.map(b => `| ${b.label} | ${usd(b.plan_usd)} | ${usd(b.estimate_usd)} | ${usd(b.cap_usd)} |`),
    `| Total (cells) | ${usd(m.plan_total_usd - 260)} | ${usd(m.total_usd)} | |`, '',
    `| Wave | Launch units | Blocks | Expected hours |`, '|---:|---:|---|---:|', ...waves.map(w => `| ${w.w} | ${w.n} | ${w.blocks} | ${w.hours} |`), '',
    '| Cell | Block | System | Configuration | Arms | Shards | Estimate |', '|---|---|---|---|---:|---:|---:|',
    ...m.cells.map(c => `| ${c.id} | ${c.block} | ${c.system} | ${c.configuration} | ${c.arms.length} | ${c.shards} | ${usd(c.estimate.usd)} |`), '',
    'Next: `bun eval/runner/q1/cell.ts plan --campaign-out <file>` writes the campaign manifest the front door reads (`bun run eval:scoreboard plan --campaign <file>`).',
  ].join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────

export function findCell(id: string, m: Manifest = loadManifest()): CellDefinition {
  const c = m.cells.find(x => x.id === id);
  if (c) return c;
  const near = m.cells.filter(x => x.id.includes(id.split('.')[0] ?? '')).slice(0, 5).map(x => x.id);
  throw refuse({ code: 'USAGE', message: `no cell ${id} in ${rel(MANIFEST_PATH)}`, why: 'run, show and merge take a cell id from the generated manifest', fix: { next: 'run', argv: [...FRONT, 'plan'], user_message: near.length ? `did you mean ${near.join(', ')}?` : 'list the cells with plan' } });
}

const usage = (message: string): ScoreboardMessage => ({ code: 'USAGE', message, why: 'the cell runner has four subcommands: plan, show, run, merge', fix: { next: 'run', argv: [...FRONT, 'plan'] } });

/** The paid-run guard for `run` without a lease proxy: --paid and an open ledger run with room for the estimate. */
export function paidGuard(argv: string[], def: CellDefinition, limit: number | null): number {
  const estimate = Math.round((limit ? def.estimate.usd * Math.min(1, limit / SETS[def.set].questions) + (def.estimate.lines.ingest ?? 0) : def.estimate.usd) * 100) / 100;
  try { requirePaidArm(argv, { arm: `q1 cell ${def.id}`, estimateUsd: estimate, ledgerPath: budgetOptionsFrom(argv).ledgerPath }); }
  catch (e) {
    if (!(e instanceof PaidArmRefusal)) throw e;
    throw refuse({ code: 'PAID_FLAGS_MISSING', message: e.message, why: 'a cell calls paid readers, judges and (for some systems) embeddings; every paid request is reserved in the budget ledger first, or charged to a lease proxy\'s lease',
      fix: { next: 'ask_user', user_message: `Cell ${def.id} is estimated at $${estimate.toFixed(2)}. Ask whether to open a ledger run for it (bun eval/runner/budget-ledger.ts open --runner q1-${def.block} --budget-usd <dollars>), then rerun with --paid --budget-run-id <id>.`, verify: ['bun', 'eval/runner/budget-ledger.ts', 'status'] },
      state: { estimate_usd: estimate, block: def.block } });
  }
  return estimate;
}

export async function main(argv: string[]): Promise<number> {
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const many = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
  const json = argv.includes('--json');
  const sub = argv[0];
  if (sub === 'plan') {
    const m = loadManifest();
    const campaignOut = one('--campaign-out');
    if (campaignOut) { writeAtomic(resolve(campaignOut), JSON.stringify(campaignManifest(m, { smoke: argv.includes('--with-smoke') }), null, 2) + '\n'); console.error(`campaign manifest written to ${campaignOut}; next: bun run eval:scoreboard plan --campaign ${campaignOut}`); }
    console.log(json ? JSON.stringify({ ...m, waves: campaignCells(m).map(c => ({ id: c.id, wave: c.wave, lease_usd: c.lease_usd })) }, null, 2) : renderPlan(m));
    return 0;
  }
  if (sub === 'show') {
    const id = one('--cell');
    if (!id) throw refuse(usage('show needs --cell <id>'));
    const c = findCell(id);
    if (json) { console.log(JSON.stringify(c, null, 2)); return 0; }
    console.log([`${c.id}: ${c.system} (${c.configuration}) on ${c.set} (${c.benchmark}, split ${c.split}), block ${c.block}, ${c.runner}, estimate $${c.estimate.usd.toFixed(2)}`,
      ...c.arms.map(a => `  ${a.cell_id}: ${a.mode}${a.budget ? ` ${a.budget}` : ''}${a.policy ? ` (${a.policy})` : ''}, readers ${a.readers.join(', ') || 'none'}${Object.keys(a.reader_replicates).length ? `, replicates ${JSON.stringify(a.reader_replicates)}` : ''}${a.frontier ? `, frontier ${a.frontier.judges.join('+')}${a.frontier.sample ? ` on ${a.frontier.sample} questions` : ''}` : ''}${a.judge_repeats ? `, ${a.judge_repeats.count} judge repeats (eval/runner/judge-repeat.ts)` : ''}`),
      `  run: ${[...FRONT, 'run', '--cell', c.id, '--paid', '--budget-run-id', '<id>'].join(' ')}`].join('\n'));
    return 0;
  }
  if (sub === 'run' || sub === 'merge') {
    const id = one('--cell');
    if (!id) throw refuse(usage(`${sub} needs --cell <id>`));
    const def = findCell(id);
    const out = resolve(one('--out') ?? process.env.SHOOTOUT_OUT ?? join(REPO_ROOT, 'eval/reports/q1', def.id));
    if (sub === 'merge') {
      const from = many('--from').map(f => resolve(f));
      if (!from.length) throw refuse(usage('merge needs --from <shard out dir>...'));
      const corpus = loadCorpus(def.benchmark);
      const selected = selectCellQuestions(corpus.questions.filter(q => splitConversations(def.benchmark, def.split, corpus).has(q.conversation)), def.selection);
      const capabilities = JSON.parse(readFileSync(join(from[0], 'cells', def.arms[0].cell_id, 'receipt.json'), 'utf8')).system.capabilities as CapabilityRecord;
      const configs = new Map(def.arms.map(a => { const t = readFileSync(join(from[0], 'cells', a.cell_id, 'run-config.json'), 'utf8'); writeAtomic(join(out, 'cells', a.cell_id, 'run-config.json'), t); return [a.id, { text: t, sha: sha256(t) }]; }));
      const res = publishCell(def, def.arms, from, out, { instrument: instrumentFor(def.canonical_instrument), selected, invalidReasons: [], configs, capabilities, stopped: null, maxAttempts: DEFAULT_MAX_ATTEMPTS });
      console.log(JSON.stringify(res, null, 2));
      return res.every(r => r.status === 'complete') ? 0 : 4;
    }
    const limit = one('--limit') ? Number(one('--limit')) : null;
    const proxy = (one('--provider-proxy') ?? process.env.SHOOTOUT_PROXY ?? '').replace(/\/$/, '') || null;
    if (!proxy) {
      paidGuard(argv, def, limit);
      startPaidRun(`q1-cell:${def.id}`, { ...budgetOptionsFrom(argv), estimateUsd: def.estimate.usd });
    }
    const shardRaw = one('--shard') ?? '0/1';
    const [si, sn] = shardRaw.split('/').map(Number);
    if (!Number.isInteger(si) || !Number.isInteger(sn) || sn < 1 || si < 0 || si >= sn) throw refuse(usage('--shard must look like i/n with 0 <= i < n'));
    const result = await runCell(def, { out, limit, shard: { index: si, count: sn }, arms: one('--arms')?.split(',') ?? null, systemUrl: one('--system-url') ?? null, providerProxy: proxy,
      maxAttempts: one('--max-attempts') ? Number(one('--max-attempts')) : undefined, frontier: !argv.includes('--no-frontier'),
      finishTimeoutS: one('--finish-timeout-s') ? Number(one('--finish-timeout-s')) : undefined, probeTimeoutMs: one('--probe-timeout-s') ? Number(one('--probe-timeout-s')) * 1000 : undefined });
    const agg = one('--aggregates');
    if (agg) writeAtomic(resolve(agg), JSON.stringify(cellAggregates(result.arms), null, 2) + '\n');
    console.log(json ? JSON.stringify(result, null, 2) : `${def.id} ${result.status}${result.stopped ? ` (stopped: ${result.stopped})` : ''}: ${result.arms.map(a => `${a.cell_id} ${a.status} ${a.answers} answers`).join('; ')}; out ${out}`);
    return result.status === 'complete' ? 0 : 4;
  }
  throw refuse(usage(sub ? `unknown subcommand ${sub}` : 'a subcommand is required'));
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (e) {
    if (e instanceof ScoreboardError) { process.stderr.write(renderMessage(e.op) + '\n'); process.exit(exitCodeOf(e.op)); }
    if (e instanceof DecideError) { process.stderr.write(renderOperatorMessage(e.op) + '\n'); process.exit(e.op.fix.next === 'ask_user' ? 3 : 2); }
    throw e;
  }
}
