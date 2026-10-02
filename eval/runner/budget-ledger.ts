/**
 * Paid-run budget ledger (plan section 4 item 11, amendment 10).
 *
 * A durable JSON ledger of every paid request any runner makes. Before a
 * request leaves the process, the runner reserves its worst-case cost; after
 * the response it reconciles the reservation to the provider-reported usage.
 * A reservation that cannot be reconciled (no usage in the response, a
 * network failure after send, a crash) keeps its reserved amount, so the
 * ledger can only overstate spend.
 *
 * Two caps apply to every reservation:
 *   program cap   default $500 across all runs in the ledger (--program-cap-usd
 *                 or BRAINBENCH_PROGRAM_CAP_USD to lower or raise it);
 *   run budget    --budget-usd (or BRAINBENCH_BUDGET_USD) for this run.
 * A reservation that would cross either cap throws BudgetExceededError and
 * the request is never sent. A run cannot open when its budget exceeds what
 * is left of the program cap.
 *
 * installPaidRequestGuard wraps globalThis.fetch, so every request to a paid
 * provider host is reserved, including SDK retries (each retry is a fetch)
 * and calls gbrain makes internally (write-side extraction, synthesis,
 * embeddings). Cached work that never reaches fetch costs nothing and
 * reserves nothing.
 *
 * Ledger path: .budget/ledger.json at the repository root (gitignored), or
 * --budget-ledger / BRAINBENCH_BUDGET_LEDGER. Writes hold a lock file and go
 * through a temp file and rename, so concurrent runners and crashes cannot
 * lose or corrupt entries.
 *
 * Shared runs: a wrapper that starts several worker processes (for example
 * longmemeval-batch.sh) opens ONE run with `open` and passes its id to every
 * worker as --budget-run-id (or BRAINBENCH_BUDGET_RUN_ID). Each worker joins
 * that run instead of opening its own, so --budget-usd caps the workers
 * together, across restarted batches too. A joined worker's summary covers
 * only its own requests; only the opener closes the run.
 *
 *   bun eval/runner/budget-ledger.ts status [--budget-ledger <path>]
 *   bun eval/runner/budget-ledger.ts open --runner <name> --budget-usd <n> [--estimate-usd <n>]
 *   bun eval/runner/budget-ledger.ts close --budget-run-id <id>
 */

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalLookup } from 'gbrain/core/model-pricing';
import { lookupEmbeddingPrice } from '../../node_modules/gbrain/src/core/embedding-pricing.ts';

export const DEFAULT_PROGRAM_CAP_USD = 500;
export const DEFAULT_LEDGER_PATH = resolve(import.meta.dir, '../../.budget/ledger.json');
const LOCK_STALE_MS = 30_000;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface LedgerEntry {
  id: string;
  run_id: string;
  description: string;
  reserved_usd: number;
  /** Provider-reported cost; null while open. */
  actual_usd: number | null;
  status: 'reserved' | 'reconciled' | 'charged-reservation';
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  settled_at: string | null;
  /** Process that made the request, when several processes share one run. */
  participant?: string;
}

export interface LedgerRun {
  run_id: string;
  runner: string;
  budget_usd: number;
  estimate_usd: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface LedgerFile {
  schema_version: 1;
  program_cap_usd: number;
  runs: LedgerRun[];
  entries: LedgerEntry[];
}

/** Spend that counts against a cap: settled actual cost, or the full reservation while unsettled. */
const committed = (e: LedgerEntry) => e.actual_usd ?? e.reserved_usd;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(ledgerPath: string, fn: () => T): T {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const lock = `${ledgerPath}.lock`;
  const deadline = Date.now() + 20_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try { fd = openSync(lock, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true }); } catch { /* raced with its owner */ }
      if (Date.now() > deadline) throw new Error(`budget ledger lock held too long: ${lock}`);
      sleepSync(25);
    }
  }
  try { return fn(); }
  finally { closeSync(fd); rmSync(lock, { force: true }); }
}

