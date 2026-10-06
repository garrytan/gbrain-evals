/**
 * Exactly-once batch submission with ledger-backed execution.
 *
 * Every submission follows one order, each step durable before the next:
 *
 *   1. intent    write an intent record (arm, request set hash, custom ids,
 *                counted input tokens) in the lane's state database;
 *   2. reserve   reserve the batch's worst case in the round's ledger, with
 *                the intent id in the reservation's description;
 *   3. prepare   upload the input file where the provider needs one;
 *   4. sending   mark the intent as about to submit;
 *   5. create    submit, carrying the intent id (OpenAI batch `metadata`,
 *                Anthropic `custom_id` prefix);
 *   6. submitted store the provider's batch id.
 *
 * On restart, `reconcile` runs before anything is submitted. An intent that
 * never reached "sending" was provably not sent: its reservation is released.
 * An intent marked "sending" without a batch id is matched against the
 * provider's batch list; a single match is adopted, and anything else becomes
 * "unknown": never resubmitted automatically and its reservation never
 * released on a timeout, until an operator resolves it.
 *
 * `poll` collects ended batches: results join to the intent by custom id
 * (duplicates must agree; unknown ids refuse; absent ids are recorded as
 * missing), are stored, and the reservation settles to provider usage at list
 * price times the factor the intent reserved at. A pilot's settlement records
 * whether the provider's own accounting confirms the batch discount.
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BudgetExceededError, BudgetRun, readLedger, runInBatchLane, type RequestPrice } from '../budget-ledger.ts';
import { checkBody, sha256, type ArmManifest, type Provider } from './manifest.ts';
import { batchReservationUsd, confirmFactor, priceOf, rowCost, worstCaseListUsd, type FactorEvidence } from './ledger.ts';
import type { BatchStatus, BatchTransport, NormalizedResult } from './transport.ts';

/** Test seams for crash tests. Production code never sets them. */
export const laneTestHooks: {
  afterCreate?: (batch: BatchStatus) => void;
  afterResultsStored?: () => void;
  afterLedgerSettle?: () => void;
} = {};

export type IntentState = 'prepared' | 'sending' | 'submitted' | 'ended' | 'settled' | 'unknown' | 'abandoned';

export interface IntentItem { question_id: string; custom_id: string; body_sha256: string; input_tokens: number; worst_list_usd: number }

export interface Intent {
  intent_id: string;
  arm_id: string;
  provider: Provider;
  model: string;
  pilot: boolean;
  request_set_hash: string;
  items: IntentItem[];
  factor: number;
  price: RequestPrice;
  budget_run_id: string;
  reservation_id: string | null;
  reserved_usd: number;
  file_handle: string | null;
  state: IntentState;
  batch_id: string | null;
  created_at: number;
  sending_at: number | null;
  settled_usd: number | null;
  note: string | null;
}

export interface StoredResult extends NormalizedResult { arm_id: string; question_id: string; intent_id: string; list_usd: number; usd: number; cost_basis: string; recorded_at: number }

export interface PollOutcome { intent_id: string; arm_id: string; batch_id: string | null; state: IntentState; provider_status: string | null; counts: Record<string, number>; settled_usd: number | null; failed_question_ids: string[]; factor?: FactorEvidence }

export interface LaneOptions {
  statePath: string;
  transports: Partial<Record<Provider, BatchTransport>>;
  /** The budget run new submissions reserve against (one per workstream). */
  run: BudgetRun;
  /** Settle intents reserved under another budget run (default: BudgetRun.join on the same ledger). */
  joinRun?: (runId: string) => BudgetRun;
  /** Allow a new batch while another is unsettled; the ledger's caps still bound the sum of open reservations. */
  parallel?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/** Input-token margin over the provider's count: Anthropic counts the exact body; OpenAI counts a Responses-shaped equivalent. */
export function marginTokens(provider: Provider, counted: number): number {
  return provider === 'anthropic' ? counted + 16 : Math.ceil(counted * 1.01) + 64;
}

const OPEN_STATES: IntentState[] = ['prepared', 'sending', 'submitted', 'ended', 'unknown'];
/** How far around the "sending" mark a provider batch may be timestamped and still be this intent's. */
const ADOPT_WINDOW_MS = { before: 60_000, after: 15 * 60_000 };

export class BatchLane {
  private db: Database;
  private now: () => number;
  private log: (line: string) => void;
  private runs = new Map<string, BudgetRun>();

