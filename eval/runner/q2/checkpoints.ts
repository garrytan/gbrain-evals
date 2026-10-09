/**
 * Resume for the Q2 paid runners (plan section 9, item 6).
 *
 *   AttemptCheckpoint  append-only JSONL, one line per attempt; the last line per key gives its state:
 *                      done (has a result), retryable (a later run tries again) or terminal (never retried; the
 *                      scorer counts it as the gate's rules say). Spend sums every attempt, retried ones included.
 *   answerKey/judgeKey separate keys for answers and judgments, by corpus, ingest, model, arm and question, so a
 *                      judge failure never re-runs a paid answer and an answer is never judged twice.
 *   withAttempts       bounded retries inside one run; HTTP 4xx other than 408, 409 and 429 is terminal at once.
 *   Opening            opening.json in the work root: the experiment identity of one opening of a sealed set. A
 *                      resume with the same identity continues the same opening; a different identity is refused.
 *   interruptionReport what every interruption prints: the resume command, remaining work, cumulative spend and
 *                      whether the resume continues the same opening.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type AttemptState = 'done' | 'retryable' | 'terminal';
export interface AttemptRecord<R> { key: string; unit: Record<string, string | number>; state: AttemptState; attempts: number; result?: R; error?: string; usd: number; at: string }

export class AttemptCheckpoint<R> {
  private readonly last = new Map<string, AttemptRecord<R>>();
  private spent = 0;
  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as AttemptRecord<R>; this.last.set(r.key, r); this.spent += r.usd ?? 0; } catch { /* torn tail after a crash */ }
    }
  }
  get(key: string): AttemptRecord<R> | undefined { return this.last.get(key); }
  done(key: string): boolean { return this.last.get(key)?.state === 'done'; }
  /** Keys still to attempt: neither done nor terminal. */
  todo(keys: readonly string[]): string[] { return keys.filter(k => { const s = this.last.get(k)?.state; return s !== 'done' && s !== 'terminal'; }); }
  record(key: string, unit: Record<string, string | number>, o: { state: AttemptState; result?: R; error?: string; usd: number; attempts?: number }): AttemptRecord<R> {
    const rec: AttemptRecord<R> = { key, unit, state: o.state, attempts: (this.last.get(key)?.attempts ?? 0) + (o.attempts ?? 1), ...(o.result !== undefined ? { result: o.result } : {}), ...(o.error ? { error: o.error.slice(0, 500) } : {}), usd: o.usd, at: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + '\n');
    this.last.set(key, rec);
    this.spent += o.usd;
    return rec;
  }
  values(): AttemptRecord<R>[] { return [...this.last.values()]; }
  spendUsd(): number { return this.spent; }
  counts(keys: readonly string[]): Record<AttemptState | 'not_started', number> {
    const c = { done: 0, retryable: 0, terminal: 0, not_started: 0 };
    for (const k of keys) c[this.last.get(k)?.state ?? 'not_started']++;
    return c;
  }
}

export interface UnitIdentity { corpus: string; ingest: number; model: string; arm: string; question: string }
export const answerKey = (u: UnitIdentity) => `answer|${u.corpus}|ingest${u.ingest}|${u.model}|${u.arm}|${u.question}`;
export const judgeKey = (u: UnitIdentity, judge: string) => `judge|${judge}|${u.corpus}|ingest${u.ingest}|${u.model}|${u.arm}|${u.question}`;

/** Terminal for HTTP 4xx other than 408, 409 and 429 (`provider error 400: ...`); everything else may succeed on a rerun. */
export function failureClass(e: unknown): 'retryable' | 'terminal' {
  const msg = e instanceof Error ? e.message : String(e);
  const code = Number(/(?:error|status|HTTP)\s*\(?([45]\d\d)\b/i.exec(msg)?.[1] ?? NaN);
  return code >= 400 && code < 500 && ![408, 409, 429].includes(code) ? 'terminal' : 'retryable';
}

/**
 * Run `fn` up to `maxAttempts` times. A terminal failure stops at once; a budget error is rethrown (it ends the run,
 * and the interruption report says what is left). The result says how many attempts this call used.
 */
export async function withAttempts<R>(fn: () => Promise<R>, o: { maxAttempts: number; backoffMs?: number; sleep?: (ms: number) => Promise<void>; isValid?: (r: R) => boolean }): Promise<{ state: AttemptState; result?: R; error?: string; attempts: number }> {
  const sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  let error = '';
  for (let a = 1; a <= o.maxAttempts; a++) {
    try {
      const r = await fn();
      if (!o.isValid || o.isValid(r)) return { state: 'done', result: r, attempts: a };
      error = 'reply did not parse as the required JSON';
    } catch (e) {
      if ((e as Error).name === 'BudgetExceededError') throw e;
      error = e instanceof Error ? e.message : String(e);
      if (failureClass(e) === 'terminal') return { state: 'terminal', error, attempts: a };
    }
    if (a < o.maxAttempts) await sleep((o.backoffMs ?? 2000) * 2 ** (a - 1));
  }
  // Repeated unparseable replies are terminal (the model will not change its mind on a rerun); transport failures are retryable.
  return { state: error.startsWith('reply did not parse') ? 'terminal' : 'retryable', error, attempts: o.maxAttempts };
}

export interface OpeningRecord { opening_id: string; identity_sha256: string; started_at: string; set: string }

/** Start or continue the one opening of a sealed set for this experiment identity. */
export function openOrContinue(workRoot: string, set: string, identity: unknown, file = 'opening.json'): OpeningRecord & { continues: boolean } {
  const path = join(workRoot, file);
  const identitySha = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  if (existsSync(path)) {
    const prev = JSON.parse(readFileSync(path, 'utf8')) as OpeningRecord;
    if (prev.identity_sha256 !== identitySha || prev.set !== set) {
      throw new Error(`${workRoot} holds opening ${prev.opening_id} of ${prev.set} for a different experiment (identity ${prev.identity_sha256.slice(0, 12)}, now ${identitySha.slice(0, 12)}). Resuming would change the experiment inside one opening, which the preregistration forbids. Rerun the exact original command, or report to the owner if the experiment really changed.`);
    }
    return { ...prev, continues: true };
  }
  const rec: OpeningRecord = { opening_id: randomUUID(), identity_sha256: identitySha, started_at: new Date().toISOString(), set };
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
  return { ...rec, continues: false };
}

/** The text every interruption prints. */
export function interruptionReport(o: { command: string; remaining: Record<string, number>; spentUsd: number; opening: { id: string; set: string } | null; reason: string }): string {
  const left = Object.entries(o.remaining).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
  return [
    `Interrupted: ${o.reason}`,
    `Remaining work: ${left}.`,
    `Cumulative spend in this work root: $${o.spentUsd.toFixed(2)} (every attempt, retried ones included).`,
    o.opening
      ? `Resuming continues the same opening (${o.opening.set}, opening ${o.opening.id}): finished units are kept, nothing already answered or judged is paid for again, and no new opening of the set is made.`
      : 'This is a development run; resuming reuses finished units.',
    `Resume with: ${o.command}`,
  ].join('\n');
}

/** The command line to resume with (argv quoted for a POSIX shell). */
export function resumeCommand(script: string, argv: readonly string[]): string {
  const q = (a: string) => (/^[A-Za-z0-9_./:=@,+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ['bun', script, ...argv].map(q).join(' ');
}