function readLedger(ledgerPath: string, programCapUsd: number): LedgerFile {
  if (!existsSync(ledgerPath)) return { schema_version: 1, program_cap_usd: programCapUsd, runs: [], entries: [] };
  const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerFile;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.runs) || !Array.isArray(parsed.entries)) {
    throw new Error(`unreadable budget ledger at ${ledgerPath}; refusing to spend without it`);
  }
  return { ...parsed, program_cap_usd: programCapUsd };
}

function writeLedger(ledgerPath: string, ledger: LedgerFile): void {
  const tmp = `${ledgerPath}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, JSON.stringify(ledger, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, ledgerPath);
}

export interface LedgerTotals {
  program_cap_usd: number;
  committed_usd: number;
  reconciled_usd: number;
  open_reservations_usd: number;
  remaining_usd: number;
  requests: number;
}

export function ledgerTotals(ledger: LedgerFile): LedgerTotals {
  const committedUsd = sum(ledger.entries.map(committed));
  return {
    program_cap_usd: ledger.program_cap_usd,
    committed_usd: committedUsd,
    reconciled_usd: sum(ledger.entries.filter(e => e.actual_usd !== null).map(e => e.actual_usd!)),
    open_reservations_usd: sum(ledger.entries.filter(e => e.actual_usd === null).map(e => e.reserved_usd)),
    remaining_usd: ledger.program_cap_usd - committedUsd,
    requests: ledger.entries.length,
  };
}

export interface RunSummary {
  run_id: string;
  budget_usd: number;
  reserved_usd: number;
  actual_usd: number;
  /** Requests whose cost was charged at the reservation because usage was unavailable. */
  charged_reservations: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export class BudgetRun {
  private constructor(
    readonly runId: string,
    readonly budgetUsd: number,
    private ledgerPath: string,
    private programCapUsd: number,
    /** Set when this process joined a run another process opened. */
    readonly participant: string | null = null,
  ) {}

  /** Join an open run another process started; reservations count against that run's budget. */
  static join(options: { runId: string; ledgerPath?: string; programCapUsd?: number }): BudgetRun {
    const programCapUsd = options.programCapUsd ?? DEFAULT_PROGRAM_CAP_USD;
    const ledgerPath = resolve(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
    const run = readLedger(ledgerPath, programCapUsd).runs.find(r => r.run_id === options.runId);
    if (!run) throw new BudgetExceededError(`no budget run ${options.runId} in ${ledgerPath}`);
    if (run.finished_at !== null) throw new BudgetExceededError(`budget run ${options.runId} already finished`);
    return new BudgetRun(run.run_id, run.budget_usd, ledgerPath, programCapUsd, `${process.pid}-${randomUUID().slice(0, 8)}`);
  }

  /** Open a run, refusing when its budget exceeds what is left of the program cap. */
  static open(options: { runner: string; budgetUsd: number; estimateUsd?: number | null; ledgerPath?: string; programCapUsd?: number }): BudgetRun {
    const programCapUsd = options.programCapUsd ?? DEFAULT_PROGRAM_CAP_USD;
    const ledgerPath = resolve(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
    if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new BudgetExceededError('--budget-usd must be a positive number of dollars');
    if (options.estimateUsd != null && options.estimateUsd > options.budgetUsd) {
      throw new BudgetExceededError(`estimated cost $${options.estimateUsd.toFixed(2)} exceeds --budget-usd $${options.budgetUsd.toFixed(2)}`);
    }
    const runId = `${options.runner}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    withLock(ledgerPath, () => {
      const ledger = readLedger(ledgerPath, programCapUsd);
      const totals = ledgerTotals(ledger);
      if (options.budgetUsd > totals.remaining_usd) {
        throw new BudgetExceededError(`run budget $${options.budgetUsd.toFixed(2)} exceeds the $${totals.remaining_usd.toFixed(2)} left of the $${programCapUsd.toFixed(2)} program cap (${ledgerPath})`);
      }
      ledger.runs.push({ run_id: runId, runner: options.runner, budget_usd: options.budgetUsd, estimate_usd: options.estimateUsd ?? null, started_at: new Date().toISOString(), finished_at: null });
      writeLedger(ledgerPath, ledger);
    });
    return new BudgetRun(runId, options.budgetUsd, ledgerPath, programCapUsd);
  }

  /** Reserve before sending. Throws BudgetExceededError, and records nothing, when either cap would be crossed. */
  reserve(usd: number, description: string): string {
    if (!Number.isFinite(usd) || usd < 0) throw new BudgetExceededError(`cannot reserve a non-finite or negative cost for ${description}`);
    const id = randomUUID();
    withLock(this.ledgerPath, () => {
      const ledger = readLedger(this.ledgerPath, this.programCapUsd);
      const runCommitted = sum(ledger.entries.filter(e => e.run_id === this.runId).map(committed));
      if (runCommitted + usd > this.budgetUsd) {
        throw new BudgetExceededError(`${description}: reserving $${usd.toFixed(4)} would take this run to $${(runCommitted + usd).toFixed(4)}, over its $${this.budgetUsd.toFixed(2)} budget`);
      }
      const programCommitted = ledgerTotals(ledger).committed_usd;
      if (programCommitted + usd > this.programCapUsd) {
        throw new BudgetExceededError(`${description}: reserving $${usd.toFixed(4)} would take the program to $${(programCommitted + usd).toFixed(4)}, over its $${this.programCapUsd.toFixed(2)} cap`);
      }
      ledger.entries.push({ id, run_id: this.runId, description, reserved_usd: usd, actual_usd: null, status: 'reserved',
        input_tokens: null, output_tokens: null, created_at: new Date().toISOString(), settled_at: null,
        ...(this.participant ? { participant: this.participant } : {}) });
      writeLedger(this.ledgerPath, ledger);
    });
    return id;
  }

  /**
   * Settle a reservation. With a measured cost the entry is reconciled; with
   * null the reservation itself is charged (usage unknown: never undercount).
   */
  settle(id: string, actual: { usd: number; input_tokens?: number | null; output_tokens?: number | null } | null): void {
    withLock(this.ledgerPath, () => {
      const ledger = readLedger(this.ledgerPath, this.programCapUsd);
      const entry = ledger.entries.find(e => e.id === id && e.run_id === this.runId);
      if (!entry) throw new Error(`unknown budget reservation ${id}`);
      if (entry.actual_usd !== null) throw new Error(`budget reservation ${id} already settled`);
      entry.actual_usd = actual ? actual.usd : entry.reserved_usd;
      entry.status = actual ? 'reconciled' : 'charged-reservation';
      entry.input_tokens = actual?.input_tokens ?? null;
      entry.output_tokens = actual?.output_tokens ?? null;
      entry.settled_at = new Date().toISOString();
      writeLedger(this.ledgerPath, ledger);
    });
  }

  summary(): RunSummary {
    const ledger = readLedger(this.ledgerPath, this.programCapUsd);
    const entries = ledger.entries.filter(e => e.run_id === this.runId && (this.participant === null || e.participant === this.participant));
    return {
      run_id: this.runId, budget_usd: this.budgetUsd,
      reserved_usd: sum(entries.map(e => e.reserved_usd)),
      actual_usd: sum(entries.map(committed)),
      charged_reservations: entries.filter(e => e.status !== 'reconciled').length,
      requests: entries.length,
      input_tokens: sum(entries.map(e => e.input_tokens ?? 0)),
      output_tokens: sum(entries.map(e => e.output_tokens ?? 0)),
    };
  }

  close(): RunSummary {
    if (this.participant !== null) return this.summary();
    withLock(this.ledgerPath, () => {
      const ledger = readLedger(this.ledgerPath, this.programCapUsd);
      const run = ledger.runs.find(r => r.run_id === this.runId);
      if (run) run.finished_at = new Date().toISOString();
      writeLedger(this.ledgerPath, ledger);
    });
    return this.summary();
  }
}