  constructor(private options: LaneOptions) {
    mkdirSync(dirname(options.statePath), { recursive: true });
    this.db = new Database(options.statePath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 10000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (intent_id TEXT PRIMARY KEY, arm_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, pilot INTEGER NOT NULL,
        request_set_hash TEXT NOT NULL, items TEXT NOT NULL, factor REAL NOT NULL, price TEXT NOT NULL, budget_run_id TEXT NOT NULL, reservation_id TEXT,
        reserved_usd REAL NOT NULL, file_handle TEXT, state TEXT NOT NULL, batch_id TEXT, created_at INTEGER NOT NULL, sending_at INTEGER,
        submitted_at INTEGER, ended_at INTEGER, settled_at INTEGER, settled_usd REAL, note TEXT);
      CREATE TABLE IF NOT EXISTS results (arm_id TEXT NOT NULL, question_id TEXT NOT NULL, intent_id TEXT NOT NULL, custom_id TEXT NOT NULL, status TEXT NOT NULL,
        text TEXT, finish TEXT, usage TEXT, response_model TEXT, service_tier TEXT, error TEXT, list_usd REAL NOT NULL, usd REAL NOT NULL, cost_basis TEXT NOT NULL,
        recorded_at INTEGER NOT NULL, PRIMARY KEY (arm_id, question_id, intent_id));
      CREATE TABLE IF NOT EXISTS token_counts (body_sha256 TEXT PRIMARY KEY, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, counted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS factors (provider TEXT NOT NULL, model TEXT NOT NULL, factor REAL NOT NULL, confirmed INTEGER NOT NULL, evidence TEXT NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY (provider, model));
    `);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (line => process.stderr.write(`[batch] ${line}\n`));
    this.runs.set(options.run.runId, options.run);
  }

  close(): void { this.db.close(); }

  private runFor(runId: string): BudgetRun {
    let run = this.runs.get(runId);
    if (!run) {
      run = this.options.joinRun?.(runId) ?? BudgetRun.join({ runId, ledgerPath: this.options.run.ledgerPath });
      this.runs.set(runId, run);
    }
    return run;
  }

  private transport(provider: Provider): BatchTransport {
    const t = this.options.transports[provider];
    if (!t) throw new Error(`no ${provider} batch transport configured`);
    return t;
  }

  private row(r: Record<string, any>): Intent {
    return { ...r, pilot: Boolean(r.pilot), items: JSON.parse(r.items), price: JSON.parse(r.price) } as Intent;
  }

  intents(filter: { arm_id?: string; states?: IntentState[] } = {}): Intent[] {
    const rows = this.db.query('SELECT * FROM intents ORDER BY created_at, intent_id').all() as Record<string, any>[];
    return rows.map(r => this.row(r)).filter(i => (!filter.arm_id || i.arm_id === filter.arm_id) && (!filter.states || filter.states.includes(i.state)));
  }

  intent(id: string): Intent {
    const r = this.db.query('SELECT * FROM intents WHERE intent_id = ?').get(id) as Record<string, any> | null;
    if (!r) throw new Error(`no batch intent ${id}`);
    return this.row(r);
  }

  private setState(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    this.db.query(`UPDATE intents SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE intent_id = ?`).run(...(keys.map(k => fields[k]) as any[]), id);
  }

  factorFor(provider: Provider, model: string): { factor: number; confirmed: boolean; evidence: FactorEvidence | null } {
    const r = this.db.query('SELECT factor, confirmed, evidence FROM factors WHERE provider = ? AND model = ?').get(provider, model) as { factor: number; confirmed: number; evidence: string } | null;
    if (!r || !r.confirmed) return { factor: 1, confirmed: false, evidence: r ? JSON.parse(r.evidence) : null };
    return { factor: r.factor, confirmed: true, evidence: JSON.parse(r.evidence) };
  }

  /** Provider-counted input tokens for a body, cached by body hash. */
  async inputTokens(provider: Provider, sha: string, body: Record<string, unknown>): Promise<number> {
    const cached = this.db.query('SELECT input_tokens FROM token_counts WHERE body_sha256 = ?').get(sha) as { input_tokens: number } | null;
    if (cached) return cached.input_tokens;
    const counted = await this.transport(provider).countTokens(body);
    this.db.query('INSERT OR REPLACE INTO token_counts VALUES (?, ?, ?, ?)').run(sha, String(body.model), counted, this.now());
    return counted;
  }

  /** Count every body's input tokens up front (free endpoints), a few at a time. */
  async countAll(provider: Provider, bodies: { sha: string; body: Record<string, unknown> }[], concurrency = 6): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, bodies.length) }, async () => {
      while (next < bodies.length) {
        const b = bodies[next++];
        out.set(b.sha, await this.inputTokens(provider, b.sha, b.body));
      }
    }));
    return out;
  }

  /** Results of an arm: the latest attempt per question, a succeeded attempt winning over failed ones. */
  results(armId: string): Map<string, StoredResult> {
    const rows = this.db.query('SELECT * FROM results WHERE arm_id = ? ORDER BY recorded_at, intent_id').all(armId) as Record<string, any>[];
    const out = new Map<string, StoredResult>();
    for (const r of rows) {
      const res = { ...r, usage: r.usage ? JSON.parse(r.usage) : null } as StoredResult;
      const prev = out.get(r.question_id);
      if (!prev || prev.status !== 'succeeded') out.set(r.question_id, res);
    }
    return out;
  }

  /** Manifest questions with no succeeded result yet (the only ids a resubmission may send). */
  failedQuestionIds(manifest: ArmManifest): string[] {
    const res = this.results(manifest.arm_id);
    const pending = new Set(this.intents({ arm_id: manifest.arm_id, states: OPEN_STATES }).flatMap(i => i.items.map(x => x.question_id)));
    return manifest.requests.map(r => r.question_id).filter(q => res.get(q)?.status !== 'succeeded' && !pending.has(q));
  }

  /** Worst-case reservation a submission would make now, without submitting (dry run). */
  async plan(manifest: ArmManifest, bodies: Map<string, Record<string, unknown>>, opts: { questionIds?: string[]; pilot?: boolean } = {}) {
    const ids = opts.questionIds ?? manifest.requests.map(r => r.question_id);
    const f = opts.pilot ? 1 : this.factorFor(manifest.provider, manifest.model).factor;
    const items = await this.items(manifest, bodies, ids, 'plan');
    return { requests: ids.length, factor: f, reserve_usd: items.reduce((s, i) => s + i.worst_list_usd, 0) * f, list_worst_usd: items.reduce((s, i) => s + i.worst_list_usd, 0), input_tokens: items.reduce((s, i) => s + i.input_tokens, 0) };
  }

  private async items(manifest: ArmManifest, bodies: Map<string, Record<string, unknown>>, ids: string[], intentId: string): Promise<IntentItem[]> {
    const shas = ids.map(q => {
      const body = bodies.get(q);
      if (!body) throw new Error(`${manifest.arm_id}: no request body for ${q}`);
      checkBody(manifest, q, body);
      return { q, sha: manifest.requests.find(r => r.question_id === q)!.body_sha256, body };
    });
    const counts = await this.countAll(manifest.provider, shas.map(s => ({ sha: s.sha, body: s.body })));
    return shas.map(s => {
      const input_tokens = marginTokens(manifest.provider, counts.get(s.sha)!);
      return { question_id: s.q, custom_id: `${intentId}-${s.q}`, body_sha256: s.sha, input_tokens, worst_list_usd: worstCaseListUsd(manifest.provider, s.body, input_tokens) };
    });
  }

  /**
   * Submit one batch for an arm: the whole manifest, or `questionIds` (a pilot,
   * or the failed ids of a settled attempt). Reconciles first; refuses while
   * another batch is unsettled (unless parallel), for completed rows, for a
   * body that differs from the manifest, for a factor the pilot did not
   * confirm when `requireFactor` is set, and when the ledger cannot cover the
   * worst case (nothing is uploaded or submitted then).
   */
  async submit(manifest: ArmManifest, bodies: Map<string, Record<string, unknown>>, opts: { questionIds?: string[]; pilot?: boolean; requireFactor?: number } = {}): Promise<Intent> {
    await this.reconcile();
    const open = this.intents({ states: OPEN_STATES });
    if (open.length && !this.options.parallel) {
      throw new Error(`batch ${open[0].intent_id} for arm ${open[0].arm_id} is ${open[0].state}; arms run one at a time, so settle it first (poll), or resolve it if unknown`);
    }
    const ids = opts.questionIds ?? manifest.requests.map(r => r.question_id);
    if (!ids.length) throw new Error(`${manifest.arm_id}: nothing to submit`);
    if (new Set(ids).size !== ids.length) throw new Error(`${manifest.arm_id}: duplicate question ids in the submission`);
    const done = this.results(manifest.arm_id);
    const completed = ids.filter(q => done.get(q)?.status === 'succeeded');
    if (completed.length) throw new Error(`${manifest.arm_id}: ${completed.length} questions already have a result (${completed.slice(0, 3).join(', ')}); completed rows are never resubmitted`);
    const pending = new Set(open.filter(i => i.arm_id === manifest.arm_id).flatMap(i => i.items.map(x => x.question_id)));
    if (ids.some(q => pending.has(q))) throw new Error(`${manifest.arm_id}: some questions are already in an open batch`);
    const known = this.factorFor(manifest.provider, manifest.model);
    const factor = opts.pilot ? 1 : known.factor;
    if (!opts.pilot && opts.requireFactor !== undefined && Math.abs(factor - opts.requireFactor) > 0.01 * opts.requireFactor) {
      throw new Error(`${manifest.arm_id}: the preregistered batch factor is ${opts.requireFactor}, but ${manifest.provider}:${manifest.model} is at ${factor} (${known.confirmed ? 'confirmed by its pilot' : 'no confirming pilot yet'}); run the pilot through the batch endpoint first, or pass the list-price factor explicitly`);
    }
    const intentId = `i${sha256(`${manifest.arm_id}:${randomUUID()}`).slice(0, 10)}`;
    const items = await this.items(manifest, bodies, ids, intentId);
    const requestSetHash = sha256(items.map(i => `${i.custom_id}:${i.body_sha256}`).join('\n'));
    const reserved = batchReservationUsd(manifest.provider, ids.map((q, k) => ({ body: bodies.get(q)!, inputTokens: items[k].input_tokens })), factor);
    const price = priceOf(manifest.provider, bodies.get(ids[0])!);
    const run = this.options.run;
    this.db.query(`INSERT INTO intents (intent_id, arm_id, provider, model, pilot, request_set_hash, items, factor, price, budget_run_id, reservation_id, reserved_usd, file_handle, state, batch_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'prepared', NULL, ?)`)
      .run(intentId, manifest.arm_id, manifest.provider, manifest.model, opts.pilot ? 1 : 0, requestSetHash, JSON.stringify(items), factor, JSON.stringify(price), run.runId, reserved, this.now());
    let reservation: string;
    try {
      reservation = run.reserve(reserved, `batch ${intentId} ${manifest.arm_id}: ${ids.length} ${manifest.provider}:${manifest.model} requests at factor ${factor}`);
    } catch (error) {
      this.setState(intentId, { state: 'abandoned', note: `reservation refused: ${(error as Error).message}` });
      throw error;
    }
    this.setState(intentId, { reservation_id: reservation });
    const transport = this.transport(manifest.provider);
    const requests = items.map(i => ({ custom_id: i.custom_id, body: bodies.get(i.question_id)! }));
    const handle = await runInBatchLane(reservation, () => transport.prepare(requests));
    this.setState(intentId, { file_handle: handle });
    this.setState(intentId, { state: 'sending', sending_at: this.now() });
    const batch = await runInBatchLane(reservation, () => transport.create(requests, handle, { intent_id: intentId, arm_id: manifest.arm_id, lane: 'gbrain-evals-batch' }));
    laneTestHooks.afterCreate?.(batch);
    this.setState(intentId, { state: 'submitted', batch_id: batch.id, submitted_at: this.now() });
    this.log(`${manifest.arm_id}: submitted ${ids.length} requests as ${batch.id} (intent ${intentId}, reserved $${reserved.toFixed(4)} at factor ${factor})`);
    return this.intent(intentId);
  }

  private releaseUnsent(i: Intent, why: string): void {
    const run = this.runFor(i.budget_run_id);
    const reservation = i.reservation_id ?? readLedger(run.ledgerPath).entries.find(e => e.run_id === i.budget_run_id && e.description.startsWith(`batch ${i.intent_id} `))?.id ?? null;
    if (reservation) {
      const entry = readLedger(run.ledgerPath).entries.find(e => e.id === reservation);
      if (entry && entry.actual_usd === null) run.settle(reservation, { usd: 0, input_tokens: 0, output_tokens: 0 });
    }
    this.setState(i.intent_id, { state: 'abandoned', reservation_id: reservation, settled_usd: 0, settled_at: this.now(), note: why });
  }

  /**
   * Resolve intents a crash left behind, before anything is submitted. Never
   * submits: an intent that may have reached the provider is either matched
   * to exactly one provider batch or marked unknown.
   */
  async reconcile(): Promise<Intent[]> {
    const touched: Intent[] = [];
    for (const i of this.intents({ states: ['prepared'] })) {
      this.releaseUnsent(i, 'crashed before submission was attempted; reservation released');
      this.log(`reconcile: intent ${i.intent_id} (${i.arm_id}) never reached the provider; released its reservation`);
      touched.push(this.intent(i.intent_id));
    }
    for (const i of this.intents({ states: ['sending'] })) {
      const transport = this.transport(i.provider);
      const since = (i.sending_at ?? i.created_at) - ADOPT_WINDOW_MS.before;
      const claimed = new Set(this.intents().map(x => x.batch_id).filter(Boolean));
      const listed = (await transport.list(since)).filter(b => !claimed.has(b.id));
      let matches: BatchStatus[];
      if (i.provider === 'openai') {
        matches = listed.filter(b => b.metadata?.intent_id === i.intent_id);
      } else {
        const windowed = listed.filter(b => b.total === i.items.length && b.created_at_ms <= (i.sending_at ?? i.created_at) + ADOPT_WINDOW_MS.after);
        matches = [];
        for (const b of windowed) {
          if (!b.ended) { matches.push(b); continue; }
          const ids = (await transport.results(b)).map(r => r.custom_id);
          if (ids.length && ids.every(c => c.startsWith(`${i.intent_id}-`))) matches.push(b);
        }
      }
      if (matches.length === 1) {
        this.setState(i.intent_id, { state: 'submitted', batch_id: matches[0].id, submitted_at: this.now(), note: `adopted on reconcile (${i.provider === 'openai' ? 'metadata intent_id' : 'request count and time window; custom ids checked at results'})` });
        this.log(`reconcile: intent ${i.intent_id} (${i.arm_id}) matched provider batch ${matches[0].id}`);
      } else {
        this.setState(i.intent_id, { state: 'unknown', note: `${matches.length} provider batches match (${matches.map(b => b.id).join(', ') || 'none'}); not resubmitted, reservation held; resolve with resolveUnknown after checking the provider console` });
        this.log(`reconcile: intent ${i.intent_id} (${i.arm_id}) outcome unknown (${matches.length} matches); it will not be resubmitted automatically`);
      }
      touched.push(this.intent(i.intent_id));
    }
    return touched;
  }

  /** Operator resolution of an unknown intent: adopt a batch id, or declare it never submitted (releases the reservation). */
  resolveUnknown(intentId: string, resolution: { batchId: string } | { notSubmitted: true; reason: string }): Intent {
    const i = this.intent(intentId);
    if (i.state !== 'unknown') throw new Error(`intent ${intentId} is ${i.state}, not unknown`);
    if ('batchId' in resolution) this.setState(intentId, { state: 'submitted', batch_id: resolution.batchId, note: `operator adopted ${resolution.batchId}` });
    else this.releaseUnsent(i, `operator: not submitted (${resolution.reason})`);
    return this.intent(intentId);
  }

  /** Check open batches; store and settle every one that has ended. */
  async poll(): Promise<PollOutcome[]> {
    await this.reconcile();
    const out: PollOutcome[] = [];
    for (const i of this.intents({ states: ['submitted', 'ended', 'unknown'] })) {
      if (i.state === 'unknown') { out.push(this.outcome(i, null)); continue; }
      let status: BatchStatus | null = null;
      if (i.state === 'submitted') {
        status = await this.transport(i.provider).get(i.batch_id!);
        if (!status.ended) { out.push(this.outcome(i, status)); continue; }
        this.storeResults(i, status, await this.transport(i.provider).results(status));
        laneTestHooks.afterResultsStored?.();
      }
      out.push(this.settle(this.intent(i.intent_id), status));
    }
    return out;
  }

  private storeResults(i: Intent, status: BatchStatus, raw: NormalizedResult[]): void {
    const byId = new Map(i.items.map(x => [x.custom_id, x]));
    const seen = new Map<string, NormalizedResult>();
    for (const r of raw) {
      if (!byId.has(r.custom_id)) throw new Error(`batch ${status.id} returned custom id ${r.custom_id}, which intent ${i.intent_id} never sent; refusing to store or settle it`);
      const prev = seen.get(r.custom_id);
      if (prev) {
        if (JSON.stringify(prev) !== JSON.stringify(r)) throw new Error(`batch ${status.id} returned two different results for ${r.custom_id}; refusing to settle until inspected`);
        continue;
      }
      seen.set(r.custom_id, r);
    }
    const factor = i.factor;
    const insert = this.db.query(`INSERT OR REPLACE INTO results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const item of i.items) {
        const r = seen.get(item.custom_id) ?? { custom_id: item.custom_id, status: 'missing' as const, text: null, finish: null, usage: null, response_model: null, service_tier: null, error: `batch ${status.id} (${status.status}) returned no result for this request` };
        const cost = rowCost(i.price, item.worst_list_usd, r, factor);
        insert.run(i.arm_id, item.question_id, i.intent_id, item.custom_id, r.status, r.text, r.finish, r.usage ? JSON.stringify(r.usage) : null, r.response_model, r.service_tier, r.error, cost.list_usd, cost.usd, cost.basis, this.now());
      }
      this.setState(i.intent_id, { state: 'ended', ended_at: this.now(), note: `${status.status}` });
    })();
    if (i.pilot) {
      const evidence = confirmFactor(i.provider, i.model, status, [...seen.values()]);
      this.db.query('INSERT OR REPLACE INTO factors VALUES (?, ?, ?, ?, ?, ?)').run(i.provider, i.model, evidence.factor, evidence.confirmed ? 1 : 0, JSON.stringify(evidence), this.now());
      this.log(`pilot ${i.intent_id} (${i.provider}:${i.model}): factor ${evidence.factor} (${evidence.confirmed ? 'confirmed' : 'not confirmed'})`);
    }
  }

