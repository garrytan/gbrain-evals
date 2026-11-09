/**
 * Paid execution for the predictive runner (run.ts --paid and --smoke): a worker pool over episode jobs, a JSONL episode
 * log that makes runs resumable, and per-episode usage read from the provider's own usage fields.
 *
 * Money rules, in order of what they protect against:
 *   - One ledger writer. The runner process joins the open budget run requirePaidArm checked (startPaidRun) and installs
 *     the paid-request guard once; every worker's requests go through that guard, which reserves before sending and
 *     reconciles from the response usage. No worker opens its own run.
 *   - A clean pause at the cap. A reservation the ledger refuses throws BudgetExceededError before anything is sent. The
 *     pool stops scheduling, lets in-flight episodes reach their own next reservation, writes each refused episode as
 *     `refused`, and prints the command that resumes the run once the cap is raised.
 *   - No silent resend. An episode whose last log row is `errored` (a provider or harness error) or `started` (in flight
 *     when the process died) may already have been billed, so a resume skips it unless --retry-errored is passed. A
 *     `refused` episode is re-run on resume: its refused request never left the process. Completed episodes are skipped.
 *   - One build per result. Every row records the gbrain version and commit it ran on, and a resume refuses, before
 *     sending anything, when any row it would reuse ran on another build (or records none).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fitAnthropicRequest } from '../anthropic-request.ts';
import { provider } from '../cat40/loop.ts';
import { normalizeUsage } from '../q1/usage.ts';
import { isCapStop } from '../refresh-barrier/ledger.ts';

export const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', particle: 'PARTICLE_API_KEY' } as const;
/** Loop stops that are not a model outcome: provider or harness errors, written uncounted and never resent on their own. */
export const ERRORED_STOPS: ReadonlySet<string> = new Set(['error', 'harness_error']);
export const EPISODE_LOG_SCHEMA = 'gbrain-evals/predictive-episode-log/v1';

export interface EpisodeRecord { success: boolean; usd: number; stop: string; model?: string }
export interface EpisodeUsage { requests: number; input: number; output: number; cache_read: number; cache_write: number }
export interface PaidJob { key: string; unit: string; model: string; run: (fetchImpl: typeof fetch) => Promise<EpisodeRecord> }
export type RowStatus = 'started' | 'done' | 'errored' | 'refused';
/** The gbrain build a row ran on: its version, and the commit loaded (an overlay's) or pinned in package.json. */
export interface GbrainStamp { version: string; commit: string | null }
export interface LogRow {
  schema: typeof EPISODE_LOG_SCHEMA; key: string; unit: string; model: string; status: RowStatus; counted: boolean; at: string;
  gbrain?: GbrainStamp; record?: EpisodeRecord; usage?: EpisodeUsage; error?: string;
}

/** A resume whose episode log ran on another gbrain build: refused before anything is sent. */
export class ResumeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeRefusal';
  }
}

/** The environment variables the given models' providers need, missing ones only. Presence checks only; values are never read out. */
export function missingKeys(models: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set(models.map(m => KEY_ENV[provider(m)]))].filter(name => !env[name]);
}

/**
 * The fetch an episode's loop uses: Claude requests fitted to the model (fitAnthropicRequest), sent through
 * globalThis.fetch so the installed guard sees them, with each response's provider usage added to `usage`.
 */
export function meteredFetch(model: string, usage: EpisodeUsage): typeof fetch {
  const prov = provider(model);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = prov === 'anthropic' && typeof init?.body === 'string' ? JSON.stringify(fitAnthropicRequest(JSON.parse(init.body))) : init?.body;
    const res = await globalThis.fetch(input, { ...init, body });
    const json = await res.clone().json().catch(() => null) as { usage?: object } | null;
    if (json?.usage) {
      const n = normalizeUsage(prov === 'anthropic' ? 'anthropic' : 'openai', json.usage);
      usage.requests++; usage.input += n.uncached_input; usage.output += n.output; usage.cache_read += n.cache_read; usage.cache_write += n.cache_write;
    }
    return res;
  }) as unknown as typeof fetch;
}

/** Every row in log order; given `counted`, only rows a run of that kind wrote, so a counted run never resumes from smoke rows or the reverse. */
export function readLogRows(path: string, counted?: boolean): LogRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as LogRow)
    .filter(row => counted === undefined || row.counted === counted);
}

/** The last row per episode key, of the kind `counted` names (readLogRows). */
export function readEpisodeLog(path: string, counted?: boolean): Map<string, LogRow> {
  return new Map(readLogRows(path, counted).map(row => [row.key, row]));
}

const buildLabel = (stamp: GbrainStamp | undefined) => stamp ? `gbrain ${stamp.version} at ${stamp.commit ?? 'an unrecorded commit'}` : 'an unrecorded gbrain build';