// ─── Request pricing ────────────────────────────────────────────────

/** Hosts whose requests cost money. */
const PAID_HOSTS: Record<string, 'openai' | 'anthropic' | 'voyage' | 'openrouter'> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'api.voyageai.com': 'voyage',
  'openrouter.ai': 'openrouter',
};

/** Output-token allowance for a chat request that names no limit. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Reranker list prices, USD per 1M tokens (voyageai.com/pricing, checked 2026-09-30). */
const RERANK_PRICES: Record<string, number> = {
  'voyage:rerank-2.5': 0.05,
  'voyage:rerank-2.5-lite': 0.02,
};

/**
 * Chat list prices, USD per 1M tokens, checked against the providers' pricing
 * pages on 2026-10-02. They take precedence over the pinned gbrain table,
 * which lacks newer models and lists stale prices for some (gpt-5.5, gpt-5.2).
 * Cache prices apply when the response reports cached tokens.
 */
export const CHAT_PRICE_OVERRIDES: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
  'anthropic:claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  'anthropic:claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'anthropic:claude-sonnet-4-6': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'anthropic:claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'anthropic:claude-opus-4-6': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'anthropic:claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  'anthropic:claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'openai:gpt-5.2': { input: 1.75, output: 14, cache_read: 0.175 },
  'openai:gpt-5.4': { input: 2.5, output: 15, cache_read: 0.25 },
  'openai:gpt-5.4-mini': { input: 0.75, output: 4.5, cache_read: 0.075 },
  'openai:gpt-5.5': { input: 5, output: 30, cache_read: 0.5 },
  'openai:gpt-6-sol': { input: 2, output: 10, cache_read: 0.2 },
  'openai:gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
  'openai:gpt-6-astra': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
};

