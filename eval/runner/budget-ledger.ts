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
 *   bun eval/runner/budget-ledger.ts status [--budget-ledger <path>]
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
  private constructor(readonly runId: string, readonly budgetUsd: number, private ledgerPath: string, private programCapUsd: number) {}

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
        input_tokens: null, output_tokens: null, created_at: new Date().toISOString(), settled_at: null });
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
    const entries = ledger.entries.filter(e => e.run_id === this.runId);
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

interface RequestPrice {
  provider: string;
  model: string;
  kind: 'chat' | 'embedding';
  /** USD per 1M tokens. */
  input: number;
  output: number;
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
  const b = (body ?? {}) as Record<string, unknown>;
  const model = typeof b.model === 'string' ? b.model : '';
  if (!model) throw new BudgetExceededError(`paid request to ${url} names no model; cannot reserve its cost`);
  const path = new URL(url).pathname;
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
  const price = canonicalLookup(`${provider}:${model}`);
  if (!price) throw new BudgetExceededError(`no chat price for ${provider}:${model}; cannot reserve its cost`);
  return { provider, model, kind: 'chat', input: price.input, output: price.output, inputTokens, maxOutputTokens };
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
  return { usd: reported ?? (inputTokens * price.input + outputTokens * price.output) / 1e6, input_tokens: inputTokens, output_tokens: outputTokens };
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
  };
}

/**
 * Start guarded paid work for a runner: print the estimate, refuse without
 * --budget-usd, open the run and install the fetch guard.
 */
export function startPaidRun(runner: string, options: BudgetOptions & { estimateUsd: number | null; log?: (line: string) => void }): { run: BudgetRun; guard: PaidRequestGuard } {
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
  log(`[budget] ${runner}: estimated cost ${options.estimateUsd === null ? 'unmeasured' : `$${options.estimateUsd.toFixed(2)}`}; ledger ${options.ledgerPath}`);
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
  const [command] = process.argv.slice(2);
  const options = budgetOptionsFrom(process.argv.slice(2));
  if (command !== 'status') {
    console.error('usage: bun eval/runner/budget-ledger.ts status [--budget-ledger <path>] [--program-cap-usd <n>]');
    process.exit(2);
  }
  const ledger = readLedger(options.ledgerPath, options.programCapUsd);
  console.log(JSON.stringify({ ledger: options.ledgerPath, ...ledgerTotals(ledger), runs: ledger.runs.length }, null, 2));
}