export interface PaidResult {
  status: 'complete' | 'paused' | 'incomplete';
  ran: number;
  skipped: { done: number; errored: number; in_flight: number };
  pause_reason: string | null;
  /** The latest done row of every job, this invocation's and earlier ones'. */
  done: LogRow[];
  errored: LogRow[];
  /** Every errored row of these jobs in the log, earlier attempts of a since-retried episode included: spend cost per correct counts. */
  errored_attempts: LogRow[];
}

/** The jobs a resume would run, and what it skips: done episodes always; errored and in-flight ones unless retryErrored. */
export function pendingJobs<J extends { key: string }>(jobs: readonly J[], prior: ReadonlyMap<string, LogRow>, retryErrored: boolean): { todo: J[]; skipped: PaidResult['skipped'] } {
  const skipped = { done: 0, errored: 0, in_flight: 0 };
  const todo = jobs.filter(j => {
    const status = prior.get(j.key)?.status;
    if (status === 'done') { skipped.done++; return false; }
    if (status === 'errored' && !retryErrored) { skipped.errored++; return false; }
    if (status === 'started' && !retryErrored) { skipped.in_flight++; return false; }
    return true;
  });
  return { todo, skipped };
}

export async function runPaid(jobs: readonly PaidJob[], opts: { log: string; concurrency: number; retryErrored: boolean; counted: boolean; gbrain: GbrainStamp; guard: { readonly exhausted: boolean }; resumeCommand: string; print?: (line: string) => void }): Promise<PaidResult> {
  const print = opts.print ?? ((line: string) => console.error(line));
  const keys = new Set<string>();
  for (const j of jobs) { if (keys.has(j.key)) throw new Error(`duplicate episode key ${j.key}`); keys.add(j.key); }
  mkdirSync(dirname(opts.log), { recursive: true });
  const prior = readEpisodeLog(opts.log, opts.counted);
  const other = [...prior.values()].find(row => row.gbrain?.version !== opts.gbrain.version || row.gbrain?.commit !== opts.gbrain.commit);
  if (other) throw new ResumeRefusal(`resume refused: episode ${other.key} in ${opts.log} ran on ${buildLabel(other.gbrain)}, not ${buildLabel(opts.gbrain)}, and one result never mixes builds; move the log aside or pass a new --out for this build`);
  const { todo, skipped } = pendingJobs(jobs, prior, opts.retryErrored);
  if (skipped.errored || skipped.in_flight) print(`resume: skipping ${skipped.errored} errored and ${skipped.in_flight} in-flight episodes, which may already have been billed; pass --retry-errored to send them again`);
  const latest = new Map(prior);
  const append = (job: PaidJob, status: RowStatus, extra: Partial<LogRow> = {}) => {
    const row: LogRow = { schema: EPISODE_LOG_SCHEMA, key: job.key, unit: job.unit, model: job.model, status, counted: opts.counted, at: new Date().toISOString(), gbrain: opts.gbrain, ...extra };
    appendFileSync(opts.log, JSON.stringify(row) + '\n');
    latest.set(job.key, row);
  };
  let next = 0, ran = 0;
  let pause: string | null = null;
  const worker = async () => {
    while (pause === null && !opts.guard.exhausted && next < todo.length) {
      const job = todo[next++];
      ran++;
      append(job, 'started');
      const usage: EpisodeUsage = { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
      try {
        const record = await job.run(meteredFetch(job.model, usage));
        const errored = ERRORED_STOPS.has(record.stop);
        append(job, errored ? 'errored' : 'done', { record, usage });
        print(`${job.key}: ${errored ? `errored (${record.stop})` : `success=${record.success} stop=${record.stop}`} usd=${record.usd.toFixed(4)} requests=${usage.requests}`);
      } catch (e) {
        const message = (e as Error).message;
        if ((e as Error).name === 'BudgetExceededError') {
          pause ??= `${isCapStop(e) ? 'cap stop' : 'ledger refusal'}: ${message}`;
          append(job, 'refused', { usage, error: message });
          print(`${job.key}: refused before sending (${message.slice(0, 200)})`);
        } else {
          append(job, 'errored', { usage, error: message });
          print(`${job.key}: errored (${message.slice(0, 200)})`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, todo.length)) }, worker));
  if (pause === null && opts.guard.exhausted) pause = 'the paid-request guard refused a reservation';
  const done = jobs.map(j => latest.get(j.key)).filter((r): r is LogRow => r?.status === 'done');
  const errored = jobs.map(j => latest.get(j.key)).filter((r): r is LogRow => r?.status === 'errored');
  if (pause !== null) print(`paused: ${pause}\nRaise the budget run's cap (a ledger extension from GBEV-3) or open a new run, then resume with:\n  ${opts.resumeCommand}`);
  const errored_attempts = readLogRows(opts.log, opts.counted).filter(r => r.status === 'errored' && keys.has(r.key));
  return { status: pause !== null ? 'paused' : done.length === jobs.length ? 'complete' : 'incomplete', ran, skipped, pause_reason: pause, done, errored, errored_attempts };
}