/** A dated API snapshot (`gpt-4o-2024-08-06`) is billed at its family's list price. */
const chatPrice = (id: string) => {
  const undated = id.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
  return CHAT_PRICE_OVERRIDES[id] ?? CHAT_PRICE_OVERRIDES[undated] ?? canonicalLookup(id) ?? canonicalLookup(undated);
};

interface RequestPrice {
  provider: string;
  model: string;
  kind: 'chat' | 'embedding' | 'rerank';
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** USD per 1M cached input tokens read / written, when the provider reports them. */
  cache_read?: number;
  cache_write?: number;
  /** Conservative input-token estimate (3 bytes per token). */
  inputTokens: number;
  maxOutputTokens: number;
}

function textBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value)) return sum(value.map(textBytes));
  if (value && typeof value === 'object') return sum(Object.values(value).map(textBytes));
  return 0;
}

/** Price a request from its URL and JSON body. Returns null for a free host; throws for an unpriceable paid request. */
export function priceRequest(url: string, body: unknown): RequestPrice | null {
  const provider = PAID_HOSTS[new URL(url).hostname];
  if (!provider) return null;
  // Model listings are free metadata reads (providers' key probes use them).
  if (/\/models(\/[^/]+)?\/?$/.test(new URL(url).pathname) && (body === undefined || body === null)) return null;
  const b = (body ?? {}) as Record<string, unknown>;
  const model = typeof b.model === 'string' ? b.model : '';
  if (!model) throw new BudgetExceededError(`paid request to ${url} names no model; cannot reserve its cost`);
  const path = new URL(url).pathname;
  if (/\/rerank/.test(path)) {
    const perMTok = RERANK_PRICES[`${provider}:${model}`];
    if (perMTok === undefined) throw new BudgetExceededError(`no rerank price for ${provider}:${model}; cannot reserve its cost`);
    const documents = Array.isArray(b.documents) ? b.documents : [];
    const inputTokens = Math.ceil((textBytes(b.query) * Math.max(1, documents.length) + textBytes(documents)) / 3) + 16;
    return { provider, model, kind: 'rerank', input: perMTok, output: 0, inputTokens, maxOutputTokens: 0 };
  }
  const embedding = /embeddings|\/embed/.test(path);
  const input = embedding ? b.input ?? b.texts : [b.system, b.messages, b.prompt, b.input];
  const inputTokens = Math.ceil(textBytes(input) / 3) + 16;
  if (embedding) {
    const price = lookupEmbeddingPrice(`${provider}:${model}`);
    if (price.kind !== 'known') throw new BudgetExceededError(`no embedding price for ${provider}:${model}; cannot reserve its cost`);
    return { provider, model, kind: 'embedding', input: price.pricePerMTok, output: 0, inputTokens, maxOutputTokens: 0 };
  }
  const maxOutputTokens = [b.max_tokens, b.max_completion_tokens, b.max_output_tokens].find(v => typeof v === 'number') as number | undefined ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (provider === 'openrouter') {
    const maxPrice = (b.provider as { max_price?: { prompt?: number; completion?: number } } | undefined)?.max_price;
    if (typeof maxPrice?.prompt !== 'number' || typeof maxPrice.completion !== 'number') {
      throw new BudgetExceededError(`OpenRouter request for ${model} sets no provider.max_price; cannot bound its cost`);
    }
    return { provider, model, kind: 'chat', input: maxPrice.prompt, output: maxPrice.completion, inputTokens, maxOutputTokens };
  }
  const price = chatPrice(`${provider}:${model}`);
  if (!price) throw new BudgetExceededError(`no chat price for ${provider}:${model}; cannot reserve its cost`);
  return { provider, model, kind: 'chat', input: price.input, output: price.output, cache_read: price.cache_read, cache_write: price.cache_write, inputTokens, maxOutputTokens };
}