  private settle(i: Intent, status: BatchStatus | null): PollOutcome {
    const rows = this.db.query('SELECT usd, status FROM results WHERE intent_id = ?').all(i.intent_id) as { usd: number; status: string }[];
    const usd = rows.reduce((s, r) => s + r.usd, 0);
    const tokens = this.db.query(`SELECT usage FROM results WHERE intent_id = ? AND usage IS NOT NULL`).all(i.intent_id) as { usage: string }[];
    const run = this.runFor(i.budget_run_id);
    const entry = readLedger(run.ledgerPath).entries.find(e => e.id === i.reservation_id);
    if (!entry) throw new Error(`intent ${i.intent_id}: reservation ${i.reservation_id} is not in the ledger`);
    let settled = usd;
    if (entry.actual_usd === null) {
      const n = (u: Record<string, unknown>, ...keys: string[]) => keys.reduce((s, k) => s + (typeof u[k] === 'number' ? (u[k] as number) : 0), 0);
      const parsed = tokens.map(t => JSON.parse(t.usage) as Record<string, unknown>);
      run.settle(i.reservation_id!, {
        usd, input_tokens: parsed.reduce((s, u) => s + n(u, 'input_tokens', 'prompt_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'), 0),
        output_tokens: parsed.reduce((s, u) => s + n(u, 'output_tokens', 'completion_tokens'), 0),
      });
      laneTestHooks.afterLedgerSettle?.();
    } else {
      settled = entry.actual_usd;
    }
    this.setState(i.intent_id, { state: 'settled', settled_usd: settled, settled_at: this.now() });
    return this.outcome(this.intent(i.intent_id), status);
  }

  private outcome(i: Intent, status: BatchStatus | null): PollOutcome {
    const rows = this.db.query('SELECT question_id, status FROM results WHERE intent_id = ?').all(i.intent_id) as { question_id: string; status: string }[];
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const factorRow = i.pilot && i.state === 'settled' ? this.factorFor(i.provider, i.model).evidence ?? undefined : undefined;
    return {
      intent_id: i.intent_id, arm_id: i.arm_id, batch_id: i.batch_id, state: i.state, provider_status: status?.status ?? null, counts, settled_usd: i.settled_usd,
      failed_question_ids: rows.filter(r => r.status !== 'succeeded').map(r => r.question_id), ...(factorRow ? { factor: factorRow } : {}),
    };
  }
}

export { BudgetExceededError };