/** Worst-case reservation: input estimate plus the full output allowance. */
export function reservationUsd(price: RequestPrice): number {
  return (price.inputTokens * price.input + price.maxOutputTokens * price.output) / 1e6;
}

/** Cost from provider-reported usage, or null when the response carries none. */
export function usageCost(price: RequestPrice, responseBody: unknown): { usd: number; input_tokens: number; output_tokens: number } | null {
  const usage = (responseBody as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const n = (key: string) => (typeof usage[key] === 'number' ? usage[key] as number : 0);
  const inputTokens = n('input_tokens') + n('prompt_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')
    + (usage.input_tokens === undefined && usage.prompt_tokens === undefined ? n('total_tokens') : 0);
  const outputTokens = n('output_tokens') + n('completion_tokens');
  if (inputTokens === 0 && outputTokens === 0) return null;
  const reported = price.provider === 'openrouter' && typeof usage.cost === 'number' ? usage.cost as number : null;
  if (reported !== null) return { usd: reported, input_tokens: inputTokens, output_tokens: outputTokens };
  // Cached input: Anthropic reports reads and writes beside input_tokens; OpenAI counts cached tokens inside input_tokens.
  const details = (usage.input_tokens_details ?? usage.prompt_tokens_details) as Record<string, unknown> | undefined;
  const openaiCached = typeof details?.cached_tokens === 'number' ? details.cached_tokens as number : 0;
  const cacheRead = n('cache_read_input_tokens') + openaiCached;
  const cacheWrite = n('cache_creation_input_tokens');
  const usd = ((inputTokens - cacheRead - cacheWrite) * price.input + cacheRead * (price.cache_read ?? price.input)
    + cacheWrite * (price.cache_write ?? price.input) + outputTokens * price.output) / 1e6;
  return { usd, input_tokens: inputTokens, output_tokens: outputTokens };
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (typeof raw !== 'string') return raw === undefined ? undefined : null;
  try { return JSON.parse(raw); } catch { return null; }
}

export interface PaidRequestGuard {
  uninstall(): void;
  /** Set once a reservation is refused; runners stop scheduling paid work. */
  readonly exhausted: boolean;
}

/**
 * Provider SDKs capture `fetch` when they are imported or constructed (the
 * Anthropic SDKs do; the AI SDK reads globalThis.fetch per request). A guard
 * installed later would never see their requests. So this module replaces
 * globalThis.fetch with a delegating fetch as soon as it is evaluated, and a
 * guard only switches the delegate. Runners import this module before any
 * gbrain or SDK module so every captured reference is the delegate.
 */
const baseFetch = globalThis.fetch;
let active: { handle: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } | null = null;
const delegatingFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => (active ? active.handle(input, init) : baseFetch(input, init)),
  { preconnect: baseFetch.preconnect?.bind(baseFetch) },
) as typeof fetch;
globalThis.fetch = delegatingFetch;

/**
 * Route every fetch to a paid host through the ledger: price, reserve, send,
 * then reconcile from the response usage. A refused reservation rejects the
 * fetch with BudgetExceededError before anything is sent. One guard at a time.
 */
export function installPaidRequestGuard(run: BudgetRun, options: { fetchImpl?: typeof fetch } = {}): PaidRequestGuard {
  if (active) throw new Error('a paid-request guard is already installed in this process');
  const previous = globalThis.fetch;
  const send = options.fetchImpl ?? (previous === delegatingFetch ? baseFetch : previous);
  const state = { exhausted: false };
  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = await requestBody(input, init);
    let price: RequestPrice | null;
    let id: string;
    try {
      price = priceRequest(url, body);
      if (!price) return send(input, init);
      id = run.reserve(reservationUsd(price), `${price.provider}:${price.model} ${price.kind}`);
    } catch (error) {
      if (error instanceof BudgetExceededError) state.exhausted = true;
      throw error;
    }
    let response: Response;
    try { response = await send(input, init); }
    catch (error) { run.settle(id, null); throw error; }
    let cost: ReturnType<typeof usageCost> = null;
    if (!(response.headers.get('content-type') ?? '').includes('event-stream')) {
      try { cost = usageCost(price, await response.clone().json()); } catch { cost = null; }
    }
    run.settle(id, cost);
    return response;
  };
  const guard = { handle };
  active = guard;
  globalThis.fetch = delegatingFetch;
  return {
    uninstall() {
      if (active !== guard) return;
      active = null;
      globalThis.fetch = previous;
    },
    get exhausted() { return state.exhausted; },
  };
}

// ─── Runner flags ───────────────────────────────────────────────────

export interface BudgetOptions {
  budgetUsd: number | null;
  ledgerPath: string;
  programCapUsd: number;
  /** Join this already-open run instead of opening one (--budget-run-id / BRAINBENCH_BUDGET_RUN_ID). */
  runId?: string | null;
}

/** Read --budget-usd, --budget-ledger and --program-cap-usd, falling back to BRAINBENCH_* env vars. */
export function budgetOptionsFrom(argv: readonly string[], env: Record<string, string | undefined> = process.env): BudgetOptions {
  const flag = (name: string) => {
    const eq = argv.find(a => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const number = (raw: string | undefined, name: string) => {
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of dollars (got ${JSON.stringify(raw)})`);
    return value;
  };
  return {
    budgetUsd: number(flag('--budget-usd') ?? env.BRAINBENCH_BUDGET_USD, '--budget-usd'),
    ledgerPath: resolve(flag('--budget-ledger') ?? env.BRAINBENCH_BUDGET_LEDGER ?? DEFAULT_LEDGER_PATH),
    programCapUsd: number(flag('--program-cap-usd') ?? env.BRAINBENCH_PROGRAM_CAP_USD, '--program-cap-usd') ?? DEFAULT_PROGRAM_CAP_USD,
    runId: flag('--budget-run-id') ?? env.BRAINBENCH_BUDGET_RUN_ID ?? null,
  };
}

/**
 * Start guarded paid work for a runner: print the estimate, refuse without
 * --budget-usd, open the run and install the fetch guard.
 */
export function startPaidRun(runner: string, options: BudgetOptions & { estimateUsd: number | null; log?: (line: string) => void }): { run: BudgetRun; guard: PaidRequestGuard } {
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
  log(`[budget] ${runner}: estimated cost ${options.estimateUsd === null ? 'unmeasured' : `$${options.estimateUsd.toFixed(2)}`}; ledger ${options.ledgerPath}`);
  if (options.runId) {
    const run = BudgetRun.join({ runId: options.runId, ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd });
    log(`[budget] ${runner}: joined shared run ${run.runId} ($${run.budgetUsd.toFixed(2)} across all of its workers)`);
    return { run, guard: installPaidRequestGuard(run) };
  }
  if (options.budgetUsd === null) throw new BudgetExceededError(`${runner} makes paid requests; pass --budget-usd <dollars> (or BRAINBENCH_BUDGET_USD) to authorize a cap`);
  const run = BudgetRun.open({ runner, budgetUsd: options.budgetUsd, estimateUsd: options.estimateUsd, ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd });
  return { run, guard: installPaidRequestGuard(run) };
}

/** Receipt v2 cost block from a closed run. */
export function receiptCost(summary: RunSummary): { usd: number; input_tokens: number; output_tokens: number; basis: string } {
  return {
    usd: Number(summary.actual_usd.toFixed(6)), input_tokens: summary.input_tokens, output_tokens: summary.output_tokens,
    basis: `budget ledger ${summary.run_id}: ${summary.requests} paid requests, ${summary.charged_reservations} charged at their reservation because usage was unavailable`,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [command] = argv;
  const options = budgetOptionsFrom(argv);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (command === 'status') {
    const ledger = readLedger(options.ledgerPath, options.programCapUsd);
    console.log(JSON.stringify({ ledger: options.ledgerPath, ...ledgerTotals(ledger), runs: ledger.runs.length }, null, 2));
  } else if (command === 'open' && flag('--runner') && options.budgetUsd !== null) {
    const estimate = flag('--estimate-usd');
    const run = BudgetRun.open({ runner: flag('--runner')!, budgetUsd: options.budgetUsd, estimateUsd: estimate === undefined ? null : Number(estimate), ledgerPath: options.ledgerPath, programCapUsd: options.programCapUsd });
    console.log(run.runId);
  } else if (command === 'close' && options.runId) {
    const ledger = readLedger(options.ledgerPath, options.programCapUsd);
    const record = ledger.runs.find(r => r.run_id === options.runId);
    if (!record) throw new Error(`no budget run ${options.runId} in ${options.ledgerPath}`);
    withLock(options.ledgerPath, () => {
      const fresh = readLedger(options.ledgerPath, options.programCapUsd);
      const run = fresh.runs.find(r => r.run_id === options.runId)!;
      run.finished_at ??= new Date().toISOString();
      writeLedger(options.ledgerPath, fresh);
    });
    const entries = readLedger(options.ledgerPath, options.programCapUsd).entries.filter(e => e.run_id === options.runId);
    console.log(JSON.stringify({ run_id: options.runId, budget_usd: record.budget_usd, requests: entries.length, actual_usd: sum(entries.map(committed)) }));
  } else {
    console.error('usage: bun eval/runner/budget-ledger.ts status | open --runner <name> --budget-usd <n> [--estimate-usd <n>] | close --budget-run-id <id>   [--budget-ledger <path>] [--program-cap-usd <n>]');
    process.exit(2);
  }
}
